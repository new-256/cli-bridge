# PROVIDER-CONTRACT — CLI Bridge 提供方（Provider）接入契约 v0.1.0（冻结）

> 单一事实来源：`core/bridge-kit.mjs`（通用骨架）。每个 CLI 提供方（agy /
> codebuddy / mimo）只写一个**描述符模块** + 各形态的薄适配层。
> **禁止**修改 `core/`、`home-plugin/`、`mcp/cli-bridge-mcp.mjs`、`scripts/`、
> `providers/registry.mjs`、根 `package.json` —— 这些是 keystone，由 Lead 单作者维护。
> 你的写权限范围见每个 provider 任务卡的 write_scopes。

## 0. 命名与硬约束（红线）

- provider id（全小写，用于事件通道/设置分区/文件名/工具名）：
  `agy` | `codebuddy` | `mimo` | `opencode` | `claude` | `codex`。
  **唯一 id 轴 = `providers/registry.mjs` 的 `PROVIDER_IDS`**；preset 目录映射的
  **唯一来源**是同文件的 `PRESET_DIRS`（`build.mjs` / `preset-declarations.mjs` /
  `verify.mjs` 都从它导入，**禁止**再各写一份——漏改会静默不产物或报误导性错误）。
- preset id：`cordis-agy` | `codebuddy-first` | `cordis-mimo`（三家旧包，**保持旧值不变**，
  旧会话头引用）；`opencode-first` | `claude-first` | `codex-first`（本包新增，直接用
  `<id>-first`）。注意 preset **目录名**与 presetId 不一定相同（agy/mimo 是旧包历史遗留）。
- 工具名（旧包语义逐字保持）：`agy_run/agy_continue/agy_status(/agy_quota)`、
  `codebuddy_run/codebuddy_continue/codebuddy_status(/codebuddy_models)`、
  `mimo_run/mimo_continue/mimo_status(/mimo_settings)`、`opencode_run/…(/opencode_models)`、
  `claude_run/…(/claude_models)`、`codex_run/…(/codex_models)`。
- 客户端契约（红线 4）：浏览器半注册 id **必须**等于包名 `@luchenglong/cli-bridge`；
  该文件是 keystone（`home-plugin/cli-bridge-indicator/lib/client.js`），provider 作者**不碰**。
- 动态沙箱形态禁止 `import/require`；派生文件一律由 `node scripts/build.mjs` 生成，
  生成物不要手改（`npm test` 的 build-sync 会锁）。

## 1. 描述符模块（每个 provider 一个文件）

文件：`providers/<id>.mjs`。ESM，**零外部依赖**：只允许
`import ... from '../core/bridge-kit.mjs'`（动态构建时该 import 行会被剥离并内联骨架）。
默认导出工厂：

```js
export default function defineProvider(deps = {}) { return descriptor }
```

`deps` 由宿主形态注入（preset 形态：`{ process, env }`；dynamic 形态：`{ env }`（沙箱，
只有 typeof 守卫可读到的 env 对象）；MCP 形态：`{ nodeFs, nodeChild, nodePath, env }`）。
描述符字段（★=必填）：

