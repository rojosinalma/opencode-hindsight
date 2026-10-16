# opencode-hindsight

An [OpenCode](https://opencode.ai) plugin that gives every project an episodic memory backed by a
self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server. Per prompt it recalls
the facts relevant to what the user just asked and injects them into the system prompt as
`## Episodic memory (Hindsight)`; at the end of every turn (and before a compaction) it retains the
new slice of the transcript as a conversation document, fire-and-forget. One memory bank per
project (`<bank_prefix>::<project>`), so sessions in different repos never bleed into each other.
Three tools are registered for the agent: `hindsight_recall` (fast lookup), `hindsight_reflect`
(slow synthesis over many sessions) and `hindsight_retain` (store a fact explicitly).

Configuration, design and troubleshooting are documented in `docs/`.

## Requirements

- OpenCode 2.x running on Bun (the plugin uses the 2.x plugin API: `session.hook`, `tool.transform`, `event.subscribe`).
- A reachable Hindsight server: its base URL and, if the server checks one, a bearer token.
- No runtime dependencies: `@opencode/plugin` is imported as types only.

## Setup

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

## License

MIT — see [LICENSE](LICENSE).
