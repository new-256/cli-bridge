# Changelog

## [1.2.9] — 2026-09-28

### Fixed（P0 — 状态灯长时间不消失）
- **症状（用户连续三次反馈，先前两轮未修真因）**：关掉 MiMo 预设会话后，标题栏
  状态灯依然常亮不灭；灯的颜色是绿的（`state=ok`），但**没有任何 mimo 任务在跑**。
- **实测证据（本机 live 路由 `GET /mimo-indicator/status`）**：
  ```json
  {"state":"ok","running":0,"presetActive":true,"lastModeAt":<刚刚>,
   "projects":[{"cwd":"...dsh-mimo","stale":<无>,"updatedAt":<49 小时前>}, ...×3]}
  ```
  三条项目记录全部来自 **49 小时前**（`mcp-live.json` 的 `writtenAt` 实测距今 49.1 小时），
  却仍被无条件并入快照。
- **根因（两处，互相叠加）**：
  1. **host 半**（`home-plugin/mimo-indicator/lib/index.mjs`）：`readMcpLive()` 对
     `mcp-live.json` **无条件并入**，既不判整份文件的 `writtenAt` 新旧，也不给
     长时间无更新的项目打任何标记 → 一条几十小时前的历史记录可以永久把灯点亮。
  2. **client 半**（`home-plugin/mimo-indicator/lib/client.js`）：可见性直接用
     **全局租约** `presetActive`：
     ```js
     const show = (data && data.presetActive) || projects.some(...) || (projects.length > 0 && (data.state === "ok" || data.state === "failed"));
     ```
     `presetActive` 是**全局**的——任何一个 mimo preset 会话在线就每 30s 心跳续期
     （TTL 75s），于是**普通会话也被别的会话的租约永久点亮**；且 `projects.length > 0`
     没有任何"短时"约束。
     > 姊妹插件 `agy-first-bridge` / `codebuddy-first-bridge` 早已修过同一问题
     > （per-session preset 判定），**本仓从未移植该修复**。
- **修正**：
  - host 半新增 `MCP_LIVE_TTL_MS`（10 分钟）：`mcp-live.json` 的 `writtenAt` 超期则整份忽略。
  - host 半新增 `PROJECT_TTL_MS`（10 分钟）与 `stale` 标记：非 running 且久未更新的
    项目在快照中带 `stale: true`（**不从表里删除**，详情面板仍可回看轨迹）。
  - client 半移植姊妹仓的 **per-session preset 判定**（双通道：框架标准 props
    `sessionId` + `useSessions`，或旧式 `inject(sessionId)` + `sessions` 服务），
    并以 `RECENT_MS` 过滤掉非活跃项目；空转"就绪"占位灯只在**本会话确实是 mimo
    preset** 时显示。判定不可用（UNKNOWN）时才回退全局租约。
  - `slots.register` 描述符补 `inject()`，把 `injectedSessionId` 与 `sessionsSvc`
    透给组件（对齐 agy-indicator 的同款接线）。

### Added
- `tests/indicator-stale.test.mjs`（**8 项**）：锁死两道独立的闸门——
  「整份 MCP 文件陈旧」与「逐项目 `stale` 标记」，另含 client 模块 id 契约与
  `slots.register` 描述符接线。

### 验证
| 项 | 结果 |
|---|---|
| `scripts/verify.mjs` | ✅ 全过（含版本同步闸门） |
| `tests/core.test.mjs` | ✅ 35 项 |
| `tests/indicator-stale.test.mjs` | ✅ **8 项** |
| `tests/contracts.test.mjs` | ✅ |
| 变异验证（纪律 8） | ✅ 拆「整份文件陈旧」→ 3 项失败；拆「逐项目 stale」→ 2 项失败 |
| 真实数据实证 | ✅ 真实 `mcp-live.json`（49.1 小时前）在新逻辑下被整份忽略 |
| **待重启验证** | ⏳ 家级灯 host 半为 DSH 启动时加载，**重启 DSH Desktop 后生效** |

