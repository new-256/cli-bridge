# HANDOVER — @luchenglong/cli-bridge 交接文档

> 面向接手这个仓库/这台机器的下一个人（或下一个 Agent）。
> 目标：**不读完所有历史也能安全改动、发布、排障**。历史事故与红线集中在 §5 与 §10。
> 最近一次更新：2026-10-20（**0.2.9：第五、第六个 provider `claude` + `codex` 接入**；
> 同时把重复三处的 `PRESET_DIRS` 收敛为单一来源、把 codebuddy 的"模型清单必须实时"
> 纪律推广到两家新 provider）。此前 0.2.4 的 OpenCode 记录见 §13。

---

## 1. 这是什么

`@luchenglong/cli-bridge` 把**本机六个编码 CLI**（agy / CodeBuddy / MiMo / OpenCode /
**Claude Code** / **OpenAI Codex**）以同一套 provider 描述符接入 DSH，并有四种落地形态
（preset / 动态宿主 / 家级宿主插件+指示灯 / MCP stdio server）。
它由三个旧包（`agy-first-bridge` / `codebuddy-first-bridge` / `mimo-first-bridge`）合并而来，
旧包的工具名、预设 id、策略文案**逐字保留**（兼容承诺，见 §5）。`opencode` / `claude` / `codex`
是统一包**新增**的 provider（无旧包可迁，无兼容包袱），见 §13 与 §14。

## 2. 当前状态快照

| 项 | 值 |
| --- | --- |
| 版本 | **0.2.9**（三处版本锁：`package.json` / `mcp/cli-bridge-mcp.mjs` 的 `SERVER_VERSION` / `CHANGELOG.md` 顶部；`verify.mjs` 机器比对） |
| npm | `@luchenglong/cli-bridge@0.2.9`（`latest`；shasum `73d55ed7ca5e157a94f35cd86a109001891eceba`，98 files） |
| GitHub | `new-256/cli-bridge`，`main` @ `31f8375`；tag `v0.2.1` … `v0.2.9` |
| 旧包 | 三个都已在 npm 标 **deprecated**（提示迁移到统一包）：`agy-first-bridge@1.7.1`、`codebuddy-first-bridge@1.6.2`、`mimo-first-bridge@1.2.9` |
| 旧仓 | `new-256/agy-first-bridge`、`new-256/mimo-first-bridge`：README 顶部已加迁移横幅且 **archived（只读）**；`codebuddy-first-bridge` 在 GitHub 上不存在 |
| 测试 | **569 tests / 568 pass / 0 fail / 1 skip**（既有跳过），四闸门 `npm run check` 全绿 |
| 本机运行时 | DSH Desktop；`dsh-home/profiles/web` 以 **npm registry 标准依赖** + pnpm 快照部署（不用 `file:`）。⚠ 0.2.9 已发布但**运行时仍可能是旧版**，切版本要用户自己做 |

**已知遗留 / 未处理项**（均有意为之，非故障）：
- 家级补丁 `dsh-home\cordis.patch.yml` 里四条 MCP 行**仍是注释状态** —— 与旧版本交接文档
  §7.3 的描述不符（实测确认）。**用户明确表示此项不由本包管理**，不要擅自恢复（§7.3）。
- `docs/` 之外还有 `.snapshot-backup-before-npm-install/`（切换安装方式前的快照备份，未入库）。

## 3. 五分钟上手

```powershell
cd "C:\Users\lcl\Desktop\DSH插件开发\CLI Bridge"

npm run check                             # 四闸门：build --check / verify / node --test / mcp --check
node mcp/cli-bridge-mcp.mjs --check       # MCP 自检（含 scheduling 快照）
node scripts/build.mjs                    # 改了模板/providers 后必须重跑，生成物要进同一个 commit

# 活体探针（DSH 运行中；$env:DSH_WEB_URL 是当前 GUI 地址，端口每次启动可能变）
Invoke-WebRequest "$env:DSH_WEB_URL/cli-bridge/status"   -UseBasicParsing | Select-Object -Expand Content
Invoke-WebRequest "$env:DSH_WEB_URL/cli-bridge/settings" -UseBasicParsing | Select-Object -Expand Content
```

设置面板：DSH「设置 → CLI Bridge 桥接」→ 横向标签 `总设置 | AGY | CB | MIMO | OPENCODE`。
「总设置」= 调度（勾选启用 + `↑↓` 优先级），其余 = 各 CLI 偏好与诊断。

**改代码后如何让本机生效（必读，最容易踩）**：
本机 profile 装的是 **npm registry 上的包**，不是本地仓库！改了本地代码后必须：
1. `npm run check` 全绿 → 升版本 → commit/tag/push → `npm publish`（见 §8）；
2. 改 `dsh-home/profiles/web/package.json` 的依赖版本 → **删快照** → `pnpm install`（§7.1）；
3. **重启 DSH**（宿主半启动时加载）。浏览器半 F5 即可。
跳过第 1 步 = 本机永远跑旧包（0.2.3 时踩过：代码有 opencode，但 profile 装的是 0.2.2，
设置面板看不到 opencode —— 且两边版本号**当时都是 0.2.2**，极具迷惑性）。

