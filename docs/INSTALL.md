# 安装指南（CLI Bridge）

一个包四种形态，可组合使用：

1. **持久 Agent Preset**（推荐主形态）—— 三家工具 + 优先策略 + 回退弹窗 + `<id>_status`：
   `cordis-agy` / `codebuddy-first` / `cordis-mimo`（preset id 与旧包一致，旧会话直接续用）；
2. **家级指示灯插件** —— 状态灯、统一设置面板、preset 声明注册，随 DSH 启动自动加载、
   所有会话显示、无需审批（`home-plugin/cli-bridge-indicator`，经包内 `dsh.bundle.patch` 挂载）；
3. **动态 Cordis 插件** —— 沙箱内临时形态（`dynamic/<id>.host.js`），给不方便装 preset 的
   组合用；
4. **MCP stdio server** —— 给 DSH 之外的任何 MCP 客户端（Claude Code / Cursor / …）：
   `node mcp/cli-bridge-mcp.mjs`（或单家入口 `mcp/<id>-mcp-server.mjs`）。

**推荐组合：方式 A + 方式 B** —— 一次接线，三家工具与常驻状态灯齐备。

---

## 前提

- 一套可运行的 **DeepSeek Harness (DSH)**（`>=0.1.1-rc.2 <0.3.0-0`，本机 0.2.1-alpha.1 验证）。
- 至少装好一家你要用的本机 CLI（工具会在缺失时亮灰灯并给出安装指引，不会崩）：
  - `agy`（Google Antigravity CLI）—— 需已登录（`agy login`）；
  - `codebuddy`（`npm i -g @tencent-ai/codebuddy-code`）；workbuddy/codebuddy-en 走桌面捆绑路径；
  - `mimo`（MiMoCode CLI）或运行中的 Xiaomi MiMo Desktop（mimo-desktop 后端）。
- 会话组合挂载这些 Host 服务（`standard` 系 preset 默认都有）：`tools`、`subprocess`、
  `systemPrompt`、`timer`；可选增强：`jobs`（后台任务）、`planMode`（plan 自动判定）、
  `sandboxPolicy`（默认 cwd）、`userQuestions`（回退弹窗）。

---

## 方式 A + B：bundle 接线（一次装齐，推荐）

本包是「双面 bundle」：`dsh.bundle.patch` 只带一行 indicator（家级灯 + 设置 + 路由），
三家 preset 由 indicator 内 **声明制自注册**（Form-A，`agentPresets.register`），
任何受支持 DSH 版本一步到位。

1. 安装依赖到 profile（停 DSH 后端后操作；运行中改 bundles 有损坏风险，红线）：

   ```powershell
   npm run deploy:local        # 暂存到 {DSH_HOME}/staging/cli-bridge（只拷贝，不改 profile）
   ```

   或全局安装后直接引用 npm 包：`npm i -g @luchenglong/cli-bridge`。

2. 在 profile 的 `package.json` 加依赖（file: 或版本号），并把包名加入 bundles 列表：

   ```jsonc
   {
     "dependencies": { "@luchenglong/cli-bridge": "file:C:/Users/<you>/AppData/Roaming/DSH Desktop/dsh-home/staging/cli-bridge" },
     "bundles": ["@luchenglong/cli-bridge"]
   }
   ```

3. 若之前挂着三个旧桥接包：删除它们的依赖与 bundle 条目（迁移见 [docs/MIGRATION.md](docs/MIGRATION.md)）。

4. 重启 DSH，验证：
   - 模式菜单出现 **AGY 执行代理 / CodeBuddy 执行代理 / MiMo 执行代理** 三个 preset；
   - 标题栏出现一盏聚合 pill（AGY · CB · MIMO 分区）；
   - `GET http://127.0.0.1:<port>/cli-bridge/status` 返回三桶 JSON；
   - 设置页出现「CLI Bridge」段（三家卡片 + 诊断）。

## 方式 C：动态宿主（无 preset 的组合）

把 `dynamic/<id>.host.js`（仓库已带生成物；改模板后 `node scripts/build.mjs` 重新生成）
粘贴进 Cordis 组合的 `code.host`。沙箱内零 import，宿主能力走 `harness.*`；状态经
`cliBridgeCollector`（旧 `agyCollector/codebuddyCollector/mimoCollector` 别名兼容）汇入灯。

