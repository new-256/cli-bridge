// providers/claude-endpoint.mjs — claude 的端点解析（第三片）。
//
// 为什么需要这一层（真实事故，2026-10-20）：
// 用户用 cc-switch 管理 Claude 配置，其「proxy 模式」把 Claude 指向第三方网关
// （例：ANTHROPIC_BASE_URL=https://opencode.ai/zen/go）。该网关要求自家 session 头
// （`x-opencode-session` / MissingSessionID），claude CLI 不会发 → **直连必然 400**。
// 能用是因为 cc-switch 在本机起了一个转发代理，由它补头/认证：
//   实测 POST http://127.0.0.1:15721/v1/messages → 200；同一配置直连 → 400 MissingSessionID。
// 所以「把 base_url 换成 cc-switch 代理」不是降级，而是这套配置**唯一可行**的访问方式。
//
// 注入方式：`--settings <json>` 覆盖 env.ANTHROPIC_BASE_URL，**不改用户的
// ~/.claude/settings.json**（那是 cc-switch 的领地，改它会在下次切换时被覆盖，也可能
// 破坏用户的 GUI 会话）。
//
// 探活采用「起一次 node 子进程做 HTTP GET」：buildArgv/meta 都是同步回调，Node 无同步
// HTTP。结果按 URL 缓存 30s，避免每次调用都起进程。探不到就如实回落直连（并在诊断里
// 说明"代理未响应"），绝不再假装已接管。

/** 默认的 cc-switch 本地代理地址（其 proxy_config.listen_port 实测为 15721）。 */
export const DEFAULT_PROXY_URL = 'http://127.0.0.1:15721'

/** 端点模式：auto = 代理活着就用它；proxy = 强制；direct = 强制直连。 */
export const ENDPOINT_MODES = ['auto', 'proxy', 'direct']

const PROXY_TTL_MS = 30 * 1000
let proxyCache = { url: '', at: 0, alive: false, detail: '' }

/** 允许测试注入探测结果，避免每个用例都起子进程。 */
export function resetProxyCache() { proxyCache = { url: '', at: 0, alive: false, detail: '' } }

function builtin(name) {
  const p = globalThis.process
  try { return (p && typeof p.getBuiltinModule === 'function') ? p.getBuiltinModule(name) : null } catch (e) { return null }
}

/** 探活子脚本：对 url 发 GET，任何 HTTP 响应都算活着（404 也算 —— cc-switch 根路径就是 404）。 */
const PROBE_SCRIPT = [
  "const http=require('http'),https=require('https');",
  "const u=process.argv[1];",
  "const m=/^https:/i.test(u)?https:http;",
  "const r=m.get(u,{timeout:1500},(res)=>{res.resume();console.log('ALIVE '+res.statusCode);process.exit(0)});",
  "r.on('error',(e)=>{console.log('DEAD '+(e.code||e.message));process.exit(0)});",
  "r.on('timeout',()=>{console.log('DEAD timeout');try{r.destroy()}catch(e){};process.exit(0)});"
].join('')

/**
 * 同步探活（带 30s 缓存）。返回 { alive, detail }。
 * 起 `node -e` 子进程是唯一能在同步回调里做真实 HTTP 的办法；代价约 100-250ms，
 * 且被 URL 维度缓存 —— 只在「首次」或「缓存过期」时付。
 */
export function detectProxySync(url, nowMs) {
  const target = String(url || '').trim()
  if (!target) return { alive: false, detail: 'no url' }
  const at = Number(nowMs) || Date.now()
  if (proxyCache.url === target && at - proxyCache.at < PROXY_TTL_MS) {
    return { alive: proxyCache.alive, detail: proxyCache.detail }
  }
  const child = builtin('node:child_process')
  const proc = globalThis.process
  let alive = false
  let detail = 'no child_process'
  if (child && typeof child.spawnSync === 'function' && proc && proc.execPath) {
    try {
      const r = child.spawnSync(proc.execPath, ['-e', PROBE_SCRIPT, target], {
        encoding: 'utf8', timeout: 4000, windowsHide: true,
        env: Object.assign({}, proc.env)
      })
      const out = String((r && r.stdout) || '')
      alive = /^ALIVE\b/m.test(out)
      detail = out.trim().split(/\r?\n/).pop() || (r && r.error && (r.error.code || r.error.message)) || 'unknown'
    } catch (e) { detail = 'probe threw: ' + String(e && e.message || e) }
  }
  proxyCache = { url: target, at, alive, detail }
  return { alive, detail }
}