## 4. 代码地图（改哪里）

| 路径 | 职责 | 谁维护 |
| --- | --- | --- |
| `providers/registry.mjs` | **唯一 id 轴** `PROVIDER_IDS = ['agy','codebuddy','mimo','opencode']`；新 provider 第一站 | keystone（Lead 单作者） |
| `providers/<id>.mjs` | 描述符：工具/policy/settings meta/mcp/diagnose/回退 | 每 provider 作者 |
| `core/bridge-kit.mjs` | 共享内核：状态引擎、runner、限流、回退弹窗、MCP payload（**零 import**） | keystone |
| `core/scheduling.mjs` | 调度单源（无 import → 可整段内联进沙箱） | keystone |
| `home-plugin/cli-bridge-indicator/lib/index.mjs` | 宿主半：状态机 + HTTP 路由 + 收集器 + 门禁 + **TTL（含 `PROJECT_DONE_TTL_MS`）** | keystone |
| `…/lib/settings.mjs` | 设置读写/掩码/旧文件迁移/`_scheduling` 区 | keystone |
| `…/lib/preset-declarations.mjs` | 声明制注册四个 preset（恒注册，顺序按优先级） | keystone |
| `…/lib/client.js` | 浏览器半：pill / 弹窗 / 设置标签页（**红线：load id ≡ 包名**） | keystone |
| `preset/<dir>/` | preset 形态（`plugin-list.mjs` 是唯一权威源 + 生成物 `*.yml`） | 生成物入库 |
| `dynamic/<id>.host.{js,template.mjs}` | 动态沙箱宿主（模板 → 生成物） | 生成物入库 |
| `mcp/cli-bridge-mcp.mjs` + `mcp/providers/<id>.mjs` | 统一 MCP server（一个 server 暴露四家） | keystone |
| `mcp/version.mjs` | **版本号单一来源**（读 package.json；读不到抛错，绝不静默回落） | keystone |
| `mcp/{agy,codebuddy,mimo}-mcp-server.mjs` | 旧包兼容入口（等价 `--provider=<id>`）。**opencode 没有**（无旧包） | keystone |
| `scripts/build.mjs` / `verify.mjs` / `deploy.mjs` | 生成 / 发布红线 / 本地暂存部署 | keystone |
| `deploy/legacy-mcp/` | **家级 `bin\` 服务器材料的权威副本**（`bin\` 不入 git） | keystone |
| `tests/keystone/` | 红线行为测试（client 面、状态机、路由、门禁、legacy MCP、TTL） | keystone |
| `tests/{agy,codebuddy,mimo,opencode}/`、`tests/core/` | 各 provider 与内核回归 | provider 作者 |

## 5. 不可动的契约（红线）

1. **client 注册 id ≡ 包名**：`lib/client.js` 的 `window.__ModuleLoader__.load({ id: "@luchenglong/cli-bridge" })`
   逐字不变。不等 → client combo 加载失败 → **整屏插件页崩溃**（agy v1.6.1 / codebuddy v1.1.8 事故）。
   `verify.mjs` + `tests/keystone/client-id.test.mjs` + `client-ui-surface.test.mjs` 三重机器锁。
2. **对外语义 verbatim**：工具名 `<id>_run/_continue/_status`、入参 schema、preset id
   （`cordis-agy` / `codebuddy-first` / `cordis-mimo`）、POLICY 文案（如 codebuddy `POLICY_TEXT` 6970B）。
   要改 = 大版本 + `docs/MIGRATION.md` 补条目。
3. **模板占位符各恰一次**：`/*__KIT__*/`、`/*__PROVIDER__*/`、`/*__SCHED__*/`；生成物
   （`dynamic/*.host.js`、`preset/*/agent.cordis.yml`、`preset.yml`）**必须入库**，`build --check` 漂移即红。
4. **单一 id 轴**：任何地方需要 id 列表都从 `providers/registry.mjs` 派生（`build.mjs`、
   `preset-declarations`、client 的 `providerMetas()` 都已改为派生）。禁止第二处硬编码 id 列表 ——
   包括**测试**：0.2.3 时 4 个 keystone 测试硬编码了三家 id，新增 provider 即红；已全部改为派生
   （`PROVIDER_IDS` / `providerMeta()`）。加第五家时这些文件应当**零改动**。
5. **零运行时依赖**，且**禁止新增 `@deepseek-ai/dsh*` peer 依赖**（`verify.mjs` + 测试双锁）。
6. **家级 `bin\` 三个服务器与 `deploy/legacy-mcp/` 副本逐字节一致**（`tests/keystone/legacy-mcp-gate.test.mjs`）。
7. **失败要响亮（开发期）**：不写静默降级/兜底；门禁只做「注册/不注册」，不改工具语义。
8. **版本号单一来源**：`mcp/version.mjs` 从 `package.json` 读一次，MCP 各面的 `meta.version`
   全部派生自它。**禁止在任何 provider 文件里硬编码版本字面量**（0.2.3 教训：8 处硬编码导致
   「server 报 0.2.3、provider 面报 0.2.2」）。测试只断言 semver 形态，不钉字面量。
9. **preset id 命名**：`cordis-` 前缀（agy/mimo）是**旧包历史遗留**，不可套用到新 provider；
   新增 provider 用 `<id>-first`（与 codebuddy-first 同构）。opencode 因此是 `opencode-first`。

## 6. 调度（0.2.0+）实现要点

用户目标：**选择启用哪些 CLI（数量）+ 排定调用优先级**，且加第 N 家 CLI 时零改动。

- **落盘**：`{DSH_HOME}/cli-bridge-settings.json` 顶层 `_scheduling = { enabled, priority }`
  （下划线前缀 = 非 provider 分区，旧代码整区忽略 → 纯增量兼容）。
- **语义**：`enabled` 是集合（数组顺序无意义）；`priority` 的**数组顺序即优先级**；
  派生 `order = priority ∩ enabled`。
- **fail-open**：文件缺失/坏值/无 fs → 全部启用（读不到 ≠ 全关）；只有**显式** `enabled: []` 是全关。
- **钉住优先**：env `CLI_BRIDGE_PROVIDER` / `--provider=<id>`（MCP 薄封装）优先级最高；
  宿主形态传 `ignorePin`，避免被全局 env 反噬。
- **四个生效面**：
  1. `preset/<id>/cli-bridge.mjs` 与 `dynamic/*.host.js` 的 `apply()` 首行门禁（禁用面零注册）；
     `preset-declarations` 的注册顺序 = 优先级顺序；
  2. 统一 MCP `selectedProviders()` 按 `enabled` 过滤、按 `order` 排序（**启动读一次**）；
  3. 家级 `bin\*-mcp-server.mjs` 经 `bin\cli-bridge-scheduling.mjs` 的 `filterTools()` **每请求现读**
     （面板改完立即生效，无需重启子进程）；mimo 的 dispatch 层单独加了拒调文本；
  4. `GET /cli-bridge/status` 与 `/cli-bridge/settings` 每次轮询现读并附 `scheduling` 快照。
- **客户端**：`providerMetas()` 以视图 `scheduling.all ∪ providers 键` 为权威 id 轴（本地 `PROVIDERS`
  降级为 fallback，仅补 presetId/展示 label）；标签页一排点击切换；`stale` 项目不再渲染常亮 pill
  （弹窗里仍保留历史）。**stale 判定见 §6.1（0.2.4 起两态 TTL）**。
- **新增 provider 自动纳入**：新 id 进 `PROVIDER_IDS` 后，`priority` 会自动补上它（漏写排末尾），
  但 `enabled` **不会**自动加 —— 若用户此前显式设过 `enabled`（如 `[codebuddy,agy]`），新 provider
  默认**不启用**，需在面板勾选。这不是 bug，是「显式列表被尊重」语义。

### 6.1 状态灯 TTL（0.2.4 起两态）

| 项目状态 | TTL | 常量 | 目的 |
| --- | --- | --- | --- |
| 运行中 / 无终态 | 10 分钟 | `PROJECT_TTL_MS` | 防抖：长任务中途不闪灯 |
| **已收口**（`running=0` 且有 `lastStatus`） | **60 秒** | `PROJECT_DONE_TTL_MS` | 跑完快速淡出 |

历史：0.2.1 用单一 10 分钟 TTL 修「一次失败后灯永久挂着」，副作用是**跑完要挂满 10 分钟才灭**，
用户感知为「灯不灭」——0.2.4 拆成两态。淡出**只影响 pill 渲染与顶层聚合**，项目仍留在列表里
（弹窗历史不丢）。详见 `tests/keystone/indicator-state.test.mjs` 末尾 4 个用例。

⚠️ `doneTtlMs` 缺省**跟随显式传入的 `projectTtlMs`**（仅生产默认值才取 60s）——否则
「传了短 TTL 却不生效」会静默坑调用方（本改动第一版就踩了这个坑，测试已锁）。

## 7. 本机运行环境接线现状（机器特定）

### 7.1 安装形态

- `dsh-home/profiles/web/package.json`：`"@luchenglong/cli-bridge": "0.2.4"`（**npm registry 标准依赖**，
  2026-10-15 起；此前是 `file:C:/Users/lcl/Desktop/DSH插件开发/CLI Bridge`），
  并在 `dsh.profile.bundles` 登记 → 包内 `cordis.patch.yml` 作为 bundle 层自动挂载
  （宿主半 + 浏览器半 + 四 preset）。
- **⚠️ 因为装的是 npm 包，本地仓库改代码不会自动生效** —— 必须先发布新版本再装（见 §3 方框）。
- **升版/重装修快照**（pnpm 按**版本**键控缓存，版本不变时可能复用旧快照 —— 必须先删再装）：
  ```powershell
  $web = "$env:APPDATA\DSH Desktop\dsh-home\profiles\web"
  $installed = "$web\node_modules\@luchenglong\cli-bridge"
  # 1) 改 $web\package.json 里的版本号  2) 删快照  3) 重装
  Remove-Item $installed -Recurse -Force
  Push-Location $web; pnpm install --prefer-offline; Pop-Location
  # 校验：版本 + 关键文件内容（例：PROVIDER_IDS 是否含新 provider）
  ```
- 校验安装是真的 registry 包（不是链接/本地目录）：
  ```powershell
  (Get-Item $installed -Force).LinkType   # 空 = 真实目录（hoisted 模式正确）
  Select-String "$web\pnpm-lock.yaml" -Pattern 'cli-bridge'   # 应见 specifier/version + integrity
  ```

### 7.2 生效时机（**最容易踩**）

| 改动 | 生效方式 |
| --- | --- |
| `lib/client.js`（浏览器半） | **刷新页面（F5）** 即生效，不用重启 |
| `lib/index.mjs`、`lib/settings.mjs`、`preset-declarations.mjs` | **必须重启 DSH**（宿主启动时加载） |
| `providers/registry.mjs`、描述符、`core/*` | 同上（宿主启动时加载）→ **必须重启 DSH** |
| 仅发布新版本但没重装/没重启 | **完全不生效**（0.2.3 踩过：面板看不到 opencode） |
| `dsh-home/cordis.patch.yml`（家级补丁/插件行） | **必须重启 DSH** |
| 家级 `bin\*-mcp-server.mjs` | 子进程重启；但调度门禁是**每请求**读盘，改设置不用重启 |
| 统一 `mcp/cli-bridge-mcp.mjs` | 子进程重启后读新配置 |

### 7.3 家级补丁（`dsh-home\cordis.patch.yml`）

**实测状态（2026-10-16 用规范 YAML 解析器确认）：活跃条目只有 4 条** ——
`session-cleaner`、`local-llm-bridge`、`bot-gateway`、`mobile-companion`。

⚠️ **四条 MCP 行目前仍是注释状态**（`mcp-agy-global` / `mcp-codebuddy-global` /
`mcp-playwright-global` / `mcp-mimo-global`，形如 `#    - id: mcp-agy-global`，
位于约 L236/L261/L363/L430/L442/L454/L486）。这与旧版交接文档「2026-10-14 已恢复」的描述
**不符** —— 实测为准。**用户明确表示此项不由本包管理，不要擅自恢复。**

⚠️ 该文件里 agy/codebuddy/playwright **各另有一份注释留档副本**（历史）。将来若真要启用，
**只能启用一份**，否则同 id 重复 → loader 致命错误。改完必须用规范 YAML 解析器验证：

```powershell
node -e "const y=require('$env:APPDATA/DSH Desktop/backend/dsh/node_modules/yaml');const d=y.parse(require('fs').readFileSync('$env:APPDATA/DSH Desktop/dsh-home/cordis.patch.yml','utf8'));const ids=[];for(const e of d)for(const k of Object.keys(e))for(const i of e[k])ids.push(i.id);console.log(d.length, ids.join(','), 'dup:', ids.filter((x,n)=>ids.indexOf(x)!==n))"
```

（这解释了为什么会话里可能看不到 `mcp__*` 前缀工具 —— 根源在家级补丁，不在本包。）

### 7.4 家级 MCP 材料

`dsh-home\bin\agy-mcp-server.mjs`、`bin\codebuddy-mcp-server.mjs`、`bin\cli-bridge-scheduling.mjs`（门禁 helper）、
`bin\mimo-mcp\{mcp\mimo-mcp-server.mjs,core\*}`、`plugins\playwright-mcp\`（含浏览器内核 `browsers\`）。
这些是**稳定副本**（仓库/包体变动不影响），但其权威源在仓库 `deploy/legacy-mcp/` + `mcp/`。

### 7.5 状态与设置

- 设置文件：`dsh-home\cli-bridge-settings.json`（当前：`enabled=[agy,codebuddy,opencode]`、
  `priority=[agy,codebuddy,opencode,mimo]` → `order=[agy,codebuddy,opencode]`，
  即 **mimo 停用**；opencode 于 2026-10-16 手动启用）。
  `opencode` 分区当前 `defaultModel=opencode/nemotron-3-ultra-free`。
- 状态路由：`GET /cli-bridge/status`（含 `scheduling`）；旧路由 `/<id>-indicator/status` 仍返回裸桶。
- **灯的实时数据看项目层**：顶层只给 `state/running/lastStatus` 聚合摘要，**`trail`（步骤）和
  `current` 在 `projects[]` 里**。查"它在做什么"要看 `projects[0].trail`（§10）。
- GUI 需要登录态；**用 HTTP 探针即可**（不要把无凭据浏览器指向 GUI，会 401）。
- MCP 形态的状态经快照文件 `{DSH_HOME}/cli-bridge-mcp-<id>.json` 跨进程上报（`buildMcpBridgePayload`
  + 原子写 tmp→rename）。**测试若把 `io.homeDir` 指向临时目录，家级灯就读不到** —— 排查"灯不亮"
  先看这个文件是否存在于 `dsh-home`。

## 8. 发布流程

见 `docs/RELEASE-SOP.md`（铁律 + 逐步命令）。要点：

1. `npm run check` 全绿 → 版本三锁同步（含 `CHANGELOG.md` 顶部）→ `node scripts/build.mjs` → commit → tag → push；
2. **scoped 包可见性权威开关是 `package.json` 的 `publishConfig.access="public"`**
   （0.2.2 首发踩坑：只靠命令行 `--access public` 时，走 GUI/插件通道发布不带该参数 → `E402 Payment Required`）；
3. 发布后可 `npm deprecate <old>@* "<msg>"` 迁移旧包；**先发布后弃用，顺序不可倒置**；
4. npm 首次创建 scoped 包返回 `PUT 202 Accepted`（"may take a few minutes"）**属正常，勿重复发布**。

本机发布通道：DSH 工具 `repo_push_access`（GUI 插件 “repo-push-access”，凭据存 DSH 凭据库）。
推 git 用插件很稳；**发 npm 建议用命令行** `npm publish --access public`（插件通道曾报
`published:true` 但实际未生效，也曾报 `fetch failed`）。

### 8.1 npm 登录态（本机特有的坑）

命令行侧**默认没有** npm 登录态，且本机 npm 读的 userconfig **不是** `C:\Users\lcl\.npmrc` ——
环境变量 `userconfig` 被 DSH 指向
`C:\Users\lcl\AppData\Roaming\DSH Desktop\backend\.npmrc`。把 token 写错地方会白忙。

```powershell
# 从凭据库取 token 写进【npm 实际读取的那份】npmrc，再验证
$cred = "$env:APPDATA\DSH Desktop\dsh-home\.credentials.yaml"
$txt  = Get-Content $cred -Raw
$m    = [regex]::Match($txt, 'repo-push-access/registry-npmjs-org:(.*?)(?=\n\S|\z)', 16)
$tok  = [regex]::Match($m.Groups[1].Value, 'token:\s*["'']?([A-Za-z0-9_\-\.]+)["'']?').Groups[1].Value
$t    = "C:\Users\lcl\AppData\Roaming\DSH Desktop\backend\.npmrc"
Set-Content $t -Value (@(Get-Content $t | Where-Object { $_ -notmatch '_authToken' }) + "//registry.npmjs.org/:_authToken=$tok") -Encoding utf8
npm whoami          # 应输出 luchenglong
```

⚠️ 若 `.npmrc` 里有**两条** `_authToken`（历史遗留），写之前先去重，只留一条。
⚠️ `npm publish` 报 `You cannot publish over the previously published versions: X` = **该版本其实
已经发布成功了**（插件通道误报 + CDN 延迟导致你以为失败）。去 registry 核对 shasum，
**切勿重复发布**。

## 9. 凭据与安全

- 凭据库：`dsh-home\.credentials.yaml`。**键必须形如 `<scope>/<id>`**
  （如 `repo-push-access/github-com`、`repo-push-access/registry-npmjs-org`）——
  曾因键写成 `repo-push-access:github.com` 导致凭据文档整体不可读 → DSH 启动致命错 + profile 被隔离为
  `profiles.broken-*`。
- 命令行侧**没有** npm/GitHub 登录态；需要 CLI 操作时从凭据库取用，**不要把 token 打进日志/翻译稿**。
- 仓库内不得出现任何 token；`.credentials.yaml` 及其备份不入库。

## 10. 排障手册（症状 → 原因 → 处置）

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| 设置面板白屏 / 整个插件页崩 | client.js 引用了未声明标识符，或 load id ≠ 包名 | 跑 `tests/keystone/client-ui-surface.test.mjs`（含标识符扫描）与 `client-id.test.mjs` |
| 面板没有横向标签 / 没有调度卡 | 浏览器仍在用旧 client.js | F5 刷新；核对 `GET /cli-bridge/settings` 是否含 `scheduling`（不含=宿主也是旧代码 → 重启） |
| 面板改了启用/优先级但没生效 | ①POST 未成功 ②宿主形态需重启会话 ③统一 MCP 子进程需重启 | 看 `cli-bridge-settings.json` 是否写入 `_scheduling`；家级 `bin\` 服务器无需重启（每请求读盘） |
| **本地改了代码，但设置面板没变化** | 本机 profile 装的是 **npm 包**，不是本地仓库 | 发布新版本 → 改 profile 依赖版本 → 删快照重装 → 重启 DSH（§3 方框、§7.1） |
| 面板缺某个 provider 的标签页 | ①装的 npm 包版本太旧（发布时还没该 provider）②该 provider 未启用 ③宿主未重启 | 核对快照 `PROVIDER_IDS`；`GET /cli-bridge/status` 看 `scheduling.all`；重启 DSH |
| 指示灯长期亮着 | 陈旧项目驱动了顶层聚合 | 查 `projects[].stale` 与两个 TTL（§6.1）；0.2.4 起已完成项目 60s 淡出 |
| **跑完任务灯不灭** | 0.2.3 及更早：单一 10 分钟 TTL | 升到 0.2.4+（已完成项目 60 秒淡出，§6.1） |
| 想看"它正在做什么"但 `current`/`trail` 是空 | **顶层不含 trail**，步骤在 `projects[]` 里 | 看 `projects[0].trail` / `projects[0].current` |
| opencode 运行中 `current` 恒为 null | opencode 只在工具【完成时】发事件，无"进行中"事件 | 非缺陷；看 `trail` 的历史步骤即可 |
| MCP 调用后灯完全不亮 | 测试/调用把 `io.homeDir` 指向了临时目录 | 快照必须写到 `dsh-home`；检查 `cli-bridge-mcp-<id>.json`（§7.5） |
| `pnpm install` 后还是旧代码 | 依赖按版本键控缓存（版本没变就复用） | 先 `Remove-Item` 快照目录再 `pnpm install --prefer-offline`，然后哈希比对 |
| `ERR_PNPM_NO_MATCHING_VERSION` | registry CDN 还没同步刚发布的版本 | 等 1–2 分钟重试；**期间先把依赖回滚到上一个可用版本**，别让运行时空着 |
| npm 发布 `E402 Payment Required` | scoped 包按私有发布 | `package.json` 加 `publishConfig.access="public"` |
| npm 发布 `ENEEDAUTH` 但凭据库有 token | token 写到了 `C:\Users\lcl\.npmrc`，而 npm 实际读 backend 那份 | 按 §8.1 写对位置；`.npmrc` 有重复 `_authToken` 先去重 |
| npm 发布后 `npm view` 404 | 首次创建 scoped 包在 processing / CDN 负缓存 | 看 npm 日志 `…\.npm-cache\_logs\*` 的 `PUT 202`；等几分钟，别重复发 |
| `You cannot publish over the previously published versions` | 该版本**已经发布成功**了 | 去 registry 核对 shasum，不要重复发 |
| npm 自检报版本与 server 不一致 | 某处硬编码了版本字面量 | 都应派生自 `mcp/version.mjs`（红线 §5.8） |
| 家级补丁报 `Sequence item without - indicator` | 解除注释时把**段落注释**也剥了（前导 `#` 被误删） | 从 `*.bak-*` 还原，按**条目行区间**精确剥离；用 §7.3 的 YAML 校验命令 |
| 会话里没有 `mcp__*` 工具 | 家级补丁四条 MCP 行被注释（**当前实测即如此**） / 未重启 / 子进程未起 | §7.3：该项不由本包管理，勿擅自恢复；本包能力走统一 MCP server |
| 出现 `profiles.broken-*` | 启动期插件激活失败被桌面壳隔离 | 看 `dsh-home\logs\startup-*.log` 定位首个 error；历史根因是凭据键格式 |

## 11. 待办与已知遗留

1. **家级补丁四条 MCP 行仍是注释状态**（§7.3）—— 用户明确表示**不由本包管理**，不要擅自恢复。
   因此会话里可能没有 `mcp__*` 前缀工具；本包能力走**统一 MCP server**，不受影响。
2. 可选：`repo-push-access` 插件写临时 npmrc 时带的 `always-auth=true` 触发 npm 11 弃用警告
   （源码在 `C:\Users\lcl\Desktop\DSH插件开发\git推送管理\repo-push-access`）；删掉该行即可静音。
3. 可选：V1/V2 opencode 并存问题 —— 本机**只应保留 V2 桌面版**（详见 §13.1）。若发现 PATH 里出现
   另一个 `opencode`，说明又误装了 V1，卸载它（V1/V2 **不能并存**，官方明确）。
4. 可选：`dsh-home\profiles.broken-*` 是历史隔离物（用户数据，未清理）。
5. 可选：`.snapshot-backup-before-npm-install/`（切换安装方式前的快照备份）确认无用后可删。

## 12. 事故史速查（后来者避坑）

- **client 注册 id 必须等于包名**：旧包曾因 id 不匹配导致整屏崩溃 → 现在三重机器锁。
- **一次 edit 失败没复查**：渲染引用了未定义的 handler → 白屏，`node --check` 查不出 →
  新增「渲染引用标识符必须已声明」静态测试。
- **React hook 顺序**：tab 的 `useState` 曾放在 `if (!view) return` 之后 → view 加载瞬间 hook 数量变化 → 崩面板；
  现在有「hook 必须在早期 return 之前」的静态锁。
- **profile 隔离会吞掉用户层补丁**：`profiles/web/cordis.patch.yml` 曾随隔离重建丢失 →
  机器级配置一律写 `dsh-home\cordis.patch.yml`（家级，不受隔离影响）。
- **双源挂载**：家级 `file://` 行与 bundle 层同时声明同一 id → `multiple active Loader sources` 致命错误；
  统一包只走 bundle 层，家级只保留注释留档。
- **MCP 反复丢失**：家级 MCP 行曾在隔离重建中消失且被当基线固化；恢复时误留成注释。
  旧版交接文档称"已恢复为活跃行"，但 2026-10-16 实测**仍是注释** → 文档描述不可全信，
  以 YAML 解析器实测为准（§7.3）。
- **改了代码却以为会生效**：本机装 npm 包而非本地目录，且 0.2.3 时两边版本号**都是 0.2.2**
  → 极具迷惑性。现在 §3 方框写明"发布→重装→重启"三步。
- **版本号多处硬编码**：8 处版本字面量 → 0.2.3 出现"server 报 0.2.3、provider 面报 0.2.2"。
  已收敛到 `mcp/version.mjs` 单一来源（红线 §5.8）。
- **测试里硬编码 id 列表**：4 个 keystone 测试钉死三家 id，新增 provider 即红 → 违反单一 id 轴。
  已全部改为从 `PROVIDER_IDS` 派生（红线 §5.4）。
- **预设契约随 DSH 版本漂移**（2026-10-18）：预设从**旧版上游模板**转录，继承了上游已删除的写法 →
  ① persona `suffix` 里的 `{{cwd}}` 不再是注册变量（DSH 只注册 `provider`/`model`），
  组装期直接 throw，**整个预设不可用**；② `dsh-tool-subagent` 0.2.1 起 `persona`/`toolFilter`
  在 `apply()` 里显式 throw、`backgroundMode` 被静默**忽略**（注意：不是"被 schema 丢弃" ——
  实测实装 schema 会**放行并保留**该键，只是无人读取；所以运行时不报错，只能靠静态闸门拦）。
  已修 + 立三层闸门（`tests/keystone/persona-prompt-vars.test.mjs`）。
  **完整方案与取证：`docs/audits/2026-10-18-preset-0.2.1-contract-fix.md`**（索引 `docs/audits/README.md`）。
  教训：上游预设模板是**会过期**的参考物，升级 DSH 后必须重新对照已实装包的
  `presets/*.patch.yml` 与 `lib/index.js` 的 schema，不能沿用旧转录。

## 13. OpenCode provider（0.2.3 新增）

统一包首个**新增** provider（前三个由旧包合并而来，无此兼容包袱）：
描述符 `providers/opencode.mjs`、preset `opencode-first`、动态宿主、MCP 面 —— 四形态齐全。
工具面 `opencode_run` / `opencode_continue` / `opencode_status` + **`opencode_models`**。

### 13.1 本机 OpenCode 事实（重要，别搞错版本）

- 装的是 **V2 桌面版**：`C:\Users\lcl\AppData\Roaming\ai.opencode.desktop\cli\2.0.29-x64\opencode-cli.exe`
  （203 MB）。**二进制名是 `opencode-cli.exe`，不是 `opencode.exe`**。
- **凭据已登录**（OpenCode Console / Personal），`opencode auth list` 可见。
- ⚠️ **V1（`opencode-ai` npm 包）与 V2（`@opencode/cli` 或桌面版）不能并存安装**，且都叫 `opencode`。
  曾误装 V1 污染 PATH（导致误判"0 credentials"），已卸载并清理 npm shim。**不要再装 V1。**
- exe 解析优先级：`OPENCODE_BIN`/`OPENCODE_CLI` env > 桌面版已知路径（版本目录按 semver 降序）
  > PATH 查找 `opencode-cli`。不做 `opencode.exe` 兜底（会误命中另一个版本）。

### 13.2 CLI 接口事实（实测 v2.0.29，勿照抄 V1 文档）

- 非交互 = `opencode run "<prompt>"`，prompt 是**位置参数**。
  ⚠️ `run` 子命令**没有 `--prompt`**；`-p` 是 `--password`（basic auth），**不是 prompt**。
- `--format json` → **NDJSON**（每行一个事件）。
- `--auto` = 自动批准未显式拒绝的权限（不加会卡在权限提示直到超时）。默认开启，可 `autoApprove:false` 关闭。
- 会话：`--session <id>` / `--continue`。**没有 `opencode continue` 子命令**。
- 模型：`--model provider/model`（V2 支持 `#variant` 后缀）。
- ⚠️ **V2 无 `--variant`**（并入 `--model`）、**无 `--dir`**（cwd 靠 spawn 工作目录）。
- 退出码才是成败判据：**0 成功 / 1 失败 / 130 SIGINT**。
- 事件 type 全集：`step_start` / `text` / `reasoning` / `tool_use` / `step_finish` / `error`。
  ⚠️ **不存在 `result`/`complete`/`init` 事件**。
- ⚠️ 文本在 **`part.text`**；统计（`cost`/`tokens`）在 **`step_finish.part`** —— 两者是**不同**事件
  （第一版实现因此产出"成功但正文为空"，见 `tests/opencode/descriptor.test.mjs`）。

### 13.3 免费模型优先

`opencode_models` 列出可用模型（本机 46 个 / 11–13 个免费），**免费模型（`-free` 后缀）排在最前**，
支持 `freeOnly` / `provider` 过滤。CLI 缺失或未登录时明确返回 `ok:false`，**绝不伪造列表**。
实测可用：`opencode/big-pickle`、`opencode/nemotron-3-ultra-free`。
`glm-5.3-flash` 实测报错（不是所有模型都能用）。
设置面板「默认模型」下拉实时调 `opencode models` 填充（约 130ms）。

### 13.4 ⚠️ 调用时必须显式传 cwd

- **显式传 `cwd` 参数最可靠**。依赖 `OPENCODE_MCP_CWD` 容易在宿主形态间不一致。
- **opencode 会谎报成功**：实测它回过 "Verification passed" 但文件其实不在预期位置（落在了进程 cwd）。
  **别信它的自述，落地产物要自己验证**（`existsSync` + 实际执行）。
- 非 TTY 时 opencode 必读 stdin → 宿主用 `stdio:['ignore',…]`，不会挂起。

---

## 14. Claude Code / OpenAI Codex provider（0.2.9 新增）

两家都是**在真机上探测**后实现的，不要凭直觉改 argv —— 有一条错就会被 CLI 直接拒（`unexpected argument`）。
完整实测事实见 `PROVIDER-CONTRACT.md` §10，这里只记要点与坑。

### 文件与命名
- `providers/claude.mjs`(508) + `claude-exe.mjs`(112) / `claude-models.mjs`(334) / `claude-policy.mjs`(37)
- `providers/codex.mjs`(544) + `codex-cli.mjs`(471) / `codex-models.mjs`(107)
- preset `preset/{claude,codex}-first/`；dynamic `dynamic/{claude,codex}.host.template.mjs`；MCP `mcp/providers/{claude,codex}.mjs`
- 工具：`claude_run/_continue/_status/_models`、`codex_run/_continue/_status/_models`

### 关键差异（与 agy/codebuddy/mimo/opencode 比）
| 维度 | claude | codex |
| --- | --- | --- |
| 非交互 | `-p --output-format stream-json --verbose` | `exec --json` |
| sessionId | `result.session_id` | `thread.started.thread_id` |
| 续聊 | `--resume <id>` / `-c` | `exec resume <id>` / `--last` |
| 成功判定 | **`is_error===false && exit===0`**（subtype 不可靠！） | exit 0 + `turn.completed` + 无顶层 error |
| 模型清单 | 无效模型触发 400 报文 | `GET {base_url}/models`（live） |

### 三个必须知道的坑
1. **claude 的成功判定不能看 subtype**：无效模型时 `is_error=true` 但 `subtype` 仍是 `"success"`、
   退出码可能是 0 也可能是 1。只看 subtype 或只看 exit code 都会把失败当成功。
2. **`codex exec` 不吃根命令的旗**：`-a/--ask-for-approval` 只属于 `codex`，`codex exec` 会报
   unexpected argument；审批走 `-c approval_policy="…"`。同理 `exec resume` 没有 `-C/-s/-o/--add-dir`。
3. **`item.completed` 的 `item.type==="error"` 是告警不是致命错**（`resume --last` 会带一条
   「此模型与原会话不同」）。把它当致命错会让正常续聊全判失败。

### 配置/凭据（本机实际布局，都不是官方直连）
- claude 走了 **DeepSeek 的 Anthropic 兼容端点**：`~/.claude/settings.json` 的 env 块里
  `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` + `ANTHROPIC_AUTH_TOKEN` +
  `ANTHROPIC_DEFAULT_*_MODEL=deepseek-v4-pro[1M]`。所以实测可用模型是 `deepseek-flash,
  deepseek-v4-pro`，**不是** Claude 官方模型名。
- codex 走了 **OpenRouter**：`~/.codex/config.toml` 里 `model_provider="custom"`、
  `base_url=https://openrouter.ai/api/v1`、`experimental_bearer_token`。实时 `/models` 返回 469 项。
- 因此两家的"可用模型"完全取决于用户配的端点，**不能硬编码模型名**；只能实时问端点。

### 手动验收脚本（会真联网/真花钱，故不进 `node --test`）
```
node tests/e2e/lead-live-smoke.mjs     # 走描述符的 buildArgv→真 CLI→parseJson→buildResult 全链路
node tests/codex/helpers/live-cli-smoke.mjs
node tests/claude/helpers/verify-real-cli.mjs
```

---

### 交接最小检查单

- [ ] `npm run check` 全绿（569 测试）
- [ ] `node mcp/cli-bridge-mcp.mjs --check` 显示 `scheduling.source` 且版本与 package.json 一致
- [ ] `GET $env:DSH_WEB_URL/cli-bridge/status` 返回**六家** + `scheduling`
- [ ] 设置面板有 `总设置 | AGY | CB | MIMO | OPENCODE | CLAUDE | CODEX` 七类卡片；
      各卡片的「默认模型」下拉显示的是**实时**清单（空的话说明该家没登录，见 §10）
- [ ] 起一个 opencode 任务：灯亮 → 完成后 **60 秒内灭**（§6.1）
- [ ] 知道红线在 §5、生效时机在 §7.2、排障在 §10、OpenCode 在 §13、claude/codex 在 §14
- [ ] **`PRESET_DIRS` 只在 `providers/registry.mjs` 一处** —— 加 provider 别再在
      `build.mjs` / `preset-declarations.mjs` / `verify.mjs` 里各写一份（0.2.9 收敛的坑）