### Lesson：全局租约不能当成本会话的资格
`presetActive` 表达的是"**某个**会话正在用 mimo preset"，不是"**本**会话是 mimo preset"。
凡是用全局心跳租约去做 per-session 的 UI 判断，都会在多会话场景下串味。
判定本会话身份必须读**本会话自己的** `agentPreset`。

## [1.2.8] — 2026-09-25

### Fixed（P0 — 1.2.7 的修复无效：参数在中间层被白名单丢弃）
- **1.2.7 只补了 `inputSchema` 的 `sessionId` 声明，但参数在中间层就被丢掉了。**
  `handleTool` 用一个**白名单转发 map** 构造 `mapped`：
  ```js
  const mapped = { prompt, mode, model, effort, cwd, timeoutSec, title, backend }
  ```
  该对象**没有 `sessionId`**，而 `runDesktop(mapped, runtime)` 读的是 `mapped`，
  于是即便 schema 声明了、调用方也传了，`args.sessionId` 仍在进入 `runDesktop` 之前被丢弃
  → 永远 `newDesktopSessionId()` 造新 id。
- **实测证据（1.2.7）**：直接对 MCP server 发 `tools/call` 并显式传
  `sessionId=ses_ffe5f26577c16ffecDFuhVIZys`，返回的却是
  `sessionId=ses_5shd9kcyfnrx16e6jh`（自造 id）→ `DESKTOP_SESSION_NOT_CREATED`。
- **修正**：在两处白名单 map 中显式转发 `sessionId`：
  - `mcp/mimo-mcp-server.mjs` 的 `handleTool` → `mapped`
  - `preset/mimo-first/mimo-first-bridge.mjs` 的 `mimo_run.execute` → `mapped`
  并给 preset 的 `mimo_run` 补上 `sessionId` 参数声明（此前只有 `mimo_continue` 有）。
  顺带清理 `mimo_continue` 分支里冗余的 `else if (a.latest) ... else ...` 双写。

### Added
- `scripts/verify.mjs` 新增 3 条护栏（共 73 处 check）：
  - `mcp server forwards sessionId through the mapped whitelist`
  - `preset bridge forwards sessionId through the mapped whitelist`
  - `preset mimo_run declares sessionId in its parameters`

### 验证（对 live MiMo Desktop API，用用户的 dsh-mimo 会话）
| 项 | 值 |
|---|---|
| 目标会话 | `ses_ffe5f26577c16ffecDFuhVIZys`（`dsh-mimo`） |
| 工具返回 | `status=ACCEPTED backend=mimo-desktop sessionId=ses_ffe5f26577c16ffecDFuhVIZys` ✅ 不再造新 id |
| `time.updated` | 1790358478514 → **1790359056551**（推进到当前）✅ |
| 新增会话 | **0**（总会话数不变）✅ |

### Lesson：声明 ≠ 转发
补了 `inputSchema` 只解决了"能不能传进来"，**没有解决"会不会被丢掉"**。
中间任何一层白名单式对象构造（`const mapped = {...}`）都是一个**静默丢弃点**。
**教训：给一个已有管道加新字段时，必须逐层验证该字段真的穿透了每一层，
而不是只给最外层补声明。** 本仓为此新增的护栏直接断言"白名单里包含该字段"，
而不只是"schema 里有"。

### Changed
- 版本号 4 处来源同步至 1.2.8。

## [1.2.7] — 2026-09-25

### Fixed（P0 — desktop 后端无法指定已存在会话）
- **`mimo_run` 的工具 schema 缺少 `sessionId` 参数声明**，而 `runDesktop()` 内部
  一直在读 `args.sessionId`。后果：调用方传 `sessionId` 会被 MCP 层的参数校验**静默丢弃**，
  代码随即走 `newDesktopSessionId()` 生成一个自造 id → 在 1.2.6 之后会被正确判为
  `DESKTOP_SESSION_NOT_CREATED`，但在 1.2.6 之前表现为"报成功但什么都没发生"。
  由于 Desktop API **不能创建会话**，这使得 **`mimo_run` 在 desktop 后端下完全不可用** ——
  没有任何途径能让它命中一个真实会话。