| 字段 | 类型 | 说明 |
|---|---|---|
| ★ `id` | string | 'agy'/'codebuddy'/'mimo' |
| ★ `label` | string | UI 短标签：'AGY'/'CB'/'MIMO' |
| ★ `presetId` | string | 上表 preset id |
| ★ `defaultBackend` | string\|null | 如 'codebuddy'/'mimocode'；agy 无多后端给 null |
| `defaultMode` | string | 默认 'auto' |
| `exeName` | string | PATH 兜底可执行名（'agy'/'codebuddy'/'mimo'） |
| `binEnvVars` | string[] | 探测用的环境变量名（['AGY_BIN'] 等） |
| ★ `backends(env)` | fn | 合法后端名数组或 null（单后端） |
| ★ `normalizeBackend(v)` | fn | 别名归一（非法输入返回 null） |
| ★ `resolveBackend(args, target, preferred)` | fn | 显式 > 会话归属(target.backend) > 偏好 > default |
| ★ `buildArgv(exePrefix, args, opts)` | fn | 返回 `{ argv, mode, timeoutSec, env? }`；opts 见 bridge-kit createRunner 调用点 |
| ★ `parseJson(stdoutText)` | fn | 宽容解析 stream-json，返回末 result 事件对象或 null |
| ★ `buildResult(parsed, outcome, mode, stderrText, stdoutText, backend)` | fn | 统一结果对象 `{ok,status,response,sessionId,mode,backend,totalTokens,durationSeconds,numTurns,exitCode,stderr,...}` |
| `foldStreamEvent(ev, project, summarizeArgs, maxArgLen, maxTrail)` | fn | 实时步骤折叠（写 project.current/trail）；无 stream-json 的 provider 省略 |
| `isTransientCliError(res)` | fn→bool | 瞬时错误自动重试一次的判定 |
| `isLimited(res)` | fn→bool | 可选：覆盖 kit 的限流/网络判定（默认 kit `isLimited`）；runner 用 provider 版决定是否弹回退三选一 |
| `failureHint(res)` | fn→string | 按失败类型给可行动指引（空串=用通用） |
| `preflight({args,exec,backend,cwd,engine,ctx,o})` | fn | 返回 `{ abort: <结果对象> }` 或 undefined |
| `execute({args,exec,backend,cwd,built,engine,ctx,o,runSync})` | async fn | **非 spawn 主路径**（mimo 桌面 HTTP 等）；与 `delegates` 配合：runner 在 `delegates(backend,args)` 为真（或未定义 delegates）时完全委托，返回值直接交 engine.end；为假则落回通用 pipeline（jobs/瞬时重试/回退弹窗） |
| `delegates(backend, args)` | fn→bool | 可选：限定 execute 的接管范围（例：mimo 只接管 mimo-desktop，mimocode 走通用 pipeline）。kit 在委托前已 engine.begin(cwd) 并调过 buildArgv——对不 spawn 的后端 buildArgv 可返回空壳 `{argv:[],mode,timeoutSec}` |
| ★ `unavailableStatus` | string | 找不到可执行时的 status（旧包各自保持：'CODEBUDDY_UNAVAILABLE' 等由你定，注意 isLimited 认 'CLI_UNAVAILABLE'，特殊名需自行保证限流判定不受影响） |
| ★ `tools` | object | `{ run:{name,description,inputSchema}, continue:{...}, status:{...} }` 纯对象 ToolDefinition（不含 execute），preset/dynamic 注册用 |
| ★ `runToolLogic(args, exec)` | async fn | 三形态共用：`this.runner.coreExecute` 已被工厂注入，见下 |
| `extraTools` | array | 额外工具 `[{name,description,inputSchema,logic(args,exec)}]`（agy_quota / mimo_settings） |
| ★ `settings` | object | 设置分区契约，见 §3 |
| `mcp` | object | MCP 形态扩展，见 §4 |

工厂约定：`defineProvider(deps)` 内部按上述字段构造 descriptor，并提供

```
descriptor.attach(hostOpts) → runner   // 见下；每个宿主形态调用一次
```

`attach(hostOpts)`：`hostOpts = { ctx, subprocess, resolveExe, getCwdFallback, getPreferredBackend?, getSettings?, planActiveFor?, publish }`。
内部构造 `engine = createStatusEngine({ provider: this, publish })` 与
`runner = createRunner(Object.assign({}, hostOpts, { provider: this, engine }))`，
把两者挂到 `this.engine`/`this.runner` 后返回 runner。descriptor 上的
`runToolLogic/continueToolLogic/statusToolLogic` 直接闭包引用 `this.runner/this.engine`
（宿主调用前必先 attach；dynamic 形态在 host 里 attach，preset 形态在 apply 里 attach）。
`continueToolLogic`：把 `args.prompt`（可选）+ sessionId/latest 语义组装成 run 调用。
（三份占位 stub 已按此形态实现，替换时保持 attach/xxxToolLogic 签名不变。）

