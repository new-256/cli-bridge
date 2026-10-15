# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## [1.7.1] - 2026-09-23

### Fixed
- **修复 agent preset 在新版 DSH 上从预设花名册彻底消失（注册机制被上游弃用）—— 这是本次迭代的主根因**。DSH 0.1.6+ 弃用了旧版预设机制：`$DSH_HOME/.agent-presets/<id>/` 目录（含 `preset.yml` + `agent.cordis.yml`）**不再被任何代码读取**（官方 `editing-cordis-compositions` skill 明言 "Nothing reads that directory any more"），预设必须以 bundle patch 里的 `@deepseek-ai/dsh-agent-preset` **声明行**注册。症状：升级后端到 0.1.7-rc.1 后，`cordis-agy` 从 registry 消失，GUI 报 `Unknown agent preset: cordis-agy (gateway/internal)`，所有记录 `agentPreset: cordis-agy` 的旧会话 resume 失败、无法切换模型。修复方式：按官方迁移指引，在包内 bundle patch（`home-plugin/agy-indicator/cordis.patch.yml`）新增 `preset-cordis-agy` 声明行 —— `id: cordis-agy`（旧会话头引用此 id，不可改）、`name`/`description` 取自 `preset.yml`、`order: 5`、`plugins` 从 `agent.cordis.yml` verbatim 转录；声明行由新脚本 `scripts/gen-preset-decl.mjs` 生成（改预设内容后重跑生成器，勿手改缩进块）。实测：`agentPresets/list` RPC 返回无 `broken`、GUI 模式菜单出现 "Agy-First 执行代理"、新建会话徽章与 "AGY 就绪" 状态灯均在、模型正常应答。
- **桥接插件行改用裸子路径解析（`agy-first-bridge/preset-plugin`）**。preset mount 的 `baseUrl` 不指向包内任何已知目录（实测 `./preset/...` 与 `../../preset/...` 两种相对形态都让 `Entry._init` 的 import 永久挂起 → `auditRows` 报 `never started`）。而 patch 顶层的 `./` 相对行会被 `anchorInsertedPluginNames` 预解析成绝对 URL，但**嵌套在 `config.plugins` 深处的行不会**。最终形态：bridge 行 `name` 用裸子路径 `agy-first-bridge/preset-plugin`，经 `package.json` 新增的 `"./preset-plugin"` exports 子路径定位 `preset/agy-first/agy-first-bridge.mjs` —— 与 host 侧灯行同款 Node 解析机制，机器无关、npm 可移植（绝对 file URL 写死仅在诊断中验证过语义，不进发布件）。
- **修复 agent preset 在新版 DSH 上整体挂载失败（工作流引擎被上游改名）**。DSH 后端把工作流引擎包从 `@deepseek-ai/dsh-workflow-worker-thread` 改名为 `@deepseek-ai/dsh-workflow-ptc`，翻转点在 `@deepseek-ai/dsh-base@0.1.6-alpha.1`（已逐版本拉 tarball 比对 `dependencies` 证实：≤0.1.5-rc.3 全部是 worker-thread，≥0.1.6-alpha.1 全部是 workflow-ptc）。`preset/agy-first/agent.cordis.yml` 的 `workflow-worker-thread` 行因此在 0.1.6-alpha.1+ 上 import 失败，而 `@deepseek-ai/dsh-agent-preset-registry` 的 `auditRows()` 只要发现**任一 enabled 行**导入失败就 `throw`，**拒绝整个 preset 挂载** —— 症状是 agy-first 预设整体不可用（不是只丢工作流工具）。本机部署副本此前已被手工热修但从未回流仓库，故 npm 上的 1.7.0 仍受影响。

- **为什么不是简单改名**：两条发布线都在服役，`npm latest = 0.1.5-rc.3` 仍发 `worker-thread`，而 `next`/`alpha = 0.1.7-*` 已发 `workflow-ptc`（`dist-tags` 实测）。写死任一个都会打断另一条线。而 preset 行的 `name` 是**原样送进 `import()`** 的（只有 `config` / `disabled` 会过 `interpolate()`），**单行无法选包**。

  现改为**两行都声明、各自用 `!!js disabled` 自证**：守卫经 `process.getBuiltinModule('node:module').createRequire(process.argv[1])` 探测运行中 CLI 自身的解析基准（`argv[1]` 即活的 `dsh/lib/bin.js`，与 loader 的 import 同树），`resolve()` 命中哪个包就只留哪一行。三条路径实测：
  - modern 树（有 ptc）→ `workflow-ptc` 启用 / worker-thread 禁用
  - legacy 树（有 worker-thread）→ `workflow-ptc` 禁用 / worker-thread 启用
  - 未知树（两者都无）→ 两行都禁用，**preset 仍能挂载**（不再因缺包而整体失败）

  守卫永不抛异常（抛异常会让 `composition-inventory` 把该行判为 `'conditional'`，行为不可预期）；`!!js` 方言由 `cordis-plugin-include` 提供，`^1.0.7` 自 dsh 0.1.2-rc.1 起即存在，覆盖全部受支持范围。

### Added
- `scripts/gen-preset-decl.mjs`：从 `preset/agy-first/agent.cordis.yml` verbatim 转录生成 bundle patch 里的 `preset-cordis-agy` 声明行（缩进 +10 对齐官方 `presets/*.patch.yml` 模板；bridge 行 `name` 改写为裸子路径）。改预设内容后重跑 `node scripts/gen-preset-decl.mjs` 即可，不要手改 plugins 缩进块。
- `scripts/verify.mjs` 新增 §6 发布闸门：钉死两个引擎行必须**同时存在**、各自带 `!!js disabled` 守卫、守卫必须基于 `process.argv[1]` + `createRequire` 探测，且不得被无条件 `disabled: true`。防止后人"简化"回单行写死包名而重新引入整预设挂载失败。
- `scripts/verify.mjs` 新增 §7 发布闸门：钉死 bundle patch 声明行存在、`config.id === 'cordis-agy'`、bridge 行用裸子路径、`package.json` 导出 `./preset-plugin` 子路径，以及 **plugins 块与源文件逐行 verbatim 一致**（310 行全量比对，改了源文件忘跑生成器立即 FAIL）。
- `tests/preset-workflow.test.mjs`：语义级回归。用本机 DSH 本体自带的 `entryListSchema`（js-yaml + `!!js` 方言）解析仓库 preset，再用 `cordis-plugin-loader` 的 `evaluate()`（preset 挂载时真正使用的求值器）在模拟的 modern / legacy / 未知三种解析树下断言"恰好一个引擎行启用、且守卫不抛异常"。本机无 DSH 时明确 SKIP，不伪装通过。

