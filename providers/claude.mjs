// providers/claude.mjs — claude provider descriptor（Claude Code CLI；本仓第五家 CLI）。
//
// 基线 = 本机实测 Claude Code 2.0.76（`claude` = 原生 claude.exe），端点被用户指向第三方
// Anthropic 兼容服务（~/.claude/settings.json 的 env: ANTHROPIC_BASE_URL/AUTH_TOKEN +
// ANTHROPIC_DEFAULT_*_MODEL 别名映射）。写代码时最容易踩的几条事实：
//   • 非交互 = `claude -p "<prompt>"`，prompt 是**单参数**（不是位置参数流，也不是 stdin）。
//   • `--output-format json` → stdout 单行 result 事件；`stream-json` 必须配 `--verbose`，
//     实测 4 行：system(init) / assistant(thinking) / assistant(text) / result。
//   • ⚠️ 成功判定陷阱：result 事件 `is_error:true` 时退出码**可能是 0 也可能 1**
//     （实测无效模型 = exit 1，但 stdout 仍是合法 JSON 且 `subtype` 竟然还是 "success"）。
//     故 buildResult 只认 `is_error` + `subtype`，绝不只看 exit code。
//   • 续聊 = `--resume <session_id>`；`-c/--continue` 续最近一次。session_id 来自
//     result 事件（json/stream-json 都有）。
//   • 权限：`--permission-mode plan|acceptEdits|...` 或 `--dangerously-skip-permissions`；
//     -p 模式没有 TTY，任何需要交互批准的路径都必须走 bypass，否则会挂到超时。
//
// 红线（PROVIDER-CONTRACT.md §8 + §1）：
//  - 本文件会被 build 内联进 dynamic 沙箱（new Function）：绝不出现 import.meta 字面量；
//    process 只经 deps 注入或 typeof 守卫读取；宿主能力全部走 deps/attach(hostOpts)。
//  - 只允许 import '../core/bridge-kit.mjs' 与同目录片文件（claude-exe / claude-models）。
//  - 模型清单只认服务端权威探测；拿不到 = ok:false + 可操作错误（绝不静默空数组/配置冒充）。
import { createStatusEngine, createRunner, clampInt, isLimited } from '../core/bridge-kit.mjs'
import { claudeExeCandidates, claudePathHint, resolveExePrefix, splitExeSpec, CLAUDE_BIN_ENV_VARS } from './claude-exe.mjs'
import { PROBE_MODEL, parseSupportedModels, probeSupportedModels, readCachedModels, readConfiguredModels, listAccountModels, resetModelsCache, claudeConfigDir } from './claude-models.mjs'
import { ENDPOINT_MODES, DEFAULT_PROXY_URL, resolveEndpoint, overlaySettingsJson, readConfiguredBaseUrl } from './claude-endpoint.mjs'
// 单行 re-export（build 内联时整行剥离；多行形态风险见 build.mjs 的 stripModuleSyntax 注释）。
export { claudeExeCandidates, claudePathHint, resolveExePrefix, splitExeSpec, PROBE_MODEL, parseSupportedModels, probeSupportedModels, readCachedModels, readConfiguredModels, listAccountModels, resetModelsCache }

function nowIso() { return new Date().toISOString() }

// 权限模式的用户可见取值（auto 由 DSH plan 状态决定；其余直通 CLI）。
const MODE_ENUM = ['auto', 'plan', 'accept-edits', 'bypass']

// 手动拉取（契约 §3.2）的探测时限与失败指引。
// 失败文案必须「可操作」：面板只会把 error 原样显示给用户，没写下一步等于没帮上忙。
const REFRESH_TIMEOUT_MS = 30000
const REFRESH_HINT = '排查顺序：① 确认设置面板的「claude 可执行文件路径」或 CLAUDE_BIN 指向真实 claude（原生 .exe 优先）；② 确认 ~/.claude/settings.json 的 env 里 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 指向可用端点（该面若未登录，先在终端跑一次 claude 完成登录）；③ 再点一次「拉取可用模型」。'

/** 缓存年龄的短文案（面板 note 用；只描述事实，不假装新鲜）。 */
function ageText(ms) {
  const min = Math.floor(Math.max(0, Number(ms) || 0) / 60000)
  if (min < 1) return '刚刚拉取'
  if (min < 60) return min + ' 分钟前拉取'
  return Math.floor(min / 60) + ' 小时前拉取'
}

