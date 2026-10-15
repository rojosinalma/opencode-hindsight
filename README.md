# opencode-hindsight

An [OpenCode](https://opencode.ai) plugin that gives every project an episodic memory backed by a
self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server. Per prompt it recalls
the facts relevant to what the user just asked and injects them into the system prompt as
`## Episodic memory (Hindsight)`; at the end of every turn (and before a compaction) it retains the
new slice of the transcript as a conversation document, fire-and-forget. One memory bank per
project (`<bank_prefix>::<project>`), so sessions in different repos never bleed into each other.
Three tools are registered for the agent: `hindsight_recall` (fast lookup), `hindsight_reflect`
(slow synthesis over many sessions) and `hindsight_retain` (store a fact explicitly).

## Install

Clone into the global plugins directory and add a `plugins[]` entry — the plugin needs at least a
`url`:

```sh
git clone https://github.com/rojosinalma/opencode-hindsight ~/.config/opencode/plugins/hindsight
```

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/hindsight",
      "options": {
        "url": "https://hindsight.example.com",
        "token": "{env:HINDSIGHT_API_TOKEN}",
        "min_reranker_score": 0.1,
        "recall_max_tokens": 800
      }
    }
  ]
}
```

`{env:…}` substitution works inside plugin options. `HINDSIGHT_URL`, `HINDSIGHT_API_TOKEN` and
`HINDSIGHT_TOKEN` are read from the environment as fallbacks. No runtime dependencies
(`@opencode/plugin` is imported as types only).

## Options

| key | default | meaning |
|---|---|---|
| `url` | `$HINDSIGHT_URL` | base URL of the Hindsight server (required) |
| `token` | `$HINDSIGHT_API_TOKEN` / `$HINDSIGHT_TOKEN` | bearer token, if the server checks one |
| `bank_prefix` | `opencode` | bank name prefix; the bank is `<prefix>::<project>` |
| `projects_root` | `~/dev` | directory whose first-level children are the projects (a session rooted deeper maps to that child) |
| `recall_budget` | `low` | search effort for the per-prompt recall: `low` / `mid` / `high` |
| `recall_max_tokens` | `800` | size of the injected block |
| `min_reranker_score` | `0.1` | drop recalled facts below this score (`0` injects whatever ranks) |
| `recall_timeout_ms` | `3000` | recall request timeout |
| `retain_timeout_ms` | `10000` | retain request timeout |
| `reflect_timeout_ms` | `120000` | reflect request timeout |
| `retain_min_chars` | `200` | skip retaining transcript slices shorter than this |
| `retain_max_chars` | `6000` | truncate retained slices to this |
| `recall_query_max_chars` | `500` | truncate the prompt used as recall query |
| `enabled` | `true` | kill switch |
| `debug` | `false` | log the injected block |

## How it works

1. `session.hook("prompt")` records the prompt text; `session.hook("context")` runs one recall per prompt and injects the block (stable across the steps of a turn, omitted when empty).
2. `session.execution.succeeded` and `session.hook("compaction")` retain the transcript since the last cursor (kept in plugin storage) as document `conversation:<sessionID>`.
3. Every request has an `AbortController` timeout; a dead server costs one log line per failure and never blocks a turn.

## Caveats

- The project key falls back to the git root's basename, then the directory name, when the location is outside `projects_root`.
- Loaded per location boot; running locations keep the plugin set they started with.
