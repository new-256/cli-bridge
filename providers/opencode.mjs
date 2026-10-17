// providers/opencode.mjs — opencode provider descriptor（第四家 CLI，无旧包可迁）。
//
// 基线 = 本机实测 OpenCode V2 CLI v2.0.29（桌面版自带 opencode-cli.exe）+ 源码 emit 全集。
// 完整 CLI 事实表见 docs/HANDOVER.md §13；这里只留写代码时最容易踩的几条：
//   • 非交互 = `opencode run "<prompt>"`，prompt 是【位置参数】（run 子命令无 --prompt；
//     `-p` 是 --password）。`--format json` → NDJSON。`--auto` = 自动批准权限。
//   • ⚠️ V2 无 --dir（cwd 靠 spawn）、无 --variant（并入 --model#variant）。
//   • 退出码才是成败判据：0 成功 / 1 错误 / 130 SIGINT。
//   • ⚠️ 无 result/complete/init 事件；type 全集 = step_start/text/reasoning/tool_use/
//     step_finish/error。文本在 part.text，统计在 step_finish.part —— 两者是不同事件。
//
// 红线（PROVIDER-CONTRACT.md §8 + §1）：
//  - 本文件会被 build 内联进 dynamic 沙箱（new Function）：绝不出现 import.meta 字面量；
//    process 只经 deps 注入或 typeof 守卫读取；宿主能力全部走 deps/attach(hostOpts)。
//  - 只允许 import '../core/bridge-kit.mjs'。
import { createStatusEngine, createRunner, clampInt, isLimited } from '../core/bridge-kit.mjs'
import { candidateExePaths, EXE_BASENAMES } from './opencode-exe.mjs'
export { candidateExePaths }

function nowIso() { return new Date().toISOString() }

// ── 可执行文件解析（env > 桌面版已知路径 > PATH）───────────────────────────────
// 二进制名是 opencode-cli.exe（不是 opencode.exe）：V2 桌面版自带，且 V1/V2 不能并存
// 安装（官方原话），故不做「opencode.exe 兜底」以免误命中另一个版本。
// 桌面版各版本目录形如 ...\ai.opencode.desktop\cli\<ver>-<arch>\opencode-cli.exe。

function schedBuiltin(name) {
  try {
    const proc = globalThis.process
    return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
  } catch (e) { return null }
}

/**
 * 探测本机 opencode 可执行文件候选路径（优先桌面版 V2）。
 * 纯函数、零副作用；无 fs 能力时返回空数组 —— 由调用方退回 PATH 查找。
 * @param {object} env 环境变量（读 APPDATA / LOCALAPPDATA / PROGRAMFILES / HOME）
 */
export function resolveExePrefix(env, binPath) {
  const e = env || {}
  const bin = binPath || e.OPENCODE_BIN || e.OPENCODE_CLI || ''
  if (bin) {
    if (/\.(mjs|cjs|js)$/i.test(bin)) {
      const proc = globalThis.process
      const node = (proc && proc.execPath) ? proc.execPath : 'node'
      return [node, bin]
    }
    return [String(bin)]
  }
  const found = candidateExePaths(e)
  if (found.length) return [found[0]]
  return [EXE_BASENAMES[0]]
}

// ── 模型列表（`opencode models`；纯文本每行 provider/model）─────────────────────
// 同步版给 settings.meta（面板下拉）；异步版给 MCP 工具。解析宽容：只认
// provider/model 形态的行，其余（表头/说明/空行）一律丢弃。
const MODEL_LINE_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.#@+-]+)$/

export function parseModelList(text) {
  const out = []
  const seen = Object.create(null)
  for (const raw of String(text || '').split(/\r?\n/)) {
    const ln = raw.trim()
    if (!ln) continue
    const m = ln.match(MODEL_LINE_RE)
    if (!m) continue
    const id = m[1] + '/' + m[2]
    if (seen[id]) continue
    seen[id] = true
    out.push({ id: id, provider: m[1], name: m[2], free: /(-free$|free)/i.test(m[2]) })
  }
  return out
}

/**
 * 同步抓取模型列表（供设置面板下拉）。失败返回空数组 —— 下拉退化为自由输入，
 * 绝不因探测失败影响面板渲染。仅 spawnSync 可用时生效（宿主形态）。
 */