## 方式 D：MCP server（DSH 之外）

```json
{
  "mcpServers": {
    "cli-bridge": {
      "command": "node",
      "args": ["<安装路径>/@luchenglong/cli-bridge/mcp/cli-bridge-mcp.mjs"]
    }
  }
}
```

只要一家：`args` 换成 `mcp/agy-mcp-server.mjs`（等价 `--provider=agy`），其余配置与旧包一致。
自检：`node mcp/cli-bridge-mcp.mjs --check`。

**MCP 形态的状态灯**：MCP 进程把状态原子写到 `{DSH_HOME}/cli-bridge-mcp-<id>.json`
（90s 内有效），DSH 里常驻的家级灯自动合并显示；家级插件不在线时，灯自然熄灭（快照过期），
不会误报「运行中」。旧包快照文件（`codebuddy-indicator-mcp.json`、
`plugins/mimo-indicator/mcp-live.json`）仍被兼容读取。

---

## 设置

DSH 设置页 →「CLI Bridge」：每家一张卡片（字段由 provider 声明），token 类字段只显掩码
（保存留空 = 保持现值，勾选清除 = 显式删除）。落盘 `{DSH_HOME}/cli-bridge-settings.json`
（按 provider 分区；env `CLI_BRIDGE_SETTINGS_FILE` 可覆盖）。
旧包设置文件（`codebuddy-bridge-settings.json`、`{APPDATA}/mimo-first-bridge/settings.json`）
会被**一次性字段级迁移**：新文件没写过该字段则自动回退旧值，写过即以新值为准；永不写旧文件。

## 环境变量总表（与旧包逐字一致，另加统一项）

| 变量 | 作用 |
| --- | --- |
| `AGY_BIN` / `AGY_CLI` | agy 可执行覆盖 |
| `AGY_MCP_CWD` | agy 默认工作目录 |
| `CLI_BRIDGE_AGY_QUOTA`（兼容旧 `AGY_QUOTA_SCRIPT`） | 额度脚本路径覆盖（默认包内 bin） |
| `CODEBUDDY_BIN` / `CODEBUDDY_EN_BIN` / `WORKBUDDY_BIN` | codebuddy 各家可执行覆盖 |
| `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_BASE_URL` / `CODEBUDDY_INTERNET_ENVIRONMENT` | codebuddy 端点与凭据注入 |
| `CODEBUDDY_AUTH_DIR` / `CODEBUDDY_CREDENTIALS_DIR` / `CODEBUDDY_MODELS_FILE` | 登录域文件目录 / DSH 凭据库目录（内放 `WORKBUDDY_TOKEN:` 等）/ 模型目录注入（旧包即有，多为测试与诊断覆盖；`WORKBUDDY_TOKEN` 本身不是环境变量，是凭据文件里的键） |
| `CODEBUDDY_MCP_CWD` | codebuddy MCP 默认工作目录（仅 MCP 面；preset/dynamic 不读） |
| `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_BASE_URL` / `CODEBUDDY_INTERNET_ENVIRONMENT` | codebuddy 端点与凭据注入 |
| `CODEBUDDY_SETTINGS_FILE` | 旧 codebuddy 设置文件覆盖（迁移读） |
| `CODEBUDDY_MCP_ALLOWED_ROOTS` | codebuddy MCP 的 cwd 白名单 |
| `MIMO_BIN` / `MIMO_CLI` | mimo CLI 覆盖 |
| `MIMO_BRIDGE_BACKEND` / `MIMO_BACKEND` / `MIMO_DESKTOP_MODEL` | mimo 后端/桌面模型 env |
| `MIMO_BRIDGE_SETTINGS` | 旧 mimo 设置文件覆盖（迁移读） |
| `MIMO_MCP_CWD` | mimo 默认工作目录 |
| `DSH_HOME` | dsh-home 定位（设置/MCP 快照文件根） |
| `CLI_BRIDGE_SETTINGS_FILE` | 统一设置文件整体覆盖 |
