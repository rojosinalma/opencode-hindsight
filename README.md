# opencode-hindsight

[![run-tests](https://github.com/rojosinalma/opencode-hindsight/actions/workflows/run-tests.yml/badge.svg)](https://github.com/rojosinalma/opencode-hindsight/actions/workflows/run-tests.yml)
[![release](https://img.shields.io/github/v/release/rojosinalma/opencode-hindsight)](https://github.com/rojosinalma/opencode-hindsight/releases)
[![license](https://img.shields.io/github/license/rojosinalma/opencode-hindsight)](LICENSE)

An [OpenCode](https://opencode.ai) plugin that gives every project an episodic memory backed by a
self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server. Per prompt it recalls
the facts relevant to what was just asked and injects them into the system prompt as
`## Episodic memory (Hindsight)`; at the end of every turn (and before a compaction) it retains the
new slice of the transcript as a conversation document, fire-and-forget. One memory bank per
project (`<bank_prefix>::<project>`), so sessions in different repos never bleed into each other.
Three tools are registered for the agent: `hindsight_recall` (fast lookup), `hindsight_reflect`
(slow synthesis over many sessions) and `hindsight_retain` (store a fact explicitly).

Configuration, design and troubleshooting are documented in [`docs/`](docs/).

## Requirements

- [OpenCode](https://opencode.ai) ≥ 2.0 — the plugin uses the 2.x plugin API (`session.hook`,
  `tool.transform`, `event.subscribe`).
- [Bun](https://bun.sh) ≥ 1.4, the runtime OpenCode loads plugins with.
- A reachable [Hindsight](https://github.com/vectorize-io/hindsight) server ≥ 0.10 (the `/v1`
  banks API): its base URL and, if the server checks one, a bearer token.
- No runtime dependencies: `@opencode/plugin` is imported as types only.

## Installation

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
`HINDSIGHT_TOKEN` are read from the environment as fallbacks. All options are listed in
[docs/configuration.md](docs/configuration.md).

## Usage

Start a new session (plugins load per location boot) and work as usual. Facts recalled from earlier
sessions of the same project appear in the system prompt as `## Episodic memory (Hindsight)`; the
block is omitted when nothing ranks. Ask the agent to "remember" something and it calls
`hindsight_retain`; ask what was decided before and it calls `hindsight_recall`. The knob that
matters most is `min_reranker_score`: lower it to inject more, raise it to cut noise. Set
`"debug": true` to see the injected block in OpenCode's log.

When the model's prompt cache matters (local servers with a prefix cache re-prefill from the
system prompt whenever the block changes), set `"inject": "on_demand"`: nothing is injected, retain
keeps running and the agent looks things up with `hindsight_recall` itself. `inject_models` keeps
the block for the models you list, for example `["anthropic/*"]` alongside `on_demand`.

## Development

```sh
bun install   # types only
bun test
```

The plugin is a single `index.ts`; tests live in `test/` and run in CI on every push and pull
request. See [CONTRIBUTING.md](CONTRIBUTING.md) for layout, style and the release process.

## License

AGPL-3.0-only — see [LICENSE](LICENSE). Copyright (C) 2026 rojosinalma.
