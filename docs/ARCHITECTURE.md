# 架构（CLI Bridge）

三个旧桥接包（agy / codebuddy / mimo）深度重构为一个包。目标不是「拼盘」，而是把三处
几乎相同的骨架收敛成一份参数化实现，每家只提供一个描述符（descriptor）。

## 1. 三形态共享一个内核

同一个 provider 描述符驱动三种运行形态：

| 形态 | 运行环境 | 宿主能力 | 状态出口 |
| --- | --- | --- | --- |
| preset（`preset/<dir>/cli-bridge.mjs`） | 宿主进程内真 ESM | 真 `process`/node:*/ctx.* | `ctx.emit('<id>/status'\|'<id>/mode')` |
| dynamic（`dynamic/<id>.host.js`） | Cordis 沙箱 `new Function` | 只有注入的 `harness.*`/ctx，**禁止 import/process 裸用** | `cliBridgeCollector.mergeSnapshot(id, snap)` |
| MCP（`mcp/cli-bridge-mcp.mjs`） | 独立 stdio 进程 | node:* 全量 | 原子快照文件 `{DSH_HOME}/cli-bridge-mcp-<id>.json` |

约束的根因：沙箱形态（dynamic）里，`providers/<id>.mjs` 与 `core/bridge-kit.mjs` 被
`scripts/build.mjs` **文本内联**（`stripModuleSyntax`）。因此这两个文件：零 import、
零 `import.meta` 字面量、`process/fs` 一律 deps 注入或 typeof 守卫。
preset/MCP 形态是真实模块，可以用 node:* 与相对 import（禁止 `@deepseek-ai/*`，
历史论证见本地 preset 解析根问题）。

## 2. `core/bridge-kit.mjs` —— 通用骨架（与 provider 无关）

- **createStatusEngine({provider, publish})**：按项目（cwd）分桶的活动模型 ——
  `begin/foldEvent/end`，每项目 `current`（此刻步骤）+ `trail`（轨迹环，MAX_TRAIL=12）+
  累计 `runs/totalTokens`；会话表（MAX_SESSIONS=256）记录 `sessionId → {cwd, backend}`
  供续接路由（`resolveTarget`：显式 cwd > 会话归属 > 回退 cwd）。全局状态派生：
  running>0 → running；否则 fallback（回退激活）/ lastStatus 成功失败 / idle。
- **createRunner(o) → coreExecute(args, exec)**：完整编排管线——
  `preflight`（可 abort）→ `resolveExe`（抛错→unavailableStatus）→ `buildArgv` →
  `delegates(backend)` 判定是否交给 provider.execute（非 spawn 路径，如 mimo 桌面）→
  `jobs.start`（background）或前台循环：`HUNG_TIMEOUT` 守卫（timeout+60s 强杀）、
  `isTransientCliError` 静默重试一次、`isLimited`（provider 可覆盖）触发 `askFallback`
  三选一（回退/重试/取消），一切状态变化实时 publish。
- **纯函数**：`projectName/clampInt/shortLabel/summarizeArgs/endpointHost/LIMIT_RE`、
  NDJSON 半行安全 `createLineStream`、展示层 `renderResult/renderStatus`、
  MCP 载荷 `buildMcpBridgePayload/normalizeMcpBridge`（stale=90s）。

provider 侧全部差异 = 一个 descriptor（见 `PROVIDER-CONTRACT.md` §1）。

## 3. 家级指示灯（`home-plugin/cli-bridge-indicator/`）

随 DSH 启动的 bundle 插件（`dsh.bundle.patch` 一行插入；`dsh.client.platform:"web"`）。
内部分层，全部可单测（`createIndicatorState` 是纯状态机，注入 `listPresetSessions/
readMcpFile/isSuccessStatus/now` 即可离线测）：

- **index.mjs**：每 provider 一个桶 `{projects, sessionLeases, presetActiveUntil,
  lastModeAt}`。事件源三路合并：① preset 桥接 `ctx.emit('<id>/status')`（同进程）；
  ② dynamic 宿主 `cliBridgeCollector.mergeSnapshot`（家级收集器，旧包单家收集器名
  `agyCollector/…` 保留别名）；③ MCP 快照文件（每次读取实时合并，过期只清零 running，
  绝不清掉活动细节）。合并规则：state 是派生字段——外部快照的 state 只在 running 时被
  信任，其余本地重算（`isSuccessStatus` 来自 descriptor，mimo 的 ACCEPTED 等语义各家自定）。
- **租约（lease）**：preset 桥接每 30s 心跳 `ctx.emit('<id>/mode',{active,sessionId})`，
  TTL 75s（两跳 + 5s 宽限）。`sessionId` 有值 → 会话级租约；缺省 → 全局租约（client
  无法判定时的保守亮）。关会话/停桥接后租约过期，灯自动灭（旧 mimo 1.2.9「灯常亮」
  事故类的对偶防线：宁可用租约到期灭，不可无来源亮）。
