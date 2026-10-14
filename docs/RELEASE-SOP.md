# 发布与维护 SOP（npm + GitHub）

> 本包发布与日常维护的操作手册。每一步的「为什么」都指向旧包 lineage 里的历史事故
> （agy v1.6.1、codebuddy v1.1.8/v1.7.1、mimo v1.2.9），不要跳步。

## 0. 铁律（违反任何一条都不要发布）

1. **scoped 包可见性 = `package.json` 的 `publishConfig.access = "public"`**：包是
   `@luchenglong` scope，scoped 包默认 restricted。**权威开关必须写在 package.json 里**
   （0.2.2 首发踩坑：SOP 只要求命令行 `--access public`，但走 GUI/插件通道发布时不带该
   参数 → npm 按私有包处理 → `E402 Payment Required`）。命令行仍建议显式带
   `--access public` 双保险，漏了也不会再翻车。
2. **client 注册 id === 包名**（`@luchenglong/cli-bridge`，红线 4）。`scripts/verify.mjs`
   与 `tests/keystone/client-id.test.mjs` 双重机器闸门。改包名必须同改 client.js 的
   `__ModuleLoader__.load({ id })`，否则 client combo 加载失败 → DSH 启动致命屏（agy
   v1.6.1 / codebuddy v1.1.8 事故原样）。
3. **先 git 后 npm**：commit → tag → push → GitHub Release → `npm publish` 顺序不可倒置。
   发布前 `npm run check` 全绿（build --check 防生成物漂移 + verify 红线 + node --test +
   mcp --check）。
4. **生成物入库**：`dynamic/*.host.js`、`preset/*/agent.cordis.yml`、`preset.yml` 提交；
   `scripts/build.mjs --check` 漂移即红。改了 plugin-list/模板/kit/providers 必须重跑
   `node scripts/build.mjs` 并把生成物放进同一个 commit。
5. **provider 语义 verbatim**：工具名、入参 schema、preset id、POLICY 文案是对外的兼容
   承诺（旧会话头/提示词在用）。要改 = 大版本 + MIGRATION.md 补条目。
6. **禁止新增运行时依赖与 `@deepseek-ai/dsh*` peer 依赖**（verify/测试双锁；加 dsh peer
   会武装 0.2.x 兼容闸门，历史论证）。

## 1. 标准发布流程

```powershell
# ① 全量校验
npm run check

# ② 版本同步三处：package.json / CHANGELOG.md 顶部 / mcp/cli-bridge-mcp.mjs 的
#    SERVER_VERSION（verify.mjs 机器比对，漏改即红）

# ③ 提交 + tag + 推送
git add <相关文件>; git commit -m "chore(release): v0.1.1"
git tag -a v0.1.1 -m "v0.1.1"
git push origin main; git push origin v0.1.1

# ④ 发布（prepack 自动再跑 verify + build --check）
npm publish --access public

# ⑤ 发布后审计
npm view @luchenglong/cli-bridge version dist.tarball
# GitHub 建 Release 挂 CHANGELOG 条目
```

## 2. 首次建仓（当前凭据失效，恢复后照此执行）

```powershell
gh auth login                      # 或 gh auth refresh -s repo,workflow
gh repo create new-256/cli-bridge --public --source . --push --description "Unified CLI bridge for DSH: agy + CodeBuddy + MiMo in one plugin"
npm login
npm publish --access public
# 旧包下线（deprecate 不删除，旧安装仍可用但提示迁移）
npm deprecate agy-first-bridge@"*" "replaced by @luchenglong/cli-bridge"
npm deprecate codebuddy-first-bridge@"*" "replaced by @luchenglong/cli-bridge"
npm deprecate mimo-first-bridge@"*" "replaced by @luchenglong/cli-bridge"
```

> 360 安全软件曾静默删除带 GitHub remote 丢失的目录——**每个仓库必须有 remote**。
> 三个旧仓库在 README 挂迁移横幅后于 GitHub 归档（Archive）。

## 3. 日常维护闸门

- 任意代码改动：`npm run check`（等价 CI）。
- 只改一家：`node scripts/build.mjs --only=<id>` + `node --test tests/<id>`。
- 指示灯/设置层改动：`node --test tests/keystone`。
- 排查线上「灯不对」：先看 `GET /cli-bridge/status` 三桶 JSON，再看
  `{DSH_HOME}/cli-bridge-mcp-<id>.json` 的 updatedAt（>90s = MCP 侧停更），
  再看设置卡诊断行。
- 运行时接线永远「先停 DSH 后端」再改 profile（红线 2）。

## 4. 回滚

npm 侧：`npm deprecate @luchenglong/cli-bridge@<坏版本> "..."` + 发补丁版（npm 不删
已发布内容）。git 侧：revert 提交重发。DSH 侧最坏情况（client id 写错上线）：profile
里摘掉该 bundle 重启即可恢复，与旧包时代一致。
