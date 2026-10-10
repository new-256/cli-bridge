# deploy/legacy-mcp — 家级 MCP 薄封装的调度门禁物料

本目录是 **部署物料**（不随 npm 包发布），逐字节对应运行时落点：

```
{DSH_HOME}/bin/cli-bridge-scheduling.mjs
```

背景：本机 DSH 的 MCP 全局注册（`cordis.patch.yml` 的 mcp-agy-global /
mcp-codebuddy-global / mcp-mimo-global）跑的是 `dsh-home\bin\` 下的自包含旧版
服务器（不依赖 @luchenglong/cli-bridge 包体）。0.2.0 CLI 调度要覆盖这条真实生效面，
三个旧服务器在 `tools/list` / `tools/call` 现读本 helper（`filterTools(id, TOOLS)`）：

- 读 `{DSH_HOME}/cli-bridge-settings.json` 顶层 `_scheduling.enabled`（设置面板写）；
- 文件缺失 / 无该区 / JSON 损坏 / 异常 → 全部启用（fail-open，与门禁上线前逐字一致）；
- `enabled: []` → 显式全关（该面空工具表、调用拒 Unknown tool）；
- `CLI_BRIDGE_PROVIDER` 钉住单面 → 最高优先（薄封装兼容语义）。

语义单源在包内 `core/scheduling.mjs`；本文件是它面向「无包依赖的旧自托管服务器」的
最小只读副本（唯一写者 = 设置面板）。改包内语义时同步改这里并重新部署：

```powershell
Copy-Item <repo>\deploy\legacy-mcp\cli-bridge-scheduling.mjs `
  "$env:APPDATA\DSH Desktop\dsh-home\bin\cli-bridge-scheduling.mjs" -Force
# 三个旧服务器（agy-mcp-server.mjs / codebuddy-mcp-server.mjs /
# mimo-mcp\mcp\mimo-mcp-server.mjs）里各有一处 tools/list + tools/call 门禁接线，
# 已在 2026-10-10 直接改在 bin\ 部署副本上（git 不追踪 bin\，本目录是唯一权威源）。
```

验证（无需 DSH 重启，MCP 子进程重启即读到新逻辑）：设置面板关掉某面后，
新会话的 `mcp__<id>__*` 工具应缺席；`tools/list` 返回空数组。