- **preset 双通道判定**：宿主侧 `agents.list() × agentPresets.composedPreset()` 枚举
  「哪些 DSH 会话正跑在桥接预设下」是权威；client 侧 `useSessions` 投影只是兜底。
- **路由**：`GET /cli-bridge/status`（聚合三桶）、`GET/POST /cli-bridge/settings`、
  `GET /agy-indicator/quota`（5 分钟缓存）。旧包路径 `/agy-indicator/status` 等全部
  保留为单桶别名（旧前端/脚本兼容）。
- **preset-declarations.mjs（Form-A 自注册）**：indicator `ctx.inject(['agentPresets'])`
  → 对三家各 `agentPresets.register(definition)`。定义体直接 import 各
  `preset/<dir>/plugin-list.mjs`（与 legacy YAML 生成同一事实来源）。`{__jsExpr}`
  字面量**原样透传**给注册器（loader 原生识别；任何 JSON 序列化往返会丢函数——绝不
  编译成函数，这是旧 gen-preset-decl 时代踩过的位置）。旧 DSH 上对不存在的服务
  `inject` 只会 pending，无害；因此该形态跨版本一步到位。
- **client.js（红线 4）**：`window.__ModuleLoader__.load({ id: "@luchenglong/cli-bridge" })`
  —— id 必须逐字等于包名，不一致 = 整个 client combo 抛错 = 白屏进安全模式（历史两次
  事故）。`scripts/verify.mjs` + `tests/keystone/client-id.test.mjs` 双闸门。UI：标题栏
  一盏聚合 pill + 悬停/点击分区面板 + 设置页 meta 驱动卡片（provider 声明 fields，
  前端不认识任何具体字段名）。

## 4. 统一设置（`lib/settings.mjs`）

单一文件 `{DSH_HOME}/cli-bridge-settings.json`，按 provider 分区。provider 只声明纯逻辑
（keys/secretKeys/defaults/normalize/meta/diagnose，§3），落盘/掩码/清洗全在 keystone：
GET 永不回传明文 secret（掩码 `••••尾4`）；POST 空=保持、`<key>Clear:true`=清除；
写用 tmp→rename 原子替换。**旧包设置文件一次性字段级迁移**（codebuddy 扁平文件 /
mimo `{APPDATA}/mimo-first-bridge/settings.json` 的 backend→preferredBackend 映射）：
新分区从未写过该键才回退旧值，写过即新值说了算；永不写旧文件。

## 5. MCP 面（`mcp/cli-bridge-mcp.mjs` + `mcp/providers/<id>.mjs`）

一个 stdio JSON-RPC server（LSP 式换行分帧），initialize/tools/call 由 keystone 框架
实现；每家一个纯面模块（`tools(env)/call(name,args,io)/check(env)`，§4），`io` 注入
fs/path/homeDir/env/log，面模块不猜路径。`--provider=<id>` 过滤单家；
`mcp/<id>-mcp-server.mjs` 是薄封装（旧配置只换路径）。MCP 进程没有 ctx.emit，publish
改写快照文件；家级灯实时合并（见 §3-③）。

## 6. 构建与闸门

```
plugin-list.mjs（每家的唯一插件清单源）
  ├─ scripts/build.mjs → preset/<dir>/agent.cordis.yml + preset.yml（legacy 目录形态）
  └─ preset-declarations.mjs 直接 import（新声明制形态，同一份源）
dynamic/<id>.host.template.mjs + core/bridge-kit.mjs + providers/<id>.mjs
  └─ scripts/build.mjs（stripModuleSyntax + 双占位文本内联）→ dynamic/<id>.host.js
```

生成物提交入库（fresh clone 可用），`--check` 模式比对漂移 → CI/prepack 红。
三道闸门：`build --check`（漂移）、`verify.mjs`（红线/版本锁/描述符完整度）、
`node --test` + `mcp --check`（行为）。CI 矩阵 node 18/20/22。

## 7. 为什么这些选择（旧事故对照）

- **裸 specifier 桥接行**（`@luchenglong/cli-bridge/preset-<id>`）：preset mount 的
  baseUrl 不指向可预期的包内目录，`./preset/...` 相对行 import 永久挂起 → auditRows
  never started（agy 1.7.1 主根因之一）。exports 子路径 + Node 解析 = 机器无关。
- **声明制自注册**：0.1.6+ 起 `$DSH_HOME/.agent-presets/` 目录无人再读（官方 skill 明言），
  preset 必须以 `agentPresets.register` / bundle 声明行注册 —— Form-A 自注册跨版本可用，
  legacy 目录形态仅作旧版兜底。
- **无 dsh peer 依赖**：兼容闸门只校验 `@deepseek-ai/dsh*` peers，桥接包不声明 =
  天然通过；声明了反而武装闸门（版本漂移即 500）。
- **workflow 行单源**：上游把 dsh-workflow-worker-thread 改名 dsh-workflow-ptc 曾让
  「任一 enabled 行 import 失败 → 整个 preset 拒挂」（agy 1.7.1）。现在清单由
  plugin-list.mjs 一份源生成，行名跟 standard-base 常量走，漂移只会出现在一处修一处。
