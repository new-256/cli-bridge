// providers/codex.mjs — codex provider descriptor（第五家 CLI，无旧包可迁）。
//
// 基线 = 本机实测 codex-cli 0.98.0（Windows，mise/cherrystudio shim）+ 真实 argv/事件流。
// 写代码时最容易踩的几条（全部实机验证过，见 docs 里 codex 任务卡）：
//   • 非交互 = `codex exec [OPTIONS] "PROMPT"`，prompt 是**位置参数**，必须放最后。
//   • ⚠️ `codex exec` **不接受** `-a/--ask-for-approval`（clap 直接报 unexpected argument；
//     那是根命令 `codex` 的旗）。要设审批策略只能走 `-c approval_policy="never"`。
//   • ⚠️ `codex exec resume` 只认 [SESSION_ID] [PROMPT] + -c/-m/-i/--json/--last/--all/
//     --skip-git-repo-check/--full-auto；**没有 -C、没有 -s、没有 -o、没有 --add-dir**
//     （实测传 -C 报 unexpected argument）。续聊的 cwd 只能靠 spawn 的 cwd。
//   • 非 git 目录必须带 --skip-git-repo-check，否则直接拒绝运行。
//   • `--json` → NDJSON 事件流：thread.started / turn.started / item.started /
//     item.completed / turn.completed；失败另加顶层 `error` + `turn.failed`。
//     ⚠️ item.completed 里也可能出现 item.type==="error" 的**告警**（如「此会话原模型与
//     当前模型不同」），那是正常续聊的提示，绝不可当成致命错误（实测 --last 续聊就带）。
//   • 退出码：0 成功 / 1 运行失败（stdout 仍是合法 JSON）/ 2 参数错误。
//   • 无 --json 时 stdout 就是纯文本答复，stderr 有元信息头（version/workdir/model/
//     provider/approval/sandbox/session id）—— 诊断只读它，不解析成结果。
//
// 红线（PROVIDER-CONTRACT.md §1/§8）：
//  - 本文件会被 build 内联进 dynamic 沙箱（new Function）：绝不出现 import.meta 字面量；
//    process 只经 typeof 守卫读取；宿主能力全部走 deps/attach(hostOpts)。
//  - 只允许 import '../core/bridge-kit.mjs' 与同目录 codex-*.mjs 片文件（片文件由 build
//    自动内联进同一作用域；主文件超 600 行红线所以必须拆）。
import { createStatusEngine, createRunner, clampInt, isLimited, endpointHost } from '../core/bridge-kit.mjs'
import {
  codexSetHost, codexResolveExePrefix, codexExeCandidates, codexReadConfig,
  codexModelsEndpoint, codexCachedModelOptions, codexCachedLiveModels, codexLiveModels,
  codexCatalogModels, codexBuiltinModels, codexHomeDir
} from './codex-cli.mjs'
import { codexModelsTool } from './codex-models.mjs'
export { codexResolveExePrefix, codexExeCandidates }

function nowIso() { return new Date().toISOString() }

// 实测枚举（根命令 help + exec help）。
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']
const APPROVAL_POLICIES = ['untrusted', 'on-failure', 'on-request', 'never']
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh']

// 手动拉取（契约 §3.2）：面板只把 error 原文显示给用户，所以失败文案必须自带下一步。
// codex-cli 没有 models 子命令，live 清单只能走端点 HTTP —— 排查顺序就围绕端点/凭据写。
const REFRESH_TIMEOUT_MS = 20000
const REFRESH_HINT = '排查顺序：① 看 ~/.codex/config.toml 的 [model_providers.<当前 provider>] 里 base_url / experimental_bearer_token（或 auth.json 的 OPENAI_BASE_URL / OPENAI_API_KEY）是否指向可用端点；② 可用 CODEX_BRIDGE_MODELS_URL / CODEX_BRIDGE_MODELS_TOKEN 临时覆盖端点与凭据；③ 再点一次「拉取可用模型」（codex_models 默认 source=live 读的是同一份清单）。'