- **修正**：在 `mimo_run` 的 `inputSchema.properties` 中补上 `sessionId`，
  并在描述中写明"必须是 MiMo Desktop 中**已存在**的会话 id"。

### Fixed（文案 — 指引用户使用不存在的参数）
- 1.2.6 引入的 `DESKTOP_SESSION_NOT_CREATED` 错误文案让用户"用 mimo_run 的 sessionId
  参数指定"，但该参数当时**尚未声明**。现两处文案（MCP server / preset bridge）改为
  明确指引：在 Xiaomi MiMo Desktop 应用中新建或选用现有会话，再把其 id 传入。

### Added
- `scripts/verify.mjs` 新增 2 条护栏（共 70 处 check）：
  `mimo_run declares sessionId input` / `mimo_continue declares sessionId input`，
  并校验错误文案不再提"手动新建"这类与实际参数名不符的指引。

### 验证（对 live MiMo Desktop API 实测）
| 场景 | accepted | status | verified | delivered | 结论 |
|---|---|---|---|---|---|
| 自造 id | true | 202 | false | **false** | ✅ 正确报失败 |
| 真实会话 id | true | 202 | true | **true** | ✅ 正确报成功并落地 |

真实会话验证时该会话 `time.updated` 推进到当前时刻，证明 turn 确实落地。

### Changed
- 版本号 4 处来源同步至 1.2.7。

## [1.2.6] — 2026-09-25

### Fixed（P0 — Desktop 派发是静默空操作）
- **MiMo Desktop 派发从未真正执行，却被报告为成功。** 实测：Desktop 本地 API
  `POST /v1/sessions/<id>/turns` 对**任意** session id 都无条件返回
  `202 {"ok":true}` —— 它**不校验目标会话是否存在**。
  - 向**自造 id** POST：得到 202，但 `GET /v1/sessions` 计数不变（19→19），
    会话从未创建、任务从未执行。
  - 向**真实存在**的 id POST：202，且该会话 `time.updated` 确实推进
    （1790191780961 → 1790357493749）。
  桥接层原先把 202 当作 `accepted` 并直接报 `ACCEPTED`，于是
  `mimo_run` 回话"成功"、状态灯变绿，而 **Desktop 应用里根本没有这个会话**。
- **修正**：`desktopSendTurn` 在收到 2xx 后**回读会话列表确认目标 id 存在**，
  返回 `verified` 与 `delivered`；两个消费方（MCP server / preset bridge）
  一律以 `turn.delivered` 为准，未确认投递时报
  `status=DESKTOP_SESSION_NOT_CREATED` 并给出可操作提示。

### Added
- `tests/desktop-delivery.test.mjs`（**4 项**，已接入 `npm test`）：用受控 fake fetch
  覆盖"真实会话 / 自造 id / 列表不可用 / API 拒绝"四种路径。
- `scripts/verify.mjs` 新增 **7 条**投递契约护栏（共 67 条）。
- `package.json` 新增 `exports["./runtime-settings"]`（供测试直接 import）。

### 变异验证（DEV-DISCIPLINE 规则 8）
- 测试：把 `delivered` 改回 `accepted` → 必 FAIL
  （`delivered MUST be false, otherwise we report ACCEPTED for a no-op`）✅
- 护栏：4 种回退变体（信任 202 / 去掉列表回读 / 两消费方各自退回 `accepted||ok`）
  全部被捕获 ✅

### Lesson
- **"接口返回成功"≠"事情发生了"。** 对外部 API 的成功码，必须用**可观测的副作用**
  （此处：目标 id 是否出现在会话列表中）来确认，而不是相信状态码。
- 这条与 v1.2.5 的"禁止静默吞错"同源：那次是错误被吞，这次是**成功被伪造**，
  两者都让状态灯说了谎。

### Changed
- 版本号 4 处来源同步至 1.2.6。

## [1.2.5] — 2026-09-24

