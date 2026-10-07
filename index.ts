// hindsight: episodic memory backed by a self-hosted Hindsight server.
//
// Per project (bank `${bank_prefix}::${project}`) it
//   1. recalls memories relevant to the latest user prompt and injects them into the
//      system prompt (`## Episodic memory (Hindsight)`), once per prompt;
//   2. retains the new part of the transcript at the end of every turn (and before a
//      compaction) as an appended conversation document, fire-and-forget;
//   3. exposes hindsight_recall / hindsight_reflect / hindsight_retain tools.
//
// Every request has an AbortController timeout and a dead server only costs one logged
// line per failure: a turn is never blocked on memory. Options come from
// `plugins[].options` in opencode.jsonc (snake_case keys, see resolveOptions), with
// HINDSIGHT_URL / HINDSIGHT_API_TOKEN / HINDSIGHT_TOKEN as env fallbacks.
//
// Type-only import: Bun resolves bare specifiers from the symlink's real path, where no
// node_modules exists. Everything else is a Bun/Node builtin for the same reason.
import type { Plugin } from "@opencode/plugin"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, sep } from "node:path"

type Options = {
  url: string
  token?: string
  bankPrefix: string
  projectsRoot: string
  recallBudget: "low" | "mid" | "high"
  recallMaxTokens: number
  minRerankerScore: number
  recallTimeoutMs: number
  retainTimeoutMs: number
  reflectTimeoutMs: number
  retainMinChars: number
  retainMaxChars: number
  recallQueryMaxChars: number
  enabled: boolean
  debug: boolean
}

const DEFAULTS: Omit<Options, "url" | "token" | "projectsRoot"> = {
  bankPrefix: "opencode",
  recallBudget: "low",
  recallMaxTokens: 800,
  minRerankerScore: 0.1,
  recallTimeoutMs: 3000,
  retainTimeoutMs: 10000,
  reflectTimeoutMs: 120000,
  retainMinChars: 200,
  retainMaxChars: 6000,
  recallQueryMaxChars: 500,
  enabled: true,
  debug: false,
}

// Sessions tracked per instance. Entries are tiny and re-derivable; the cap only guards
// against a long-lived server accumulating ids.
const MAX_SESSIONS = 200

type RecallResult = {
  text: string
  type?: string | null
  scores?: { final?: number; reranker?: number | null } | null
}

type Transcript = Awaited<ReturnType<Plugin.Context["session"]["context"]>>
type TranscriptMessage = Transcript[number]

type SessionState = {
  prompt: string
  block?: Promise<string | undefined> // recall for `blockFor`, shared by every step of the turn
  blockFor?: string
  retained?: number // transcript messages already sent to Hindsight; undefined until loaded from storage
  busy: boolean
  title?: string
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : fallback
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p
}

// A `{env:NAME}` placeholder that opencode did not substitute (variable unset at server
// start) must not be sent as a bearer token.
function unresolved(value: string): boolean {
  return /^\{env:[^}]*\}$/.test(value)
}

function resolveOptions(raw: Readonly<Record<string, any>>, warn: (message: string) => void): Options {
  const budget = str(raw.recall_budget) as Options["recallBudget"]
  let token = str(raw.token)
  if (unresolved(token)) {
    warn(`token ${token} was not substituted by opencode (variable unset at server start?); falling back to the environment`)
    token = ""
  }
  token ||= str(process.env["HINDSIGHT_API_TOKEN"]) || str(process.env["HINDSIGHT_TOKEN"])
  return {
    url: (str(raw.url) || str(process.env["HINDSIGHT_URL"])).replace(/\/+$/, ""),
    token: token || undefined,
    bankPrefix: str(raw.bank_prefix) || DEFAULTS.bankPrefix,
    projectsRoot: expandHome(str(raw.projects_root) || join(homedir(), "dev")),
    recallBudget: ["low", "mid", "high"].includes(budget) ? budget : DEFAULTS.recallBudget,
    recallMaxTokens: num(raw.recall_max_tokens, DEFAULTS.recallMaxTokens),
    minRerankerScore: num(raw.min_reranker_score, DEFAULTS.minRerankerScore),
    recallTimeoutMs: num(raw.recall_timeout_ms, DEFAULTS.recallTimeoutMs),
    retainTimeoutMs: num(raw.retain_timeout_ms, DEFAULTS.retainTimeoutMs),
    reflectTimeoutMs: num(raw.reflect_timeout_ms, DEFAULTS.reflectTimeoutMs),
    retainMinChars: num(raw.retain_min_chars, DEFAULTS.retainMinChars),
    retainMaxChars: num(raw.retain_max_chars, DEFAULTS.retainMaxChars),
    recallQueryMaxChars: num(raw.recall_query_max_chars, DEFAULTS.recallQueryMaxChars),
    enabled: raw.enabled !== false && raw.enabled !== "false",
    debug: raw.debug === true || raw.debug === "true",
  }
}