### Changed
- **回填 2026-09-22 的部署侧热修（quota 兜底路径）到仓库**。`preset/agy-first/agy-first-bridge.mjs` 的 `QUOTA_FALLBACK_SCRIPTS` 原指向 `C:\Users\lcl\Desktop\agy-first-bridge\bin\agy-quota.mjs`（dev 仓库已迁移 → 路径失效）。该修复 9/22 只改了部署副本、未回流，v1.7.1 将其回填：兜底列表改为 npm 包内副本（`dsh-home\profiles\web\node_modules\agy-first-bridge\bin\agy-quota.mjs`）+ 稳定部署副本（`dsh-home\bin\agy-quota.mjs`）两条独立冗余路径，并附带溯源注释。回填后 `preset/agy-first/` 与部署件（`dsh-home\.agent-presets\cordis-agy\`）字节一致。
- **本地部署同步**：`profiles/web/node_modules/agy-first-bridge/` 内的 `package.json`（+exports 子路径）、`home-plugin/agy-indicator/cordis.patch.yml`（+预设声明行）、`preset/agy-first/*`（workflow 双守卫行 + 回填的 quota 兜底）与仓库逐字节一致；legacy 目录 `dsh-home/.agent-presets/cordis-agy/` 同步保持一致（新版已不读，留作回滚锚点）。旧会话在**重启 DSH Desktop 后**即可正常 resume（预设注册发生在 boot 时）。
- 版本号四处同步至 `1.7.1`：`package.json`、`mcp/agy-mcp-server.mjs` 的 `VERSION`、`home-plugin/agy-indicator/package.json`、本 CHANGELOG 顶部。

## [1.7.0] - 2026-09-12

### Added
- `docs/SUPPORT.md`：DSH 逐版本兼容性声明。基于对 `@deepseek-ai/dsh-client-modules@0.0.1-rc.1 .. 0.1.5-rc.2`、`@deepseek-ai/dsh-web-app@0.0.1-rc.1 .. 0.1.5-rc.2` 共 16 个历史 tarball 的逐字节指纹比对；支持下限定为 `@deepseek-ai/dsh ≥ 0.1.2-rc.1`（arrive() 契约从 0.0.1 起就存在，但 `reloadUrls` 等配套此版才补齐）。
- `docs/issues/BACKEND-ISSUES.md`：提给 DSH 后端 / 桌面壳的两条 issue 草案（挂载期校验 client id / enterSafeMode 单行隔离）。
- `docs/handover/audit/`：回测证据 JSON 与关键版本 client.js 的 arrive() 契约指纹（含 SHA256），可独立复算。

### Changed
- **重构调用范式：agy_run 引入紧凑上下文包，后续调用转由 agy_continue 延续**（**根因：与原生 subagent_fork 的上下文继承不对称**）。旧版 `agy_run` 强制要求提示词“完整且自包含”，将全量上下文序列化的沉重负担强加给调用模型，导致模型更倾向于选择自动继承历史轮次的 `subagent_fork`。现改为在首派时注入 2-6 行 compact CONTEXT 前置块（仅指明目标、仓库根目录、关键路径与既有约束，严禁贴文件全文，由 agy 自行查阅），同一主题后续任务转由 `agy_continue` 沿用内部会话；两工具的超时默认值统一由 300s 提升至 600s（`timeoutSec` 默认 600）。
- **执行形态默认后台化，决策与回退循环闭环下沉至 Job**（**根因：执行形态不对称与后台“失败无回退”的劝退设计**）。原生子代理默认后台运行，而旧版 `agy_run` 默认前台阻塞，且其后台分支硬编码“后台失败不弹回退框”，导致后台体验劣质。现改为当环境支持 jobs 时默认 `background: true`（立即返回 jobId 并通过 `job_output` 收集、`agy_status` 观察进度；显式传 `false` 才阻塞）；将核心决策循环（运行 → 限流/网络受限时弹窗询问 → 重试/回退/返回错误，最多 2 次）抽象为通用逻辑并在后台 Job 中完整支持（后台 Job 运行中遇到受限同样触发用户回退弹窗，且绝不透传过期 signal）。用户选择回退后 Job 输出结构一致的 `FALLBACK_TO_DSH` 结果。注意：5h 配额阻断（`QUOTA_BLOCKED`，Gemini 5h 池子 <10%）依然保持完全同步拦截，不进入后台 Job。
- **系统提示词段落后移对齐注意力，注入子代理 Persona，精简政策为决策表**（**根因：政策注入位置劣势、文本自相矛盾与昂贵感暗号**）。旧版 `agy:policy` 位于 `order: 5`（最顶部），被位于 `order: 2800`（`TOOL_SUBAGENT`，紧邻工具目录）的原生子代理引导抢占注意力。现将注入顺序改为动态获取 `TOOL_SUBAGENT` 顺序并置为 `TOOL_SUBAGENT + 10`（降级 2810）；在 `agent.cordis.yml` 的 `tool-subagent` 与 `tool-subagent-fork` 预设中均注入委托导向的 English `persona`，明确要求子代理在写代码/重构/跨文件排查前先派发 agy；将政策文本重构为紧凑决策表（总长度不增加），消除“先查 agy_quota”与工具声明中“无需预检”的自相矛盾，删除结果头行产生开销暗示的 `tokens=NNNNN`（仅保留在结构化结果内部）。
- **同步 MCP-POLICY 文档与 MCP server / dynamic 副本**：更新根目录 `MCP-POLICY.md` 与 `MCP-POLICY.zh.md` 的优先规则与上下文包模式（保持外部同步 MCP 调用的契约范围，不引入 DSH 后台概念，超时默认同步至 600s）；`mcp/agy-mcp-server.mjs` 与 `dynamic/host.js` 同步更新参数提示、默认超时 600s、去 tokens 渲染头及系统提示词位置。
- README 版本表回填 v1.6.1 / v1.6.2 行；新增"与 DSH 的版本兼容性（速查）"一节，明确支持下限 `0.1.2-rc.1`。
- Git tag 补齐：`v1.5.15` / `v1.6.0` / `v1.6.2`（v1.6.1 已存在）；GitHub Release 对应三版已建立，v1.6.2 置为 Latest。

## [1.6.2] - 2026-09-10

### Fixed
- **修复合并主包布局下「MCP 通道点灯」失效（host 读错 live 文件路径）**。MCP server（部署在 `<dsh-home>/bin/agy-mcp-server.mjs`）始终把运行状态写到 `<dsh-home>/plugins/agy-indicator/mcp-live.json`；但 1.6.0 并包后 host 半随包位于 `<pkg>/home-plugin/agy-indicator/lib/index.mjs`，旧代码用 `new URL('../mcp-live.json', import.meta.url)` 定位，`../` 落到**包内部**（`<pkg>/home-plugin/agy-indicator/mcp-live.json`），永远读不到 MCP 写的共享文件。症状：`mcp__agy__*` 调用时 MCP 写盘正常、文件里 `running:1`，但家级灯恒 `idle`（本机以主包名 junction 安装后逐秒采样 47/47 漏报确认）。现改为按与 `dsh-plugin-manager-plus` 同款的 `detectDshHome()`（`DSH_HOME` → `%APPDATA%/DSH Desktop/dsh-home` → `~/.dsh`）锚定共享文件；显式 `AGY_MCP_LIVE_FILE` 仍最优先，旧 `import.meta.url` 相对路径降为末位兜底（旧式 `<dsh-home>/plugins/agy-indicator/lib/` 布局继续可用）。

## [1.6.1] - 2026-09-10

### Fixed
- **修复全新安装时整屏插件页崩溃（client 模块注册 id 失配）**。v1.6.0 把灯并入主包后，`home-plugin/agy-indicator/lib/client.js` 的 `__ModuleLoader__.load({ id })` 仍写着旧内层包名 `"agy-indicator"`，而 `@deepseek-ai/dsh-client-modules` 按 loader 行解析到的 package.json `name`（主包名 `agy-first-bridge`）生成 graph 行 id。两者不一致时浏览器侧 `arrive()` 抛 `client-modules: bundle ... loaded without registering "agy-first-bridge"`，combo 机制下单模块失败会糊掉整屏插件页（同款事故见 codebuddy-first-bridge 1.1.7）。本机 junction/内层包形态因 graph id 恰为 `agy-indicator` 而未暴露，故一直未发现。现已将注册 id 改为主包名 `agy-first-bridge`。

### Added
- **发布闸门 `scripts/verify.mjs`（`npm run prepack` 自动执行）**：把「client 注册 id 必须 === 主包名」做成静态检查，含显式禁止退回 `agy-indicator` 的双保险；另锁版本号三处一致（package.json ↔ MCP `VERSION` ↔ CHANGELOG 顶部）、主包 DSH 插件面结构、bundle patch 行、preset 组合要素。v1.6.0 主包 package.json 完全没有 scripts/prepack，是该缺陷能流到 npm 的直接原因。

### Changed
- MCP server `VERSION` 从漂移的 `1.5.13` 同步为 `1.6.1`（`serverInfo.version` 与 `--check` 输出随之修正）。
- 内层包 `home-plugin/agy-indicator/package.json` 标记 `"private": true` 并 bump 1.6.1：它只是随主包分发的仓库内部构件，禁止再以 `agy-indicator` 名单独发布（独立包冻结于旧版留档）。
- client.js 顶部注释补写 id 契约与事故根因，防止后续误改回内层包名。

## [1.6.0] - 2026-09-08

### Changed
- **双包合一：灯并入主包 `agy-first-bridge`**。主包 `package.json` 增加 DSH 插件面——`main` → `./home-plugin/agy-indicator/lib/index.mjs`（灯 Host 半）、`exports` 双面暴露（`.` → host、`./client` → 灯浏览器半）、`dsh.bundle.patch` → 包内 `home-plugin/agy-indicator/cordis.patch.yml`。跨设备安装灯变为单命令：`dsh plugin --profile web add agy-first-bridge`（bundle 层自动挂载，与官方 `dsh-comfyui-bridge` 同模式）。
- **独立 npm 包 `agy-indicator` 弃用留档**：自 v1.6.0 起不再更新，npm 已发布版本保留不删（无法删除）。主包内 `home-plugin/agy-indicator/package.json` 描述标注弃用；旧式安装（复制目录 + junction + 用户层裸包名 `agy-indicator`）仍受支持——用户层同 id 行后应用、整体覆盖 bundle 层，本机部署形态不变。
- **包内 bundle 层行 name 改为 `agy-first-bridge`**：远程设备 `dsh plugin --profile web add agy-first-bridge` 时，裸包名解析到主包（main → 灯 host 半）；本机用户层 `agy-indicator`（junction 直连）不受影响。

### Added
- 主包 README 中英「经 npm 安装」章节更新为全套组件单包分发说明；方式 B 增加标准安装（`dsh plugin --profile web add agy-first-bridge`）与弃用说明。

### Notes
- 灯组件在分发物中的位置不变（`home-plugin/agy-indicator/`，含 `lib/` 3 文件 + `cordis.patch.yml` + `package.json`），主包 `files` 已含 `home-plugin/`，`npm pack` 后 tarball 结构与内容保持全套（preset + 灯 + MCP + 动态 + bin）。
- 兼容性：v1.5.15 已安装 `agy-indicator` 独立包的环境无需迁移，旧版继续可用；新环境统一走主包。

## [1.5.15] - 2026

### Changed
- **适配 `dsh-persona` 新校验（DSH 0.1.3-alpha.2+）**：DSH 后端自动更新后，`@deepseek-ai/dsh-persona` 将配置校验升级为 `prefix: z.string().required()`（另有 `suffix`/`complete`/`includeRuntimeContext` 均带默认值）。preset 组合里的旧写法 `config: { text: ... }` 被 Schemastery 直接拒绝挂载，恢复会话报 `invalid config: - $.prefix missing required value`。本仓库 preset 的 persona 行迁移为：
  ```yaml
  config:
    prefix: >-
      You are a coding agent powered by the {{model}} model.
    suffix: Your working directory is {{cwd}}.
  ```
  原单句 `text` 逐字拆分为 prefix + suffix，语义不变（与部署侧 cordis-agy / codebuddy-first / agy-coding 的迁移写法一致）。部署侧两个 preset 根的迁移由修复会话完成，本版将同款结构落进仓库交付物。

### Added
- **npm 发布就绪**：`package.json` 移除 `private`，新增 `bin`（`agy-mcp-server` → `mcp/agy-mcp-server.mjs`，文件本就带 shebang，支持 `npx -y agy-first-bridge`）、`repository`/`homepage`/`bugs` provenance；`files` 补入 `bin/`（`agy-quota.mjs` 是 preset 桥与 MCP server 的额度门禁依赖）。名称 `agy-first-bridge` 在 npm 上可用（404）。
- **`AGY_QUOTA_SCRIPT` 环境变量**（preset 桥 + MCP server）：额度脚本解析顺序变为 env 覆盖 → 相对包内 `bin/` → 本机绝对路径 fallback。preset 从 npm 包复制进 `.agent-presets/` 后相对路径会断，此前只能靠硬编码的本机路径；现在设 `AGY_QUOTA_SCRIPT` 即可让 5h 门禁在任意安装布局下继续生效（不设置则静默跳过，运行时限流仍有回退兜底）。MCP server 原有 `AGY_MCP_LIVE_FILE` 不变。
- **`agy-indicator` 标准 npm 包形态**（对齐官方 `dsh-comfyui-bridge` 模式）：`home-plugin/agy-indicator/package.json` 的 `main` 从浏览器占位 `lib/client-entry.mjs` 改为 Host 半入口 `lib/index.mjs`，`exports` 双面暴露（`.` → host、`./client` → 浏览器半），新增 `dsh.bundle.patch` → 包内 `cordis.patch.yml`（bundle 补丁层，安装后自动挂载通用默认行）。家级 `cordis.patch.yml` 的 host 行从 `file:///...lib/index.mjs?v=7` 迁移为**裸包名** `name: agy-indicator`（经 junction 解析，client 半靠 `dsh.client` 声明自动纳入浏览器花名册，无需单独 client 行）。跨设备分发：`dsh plugin --profile web add agy-indicator`。
- README 中英双语新增「经 npm 安装」章节；方式 D 补充 `agy-mcp-server` bin / `npx` 用法；方式 B 改为标准裸包名安装说明（本机 junction + 跨设备 npm）。

### Notes
- 兼容性：persona 新写法对更早的 DSH 版本同样合法（`text` 从未是 schema 的正式字段，旧版只是宽松忽略未知键）。
- 环境备注：本机默认 registry 为 npmmirror，发布需显式 `--registry https://registry.npmjs.org`（用户级 .npmrc 已有官方 registry token）。
- 部署侧 `cordis-web-search` 旧版预设目录已被删除（修复会话清理），v1.5.14 对它的桥修复随之作废，无影响。

## [1.5.14] - 2026

### Fixed
- **非 SUCCESS 结束后状态灯永久冻结（灯假 running、agy_status 投毒）**：`globalStatus()` 的聚合状态表达式原写作 `lastStatus === 'SUCCESS' || lastOk`，其中 `lastOk` 是**未声明的裸标识符**（本意是各项目 `p.lastOk` 的聚合，但循环里从未提取过）。任何一次以非 SUCCESS 结束（PARSE_ERROR / FAILED / agy 进程中途暴毙没有最终 result 行）且不处于回退弹窗时，聚合计算必然抛 `ReferenceError: lastOk is not defined`：
  - `agy_status` 工具直接报「lastOk is not defined」；
  - 状态灯的 `publish()` 把异常静默吞掉 → 灯永远冻结在最后一次成功发布的 "running" 快照上，看起来 agy 一直在跑（实测：QQ 任务 23:20 已死，灯又"跑"了 1.5 小时）。
  - 修复与 codebuddy-core v1.1.0 的同款整改一致：聚合状态只看 `lastStatus === 'SUCCESS'`（删除 `|| lastOk`）。项目对象上的 `p.lastOk` 字段本身保留（声明 + 赋值合法）。
  - 修复位置：preset（部署 cordis-agy 已由诊断会话修复，仓库本版同步）＋ `dynamic/host.js`；部署侧本机 `cordis-web-search` 旧版桥一并修复。MCP server、家级灯 index/client、agy-coding 桥无此代码路径（逐副本排查确认干净）。
  - 验证：隔离复现旧表达式抛 `ReferenceError: lastOk is not defined`；修复后同场景 `state='failed'` 正常传播；全盘扫描（`.dsh` 与 `DSH Desktop` 两处 preset 根 + 仓库）无执行代码级 `|| lastOk` 残留。

### Notes
- 需**重启 DSH** 生效（preset 模块在进程内缓存；重启同时加载 v1.5.13 的 5h 门禁与灯留存改动）。
- 遗留隐患（本版未处理，记录在案）：`askFallback()` 在限流/网络失败时弹回退对话框并**无限等待**——bot-gateway 这类远程会话无人能点，未来一次网络抖动可能让 QQ 任务真卡死；建议给远程会话加超时或把问题转发到 QQ。另：QQ 会话收到 PARSE_ERROR 后自身沉默（turn 未收尾）是独立一层问题，待查。

## [1.5.13] - 2026

### Changed
- **额度门禁只认 5h 窗口**：单次任务的门禁判断**仅取决于 Gemini 5h 池子**（<10% → 静默 QUOTA_BLOCKED，不调 agy）。理由：5h 枯竭意味着本轮任务里 agy 确实跑不动，必须阻断；而**周用量枯竭只说明这个子代理这周不该再用**（换别的子代理或用原生工具），不是 agy 临时不可用，因此不该参与单次任务判断。
  - 移除调用路径上的**周额度软警告**（原 v1.5.9：weekly <20% → 结果附 `[quota] 周套餐余量低…建议降低任务规模`）：preset / dynamic 两处的 `quotaWarning` 计算与拼接全部删除。
  - 同步改写会误导模型的提示词与工具描述：`agy_quota` 描述与 systemPrompt 的 Quota guard 段明确「5h 是唯一门禁；weekly 不是单次任务门禁，绝不因周用量缩小/推迟/放弃当前任务」（preset / dynamic / MCP 三处）。
  - 周额度信息**保留**：`agy_quota` 仍返回 weekly 桶，家级灯弹窗仍显示周余量——只做展示，不做门禁。
  - MCP server 的调用路径本就只有 5h 阻断（无周门禁），本次只修正其 `agy_quota` 描述文案。

### Added
- **agy MCP 全局注入**：家级 `cordis.patch.yml` 注册 `mcp-agy-global`（`@deepseek-ai/dsh-mcp-client` + `bin/agy-mcp-server.mjs`），工具落在 tools registry 的 **global 层** → **所有 preset（标准/极简/创造等）都能看到并调用 `mcp__agy__agy_run|agy_continue|agy_status`**；agy 优先模式仍以原生 `agy_run`（带策略提示词、回退弹窗）为首选。
  - 相应移除 preset 层重复的 `mcp-agy` 行（cordis-agy / cordis-web-search），避免同一 server 被拉起两份。
- **MCP 通道点灯（跨进程桥）**：`agy-mcp-server.mjs` 每次状态变化（running / step_update / ok / failed）把 per-project 快照写盘到 `<dsh-home>/plugins/agy-indicator/mcp-live.json`（`AGY_MCP_LIVE_FILE` 可覆盖）；家级灯 `index.mjs` 在 `/agy-indicator/status` 里读盘合并（400ms 节流）。此前 MCP server 是独立 stdio 子进程、无 `ctx.emit` 也拿不到 `agyCollector`，**走 `mcp__agy__*` 的调用完全不点灯**。
  - 字段在写盘时对齐 `mergeSnapshot`（`lastStatus`/`lastAt`/`lastConversationId`，ISO → epoch ms；否则 `Number(ISO)=NaN` 会回退 `Date.now()`，导致 ok 永不过期）。

### Fixed
- **调用结束后状态灯不消失（跨会话常驻）**：家级灯的 `OK_HOLD_MS` 原为 `presetActive ? 10min : 8s`，而 `presetActive` 是**全局心跳租约**——只要有任一 agy preset 会话在线，**所有**会话（含普通模式）的 ok 结果都被保留 10 分钟；项目表又是全局共享的，删除当前会话也不清空。现统一为 ok/failed **8s**、idle 10s，running/回退期间恒保留。agy 优先会话的常驻「就绪」灯由 client 端按本会话 preset 判定（readyShow）提供，不依赖旧 ok 项目滞留。

## [1.5.12] - 2026

### Fixed
- **agy_quota 在含空格路径的部署（如 `DSH Desktop`）下恒报 `no JSON output`**：`new URL(...).pathname` 对空格返回 `%20` 百分号编码，`replace(/^\/([A-Za-z]:)/, '$1')` 只剥前导斜杠、无法还原 `%20`，导致拼出的脚本路径永远不存在、子进程无输出。改为 `fileURLToPath()` 正确解码（preset 与 MCP 两处同修）。
- 脚本定位增加 fallback（`Desktop\agy-first-bridge\bin\agy-quota.mjs`）与缺失检测；失败报错带退出码与 stderr，便于诊断。
- 顺带影响修复：agy_run 的额度预检此前也因同一路径 bug 静默跳过（cachedQuotaCheck 拿不到 JSON），现恢复正常。

### Notes
- 适配 DSH：**0.1.2-alpha.4**（历史 v1.0.0 → v1.5.11 适配 DSH 0.1.1-rc.2）。
- 实测：本机部署路径（含空格）下 agy_quota 正常返回 gemini-weekly 23% / gemini-5h 92%、28 模型中 25 recommended。
## [1.5.11] - 2026

### Added
- **5h 额度硬阻断（Quota guard）**：Gemini 5h 池子余量 <10% 时，agy_run / agy_continue **不调用 agy**，静默返回 QUOTA_BLOCKED（**无弹窗、不通知用户**），模型直接改用原生工具完成。
  - preset / dynamic / MCP 三处统一实现；前台与后台都生效。
  - 判定目标：Gemini 相关 5h 桶（bucketId 含 gemini 或组名含 Gemini），如 gemini-5h。
  - 30 分钟缓存复用（与周额度预检一致）。
- 周额度 <20% 仍为软提示（前台结果附 [quota]），不阻断。

### Notes
- 实测：当前 Gemini 5h = 98%，不触发阻断；逻辑验证：bucket 识别命中 gemini-5h，阈值 <0.10 判断正常。
## [1.5.10] - 2026

### Added
- **模型选择策略**：DSH 根据任务需求自行决定 agy 用哪个模型（model 参数）。
  - gy_quota 输出每个模型的 amily（gemini/claude/gpt/other）与 ecommended（Claude/GPT 3p = false）；render 中 3p 标 [3p: Claude/GPT 不推荐]；--summary 的 topModels 只列推荐模型。
  - policyText 新增 Model selection policy 段：优先 Gemini 池子 / 工具模型（recommended:true），**不要向 agy_run 传 Claude/GPT (3p) 模型**（本套餐上基本不可用）。
  - **生图/图像编辑任务**：直接交给 agy_run 且**不指定 model**——agy 自行选择图像模型处理，不做过滤拦截。

### Notes
- 模型家族识别规则：name 含 claude → claude；含 gpt → gpt；含 gemini → gemini；其余 → other。
- 实测：28 模型中推荐 25 个（Gemini 21 + 工具类 4），Claude 2 + GPT 1 标不推荐。
## [1.5.9] - 2026

### Added
- **Google AI 套餐池子额度查询**（参考开源项目 [lbjlaq/Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager) 的方法，已实测打通）：
  - 新增独立脚本 in/agy-quota.mjs：读 Windows 凭据管理器 gemini:antigravity（agy OAuth 登录时写入）→ 用 Antigravity 公开 OAuth client 刷新 access_token → 调 Google Cloud Code API：
    - etchAvailableModels：每模型池子剩余百分比（remainingFraction → %）；
    - etrieveUserQuotaSummary：分组套餐余量（weekly 周窗口 + 5h 快窗口）。
  - 新增工具 **gy_quota**（preset / 动态形态 / MCP 三处实现）：返回 { ok, models[], groups[], tier }；--summary 返回紧凑摘要。
  - **家级灯**：弹窗顶部显示周套餐余量（/agy-indicator/quota 路由，5 分钟缓存）；周额度 <20% 琥珀色警告。
  - **谨慎调用**：前台 gy_run 前 30 分钟缓存预检周余量，<20% 时在结果附 [quota] 警告（建议降低规模或先查 agy_quota）。
- 凭据读取用 csc.exe 现编译最小 C# 程序（规避本机 Add-Type 因 LIB 自引用失效的问题），编译产物缓存于 %TEMP%。

### Notes
- 实测本机数据：Gemini 周额度 27%（reset 09/03）、Claude/GPT 周 100%；每模型池子 98-100%。
- 动态形态的 agy_quota 随下次插件重定义生效（本次会话的旧动态插件不含该工具）。
## [1.5.8] - 2026

### Fixed
- **超时不再静默 FAILED**：实测发现 agy 超时时错误信息位于 result JSON 的 rror 字段（如 	imeout waiting for response），而非 stderr；此前 DSH 侧 isLimited 检测不到 → 网络挂起/超时只返回 FAILED 不弹回退窗。
- 现在 uildResult 将 parsed.error 并入 stderr → 	imeout 词命中 LIMIT_RE → 正确触发回退弹窗（可选 DSH 本地 API 继续 / 重试 / 返回错误）。
- 实测确认：agy 自身 --print-timeout 是有效的第一道防线（timeoutSec=10 + sleep 40 时 17s 退出，不无限等）；DSH 侧 	imeoutSec+60s 硬超时是第二道防线。
- 同步至 preset / 动态形态 / MCP 三种实现。
## [1.5.7] - 2026

### Fixed / Added
- **防死等加固（工作探测）**：
  - DSH 侧进程超时强制 terminate（	imeoutSec + 60s，绝不无限等）；超时时明确报 HUNG_TIMEOUT（区别于解析失败），并附**最后事件摘要**（最后步骤、最近轨迹、距上次活动秒数），便于区分"长任务正常"与"真卡死"。
  - 实测确认：agy 在后台长命令（如 sleep 40s / build）期间**不产生 step_update 事件**，因此**不做"无事件即杀"的心跳**（会误杀长任务）；以进程超时为唯一防线，长任务请调大 	imeoutSec。
  - HUNG_TIMEOUT 计入"受限"归类 → 触发回退弹窗（网络挂起场景）。
- **错误归类增强**：LIMIT_RE 补充额度/认证词（quota|insufficient|credit|balance|exhausted|401|403|unauthorized|金额|余额|额度|认证），额度耗尽/认证失败快速识别并触发回退，不再静默。
- **弹窗透明化**：家级详情弹窗显示每个运行项目"无活动 Ns"（>90s 琥珀色提示：长任务请耐心 / 疑似卡住可取消重试）。
- 同步至 preset / 动态形态 / MCP 三种实现。
## [1.5.6] - 2026

### Added
- **点击灯弹窗实时查看 agy 活动**：点击标题栏状态灯打开详情面板，逐项目显示：
  - 当前步骤（高亮）：当前: step N → 工具名 + 参数 JSON；
  - 最近步骤：最近 6 条轨迹（[ACTIVE/DONE] step N 工具 参数）；
  - 项目 cwd 与上次状态（last=SUCCESS + 会话号）。
  - 数据跟随 1.2s 轮询**自动刷新**，无需关闭重开；关闭方式：× 按钮 / 点击遮罩 / Esc。
  - 纯浏览器实现（原生 setInterval/clearInterval + React），不引入 Cordis ctx，保持切换会话不空白。
- 目视实测：运行中点击灯 → 面板实时显示 step → tool + 参数变化；完成后显示 ✓ + 轨迹。
## [1.5.5] - 2026

### Fixed
- **脉冲圆点颜色无辨识度**：--dsw-alias-brand-primary 实际解析为近黑色（ar(--dsw-static-neutral-bluish-1000) = #0f1115），running 圆点看起来是灰点。改用静态蓝 --dsw-static-blue-500 (#3b82f6)，ok 改用 --dsw-static-green-500 (#22c55e)。
- **灯文字显示项目名而非 AGY**（如 "⟳ DSH"）：统一显示 "AGY"（⟳ AGY / ✓ AGY / ✗ AGY / ↩ AGY），项目名与当前步骤移入 tooltip（project: DSH + 步骤轨迹）。
## [1.5.4] - 2026

### Added
- **全软件统一为一盏 agy 状态灯**：此前动态插件（当前会话）与家级插件（全局）各自渲染标题栏灯，普通模式下会出现两盏 "AGY 就绪"。v1.5.4 起动态形态**不再注册自己的灯**，改为通过家级 host 暴露的 `agyCollector` 服务（`ctx.provide('agyCollector', { mergeSnapshot })`）把快照推入**同一张全局表**，由家级灯统一显示——任何形态（preset 或动态）的 agy 活动都反映在同一盏灯上。
- **模式感知的显示策略**：
  - `presetActive=true`（有 agy 优先会话在线，preset 挂载时 `ctx.emit('agy/mode', {active:true})` 宣告、每 30s 续期）：家级灯**常驻**显示，无项目时显示占位 "AGY 就绪"。
  - `presetActive=false`（普通模式会话）：家级灯**仅调用 agy 时临时出现**——运行/回退期间显示，ok/failed 结果保留 8 秒后隐藏，空闲时标题栏无灯。

### Fixed
- **后端启动崩溃（`service "agyCollector" has been registered`）**：patch 中裸名行 `agy-indicator` 通过 `package.json` 的 `main` 解析，此前 `main` 指向 `lib/index.mjs`，导致同一份宿主逻辑被 file:// 行与裸名行加载成两个模块实例（ESM URL 不同），`apply` 执行两次、`ctx.provide('agyCollector')` 二次注册同名服务 → 后端启动失败。修复：新增 `lib/client-entry.mjs`（空操作占位），`main`/`exports["."]` 改指向该占位，裸名行只承担 client-modules 花名册扫描职责，宿主逻辑仅由 file:// 行加载；`index.mjs` 的 `provide` 加 try/catch 双保险。
- 目视实测（普通模式 + 动态形态）：空闲无灯 → `⟳ DSH` 品牌色脉冲（运行中）→ `✓ DSH` 绿点（完成后 8 秒）→ 灯消失。

## [1.5.3] - 2026

### Fixed
- **动态灯读不到状态（永远显示占位灰点 + `agy[undefined]undefined`）**：Cordis 动态插件的 `host.call` 返回 host-runner 的 invoke 包装 `{ ok, value }`，而非 handler 的原始结果。`dynamic/client.js` 此前直接把包装对象当作 snapshot 使用，`s.state`/`s.projects` 恒为 undefined，灯永远渲染占位符。已改为**解包 `value`**（防御性：仅当 `v.ok === true && 'value' in v` 时解包，否则原样使用）。修复后动态灯显示真实状态：`⟳ 项目名`（工作中，品牌色脉冲）、`✓ 项目名`（成功，绿点）、`✗`/`↩`，悬浮 tooltip 显示当前步骤与最近轨迹。
- 目视实测（真实 agy 调用）：标题栏灯 就绪 → `⟳ DSH` 脉冲 → `✓ DSH`（last=SUCCESS）。

## [1.5.2] - 2026

### Fixed
- **动态形态 agy_run 触发 Host guard 拒绝**：Cordis 动态插件沙箱不暴露 `ctx.emit`（runner guard 拒绝任何访问并产生告警）。`dynamic/host.js` 此前在 `publish()` 中调用 `ctx.emit`，虽被 try/catch 包裹，仍会污染运行时状态。已改为 **no-op**：动态形态不推送事件（其浏览器灯通过 `harness.handle('agy_status')` RPC 读取快照），preset 形态（真 Node 模块）保留真实 `ctx.emit` 推送。
- 目视实测（真实 agy 调用）确认状态灯全链路：标题栏灯 就绪（灰点）→ `⟳ DSH` 工作中（品牌色脉冲）→ `✓ DSH` 成功（绿点，last=SUCCESS）。

## [1.5.1] - 2026

### Fixed
- **切换会话（对话任务）时窗口空白**：家级 `agy-indicator` 的 client 半（`lib/client.js`）在组件卸载清理中曾依赖 Cordis `ctx.interval` 的 disposer；若其形态与预期不符，卸载会抛错，导致 React 渲染树崩溃、对话窗口空白。已改为**浏览器原生 `setInterval`/`clearInterval`**（组件内零 `ctx` 引用），卸载清理必然成功；`apply` 改用产品同款 `ctx.inject(['slots'], ...)` 等待服务就绪模式。
- **家级灯与动态插件灯同 slot 撞 id**：家级 client 的 Slot id 由 `agy-indicator` 改为 **`agy-indicator-home`**，避免与动态插件形态（`dynamic/client.js`，id `agy-indicator`）同时运行时在同一 slot 冲突。

### Changed
- `home-plugin/agy-indicator/lib/client.js` 重写（对齐 dsh-model-status 成熟模式）；部署副本已同步，花名册热更新，刷新浏览器即生效。

## [1.5.0] - 2026

### Added
- **状态灯随软件启动（home-level `agy-indicator` 插件）**：状态灯不再依赖动态插件（重启即失）或 preset（无 UI），而是作为**家级插件**通过 `cordis.patch.yml` 注册（`dsh-home/plugins/agy-indicator/`，junction 到 `node_modules/agy-indicator` 与 `profiles/node_modules/agy-indicator`），随 DSH 启动自动加载、**所有会话自动显示**、无需审批。
  - host 半（`lib/index.mjs`）：`ctx.on('agy/status')` 收集各会话 agy-first-bridge 推送的快照，维护按 cwd 索引的全局项目表；经 `webServer` 注册 `GET /agy-indicator/status` 暴露 JSON；10 分钟未更新的 idle 项目自动过滤。
  - client 半（`lib/client.js`）：浏览器花名册模块（`window.__ModuleLoader__.load`），挂载 `conversation.session.header.utilities`，每 1.2s 轮询 HTTP 路由，按项目分别渲染状态灯（同 v1.4.0 样式：`⟳`/`✓`/`✗`/`↩` + 项目名）。
- **preset 形态推送状态**：`agy-first-bridge.mjs` 的 `begin`/`end`/`foldStepUpdate` 每次更新后 `ctx.emit('agy/status', { snapshot })`，供家级收集器合并。动态插件形态（沙箱无 `ctx.emit`）维持自身 client 半灯（`host.call('agy_status')`），无需家级推送。

### Notes
- `cordis.patch.yml` 通过 Cordis HMR 热重载：改 `lib/index.mjs` 后 bump `?v=N` 即生效，改 `lib/client.js` 后刷新浏览器即生效（无需重启 DSH）。

## [1.4.0] - 2026

### Added
- **UI 状态灯按项目分别显示（per-project status lights）**：状态快照按**项目（工作目录 cwd）**分组。DSH 会话标题栏渲染**每个项目一盏灯**（项目名 + 各自状态：工作中/成功/失败/回退），tooltip 显示该项目当前步骤与最近轨迹；`agy_status` 工具 / MCP 工具按项目分节返回，并支持 `cwd` 参数只查某个项目。
- 并发验证：两个 agy 任务在不同 cwd 同时运行，快照分别列出两个项目，各自的运行计数、当前步骤、轨迹与最近结果互不混淆。

### Changed
- 状态追踪由全局单例改为 per-project 表（`projects[cwd]`）+ 全局聚合（顶层字段保留，向后兼容）；项目按最近活动排序，最多保留 12 个项目。

## [1.3.0] - 2026

### Added
- **实时观察 agy 当前正在干什么（live observation）**：所有形态改用 `--output-format stream-json` 运行 agy，逐行解析 `step_update` 事件（`step_type`：tool / agent_response / user_input；`state`：ACTIVE / DONE / ERROR；`tool_name` + 参数）。
- **`agy_status` 工具**（三种形态统一）：返回实时快照 —— 运行计数、**当前正在执行的步骤**（工具名 + 参数，或 agent_response 思考/打字中）、最近步骤轨迹（执行的工具、完成/出错）、最近一次完成运行的状态与会话 id。可在 agy 运行期间随时调用，无需等待结束。
  - DSH preset（`preset/agy-first/`）与动态插件（`dynamic/host.js`）：新增模型工具 `agy_status`；状态灯（`dynamic/client.js`）tooltip 同步显示当前步骤与最近轨迹。
  - MCP 服务器（`mcp/agy-mcp-server.mjs`）：新增 `agy_status` MCP 工具，Claude Code / Codex 等宿主可随时查看 agy 在干什么。
- `agy:policy` 提示段与 `MCP-POLICY.md` 增加「可用 `agy_status` 观察进行中的 agy 运行」。

### Changed
- agy 输出格式由 `json` 改为 `stream-json`（兼容解析：末行为 `{"event":"result",...}`，容忍额外日志行）。

## [1.2.0] - 2026

### Added
- **DSH 随软件启动自动加载**：本地部署 `agent-presets.default` 已设为 `cordis-agy`（合并 preset：cordis 自改能力 + agy 优先 + MCP 桥）。新会话创建时自动挂载，无需手动选择。
- **DSH 内 MCP 补充注册**：`cordis-agy` preset 增加 `@deepseek-ai/dsh-mcp-client` 行，把同一 MCP 服务器注册为 DSH 原生工具（`mcp__agy__agy_run` / `mcp__agy__agy_continue`），`failOnStartupError: false` 保证 agy 缺失不阻塞会话启动。
- **外部软件 MCP 注册**：Claude Code（`claude mcp add -s user agy`，已 ✓ Connected）与 Codex（`~/.codex/config.toml` 的 `[mcp_servers.agy]`，已 enabled）。
- **披露并优先使用策略**：`MCP-POLICY.md`（中英双语）安装到 `~/.claude/CLAUDE.md` 与 `~/.codex/AGENTS.md`，要求外部代理优先调用 `mcp__agy__*` 做实际工作、禁止限流循环重试。
- **版本管理**：新增 `package.json`（v1.2.0，Node ≥18）；MCP 服务器自报版本升至 1.2.0；Git tag `v1.2.0` + GitHub Release。

### Changed
- MCP 服务器版本常量 `1.1.0` → `1.2.0`。
- 服务器稳定副本统一存放于 `dsh-home\bin\agy-mcp-server.mjs`（仓库删除不影响已注册的三端）。

## [1.1.0] - 2026

### Added
- **MCP 服务器**（`mcp/agy-mcp-server.mjs`）：零依赖 stdio MCP 服务器，把 `agy_run` / `agy_continue` 暴露给任何支持 MCP 的宿主（Claude Code / Codex / Cherry Studio…）。宿主代理通过 `tools/list` **自动发现**工具并**自主决定**是否调用——无需加载任何 agy-first preset。保持完全宿主控制（`--dangerously-skip-permissions`、JSON 输出、超时强杀）；限流/网络失败在结果文本中附加防循环提示（MCP 无 UI 弹窗，回退决策交给调用方）。已通过真实握手（initialize → tools/list → tools/call）与真实 `agy_run` 端到端验证。
- MCP 自检命令：`node mcp/agy-mcp-server.mjs --check`。
- 注册文档：`mcp/README.md`（Claude Code / Codex / 通用 JSON 配置、`AGY_MCP_CWD` 环境变量）。

### Fixed
- MCP 服务器在 stdin 提前关闭时不再杀死进行中的 agy 调用（等待 `pendingCalls` 归零后才退出）。

### Changed
- 本地部署：新增 `cordis-agy` 合并 preset（cordis 自改能力 + agy 优先）并设为 DSH 默认；该副本移除了 `tool-cordis` 行，避免在已运行 cordis 的进程里重复注册 inspect provider 导致挂载失败（原因与恢复方法记录在组合文件注释中）。

## [1.0.0] - 2026

首个发布版本。

### Added
- **agy 桥接工具**：`agy_run` 与 `agy_continue`，把编码/构建/调试/排查等任务派发给本机 `agy` CLI。
- **DSH 完全控制 agy**：每次调用强制 `--dangerously-skip-permissions` + `--output-format json` + `--print-timeout`；agy 全程无提示，模式/模型/effort/cwd/超时/后台/取消均由 DSH 决定。
- **agy 优先策略提示段**（`agy:policy`）：覆盖普通 / plan / accept-edits / 子代理 / workflow / ralph / goal 轮次等所有模式。
- **`mode:auto`**：读取 `planMode` 自动在 `plan` / `accept-edits` 间切换。
- **后台任务**：`background:true` 经 `jobs` 服务运行，返回 `jobId`，用 `job_output` 收结果。
- **限流 / 网络回退弹窗**：失败且疑似受限时经 `userQuestions.ask()` 弹窗，提供「使用 DSH 本地 API 配置（回退）/ 重试 / 不回退」；子代理无真人应答者时自动跳过，最多重试 2 次防循环，后台失败不弹窗。
- **实时状态灯**（动态形态）：会话标题栏 Slot 中的彩色指示灯，每 1.2s 轮询 Host `agy_status` RPC，展示 工作中 / 成功 / 失败 / 本地回退 / 就绪，颜色取自主题 token。
- **两种形态**：持久 Agent Preset（`preset/agy-first/`，随重启保留，含回退）与动态 Cordis 插件（`dynamic/`，含状态灯）。
- 文档：README、安装指南、架构、回退与状态灯说明。
- 英文文档：`README.en.md` 与 `docs/en/`（安装 / 架构 / 回退与状态灯）。
- 持续集成：`.github/workflows/ci.yml`，在 Node 18/20/22 上对所有源文件跑 `node --check`，并校验 preset YAML。
- 资源：`assets/indicator-states.svg`，展示状态灯各状态。

### Notes / Known limitations
- 状态灯仅在动态 Cordis 插件形态提供；Preset 形态为 Host 面组合，不含浏览器 UI（回退弹窗两种形态都有）。
- Preset 内的 `.mjs` 为零依赖自包含模块（用户目录无法解析 `@deepseek-ai/*`）。
- `--dangerously-skip-permissions` 意味着 agy 会无提示改文件/执行命令，请在信任的环境使用。