### Fixed（P0 — 状态灯永远不绿）
- **顶层 `fallbackActive` 聚合用了 OR 语义**（`if (p.fallbackActive) fallbackActive = true`），
  即只要**任意一个**历史项目曾回退过，整盏灯就被永久涂成琥珀。实测症状：当前项目刚刚
  `ACCEPTED` 成功，`/mimo-indicator/status` 仍返回 `state=fallback, fallbackActive=true`，
  用户永远看不到绿色。三处形态同病：
  `core/mimo-core.mjs`（globalState）、`home-plugin/mimo-indicator/lib/index.mjs`（snapshot）、
  `dynamic/host.js`（globalState）。
  修正：顶层状态只认同**唯一一个「最近活动」项目**，并让 `lastStatus`/`lastAt`/
  `lastSessionId`/`fallbackActive` 全部由该项目派生，保证聚合自洽。
- **「最近」缺少确定序**：墙钟毫秒在同一毫秒内可写入两个项目（实测两项目 `lastAt` 与
  `updatedAt` 完全相同），导致排序退化为 cwd 字符串比较、结果随机。新增单调递增
  `seq` 计数器（三形态各自维护），排序键依次为 `seq` → `updatedAt` → `cwd`。

### Added
- `tests/core.test.mjs` 新增 2 项回归测试（共 35 项）：
  - 陈旧回退项目不得把顶层状态拖成 fallback（`state` 必须为 `ok`）
  - 最近项目确实回退时，顶层仍须如实报告 `fallback`
- `scripts/verify.mjs` 新增 12 条护栏（共 60 条），覆盖三形态的聚合契约。

### Lesson（DEV-DISCIPLINE 规则 8 的第二次实战 —— 假护栏）
- 本护栏**第一版是假护栏**：只匹配 `= list.some(`，被 `if (list.some(...)) x = true`
  绕过。变异测试当场抓出 4 个漏网点；改用「统计赋值点个数」后，又因
  (a) 正则只锚行首、(b) RHS `[^\n;]+` 吃穿行尾导致同行双赋值被吞、
  (c) 声明排除正则 `[^\n]*?` 跨语句把 `for (const q ...)` 误判为声明
  —— 又连续漏掉 3 个变体。最终以「LHS 出现次数 + 单语句边界」实现，
  通过 **12 种 OR 写法变体**的变异矩阵全部捕获。
- 教训：**护栏的自然语言目标（"不得用 OR"）不能靠枚举正则实现**，必须转成可判定的
  结构性命题（"赋值点恰好一个，且来源为 top"），并对该命题做多写法变异验证。

### Changed
- 版本号 4 处来源同步至 1.2.5。

## [1.2.4] — 2026-09-24

### Fixed（P0 — 状态灯完全不显示）
- **client.js 的 `slots.register` 调用签名错误 + 缺少 Cordis 服务级依赖声明**，导致状态灯
  从未成功注册、界面上完全不出现。三重故障：
  1. 单参调用 `slots.register({ id, position, component })`：框架真实签名为
     `register(options, component)`（`dsh-client-ui-slots/lib/index.js`），`options` 必带
     `name` 字段且**不存在 `position` 字段**；组件必须是第 2 个实参。原写法
     `options.name` 为 undefined，框架首行即抛 `slot "undefined" is not declared ...`。
  2. 缺少插槽生命周期等待：目标插槽 `conversation.session.header.utilities` 由
     `ConversationSessionHeader` 挂载时才 declare，必须用 `slots.inject(slot, cb)` 等它
     声明成立后再注册；直接 register 同样抛 "is not declared"。
  3. 顶层导出缺少 `exports.inject = ["slots"]`：Cordis loader 经 `unwrapExports` 取
     `exports.default`，无 `inject` 声明则 fiber 立即激活，可能在 `slots` 服务 provide
     之前就执行 apply。
  致命放大因素：原代码外层 `try { register() } catch (e) {}` 把上述必崩错误**完全吞掉**，
  控制台无任何报错，外部表现仅为"灯就是不出现"，极难定位。
- **发布流程缺少该契约的护栏**：`scripts/verify.mjs` 此前只校验 client 模块 id === 主包名，
  未校验 slots 注册契约，故该缺陷一路通过 45 条护栏被发布出去。新增 5 条护栏（见 Added）。