可选补充字段：

| 字段 | 说明 |
|---|---|
| `isSuccessStatus(st)` | 灯/聚合层的「成功态」判定（mimo 的 ACCEPTED 就靠它）；缺省=仅 SUCCESS |

## 2. 事件与状态通道（由 keystone 统一监听，provider 只管发）

- preset 形态（Node 模块 `preset/<id>/cli-bridge.mjs`）：
  - 状态变化 `ctx.emit('<id>/status', { snapshot })`；snapshot 即 engine.statusSnapshot()（顶层含 `provider` 字段）。
  - 挂载时与每 30s `ctx.emit('<id>/mode', { active: true, sessionId })`（心跳租约，TTL 75s）。
- dynamic 形态：`ctx.get('cliBridgeCollector').mergeSnapshot('<id>', snapshot)`。
  （旧 `<id>Collector` 服务名在 keystone 里保留别名，向后兼容旧包并存场景。）
- 家级 HTTP 单一路由：`GET /cli-bridge/status` 返回
  `{ providers: { agy:{state,running,projects,presetActive,presetSessions}, codebuddy:{...}, mimo:{...} }, updatedAt }`。
- provider 模块**不要**自己注册事件监听/webServer 路由/preset —— 全在 keystone 指示灯与注册表里做。

## 3. 设置分区（统一文件 `{dsh-home}/cli-bridge-settings.json`，按 id 分区）

`descriptor.settings`：

```
{
  keys: string[],                      // 本分区允许的字符串字段名
  secretKeys?: string[],               // 其中属凭据/token 的字段：GET 只回掩码，
                                       // POST 空值=保持现值，`<key>Clear:true`=显式清除
  defaults(): object,                  // 默认值
  normalize(raw, env?): object,        // 清洗（未知键丢弃）
  meta?(env): object,                  // 展示元数据（字段标签/选项等）
  diagnose?(settings, env): string     // 一行诊断文本（灯面板用）
}
```

读写/落盘/GUI 全在 keystone；provider 只给纯逻辑。旧 codebuddy 的
preferredBackend/defaultModel/endpointOverride/codebuddyEnToken 归入 `codebuddy` 分区；
mimo 的 backend/desktopModel 归入 `mimo` 分区；agy 暂无分区字段可给 `{keys:[],defaults:()=>({}),normalize:()=>({})}`。
**token 永不回传明文**（keystone 负责掩码）。

`meta(env)` 的返回直接驱动合并后的设置面板（client.js 按它渲染，不认识任何具体字段名）：

```
meta(env) → {
  titleSuffix?: string,          // 卡片标题后缀（如 'CodeBuddy'）
  fields: [ {
    key: string,                 // 分区字段名
    label: string,               // 中文标签可，面板统一中文
    type: 'text' | 'select',     // 缺省 'text'
    options?: [{value,label}],   // select 用
    allowCustom?: boolean,       // select 允许自定义输入（defaultModel 就是它）
    placeholder?: string,
    note?: string,               // 字段下方说明
    secret?: boolean,            // 凭据字段：必须同时列入 secretKeys
    refresh?: {                  // 可选：给 select 加「手动拉取」按钮（见 §3.2）
      label?: string             //   按钮文案，缺省「拉取可用项」
    }
  } ]
}
```

diagnose(settings, env) 返回一行文本（卡片底部「诊断」区）；无诊断给 ''。

### 3.2 手动拉取（`refreshModels`）—— 面板不自动探测

