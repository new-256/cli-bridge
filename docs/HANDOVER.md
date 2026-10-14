# HANDOVER — @luchenglong/cli-bridge 交接文档

> 面向接手这个仓库/这台机器的下一个人（或下一个 Agent）。
> 目标：**不读完所有历史也能安全改动、发布、排障**。历史事故与红线集中在 §5 与 §10。
> 最近一次更新：2026-10-15（0.2.2 首发 npm + 旧包 deprecated + 旧仓归档之后）。

---

## 1. 这是什么

`@luchenglong/cli-bridge` 把**本机三个编码 CLI**（agy / CodeBuddy / MiMo）以同一套 provider
描述符接入 DSH，并有四种落地形态（preset / 动态宿主 / 家级宿主插件+指示灯 / MCP stdio server）。
它由三个旧包（`agy-first-bridge` / `codebuddy-first-bridge` / `mimo-first-bridge`）合并而来，
旧包的工具名、预设 id、策略文案**逐字保留**（兼容承诺，见 §5）。

## 2. 当前状态快照

| 项 | 值 |
| --- | --- |
| 版本 | **0.2.2**（三处版本锁：`package.json` / `mcp/cli-bridge-mcp.mjs` 的 `SERVER_VERSION` / `CHANGELOG.md` 顶部；`verify.mjs` 机器比对） |
| npm | `@luchenglong/cli-bridge@0.2.2`（`latest`；2026-10-14 首次发布，shasum `362d506e0b85dd7014bb8b3fc1100bf3a6d0d1d5`，58 files / 320.1 kB） |
| GitHub | `new-256/cli-bridge`，`main` @ `520194c`；tag `v0.1.0` / `v0.2.1` / `v0.2.2` |
| 旧包 | 三个都已在 npm 标 **deprecated**（提示迁移到统一包）：`agy-first-bridge@1.7.1`、`codebuddy-first-bridge@1.6.2`、`mimo-first-bridge@1.2.9` |
| 旧仓 | `new-256/agy-first-bridge`、`new-256/mimo-first-bridge`：README 顶部已加迁移横幅且 **archived（只读）**；`codebuddy-first-bridge` 在 GitHub 上不存在 |
| 测试 | **271 pass / 0 fail**（28 个 `*.test.mjs`），四闸门 `npm run check` 全绿 |
| 本机运行时 | DSH Desktop，宿主 **2026-10-14 22:35 重启后加载 0.2.2**；`dsh-home/profiles/web` 以 `file:` 依赖 + pnpm 快照部署 |

**交接时点唯一未完成项**：家级补丁里四条 MCP 行刚被恢复，**需重启 DSH 才生效**（§7.3、§11）。

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

设置面板：DSH「设置 → CLI Bridge 桥接」→ 横向标签 `总设置 | AGY | CB | MIMO`。
「总设置」= 调度（勾选启用 + `↑↓` 优先级），其余 = 各 CLI 偏好与诊断。

## 4. 代码地图（改哪里）