export function fetchModelsSync(env, binPath, timeoutMs) {
  try {
    const child = schedBuiltin('node:child_process')
    if (!child || typeof child.spawnSync !== 'function') return []
    const prefix = resolveExePrefix(env, binPath)
    const r = child.spawnSync(prefix[0], prefix.slice(1).concat(['models']), {
      encoding: 'utf8', timeout: clampInt(timeoutMs, 8000, 1000, 30000),
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    if (!r || r.error || r.status !== 0) return []
    return parseModelList(String(r.stdout || ''))
  } catch (e) { return [] }
}

// ── 三工具 schema ────────────────────────────────────────────────────────────
const RUN_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The task instruction for opencode. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — opencode reads the repo itself). For follow-ups on the same topic, use opencode_continue with latest=true or sessionId (opencode keeps session context; state only what is new).' },
    model: { type: 'string', description: 'Optional model in provider/model form (e.g. "opencode/big-pickle"). Prefer a -free model when the task does not need a frontier model. Omit to use the model chosen in the CLI Bridge settings panel, or (if unset there) opencode\'s own default.' },
    agent: { type: 'string', description: 'Optional opencode agent name (primary agents only; subagent names are rejected by opencode itself).' },
    cwd: { type: 'string', description: 'Working directory for opencode. Defaults to the DSH workspace root.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths to attach to the message.' },
    title: { type: 'string', description: 'Optional session title (opencode truncates the prompt when omitted).' },
    timeoutSec: { type: 'integer', description: 'Execution timeout seconds (10-3600, default 600).' },
    autoApprove: { type: 'boolean', description: 'Default true: pass --auto so opencode auto-approves permissions and never blocks on a prompt. Set false to require explicit approval (opencode may then block and hit the timeout).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with opencode_status. Set false to block for the final answer.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing opencode session. State only what is new; opencode preserves its session context.' },
    sessionId: { type: 'string', description: 'opencode session id to continue (from a prior opencode_run result).' },
    latest: { type: 'boolean', description: 'Continue the most recent opencode session instead of a specific id.' },
    model: { type: 'string', description: 'Optional model in provider/model form.' },
    agent: { type: 'string', description: 'Optional opencode agent name.' },
    cwd: { type: 'string', description: 'Working directory for opencode.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths to attach.' },
    timeoutSec: { type: 'integer', description: 'Execution timeout seconds (10-3600, default 600).' },
    autoApprove: { type: 'boolean', description: 'Default true: pass --auto. Set false to require explicit approval.' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with opencode_status. Set false to block for the final answer.' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }

// opencode_models（附加工具）：列出本机 opencode 可用模型（免费模型优先展示）。
const MODELS_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    freeOnly: { type: 'boolean', description: 'Return only free models (id ends with -free). Default false = all.' },
    provider: { type: 'string', description: 'Optional provider filter, e.g. "opencode" or "opencode-go".' }
  }
}
const MODELS_DESCRIPTION = 'List the models available to the local opencode CLI (from `opencode models`). Returns { ok, models: [{id, provider, name, free}], count }. Use this to pick a model before opencode_run, or to check which models are free. Prefer a -free model for routine work and reserve paid/frontier models for tasks that genuinely need them. If the CLI is missing or not logged in, this returns ok:false with an actionable error — it never silently invents a model list.'

function renderModels(value) {
  const v = value || {}
  if (!v.ok) return [{ type: 'text', text: 'opencode_models failed: ' + String(v.error || 'unknown') }]
  const list = Array.isArray(v.models) ? v.models : []
  if (!list.length) return [{ type: 'text', text: 'opencode_models: no models returned' }]
  const lines = ['opencode models (' + list.length + '):']
  for (const m of list.slice(0, 40)) lines.push('  ' + m.id + (m.free ? '  [free]' : ''))
  if (list.length > 40) lines.push('  … and ' + (list.length - 40) + ' more')
  const free = list.filter((m) => m.free).length
  lines.push('free: ' + free + ' / ' + list.length)
  return [{ type: 'text', text: lines.join('\n') }]
}

