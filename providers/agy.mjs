// providers/agy.mjs — agy provider descriptor（真移植，替换 Lead 冒烟占位）。
//
// 移植基线：agy-first-bridge v1.7.1 preset/agy-first/agy-first-bridge.mjs 的内联逻辑
// （buildArgv / parseAgyJson / buildResult / foldStepUpdate / 额度门禁 / 三工具 schema），
// 语义逐字保持；与 provider 无关的骨架（状态引擎/行流/回退弹窗/展示层）在
// core/bridge-kit.mjs（PROVIDER-CONTRACT.md §1）。
//
// 红线（PROVIDER-CONTRACT.md §8 + Lead 定案）：
//  - 本文件会被 build 内联进 dynamic 沙箱（new Function）：绝不出现 import.meta 字面量；
//    process 只经 deps 注入或 typeof 守卫读取；宿主能力全部走 deps/attach(hostOpts)。
//  - 只允许 import '../core/bridge-kit.mjs'。
import { createStatusEngine, createRunner, clampInt, isLimited } from '../core/bridge-kit.mjs'

// subprocess stdio 预算（与 bridge-kit createRunner 内部 stdio 一致；quota 脚本用）。
const STDIO = {
  stdin: 'ignore',
  stdout: { maxBytes: 4000000, spill: { maxBytes: 40000000 } },
  stderr: { maxBytes: 1000000, spill: { maxBytes: 8000000 } }
}

function nowIso() { return new Date().toISOString() }