### Added
- `scripts/verify.mjs` 新增 5 条 slots 注册契约护栏（均已做变异验证，还原修复必 FAIL）：
  - 禁止单参 `slots.register({ id: ... })` 写法
  - 插槽名必须经 `options.name` 传递，禁止 `options.position`
  - 模块导出必须声明 `exports.inject = ["slots"]`
  - `exports.default` 必须携带 `inject: ["slots"]`
  - 注册前必须先 `slots.inject("conversation.session.header.utilities", ...)`

### Changed
- 版本号 4 处来源同步至 1.2.4（package.json / 内层包 / mcp VERSION / CHANGELOG）。
- 1.2.3 发布后曾对已安装副本手工热修 client.js；1.2.4 为**经 registry 安装的正规制品**，
  消除"已安装 != 已发布"的漂移（DEV-DISCIPLINE 规则 5）。

### Lesson（DEV-DISCIPLINE 规则 4 与 8 的新实例）
- **静默吞错的 try/catch 会掩盖必崩缺陷**：`catch (e) {}` 让"注册彻底失败"伪装成
  "没有内容可渲染"。凡注册类调用，要么不吞、要么在 catch 中上报可见状态。
- **护栏覆盖不到的地方就会出事故**：本次缺陷落在"与外部框架的 API 契约"这一零护栏空白区。
  护栏必须覆盖**对外交互契约**，而不只是自身内部一致性。

## [1.2.3] — 2026-09-24

> 本轮由 agy 做只读代码审计（独立复核），确认 7 项真问题后修复；每项均以「改前先证伪」方式核对，
> 修复后用变异测试（mutation test）逐条验证回归测试真的能拦住旧缺陷。

### Fixed
- **[P0] MCP 二次 `engine.end`**：`runMimo` / `runDesktop` 内部**所有**退出路径都已 `engine.end`，但 `handleTool` 在受限分支又调了一次 → `running` 多减（被 `Math.max(0,…)` 掩盖成计数错乱）、`runs` 虚标翻倍。删除该冗余调用。
- **[P0] 淘汰逻辑会删掉正在 running 的项目**：`keys.length >= MAX_PROJECTS` 且**全部 running** 时，`pool` 回退为全体 → 把最旧的**运行中**项目 `delete`，状态断层/内存泄露。改为仅在存在 idle 项目时淘汰；全 running 时宁可暂时超限。core / 家级灯 host 半 / dynamic 三处同步。
- **[P1] `mergeExternal` 盲信外部派生 `state`**：core 仍是 `if (src.state) p.state = src.state`，与家级灯 host 半的「本地重算」策略漂移 → preset 形态经外部快照会把 ACCEPTED 重新画成红色 ✗。改为与 host 半同策略（外部 `state` 仅在 `running` 时作运行中提示）。
- **[P1] `end()` 并发下算错 state 并误清 fallback**：同项目并发时（`running` 2→1），fallback 分支会把 state 设成 `fallback`（仍有任务在跑，应为 `running`）；成功分支无条件 `fallbackActive = false`，清掉另一个在飞任务的 fallback 标记。改为 `running > 0` 时 state 强制 `running`，且仅在 `running === 0` 时允许清 `fallbackActive`。core + dynamic 同步。
- **[P2] `mergeExternal` 接受更旧的外部快照**：守卫 `srcAt < p.updatedAt && p.running > 0` 只在本地 running 时生效，空闲时旧快照会覆盖较新的本地状态。改为有明确时间戳且更旧即丢弃。
- **[P2] preset 重试会连问两次**：`while (… && attempt < 2)` 循环体最多跑一次，用户选 retry 后退出循环，紧接着的 `if (… && attempt >= 2)` **又弹一次窗**，且第二次选 retry 被静默忽略。改为显式 `for (attempt = 1..2)`：每次受限都询问、retry 则重试、循环耗尽时明确标注「已达重试上限」而非静默失败。