export default function defineProvider(deps = {}) {
  const env = deps.env || {}
  let host = null
  let settingsRef = { binPath: '', defaultModel: '', defaultAgent: '' }

  /**
   * 取当前生效的偏好设置。三条来源按优先级合并，每次 buildArgv 都重新读 ——
   * 面板改默认模型后无需重启即生效：
   *   1) `host.getSettings('opencode')` —— preset/dynamic 形态（attach 时由宿主注入）；
   *   2) `deps.readSettings()` —— MCP 形态（真 Node 进程，每次现读设置文件）；
   *   3) `settingsRef` —— attach 时固化的一次性快照 / 缺省值。
   * 三条都拿不到 → 缺省空值（= 不传 --model，交给 opencode 自身配置决定）。
   *
   * 历史坑：MCP 形态不 attach（自建 engine），只认 host.getSettings 会让面板设置的
   * defaultModel 在 MCP 面对 opencode_run 完全失效 —— 只有 args.model 才落地。
   * 三个形态行为不一致是缺陷，故此处统一把 readSettings 纳入（与 mimo 同构）。
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
        const s = host.getSettings('opencode')
        if (s && typeof s === 'object') Object.assign(out, s)
      }
    } catch (e) { }
    return out
  }

  const descriptor = {
    id: 'opencode', label: 'OPENCODE', presetId: 'opencode-first', defaultBackend: null, defaultMode: 'auto',
    exeName: 'opencode-cli', binEnvVars: ['OPENCODE_BIN', 'OPENCODE_CLI'], unavailableStatus: 'OPENCODE_UNAVAILABLE',

    // 单后端：opencode 自身选择 provider/model，桥不引入第二后端概念。
    backends() { return null },
    normalizeBackend() { return null },
    resolveBackend(args, target, preferred) { return null },

    // 实测 flag 集（V2.0.29）。
    buildArgv(exePrefix, args, opts) {
      const o = opts || {}
      const argv = Array.isArray(exePrefix) ? exePrefix.slice() : [String(exePrefix)]
      argv.push('run', String(args.prompt), '--format', 'json')
      if (args.autoApprove !== false) argv.push('--auto')
      const timeoutSec = clampInt(args.timeoutSec, 600, 10, 3600)
      // 模型优先级：调用参数 > 设置面板 defaultModel > 不传（交给 opencode 自身默认）。
      // 用户要求「不设默认 → 由 opencode 自决」，故 settingsRef.defaultModel 为空时不落地 --model。
      const model = args.model || currentSettings().defaultModel || ''
      if (model) argv.push('--model', String(model))
      const agent = args.agent || currentSettings().defaultAgent || ''
      if (agent) argv.push('--agent', String(agent))
      if (args.title) argv.push('--title', String(args.title))
      if (Array.isArray(args.files)) for (const f of args.files) { if (f) argv.push('--file', String(f)) }
      if (args.sessionId) argv.push('--session', String(args.sessionId))
      else if (args.continueLatest) argv.push('--continue')
      return { argv, mode: 'auto', timeoutSec }
    },

    // JSONL（每行一个 JSON 对象）。事件 type 取自 CLI 源码 emit 全集（实测一致）：
    // step_start / text / reasoning / tool_use / step_finish / error。
    // ⚠️ 不存在 result/complete/init 事件 —— 终止判据是「进程退出码」，不是某个终态事件。
    // ⚠️ 文本与统计在【不同】事件里：text.part.text 是回复正文，step_finish.part 只有
    //    cost/tokens。若直接取 step_finish 会得到「成功但正文为空」的结果。
    // ⚠️ 因此必须【正向】扫完整个流再决策：倒序会在读到 text 之前就命中末尾的
    //    step_finish 并返回，回填永远为空（第一版实现的真实 bug）。
    //   实测一次真实调用只产生 step_start + text（无 step_finish）—— 末段 text 兜底
    //   是活的必经分支，不是死代码。
    // 决策优先级：error > step_finish > 末段 text > 末条事件；命中前两者时把末段文本
    // 回填进 part.text，让 buildResult 统一从 part.text 读正文。
    // 无 JSON 时返回 null，由 buildResult 走纯文本兜底（绝不假造 status）。
    parseJson(stdoutText) {
      const trimmed = String(stdoutText || '').trim()
      if (!trimmed) return null
      const lines = trimmed.split(/\r?\n/).filter(Boolean)
      let lastText = null
      let lastTextStr = ''
      let terminal = null
      let fallback = null
      for (const raw of lines) {
        const ln = raw.trim()
        if (!ln.startsWith('{')) continue
        let obj
        try { obj = JSON.parse(ln) } catch (e) { continue }
        if (!obj || typeof obj !== 'object') continue
        const part = obj.part && typeof obj.part === 'object' ? obj.part : null
        if (obj.type === 'text' && part && typeof part.text === 'string') {
          lastText = obj
          lastTextStr = part.text
        } else if (obj.type === 'error') {
          terminal = obj
        } else if (obj.type === 'step_finish') {
          if (!terminal || terminal.type !== 'error') terminal = obj
        }
        fallback = obj
      }
      if (terminal) {
        const part = terminal.part && typeof terminal.part === 'object' ? terminal.part : null
        if (lastTextStr && !(part && typeof part.text === 'string')) {
          terminal.part = Object.assign({}, part || {}, { text: lastTextStr })
        }
        return terminal
      }
      return lastText || fallback
    },

    // 统一结果对象（契约 §1 buildResult 行）。
    // 事件负载一律在 part 里（CLI emit: {type,timestamp,sessionID,...data}，data = {part}）。
    // 终止判据 = exit code（0 成功 / 1 错误 / 130 SIGINT），不存在 result 事件可依赖。
    buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
      const exitCode = outcome ? outcome.exitCode : null
      const stderr = stderrText ? String(stderrText).slice(-2000) : ''
      if (parsed && typeof parsed === 'object') {
        const sessionId = typeof parsed.sessionID === 'string' ? parsed.sessionID
          : (typeof parsed.sessionId === 'string' ? parsed.sessionId : null)
        const part = parsed.part && typeof parsed.part === 'object' ? parsed.part : {}
        const errObj = parsed.error && typeof parsed.error === 'object' ? parsed.error : null
        const dataObj = errObj && errObj.data && typeof errObj.data === 'object' ? errObj.data : null
        const errMsg = dataObj && typeof dataObj.message === 'string' ? dataObj.message
          : (errObj && typeof errObj.message === 'string' ? errObj.message
            : (typeof parsed.error === 'string' ? parsed.error : ''))
        let response = ''
        if (typeof part.text === 'string') response = part.text
        else if (typeof parsed.response === 'string') response = parsed.response
        const isErrorEvent = parsed.type === 'error'
        let status
        if (exitCode === 130) status = 'ABORTED'
        else if (isErrorEvent) status = 'ERROR'
        else if (typeof parsed.status === 'string') status = parsed.status
        else status = exitCode === 0 ? 'SUCCESS' : 'ERROR'
        const tokens = part.tokens && typeof part.tokens === 'object' ? part.tokens : null
        let totalTokens = null
        if (tokens) {
          if (typeof tokens.total === 'number') totalTokens = tokens.total
          else if (typeof tokens.totalTokens === 'number') totalTokens = tokens.totalTokens
          else {
            let sum = 0
            let any = false
            for (const k of Object.keys(tokens)) {
              if (typeof tokens[k] === 'number') { sum += tokens[k]; any = true }
            }
            if (any) totalTokens = sum
          }
        }
        return {
          ok: exitCode === 0 && !isErrorEvent,
          status,
          response,
          sessionId,
          durationSeconds: null,
          numTurns: null,
          totalTokens,
          exitCode, mode, backend: backend || null,
          stderr: (stderr ? stderr + ' ' : '') + errMsg,
          cost: typeof part.cost === 'number' ? part.cost : null
        }
      }
      const text = String(stdoutText || '').trim()
      return {
        ok: exitCode === 0,
        status: exitCode === 0 ? 'SUCCESS' : 'ERROR',
        response: text,
        sessionId: null,
        durationSeconds: null, numTurns: null, totalTokens: null,
        exitCode, mode, backend: backend || null, stderr,
        rawStdout: text.slice(-2000)
      }
    },

    // 实时步骤折叠（写 project.current/trail）。
    // tool_use.part = { tool:"bash", state:{status,input,output,title,time}, … }
    // text.part     = { text:"…", time:{start,end} }
    foldStreamEvent(ev, p, summarizeArgs, maxArgLen, maxTrail) {
      if (!ev || typeof ev !== 'object') return
      const type = ev.type
      if (!type) return
      const part = ev.part && typeof ev.part === 'object' ? ev.part : {}
      p.updatedAt = Date.now()
      if (type === 'tool_use') {
        const tool = part.tool || part.name || 'tool'
        const st = part.state && typeof part.state === 'object' ? part.state : {}
        const args = summarizeArgs(st.input || part.input)
        const state = st.status === 'completed' ? 'DONE' : (st.status === 'failed' ? 'ERROR' : 'ACTIVE')
        const entry = { stepIndex: p.trail.length, state: state, tool: tool, args: args || null, at: nowIso() }
        p.trail.push(entry)
        const cap = maxTrail || 12
        if (p.trail.length > cap) p.trail.shift()
        if (p.current) p.current = null
      } else if (type === 'text' || type === 'reasoning') {
        const delta = typeof part.text === 'string' ? part.text : ''
        if (!delta) return
        const capLen = maxArgLen || 120
        p.current = { tool: type === 'reasoning' ? 'reasoning' : 'agent_response', args: { text_delta: String(delta).slice(0, capLen) }, stepIndex: p.trail.length, since: nowIso() }
      } else if (type === 'step_finish') {
        if (p.current) p.current = null
      }
    },

    isTransientCliError(res) {
      if (!res || res.ok) return false
      if (isLimited(res)) return false
      return res.status === 'ERROR_DURING_EXECUTION'
    },

    failureHint(res) {
      if (!res || res.ok) return ''
      const st = String(res.status || '')
      if (st === 'OPENCODE_UNAVAILABLE') return '[诊断] 未找到 opencode 可执行文件：请安装 OpenCode（桌面版自带 CLI），或在 CLI Bridge 设置面板填写 opencode 可执行文件路径。'
      const hay = String(res.stderr || '') + ' ' + String(res.response || '')
      if (/Incorrect API key|invalid_api_key|401|unauthorized|not logged|login/i.test(hay) && !/rate.?limit|quota|限流|额度/i.test(hay)) {
        return '[诊断] opencode 凭据问题（未登录 / API key 无效）：请让用户执行 `opencode auth login` 登录 provider。这不是限流。'
      }
      if (/No models available|no models|model not found|Unknown provider|not found.*model/i.test(hay)) {
        return '[诊断] opencode 没有可用模型或模型名无效：先用 opencode_models（或 `opencode models`）列出可用模型，再传 model。'
      }
      if (/quota|额度|exhausted|insufficient|credit|balance/i.test(hay)) {
        return '[诊断] opencode 额度可能耗尽：换一个（优先 -free）模型，或改用原生工具完成本任务。'
      }
      return ''
    },

    isSuccessStatus(st) { return st === 'SUCCESS' },

    tools: {
      run: { name: 'opencode_run', description: 'Dispatch a coding/build/debug/investigation task to the local opencode agent CLI and return its final answer. Prefer this for implementation, edits, refactors, multi-file investigation and debugging in every mode. DSH fully controls opencode: it always runs non-interactively with permissions auto-approved (opencode never blocks on a prompt). Use read-only native tools only for quick lookups and for final build/test verification. Runs in the background by default (returns a jobId immediately; collect with job_output); set background=false to block for the final answer.', inputSchema: RUN_PARAMS },
      continue: { name: 'opencode_continue', description: 'Continue an existing opencode session with a follow-up prompt, reusing opencode context. Pass sessionId from a prior opencode_run result, or set latest=true to continue the most recent opencode session. Same DSH-controlled, no-prompt execution as opencode_run.', inputSchema: CONTINUE_PARAMS },
      status: { name: 'opencode_status', description: 'Read a live snapshot of what the local opencode agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or agent_response thinking/typing), the recent step trail (tools executed, done/error), and the last completed run status + session id. Optional cwd filters to a single project. Call this to check on an in-flight opencode_run/opencode_continue without waiting for it to finish.', inputSchema: STATUS_PARAMS }
    },

    // opencode_models：宿主有 spawn 能力时注册（preset 注入 deps.process / MCP 注入
    // deps.nodeChild；dynamic 沙箱形态省略）。
    extraTools: (deps.process || deps.nodeChild) ? [{
      name: 'opencode_models',
      description: MODELS_DESCRIPTION,
      inputSchema: MODELS_PARAMS,
      render: renderModels,
      async logic(args) {
        return await descriptor.listModels(args || {})
      }
    }] : [],

    /**
     * 列出可用模型（三形态共用）。真实执行 `opencode models`；
     * CLI 缺失/未登录 → { ok:false, error }（绝不凭空造列表）。
     */
    async listModels(args) {
      const a = args || {}
      const child = deps.nodeChild
      if (!child || typeof child.spawn !== 'function') {
        // preset 形态：宿主 subprocess（attach 后可用）。
        if (!(host && host.subprocess)) return { ok: false, error: 'no spawn capability in this host form' }
      }
      const prefix = resolveExePrefix(env, currentSettings().binPath)
      const argv = prefix.slice(1).concat(['models'])
      const run = child && typeof child.spawn === 'function'
        ? spawnModelsNode(child, prefix[0], argv)
        : spawnModelsHost(argv)
      let res
      try { res = await run } catch (e) { return { ok: false, error: String(e && e.message || e) } }
      if (!res.ok) return res
      let list = res.models
      if (a.provider) {
        const pv = String(a.provider).toLowerCase()
        list = list.filter((m) => String(m.provider).toLowerCase() === pv)
      }
      if (a.freeOnly) list = list.filter((m) => m.free)
      // 免费模型优先展示（用户要求：优先用性能较好的免费模型），其次按字母序。
      list.sort((x, y) => (x.free === y.free ? String(x.id).localeCompare(String(y.id)) : (x.free ? -1 : 1)))
      return { ok: true, models: list, count: list.length }
    },

    // 设置分区：用户可选「用哪个 opencode（exe 路径）」+「默认模型」+「默认 agent」。
    settings: {
      keys: ['binPath', 'defaultModel', 'defaultAgent'],
      defaults: () => ({ binPath: '', defaultModel: '', defaultAgent: '' }),
      normalize: (raw) => {
        const r = raw && typeof raw === 'object' ? raw : {}
        const out = { binPath: '', defaultModel: '', defaultAgent: '' }
        for (const k of ['binPath', 'defaultModel', 'defaultAgent']) {
          if (typeof r[k] === 'string') out[k] = String(r[k]).trim()
        }
        return out
      },
      meta: (env2) => {
        const e = env2 && typeof env2 === 'object' ? env2 : {}
        const s = currentSettings()
        // 下拉选项：实时 `opencode models`（失败则退化为空 → 面板仍可自由输入）。
        const models = fetchModelsSync(e, s.binPath, 8000)
        const options = models.map((m) => ({ value: m.id, label: m.id + (m.free ? '  [free]' : '') }))
        // 默认给「可用 exe 路径」的下拉候选（env 覆盖 > 桌面版探测）。
        const exeCandidates = []
        if (e.OPENCODE_BIN || e.OPENCODE_CLI) exeCandidates.push(String(e.OPENCODE_BIN || e.OPENCODE_CLI))
        for (const p of candidateExePaths(e)) if (exeCandidates.indexOf(p) < 0) exeCandidates.push(p)
        return {
          titleSuffix: 'OpenCode',
          fields: [
            {
              key: 'binPath', label: 'opencode 可执行文件路径', type: 'select', allowCustom: true,
              options: exeCandidates.map((p) => ({ value: p, label: p })),
              placeholder: '留空 = 自动探测桌面版 / PATH',
              note: '检测到 ' + exeCandidates.length + ' 个候选；也可手动粘贴任意路径（含 .mjs 会经 node 启动）。'
            },
            {
              key: 'defaultModel', label: '默认模型', type: 'select', allowCustom: true,
              options: options,
              placeholder: '留空 = 由 opencode 自身配置决定',
              note: options.length
                ? '共 ' + options.length + ' 个可用模型，免费模型已排在前面（[free]）。调用时传 model 可覆盖本项。'
                : '未能读取模型列表（CLI 未安装/未登录/超时）—— 仍可手动输入 provider/model。'
            },
            {
              key: 'defaultAgent', label: '默认 agent', type: 'select', allowCustom: true,
              options: [{ value: 'build', label: 'build（默认，全权限）' }, { value: 'plan', label: 'plan（只读）' }],
              placeholder: '留空 = opencode 默认 agent',
              note: 'opencode 只接受 primary agent；subagent 名会被 opencode 自身拒绝并回退。'
            }
          ]
        }
      },
      diagnose: (settings, env2) => {
        const s = settings && typeof settings === 'object' ? settings : {}
        const e = env2 && typeof env2 === 'object' ? env2 : {}
        const bits = []
        const found = candidateExePaths(e)
        if (s.binPath) bits.push('bin=设置:' + s.binPath)
        else if (e.OPENCODE_BIN || e.OPENCODE_CLI) bits.push('bin=env:' + (e.OPENCODE_BIN || e.OPENCODE_CLI))
        else if (found.length) bits.push('bin=桌面版:' + found[0].split(/[\\/]/).slice(-3).join('/'))
        else bits.push('bin=PATH:opencode-cli')
        bits.push(s.defaultModel ? 'model=' + s.defaultModel : 'model=(opencode 自决)')
        if (s.defaultAgent) bits.push('agent=' + s.defaultAgent)
        return bits.join(' · ')
      }
    },

    mcp: { version: '0.2.2' }
  }

  // MCP/测试形态：真 child_process。
  function spawnModelsNode(child, exe, argv) {
    return new Promise((resolve) => {
      let c
      try { c = child.spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
      catch (e) { resolve({ ok: false, error: 'spawn: ' + String(e && e.message || e) }); return }
      let out = ''
      let err = ''
      const timer = setTimeout(() => { try { c.kill() } catch (e) {} }, 15000)
      c.stdout.on('data', (d) => { out += d })
      c.stderr.on('data', (d) => { err += d })
      c.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: 'spawn: ' + String(e && e.message || e) }) })
      c.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) { resolve({ ok: false, error: '`opencode models` exited ' + code + ': ' + String(err || out).slice(0, 300) }); return }
        const list = parseModelList(out)
        if (!list.length) { resolve({ ok: false, error: 'no models parsed from output: ' + String(out).slice(0, 200) }); return }
        resolve({ ok: true, models: list })
      })
    })
  }

  // preset 形态：DSH subprocess。
  async function spawnModelsHost(argv) {
    try {
      const spec = { argv: [resolveExePrefix(env, currentSettings().binPath)[0]].concat(argv), stdio: { stdin: 'ignore', stdout: { maxBytes: 1000000 }, stderr: { maxBytes: 200000 } }, graceMs: 5000 }
      if (deps.process && typeof deps.process.cwd === 'function') spec.cwd = deps.process.cwd()
      const handle = host.subprocess.spawn(spec)
      const outcome = await handle.done
      const stdoutText = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
      const stderrText = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
      if (!outcome || outcome.exitCode !== 0) return { ok: false, error: '`opencode models` exited ' + (outcome && outcome.exitCode) + ': ' + String(stderrText || stdoutText).slice(0, 300) }
      const list = parseModelList(stdoutText)
      if (!list.length) return { ok: false, error: 'no models parsed from output: ' + String(stdoutText).slice(0, 200) }
      return { ok: true, models: list }
    } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  }

  descriptor.runToolLogic = async function (args, exec) {
    const a = args || {}
    const normalized = a.background === undefined ? Object.assign({}, a, { background: true }) : a
    return this.runner.coreExecute(normalized, exec)
  }
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = {
      prompt: a.prompt, model: a.model, agent: a.agent,
      cwd: a.cwd, files: a.files, timeoutSec: a.timeoutSec, autoApprove: a.autoApprove,
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
    // 宿主注入 getSettings 时才能把面板偏好带进 buildArgv（preset/dynamic 形态）。
    try {
      if (typeof host.getSettings === 'function') {
        const s = host.getSettings('opencode')
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