// First path segment below `root` when `dir` lies under it, else undefined.
function projectUnder(root: string, dir: string): string | undefined {
  if (!dir) return undefined
  const rel = relative(root, dir)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined
  return rel.split(sep)[0] || undefined
}

// Project key for a location. A directory anywhere under the projects root (~/dev by
// default) maps to the project it sits in, so a session rooted in a nested dir (openchamber
// runs them from <project>/data/config/chats/<date>/session-<id>/) still shares the project
// bank. Otherwise: the git root's basename, else the directory's.
function scopeOf(projectsRoot: string, projectDirectory: string, directory: string): string {
  const nested = projectUnder(projectsRoot, directory) ?? projectUnder(projectsRoot, projectDirectory)
  if (nested) return nested
  const fromProject = basename(projectDirectory || "")
  if (fromProject && fromProject !== "/") return fromProject
  return basename(directory || "") || "global"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.name === "AbortError" || error.name === "TimeoutError" ? "timeout" : error.message
  return String(error)
}

class Client {
  private readonly base: string
  constructor(private readonly opts: Options, bank: string) {
    this.base = `${opts.url}/v1/default/banks/${encodeURIComponent(bank)}`
  }

  private async call<T>(method: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (this.opts.token) headers["authorization"] = `Bearer ${this.opts.token}`
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}: ${(await res.text()).slice(0, 200)}`)
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  ensureBank(project: string) {
    return this.call("PUT", "", {
      retain_mission:
        `Memories of coding sessions in project ${project}: decisions, bugs and their fixes,` +
        " conventions, commands, file locations, things tried that failed and why." +
        " Record durable facts about the project and its code. Do not record that a question was" +
        " asked, that the assistant lacked knowledge, or anything about the conversation itself.",
    }, this.opts.recallTimeoutMs) // cheap call, and it sits on the recall path before a turn
  }

  async recall(query: string, budget = this.opts.recallBudget, maxTokens = this.opts.recallMaxTokens) {
    const out = await this.call<{ results?: RecallResult[] }>("POST", "/memories/recall", {
      query,
      budget,
      max_tokens: maxTokens,
      types: ["world", "experience", "observation"],
      min_scores: { reranker: this.opts.minRerankerScore },
    }, this.opts.recallTimeoutMs)
    return out.results ?? []
  }

  retain(item: Record<string, unknown>) {
    return this.call<{ operation_id?: string }>("POST", "/memories", { items: [item], async: true }, this.opts.retainTimeoutMs)
  }

  async reflect(query: string, budget: Options["recallBudget"] = "low") {
    const out = await this.call<{ text?: string }>("POST", "/reflect", { query, budget }, this.opts.reflectTimeoutMs)
    return out.text ?? ""
  }
}

// Heading differs from the `memory` plugin's `## Memory` on purpose: both blocks sit in the
// same system prompt.
function renderRecall(results: RecallResult[]): string {
  const lines = results.map((r) => {
    const score = r.scores?.final ?? r.scores?.reranker
    const tag = r.type && r.type !== "world" ? ` (${r.type})` : ""
    return `- ${r.text.replace(/\s+/g, " ").trim()}${tag}${typeof score === "number" ? ` [${score.toFixed(2)}]` : ""}`
  })
  return [
    "## Episodic memory (Hindsight)",
    "",
    "Facts recalled from earlier sessions in this project, most relevant first (score in brackets).",
    "They may be stale; verify against the code when it matters.",
    "",
    ...lines,
    "",
    "Call hindsight_recall(query) for a deeper lookup when the user refers to something decided or done before.",
  ].join("\n")
}

// Renders transcript messages [from, to) as plain text. Tool outputs and reasoning are dropped
// on purpose: Hindsight extracts facts from what was said and decided, not from file dumps.
function renderTranscript(messages: Transcript, from: number, cap: number): string {
  const lines: string[] = []
  for (const message of messages.slice(from) as TranscriptMessage[]) {
    if (message.type === "user") {
      if (message.text.trim()) lines.push(`User: ${message.text.trim()}`)
    } else if (message.type === "assistant") {
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) lines.push(`Assistant: ${part.text.trim()}`)
        else if (part.type === "tool") lines.push(`[tool: ${part.name}]`)
      }
    }
  }
  const text = lines.join("\n")
  return text.length > cap ? `${text.slice(0, cap)}\n[truncated]` : text
}

