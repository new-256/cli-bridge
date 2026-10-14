# Changelog — @luchenglong/cli-bridge

本项目遵循 [语义化版本](https://semver.org/)；版本号同步 `package.json`、Git tag 与
GitHub Release（`scripts/verify.mjs` 在 CI 与 prepack 双重锁一致）。

> **三个旧桥接包（`agy-first-bridge` / `codebuddy-first-bridge` / `mimo-first-bridge`）
> 的全部历史已逐字并入各自 lineage 文档，本文件只记统一包自身的变更：**
> - AGY 线：[docs/history/agy/CHANGELOG.md](docs/history/agy/CHANGELOG.md)（终版 1.7.1）
> - CodeBuddy 线：[docs/history/codebuddy/CHANGELOG.md](docs/history/codebuddy/CHANGELOG.md)（终版 1.6.2）
> - MiMo 线：[docs/history/mimo/CHANGELOG.md](docs/history/mimo/CHANGELOG.md)（终版 1.2.9）

## [0.2.2] - 2026-10-10

### Changed
- **设置面板改横向标签页**（替代 0.2.1 的纵向网格堆叠 —— 页面长度随 provider 数增长的
  问题）：一排名字点击切换，同屏只渲染一张卡；「总设置」= 调度卡，其余 = 各 CLI 偏好卡
  （卡头 chip 保留）。tab 上带 启用绿点/灰点 + 优先级 `#n`，顺序跟随优先级；
  `flex-wrap` 使第 4、5 个 CLI 只是多一个 tab，布局零改动。
- **id 轴后端驱动**：`providerMetas()` 以视图 `scheduling.all` ∪ `providers` 键为权威轴，
  本地 `PROVIDERS` 表降级为 fallback（只补 presetId/label 展示）——新 provider 接入时
  灯 pill、弹窗分区、标签页、调度卡、保存循环全部自动出现，client.js 零改动。
### Fixed
- React hook 顺序红线：tab 状态声明置于 `if (!view)` 早期 return 之前（否则 view 加载
  瞬间 hook 数量变化 → 面板崩溃），`client-ui-surface` 静态锁。
- **首发 npm 的 scoped 包可见性**：`package.json` 补 `publishConfig.access = "public"`。
  此前只有 RELEASE-SOP 要求命令行 `npm publish --access public`；走 GUI/插件通道发布时不带该
  参数，npm 按私有包处理 → `E402 Payment Required`。写入 package.json 后任何发布通道都正确。

### 发布（2026-10-14）
- **首发 npm**：`@luchenglong/cli-bridge@0.2.2`（统一包首次发布；registry 上 `latest=0.2.2`，
  shasum `362d506e`，58 files / 320.1 kB）。npm 首次创建 scoped 包返回 `PUT 202 Accepted`
  （"may take a few minutes to become available"）—— 属正常，勿重复发布。
- **旧包已 deprecated**（三条均已在 registry 生效，显示迁移提示）：`agy-first-bridge`（终版 1.7.1）、
  `codebuddy-first-bridge`（终版 1.6.2）、`mimo-first-bridge`（终版 1.2.9）。

## [0.2.1] - 2026-10-10

### Fixed
- **指示灯长期存在**：超过 `PROJECT_TTL_MS`（10 分钟）无活动的项目（`stale:true`）不再
  渲染为常亮 pill（弹窗历史列表保留）；服务端半边 —— 顶层聚合 `state/lastStatus/
  fallbackActive` 只认新鲜项目，全陈旧时回落 `idle`（此前一次失败的 ✗AGY 会永久挂灯，
  `indicator-state` 新增 3 条红线锁）。
### Changed
- **设置面板卡片模式**：「总设置」区（调度卡：启用数量 + 优先级）与每个 CLI 独立成卡、
  响应式网格排布；CLI 卡头带 启用/未启用 与优先级 `#n` chip（与调度视图同源派生，两处
  永远一致），未启用卡半透明并明确提示「三形态不注册工具、偏好仍保存」。
- **单一 id 轴贯通 `scripts/build.mjs` 与 `preset-declarations`**（改从 `providers/registry.mjs`
  派生 `PROVIDER_IDS`）：新增 provider 只改 registry，调度卡/构建派生物自动跟上
  （PROVIDER-CONTRACT.md §3.1）。版本锁三处 + provider `mcp.version` 同步 0.2.1。

## [0.2.0] - 2026-10-10


新增「CLI 调度」：让用户选择由智能体调用 CLI 时**启用哪些 CLI（数量）**以及**调用优先级**。

### Added
- **调度单源 `core/scheduling.mjs`**（纯逻辑、无 import，可同时被宿主 ESM 与动态沙箱文本内联消费）：
  `normalizeScheduling` / `resolveScheduling` / `isBridgeEnabled`（门禁 helper）/ `defaultPriority` /
  `describeScheduling`。语义：`enabled` = 勾选启用集合（未启用一面不注册任何工具/政策段/心跳），
  `priority` = 数组顺序即调用建议顺序（首位最高）；文件缺失/坏值/无 fs → 全部启用 + 注册表顺序
  （**fail-open**：读不到配置永远不等于关掉所有桥）。
- **落盘**：统一设置文件新增顶层 `_scheduling` 区（下划线前缀 = 非 provider 区，旧代码逐分区读取
  整区忽略 → 纯增量向后兼容）。`normalizeAll` / `settingsView` / `parseSettingsBody` 三区同步：
  GET 返回 `scheduling:{enabled,priority,order,all,labels}`；POST 整区替换、类型严格（非对象 /
  未知 id → 400）、**缺省 = 保持现值**（provider-only 提交绝不悄悄重置调度）。
- **四形态贯穿**：① 6 个桥接宿主（3 preset + 3 dynamic 模板）`apply()` 首行门禁 —— 禁用面零注册；
  ② 声明制 preset 注册顺序按 priority 排（三个 preset 恒常注册：禁用 ≠ 从目录消失，用户仍可切入排查）；
  ③ MCP `selectedProviders()` 无钉住时按 `enabled` 过滤、按 `order` 排序（子进程启动读一次，重启刷新）；
     本机实际注册的是 `dsh-home\bin\` 下三个自包含旧服务器（不依赖本包），故另附最小只读副本
     `bin\cli-bridge-scheduling.mjs`（物料源 `deploy/legacy-mcp/`），三服务器 `tools/list`/`tools/call`
     现读过滤 —— 面板关掉某面后 MCP 子进程重启即空工具面；语义单源仍是 `core/scheduling.mjs`。
  ④ `GET /cli-bridge/status` 每次轮询现读并附 `scheduling` 快照（灯侧即时可见）。
  env `CLI_BRIDGE_PROVIDER`（薄封装钉住单面）优先级最高；宿主形态传 `ignorePin` 不受全局 env 反噬。
- **构建**：`scripts/build.mjs` 新增 `/*__SCHED__*/` 占位，内联 `core/scheduling.mjs` + 注入
  `SCHED_ALL_IDS` 常量（沙箱禁 import，拿不到 registry）；旧模板无该占位则不注入（向后兼容）。
- **UI**：设置面板顶部「调度 · 启用与优先级」卡 —— 每 CLI 一行（勾选 + 序号徽标 + ↑↓）；
  provider 卡片顺序跟随优先级，禁用面仍渲染（不改开关也能修好它的 token/预选）；全禁用时红字警告。
  过渡窗口护栏：新 client.js 先于宿主热加载时（旧宿主视图无 `scheduling`），卡片自动禁用交互、
  POST 跳过 `_scheduling`、保存后红字提示「重启 DSH 后重新保存」，绝不假成功。
- `mcp/cli-bridge-mcp.mjs --check` 报告新增 `scheduling:{source,enabled,order}`，部署后一眼确认生效面。

### Notes
- 提示词连续性红线不受影响：政策段全文仍逐字来自 provider，门禁只做「注册 / 不注册」；
  优先级以**注册与装配顺序**表达（preset 目录序 / MCP tools/list 序 / 提示段落序），不新增文案。
- 生效时机：preset / 动态形态下次会话装配即读；MCP 子进程需重启才刷新工具面（面板保存提示已说明）。

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

### Known limitations（0.1.0，有意省略）
- codebuddy 设置面板的**促销角标**未随迁（旧 v1.6.1 的 `modelPromotions` 面板装饰）；
  模型目录保留「倍率 + 授权」两标与账号实时清单，选模型行为不受影响。
- 除此之外，三家全部工具语义、状态机、回退弹窗、额度面板（AGY quota）、旧路由/
  旧设置文件/旧 MCP 快照路径兼容均按逐字兼容移植，无已知功能缺口。

### Compatibility
- DSH：`>=0.1.1-rc.2 <0.3.0-0`（本机 0.2.1-alpha.1 验证）；无 dsh peer 依赖，
  兼容闸门天然通过。
- Node ≥ 18（MCP/dynamic/preset 全形态）；零运行时依赖。
- 红线 4：升级包名必须同步改 `client.js` 注册 id（verify + 测试双保险）。