/** 读 ~/.claude/settings.json 里配置的 ANTHROPIC_BASE_URL（只读，不写）。 */
export function readConfiguredBaseUrl(env, configDir) {
  const fs = builtin('node:fs')
  const path = builtin('node:path')
  if (!fs || !path) return ''
  const dir = configDir || ((env && (env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME)) || '')
  if (!dir) return ''
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
    const block = raw && raw.env && typeof raw.env === 'object' ? raw.env : {}
    return typeof block.ANTHROPIC_BASE_URL === 'string' ? block.ANTHROPIC_BASE_URL.trim() : ''
  } catch (e) { return '' }
}

/**
 * 解析最终端点。
 * @returns {{ mode: 'proxy'|'direct', baseUrl: string, proxyUrl: string, proxyAlive: boolean,
 *             configuredBaseUrl: string, note: string, error?: string }}
 */
export function resolveEndpoint(settings, env, opts) {
  const o = opts || {}
  const s = settings && typeof settings === 'object' ? settings : {}
  const mode = ENDPOINT_MODES.indexOf(String(s.endpointMode || '')) >= 0 ? String(s.endpointMode) : 'auto'
  const proxyUrl = String(s.proxyUrl || DEFAULT_PROXY_URL).trim() || DEFAULT_PROXY_URL
  const configuredBaseUrl = readConfiguredBaseUrl(env, o.configDir)

  if (mode === 'direct') {
    return { mode: 'direct', baseUrl: configuredBaseUrl, proxyUrl, proxyAlive: false, configuredBaseUrl, note: '强制直连（endpointMode=direct）' }
  }
  const det = o.probe ? o.probe(proxyUrl) : detectProxySync(proxyUrl)
  if (det.alive) {
    return {
      mode: 'proxy', baseUrl: proxyUrl, proxyUrl, proxyAlive: true, configuredBaseUrl,
      note: '经 cc-switch 本地代理 ' + proxyUrl + '（配置的端点 ' + (configuredBaseUrl || '(未读到)') + ' 需要代理补头）'
    }
  }
  if (mode === 'proxy') {
    return {
      mode: 'proxy', baseUrl: proxyUrl, proxyUrl, proxyAlive: false, configuredBaseUrl,
      note: '强制走代理但探测失败：' + det.detail,
      error: 'cc-switch 本地代理 ' + proxyUrl + ' 无响应（' + det.detail + '）。请启动 cc-switch（含其本地代理），' +
        '或把「端点模式」改为 direct 直连，或在「代理地址」里填实际端口。'
    }
  }
  return {
    mode: 'direct', baseUrl: configuredBaseUrl, proxyUrl, proxyAlive: false, configuredBaseUrl,
    note: '直连配置的端点 ' + (configuredBaseUrl || '(未读到)') + '（本地代理 ' + proxyUrl + ' 未响应：' + det.detail + '）。' +
      '若该端点来自 cc-switch 的 proxy 模式，请启动 cc-switch —— 否则会被网关以缺 session 头拒绝。'
  }
}

/** 把端点覆盖编成 claude 的 `--settings` JSON（只覆盖 base_url，不动其它键）。 */
export function overlaySettingsJson(baseUrl) {
  if (!baseUrl) return ''
  return JSON.stringify({ env: { ANTHROPIC_BASE_URL: String(baseUrl) } })
}
