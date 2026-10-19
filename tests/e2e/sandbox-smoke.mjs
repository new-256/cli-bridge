// 沙箱冒烟：把 dynamic/<id>.host.js 塞进 new Function（复刻 dynamic 形态的运行环境，
// 没有 import/require），确认它能被实例化；**并检查片文件导出的符号在生成物里确有定义**
// —— 这一条专门捕获"模板漏了 EXTRA 占位 → 片文件没被内联 → 调用时 ReferenceError"，
// 那是纯求值检查抓不到的（引用未定义标识符只在函数被调用时才炸）。
// 用法：node tests/e2e/sandbox-smoke.mjs [id ...]   默认全部 6 家
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['agy', 'codebuddy', 'mimo', 'opencode', 'claude', 'codex']

// 沙箱里 host 脚本期待的注入面（最小桩）：只要能让模块体求值即可。
function sandboxStub() {
  const noop = () => { }
  return {
    harness: { registerTool: noop, handle: noop, log: noop },
    ctx: { get: () => null, emit: noop, effect: (f) => { try { f() } catch (e) { } }, on: noop },
    console: { log: noop, warn: noop, error: noop }
  }
}

/** 从 providers/<id>-*.mjs 片文件里提取被 export 的顶层函数/常量名。 */
function fragmentExports(id) {
  const dir = ROOT + 'providers'
  const files = readdirSync(dir).filter((f) => f.startsWith(id + '-') && f.endsWith('.mjs'))
  const names = []
  for (const f of files) {
    const txt = readFileSync(dir + '/' + f, 'utf8')
    for (const m of txt.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1])
    for (const m of txt.matchAll(/^\s*export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1])
  }
  return { files, names: [...new Set(names)] }
}

/** 生成物里该符号是否有"定义"（function/const/let/class 声明），而不只是被引用。 */
function hasDefinition(src, name) {
  const n = name.replace(/[$]/g, '\\$')
  return new RegExp('(?:^|[\\s;])(?:async\\s+)?function\\s+' + n + '\\b|(?:^|[\\s;])(?:const|let|var)\\s+' + n + '\\s*=|(?:^|[\\s;])class\\s+' + n + '\\b', 'm').test(src)
}

let bad = 0
for (const id of ids) {
  const p = ROOT + 'dynamic/' + id + '.host.js'
  let src
  try { src = readFileSync(p, 'utf8') } catch (e) { console.log('  ' + id.padEnd(10) + ' SKIP (no generated host)'); continue }
  const stub = sandboxStub()
  const names = Object.keys(stub)
  const vals = Object.values(stub)
  const problems = []
  try {
    // eslint-disable-next-line no-new-func
    const run = new Function(...names, src + '\n;return typeof apply === "function" ? apply : (typeof registerHost === "function" ? registerHost : null);')
    const fn = run(...vals)
    // 片文件符号必须有定义，否则运行到那行就 ReferenceError
    const frag = fragmentExports(id)
    const missing = frag.names.filter((n) => !hasDefinition(src, n))
    if (missing.length) problems.push('片文件符号未内联: ' + missing.slice(0, 5).join(',') + (frag.names.length > 5 ? ' …' : ''))
    const fragInfo = frag.files.length ? ('片=' + frag.files.length + '/' + frag.names.length + '符号') : '无片'
    if (problems.length) { bad++; console.log('  ' + id.padEnd(10) + ' ✗ ' + problems.join('; ') + '  [' + fragInfo + ']') }
    else console.log('  ' + id.padEnd(10) + ' ✓ 求值+内联 OK, 入口=' + (fn ? (fn.name || 'anonymous') : '(仅副作用)') + '  [' + fragInfo + ']')
  } catch (e) {
    bad++
    console.log('  ' + id.padEnd(10) + ' ✗ ' + String((e && e.message) || e).slice(0, 160))
  }
}
console.log(bad === 0 ? '\n全部通过' : '\n失败 ' + bad + ' 个')
process.exit(bad === 0 ? 0 : 1)