| 路径 | 职责 | 谁维护 |
| --- | --- | --- |
| `providers/registry.mjs` | **唯一 id 轴** `PROVIDER_IDS`；新 provider 第一站 | keystone（Lead 单作者） |
| `providers/<id>.mjs` | 描述符：工具/policy/settings meta/mcp/diagnose/回退 | 每 provider 作者 |
| `core/bridge-kit.mjs` | 共享内核：状态引擎、runner、限流、回退弹窗、MCP payload（**零 import**） | keystone |
| `core/scheduling.mjs` | 调度单源（无 import → 可整段内联进沙箱） | keystone |
| `home-plugin/cli-bridge-indicator/lib/index.mjs` | 宿主半：状态机 + HTTP 路由 + 收集器 + 门禁 | keystone |
| `…/lib/settings.mjs` | 设置读写/掩码/旧文件迁移/`_scheduling` 区 | keystone |
| `…/lib/preset-declarations.mjs` | 声明制注册三个 preset（恒注册，顺序按优先级） | keystone |
| `…/lib/client.js` | 浏览器半：pill / 弹窗 / 设置标签页（**红线：load id ≡ 包名**） | keystone |
| `preset/<dir>/` | preset 形态（`plugin-list.mjs` 是唯一权威源 + 生成物 `*.yml`） | 生成物入库 |
| `dynamic/<id>.host.{js,template.mjs}` | 动态沙箱宿主（模板 → 生成物） | 生成物入库 |
| `mcp/cli-bridge-mcp.mjs` + `mcp/providers/<id>.mjs` | 统一 MCP server（一个 server 暴露三家） | keystone |
| `mcp/{agy,codebuddy,mimo}-mcp-server.mjs` | 旧包兼容入口（等价 `--provider=<id>`） | keystone |
| `scripts/build.mjs` / `verify.mjs` / `deploy.mjs` | 生成 / 发布红线 / 本地暂存部署 | keystone |
| `deploy/legacy-mcp/` | **家级 `bin\` 服务器材料的权威副本**（`bin\` 不入 git） | keystone |
| `tests/keystone/` | 红线行为测试（client 面、状态机、路由、门禁、legacy MCP） | keystone |
| `tests/{agy,codebuddy,mimo}/`、`tests/core/` | 各 provider 与内核回归 | provider 作者 |

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
   `preset-declarations`、client 的 `providerMetas()` 都已改为派生）。禁止第二处硬编码三家 id。
5. **零运行时依赖**，且**禁止新增 `@deepseek-ai/dsh*` peer 依赖**（`verify.mjs` + 测试双锁）。
6. **家级 `bin\` 三个服务器与 `deploy/legacy-mcp/` 副本逐字节一致**（`tests/keystone/legacy-mcp-gate.test.mjs`）。
7. **失败要响亮（开发期）**：不写静默降级/兜底；门禁只做「注册/不注册」，不改工具语义。

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
  降级为 fallback，仅补 presetId/展示 label）；标签页一排点击切换；`stale` 项目（>10 分钟无活动）
  不再渲染常亮 pill（弹窗里仍保留历史）。

## 7. 本机运行环境接线现状（机器特定）

### 7.1 安装形态

- `dsh-home/profiles/web/package.json`：`"@luchenglong/cli-bridge": "file:C:/Users/lcl/Desktop/DSH插件开发/CLI Bridge"`，
  并在 `dsh.profile.bundles` 登记 → 包内 `cordis.patch.yml` 作为 bundle 层自动挂载（宿主半 + 浏览器半 + 三 preset）。
- **改完必须刷新快照**（pnpm 对 `file:` 依赖按**版本**键控缓存）：
  ```powershell
  $installed = "$env:APPDATA\DSH Desktop\dsh-home\profiles\web\node_modules\@luchenglong\cli-bridge"
  Remove-Item $installed -Recurse -Force
  Push-Location "$env:APPDATA\DSH Desktop\dsh-home\profiles\web"; pnpm install --prefer-offline; Pop-Location
  # 校验：Get-FileHash 对比仓库与快照同名文件
  ```

### 7.2 生效时机（**最容易踩**）

| 改动 | 生效方式 |
| --- | --- |
| `lib/client.js`（浏览器半） | **刷新页面（F5）** 即生效，不用重启 |
| `lib/index.mjs`、`lib/settings.mjs`、`preset-declarations.mjs` | **必须重启 DSH**（宿主启动时加载） |
| `dsh-home/cordis.patch.yml`（家级补丁/插件行） | **必须重启 DSH** |
| 家级 `bin\*-mcp-server.mjs` | 子进程重启；但调度门禁是**每请求**读盘，改设置不用重启 |
| 统一 `mcp/cli-bridge-mcp.mjs` | 子进程重启后读新配置 |

### 7.3 家级补丁（`dsh-home\cordis.patch.yml`）

活跃 8 条：`session-cleaner`、`local-llm-bridge`、`bot-gateway`、`mobile-companion`，
以及 **四条 MCP 行**：`mcp-agy-global` / `mcp-codebuddy-global` / `mcp-playwright-global` / `mcp-mimo-global`
（2026-10-14 从注释状态恢复；备份 `cordis.patch.yml.bak-before-mcp-restore-20261014-234959`）。

⚠️ 该文件里 agy/codebuddy/playwright **各另有一份注释留档副本**（历史）。启用时**只能启用一份**，
否则同 id 重复 → loader 致命错误。改完必须用规范 YAML 解析器验证：

```powershell
node -e "const y=require('$env:APPDATA/DSH Desktop/backend/dsh/node_modules/yaml');const d=y.parse(require('fs').readFileSync('$env:APPDATA/DSH Desktop/dsh-home/cordis.patch.yml','utf8'));const ids=[];for(const e of d)for(const k of Object.keys(e))for(const i of e[k])ids.push(i.id);console.log(d.length, ids.join(','), 'dup:', ids.filter((x,n)=>ids.indexOf(x)!==n))"
```

### 7.4 家级 MCP 材料

`dsh-home\bin\agy-mcp-server.mjs`、`bin\codebuddy-mcp-server.mjs`、`bin\cli-bridge-scheduling.mjs`（门禁 helper）、
`bin\mimo-mcp\{mcp\mimo-mcp-server.mjs,core\*}`、`plugins\playwright-mcp\`（含浏览器内核 `browsers\`）。
这些是**稳定副本**（仓库/包体变动不影响），但其权威源在仓库 `deploy/legacy-mcp/` + `mcp/`。

### 7.5 状态与设置

- 设置文件：`dsh-home\cli-bridge-settings.json`（交接时：`enabled=[codebuddy,agy]`、
  `priority=[agy,codebuddy,mimo]` → `order=[agy,codebuddy]`，即 **mimo 停用、agy 优先级最高**）。
- 状态路由：`GET /cli-bridge/status`（含 `scheduling`）；旧路由 `/<id>-indicator/status` 仍返回裸桶。
- GUI 需要登录态；**用 HTTP 探针即可**（不要把无凭据浏览器指向 GUI，会 401）。

## 8. 发布流程

见 `docs/RELEASE-SOP.md`（铁律 + 逐步命令）。要点：

1. `npm run check` 全绿 → 版本三锁同步（含 `CHANGELOG.md` 顶部）→ `node scripts/build.mjs` → commit → tag → push；
2. **scoped 包可见性权威开关是 `package.json` 的 `publishConfig.access="public"`**
   （0.2.2 首发踩坑：只靠命令行 `--access public` 时，走 GUI/插件通道发布不带该参数 → `E402 Payment Required`）；
3. 发布后可 `npm deprecate <old>@* "<msg>"` 迁移旧包；**先发布后弃用，顺序不可倒置**；
4. npm 首次创建 scoped 包返回 `PUT 202 Accepted`（"may take a few minutes"）**属正常，勿重复发布**。

本机发布通道：DSH 工具 `repo_push_access`（GUI 插件 “repo-push-access”，凭据存 DSH 凭据库）。

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
| 指示灯长期亮着 | 陈旧项目（>10 分钟无活动）驱动了顶层聚合 | 0.2.1 已修（客户端过滤 + 服务端聚合只看新鲜项目）；复发查 `projects[].stale` 与 `PROJECT_TTL_MS` |
| `pnpm install` 后还是旧代码 | `file:` 依赖按版本键控缓存 | 先 `Remove-Item` 快照目录再 `pnpm install --prefer-offline`，然后哈希比对 |
| npm 发布 `E402 Payment Required` | scoped 包按私有发布 | `package.json` 加 `publishConfig.access="public"` |
| npm 发布后 `npm view` 404 | 首次创建 scoped 包在 processing / CDN 负缓存 | 看 npm 日志 `…\.npm-cache\_logs\*` 的 `PUT 202`；等几分钟，别重复发 |
| 家级补丁报 `Sequence item without - indicator` | 解除注释时把**段落注释**也剥了（前导 `#` 被误删） | 从 `*.bak-*` 还原，按**条目行区间**精确剥离；用 §7.3 的 YAML 校验命令 |
| 会话里没有 `mcp__*` 工具 | 家级补丁四条 MCP 行被注释 / 未重启 / 子进程未起 | 检查补丁活跃 id、重启 DSH、`Get-CimInstance Win32_Process` 找 node 子进程 |
| 出现 `profiles.broken-*` | 启动期插件激活失败被桌面壳隔离 | 看 `dsh-home\logs\startup-*.log` 定位首个 error；历史根因是凭据键格式 |

