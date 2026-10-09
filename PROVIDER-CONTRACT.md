# PROVIDER-CONTRACT — CLI Bridge 提供方（Provider）接入契约 v0.1.0（冻结）

> 单一事实来源：`core/bridge-kit.mjs`（通用骨架）。每个 CLI 提供方（agy /
> codebuddy / mimo）只写一个**描述符模块** + 各形态的薄适配层。
> **禁止**修改 `core/`、`home-plugin/`、`mcp/cli-bridge-mcp.mjs`、`scripts/`、
> `providers/registry.mjs`、根 `package.json` —— 这些是 keystone，由 Lead 单作者维护。
> 你的写权限范围见每个 provider 任务卡的 write_scopes。

## 0. 命名与硬约束（红线）

- provider id（全小写，用于事件通道/设置分区/文件名/工具名）：`agy` | `codebuddy` | `mimo`。
- preset id（保持旧包不变，旧会话头引用）：`cordis-agy` | `codebuddy-first` | `cordis-mimo`。
- 模型工具名（保持旧包不变）：`agy_run/agy_continue/agy_status(/agy_quota)`、
  `codebuddy_run/codebuddy_continue/codebuddy_status`、`mimo_run/mimo_continue/mimo_status(/mimo_settings)`。
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
| `failureHint(res)` | fn→string | 按失败类型给可行动指引（空串=用通用） |
| `preflight({args,exec,backend,cwd,engine,ctx,o})` | fn | 返回 `{ abort: <结果对象> }` 或 undefined |
| `execute({args,exec,backend,cwd,built,engine,ctx,o,runSync})` | async fn | **非 spawn 主路径**（mimo 桌面 HTTP 等）给了它则 runner 完全委托 |
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
- mimo：`core/mimo-core.mjs` + `core/runtime-settings.mjs` 的纯逻辑进 descriptor/mcp 模块；
  桌面 HTTP 路径（desktopFetch/desktopSendTurn 等）放进描述符（可 import node: 的形态仅限 mcp/*），
  preset/dynamic 形态的 fetch 用全局 fetch（沙箱可用）。