### Added
- **dynamic 形态补 `mimo_settings`**：此前只有 3 个工具（run/continue/status），与 preset/MCP 的 4 个不一致。沙箱无 fs，故如实返回 `settingsPath: null`、`desktopAvailable: false` 并说明「dynamic 不持久化设置」，不伪造 fs 能力。

### Changed
- `scripts/verify.mjs`：40 → **45** 条护栏，新增针对上列各项的契约锁（含「MCP 禁止二次 end」「三处均不得淘汰 running」「并发状态守护」「dynamic 注册四工具」）。
- `tests/core.test.mjs`：27 → **33** 项，新增全 running 不淘汰、idle 仍淘汰、`mergeExternal` 重算 state、并发守护、旧快照丢弃、`clearFallback`。

## [1.2.2] — 2026-09-24

### Fixed
- **家级灯盲信外部快照的派生 `state`**：`mergeSnapshot` 原样接受 MCP 子进程写来的 `state` 字段，而该字段是可由 `lastStatus`/`running`/`fallbackActive` 重算的派生值。一旦写入方留下的 `state` 与 `lastStatus` 不一致（实测：`lastStatus=ACCEPTED` 却 `state=failed`），灯就会画成错误颜色。改为：外部快照的 `state` 仅在等于 `running` 时作为运行中提示被接受，其余一律本地重算。
- 回归护栏：`scripts/verify.mjs` 新增 1 条（host 半必须重算派生 state，且不得再出现 `if (src.state) p.state = src.state`）。

## [1.2.1] — 2026-09-24

### Fixed
- **状态灯把成功的桌面派发画成红色 ✗**：`mimo-desktop` 异步受理后回报 `ACCEPTED`（HTTP 202，此时尚无回复文本），而状态机只把 `SUCCESS` 当成功 → 健康派发被渲染成 `failed`。新增 `SUCCESS_STATUSES = ['SUCCESS','ACCEPTED']` 与 `isSuccessStatus()`，core / 家级灯 host 半 / dynamic host 三处同步（均为自包含副本，不跨文件 import）。
- 回归护栏：`scripts/verify.mjs` 新增 4 条（三处副本都必须认 ACCEPTED + 禁止再出现 `lastStatus === 'SUCCESS'` 单值比较）；`tests/core.test.mjs` 新增 2 项（`isSuccessStatus` 分类、ACCEPTED 派发后快照为 `ok`）。

## [1.2.0] — 2026-09-24

### Fixed
- MCP→家级状态灯 live 文件路径：制品安装布局下原先写到 <profile>/node_modules/plugins/…，家级灯读 <DSH_HOME>/plugins/mimo-indicator/mcp-live.json，导致「MCP 写盘正常、灯恒 idle」。改为按 DSH_HOME → APPDATA/DSH Desktop/dsh-home → HOME/.dsh 分层锚定，MIMO_MCP_LIVE_FILE 显式覆盖仍最优先，包内相对路径仅作自定义布局末位兜底。
- mimo_settings 输出渲染：原误用 mimo_status 的渲染器，显示 state=undefined；新增独立 renderSettings。
- dynamic/host.js 硬编码开发机路径（MIMO_BIN / CWD_FALLBACK）改为沙箱安全探测链（MIMO_BIN → MIMO_CLI → USERPROFILE/.mimocode/bin/mimo.exe → HOME/... → 'mimo' 交 PATH），字面量仅作部署期兜底。

### Changed
- dynamic 形态补齐 `backend` 参数；mimo-desktop 在动态沙箱不可用（无 fs/import），显式返回 DESKTOP_UNSUPPORTED 并给出改用 preset/MCP 形态的指引，不再静默失败。
- preset 两处子代理 persona 文案由 agy 残留改为 MiMo-first。
- package.json 补 repository/homepage/bugs。

## [1.1.0] — 2026-09-24