// ── 三工具 schema ─────────────────────────────────────────────────────────────
const RUN_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The task instruction for claude. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — claude reads the repo itself). For follow-ups on the same topic, use claude_continue with latest=true or sessionId (claude keeps session context; state only what is new).' },
    mode: { type: 'string', enum: MODE_ENUM, description: 'Permission mode. auto (default) follows the DSH plan state: plan when the session is in plan mode, otherwise bypass (permissions auto-approved so claude never blocks). plan = read-only planning; accept-edits = allow file edits but still ask for risky commands; bypass = --dangerously-skip-permissions.' },
    model: { type: 'string', description: 'Optional model id or alias (e.g. "sonnet", "opus", or a full id). Which ids actually work is decided by the endpoint, not by this bridge — call claude_models for the authoritative server-side list. Omit to use the model chosen in CLI Bridge settings, else claude\'s own configuration.' },
    maxBudgetUsd: { type: 'number', description: 'Optional hard cap on API spend for this run (passes --max-budget-usd).' },
    cwd: { type: 'string', description: 'Working directory for claude. Defaults to the DSH workspace root.' },
    addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to allow tool access to (--add-dir).' },
    allowedTools: { type: 'array', items: { type: 'string' }, description: 'Optional allow-list of tool names (--allowedTools).' },
    disallowedTools: { type: 'array', items: { type: 'string' }, description: 'Optional deny-list of tool names (--disallowedTools).' },
    systemPrompt: { type: 'string', description: 'Optional replacement system prompt (--system-prompt).' },
    appendSystemPrompt: { type: 'string', description: 'Optional system prompt appended to the default one (--append-system-prompt).' },
    forkSession: { type: 'boolean', description: 'When resuming, create a new session id instead of reusing the original (--fork-session).' },
    timeoutSec: { type: 'integer', description: 'Execution timeout seconds (10-3600, default 600).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with claude_status. Set false to block for the final answer.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing claude session. State only what is new; claude preserves its session context.' },
    sessionId: { type: 'string', description: 'claude session id to resume (from a prior claude_run result; passes --resume).' },
    latest: { type: 'boolean', description: 'Continue the most recent claude conversation instead of a specific id (--continue).' },
    mode: { type: 'string', enum: MODE_ENUM, description: 'Permission mode; default auto.' },
    model: { type: 'string', description: 'Optional model id or alias.' },
    maxBudgetUsd: { type: 'number', description: 'Optional hard cap on API spend for this run.' },
    cwd: { type: 'string', description: 'Working directory for claude.' },
    forkSession: { type: 'boolean', description: 'Create a new session id instead of reusing the original (--fork-session).' },
    timeoutSec: { type: 'integer', description: 'Execution timeout seconds (10-3600, default 600).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output. Set false to block for the final answer.' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }

// claude_models（附加工具）：服务端权威模型清单（探测 400 报文，绝不用配置冒充）。
const MODELS_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    refresh: { type: 'boolean', description: 'Bypass the 5-minute probe cache and ask the endpoint again.' },
    timeoutMs: { type: 'integer', description: 'Probe timeout in ms (5000-90000, default 30000).' }
  }
}
const MODELS_DESCRIPTION = 'List the models the current claude account/endpoint really supports, read LIVE from the server. Mechanism: the CLI is run once with a deliberately invalid model id, which makes the endpoint answer HTTP 400 with "The supported API model names are X, Y" — that roster is authoritative for this endpoint+key. Returns { ok, source:"account-live", models:[{id, configuredAs}], count }. The ANTHROPIC_*_MODEL entries in ~/.claude/settings.json are alias mappings, NOT the full supported set, so they are only returned as a diagnostic hint (never as models). If no live roster can be read this returns ok:false with an actionable error — it never invents a list.'

