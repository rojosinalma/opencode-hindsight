# Contributing

## Running it locally

The plugin is a single TypeScript file loaded by an OpenCode 2.x server. Clone it where that server
looks for plugins and point a `plugins[]` entry at it:

```sh
git clone https://github.com/rojosinalma/opencode-hindsight ~/.config/opencode/plugins/hindsight
```

```jsonc
{ "plugins": [{ "package": "./plugins/hindsight", "options": { "url": "https://hindsight.example.com", "debug": true } }] }
```

Start a new session (plugins load per location boot) and watch OpenCode's log for `[hindsight]`
lines. `debug: true` prints the injected block, so you see exactly what the agent gets. You need a
reachable Hindsight server; any bank name works, the plugin creates it.

## Tests

```sh
bun install   # types only
bun test
```

`test/scope.test.ts` covers the pure functions: option resolution (defaults, coercion, env
fallbacks, the unsubstituted `{env:…}` guard) and the project key (`scopeOf`) with and without
`projects_root`. `test/inject.test.ts` covers the injection modes: the `shouldInject` matrix and
`plugin.setup` against a fake context with a stubbed `fetch`, one test per mode. Everything else
about hook behaviour is verified against a running server. CI runs the same suite on
every push and pull request (`.github/workflows/run-tests.yml`).

## Code style and layout

- `index.ts` holds everything: options, project key, the Hindsight client, renderers, the plugin
  object. Pure functions that tests need are exported; the plugin object is the default export.
- No runtime dependencies. `@opencode/plugin` stays an `import type`; everything else is a Bun/Node
  builtin.
- Two-space indent, no semicolons, double quotes, `snake_case` option keys mapped to `camelCase`
  internally.
- Every network call goes through `Client.call` so it has a timeout; every failure logs once and
  returns. Do not add a code path that can block a turn.

## Commits and PRs

Plain, descriptive commit messages in the imperative ("Add retain cursor to plugin storage").
One logical change per commit, every commit GPG-signed (`git config commit.gpgsign true`). Open a
pull request against `main`; `run-tests` must be green before it merges.

## Documentation

- `README.md` — what it is, requirements, installation, usage, development, licence. Nothing else.
- `docs/configuration.md` — every option, the project key, tuning.
- `docs/SDD.md` — design: architecture, data model, flows, decisions, operations.
- `docs/troubleshooting.md` — symptoms, log lines and fixes.
- `CHANGELOG.md` — Keep a Changelog; add your change under `Unreleased`.
- `SECURITY.md`, `CODE_OF_CONDUCT.md` — reporting path and conduct.

A change in behaviour updates the matching doc and the changelog in the same commit.

## Releasing

Bump `version` in `package.json`, move the `Unreleased` section of `CHANGELOG.md` under the new
version, commit, then create a signed tag and a GitHub release whose notes are that section:

```sh
git tag -s vX.Y.Z -m vX.Y.Z
git push --follow-tags
gh release create vX.Y.Z --title "opencode-hindsight X.Y.Z" --notes-file <section>
```
