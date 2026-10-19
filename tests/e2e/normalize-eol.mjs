// 规范化源码行尾为 LF（.gitattributes 要求 eol=lf）。
// 背景：PowerShell 的 Set-Content / WriteAllLines 在 Windows 上会写 CRLF，与被 .gitattributes
// 约束的 eol=lf 冲突 → 生成物按 CRLF 源拼出，别的机器 clone 后 `build --check` 会 drift。
// 只处理文本源码（.mjs/.js/.yml/.md/.json），跳过 .bat/.ps1（它们要 CRLF）与二进制。
// 用法：node tests/e2e/normalize-eol.mjs [--apply]
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const apply = process.argv.includes('--apply')
const EXTS = new Set(['.mjs', '.js', '.yml', '.json'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.probe', '.tmp', 'test-output', 'runtime-data'])

const hits = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.snapshot-backup')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) { walk(p); continue }
    if (!EXTS.has(extname(name))) continue
    const buf = readFileSync(p)
    const text = buf.toString('utf8')
    if (!text.includes('\r\n')) continue
    hits.push(p.slice(ROOT.length + 1).replace(/\\/g, '/'))
    if (apply) writeFileSync(p, text.replace(/\r\n/g, '\n'), 'utf8')
  }
}
walk(ROOT)
console.log('files with CRLF: ' + hits.length)
hits.slice(0, 30).forEach((h) => console.log('  ' + h))
if (hits.length > 30) console.log('  … and ' + (hits.length - 30) + ' more')
if (apply) console.log('normalized to LF'); else console.log('(dry run; pass --apply)')