## 11. 待办与已知遗留

1. **重启 DSH** —— 恢复的四条 MCP 行需要重启才注册（交接时点刚改完配置，尚未重启）。
   重启后：新会话出现 `mcp__agy__*`（4 个，含 quota）、`mcp__codebuddy__*`（3）、`mcp__playwright__*`；
   `mcp__mimo__*` 因调度停用而**工具面为空**（这是设计行为，不是故障）。
2. 可选：`repo-push-access` 插件写临时 npmrc 时带的 `always-auth=true` 触发 npm 11 弃用警告
   （源码在 `C:\Users\lcl\Desktop\DSH插件开发\git推送管理\repo-push-access`）；删掉该行即可静音。
3. 可选：npm 上的 0.2.2 比仓库少 2 个**纯文档** commit（发布后的 release notes/SOP 补充）；
   如需 npm 侧完全一致，可发 0.2.3（无功能改动）。
4. `dsh-home\profiles.broken-*` 是历史隔离物（用户数据，未清理）。

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
- **MCP 反复丢失**：家级三条 MCP 行曾在隔离重建中消失且被当基线固化；恢复时误留成注释 →
  本次已恢复为活跃行（§7.3）。

---

### 交接最小检查单

- [ ] `npm run check` 全绿（271 测试）
- [ ] `node mcp/cli-bridge-mcp.mjs --check` 显示 `scheduling.source`
- [ ] `GET $env:DSH_WEB_URL/cli-bridge/status` 返回三家 + `scheduling`
- [ ] 重启 DSH 后确认四条 MCP 工具面（含 mimo 为空）
- [ ] 设置面板能勾选/排序/保存，且 `cli-bridge-settings.json` 落盘
- [ ] 知道红线在 §5、生效时机在 §7.2、排障在 §10