**背景**：模型可用列表只能问服务端/端点，而"问"要起子进程、可能联网、可能因为某个
产品面没登录而失败。早期做法是在 `meta()` 里同步探针（`spawnSync` + 缓存），带来两个问题：
① 面板首屏可能被拖慢；② 探不到时下拉空着，用户无法区分"没模型"与"没拉到"。

**现在**：`meta()` **只读缓存、绝不主动探测**；探测改由用户点按钮显式触发。
provider 若希望自己的某个 select 字段支持手动拉取，则：

1. 在 `meta()` 的该字段上加 `refresh: { label: '拉取可用模型' }`；
2. 实现 `settings.refreshModels(settings, env)`（**可选**，async）：

```
refreshModels(settings, env) → Promise<{
  ok: boolean,
  ids?: string[],        // 可用项 id（keystone 转成 options:[{value,label}]）
  labels?: object,       // 可选：id → 展示文案
  source?: string,       // 数据来源标注，面板会显示（如 'account-live' / 'live'）
  error?: string         // ok:false 时必填且要可行动（告诉用户下一步怎么做）
}>
```

**铁律**：探测失败必须 `ok:false` + 可操作错误，**绝不**返回 `{ok:true, ids:[]}`
或把静态表冒充成权威清单（这是本项目反复踩过的坑，0.2.6~0.2.9 都在修它）。

keystone 提供端点 `POST /cli-bridge/settings/models`（body `{ provider: '<id>' }`），
固定返回 HTTP 200 + `{ ok, provider, options, source, error }` —— 用 `ok` 表达业务失败，
不用 HTTP 状态码，以免前端把"没拉到"当成网络错误而静默。client.js 渲染按钮、处理 loading
与错误展示，并把拿到的 options 合并进当前字段（不落盘，纯展示态；用户选中后照常走 POST 保存）。

### 3.1 调度区（顶层 `_scheduling`，非 provider 分区 —— 新增 provider 零改动接入）

`{DSH_HOME}/cli-bridge-settings.json` 顶层另有 `_scheduling` 区（下划线前缀 = 非 provider
命名空间，逐分区读取的旧代码天然忽略）：

```
"_scheduling": { "enabled": string[], "priority": string[] }
```

- `enabled` = 启用集合（集合语义，数组顺序无意义）；`priority` = 调用优先级，**数组顺序即优先级**；
- 生效序 `order = priority ∩ enabled`；缺省 / 文件缺失 / 值坏 → 全量启用（fail-open：读配置
  失败绝不等于关桥）；显式 `enabled: []` = 全关（被尊重）；非空但全部未知 → 回落全开；
- 单源逻辑 `core/scheduling.mjs`（`normalizeScheduling / resolveScheduling / isBridgeEnabled /
  describeScheduling`），宿主形态用 `ignorePin`（全局 env `CLI_BRIDGE_PROVIDER` 只是 MCP 进程
  启动参数，不得反噬用户会话里的桥）；钉住仅对 MCP 进程最高优先；
- **provider 作者不需要为此写任何代码**：注册表 `providers/registry.mjs` 的 `PROVIDER_IDS` 是
  唯一 id 轴 —— 新 id 进注册表后，面板调度卡（labels 取 `descriptor.label`、all 取视图
  `scheduling.all`）、四形态门禁（preset/dynamic `isBridgeEnabled(id, PROVIDER_IDS)`、MCP
  `selectedProviders`、status 视图）自动纳入；preset/dynamic 模板/声明一律以 ids 数组传参，
  禁止新增硬编码 id 列表（keystone 测试 `tests/core/scheduling.test.mjs` +
  `tests/keystone/scheduling-gate.test.mjs` 锁语义）。

## 4. MCP 形态（`mcp/providers/<id>.mjs`）

统一 stdio JSON-RPC 服务器 `mcp/cli-bridge-mcp.mjs`（keystone）聚合三家工具。每个 provider 导出：

