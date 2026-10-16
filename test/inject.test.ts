import { afterEach, beforeEach, expect, test } from "bun:test"
import plugin, { resolveOptions, retainsAutomatically, shouldInject, type Options } from "../index.ts"

const base = (over: Partial<Options> = {}): Options => ({ ...resolveOptions({ url: "http://h.test" }), ...over })
const m = (providerID: string, id: string) => ({ providerID, id })

test("options: inject defaults to always with an empty model list", () => {
  const o = resolveOptions({ url: "http://h.test" })
  expect(o.inject).toBe("always")
  expect(o.injectModels).toEqual([])
})

test("options: inject parses the three modes and warns on an unknown value", () => {
  expect(resolveOptions({ inject: "on_demand" }).inject).toBe("on_demand")
  expect(resolveOptions({ inject: "never" }).inject).toBe("never")
  const warnings: string[] = []
  expect(resolveOptions({ inject: "sometimes" }, (w) => warnings.push(w)).inject).toBe("always")
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('inject "sometimes"')
})

test("options: inject_models accepts an array or a comma-separated string", () => {
  expect(resolveOptions({ inject_models: ["a/b", " c/* ", ""] }).injectModels).toEqual(["a/b", "c/*"])
  expect(resolveOptions({ inject_models: "a/b, c/*" }).injectModels).toEqual(["a/b", "c/*"])
  expect(resolveOptions({ inject_models: 42 }).injectModels).toEqual([])
})

test("shouldInject: never wins over everything", () => {
  expect(shouldInject(base({ inject: "never" }), m("p", "x"))).toBe(false)
  expect(shouldInject(base({ inject: "never", injectModels: ["p/x"] }), m("p", "x"))).toBe(false)
  expect(retainsAutomatically(base({ inject: "never" }))).toBe(false)
})

test("shouldInject: on_demand injects only listed models", () => {
  expect(shouldInject(base({ inject: "on_demand" }), m("p", "x"))).toBe(false)
  expect(shouldInject(base({ inject: "on_demand", injectModels: ["p/x"] }), m("p", "x"))).toBe(true)
  expect(shouldInject(base({ inject: "on_demand", injectModels: ["p/*"] }), m("p", "y"))).toBe(true)
  expect(shouldInject(base({ inject: "on_demand", injectModels: ["p/x"] }), m("q", "x"))).toBe(false)
  expect(shouldInject(base({ inject: "on_demand", injectModels: ["p/x"] }), undefined)).toBe(false)
  expect(retainsAutomatically(base({ inject: "on_demand" }))).toBe(true)
})

test("shouldInject: always injects, the list filters", () => {
  expect(shouldInject(base(), m("p", "x"))).toBe(true)
  expect(shouldInject(base({ injectModels: ["p/x"] }), m("p", "x"))).toBe(true)
  expect(shouldInject(base({ injectModels: ["p/x"] }), m("p", "y"))).toBe(false)
  expect(retainsAutomatically(base())).toBe(true)
})

// ---- plugin.setup against a fake context -------------------------------------------------

type Hooks = Record<string, (event: any) => Promise<void> | void>
type Tool = { name: string; description: string; execute: (input: unknown, tool: { sessionID: string }) => Promise<{ content: string }> }

const realFetch = globalThis.fetch
let requests: string[] = []

beforeEach(() => {
  requests = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    requests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`)
    const body = url.endsWith("/memories/recall")
      ? { results: [{ text: "fact one", type: "world", scores: { final: 0.9 } }] }
      : { operation_id: "op-1" }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

async function boot(options: Record<string, unknown>) {
  const hooks: Hooks = {}
  const tools: Tool[] = []
  const logs: string[] = []
  const error = console.error
  console.error = (line: string) => void logs.push(String(line))
  const ctx = {
    options: { url: "http://h.test", ...options },
    location: { directory: "/tmp/x/proj", project: { directory: "/tmp/x/proj" } },
    storage: { get: async () => undefined, set: async () => {} },
    session: {
      hook: async (name: string, fn: Hooks[string]) => void (hooks[name] = fn),
      context: async () => [],
      get: async () => ({ title: "t" }),
    },
    tool: { transform: async (fn: (editor: { add: (t: Tool) => void }) => void) => fn({ add: (t) => tools.push(t) }) },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        },
      }),
    },
  }
  const cleanup = (await plugin.setup(ctx as any)) as (() => void) | undefined
  const contextEvent = (model = m("p", "m")) => ({ sessionID: "ses_1", model, system: [] as { type: string; text: string }[], messages: [], options: {}, agent: "build", tools: {} })
  const run = async (model?: { providerID: string; id: string }) => {
    await hooks["prompt"]!({ sessionID: "ses_1", prompt: { text: "hello world" } })
    const event = contextEvent(model)
    await hooks["context"]!(event)
    return event.system
  }
  return {
    hooks,
    tools,
    logs,
    run,
    cleanup: () => {
      console.error = error
      cleanup?.()
    },
  }
}

const recalls = () => requests.filter((r) => r.endsWith("/memories/recall")).length

test("setup: always injects the block and recalls once", async () => {
  const p = await boot({ inject: "always" })
  const system = await p.run()
  expect(system).toHaveLength(1)
  expect(system[0]!.text).toContain("## Episodic memory (Hindsight)")
  expect(system[0]!.text).toContain("fact one")
  expect(recalls()).toBe(1)
  expect(p.tools.find((t) => t.name === "hindsight_recall")!.description).not.toContain("Nothing is injected automatically")
  expect(p.logs.some((l) => l.includes("inject always"))).toBe(true)
  p.cleanup()
})

test("setup: on_demand injects nothing and makes no recall request", async () => {
  const p = await boot({ inject: "on_demand", debug: true })
  const system = await p.run()
  expect(system).toHaveLength(0)
  expect(recalls()).toBe(0)
  expect(p.logs.some((l) => l.includes("injection skipped for ses_1 (on_demand, p/m)"))).toBe(true)
  expect(p.tools.find((t) => t.name === "hindsight_recall")!.description).toContain("Nothing is injected automatically")
  p.cleanup()
})

test("setup: on_demand with inject_models injects for a listed model only", async () => {
  const p = await boot({ inject: "on_demand", inject_models: ["p/m"] })
  expect(await p.run(m("p", "m"))).toHaveLength(1)
  expect(await p.run(m("p", "other"))).toHaveLength(0)
  expect(recalls()).toBe(1)
  p.cleanup()
})

test("setup: never injects nothing, skips automatic retain, tools still work", async () => {
  const p = await boot({ inject: "never" })
  const system = await p.run()
  expect(system).toHaveLength(0)
  expect(recalls()).toBe(0)
  await p.hooks["compaction"]!({ sessionID: "ses_1", model: m("p", "m"), system: [], messages: [], options: {}, agent: "build", tools: {} })
  expect(requests.filter((r) => r.startsWith("POST") && r.endsWith("/memories")).length).toBe(0)
  expect(p.tools.map((t) => t.name).sort()).toEqual(["hindsight_recall", "hindsight_reflect", "hindsight_retain"])
  const out = await p.tools.find((t) => t.name === "hindsight_recall")!.execute({ query: "x" }, { sessionID: "ses_1" })
  expect(out.content).toContain("fact one")
  p.cleanup()
})