// ── 三工具 schema（旧 preset verbatim；契约 §8：不许顺手改 schema）──────────────
const RUN_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The task instruction for agy. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — agy reads the repo itself). For follow-ups on the same topic, use agy_continue with latest=true or conversationId (agy keeps conversation context; state only what is new).' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows DSH plan state; plan = no writes; accept-edits = allow edits. Default auto.' },
    model: { type: 'string', description: 'Optional agy model id — pick from the Gemini pool or utility models per the model-selection policy (use agy_quota to see the recommended:true list). Do NOT pass a Claude/GPT (3p) model.' },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort.' },
    cwd: { type: 'string', description: 'Working directory for agy. Defaults to the DSH workspace root.' },
    addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to add to agy workspace.' },
    timeoutSec: { type: 'integer', description: 'Print timeout seconds (10-3600, default 600).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with agy_status. Set false to block for the final answer.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing agy conversation. State only what is new; agy preserves its conversation context.' },
    conversationId: { type: 'string', description: 'agy conversation id to resume (from a prior agy_run result).' },
    latest: { type: 'boolean', description: 'Continue the most recent agy conversation instead of a specific id.' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode; default auto.' },
    model: { type: 'string', description: 'Optional agy model id.' },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort.' },
    cwd: { type: 'string', description: 'Working directory for agy.' },
    timeoutSec: { type: 'integer', description: 'Print timeout seconds (10-3600, default 600).' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with agy_status. Set false to block for the final answer.' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }

// agy_quota（旧 preset quotaTool verbatim）：查 Google AI 套餐（Antigravity OAuth）池子额度。
const QUOTA_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { summary: { type: 'boolean', description: 'Return only a compact summary line (weekly buckets + top models).' } } }
const QUOTA_DESCRIPTION = 'Query the Google AI plan (Antigravity OAuth consumer) quota pool behind the local agy CLI. Reads the Windows credential manager entry (gemini:antigravity) that agy wrote at login, refreshes the access token, then calls Google Cloud Code quota APIs: fetchAvailableModels (per-model remaining pool percentage) and retrieveUserQuotaSummary (grouped plan buckets: weekly + 5h windows). Returns { ok, models: [{name, percentage, resetTime, displayName}], groups: [{displayName, buckets: [{bucketId, window, remainingFraction, resetTime}]}], tier }. GATING RULE: only the Gemini 5h window decides whether agy can run this task — agy_run/agy_continue already refuse silently below 10% of the 5h pool, so you normally do not need to pre-check. The weekly window is NOT a per-task gate: a drained weekly bucket only means agy is a poor choice for the rest of the week (pick another subagent or your own tools), never a reason to abort or shrink the current task. If the credential is missing the tool returns { ok:false, error } and agy_run still works normally.'

function renderQuota(args, value) {
  const v = value || {}
  if (!v.ok) return [{ type: 'text', text: 'agy_quota failed: ' + String(v.error || 'unknown') }]
  const lines = []
  lines.push('agy quota [tier=' + (v.tier || '?') + ']')
  if (Array.isArray(v.groups)) {
    for (const g of v.groups) {
      for (const b of (g.buckets || [])) {
        const pct = typeof b.remainingFraction === 'number' ? Math.round(b.remainingFraction * 100) : '?'
        lines.push('· ' + (b.bucketId || g.displayName || '') + ' [' + (b.window || '') + '] ' + pct + '%' + (b.resetTime ? ' reset=' + b.resetTime : ''))
      }
    }
  }
  if (Array.isArray(v.models) && v.models.length) {
    lines.push('models (pool %):')
    for (const m of v.models.slice(0, 10)) { lines.push('  ' + (m.displayName || m.name) + ' : ' + m.percentage + '%' + (m.recommended === false ? ' [3p: Claude/GPT 不推荐]' : '') + (m.resetTime ? ' (reset ' + m.resetTime + ')' : '')) }
    if (v.models.length > 10) lines.push('  … and ' + (v.models.length - 10) + ' more')
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

export default function defineProvider(deps = {}) {
  const env = deps.env || {}
  let host = null // attach 后保存 hostOpts（preset/dynamic 形态提供 subprocess）
  let quotaCache = { at: 0, data: null } // 30 分钟缓存（旧 cachedQuotaCheck 语义）

  // ── 额度脚本执行（bin/agy-quota.mjs）─────────────────────────────────────────
  // 脚本定位（契约 §8 + Lead 定案 4）：CLI_BRIDGE_AGY_QUOTA > AGY_QUOTA_SCRIPT（旧兼容）
  // > deps.quotaScript（preset/MCP 宿主注入）。定位不到或无 spawn 能力 = 静默跳过门禁
  // （旧语义的宽容降级）。
  function quotaScriptPath() {
    return env.CLI_BRIDGE_AGY_QUOTA || env.AGY_QUOTA_SCRIPT || deps.quotaScript || null
  }
  function quotaCapable() {
    return !!quotaScriptPath() && !!(deps.nodeChild || (host && host.subprocess))
  }
  function execQuotaScript() {
    const scriptPath = quotaScriptPath()
    if (!scriptPath) return Promise.resolve({ ok: false, error: 'quota script not found (set CLI_BRIDGE_AGY_QUOTA or install the package bin/agy-quota.mjs)' })
    const node = (deps.process && deps.process.execPath) || 'node'
    if (deps.nodeChild) {
      // MCP/测试形态：真 child_process（旧 agy-mcp-server execQuota verbatim 语义）。
      return new Promise((resolve) => {
        let child
        try { child = deps.nodeChild.spawn(node, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
        catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); return }
        let out = ''
        let err = ''
        const timer = setTimeout(() => { try { child.kill() } catch (e) {} }, 60000)
        child.stdout.on('data', (d) => { out += d })
        child.stderr.on('data', (d) => { err += d })
        child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: 'spawn: ' + String(e && e.message || e) }) })
        child.on('close', (code) => {
          clearTimeout(timer)
          const m = out.match(/\{[\s\S]*\}/)
          if (!m) { resolve({ ok: false, error: 'no JSON output (exit=' + code + '): ' + (out + ' ' + err).slice(0, 300) }); return }
          try { resolve(JSON.parse(m[0])) } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }) }
        })
      })
    }
    if (host && host.subprocess) {
      // preset 形态：DSH subprocess（旧 preset execQuotaScript verbatim 语义）。
      return (async () => {
        try {
          const spec = { argv: [node, scriptPath], stdio: STDIO, graceMs: 5000 }
          if (deps.process && typeof deps.process.cwd === 'function') spec.cwd = deps.process.cwd()
          const handle = host.subprocess.spawn(spec)
          const outcome = await handle.done
          const stdoutText = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
          const stderrText = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
          const jsonMatch = String(stdoutText || '').match(/\{[\s\S]*\}/)
          if (!jsonMatch) return { ok: false, error: 'no JSON output (exit=' + (outcome && outcome.exitCode) + '): ' + (String(stdoutText).slice(0, 200) || String(stderrText).slice(0, 200)) }
          try { return JSON.parse(jsonMatch[0]) } catch (e) { return { ok: false, error: 'parse error: ' + e.message } }
        } catch (e) { return { ok: false, error: String(e && e.message || e) } }
      })()
    }
    return Promise.resolve({ ok: false, error: 'no spawn capability in this host form' })
  }
  async function cachedQuotaCheck() {
    const now = Date.now()
    if (quotaCache.data && now - quotaCache.at < 30 * 60 * 1000) return quotaCache.data
    let res = null
    try { res = await execQuotaScript() } catch (e) { res = { ok: false, error: String(e && e.message || e) } }
    quotaCache = { at: now, data: res }
    return res
  }
  // 5h 硬阻断（旧 v1.5.13 门禁 verbatim）：Gemini 5h 桶 <10% → QUOTA_BLOCKED（静默，
  // 不弹窗）；周用量不参与单次任务判断。预检失败不阻塞调用。
  async function quotaGate5h(args, exec) {
    if (!quotaCapable()) return null
    let q = null
    try { q = await cachedQuotaCheck() } catch (e) { return null }
    if (!q || !q.ok) return null
    const fiveHBuckets = (q.groups || []).flatMap((g) =>
      (g.buckets || [])
        .filter((b) => b.window === '5h' && (String(b.bucketId || '').toLowerCase().includes('gemini') || String(g.displayName || '').toLowerCase().includes('gemini')))
        .map((b) => ({ bucketId: b.bucketId, remainingFraction: b.remainingFraction, resetTime: b.resetTime }))
    )
    const low5h = fiveHBuckets.find((b) => typeof b.remainingFraction === 'number' && b.remainingFraction < 0.10)
    if (!low5h) return null
    let mode = (args && args.mode) || 'auto'
    if (mode === 'auto') {
      let planActive = false
      try { if (host && typeof host.planActiveFor === 'function') planActive = !!host.planActiveFor(exec) } catch (e) {}
      mode = planActive ? 'plan' : 'accept-edits'
    }
    return {
      ok: false, status: 'QUOTA_BLOCKED', response: '', conversationId: null, sessionId: null,
      durationSeconds: null, numTurns: null, totalTokens: null, exitCode: null, mode, backend: null,
      stderr: 'agy blocked: Gemini 5h pool quota < 10% (' + Math.round(low5h.remainingFraction * 100) + '%, reset ' + (low5h.resetTime || '?') + '). Use native tools; do not call agy.'
    }
  }

  const descriptor = {
    id: 'agy', label: 'AGY', presetId: 'cordis-agy', defaultBackend: null, defaultMode: 'auto',
    exeName: 'agy', binEnvVars: ['AGY_BIN', 'AGY_CLI'], unavailableStatus: 'AGY_UNAVAILABLE',

    // 单后端：backends() 恒 null；'agy'/'antigravity' 是历史别名，归一为 null；
    // 非法值同样返回 null（契约 §1：非法输入返回 null）。会话路由由 engine.resolveTarget
    // 完成（agy 的 backend 恒 null）。
    backends() { return null },
    normalizeBackend(v) {
      if (v === undefined || v === null) return null
      const s = String(v).trim().toLowerCase()
      if (s === '' || s === 'agy' || s === 'antigravity') return null
      return null
    },
    resolveBackend(args, target, preferred) { return null },

    // 旧 preset buildArgv(exe, args, planActive) verbatim 语义（execPrefix 可为
    // [nodeExe, binPath] 数组，runner 已归一）。
    buildArgv(exePrefix, args, opts) {
      const o = opts || {}
      const argv = Array.isArray(exePrefix) ? exePrefix.slice() : [String(exePrefix)]
      argv.push('-p', String(args.prompt), '--output-format', 'stream-json', '--dangerously-skip-permissions')
      const timeoutSec = clampInt(args.timeoutSec, 600, 10, 3600)
      argv.push('--print-timeout', timeoutSec + 's')
      let mode = args.mode || 'auto'
      if (mode === 'auto') mode = o.planActive ? 'plan' : 'accept-edits'
      if (mode === 'plan' || mode === 'accept-edits') argv.push('--mode', mode)
      if (args.model) argv.push('--model', String(args.model))
      if (args.effort) argv.push('--effort', String(args.effort))
      if (Array.isArray(args.addDirs)) for (const d of args.addDirs) { if (d) argv.push('--add-dir', String(d)) }
      if (args.conversationId) argv.push('--conversation', String(args.conversationId))
      else if (args.continueLatest) argv.push('--continue')
      return { argv, mode, timeoutSec }
    },

    // 旧 parseAgyJson verbatim：末 result 事件优先，容忍杂日志与整串 JSON。
    parseJson(stdoutText) {
      const trimmed = String(stdoutText || '').trim()
      if (!trimmed) return null
      const lines = trimmed.split(/\r?\n/).filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i].trim()
        if (!ln.startsWith('{')) continue
        try {
          const obj = JSON.parse(ln)
          if (obj && obj.event === 'result' && obj.result) return obj.result
          if (obj && obj.status && obj.response !== undefined) return obj
        } catch (e) {}
      }
      try { return JSON.parse(trimmed) } catch (e) {}
      return null
    },

    // 旧 buildResult verbatim + backend 字段 + sessionId/conversationId 双写
    //（agy 的会话字段名旧包是 conversationId；新契约统一 sessionId，两键同值以兼容
    //  旧 status 面板/测试与 keystone engine.end 的会话登记）。
    buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
      const exitCode = outcome ? outcome.exitCode : null
      // agy 超时/错误时信息在 result.error 字段（如 "timeout waiting for response"），
      // 必须并入 stderr 供 isLimited 归类（旧 v1.5.8 修复：网络挂起不再静默 FAILED）。
      const errText = parsed && typeof parsed.error === 'string' && parsed.error ? parsed.error : ''
      const stderr = (stderrText ? String(stderrText).slice(-2000) : '') + (errText ? (stderrText ? ' ' : '') + errText : '')
      if (parsed) {
        const conversationId = typeof parsed.conversation_id === 'string' ? parsed.conversation_id : null
        return {
          ok: exitCode === 0 && parsed.status === 'SUCCESS',
          status: typeof parsed.status === 'string' ? parsed.status : (exitCode === 0 ? 'UNKNOWN' : 'ERROR'),
          response: typeof parsed.response === 'string' ? parsed.response : '',
          conversationId,
          sessionId: conversationId,
          durationSeconds: typeof parsed.duration_seconds === 'number' ? parsed.duration_seconds : null,
          numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
          totalTokens: parsed.usage && typeof parsed.usage.total_tokens === 'number' ? parsed.usage.total_tokens : null,
          exitCode, mode, backend: backend || null, stderr
        }
      }
      return {
        ok: false, status: 'PARSE_ERROR', response: '',
        conversationId: null, sessionId: null,
        durationSeconds: null, numTurns: null, totalTokens: null,
        exitCode, mode, backend: backend || null, stderr,
        rawStdout: String(stdoutText || '').slice(-2000)
      }
    },

    // 旧 foldStepUpdate verbatim（step_update → project.current/trail）。
    // bridge-kit foldEvent 对每行 JSON 都调本函数，故这里自判 event==='step_update'。
    foldStreamEvent(ev, p, summarizeArgs, maxArgLen, maxTrail) {
      if (!ev || ev.event !== 'step_update') return
      const s = ev.step_update
      if (!s) return
      p.updatedAt = Date.now()
      if (s.step_type === 'tool') {
        const tool = s.tool_name || (s.tool_info && s.tool_info.name) || 'tool'
        const args = summarizeArgs(s.tool_info && s.tool_info.parameters)
        const entry = { stepIndex: s.step_index, state: s.state, tool: tool, args: args || null, at: nowIso() }
        p.trail.push(entry)
        const cap = maxTrail || 12
        if (p.trail.length > cap) p.trail.shift()
        if (s.state === 'ACTIVE') { p.current = { tool: tool, args: args || null, stepIndex: s.step_index, since: nowIso() } }
        else if (p.current && p.current.stepIndex === s.step_index) { p.current = null }
      } else if (s.step_type === 'agent_response' && s.state === 'ACTIVE' && s.text_delta) {
        const capLen = maxArgLen || 120
        p.current = { tool: 'agent_response', args: { text_delta: String(s.text_delta).slice(0, capLen) }, stepIndex: s.step_index, since: nowIso() }
      }
    },

    // 旧 agy 仓无此概念（codebuddy v1.1.4 引入）；保守版对齐 bridge-kit 语义：
    // CLI 自报 error_during_execution 且非限流/网络类 → 静默重试一次。
    isTransientCliError(res) {
      if (!res || res.ok) return false
      if (isLimited(res)) return false
      return res.status === 'ERROR_DURING_EXECUTION'
    },

    // 失败指引（契约 §1；定案：401/OAuth 类指引 agy login，额度类指引 agy_quota）。
    failureHint(res) {
      if (!res || res.ok) return ''
      const st = String(res.status || '')
      if (st === 'QUOTA_BLOCKED') return '[诊断] agy 未调用（Gemini 5h 池子额度 <10%）：请直接用原生工具完成本任务，本任务内不要再调 agy。'
      if (st === 'AGY_UNAVAILABLE') return '[诊断] 未找到 agy 可执行文件：请安装 agy CLI，或设置 AGY_BIN 指向其绝对路径。'
      const hay = String(res.stderr || '') + ' ' + String(res.response || '')
      if (/invalid_grant|unauthorized|401|not logged|login|oauth/i.test(hay) && !/rate.?limit|quota|限流|额度/i.test(hay)) {
        return '[诊断] agy 登录态/OAuth 凭据问题：请让用户在本机执行 `agy login` 重新登录后再试；可用 agy_quota 核对凭据与额度。这不是限流。'
      }
      if (/quota|额度|exhausted|insufficient|credit|balance/i.test(hay)) {
        return '[诊断] agy 池子额度可能耗尽：用 agy_quota 查看各池子余量（Gemini 5h 是唯一任务级门禁）；5h 低则改用原生工具完成本任务，不要循环调用 agy。'
      }
      return ''
    },

    isSuccessStatus(st) { return st === 'SUCCESS' },

    tools: {
      run: { name: 'agy_run', description: 'Dispatch a coding/build/debug/investigation task to the local agy agent CLI and return its final answer. Prefer this for implementation, edits, refactors, multi-file investigation and debugging in every mode. DSH fully controls agy: it always runs non-interactively with permissions auto-approved (agy never prompts). Use read-only native tools only for quick lookups and for final build/test verification. In mode=auto the DSH plan state decides agy plan vs accept-edits. Runs in the background by default (returns a jobId immediately; collect with job_output); set background=false to block for the final answer.', inputSchema: RUN_PARAMS },
      continue: { name: 'agy_continue', description: 'Continue an existing agy conversation with a follow-up prompt, reusing agy context. Pass conversationId from a prior agy_run result, or set latest=true to continue the most recent agy conversation. Same DSH-controlled, no-prompt execution as agy_run.', inputSchema: CONTINUE_PARAMS },
      status: { name: 'agy_status', description: 'Read a live snapshot of what the local agy agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or agent_response thinking/typing), the recent step trail (tools executed, done/error), and the last completed run status + conversation id. Optional cwd filters to a single project. Call this to check on an in-flight agy_run/agy_continue without waiting for it to finish.', inputSchema: STATUS_PARAMS }
    },

    // agy_quota 仅在宿主有 spawn 能力时注册（preset 注入 deps.process / MCP 注入
    // deps.nodeChild；dynamic 沙箱形态省略 —— Lead 定案 4）。
    extraTools: (deps.process || deps.nodeChild) ? [{
      name: 'agy_quota',
      description: QUOTA_DESCRIPTION,
      inputSchema: QUOTA_PARAMS,
      render: renderQuota,
      async logic(args) {
        const a = args || {}
        const res = await execQuotaScript()
        if (res && res.ok && a.summary) {
          const weekly = (res.groups || []).flatMap((g) => (g.buckets || []).filter((b) => b.window === 'weekly').map((b) => ({ g: g.displayName, id: b.bucketId, pct: Math.round((b.remainingFraction || 0) * 100), reset: b.resetTime })))
          const top = (res.models || []).slice(0, 4).map((m) => (m.displayName || m.name) + ' ' + m.percentage + '%').join(', ')
          return { ok: true, summary: { weekly, topModels: top }, models: res.models, groups: res.groups, tier: res.tier }
        }
        return res
      }
    }] : [],

    // agy 无设置分区字段（契约 §3）。
    settings: {
      keys: [],
      defaults: () => ({}),
      normalize: () => ({}),
      meta: () => ({ fields: [] }),
      diagnose: () => ''
    },

    mcp: { version: '0.1.0' }
  }

  // 三形态共用的工具逻辑。签名保持不变（keystone 与队友按此接线）。
  descriptor.runToolLogic = async function (args, exec) {
    const a = args || {}
    // 旧 agy preset/dynamic 语义：background 默认 true（仅显式 false 才前台阻塞）。
    const normalized = a.background === undefined ? Object.assign({}, a, { background: true }) : a
    const block = await quotaGate5h(normalized, exec)
    if (block) return block
    return this.runner.coreExecute(normalized, exec)
  }
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = { prompt: a.prompt, mode: a.mode, model: a.model, effort: a.effort, cwd: a.cwd, timeoutSec: a.timeoutSec, background: a.background === undefined ? true : a.background }
    const cid = a.conversationId || a.sessionId || null
    if (cid) {
      mapped.conversationId = cid
      mapped.sessionId = cid // keystone engine.resolveTarget 按 sessionId 路由 cwd
    } else if (a.latest) {
      mapped.continueLatest = true
    }
    const block = await quotaGate5h(mapped, exec)
    if (block) return block
    return this.runner.coreExecute(mapped, exec)
  }
  // 旧 statusTool.execute verbatim：cwd 过滤到单项目。
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
  // 供 MCP/测试形态直接复用门禁与额度执行。
  descriptor.quotaGate5h = quotaGate5h
  descriptor.execQuotaScript = execQuotaScript
  descriptor.cachedQuotaCheck = cachedQuotaCheck

  descriptor.attach = function (hostOpts) {
    host = hostOpts || {}
    this.engine = createStatusEngine({ provider: this, publish: host.publish })
    const runner = createRunner(Object.assign({}, host, { provider: this, engine: this.engine }))
    this.runner = runner
    return runner
  }
  return descriptor
}
