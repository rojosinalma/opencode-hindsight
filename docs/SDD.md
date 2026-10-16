# Software design document

## Purpose

Give every OpenCode project a durable episodic memory without changing how the agent is driven.
Facts from earlier sessions (decisions, fixes, conventions, failed attempts) are recalled per
prompt and placed in the system prompt; new transcript slices are retained after every turn so the
next session can recall them. Hindsight does the extraction, storage and ranking; this plugin is
the glue between OpenCode's plugin hooks and Hindsight's HTTP API.

## Architecture

One file, `index.ts`, exporting the plugin object (`id: "hindsight"`) plus the pure functions
`resolveOptions`, `scopeOf` and `shouldInject` for tests.

Components inside it:

- **Option resolution** (`resolveOptions`): reads `plugins[].options`, applies defaults, falls back
  to `HINDSIGHT_URL` / `HINDSIGHT_API_TOKEN` / `HINDSIGHT_TOKEN`, refuses an unsubstituted
  `{env:…}` token.
- **Project key** (`scopeOf`, `projectUnder`): derives `<project>` from the session location; the
  bank is `<bank_prefix>::<project>`.
- **Client** (`class Client`): `fetch` wrapper against `/v1/default/banks/<bank>` with a bearer
  header and an `AbortController` timeout per call. Methods: `ensureBank` (`PUT` the bank with a
  retain mission), `recall` (`POST /memories/recall`), `retain` (`POST /memories`, `async: true`),
  `reflect` (`POST /reflect`).
- **Session state** (`Map<sessionID, SessionState>`, capped at 200 entries, oldest evicted): the
  current prompt, the cached recall block promise, the retain cursor, a busy flag and the title.
- **Renderers**: `renderRecall` turns results into the `## Episodic memory (Hindsight)` block;
  `renderTranscript` turns transcript messages into `User:` / `Assistant:` lines, dropping tool
  output and reasoning.

OpenCode talks to the plugin through hooks; the plugin talks to Hindsight over HTTPS. Nothing else.

```
OpenCode ──prompt hook────────▶ record prompt (query)
         ──context hook───────▶ recall(query) ─────────▶ Hindsight /memories/recall
         ◀─system text────────   render block
         ──execution.succeeded▶ retain(transcript slice) ▶ Hindsight /memories (async)
         ──compaction hook────▶ retain + recall
         ──tool calls─────────▶ hindsight_recall / _reflect / _retain
```

## Data model / storage

- **Hindsight bank** `<bank_prefix>::<project>`, created idempotently with a retain mission that
  tells the extractor to keep durable facts about the project and skip conversational meta.
- **Conversation document** `conversation:<sessionID>`, `update_mode: append`: every retained slice
  is appended, tagged `source:opencode`, `project:<project>`, with `session_id`, `title`, `project`
  in metadata.
- **Notes** from `hindsight_retain`: document `note:<sessionID>:<timestamp>`, tag `kind:note`.
- **Plugin storage** (OpenCode's per-plugin key-value store): `hindsight/cursor/<sessionID>` = the
  number of transcript messages already retained. Survives reloads so a document is never re-sent.
- **In memory**: the session map above. No other state, no files.

## Key flows

1. **Recall per prompt.** `session.hook("prompt")` stores the head of the prompt
   (`recall_query_max_chars`). `session.hook("context")` first checks
   `shouldInject(opts, event.model)` (`inject` mode and `inject_models` filter) and returns without
   a request when the block is not wanted. Otherwise it calls `recallBlock(sessionID)`: if the
   cached block belongs to the current prompt it is reused, otherwise one recall request runs and
   its promise is cached, so every step of the turn (tool-call rounds) shares one request and gets
   an identical block — which keeps the provider's prompt cache warm. An empty result injects
   nothing.
2. **Retain per turn.** On `session.execution.succeeded` for a session this instance has seen,
   `retain` loads the cursor (storage, then memory), fetches the transcript, renders the slice
   after the cursor, skips it below `retain_min_chars`, truncates at `retain_max_chars`, sends it
   with `async: true`, then advances the cursor in memory and storage. A `busy` flag coalesces
   overlapping calls.
3. **Compaction.** `session.hook("compaction")` retains first (so nothing is lost when the
   transcript is summarised), then injects the recall block into the compaction prompt, under the
   same `shouldInject` check.
4. **Tools.** `hindsight_recall` (budget selectable, 2000-token cap), `hindsight_reflect` (prose
   answer, long timeout), `hindsight_retain` (explicit note, 20 000-char cap). All report errors as
   tool content, never as thrown exceptions.
5. **Titles.** `session.renamed` events update the cached title used in the retain context.

## Configuration surface

All keys in `docs/configuration.md`. Defaults are the `DEFAULTS` constant; `url`, `token` and
`projects_root` have no built-in default beyond the environment fallbacks.

## Decisions and rationale

- **Fire-and-forget everywhere.** Every request has a timeout; failures log one line and return.
  Memory must never cost a turn.
- **One recall per prompt, cached across steps.** A fresh recall per step would change the system
  prompt between tool rounds and invalidate the provider's prompt cache.
- **Injection is optional per model.** Even cached per prompt, the block changes every turn and sits
  before the conversation, so a server with a prefix cache re-prefills everything after the system
  prompt on every turn. `inject: on_demand` and `inject_models` turn the block off where that cost
  matters and leave the agent the tools to recall itself; when the block is not injected the recall
  request is skipped entirely, not just its output.
- **Transcript text only.** Tool outputs and reasoning are dropped before retaining: Hindsight
  extracts facts from what was said and decided, not from file dumps, and the slice stays small.
- **Cursor in plugin storage, not in the bank.** Cheap, local, and it makes a plugin reload
  idempotent.
- **`projects_root` is opt-in.** The git root is the natural unit; the root mapping exists for
  setups that start sessions in subdirectories and want them to share the repo's bank.
- **Distinct heading.** `## Episodic memory (Hindsight)` so the block cannot be confused with other
  memory blocks in the same system prompt.
- **Type-only dependency.** `@opencode/plugin` is imported with `import type`, so the plugin runs
  from a bare clone with no `node_modules`.

## Current scope and non-goals

Today the plugin recalls and retains per project, exposes three tools and uses Hindsight's default
tenant (`/v1/default`). It does not manage Hindsight itself (deployment, model choice, bank
deletion), does not share banks across projects and does not read tool output into memory. Those
are the current boundaries, not a ceiling.

## Operations

- **Logs**: `[hindsight] …` on OpenCode's stderr. Startup prints `active for <project> (bank …) at
  <url>, token set|none, inject <mode>`; every retain prints size, reason, duration and the
  Hindsight operation id; failures print the reason. `debug: true` adds the injected block, recall
  timings and `injection skipped …` for requests that get no block.
- **Health**: no endpoint of its own; a dead server shows up as `recall failed … timeout` lines
  and nothing injected. Check the Hindsight server directly.
- **Upgrade**: `git pull` in the plugin directory, then start a new session (plugins load per
  location boot). No migrations; the cursor keys are stable.
- **Tests**: `bun test` (`test/`), run in CI by `.github/workflows/run-tests.yml`.