const plugin: Plugin.Plugin = {
  id: "hindsight",
  async setup(ctx) {
    const log = (message: string) => console.error(`[hindsight] ${message}`)
    const opts = resolveOptions(ctx.options ?? {}, log)
    if (!opts.enabled || !opts.url) {
      log(opts.enabled ? "no url configured, plugin inactive" : "disabled by config")
      return
    }

    const directory = ctx.location.directory
    const project = scopeOf(opts.projectsRoot, ctx.location.project.directory, directory)
    const bank = `${opts.bankPrefix}::${project}`
    const client = new Client(opts, bank)
    const debug = (message: string) => opts.debug && log(message)

    // Bank creation is idempotent; done once per instance, lazily, and retried on the next use
    // if the server was down the first time.
    let bankReady: Promise<boolean> | undefined
    const ensureBank = () => {
      bankReady ??= client.ensureBank(project).then(
        () => true,
        (error) => {
          log(`bank ${bank} not ensured: ${errorMessage(error)}`)
          bankReady = undefined
          return false
        },
      )
      return bankReady
    }

    const sessions = new Map<string, SessionState>()
    const cursorKey = (id: string) => `hindsight/cursor/${id}`
    const state = (id: string): SessionState => {
      let hit = sessions.get(id)
      if (!hit) {
        if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string)
        hit = { prompt: "", busy: false }
        sessions.set(id, hit)
      }
      return hit
    }

    // Recall for the current prompt, cached (as a promise, so concurrent steps share one
    // request) until the next user prompt in that session: the block is identical across the
    // tool-call steps of one turn, which keeps the prompt cache warm.
    const recallBlock = (id: string): Promise<string | undefined> => {
      const s = state(id)
      if (!s.prompt) return Promise.resolve(undefined)
      if (s.blockFor === s.prompt && s.block) return s.block
      const prompt = s.prompt
      s.blockFor = prompt
      s.block = (async () => {
        const started = Date.now()
        try {
          if (!(await ensureBank())) return undefined // already logged
          const results = await client.recall(prompt)
          const block = results.length ? renderRecall(results) : undefined
          debug(`recall for ${id}: ${results.length} results in ${Date.now() - started} ms` + (block ? `\n${block}` : ""))
          return block
        } catch (error) {
          log(`recall failed for ${id} (${Date.now() - started} ms): ${errorMessage(error)}`)
          return undefined
        }
      })()
      return s.block
    }

    const retain = async (id: string, reason: string) => {
      const s = state(id)
      if (s.busy) return
      s.busy = true
      try {
        // The cursor lives in plugin storage so a reload (config edit, restart) does not re-send
        // the whole transcript into the document.
        s.retained ??= num(await ctx.storage.get(cursorKey(id)).catch(() => undefined), 0)
        const messages = await ctx.session.context({ sessionID: id })
        if (messages.length <= s.retained) return
        const text = renderTranscript(messages, s.retained, opts.retainMaxChars)
        const next = messages.length
        if (text.length < opts.retainMinChars) {
          debug(`retain skipped for ${id} (${reason}): ${text.length} chars < ${opts.retainMinChars}`)
          return
        }
        if (!(await ensureBank())) return
        if (s.title === undefined) {
          s.title = await ctx.session.get({ sessionID: id }).then((info) => info.title ?? "", () => "")
        }
        const started = Date.now()
        const out = await client.retain({
          content: text,
          context: `opencode session in project ${project}${s.title ? `: ${s.title}` : ""}`,
          document_id: `conversation:${id}`,
          update_mode: "append",
          tags: ["source:opencode", `project:${project}`],
          metadata: { session_id: id, title: s.title ?? "", project },
        })
        s.retained = next
        await ctx.storage.set(cursorKey(id), next).catch((error) => log(`cursor not saved for ${id}: ${errorMessage(error)}`))
        log(`retained ${text.length} chars for ${id} (${reason}) in ${Date.now() - started} ms, operation ${out.operation_id ?? "-"}`)
      } catch (error) {
        log(`retain failed for ${id} (${reason}): ${errorMessage(error)}`)
      } finally {
        s.busy = false
      }
    }

    await ctx.session.hook("prompt", (event) => {
      const text = event.prompt.text?.trim()
      if (!text) return
      // The prompt is the recall query. Long prompts are mostly pasted material (logs, code),
      // which only dilutes the reranker, so the query is the head of the prompt.
      state(event.sessionID).prompt = text.slice(0, opts.recallQueryMaxChars)
    })

    await ctx.session.hook("context", async (event) => {
      const text = await recallBlock(event.sessionID)
      if (text) event.system.push({ type: "text", text })
    })

    await ctx.session.hook("compaction", async (event) => {
      await retain(event.sessionID, "compaction")
      const text = await recallBlock(event.sessionID)
      if (text) event.system.push({ type: "text", text })
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "hindsight_recall",
        description:
          "Search this project's episodic memory (Hindsight) for facts from earlier sessions:" +
          " decisions, fixes, conventions, failed attempts. Fast (<1 s). Use when the user refers" +
          " to something decided or done before that is not in the current context.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to look for, as a question or topic." },
            budget: { type: "string", enum: ["low", "mid", "high"], description: "Search effort; default low." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input) {
          const args = input as { query?: string; budget?: Options["recallBudget"] }
          const query = str(args.query)
          if (!query) return { content: "Nothing searched: query was empty." }
          const started = Date.now()
          try {
            await ensureBank()
            const results = await client.recall(query, args.budget ?? opts.recallBudget, 2000)
            if (!results.length) return { content: `No memories match "${query}" (${Date.now() - started} ms).` }
            return { content: `${renderRecall(results)}\n\n${results.length} results in ${Date.now() - started} ms.` }
          } catch (error) {
            return { content: `Recall failed: ${errorMessage(error)}` }
          }
        },
      })

      editor.add({
        name: "hindsight_reflect",
        description:
          "Ask Hindsight to reason over this project's episodic memory and answer a question in prose." +
          " SLOW (typically 1-2 minutes on the local model): use only for a genuine synthesis" +
          " question across many past sessions, never for a simple lookup (use hindsight_recall).",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "The question to answer from memory." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input) {
          const query = str((input as { query?: string }).query)
          if (!query) return { content: "Nothing asked: query was empty." }
          const started = Date.now()
          try {
            await ensureBank()
            const text = await client.reflect(query)
            return { content: `${text || "(empty answer)"}\n\n(reflect took ${Math.round((Date.now() - started) / 1000)} s)` }
          } catch (error) {
            return { content: `Reflect failed: ${errorMessage(error)}` }
          }
        },
      })

      editor.add({
        name: "hindsight_retain",
        description:
          "Store a fact or note in this project's episodic memory (Hindsight) explicitly. The end of" +
          " every turn is retained automatically; use this for something that must not be missed, or" +
          " when the user asks to remember something.",
        input: {
          type: "object",
          properties: {
            content: { type: "string", description: "The text to remember, self-contained." },
            context: { type: "string", description: "Optional short context, e.g. where it came from." },
          },
          required: ["content"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input, tool) {
          const args = input as { content?: string; context?: string }
          const content = str(args.content)
          if (!content) return { content: "Nothing stored: content was empty." }
          if (content.length > 20000) return { content: "Nothing stored: keep it under 20000 characters." }
          try {
            if (!(await ensureBank())) return { content: "Store failed: Hindsight bank unavailable." }
            const out = await client.retain({
              content,
              context: str(args.context) || `explicit note from an opencode session in project ${project}`,
              document_id: `note:${tool.sessionID}:${Date.now()}`,
              tags: ["source:opencode", "kind:note", `project:${project}`],
              metadata: { session_id: tool.sessionID, project },
            })
            return { content: `Stored in bank ${bank} (operation ${out.operation_id ?? "-"}); facts are extracted in the background.` }
          } catch (error) {
            return { content: `Store failed: ${errorMessage(error)}` }
          }
        },
      })
    })

    // End of turn. Events carry no location, so only sessions seen in this instance's prompt
    // hook are retained; a session from another location is simply never in `sessions`.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.renamed") {
            const s = sessions.get(event.data.sessionID)
            if (s) s.title = event.data.title
            continue
          }
          if (event.type === "session.execution.succeeded") {
            const id = event.data.sessionID
            if (sessions.has(id)) void retain(id, "turn")
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) log(`event subscription ended: ${errorMessage(error)}`)
      }
    })()

    log(`active for ${project} (bank ${bank}) at ${opts.url}, token ${opts.token ? "set" : "none"}`)
    return () => controller.abort()
  },
}

export default plugin