// ── 三工具 schema ────────────────────────────────────────────────────────────
const RUN_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The task instruction for codex. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — codex reads the repo itself). For follow-ups on the same topic, use codex_continue with latest=true or sessionId (codex keeps the thread context; state only what is new).' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows the DSH plan state; plan = read-only sandbox (no writes), accept-edits = workspace-write. Default auto. An explicit sandboxMode overrides this.' },
    model: { type: 'string', description: 'Optional codex model id (e.g. "minimax/minimax-m3.1-flash:free"). Omit to use the CLI Bridge settings default, or codex\'s own ~/.codex/config.toml model. Run codex_models first; the server rejects unknown ids with HTTP 400.' },
    sandboxMode: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Optional codex sandbox policy (-s). Overrides the mode-derived default and the settings panel value.' },
    reasoningEffort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh'], description: 'Optional model_reasoning_effort override (-c model_reasoning_effort="…"). Ignored by models that do not support it.' },
    cwd: { type: 'string', description: 'Working directory for codex (-C, and the spawn cwd). Defaults to the DSH workspace root.' },
    addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra writable directories (--add-dir). Ignored on resume (codex exec resume has no --add-dir).' },
    images: { type: 'array', items: { type: 'string' }, description: 'Image files to attach to the prompt (-i).' },
    timeoutSec: { type: 'integer', description: 'Execution timeout seconds (10-3600, default 900).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with codex_status. Set false to block for the final answer.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing codex thread. State only what is new; codex preserves the thread context.' },
    sessionId: { type: 'string', description: 'codex thread id to resume (the thread_id from a prior codex_run result).' },
    latest: { type: 'boolean', description: 'Resume the most recent codex thread in this working directory (exec resume --last) instead of a specific id.' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode; default auto. On resume codex has no -s flag, so the sandbox is applied via -c sandbox_mode="…".' },
    model: { type: 'string', description: 'Optional codex model id.' },
    sandboxMode: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'], description: 'Optional sandbox policy applied through -c sandbox_mode="…" (resume has no -s).' },
    reasoningEffort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh'], description: 'Optional model_reasoning_effort override.' },
    cwd: { type: 'string', description: 'Working directory (spawn cwd only — resume has no -C).' },
    images: { type: 'array', items: { type: 'string' }, description: 'Image files to attach (-i).' },
    timeoutSec: { type: 'integer', description: 'Execution timeout seconds (10-3600, default 900).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with codex_status. Set false to block.' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }

export default function defineProvider(deps = {}) {
  const env = deps.env || {}
  let host = null
  let settingsRef = { binPath: '', defaultModel: '', sandboxMode: '', approvalPolicy: '' }
  codexSetHost(env, deps.nodeFs || null, deps.nodePath || null)

  /**
   * 取当前生效的偏好设置（三条来源按优先级合并，每次 buildArgv 重读 —— 面板改默认
   * 模型后无需重启即生效）：
   *   1) deps.readSettings()：MCP 形态（真 Node，每次现读设置文件）；
   *   2) host.getSettings('codex')：preset/dynamic 形态（attach 注入）；
   *   3) settingsRef：attach 时固化的一次性快照 / 缺省值。
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
    } catch (e) { /* 设置读失败 = 用缺省，不影响本次调用 */ }
    try {
      if (host && typeof host.getSettings === 'function') {
        const s = host.getSettings('codex')
        if (s && typeof s === 'object') Object.assign(out, s)
      }
    } catch (e) { /* 同上 */ }
    return out
  }

  function sandboxFor(mode, args, settings) {
    if (args && args.sandboxMode && SANDBOX_MODES.indexOf(String(args.sandboxMode)) >= 0) return String(args.sandboxMode)
    if (settings && settings.sandboxMode && SANDBOX_MODES.indexOf(String(settings.sandboxMode)) >= 0) return String(settings.sandboxMode)
    // 默认与其余五家（agy/claude/mimo/codebuddy/opencode 的 skip-permissions / auto 档）对齐：
    // 不限工作区。用户明确要求「其他 CLI 要有与 agy 一样自由的权限」。
    // 此前默认 workspace-write 会导致「无权编辑工作区外」——那是 codex 唯一比别家严的地方。
    // plan 模式仍保留 read-only（plan 的语义就是不改动）。
    // 想收紧：传 args.sandboxMode，或在设置面板改「沙箱模式」。
    return mode === 'plan' ? 'read-only' : 'danger-full-access'
  }

  const descriptor = {
    id: 'codex', label: 'CODEX', presetId: 'codex-first', defaultBackend: null, defaultMode: 'auto',
    exeName: 'codex', binEnvVars: ['CODEX_BIN', 'CODEX_CLI'], unavailableStatus: 'CODEX_UNAVAILABLE',

    // 单后端：model_provider/base_url 属于 codex 自身配置，桥不引入第二后端概念。
    backends() { return null },
    normalizeBackend() { return null },
    resolveBackend(args, target, preferred) { return null },

    // 实测 flag 集（exec 与 exec resume 的可用旗不同 —— 见文件头）。
    buildArgv(exePrefix, args, opts) {
      const o = opts || {}
      const a = args || {}
      const settings = currentSettings()
      const argv = Array.isArray(exePrefix) ? exePrefix.slice() : [String(exePrefix)]
      const resume = !!(a.sessionId || a.continueLatest || a.latest === true)
      argv.push('exec')
      if (resume) {
        argv.push('resume')
        if (a.sessionId) argv.push(String(a.sessionId))
        else argv.push('--last')
      }
      // --json 是所有折叠/解析的前提；--skip-git-repo-check 让非 git 目录也能跑。
      argv.push('--json', '--skip-git-repo-check')
      // -C 只有 exec 有；resume 的 cwd 由 spawn 的 cwd 决定（实测 resume 传 -C 直接报错）。
      const cwd = a.cwd ? String(a.cwd) : null
      if (cwd && !resume) argv.push('-C', cwd)

      let mode = a.mode || 'auto'
      if (mode === 'auto') mode = o.planActive ? 'plan' : 'accept-edits'
      const sandbox = sandboxFor(mode, a, settings)
      if (resume) argv.push('-c', 'sandbox_mode="' + sandbox + '"')
      else argv.push('-s', sandbox)

      // 审批策略：非交互（-p/exec 无 TTY）场景**必须**显式给 never，否则 codex 会按自身
      // 配置（或内置默认 on-request）请求批准 —— 没人能点，进程一路挂到超时。
      // 此前这里默认留空、完全依赖用户 ~/.codex/config.toml（本机恰好写了 never 才没炸），
      // 属于隐式依赖：换台机器或用户改配置就会静默变成"每次都等批准"。
      // 现规则：用户显式配了就用；没配则 accept-edits/bypass 语义下强制 never。
      const configuredApproval = (settings && settings.approvalPolicy && APPROVAL_POLICIES.indexOf(String(settings.approvalPolicy)) >= 0)
        ? String(settings.approvalPolicy)
        : ''
      const approval = configuredApproval || (mode === 'plan' ? '' : 'never')
      // exec 没有 -a/--ask-for-approval；等价效果只能经 -c 覆盖（TOML 字符串值）。
      if (approval) argv.push('-c', 'approval_policy="' + approval + '"')

      const model = a.model || o.defaultModel || settings.defaultModel || ''
      if (model) argv.push('-m', String(model))
      if (a.reasoningEffort && REASONING_EFFORTS.indexOf(String(a.reasoningEffort)) >= 0) {
        argv.push('-c', 'model_reasoning_effort="' + String(a.reasoningEffort) + '"')
      }
      if (!resume && Array.isArray(a.addDirs)) for (const d of a.addDirs) { if (d) argv.push('--add-dir', String(d)) }
      if (Array.isArray(a.images)) for (const f of a.images) { if (f) argv.push('-i', String(f)) }
      // prompt 必须最后（位置参数）。
      argv.push(String(a.prompt))
      const timeoutSec = clampInt(a.timeoutSec, 900, 10, 3600)
      return { argv, mode, timeoutSec }
    },

    // NDJSON（--json）。宽容：坏行跳过；无任何 JSON 行返回 null（交 buildResult 走纯文本）。
    // 终止判据 = turn.completed + 退出码 0；顶层 error / turn.failed 才算致命。
    // ⚠️ item.completed 里 item.type==="error" 只是告警（实测续聊会带），绝不致命。
    parseJson(stdoutText) {
      const trimmed = String(stdoutText || '').trim()
      if (!trimmed) return null
      let sawJson = false
      let threadId = null
      let response = ''
      let usage = null
      let completed = false
      let fatal = null
      let turns = 0
      for (const raw of trimmed.split(/\r?\n/)) {
        const ln = raw.trim()
        if (ln.charAt(0) !== '{') continue
        let ev
        try { ev = JSON.parse(ln) } catch (e) { continue }
        if (!ev || typeof ev !== 'object') continue
        sawJson = true
        const t = ev.type
        if (t === 'thread.started') {
          if (typeof ev.thread_id === 'string') threadId = ev.thread_id
        } else if (t === 'turn.started') {
          turns += 1
        } else if (t === 'turn.completed') {
          completed = true
          if (ev.usage && typeof ev.usage === 'object') usage = ev.usage
        } else if (t === 'turn.failed') {
          const msg = ev.error && typeof ev.error.message === 'string' ? ev.error.message
            : (typeof ev.error === 'string' ? ev.error : 'turn failed')
          fatal = { message: msg }
        } else if (t === 'error') {
          // 顶层 error 事件：message 常常是嵌套 JSON 字符串（实测）。
          fatal = { message: typeof ev.message === 'string' ? ev.message : 'error event' }
        } else if (t === 'item.completed' && ev.item && typeof ev.item === 'object') {
          if (ev.item.type === 'agent_message' && typeof ev.item.text === 'string') response = ev.item.text
        }
      }
      if (!sawJson) return null
      return {
        type: completed ? 'turn.completed' : (fatal ? 'turn.failed' : 'incomplete'),
        threadId: threadId || null,
        response: String(response || ''),
        usage: usage || null,
        completed: completed,
        error: fatal,
        numTurns: turns || null
      }
    },

    // 统一结果对象（契约 §1）。成功必须同时满足：退出码 0 + 收到 turn.completed +
    // 无顶层错误事件。只看退出码不够（实测 400 时 stdout 仍是合法事件流，退出码 1）。
    buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
      const exitCode = outcome ? outcome.exitCode : null
      const stderr = stderrText ? String(stderrText).slice(-2000) : ''
      const mk = (over) => Object.assign({
        ok: false, status: 'ERROR', response: '', sessionId: null, durationSeconds: null,
        numTurns: null, totalTokens: null, duration: null, exitCode, mode, backend: backend || null, stderr
      }, over)
      const usageOf = (u) => {
        if (!u || typeof u !== 'object') return null
        const i = Number(u.input_tokens) || 0
        const o = Number(u.output_tokens) || 0
        return (i + o) > 0 ? i + o : null
      }
      if (parsed && typeof parsed === 'object') {
        const sessionId = parsed.threadId || null
        const totalTokens = usageOf(parsed.usage)
        if (parsed.error) {
          const msg = String(parsed.error.message || 'turn failed')
          return mk({
            status: 'TURN_FAILED', response: parsed.response || '', sessionId,
            numTurns: parsed.numTurns, totalTokens, errorMessage: msg,
            stderr: (stderr ? stderr + ' ' : '') + msg
          })
        }
        if (exitCode === 0 && parsed.completed) {
          return {
            ok: true, status: 'SUCCESS', response: parsed.response || '', sessionId,
            durationSeconds: null, numTurns: parsed.numTurns || 1, totalTokens,
            exitCode, mode, backend: backend || null, stderr
          }
        }
        if (exitCode === 0) {
          return mk({
            status: 'INCOMPLETE', response: parsed.response || '', sessionId, totalTokens,
            numTurns: parsed.numTurns,
            stderr: (stderr ? stderr + ' ' : '') + 'codex event stream ended without turn.completed (process exited 0). The run may have been interrupted; retry, and check `codex --version` if it persists.'
          })
        }
        return mk({
          status: exitCode === 2 ? 'BAD_ARGS' : 'ERROR',
          response: parsed.response || '', sessionId, numTurns: parsed.numTurns, totalTokens,
          stderr: (stderr ? stderr + ' ' : '') + 'codex exited ' + exitCode
        })
      }
      const text = String(stdoutText || '').trim()
      if (exitCode === 0) {
        return {
          ok: true, status: 'SUCCESS', response: text, sessionId: null,
          durationSeconds: null, numTurns: null, totalTokens: null, exitCode, mode,
          backend: backend || null, stderr
        }
      }
      return mk({
        status: exitCode === 2 ? 'BAD_ARGS' : 'ERROR',
        response: '',
        stderr: stderr || ('codex exited ' + exitCode),
        rawStdout: text.slice(-2000)
      })
    },

    // 实时步骤折叠（写 project.current/trail）。事件形态见文件头。
    // item 类型实测：command_execution / reasoning / agent_message / error(告警) /
    // file_change / mcp_tool_call / web_search —— 未知类型也按通用形态记账，绝不吞事件。
    foldStreamEvent(ev, p, summarizeArgs, maxArgLen, maxTrail) {
      if (!ev || typeof ev !== 'object') return
      const t = ev.type
      if (!t) return
      p.updatedAt = Date.now()
      const cap = maxTrail || 12
      const capLen = maxArgLen || 120
      const pushTrail = (entry) => { p.trail.push(entry); if (p.trail.length > cap) p.trail.shift() }
      if (t === 'thread.started') {
        p.current = { tool: 'session', args: { thread_id: String(ev.thread_id || '').slice(0, capLen) }, stepIndex: p.trail.length, since: nowIso() }
        return
      }
      if (t === 'turn.completed' || t === 'turn.failed') { p.current = null; return }
      if (t === 'error') {
        pushTrail({ stepIndex: p.trail.length, state: 'ERROR', tool: 'error', args: { message: String(ev.message || '').slice(0, capLen) }, at: nowIso() })
        p.current = null
        return
      }
      if (t !== 'item.started' && t !== 'item.completed') return
      const item = ev.item && typeof ev.item === 'object' ? ev.item : null
      if (!item) return
      const kind = String(item.type || 'item')
      const failed = kind === 'error' || item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0)
      const state = t === 'item.started' ? 'ACTIVE' : (failed ? 'ERROR' : 'DONE')
      let tool = kind
      let args = null
      if (kind === 'command_execution') {
        tool = 'command'
        args = summarizeArgs({ command: item.command })
      } else if (kind === 'agent_message') {
        tool = 'agent_response'
        args = { text_delta: String(item.text || '').slice(0, capLen) }
      } else if (kind === 'reasoning') {
        tool = 'reasoning'
        args = { text_delta: String(item.text || item.summary || '').slice(0, capLen) }
      } else if (kind === 'file_change') {
        tool = 'file_change'
        const changes = Array.isArray(item.changes) ? item.changes.map((c) => (c && (c.path || c.file)) || '').filter(Boolean) : []
        args = summarizeArgs({ paths: changes.slice(0, 6) })
      } else if (kind === 'mcp_tool_call') {
        tool = 'mcp:' + String(item.server || '?') + '/' + String(item.tool || item.name || '?')
        args = summarizeArgs(item.arguments || null)
      } else if (kind === 'web_search') {
        tool = 'web_search'
        args = summarizeArgs({ query: item.query })
      } else if (kind === 'error') {
        tool = 'warning'
        args = { message: String(item.message || '').slice(0, capLen) }
      } else {
        args = summarizeArgs({ type: kind })
      }
      const key = item.id ? String(item.id) : null
      p.codexByItem = p.codexByItem || Object.create(null)
      const prior = key ? p.codexByItem[key] : null
      if (prior) {
        prior.state = state
        if (key) delete p.codexByItem[key]
        if (p.current && p.current.itemKey === key) p.current = null
        return
      }
      const entry = { stepIndex: p.trail.length, state, tool, args: args || null, at: nowIso() }
      pushTrail(entry)
      if (t === 'item.started') {
        if (key) p.codexByItem[key] = entry
        p.current = { tool, args: args || null, stepIndex: entry.stepIndex, since: nowIso(), itemKey: key }
      }
    },

    // 瞬时错误重试：codex 自己会重试网络，这里只兜「流断了但非限流」这一类。
    isTransientCliError(res) {
      if (!res || res.ok) return false
      if (isLimited(res)) return false
      if (res.status === 'INCOMPLETE') return true
      const hay = String(res.errorMessage || '') + ' ' + String(res.stderr || '')
      return /stream disconnected|connection reset|ECONNRESET|ETIMEDOUT|temporarily unavailable|overloaded|try again/i.test(hay)
    },

    failureHint(res) {
      if (!res || res.ok) return ''
      const st = String(res.status || '')
      if (st === 'CODEX_UNAVAILABLE') return '[诊断] 未找到 codex 可执行文件：请安装 Codex CLI，或在 CLI Bridge 设置面板填写 codex 可执行文件路径（也可设 CODEX_BIN）。'
      if (st === 'BAD_ARGS') return '[诊断] codex 拒绝了参数（exit 2）：请检查 model/sandboxMode 等取值；codex_models 可列出可用模型 id。'
      const hay = String(res.stderr || '') + ' ' + String(res.errorMessage || '') + ' ' + String(res.response || '')
      if (/not logged in|please run.*login|unauthorized|invalid api key|401|403/i.test(hay) && !/rate.?limit|quota|限流|额度/i.test(hay)) {
        return '[诊断] codex 凭据问题（未登录 / API key 无效）：请让用户执行 `codex login`，或检查 ~/.codex/config.toml 里 model_providers.<name> 的 base_url 与 experimental_bearer_token。这不是限流。'
      }
      if (/not a valid model|invalid model|model not found|unknown model|unsupported model/i.test(hay)) {
        return '[诊断] 模型 id 不被服务端接受：先用 codex_models（默认 source=live）列出该端点真实可用的 id，再传 model。注意 ~/.codex/models.json 与 model_catalog_json 只是本地目录，不代表服务端可用。'
      }
      if (/not inside a trusted directory|not a git repository|skip-git-repo-check/i.test(hay)) {
        return '[诊断] codex 拒绝了当前工作目录（非 git 仓库）：本桥已默认加 --skip-git-repo-check；若仍出现，说明 argv 被外部改写，请检查 buildArgv。'
      }
      if (/approval|sandbox|permission denied|operation not permitted/i.test(hay)) {
        return '[诊断] 沙箱/审批拒绝了操作：非交互 exec 无法弹出审批，请调高 sandboxMode（workspace-write → danger-full-access）或在设置面板改「沙箱策略」，然后重跑。'
      }
      if (/quota|额度|rate.?limit|insufficient|credit|balance|402/i.test(hay)) {
        return '[诊断] 端点额度可能耗尽：换一个（优先 :free）模型，或改用原生工具完成本任务；不要循环重试。'
      }
      return ''
    },

    isSuccessStatus(st) { return st === 'SUCCESS' },

    tools: {
      run: { name: 'codex_run', description: 'Dispatch a coding/build/debug/investigation task to the local OpenAI Codex CLI and return its final answer. Prefer this for implementation, edits, refactors, multi-file investigation and debugging in every mode. DSH fully controls codex: it always runs non-interactively (`codex exec --json`, approvals cannot block). Use read-only native tools only for quick lookups and for final build/test verification. In mode=auto the DSH plan state decides the sandbox (plan → read-only, otherwise workspace-write). Runs in the background by default (returns a jobId immediately; collect with job_output, watch progress with codex_status); set background=false to block for the final answer.', inputSchema: RUN_PARAMS },
      continue: { name: 'codex_continue', description: 'Continue an existing codex thread with a follow-up prompt, reusing codex context (`codex exec resume`). Pass sessionId (the thread_id from a prior codex_run result), or set latest=true to resume the most recent thread in this working directory. codex exec resume has no -C/-s, so the sandbox is applied via -c and the working directory comes from the bridge session registry. Same DSH-controlled, no-prompt execution as codex_run.', inputSchema: CONTINUE_PARAMS },
      status: { name: 'codex_status', description: 'Read a live snapshot of what the local codex agent is currently doing. Returns one section per project (working directory): running count, the current step (the command/text being produced, from the --json event stream), the recent step trail (commands, file changes, messages, errors), and the last completed run status + thread id. Optional cwd filters to a single project. Call this to check on an in-flight codex_run/codex_continue without waiting for it to finish.', inputSchema: STATUS_PARAMS }
    },

    // codex_models：宿主有 spawn/fetch 能力时注册（preset 注入 deps.process / MCP 注入
    // deps.nodeChild；dynamic 沙箱形态省略 —— 与 agy/opencode 同约定）。
    extraTools: (deps.process || deps.nodeChild || typeof deps.fetch === 'function')
      ? [codexModelsTool({ env, deps })]
      : [],

    settings: {
      keys: ['binPath', 'defaultModel', 'sandboxMode', 'approvalPolicy'],
      defaults: () => ({ binPath: '', defaultModel: '', sandboxMode: '', approvalPolicy: '' }),
      normalize: (raw) => {
        const r = raw && typeof raw === 'object' ? raw : {}
        const pick = (v) => (typeof v === 'string' ? String(v).trim() : '')
        const sandbox = pick(r.sandboxMode)
        const approval = pick(r.approvalPolicy)
        return {
          binPath: pick(r.binPath),
          defaultModel: pick(r.defaultModel),
          sandboxMode: SANDBOX_MODES.indexOf(sandbox) >= 0 ? sandbox : '',
          approvalPolicy: APPROVAL_POLICIES.indexOf(approval) >= 0 ? approval : ''
        }
      },
      // 面板是同步回调，且**不再自动探测**（契约 §3.2）：defaultModel 的候选只来自
      // 已缓存的 live 清单（codexCachedModelOptions 纯读，不 spawnSync、不发请求）。
      // 探测由用户点「拉取可用模型」→ settings.refreshModels() 显式触发。
      meta: (env2) => {
        const e = env2 && typeof env2 === 'object' ? env2 : env
        const opts = codexCachedModelOptions(e)
        const exeCandidates = codexExeCandidates(e)
        return {
          titleSuffix: 'Codex',
          fields: [
            {
              key: 'binPath', label: 'codex 可执行文件路径', type: 'select', allowCustom: true,
              options: exeCandidates.map((p) => ({ value: p, label: p })),
              placeholder: '留空 = CODEX_BIN / CODEX_CLI / PATH 的 codex',
              note: '留空即按 env › PATH 顺序解析；填 .mjs/.js 会经 node 启动（测试夹具形态）。'
            },
            {
              key: 'defaultModel', label: '默认模型', type: 'select', allowCustom: true,
              options: opts.options,
              // 面板据此渲染「手动拉取」按钮（契约 §3.2）；meta() 自身永不探测。
              refresh: { label: '拉取可用模型' },
              placeholder: '留空 = 由 ~/.codex/config.toml 的 model 决定',
              note: opts.note
            },
            {
              key: 'sandboxMode', label: '沙箱策略', type: 'select',
              options: [
                { value: '', label: '（跟随 mode：非 plan 一律 danger-full-access）' },
                { value: 'read-only', label: 'read-only（只读）' },
                { value: 'workspace-write', label: 'workspace-write（仅可写工作目录内）' },
                { value: 'danger-full-access', label: 'danger-full-access（无限制，默认）' }
              ],
              note: '对应 codex 的 -s；续聊（resume）没有 -s，改经 -c sandbox_mode 生效。默认 danger-full-access，与其余五家（agy/claude/mimo/codebuddy/opencode 的 skip-permissions / auto 档）一致；想收紧就选 workspace-write —— 那会禁止写工作目录之外的文件。'
            },
            {
              key: 'approvalPolicy', label: '审批策略', type: 'select',
              options: [
                { value: '', label: '（不覆盖，用 codex 自身 config）' },
                { value: 'never', label: 'never（从不审批，推荐）' },
                { value: 'on-request', label: 'on-request' },
                { value: 'on-failure', label: 'on-failure' },
                { value: 'untrusted', label: 'untrusted' }
              ],
              note: '经 -c approval_policy="…" 传入 —— codex exec 没有 -a 旗（实测报 unexpected argument）。非交互场景建议 never。'
            }
          ]
        }
      },
      /**
       * 手动拉取（契约 §3.2）：面板「拉取可用模型」按钮 → keystone
       * POST /cli-bridge/settings/models → 这里。这是本 provider 唯一的面板探测入口。
       *
       * 复用 codexLiveModels（工具面同一个实现：GET {base_url}/models + Bearer），不写第二套；
       * 成功时它已把 payload 写回 CODEX_MODEL_CACHE，随后 meta() 直接命中。
       * 铁律：失败 = ok:false + 可操作错误 + 空 ids；绝不返回 {ok:true, ids:[]}，
       * 也绝不把 catalog/builtin（本地目录、非权威）混进这份「服务端可用清单」。
       */
      async refreshModels(settings, env2) {
        const e = (env2 && typeof env2 === 'object') ? env2 : env
        const res = await codexLiveModels(e, {
          refresh: true,
          fetch: deps.fetch,
          timeoutMs: REFRESH_TIMEOUT_MS
        })
        if (!res.ok) {
          return { ok: false, ids: [], source: 'live', error: String(res.error || 'live model list unavailable') + ' ' + REFRESH_HINT }
        }
        const ids = []
        const labels = {}
        for (const m of res.models || []) {
          if (!m || !m.id || ids.indexOf(m.id) >= 0) continue
          ids.push(m.id)
          labels[m.id] = m.free ? m.id + '  [free]' : m.id
        }
        if (!ids.length) {
          // 拿到 2xx 却没有任何可用 id：显式失败，绝不把空清单当成功（本项目 0.2.6~0.2.9 的坑）。
          return { ok: false, ids: [], source: 'live', error: '端点 ' + String(res.url || '') + ' 返回 0 个可用模型 id（响应已解析但没有可用项）。' + REFRESH_HINT }
        }
        return { ok: true, ids, labels, source: 'live' }
      },

      diagnose: (settings, env2) => {
        const s = settings && typeof settings === 'object' ? settings : {}
        const e = env2 && typeof env2 === 'object' ? env2 : env
        const bits = []
        bits.push(s.binPath ? 'bin=设置:' + s.binPath : 'bin=' + codexExeCandidates(e)[0])
        bits.push(s.defaultModel ? 'model=' + s.defaultModel : 'model=(codex config 自决)')
        const ep = codexModelsEndpoint(e)
        if (ep.ok) {
          const cached = codexCachedLiveModels(e)
          bits.push('endpoint=' + endpointHost(ep.url) + (cached && cached.ok ? ' live=' + cached.count : ' live=未缓存'))
        } else bits.push('endpoint=未配置')
        bits.push('sandbox=' + (s.sandboxMode || 'mode 派生'))
        bits.push('approval=' + (s.approvalPolicy || 'codex config'))
        const cfg = codexReadConfig(e)
        if (cfg.model) bits.push('cfg.model=' + cfg.model)
        bits.push('home=' + (codexHomeDir(e) || '?'))
        return bits.join(' · ')
      }
    },

    mcp: { version: '0.2.8' }
  }

  // 三形态共用的工具逻辑（kit 的 coreExecute 负责 jobs/超时/回退/瞬时重试）。
  descriptor.runToolLogic = async function (args, exec) {
    const a = args || {}
    const normalized = a.background === undefined ? Object.assign({}, a, { background: true }) : a
    return this.runner.coreExecute(normalized, exec)
  }
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = {
      prompt: a.prompt, model: a.model, mode: a.mode, sandboxMode: a.sandboxMode,
      reasoningEffort: a.reasoningEffort, cwd: a.cwd, images: a.images,
      timeoutSec: a.timeoutSec,
      background: a.background === undefined ? true : a.background
    }
    if (a.sessionId) mapped.sessionId = String(a.sessionId)
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

  // MCP/测试形态复用同一套模型读取（与 extraTools 同源，避免两处实现漂移）。
  descriptor.listModels = async function (args) {
    return codexModelsTool({ env, deps }).logic(args || {})
  }
  descriptor.liveModels = codexLiveModels
  descriptor.catalogModels = codexCatalogModels
  descriptor.builtinModels = codexBuiltinModels

  descriptor.attach = function (hostOpts) {
    host = hostOpts || {}
    codexSetHost(env, deps.nodeFs || null, deps.nodePath || null)
    try {
      if (typeof host.getSettings === 'function') {
        const s = host.getSettings('codex')
        if (s && typeof s === 'object') settingsRef = descriptor.settings.normalize(s)
      }
    } catch (e) { /* 设置缺省不影响装配 */ }
    this.engine = createStatusEngine({ provider: this, publish: host.publish })
    const runner = createRunner(Object.assign({}, host, { provider: this, engine: this.engine }))
    this.runner = runner
    return runner
  }
  return descriptor
}
