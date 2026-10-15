# CLI Bridge

**Chinese only for now** · [中文 README](README.md)

> A Cordis plugin package for **DeepSeek Harness (DSH)**: dispatch real coding /
> build / debug / investigation work to **local CLI agents** — Google
> **Antigravity (`agy`)**, Tencent **CodeBuddy Code**, Xiaomi **MiMo (MiMoCode CLI /
> MiMo Desktop)** — with DSH fully controlling each CLI (non-interactive, never
> prompts), a **rate-limit/network fallback dialog** (switch to the DSH local API
> configuration), one **aggregated live status pill** in the session header
> (segmented per provider), and a **unified settings panel** for preferences and
> credentials across all three.
>
> This package merges and replaces three legacy packages — `agy-first-bridge`
> (final 1.7.1), `codebuddy-first-bridge` (final 1.6.2), `mimo-first-bridge`
> (final 1.2.9). All legacy features are preserved verbatim; see
> [docs/MIGRATION.md](docs/MIGRATION.md) (Chinese) for the compatibility matrix.

---

## What you get

1. **Three model tools per provider** — `<id>_run` / `<id>_continue` / `<id>_status`
   (plus `agy_quota` and `mimo_settings`). **Tool names, parameters and result
   semantics are byte-compatible with the legacy packages**, so existing sessions
   and prompts keep working untouched.
2. **A CLI-first policy section** injected per provider so the model dispatches
   implementation work to the CLI in every mode (plan / accept-edits / subagents /
   workflow / goal rounds) while native tools stay for read-only queries and final
   verification.
3. **One aggregated status pill** (home-level plugin, auto-loaded with DSH): green
   ready/success, yellow running, red failed, grey unavailable, amber local
   fallback, highlighted when the session itself runs under a bridge preset.
   Hover shows the live step; click opens a per-provider, per-project activity
   panel (folded current step + trail, cumulative runs / tokens, last finished run).
4. **Unified settings** (DSH settings page, one card per provider, meta-driven):
   secrets are never returned in plaintext (masked, "empty keeps, Clear erases"
   semantics preserved from CodeBuddy v1.3+). Persisted to
   `{DSH_HOME}/cli-bridge-settings.json` partitioned by provider, with **one-time
   field-level migration from the legacy settings files**.

## Four shapes, one descriptor

A single provider descriptor drives every runtime shape (zero duplicated logic):

| Shape | Where | Notes |
| --- | --- | --- |
| **Agent presets** (recommended) | [`preset/`](preset/) | `cordis-agy` / `codebuddy-first` / `cordis-mimo` — ids unchanged from legacy |
| **Home-level indicator bundle** | [`home-plugin/cli-bridge-indicator/`](home-plugin/cli-bridge-indicator/) | pill + settings + routes + declaration-based preset registration; ships via `dsh.bundle.patch` |
| **Dynamic sandbox host** | [`dynamic/<id>.host.js`](dynamic/) (generated from templates) | for compositions that cannot mount a preset |
| **MCP stdio server** | [`mcp/cli-bridge-mcp.mjs`](mcp/) (bin `cli-bridge-mcp`) | one server exposes all providers; `mcp/<id>-mcp-server.mjs` = single-provider drop-in for legacy configs |

```json
{ "mcpServers": { "cli-bridge": {
  "command": "node",
  "args": ["<install>/node_modules/@luchenglong/cli-bridge/mcp/cli-bridge-mcp.mjs"] } } }
```

MCP runs out-of-process, so it publishes state by atomically writing
`{DSH_HOME}/cli-bridge-mcp-<id>.json` (stale after 90 s) which the home pill merges
live — running `agy` from Claude Code still lights up the DSH title bar.

## Install

```bash
npm install -g @luchenglong/cli-bridge
```

DSH wiring (bundle + presets + indicator in one step): see
[docs/INSTALL.md](docs/INSTALL.md) (Chinese; read the red lines first — stop the DSH
backend before touching runtime wiring). `npm run deploy:local` only stages a
directory; it never edits your profile.

## Development

```bash
node scripts/build.mjs               # regenerate dynamic hosts + legacy YAML
node scripts/verify.mjs              # publish red-line gate
node --test                          # unit tests (kit + keystone + per provider)
node mcp/cli-bridge-mcp.mjs --check  # MCP self-check
npm run check                        # all gates
```

Adding a fourth CLI? Implement one descriptor per
[PROVIDER-CONTRACT.md](PROVIDER-CONTRACT.md) — every shape comes free.

## Docs

- [README.md](README.md) — full Chinese documentation (canonical)
- [docs/INSTALL.md](docs/INSTALL.md) — install & wiring, env-var matrix
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — shared core, state machine, red lines
- [docs/MIGRATION.md](docs/MIGRATION.md) — legacy package compatibility table
- [docs/RELEASE-SOP.md](docs/RELEASE-SOP.md) — release procedure & gates
- [CHANGELOG.md](CHANGELOG.md) + [docs/history/](docs/history/) — merged history and full legacy lineages

## License

[MIT](LICENSE)
