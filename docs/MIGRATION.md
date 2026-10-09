# 从三个旧包迁移到 @luchenglong/cli-bridge

三个旧包（`agy-first-bridge` ≤1.7.1、`codebuddy-first-bridge` ≤1.6.2、
`mimo-first-bridge` ≤1.2.9）已全部并入本包并 deprecated。**行为与接口的兼容性是逐字级
的**，迁移只是「换包名 + 换路径」：

## 不变的东西（刻意设计）

| 项 | 旧 | 新 | 变化 |
| --- | --- | --- | --- |
| 工具名 | `agy_run` / `codebuddy_run` / `mimo_run` …（含 continue/status/quota/settings） | 同左 | **无** |
| 工具入参/返回语义 | 旧包定义 | verbatim 移植 | **无** |
| preset id | `cordis-agy` / `codebuddy-first` / `cordis-mimo` | 同左 | **无**（旧会话头直接续用） |
| 优先策略/POLICY 文本 | 各旧包 | verbatim | **无** |
| 回退弹窗三选一 | 各旧包 | 统一内核实现，标签/语义一致 | 无 |
| env 变量 | 各旧包（见 INSTALL 总表） | 全部保留 | 无 |
| 家级路由 | `/{agy,codebuddy,mimo}-indicator/status` 等 | 保留为兼容别名，新增 `/cli-bridge/status` 聚合 | 兼容 |
| 设置语义（token 掩码/空=保持/Clear=清除） | codebuddy v1.3+ | 统一面板逐字段保留 | 兼容 |
| 旧设置文件 | `codebuddy-bridge-settings.json`、`{APPDATA}/mimo-first-bridge/settings.json` | 自动一次性迁移（新分区没写过该字段才回退旧值；写新不写旧） | 无损 |
| MCP 快照文件 | `{DSH_HOME}/plugins/agy-indicator/mcp-live.json`、`{DSH_HOME}/codebuddy-indicator-mcp.json`、`{DSH_HOME}/plugins/mimo-indicator/mcp-live.json` | 新名 `cli-bridge-mcp-<id>.json`；三个旧名仍被家级灯兼容读取 | 无损 |

## 需要动手的三处

1. **DSH profile / bundles**：删除三个旧包条目，加入 `@luchenglong/cli-bridge`
   （操作前必须停止 DSH 后端——运行时改接线有损坏风险）。
2. **外部 MCP 配置**（Claude Code / Cursor 等）：`args` 路径从
   `<旧包>/mcp/<id>-mcp-server.mjs` 换成 `<新包>/mcp/<id>-mcp-server.mjs`（同名兼容入口，
   也可换 `mcp/cli-bridge-mcp.mjs` 一次拿全部三家）。
3. **直接引用过旧包内部路径的脚本**（如有）：旧 `core/*` → 新
   `providers/<id>.mjs` + `core/bridge-kit.mjs`；旧 preset 模块路径 → 新
   `@luchenglong/cli-bridge/preset-<id>`（exports 子路径）。

## 版本对应

`0.1.0` 的功能基线 = agy 1.7.1 + codebuddy 1.6.2 + mimo 1.2.9 之和。
三家完整历史在 [docs/history/](history/)（verbatim）；统一包自己的演进在
[CHANGELOG.md](../CHANGELOG.md)。

## 旧包仓库

三个旧仓库将只读归档（README 顶部挂迁移横幅）。npm 上已执行
`npm deprecate <旧包>@"*" "replaced by @luchenglong/cli-bridge"`。
不要再向旧包提 issue/PR —— 一律发到新仓库。
