# Troubleshooting

Every log line is prefixed `[hindsight]` and goes to OpenCode's stderr/log.

## Nothing is injected

- `no url configured, plugin inactive` at startup: set `url` in the options or `HINDSIGHT_URL` in
  the server's environment.
- `disabled by config`: `enabled` is `false`.
- Recall ran but returned nothing: the block is omitted when there are no results. Lower
  `min_reranker_score` (`0` injects whatever ranks) or set `debug: true` to see the result count
  and timing per recall.
- `recall failed for <session> (… ms): timeout`: raise `recall_timeout_ms`. A dead or slow server
  costs one log line per failure and never blocks the turn.

## No `## Episodic memory` block although the server is up

- Check `inject` and `inject_models` (see `configuration.md` → Injection modes): `on_demand` and
  `never` inject nothing, and a non-empty `inject_models` drops the block for every model not on
  the list. The startup line `active for … inject <mode>` shows the mode in effect.
- With `debug: true`, each request that is not injected logs
  `injection skipped for <session> (<mode>, <provider>/<model>)`, so you can see which model id
  to add to `inject_models`.

## Token problems

- `token {env:HINDSIGHT_API_TOKEN} was not substituted by opencode`: the variable was unset when
  the OpenCode server started. Set it in the server's environment and restart the server; the
  plugin falls back to `HINDSIGHT_API_TOKEN` / `HINDSIGHT_TOKEN` from its own environment in the
  meantime.
- `HTTP 401` / `HTTP 403` on any call: wrong token or the server does not know the bank's tenant.

## Bank and project key

- The bank is `<bank_prefix>::<project>`; the startup line `active for <project> (bank …)` shows
  what was derived. If sessions that should share memory land in different banks, set
  `projects_root` (see `configuration.md` → The project key) or check that OpenCode resolves the
  same git root for both.
- `bank … not ensured: …`: the `PUT` that creates the bank failed; it is retried on the next use.

## Nothing is retained

- `retain skipped … chars < retain_min_chars`: the new transcript slice was too short. Lower
  `retain_min_chars` if short turns matter to you.
- Retention runs on `session.execution.succeeded`; a turn that ended in an error is retained at the
  next successful turn or at compaction, because the cursor only moves after a successful send.
- The cursor lives in plugin storage (`hindsight/cursor/<sessionID>`), so a plugin reload does not
  re-send the whole transcript.

## Plugin loading

- Plugins are loaded per location boot: a running location keeps the plugin set and options it
  started with. Edit `opencode.jsonc`, then start a new session (or restart the server) to pick up
  changes.
- No `node_modules` is needed in the plugin directory: `@opencode/plugin` is a type-only import.
