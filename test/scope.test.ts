import { afterEach, beforeEach, expect, test } from "bun:test"
import * as os from "node:os"
import * as path from "node:path"
import { resolveOptions, scopeOf } from "../index.ts"

const home = os.homedir()
const h = (p: string) => path.join(home, p)

const ENV = ["HINDSIGHT_URL", "HINDSIGHT_API_TOKEN", "HINDSIGHT_TOKEN"] as const
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {}
beforeEach(() => {
  for (const key of ENV) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})
afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

test("options: projects_root is optional and expands ~", () => {
  expect(resolveOptions().projectsRoot).toBeUndefined()
  expect(resolveOptions({ projects_root: "" }).projectsRoot).toBeUndefined()
  expect(resolveOptions({ projects_root: "~/code" }).projectsRoot).toBe(h("code"))
  expect(resolveOptions({ projects_root: "/srv/code" }).projectsRoot).toBe("/srv/code")
})

test("options: defaults, numeric coercion and flags", () => {
  const o = resolveOptions({ url: "https://hindsight.example.com/" })
  expect(o.url).toBe("https://hindsight.example.com")
  expect(o.bankPrefix).toBe("opencode")
  expect(o.recallBudget).toBe("low")
  expect(o.recallMaxTokens).toBe(800)
  expect(o.minRerankerScore).toBe(0.1)
  expect(o.recallTimeoutMs).toBe(3000)
  expect(o.enabled).toBe(true)
  expect(o.debug).toBe(false)

  const c = resolveOptions({
    url: "https://x.example",
    bank_prefix: "team",
    recall_budget: "mid",
    recall_max_tokens: "600",
    min_reranker_score: 0,
    recall_timeout_ms: "nope",
    enabled: "false",
    debug: "true",
  })
  expect(c.bankPrefix).toBe("team")
  expect(c.recallBudget).toBe("mid")
  expect(c.recallMaxTokens).toBe(600)
  expect(c.minRerankerScore).toBe(0)
  expect(c.recallTimeoutMs).toBe(3000) // unparsable → default
  expect(c.enabled).toBe(false)
  expect(c.debug).toBe(true)
  expect(resolveOptions({ recall_budget: "extreme" }).recallBudget).toBe("low")
})

test("options: url and token fall back to the environment", () => {
  process.env.HINDSIGHT_URL = "https://env.example/"
  process.env.HINDSIGHT_TOKEN = "t-env"
  const o = resolveOptions()
  expect(o.url).toBe("https://env.example")
  expect(o.token).toBe("t-env")
  process.env.HINDSIGHT_API_TOKEN = "t-api"
  expect(resolveOptions().token).toBe("t-api")
  expect(resolveOptions({ token: "t-cfg" }).token).toBe("t-cfg")
  expect(resolveOptions({ token: "   " }).token).toBe("t-api")
})

test("options: an unsubstituted {env:…} token is never sent and is reported", () => {
  const warnings: string[] = []
  const o = resolveOptions({ token: "{env:HINDSIGHT_API_TOKEN}" }, (m) => warnings.push(m))
  expect(o.token).toBeUndefined()
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("{env:HINDSIGHT_API_TOKEN}")
  process.env.HINDSIGHT_API_TOKEN = "t-api"
  expect(resolveOptions({ token: "{env:HINDSIGHT_API_TOKEN}" }).token).toBe("t-api")
})

test("without a projects root the key is the git root's basename, else the directory name", () => {
  expect(scopeOf(undefined, h("code/app"), h("code/app/lib"))).toBe("app")
  expect(scopeOf(undefined, "/", "/tmp/scratch")).toBe("scratch")
  expect(scopeOf(undefined, "", "/tmp/scratch")).toBe("scratch")
  expect(scopeOf(undefined, "", "")).toBe("global")
})

test("with a projects root, anything under it maps to the first segment below the root", () => {
  const root = h("code")
  expect(scopeOf(root, h("code/app"), h("code/app"))).toBe("app")
  expect(scopeOf(root, h("code/app/data/chats/session-1"), h("code/app/data/chats/session-1"))).toBe("app")
  expect(scopeOf(root, h("code/app"), h("code/app/packages/web"))).toBe("app")
  expect(scopeOf(root, "/", h("code"))).toBe("code")
  expect(scopeOf(root, "/", "/tmp/scratch")).toBe("scratch")
  expect(scopeOf(root, h("other/repo"), h("other/repo/src"))).toBe("repo")
  expect(scopeOf(root, h("code-extra/repo"), h("code-extra/repo"))).toBe("repo") // prefix, not a child
})
