# Configuration

Options live in the plugin's `plugins[]` entry in `opencode.jsonc` (snake_case keys). `{env:NAME}`
placeholders are substituted by OpenCode before the plugin sees them; a placeholder that was not
substituted (the variable was unset when the server started) is detected, logged and never sent as
a bearer token.

| key | default | meaning |
|---|---|---|
| `url` | `$HINDSIGHT_URL` | base URL of the Hindsight server (required; trailing slashes are stripped) |
| `token` | `$HINDSIGHT_API_TOKEN` / `$HINDSIGHT_TOKEN` | bearer token, if the server checks one |
| `bank_prefix` | `opencode` | bank name prefix; the bank is `<prefix>::<project>` |
| `projects_root` | unset | directory whose first-level children are the projects (see below) |
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
| `debug` | `false` | log the injected block and recall/retain details |

Numeric options accept numbers or numeric strings; anything unparsable falls back to the default.
`enabled` and `debug` accept booleans or the strings `"true"`/`"false"`.

## The project key

The bank name is `<bank_prefix>::<project>`, where `<project>` is derived from the session's
location:

1. With `projects_root` set (`~` expands to the home directory), any directory under it maps to the
   first path segment below the root. A session rooted in a nested directory of a project —
   `<root>/app/packages/web`, `<root>/app/data/chats/session-1` — shares `app`'s bank. The
   session's working directory is checked first, then OpenCode's git root for it.
2. Otherwise, or for a location outside `projects_root`: the basename of the git root OpenCode
   resolved for the session; if there is none (a directory outside any repo), the basename of the
   working directory; `global` as the last resort.

Set `projects_root` when you keep every repo under one directory and want sessions started in
subdirectories to share their repo's memory. Leave it unset when the git root is already the right
unit, which is the common case.

## Tuning

The two knobs that matter in practice are `min_reranker_score` (lower to inject more, raise to cut
noise) and `recall_max_tokens` (how much of the system prompt the block may take). Raise
`recall_timeout_ms` when the server's reranker is slow under load; a recall that times out is
logged and skipped, it never delays the turn. `debug: true` prints the injected block to OpenCode's
log so you can see what the agent sees.
