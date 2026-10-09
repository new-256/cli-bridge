# CLI Bridge policy (cli-bridge MCP)

中文 | [English](MCP-POLICY.md) — canonical copy; also installed into
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` on the authoring machine.

The local **`agy`** (Google Antigravity), **`codebuddy`** (Tencent CodeBuddy Code,
four product faces) and **`mimo`** (Xiaomi MiMoCode CLI / MiMo Desktop) agent CLIs
are available to this host through the MCP server **`cli-bridge`**, exposed as
`agy_run / agy_continue / agy_status / agy_quota`, `codebuddy_run / codebuddy_continue /
codebuddy_status` and `mimo_run / mimo_continue / mimo_status / mimo_settings`
(server-qualified, e.g. `mcp__cli-bridge__agy_run`). Every CLI runs **fully
non-interactively under host control** — permissions are auto-approved, they never
prompt, and they can edit files, run builds, and investigate multi-file code.

One server exposes all three; run it with `--provider=agy` (or the per-provider
entry `mcp/<id>-mcp-server.mjs`) to expose a single family and keep the older
tool-surface configuration byte-compatible.

## Priority rule — decision table and context pattern

### Tool Selection (identical for all three families)
- **Single read/glob/grep or short (<30s) command** → Use native host tools.
- **Implementing, editing, refactoring, debugging, builds, multi-file investigation** → Prefer `<id>_run` first (pick the family your account/quota favors).
- **Follow-ups on the same topic** → Use `<id>_continue` with `sessionId`/`conversationId` or `latest: true` (conversation context is preserved server-side).
- **Final build/test verification of the CLI's output** → Use native host tools.
- **Image/video generation** → Dispatch to `agy_run` without specifying a model.

### Context Protocol (one topic = one conversation)
- **First dispatch on a topic**: include a compact CONTEXT preamble (point to paths, do not paste file contents; the CLI reads the repo itself):
  ```
  CONTEXT: 2-6 lines — goal; repo root; key paths; decisions/constraints; current state.
  TASK: the complete instruction.
  ```
- **Follow-ups**: call `<id>_continue` and state only what is new.
- When the task must not write files yet, call `<id>_run` with `mode: "plan"`.
- When you delegate to a sub-agent, instruct it to also follow this CLI-first policy.
- While `<id>_run`/`<id>_continue` is running, call `<id>_status` any time to see the
  live per-project step + recent trail without waiting for completion.

## Quota awareness (agy)

`agy_quota` reports the Google AI plan pools. The **Gemini 5-hour window** is the
sole per-task gate (below ~10% remaining the bridge blocks dispatch); an exhausted
weekly bucket does not abort work — it only means agy is a poor pick for the rest
of the week. `codebuddy` has no quota API: watch per-project `runs`/`totalTokens`
via `codebuddy_status`. `mimo_settings` shows the effective backend (CLI vs Desktop).

## Fallback — never loop

When a CLI is **rate-limited or the network is down**, the tool result text says so
explicitly. **Do NOT retry in a loop.** Finish the task with your own tools, or ask
the user whether to fall back to the local model / API config. Never ask the CLI to
call back into this host.
