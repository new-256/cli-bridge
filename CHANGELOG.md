# Changelog — @luchenglong/cli-bridge

本项目遵循 [语义化版本](https://semver.org/)；版本号同步 `package.json`、Git tag 与
GitHub Release（`scripts/verify.mjs` 在 CI 与 prepack 双重锁一致）。

> **三个旧桥接包（`agy-first-bridge` / `codebuddy-first-bridge` / `mimo-first-bridge`）
> 的全部历史已逐字并入各自 lineage 文档，本文件只记统一包自身的变更：**
> - AGY 线：[docs/history/agy/CHANGELOG.md](docs/history/agy/CHANGELOG.md)（终版 1.7.1）
> - CodeBuddy 线：[docs/history/codebuddy/CHANGELOG.md](docs/history/codebuddy/CHANGELOG.md)（终版 1.6.2）
> - MiMo 线：[docs/history/mimo/CHANGELOG.md](docs/history/mimo/CHANGELOG.md)（终版 1.2.9）

## [0.1.0] - 2026-10-10

首个统一版本：`agy-first-bridge`、`codebuddy-first-bridge`、`Xiaomi MiMo-bridge`
三个插件整合为一个包、一个指示灯、一个 MCP server、一个设置面板。

### Added
- **统一内核 `core/bridge-kit.mjs`**：状态引擎（项目分桶 / 会话租约 / 累计 runs+tokens）、
  行流解析、NDJSON 半行安全、限流判定（`isLimited` 可被 provider 收窄覆盖）、回退三选一
  编排（`createRunner`：preflight → resolveExe → buildArgv → 瞬时错误静默重试一次 →
  限流弹窗 → fallback/retry/cancel）、MCP 快照载荷（`buildMcpBridgePayload`/
  `normalizeMcpBridge`，文件 `{DSH_HOME}/cli-bridge-mcp-<id>.json`，90s stale）。
- **Provider 注册表 `providers/registry.mjs` + 冻结契约 `PROVIDER-CONTRACT.md`**：
  agy / codebuddy / mimo 各以一个描述符（buildArgv / parseJson / buildResult /
  foldStreamEvent / resolveBackend / settings / tools / execute / attach …）接入，
  三形态（preset / dynamic 沙箱 / MCP stdio）共享同一 provider 模块，零重复逻辑。
- **单一状态灯（家级插件 `home-plugin/cli-bridge-indicator/`）**：一个 pill 聚合三家
  （AGY · CB · MIMO 分区弹出面板），每项目实时步骤折叠、悬停当前步骤、点击展开活动面板；
  preset 租约（75s TTL/30s 心跳）+ 宿主枚举（agents.list × composedPreset）双通道判定
  「本会话是否运行在桥接预设下」；旧路由 `/agy-indicator/status`、
  `/codebuddy-indicator/status`、`/mimo-indicator/status` 保持兼容别名。
- **统一设置面板**：`GET/POST /cli-bridge/settings` + 浏览器内三卡片表单（meta 驱动，
  provider 各自声明 fields/secretKeys）；单一文件 `{DSH_HOME}/cli-bridge-settings.json`
  按 provider 分区；token 永不明文回传（掩码 set+尾4位）；POST 空=保持、
  `<key>Clear:true`=清除；**旧包设置文件一次性字段级迁移**：codebuddy 扁平
  `codebuddy-bridge-settings.json` 与 mimo `{APPDATA}/mimo-first-bridge/settings.json`
  （backend→preferredBackend、desktopModel）在统一键未写过时自动回退，写过即失效，
  永不写旧文件。
- **单一 MCP server `mcp/cli-bridge-mcp.mjs`**（bin `cli-bridge-mcp`）：一次接入暴露
  全部 provider 工具（agy_run/continue/status/quota、codebuddy_run/continue/status、
  mimo_run/continue/status/settings）；`--provider=<id>` 过滤单面；
  `mcp/<id>-mcp-server.mjs`（bin 同名兼容入口）= 带 `--provider=<id>` 的薄封装，
  旧包 MCP 配置只需换路径。
- **preset 声明制交付（Form-A 自注册）**：`preset-declarations.mjs` 在 indicator 内
  `ctx.inject(['agentPresets'])` 直接 `register(definition)`，任何 DSH 版本可用；
  bundle patch 只含一行 indicator；桥接插件行走裸子路径
  `@luchenglong/cli-bridge/preset-<id>`（历史事故教训：相对路径在 preset baseUrl
  下误解析）。preset id 保持旧值不可变：`cordis-agy` / `codebuddy-first` / `cordis-mimo`。
- **构建单一源 `scripts/build.mjs`**：`preset/<dir>/plugin-list.mjs` 一份源同时生成
  legacy `agent.cordis.yml` + `preset.yml` 与运行时声明；`dynamic/<id>.host.js` 由
  模板（双占位符 KIT+PROVIDER）内联生成（`stripModuleSyntax`，遇到不支持的模块形态
  大声失败）；`--check` 漂移即 CI 红；`--only=<id>` 支持并行开发。
- **发布红线闸门 `scripts/verify.mjs`**（prepack + CI，9 项）：client 注册 id ≡ 包名
  （历史事故 agy 1.6.1 / codebuddy 1.1.8：不一致 = 客户端组合加载失败 = 启动致命屏）、
  bundle 行名、exports 目标存在性、preset 桥接说明符、描述符完整度、
  `dsh.client.platform=web`、plugin-list 单源存在性、版本双锁
  （`package.json` ≡ MCP `SERVER_VERSION` ≡ CHANGELOG 顶部条目）、
  凭据泄漏扫描（fixtures 文件名形态 + 源码内 ≥24 位随机凭据字面量，`fake-*` 白名单）。
- **CI（`.github/workflows/ci.yml`）**：node 18/20/22 矩阵跑 build → verify → build
  --check → dynamic 宿主 `node --check` → `node --test` → 统一与分 provider MCP
  `--check`。
- **AGY 额度面板保留**：`GET /agy-indicator/quota`（5 分钟缓存）→ `bin/agy-quota.mjs`
  （脚本定位 = env `CLI_BRIDGE_AGY_QUOTA` > 包内 bin，绝无硬编码用户路径）。

### Changed（相对三个旧包）
- 三包合一：一个 npm 包名（`@luchenglong/cli-bridge`）、一个 git 仓库、一套文档；
  旧包 `deprecated` 后不再维护。
- 状态灯从三盏 pill 变一盏聚合 pill（悬停/点击面板内按 provider 分区），旧「各自一盏」
  的视觉由分区色标代替；每个项目的活动细节、runs/tokens 统计语义不变。
- 设置从三个面板/文件统一为一个分区式面板；字段与语义逐字段映射（见上迁移条目）。
- MCP 从三个 server 变一个（工具名、入参、返回文本语义逐字不变）。

### Compatibility
- DSH：`>=0.1.1-rc.2 <0.3.0-0`（本机 0.2.1-alpha.1 验证）；无 dsh peer 依赖，
  兼容闸门天然通过。
- Node ≥ 18（MCP/dynamic/preset 全形态）；零运行时依赖。
- 红线 4：升级包名必须同步改 `client.js` 注册 id（verify + 测试双保险）。
