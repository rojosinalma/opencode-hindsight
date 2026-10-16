# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-16

### Added

- `inject` option (`always` / `on_demand` / `never`, default `always`): `on_demand` injects
  nothing and makes no per-prompt recall while retain keeps running, for models whose prefix cache
  a changing system prompt would invalidate; `never` also stops the automatic retain. The tools
  stay available in every mode; an unknown value warns and falls back to `always`.
- `inject_models` option: a list of `provider/model` ids (array or comma-separated string,
  `provider/*` for a whole provider) that get the block in `always` and `on_demand`; unlisted
  models do not.
- `debug: true` logs `injection skipped for <session> (<mode>, <provider>/<model>)` when a request
  is not injected.

### Changed

- The `hindsight_recall` description tells the agent to look things up itself when injection is
  off.
- The startup line `active for …` states the inject mode.

## [0.1.0] - 2026-10-16

First release.

### Added

- Per-prompt recall: facts relevant to the latest prompt are fetched from the project's Hindsight
  bank and injected into the system prompt as `## Episodic memory (Hindsight)`; the block is stable
  across the steps of one turn and omitted when nothing ranks.
- Retain at the end of every turn and before a compaction: the new transcript slice is appended to
  the bank as a conversation document, fire-and-forget, with a cursor in plugin storage.
- Agent tools `hindsight_recall` (fast lookup), `hindsight_reflect` (slow synthesis across sessions)
  and `hindsight_retain` (store a fact explicitly).
- One bank per project (`<bank_prefix>::<project>`), the project key derived from `projects_root`
  or the session's git root.
- Options in `plugins[].options` with `{env:…}` substitution and `HINDSIGHT_URL` /
  `HINDSIGHT_API_TOKEN` / `HINDSIGHT_TOKEN` as environment fallbacks; every request bounded by a
  timeout so a dead server never blocks a turn.
- Test suite for option resolution and the project key (`bun test`), run in CI on every push and
  pull request.
- `docs/configuration.md`, `docs/SDD.md`, `docs/troubleshooting.md`, `CONTRIBUTING.md`,
  `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and pull request templates, Dependabot.

### Changed

- Licence is AGPL-3.0-only (the unreleased history was MIT).

[Unreleased]: https://github.com/rojosinalma/opencode-hindsight/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/rojosinalma/opencode-hindsight/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rojosinalma/opencode-hindsight/releases/tag/v0.1.0