```
export const meta = { id, label, version }          // version 独立跟随本包
export function tools(env) → [{ name, description, inputSchema }]   // 完整列表（含 extra）
export async function call(name, args, io) → string                  // 返回纯文本；错误也是文本
export function check(env) → true | throw                             // --check 自检
```

`io = { fs, path, homeDir, env, log }`。`call` 内部自己起子进程（无 DSH ctx），复用
描述符的 buildArgv/parseJson/buildResult；**每次状态变化把 engine 快照写
`{homeDir}/cli-bridge-mcp-<id>.json`**（用 bridge-kit 的 buildMcpBridgePayload + 原子写
`tmp→rename`）。允许 `import node:*`（MCP 是真 Node 进程）。

## 5. 交付文件清单（每个 provider 完全一致，路径冻结）

| 文件 | 形态 | 说明 |
|---|---|---|
| `providers/<id>.mjs` | 描述符 | §1；只 import bridge-kit |
| `preset/<presetDir>/cli-bridge.mjs` | preset host | presetDir：agy→`agy-first`、codebuddy→`codebuddy-first`、mimo→`mimo-first`（package.json exports `./preset-agy|./preset-codebuddy|./preset-mimo` 指向这里）。薄适配：读 `@deepseek-ai/dsh` 注入的 ctx，descriptor.attach() 装配 runner，注册 `descriptor.tools`+extraTools（`ctx.tools.register`，`ctx.effect` 包裹），注册提示段 `ctx.systemPrompt.section({name:'<id>:policy', text})`，心跳 `ctx.emit('<id>/mode')`，状态 `ctx.emit('<id>/status',{snapshot})`；导出 `apply(ctx)`/`name`/`inject` |
| `preset/<presetDir>/plugin-list.mjs` | preset 组合唯一权威源 | `export const meta={id,name,description,order}` + `export function buildPlugins(deps)`：以 `import { standardPluginRows, bridgeRow } from '../standard-base.mjs'` 为基底（keystone 单源，勿复制官方行），复制 persona 行改 prefix/suffix（如有），末尾 bridgeRow(id, deps.bridgeName)。返回纯数据（`__jsExpr` 占位原样透传，不要自己包函数） |
| `preset/<presetDir>/agent.cordis.yml` | **生成物·勿手改** | 由 `node scripts/build.mjs` 从同目录 plugin-list.mjs 生成（legacy 目录形态 `preset.yml` 同批生成）。当前 DSH（≥0.1.7-alpha.1，声明制）不读它；仅作 ≤0.1.6 的兜底交付物与 `npm run deploy:local` 拷贝源。桥接行 name 为裸说明符 `@luchenglong/cli-bridge/preset-<id>`（相对路径在注册表 baseUrl 下必然错解——历史事故） |
| `dynamic/<id>.host.template.mjs` | dynamic 沙箱 | 以旧仓 `dynamic/host.template.mjs`/`dynamic/host.js` 为蓝本重写为模板：只含沙箱适配（harness.registerTool、harness.handle RPC、collector 推送、exe 解析 env 守卫），**顶部两个占位符** `/*__KIT__*/`（bridge-kit 内联）与 `/*__PROVIDER__*/`（providers/<id>.mjs 内联），其余逻辑走描述符 |
| `dynamic/<id>.host.js` | 生成物 | `node scripts/build.mjs` 产物，勿手改 |
| `mcp/providers/<id>.mjs` | MCP 工具面 | §4 |
| `tests/<id>/*.test.mjs` | 测试 | `node --test`；覆盖 descriptor 纯函数、buildArgv/parse/result、状态引擎集成、preset apply 冒烟（mock ctx）、MCP tools/call 冒烟（fake exe fixture 放 `tests/<id>/fixtures/`） |
| `docs/history/<id>/CHANGELOG.md` | 历史 | 旧仓 CHANGELOG verbatim（勿改写） |

## 6. 验收闸门（Lead 会统一跑，你的 scope 必须全绿）

