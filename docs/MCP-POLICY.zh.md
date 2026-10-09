# CLI Bridge 优先策略（cli-bridge MCP）· 中文版

[English](../MCP-POLICY.md) | 中文 —— 权威文本；开发机上同步安装到
`~/.claude/CLAUDE.md` 与 `~/.codex/AGENTS.md`。

本机三个编码 CLI agent —— **`agy`**（Google Antigravity）、**`codebuddy`**（腾讯
CodeBuddy Code，四种产品形态）与 **`mimo`**（小米 MiMoCode CLI / MiMo Desktop）——
经 MCP server **`cli-bridge`** 暴露为工具：`agy_run / agy_continue / agy_status /
agy_quota`、`codebuddy_run / codebuddy_continue / codebuddy_status`、
`mimo_run / mimo_continue / mimo_status / mimo_settings`（宿主侧带服务前缀，如
`mcp__cli-bridge__agy_run`）。所有 CLI **全程受宿主掌控、完全非交互**：权限自动批准、
绝不弹提示，可以直接改文件、跑构建、做跨文件排查。

一个 server 同时暴露三家；用 `--provider=agy`（或单家入口 `mcp/<id>-mcp-server.mjs`）
可只开一家，工具面与旧包配置逐字兼容。

## 优先规则 —— 决策表与上下文协议

### 工具选择（三家同构）
- **单条 read/glob/grep 或 <30 秒短命令** → 用宿主原生工具。
- **实现、编辑、重构、调试、构建、跨文件排查** → 优先 `<id>_run`（按账号/额度选家族）。
- **同主题后续** → `<id>_continue` 带 `sessionId`/`conversationId` 或 `latest: true`
  （会话上下文由服务端保留）。
- **对 CLI 产出做最终构建/测试验证** → 用宿主原生工具。
- **图像/视频生成** → 派给 `agy_run`，不指定模型。

### 上下文协议（一个主题 = 一个会话）
- **主题首次派发**：带一段紧凑 CONTEXT 前言（指向路径，不要粘贴文件内容；CLI 自己读仓库）：
  ```
  CONTEXT: 2-6 行 —— 目标；仓库根；关键路径；决定/约束；当前状态。
  TASK: 完整指令。
  ```
- **后续**：调用 `<id>_continue`，只说新增部分。
- 任务暂时不许写文件时，`<id>_run` 用 `mode: "plan"`。
- 委派子代理时，要求其同样遵守本 CLI 优先策略。
- `<id>_run`/`<id>_continue` 运行期间可随时 `<id>_status` 看各项目此刻步骤与最近轨迹，
  无需等待完成。

## 额度感知（agy）

`agy_quota` 返回 Google AI 套餐各池余量。**Gemini 5 小时窗口是唯一的任务级门禁**
（余量低于约 10% 时桥接会直接拦截派发）；周池耗尽不会中止工作 —— 只代表本周剩余时间
agy 不是好选择。codebuddy 无额度 API：用 `codebuddy_status` 观察各项目
`runs`/`totalTokens`。`mimo_settings` 查看生效后端（CLI vs Desktop）。

## 回退 —— 绝不循环

CLI **被限流或网络不通**时，工具结果文本会明确说明。**不要循环重试。** 用自己的工具
完成任务，或询问用户是否回退到本地模型/API 配置。绝不让被派发的 CLI 回调宿主。
