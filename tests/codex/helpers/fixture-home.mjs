// tests/codex/helpers/fixture-home.mjs — 把 fixtures/codex-home 变成可用的临时 CODEX_HOME。
//
// 为什么要这一步：codex CLI 固定读 `{CODEX_HOME}/auth.json`，而发布安全红线
// （scripts/verify.mjs §9）禁止提交文件名含 auth/token/credential/secret 且非 `fake*`
// 开头的 fixture —— 旧仓曾把真实设备授权文件照抄进 fixtures 打进 tarball。
// 因此仓库里存的是 `fake-auth.json`，运行时才复制成 CLI 认的 `auth.json`（临时目录，
// 不进包）。这样既守住红线，又能真实覆盖「auth.json 兜底 base_url / api key」这条路径。
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../fixtures/codex-home/', import.meta.url))

/** @returns {{home: string, cleanup: () => void}} */
export function materializeCodexHome() {
  const home = mkdtempSync(join(tmpdir(), 'clb-codex-home-'))
  for (const f of ['config.toml', 'cc-switch-model-catalog.json', 'models.json']) {
    copyFileSync(join(SRC, f), join(home, f))
  }
  copyFileSync(join(SRC, 'fake-auth.json'), join(home, 'auth.json'))
  return {
    home,
    cleanup() { try { rmSync(home, { recursive: true, force: true }) } catch (e) { /* 清理尽力而为 */ } }
  }
}