1. `node --check` 每个交付 .mjs/.js。
2. `node scripts/build.mjs`（全量生成）+ `--check` 幂等。
3. `node --test tests/<id>/`。
4. `node mcp/cli-bridge-mcp.mjs --check`（聚合后；你的模块缺失时 Lead 的文件会明确报错）。
5. 不新增 npm 依赖；`git` 提交信息 conventional commits。

## 7. 移植基线（旧仓 → 新仓映射速查）

- agy：`preset/agy-first/agy-first-bridge.mjs` 内联逻辑 → descriptor + 薄 preset；
  `bin/agy-quota.mjs` → `bin/agy-quota.mjs`（原样，路径改环境变量 `CLI_BRIDGE_AGY_QUOTA` 优先）；
  `mcp/agy-mcp-server.mjs` 的 framing 归 keystone 服务器，工具逻辑进 `mcp/providers/agy.mjs`。
- codebuddy：`core/codebuddy-core.mjs` 中与 provider 无关的骨架**不要**复制（已在 bridge-kit），
  provider 特有部分（BACKENDS/endpoint/auth/model catalog/settings/plan-mode Bash 预批 argv）进 descriptor；
  `dynamic/host.template.mjs` 的占位符改造为双占位符模板。
## 8. 运行时事实与红线速查（team 必读）

- **client id 红线**：`home-plugin/cli-bridge-indicator/lib/client.js` 的
  `__ModuleLoader__.load({ id: "@luchenglong/cli-bridge" })` 必须逐字等于包名，
  由 `scripts/verify.mjs`（prepack 自动跑）机器把关。**任何人任何任务不得改这个 id**，
  除非同时改包名并走 Lead 评审。改错 = 整个客户端组合加载失败 = DSH 启动致命屏。
- **红线 1**：任何任务不得重启/杀掉正在运行的 DSH 后端；不得改
  `%APPDATA%\DSH Desktop\dsh-home\profiles\web\package.json`（本次交付不切运行时）。
- **红线 3**：不得在本仓库创建 junction/symlink（360 会连带删目标）。
- preset 形态模块 = 宿主进程内真 ESM：可 `import node:fs` 等内建、可用 `process`；
  但**不得 import `@deepseek-ai/*`**（本地包解析根够不到 harness 包，历史论证）；
  模块内相对 import（如 `'../../providers/agy.mjs'`）是标准 ESM 解析，安全可用。
- dynamic 形态：`dynamic/<id>.host.js` 由 build 内联生成；**模板里禁止任何 import**
  （沙箱 new Function），宿主能力全部来自沙箱注入的 `harness.*`。
- MCP 形态：真 Node 进程，可 import node:*；没有 ctx.emit，状态只能走快照文件
  （`{DSH_HOME}/cli-bridge-mcp-<id>.json`，bridge-kit `buildMcpBridgePayload` + 原子写）。
- 家级灯路由（keystone 已实现，别重复注册）：`GET /cli-bridge/status`、
  `GET/POST /cli-bridge/settings`、三个旧路径 `/agy-indicator/status` 等保持兼容、
  `GET /agy-indicator/quota`（脚本定位 = env `CLI_BRIDGE_AGY_QUOTA` > 本包 bin）。
- 事件契约（provider 只管发，keystone 听）：`<id>/status` payload
  `{ snapshot: <engine.statusSnapshot() 输出> }`；`<id>/mode` payload
  `{ active: true, sessionId }`（每 30s 心跳续租，TTL 75s）。
- 旧包工具入参语义保持逐字不变（老提示词/会话仍在用）：移植时以旧仓测试为准，
  不许「顺手改 schema」。

## 9. 移植基线补充