### Added
- **backend 设置预选**：用户可提前选择派发目标 —— `mimocode`（本机 `mimo` CLI / MiMoCode）或 `mimo-desktop`（Xiaomi MiMo 桌面客户端本地 API）。
- 预选优先级：工具参数 `backend` > 插件 `config.backend` > 环境变量 `MIMO_BRIDGE_BACKEND` / `MIMO_BACKEND` > settings 文件 > 默认 `mimocode`。
- **settings 文件**（设置面）：`%APPDATA%/mimo-first-bridge/settings.json`（或 `MIMO_BRIDGE_SETTINGS`），示例见 `settings.example.json`。
- 新工具 **`mimo_settings`**：读/写默认 backend 与 desktopModel，返回当前生效配置与 Desktop API 可用性。
- **mimo-desktop 派发**：经 Xiaomi MiMo Desktop 本地 API（`%APPDATA%/Xiaomi MiMo/desktop-api.json` 的 `port`+`token`，`Authorization: Bearer`）：
  - `GET /v1/health` 健康检查
  - `POST /v1/sessions/:id/turns` 投递 `{message, model, directory}`（202 accepted）
  - `GET /v1/sessions/:id/events` 读取回复
  - `GET /v1/sessions?limit=` 列会话
- 工具参数 `backend`（`mimo_run` / `mimo_continue`，三形态齐备）可单次覆盖预选。
- 结果对象带 `backend` 字段；`mimo_status` 返回 `defaultBackend`。

### Notes
- Desktop 桌面端需在运行中；未启动时 `mimo-desktop` 返回 `DESKTOP_UNAVAILABLE`（可改回 `mimocode`）。
- 插件 `config.backend` 示例（cordis / agent.cordis.yml 行）：
  ```yaml
  - id: mimo-first-bridge
    name: './mimo-first-bridge.mjs'
    config:
      backend: mimo-desktop   # 或 mimocode
  ```

## [1.0.0] — 2026-09-18

### Added
- 首个正式版本：`mimo-first-bridge` 连接 **Xiaomi MiMo Desktop / MiMoCode** 与 **DSH**。
- 三个模型工具：`mimo_run` / `mimo_continue` / `mimo_status`，把任务转交给本机 `mimo` CLI（`--dangerously-skip-permissions` + `--format json`，DSH 完全控制、mimo 无提示）。
- MiMo-First 优先策略提示段（`mimo:policy`）：实现/编辑/调试/构建/跨文件排查优先派给 mimo；原生工具只做只读查询与最终验证。
- 限流/网络/认证失败回退弹窗（`userQuestions.ask`）：回退 DSH 本地 API / 重试 / 返回错误。
- 家级实时状态灯 `mimo-indicator`（随软件启动、所有会话可见、无需审批）。
- 动态 Cordis 插件形态（`dynamic/host.js` + `client.js` 空骨架，仅支持 `mimocode` 命令行后端，状态推入家级收集器）。
- 零依赖 MCP server（`mcp/mimo-mcp-server.mjs`）：任何 MCP 宿主通过 `tools/list` 自动发现三个工具。
- 共享核心 `core/mimo-core.mjs`（纯函数 + 状态引擎 + NDJSON 半行安全解析 + 执行编排）。
- 发布闸门 `scripts/verify.mjs`：锁 client 模块 id === 主包名、版本三处同步、分发结构、工作流双行、工具名契约。
- 测试：`tests/core.test.mjs`（解析/argv/限流/状态引擎）、`tests/contracts.test.mjs`（DSH 契约）、`tests/mcp-smoke.test.mjs`（MCP 握手）。

### CLI mapping (mimo)
| 工具参数 | mimo CLI |
| --- | --- |
| prompt | `mimo run <prompt>` |
| — | `--format json --dangerously-skip-permissions` |
| mode plan/build/compose | `--agent plan\|build\|compose` |
| model | `--model provider/model` |
| effort low/high | `--variant minimal\|high` |
| cwd | `--dir` |
| sessionId / latest | `--session <id>` / `--continue` |
| timeoutSec | 宿主硬超时（mimo 无 --print-timeout） |

### Notes
- 本机开发时 `mimo` 免费 API 可能已结束（错误事件可被 `isLimited` 识别并触发回退弹窗）。
- client 模块 id 永远 === 主包名 `mimo-first-bridge`（dsh-client-modules arrive() 契约）。