// 渲染函数签名遵循 harness 契约 render(args, value)（extraTools[].render 同签名，
// preset/dynamic/MCP 三处都按两参数调用 —— 只写一个参数会渲染出空壳）。
function renderModels(args, value) {
  const v = value || {}
  if (!v.ok) {
    const lines = ['claude_models failed: ' + String(v.error || 'unknown')]
    const cfg = v.diagnostic && Array.isArray(v.diagnostic.configured) ? v.diagnostic.configured : []
    if (cfg.length) {
      lines.push('configured aliases (NOT authoritative): ' + cfg.map((m) => m.id).join(', '))
      if (v.diagnostic && v.diagnostic.settingsPath) lines.push('  from ' + v.diagnostic.settingsPath)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const list = Array.isArray(v.models) ? v.models : []
  if (!list.length) return [{ type: 'text', text: 'claude_models: server returned an empty roster' }]
  const lines = ['claude models (' + list.length + ') [source=' + (v.source || 'account-live') + ']:']
  for (const m of list.slice(0, 40)) lines.push('  ' + m.id + (m.configuredAs ? '  [configured as ' + m.configuredAs + ']' : ''))
  if (list.length > 40) lines.push('  … and ' + (list.length - 40) + ' more')
  if (v.diagnostic && v.diagnostic.settingsPath) lines.push('settings: ' + v.diagnostic.settingsPath)
  return [{ type: 'text', text: lines.join('\n') }]
}

// usage 汇总：input/output + 两个 cache 计数（claude 的 input_tokens 不含 cache 命中）。
function sumTokens(usage) {
  if (!usage || typeof usage !== 'object') return null
  let total = 0
  let any = false
  for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
    if (typeof usage[k] === 'number' && Number.isFinite(usage[k])) { total += usage[k]; any = true }
  }
  return any ? total : null
}

// 本次实际跑的主模型：modelUsage 里按 costUSD（再退 token 量）挑最大者。
function pickModelUsed(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return null
  let best = null
  let bestScore = -1
  for (const k of Object.keys(modelUsage)) {
    const u = modelUsage[k] && typeof modelUsage[k] === 'object' ? modelUsage[k] : {}
    const score = (Number(u.costUSD) || 0) * 1e6 + (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0)
    if (score > bestScore) { bestScore = score; best = k }
  }
  return best
}

export default function defineProvider(deps = {}) {
  const env = deps.env || {}
  let host = null
  let settingsRef = { binPath: '', defaultModel: '', maxBudgetUsd: '' }

  /**
   * 当前生效设置（面板改完即时生效，无需重启）。三源合并，后者覆盖前者：
   *   ① settingsRef（attach 时快照/缺省）② deps.readSettings（MCP 形态现读文件）
   *   ③ host.getSettings('claude')（preset/dynamic 形态）。
   */
  function currentSettings() {
    const out = Object.assign({}, settingsRef)
    try {
      if (typeof deps.readSettings === 'function') {
        const r = deps.readSettings()
        if (r && typeof r === 'object') {
          const part = ('partition' in r || 'path' in r || 'home' in r) ? r.partition : r
          if (part && typeof part === 'object') Object.assign(out, part)
        }
      }
    } catch (e) { }
    try {
      if (host && typeof host.getSettings === 'function') {
        const s = host.getSettings('claude')
        if (s && typeof s === 'object') Object.assign(out, s)
      }
    } catch (e) { }
    return out
  }

  const descriptor = {
    id: 'claude', label: 'CLAUDE', presetId: 'claude-first', defaultBackend: null, defaultMode: 'auto',
    exeName: 'claude', binEnvVars: CLAUDE_BIN_ENV_VARS, unavailableStatus: 'CLAUDE_UNAVAILABLE',

    // 单后端：模型/凭据由 claude 自身配置（~/.claude/settings.json）决定，桥不引入第二后端。
    backends() { return null },
    normalizeBackend() { return null },
    resolveBackend(args, target, preferred) { return null },

    // 实测 flag 集（Claude Code 2.0.76 `claude --help`）。
    buildArgv(exePrefix, args, opts) {
      const o = opts || {}
      const argv = Array.isArray(exePrefix) ? exePrefix.slice() : [String(exePrefix)]
      argv.push('-p', String(args.prompt))
      // stream-json 才能实时折叠步骤（foldStreamEvent 吃 system/assistant/result 事件）；
      // stream=false 时退单行 json（更省字节，仍可解析）。
      const stream = args.stream !== false
      if (stream) argv.push('--output-format', 'stream-json', '--verbose')
      else argv.push('--output-format', 'json')
      if (stream && args.includePartialMessages) argv.push('--include-partial-messages')
      const timeoutSec = clampInt(args.timeoutSec, 600, 10, 3600)
      // 端点：cc-switch 的 proxy 模式把 Claude 指向第三方网关，而该网关要求自家 session 头
      // （claude CLI 不会发）——**直连必然 400**，必须经 cc-switch 本地代理转发。
      // 这里用 --settings 只覆盖 ANTHROPIC_BASE_URL，绝不改写用户的 ~/.claude/settings.json。
      const ep = resolveEndpoint(currentSettings(), deps.env || {}, { probe: o.probeProxy, configDir: claudeConfigDir(deps.env || {}) })
      if (ep.error) { const e = new Error(ep.error); e.code = 'ENDPOINT_UNAVAILABLE'; throw e }
      if (ep.mode === 'proxy' && ep.baseUrl) argv.push('--settings', overlaySettingsJson(ep.baseUrl))

      // 权限：auto → 跟随 DSH plan 状态；plan 用 CLI 的 plan 模式，其余走 bypass
      //（-p 没有 TTY，任何交互批准都会挂到超时 —— 与 agy/codebuddy/opencode 同语义）。
      let mode = String(args.mode || descriptor.defaultMode || 'auto')
      if (MODE_ENUM.indexOf(mode) < 0) mode = 'auto'
      if (mode === 'auto') mode = o.planActive ? 'plan' : 'bypass'
      if (mode === 'plan') argv.push('--permission-mode', 'plan')
      else if (mode === 'accept-edits') argv.push('--permission-mode', 'acceptEdits')
      else { mode = 'bypass'; argv.push('--dangerously-skip-permissions') }

      // 模型优先级：调用参数 > 设置面板 defaultModel > kit 注入的 defaultModel > 不传（claude 自决）。
      const model = args.model || currentSettings().defaultModel || o.defaultModel || ''
      if (model) argv.push('--model', String(model))

      const budgetRaw = args.maxBudgetUsd != null ? args.maxBudgetUsd : currentSettings().maxBudgetUsd
      const budget = budgetRaw == null ? NaN : Number(budgetRaw)
      if (Number.isFinite(budget) && budget > 0) argv.push('--max-budget-usd', String(budget))

      if (args.systemPrompt) argv.push('--system-prompt', String(args.systemPrompt))
      if (args.appendSystemPrompt) argv.push('--append-system-prompt', String(args.appendSystemPrompt))
      if (Array.isArray(args.allowedTools) && args.allowedTools.length) argv.push('--allowedTools', args.allowedTools.map(String).join(','))
      if (Array.isArray(args.disallowedTools) && args.disallowedTools.length) argv.push('--disallowedTools', args.disallowedTools.map(String).join(','))
      if (Array.isArray(args.addDirs)) for (const d of args.addDirs) { if (d) argv.push('--add-dir', String(d)) }
      if (args.noSessionPersistence) argv.push('--no-session-persistence')

      if (args.sessionId) argv.push('--resume', String(args.sessionId))
      else if (args.continueLatest) argv.push('--continue')
      if (args.forkSession && (args.sessionId || args.continueLatest)) argv.push('--fork-session')
      return { argv, mode, timeoutSec }
    },

    // stdout 解析：json = 单行 result；stream-json = 多行事件，取**最后**一个 result。
    // 无 result 事件 → null（buildResult 据此判 PARSE_ERROR，绝不假造成功）。
    parseJson(stdoutText) {
      const trimmed = String(stdoutText || '').trim()
      if (!trimmed) return null
      let last = null
      for (const raw of trimmed.split(/\r?\n/)) {
        const t = raw.trim()
        if (!t.startsWith('{')) continue
        let obj
        try { obj = JSON.parse(t) } catch (e) { continue }
        if (obj && obj.type === 'result') last = obj
      }
      if (last) return last
      try {
        const obj = JSON.parse(trimmed)
        if (obj && obj.type === 'result') return obj
      } catch (e) { }
      return null
    },

    // 统一结果对象。⚠️ 成功判据 = is_error === false（且 subtype 非错误态）**并且** exit 0；
    // 只看 exit code 会把「无效模型」误判成成功（实测该场景 exit 1 + subtype "success"），
    // 反过来也存在 exit 0 + is_error true 的形态，故两者必须同时成立。
    buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
      const exitCode = outcome ? outcome.exitCode : null
      const stderr = stderrText ? String(stderrText).slice(-2000) : ''
      if (parsed && typeof parsed === 'object') {
        const isError = parsed.is_error === true
        const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : ''
        const response = typeof parsed.result === 'string' ? parsed.result : ''
        const errorText = isError ? (response || (typeof parsed.error === 'string' ? parsed.error : '')) : ''
        let status
        if (exitCode === 130) status = 'ABORTED'
        else if (isError) status = subtype === 'error_max_turns' ? 'MAX_TURNS' : 'EXEC_ERROR'
        else if (exitCode !== 0) status = 'CLI_ERROR'
        else status = 'SUCCESS'
        const ok = !isError && exitCode === 0 && status === 'SUCCESS'
        const denials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials.length : 0
        return {
          ok,
          status,
          response,
          sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
          durationSeconds: typeof parsed.duration_ms === 'number' ? Math.round(parsed.duration_ms / 100) / 10 : null,
          numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
          totalTokens: sumTokens(parsed.usage),
          exitCode, mode, backend: backend || null,
          // is_error 的正文也必须进 stderr：限流/凭据判定与失败指引都读它。
          stderr: (stderr ? stderr + ' ' : '') + errorText,
          subtype: subtype || null,
          modelUsed: pickModelUsed(parsed.modelUsage),
          costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
          permissionDenials: denials
        }
      }
      const text = String(stdoutText || '').trim()
      const status = exitCode === 0 ? 'PARSE_ERROR' : 'CLI_ERROR'
      return {
        ok: false,
        status,
        response: '',
        sessionId: null,
        durationSeconds: null, numTurns: null, totalTokens: null,
        exitCode, mode, backend: backend || null,
        stderr: (stderr ? stderr + ' ' : '') + (exitCode === 0 ? 'no result event in claude output' : ''),
        subtype: null, modelUsed: null, costUsd: null, permissionDenials: 0,
        rawStdout: text.slice(-2000)
      }
    },

    // 实时步骤折叠（stream-json → project.current/trail）。
    // 事件形态（实测）：system/subtype=init 带 model+permissionMode；assistant.message.content
    // 是 Anthropic 内容块数组（thinking / text / tool_use）；user.message.content 带 tool_result。
    foldStreamEvent(ev, p, summarizeArgs, maxArgLen, maxTrail) {
      if (!ev || typeof ev !== 'object') return
      const type = ev.type
      if (!type) return
      const cap = maxTrail || 12
      const capLen = maxArgLen || 120
      const push = (entry) => { p.trail.push(entry); while (p.trail.length > cap) p.trail.shift() }
      const blocksOf = (m) => (m && typeof m === 'object' && Array.isArray(m.content) ? m.content : [])
      p.updatedAt = Date.now()
      if (type === 'system') {
        if (ev.subtype === 'init') {
          p.current = { tool: 'session', args: { model: ev.model || '', permissionMode: ev.permissionMode || '' }, stepIndex: 0, since: nowIso() }
          return
        }
        return
      }
      if (type === 'assistant') {
        for (const b of blocksOf(ev.message)) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'tool_use') {
            const tool = b.name || 'tool'
            const args = summarizeArgs(b.input)
            const idx = p.trail.length
            push({ stepIndex: idx, state: 'ACTIVE', tool, args: args || null, at: nowIso() })
            p.current = { tool, args: args || null, stepIndex: idx, since: nowIso() }
          } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
            p.current = { tool: 'agent_response', args: { text_delta: b.text.slice(0, capLen) }, stepIndex: p.trail.length, since: nowIso() }
          } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
            p.current = { tool: 'reasoning', args: { text_delta: b.thinking.slice(0, capLen) }, stepIndex: p.trail.length, since: nowIso() }
          }
        }
        return
      }
      if (type === 'user') {
        for (const b of blocksOf(ev.message)) {
          if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue
          // 把最近一个仍在 ACTIVE 的步骤收尾（tool_result 不带 tool name，按时间序配对）。
          for (let i = p.trail.length - 1; i >= 0; i--) {
            if (p.trail[i].state === 'ACTIVE') { p.trail[i].state = b.is_error === true ? 'ERROR' : 'DONE'; break }
          }
          p.current = null
        }
        return
      }
      if (type === 'result') { p.current = null }
    },

    // 瞬时错误静默重试一次：只认网络/过载类，且明确排除模型名/凭据类（那些重试无用）。
    isTransientCliError(res) {
      if (!res || res.ok) return false
      if (isLimited(res)) return false
      const hay = String(res.stderr || '') + ' ' + String(res.response || '')
      if (/supported API model names|invalid_request_error|model .* not|authentication|invalid api key|401|403/i.test(hay)) return false
      return /overloaded|529|503|ECONNRESET|socket hang up|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|terminated|connection (reset|closed)/i.test(hay)
    },

    failureHint(res) {
      if (!res || res.ok) return ''
      const st = String(res.status || '')
      if (st === 'CLAUDE_UNAVAILABLE') return '[诊断] 未找到 claude 可执行文件：请安装 Claude Code（或 npm i -g @anthropic-ai/claude-code），或在 CLI Bridge 设置面板填写 claude 可执行文件路径（也可设 CLAUDE_BIN）。'
      if (st === 'PARSE_ERROR') return '[诊断] claude 没有输出 result 事件（进程可能被中断/输出被截断）。若你手动改了 output-format，请改回；否则重试一次，持续失败请检查 CLI 版本（--output-format json 是 2.x 的行为）。'
      const hay = String(res.stderr || '') + ' ' + String(res.response || '')
      const supported = parseSupportedModels(hay)
      if (supported) return '[诊断] 模型名被端点拒绝。该端点当前支持的模型：' + supported.join(', ') + ' —— 用 claude_models 取权威清单，然后在调用参数或设置面板里改 model；字符串 "[1M]" 之类的后缀属于配置里的别名写法，不能直接当 --model 传入。'
      if (/supported API model names|invalid_request_error/i.test(hay)) return '[诊断] 模型名被端点拒绝（400 invalid_request_error）：先用 claude_models 确认服务端支持的模型，再传 model。'
      if (res.permissionDenials) return '[诊断] 有 ' + res.permissionDenials + ' 次工具调用被权限拒绝：-p 模式没有交互确认，请用 mode=bypass（默认 auto 在非 plan 模式下就是 bypass），或在 allowedTools 里放行所需工具。'
      if (/authentication_error|invalid x-api-key|invalid api key|401|unauthorized|not logged in|oauth|api key/i.test(hay) && !/rate.?limit|quota|限流|额度/i.test(hay)) {
        return '[诊断] claude 凭据/端点问题：请让用户检查 ~/.claude/settings.json 的 env 块（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN）或重新登录 claude；这不是限流。'
      }
      if (/rate.?limit|\b429\b|quota|insufficient|credit|balance|额度/i.test(hay)) {
        return '[诊断] 端点报告限流/额度不足：不要循环重试；换 model（用 claude_models 挑一个可用的）或改用 DSH 原生工具完成本任务。'
      }
      return ''
    },

    isSuccessStatus(st) { return st === 'SUCCESS' },

    tools: {
      run: { name: 'claude_run', description: 'Dispatch a coding/build/debug/investigation task to the local Claude Code CLI and return its final answer. Prefer this for implementation, edits, refactors, multi-file investigation and debugging in every mode. DSH fully controls claude: it always runs non-interactively with permissions auto-approved (claude never blocks on a prompt), in stream-json mode so live steps reach claude_status. Use read-only native tools only for quick lookups and for final build/test verification. Runs in the background by default (returns a jobId immediately; collect with job_output); set background=false to block for the final answer.', inputSchema: RUN_PARAMS },
      continue: { name: 'claude_continue', description: 'Continue an existing claude session with a follow-up prompt, reusing claude context. Pass sessionId from a prior claude_run result (--resume), or set latest=true to continue the most recent conversation (--continue). Same DSH-controlled, no-prompt execution as claude_run.', inputSchema: CONTINUE_PARAMS },
      status: { name: 'claude_status', description: 'Read a live snapshot of what the local claude agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or agent_response thinking/typing), the recent step trail (tools executed, done/error), and the last completed run status + session id. Optional cwd filters to a single project. Call this to check on an in-flight claude_run/claude_continue without waiting for it to finish.', inputSchema: STATUS_PARAMS }
    },

    // claude_models：三形态都注册（探测只需 node child_process；拿不到 spawn 能力时
    // logic 明确返回 ok:false，而不是静默缺席或伪造列表）。
    extraTools: [{
      name: 'claude_models',
      description: MODELS_DESCRIPTION,
      inputSchema: MODELS_PARAMS,
      render: renderModels,
      async logic(args) {
        return await descriptor.listModels(args || {})
      }
    }],

    /**
     * 列出服务端权威可用模型（三形态共用）。
     * 铁律：只认账号/端点探测；探测失败 = ok:false + 可操作错误 + 配置线索（非权威）。
     */
    async listModels(args) {
      const a = args || {}
      return await listAccountModels(env, {
        binPath: currentSettings().binPath,
        timeoutMs: clampInt(a.timeoutMs, 30000, 5000, 90000),
        refresh: !!a.refresh
      })
    },

    // ── 设置分区（契约 §3）─────────────────────────────────────────────────────
    settings: {
      keys: ['binPath', 'defaultModel', 'maxBudgetUsd'],
      defaults: () => ({ binPath: '', defaultModel: '', maxBudgetUsd: '' }),
      normalize: (raw) => {
        const r = raw && typeof raw === 'object' ? raw : {}
        const out = { binPath: '', defaultModel: '', maxBudgetUsd: '' }
        for (const k of ['binPath', 'defaultModel', 'maxBudgetUsd']) {
          if (typeof r[k] === 'string') out[k] = String(r[k]).trim()
        }
        return out
      },
      /**
       * 设置面板元数据（契约 §3.2）：**只读缓存、绝不探测**。
       * 面板是同步回调，而探测要起子进程打网络（3-5s）——放在这里会把首屏拖慢，且探不到时
       * 用户无法区分「没模型」与「没拉到」。故探测改为用户点「拉取可用模型」→
       * settings.refreshModels() 显式触发；成功后写回同一份缓存，这里下次渲染直接命中。
       */
      meta: (env2) => {
        const e = env2 && typeof env2 === 'object' ? env2 : {}
        const s = currentSettings()
        const cached = readCachedModels(e, { binPath: s.binPath })
        const options = (cached ? cached.ids : []).map((id) => ({ value: id, label: id }))
        const exeCandidates = claudeExeCandidates(e, '')
        // 端点实际走向（proxy / direct）——面板上如实显示，用户不用猜为什么请求失败。
        const epInfo = resolveEndpoint(s, e, { configDir: claudeConfigDir(e) })
        return {
          titleSuffix: 'Claude Code',
          fields: [
            {
              key: 'binPath', label: 'claude 可执行文件路径', type: 'select', allowCustom: true,
              options: exeCandidates.map((p) => ({ value: p, label: p })),
              placeholder: '留空 = 自动探测本地安装 / PATH',
              note: '检测到 ' + exeCandidates.length + ' 个候选；npm 全局安装给的是 .cmd（模型探测与 MCP 形态经 shell 启动），原生安装给 .exe —— preset 形态建议指向原生 .exe（.cmd 能否执行取决于宿主 subprocess）。也可手动粘贴任意路径（.mjs/.js 经 node 启动）。'
            },
            {
              key: 'defaultModel', label: '默认模型', type: 'select', allowCustom: true,
              options,
              // 面板据此渲染「手动拉取」按钮（契约 §3.2）；meta() 自身永不探测。
              refresh: { label: '拉取可用模型' },
              placeholder: '留空 = 由 claude 自身配置（~/.claude/settings.json）决定',
              note: options.length
                ? '共 ' + options.length + ' 个服务端权威可用模型（' + ageText(cached.ageMs) + '，源：' + cached.mode + '）。点「拉取可用模型」重新获取；调用时传 model 可覆盖本项。'
                : '还没拉取过（或上次没拉到）：点「拉取可用模型」向端点取权威清单；空表示尚未拉取 / 该面未登录。可直接手动输入模型名 —— 配置里的 ANTHROPIC_*_MODEL 只是别名映射，不作为候选展示。'
            },
            {
              key: 'maxBudgetUsd', label: '单次最大花费（美元）', type: 'text',
              placeholder: '留空 = 不限制',
              note: '非空时自动附加 --max-budget-usd；调用参数 maxBudgetUsd 可覆盖。'
            },
            {
              key: 'endpointMode', label: '端点模式', type: 'select',
              options: [
                { value: 'auto', label: 'auto —— 代理活着就走代理，否则直连' },
                { value: 'proxy', label: 'proxy —— 强制走本地代理' },
                { value: 'direct', label: 'direct —— 强制直连配置的端点' }
              ],
              note: epInfo.note + '。cc-switch 的 proxy 模式把 Claude 指向第三方网关，该网关要求自家 session 头而 claude CLI 不会发：直连必然 400，必须经 cc-switch 本地代理转发。'
            },
            {
              key: 'proxyUrl', label: '本地代理地址', type: 'text',
              placeholder: DEFAULT_PROXY_URL,
              note: 'cc-switch 的本地代理默认监听 127.0.0.1:15721。若你改过端口，填这里。桥接用 --settings 只覆盖 ANTHROPIC_BASE_URL，**不会改写** ~/.claude/settings.json。'
            }
          ]
        }
      },

      /**
       * 手动拉取（契约 §3.2）：面板「拉取可用模型」按钮 → keystone
       * POST /cli-bridge/settings/models → 这里。这是本 provider 唯一的面板探测入口。
       *
       * 复用 listAccountModels（异步 probeSupportedModels + 配置诊断），不写第二套探测；
       * 其成功路径已把权威清单写回 modelsCache，随后 meta() 直接命中（无需再探测）。
       * 铁律：失败 = ok:false + 可操作错误 + 空 ids，绝不返回 {ok:true, ids:[]}；
       * 也绝不把 settings.json 里的别名映射冒充成服务端可用全集。
       */
      async refreshModels(settings, env2) {
        const e = (env2 && typeof env2 === 'object') ? env2 : env
        const s = descriptor.settings.normalize(settings)
        // 探测必须走**同一个端点**：cc-switch proxy 模式下直连第三方网关会 400，那样探测
        // 永远拿不到东西（但配置清单仍应给出，见 listAccountModels 的合并逻辑）。
        const ep = resolveEndpoint(s, e, { configDir: claudeConfigDir(e) })
        const got = await listAccountModels(e, {
          binPath: s.binPath,
          baseUrl: ep.mode === 'proxy' ? ep.baseUrl : '',
          timeoutMs: REFRESH_TIMEOUT_MS,
          refresh: true
        })
        if (!got.ok) {
          return { ok: false, ids: [], source: got.source || 'none', error: String(got.error || 'probe failed') + ' ' + REFRESH_HINT + ' 端点：' + ep.note }
        }
        const ids = (got.models || []).map((m) => m.id).filter(Boolean)
        if (!ids.length) {
          return { ok: false, ids: [], source: got.source || 'none', error: '探测声称成功但未返回任何模型 id（内部不一致）。' + REFRESH_HINT }
        }
        // labels 标出「来自配置」还是「服务端报文补充」，面板可据此区分来源。
        const labels = {}
        for (const m of got.models) {
          labels[m.id] = m.id + (m.source === 'configured'
            ? '  [' + String(m.configuredAs || 'settings.json') + ']'
            : '  [服务端清单]')
        }
        return { ok: true, ids, labels, source: got.source || 'configured', endpoint: ep.note }
      },
      diagnose: (settings, env2) => {
        const s = settings && typeof settings === 'object' ? settings : {}
        const e = env2 && typeof env2 === 'object' ? env2 : {}
        const bits = []
        if (s.binPath) bits.push('bin=设置:' + s.binPath)
        else if (claudePathHint(e)) bits.push('bin=' + claudePathHint(e))
        else bits.push('bin=PATH:claude')
        bits.push(s.defaultModel ? 'model=' + s.defaultModel : 'model=(claude 自决)')
        if (s.maxBudgetUsd) bits.push('maxBudget=$' + s.maxBudgetUsd)
        const cfg = readConfiguredModels(e)
        if (cfg.ok && cfg.models.length) bits.push('settings.json env: ' + cfg.models.length + ' 个别名映射（非权威清单）')
        if (!cfg.ok && cfg.error) bits.push('settings.json: ' + cfg.error.slice(0, 120))
        return bits.join(' · ')
      }
    },

    // MCP 面版本由宿主注入（mcp/version.mjs 单源派生），描述符不复制 version 字面量。
    mcp: (deps.mcp && typeof deps.mcp === 'object') ? Object.assign({}, deps.mcp) : {}
  }

  // ── 三形态共用的工具逻辑（签名固定：宿主接线见 preset/dynamic/mcp 三处）──────────
  descriptor.runToolLogic = async function (args, exec) {
    const a = args || {}
    const normalized = a.background === undefined ? Object.assign({}, a, { background: true }) : a
    return this.runner.coreExecute(normalized, exec)
  }
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = {
      prompt: a.prompt, mode: a.mode, model: a.model, maxBudgetUsd: a.maxBudgetUsd,
      cwd: a.cwd, forkSession: a.forkSession, timeoutSec: a.timeoutSec,
      background: a.background === undefined ? true : a.background
    }
    const sid = a.sessionId || null
    if (sid) mapped.sessionId = sid
    else if (a.latest) mapped.continueLatest = true
    return this.runner.coreExecute(mapped, exec)
  }
  descriptor.statusToolLogic = function (args) {
    const a = args || {}
    const snap = this.engine.statusSnapshot()
    if (a.cwd) {
      const key = String(a.cwd)
      snap.projects = snap.projects.filter((p) => p.cwd === key)
      const g = snap.projects[0]
      if (g) {
        Object.assign(snap, {
          state: g.state, running: g.running, current: g.current, trail: g.trail,
          lastStatus: g.lastStatus, lastAt: g.lastAt, lastSessionId: g.lastSessionId,
          lastBackend: g.lastBackend, fallbackActive: g.fallbackActive, updatedAt: g.updatedAt
        })
      }
    }
    return snap
  }

  descriptor.attach = function (hostOpts) {
    host = hostOpts || {}
    try {
      if (typeof host.getSettings === 'function') {
        const s = host.getSettings('claude')
        if (s && typeof s === 'object') settingsRef = descriptor.settings.normalize(s)
      }
    } catch (e) { }
    this.engine = createStatusEngine({ provider: this, publish: host.publish })
    const runner = createRunner(Object.assign({}, host, { provider: this, engine: this.engine }))
    this.runner = runner
    return runner
  }
  return descriptor
}