- mimo：`core/mimo-core.mjs` + `core/runtime-settings.mjs` 的纯逻辑进 descriptor/mcp 模块；
  桌面 HTTP 路径（desktopFetch/desktopSendTurn 等）：preset/MCP 形态可用全局 fetch 与
  node: 模块，dynamic 沙箱形态若拿不到 fetch 则 preflight 报 `DESKTOP_UNREACHABLE`
  并提示改用 mimocode 后端（保持旧包语义）。

## 10. claude / codex 的实测事实（0.2.9 接入，改动前必读）

两家都是**在真机上跑出来的**，下面每条都有单测或 `check()` 防线钉住，别凭直觉"顺手修正"。

### claude（Claude Code，实测 2.0.76）
- 非交互：`claude -p <prompt> --output-format text|json|stream-json [--verbose]`。
  `stream-json` 必须配 `--verbose`，否则只吐结果不吐事件。
- 事件：`system`（含 `session_id` / `model` / `tools` / `permissionMode` / `apiKeySource`）→
  `assistant`（`message`）→ `result`（`subtype` / `is_error` / `result` / `session_id` /
  `total_cost_usd` / `usage` / `modelUsage`）。
- **成功判定陷阱**：`is_error=true` 时退出码可能是 0 也可能是 1，且 `subtype` 仍可能是
  `"success"`（无效模型实测就是这个形状）。判定必须 `is_error === false && exitCode === 0`。
- 续聊：`--resume <session_id>` / `-c|--continue` / `--fork-session`。
- 模型清单：**唯一权威来源 = 无效模型触发的服务端 400 报文**
  `"The supported API model names are X, Y, ..."`。`~/.claude/settings.json` 的 env 块里
  `ANTHROPIC_DEFAULT_*_MODEL` / `ANTHROPIC_MODEL` 是**用户配置的别名映射，不是服务端可用
  全集**（实测两者不一致），只能作诊断线索。
- 权限：`-p` 无 TTY，任何需要交互批准的动作都会挂到超时，故 auto 模式映射为
  `--dangerously-skip-permissions`（或 plan 态 `--permission-mode plan`）。

### codex（OpenAI Codex CLI，实测 0.98.0）
- 非交互：`codex exec [opts] <prompt>`；`--json` 出事件流，不加就是纯文本。
- 事件：`thread.started`（`thread_id`）→ `turn.started` → `item.completed`（`item`）→
  `turn.completed`（`usage`）。
- **`codex exec` 不接受 `-a/--ask-for-approval`**（那是根命令 `codex` 的旗，clap 会报
  unexpected argument）→ 审批只能 `-c approval_policy="…"`。
- **`codex exec resume` 不支持 `-C/-s/-o/--add-dir`** → cwd 交给 spawn 的 `cwd`，
  沙箱走 `-c sandbox_mode="…"`。
- **`item.completed` 里 `item.type==="error"` 是告警，不是致命错**（`resume --last` 会带一条
  「此会话原模型与当前模型不同」）。致命只有顶层 `error` / `turn.failed`；
  成功判据 = 退出码 0 + 收到 `turn.completed` + 无顶层错误。
- 非 git 目录必须 `--skip-git-repo-check`。
- 退出码：0 成功；1 运行错误（stdout 仍是合法事件流）；2 参数错误。
- 配置/凭据：`~/.codex/config.toml`（`model` / `model_provider` /
  `[model_providers.<name>]` 的 `base_url` + `experimental_bearer_token` /
  `model_catalog_json`）、`~/.codex/auth.json`（`OPENAI_API_KEY` / `OPENAI_BASE_URL`）；
  `CODEX_HOME` 可覆盖目录。**模型清单默认只走 live**（`GET {base_url}/models`），
  本地 `model_catalog_json` / `models.json` 仅在显式 `source=catalog|builtin` 时返回。
- npm 全局安装得到的是 `.cmd` shim：无 shell 时 spawn 不了，走 shell 会把 prompt 二次解释。
  因此命中 `.cmd/.bat` 时**明确报错并指引指向真实 exe**，不静默套 shell、不静默降级。

