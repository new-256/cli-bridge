// providers/mimo.mjs — mimo provider descriptor（单后端：本地 mimo CLI / MiMoCode）。
//
// 移植基线：mimo-first-bridge v1.x 仓 core/mimo-core.mjs + core/runtime-settings.mjs +
// preset/mimo-first/mimo-first-bridge.mjs 的内联逻辑（buildArgv / parseMimoJson /
// buildResult / 三工具 schema / mimo_settings），语义逐字保持；与 provider 无关的骨架
// （状态引擎/行流/回退弹窗/展示层/超时护栏）在 core/bridge-kit.mjs（契约 §1）。
//
// 2026-10 去 desktop 化（用户定案：MiMo 免费 API 服务已被官方终止 + 本机 0 凭据）：
//  1. 取消 mimo-desktop 后端 —— 只走 `mimo run`（MiMoCode CLI，官方便携安装位置
//     ~/.mimocode/bin/mimo.exe）；登录由用户在 CLI 侧 `mimo auth login` 自理。
//  2. 模型由用户在设置里手动指定（settings.defaultModel，不写死默认值）；留空 =
//     不传 --model，交给 mimo CLI 自身默认。可用模型以 `mimo models` 实测为准
//     （xiaomi/mimo-v2.6-flash / -pro / -pro-ultraspeed 等）。
//     契约 §3.2：面板**不自动探测**，meta() 只读上次手动拉取的缓存；用户点
//     「拉取可用模型」才经 settings.refreshModels 跑一次 `mimo models`。
//  3. 是否启用 mimo 由调度（_scheduling.enabled）控制；本描述符不含任何开关。
//
// 红线（PROVIDER-CONTRACT.md §8 + Lead 定案）：本文件会被 build 内联进 dynamic 沙箱
// （new Function）—— 绝不出现 import.meta 字面量；process/fs/child_process 只经
// globalThis.process.getBuiltinModule + typeof 守卫读取；只允许 import bridge-kit
// 与同目录的 mimo-pure.mjs 片文件（build 会把 providers/mimo-*.mjs 一并内联进同一沙箱作用域）。
import { createStatusEngine, createRunner, clampInt, shortLabel, summarizeArgs } from '../core/bridge-kit.mjs'
import {
  parseMimoJson, buildResult, mimoCandidateExePaths, resolveMimoExePrefix, parseMimoModels,
  fetchMimoModelsDetailed, fetchMimoModelsSync, cachedMimoModels, rememberMimoModels
} from './mimo-pure.mjs'
// 模型清单探测链路搬到片文件后仍保留旧 import 入口（ESM 具名导出；dynamic 内联时本行被 build 剥掉）。
export { mimoCandidateExePaths, resolveMimoExePrefix, parseMimoModels, fetchMimoModelsSync, fetchMimoModelsDetailed }

// ── 单后端归一（旧 mimo-core 双后端 verbatim 的收缩形态）───────────────────────
// mimo-desktop 取消后不再有第二后端：backends() 恒 null；任何输入（含历史别名
// mimocode / mimo-cli / desktop / 空串 / 非法值）一律归一为 null。会话路由由
// engine.resolveTarget（cwd + sessionId）完成，backend 恒 null。
const DEFAULT_TIMEOUT_SEC = 600

// 旧 LIMIT_RE（比 kit 版多 free-API/登录/第三方等 MiMo 文案；provider.isLimited 覆盖）。
// 命名 MIMO_ 前缀：dynamic 内联时 kit 也声明顶层 LIMIT_RE，同名会在同一脚本作用域
// 触发「Identifier already declared」构建错误（scripts/build.mjs 文本拼接的固有约束）。
const MIMO_LIMIT_RE = /rate.?limit|ratelimit|429|too many|quota|insufficient|credit|balance|exhausted|exceed|network|offline|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|timeout|timed out|unavailable|503|502|500|401|403|unauthorized|invalid api|api key|connection|proxy|socket|tls|ssl|dns|free API service has ended|sign in|configure a third-party|网络|超时|限流|流量|受限|配额|金额|余额|额度|认证|连接|断开|登录|第三方/i

// ── 模型清单探测（可执行路径 / `mimo models` 解析 / 手动拉取缓存）──────────────
// 全部在 providers/mimo-pure.mjs（本文件只消费）：契约 §3.2 要求面板渲染不 spawn，
// 只有 settings.refreshModels 才会真正跑一次 `mimo models`，结果进内存缓存供 meta() 读。


// ── 三工具 schema（旧 preset verbatim；desktop 专属入参已随之后端取消而删除）────
const MODEL_DESC = 'provider/model 格式，如 xiaomi/mimo-v2.6-flash；留空用设置里的默认模型'
const RUN_PARAMS = {
  type: 'object', additionalProperties: true, required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The task instruction for mimo. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — mimo reads the repo itself). For follow-ups on the same topic, use mimo_continue with latest=true or sessionId (mimo keeps conversation context; state only what is new).' },
    mode: { type: 'string', enum: ['auto', 'plan', 'build', 'compose', 'accept-edits'], description: 'auto follows DSH plan state (plan vs build); plan = read-only analysis (--agent plan); build = full tools (--agent build); compose = compose workflow.' },
    model: { type: 'string', description: MODEL_DESC },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort, mapped to mimo --variant (low→minimal, high→high).' },
    cwd: { type: 'string', description: 'Working directory for mimo (--dir).' },
    timeoutSec: { type: 'integer', description: 'Hard timeout seconds (10-3600, default 600). Grace +60s on top.' },
    background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with mimo_status. Set false to block for the final answer.' },
    sessionId: { type: 'string', description: 'Optional mimo session id to resume (--session). Follow-ups on the same topic normally go through mimo_continue.' },
    title: { type: 'string', description: 'Optional session title.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object', additionalProperties: true, required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing mimo session. State only what is new; mimo preserves its conversation context.' },
    sessionId: { type: 'string', description: 'mimo session id to resume (--session).' },
    latest: { type: 'boolean', description: 'Continue the most recent mimo session (--continue).' },
    mode: { type: 'string', enum: ['auto', 'plan', 'build', 'compose', 'accept-edits'], description: 'Execution mode.' },
    model: { type: 'string', description: MODEL_DESC },
    effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort.' },
    cwd: { type: 'string', description: 'Working directory for mimo.' },
    timeoutSec: { type: 'integer', description: 'Hard timeout seconds (10-3600, default 600).' },
    background: { type: 'boolean', description: 'Defaults to true (background job).' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: true, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }
const SETTINGS_PARAMS = { type: 'object', additionalProperties: true, required: [], properties: { model: { type: 'string', description: MODEL_DESC } } }
const SETTINGS_DESCRIPTION = 'Read or change the default mimo model (settings). Call with model=<provider/model> to save it as the default for subsequent mimo_run/mimo_continue; call with no args to read current settings. Persisted to the settings file; a per-call `model` argument on mimo_run/mimo_continue overrides it for that call only. Available models are listed by `mimo models` on this machine (mimo CLI must be installed and logged in).'

function renderSettings(value) {
  const s = value || {}
  const lines = [
    'mimo settings',
    '  settings file  : ' + (s.settingsPath || '(unknown)'),
    '  default model  : ' + (s.defaultModel || '(unset — 不传 --model)'),
    '  effective      : ' + (s.effective || '(unknown)'),
    '  exe            : ' + (s.exe || '(unknown)'),
    '  saved          : ' + (s.saved ? 'yes' : 'no')
  ]
  if (s.saveError) lines.push('  save error     : ' + s.saveError)
  if (s.note) lines.push('  note           : ' + s.note)
  return [{ type: 'text', text: lines.join('\n') }]
}
// ── 可纯函数化的 mimo-core 语义（descriptor 方法 + 独立导出双份）───────────────

export default function defineProvider(deps = {}) {
  const env = deps.env || {}
  const nodeFs = deps.nodeFs || null
  const nodePath = deps.nodePath || null
  let host = null // attach 后保存 hostOpts（preset/dynamic 形态提供 getSettings）
  let settingsRef = { defaultModel: '' }

  /** 取当前生效的偏好设置。三条来源按优先级合并，每次 buildArgv 都重新读 ——
   *  面板改默认模型后无需重启即生效：
   *   1) `host.getSettings('mimo')` —— preset/dynamic 形态（attach 时由宿主注入）；
   *   2) `deps.readSettings()` —— MCP 形态（真 Node 进程，每次现读设置文件）；
   *   3) `settingsRef` —— attach 时固化的一次性快照 / 缺省值。
   *  三条都拿不到 → 缺省 `{defaultModel:''}`（= 不传 --model，交给 mimo CLI 自决）。
   *
   *  历史坑：MCP 形态不 attach（自建 engine），只认 host.getSettings 会让面板设置的
   *  defaultModel 在 MCP 面对 mimo_run 完全失效 —— 只有 args.model 才落地。
   *  三个形态行为不一致是缺陷，故此处统一把 readSettings 纳入。 */
  function currentSettings() {
    const out = Object.assign({}, settingsRef)
    try {
      if (typeof deps.readSettings === 'function') {
        const r = deps.readSettings()
        if (r && typeof r === 'object') {
          // 宿主可返回 { partition, path, home } 或直接返回分区对象（宽松兼容）。
          const part = ('partition' in r || 'path' in r || 'home' in r) ? r.partition : r
          if (part && typeof part === 'object') Object.assign(out, part)
        }
      }
    } catch (e) { }
    try {
      if (host && typeof host.getSettings === 'function') {
        const s = host.getSettings('mimo')
        if (s && typeof s === 'object') Object.assign(out, s)
      }
    } catch (e) { }
    return out
  }

  // 模型优先级：调用参数 > 宿主注入设置 > runner opts 透传 > 空（不传 --model）。
  // 用户要求「不设默认 → 由 mimo CLI 自决」，故空值绝不落地 --model。
  function effectiveModel(args, opts) {
    const o = opts || {}
    const fromArg = (args && args.model && String(args.model).trim()) || ''
    if (fromArg) return fromArg
    const fromSettings = (currentSettings().defaultModel || '').trim()
    if (fromSettings) return fromSettings
    const fromOpts = (o.settings && o.settings.defaultModel) || o.defaultModel
    return fromOpts ? String(fromOpts).trim() : ''
  }

  // ── 统一设置分区读取（keystone 落盘；descriptor 只读）。宿主注入 deps.readSettings
  //    动态读取（preset/MCP 每次取最新文件值），或静态 deps.settings（测试/dynamic）。
  function liveSettings() {
    if (typeof deps.readSettings === 'function') {
      try {
        const r = deps.readSettings()
        if (r && typeof r === 'object') {
          // 宿主可返回 { partition, path, home } 或直接返回分区对象（宽松兼容）。
          if ('partition' in r || 'path' in r || 'home' in r) {
            return { partition: r.partition || null, path: r.path || null, home: r.home || null }
          }
          return { partition: r, path: deps.settingsPath || null, home: deps.dshHome || null }
        }
      } catch (e) { }
    }
    return { partition: (deps.settings && typeof deps.settings === 'object') ? deps.settings : null, path: deps.settingsPath || null, home: deps.dshHome || null }
  }

  const descriptor = {
    id: 'mimo', label: 'MIMO', presetId: 'cordis-mimo', defaultBackend: null, defaultMode: 'auto',
    exeName: 'mimo', binEnvVars: ['MIMO_BIN', 'MIMO_CLI'], unavailableStatus: 'MIMO_UNAVAILABLE',

    // 单后端：backends() 恒 null；历史别名（mimocode/mimo-cli/desktop）与非法值一律
    // 归一为 null（契约 §1：非法输入返回 null）。
    backends() { return null },
    normalizeBackend() { return null },
    resolveBackend(args, target, preferred) { return null },

    // 旧 preset buildArgv(exe, args, planActive) verbatim 语义（execPrefix 可为
    // [nodeExe, binPath] 数组，runner 已归一）。
    buildArgv(exePrefix, args, opts) {
      const o = opts || {}
      const timeoutSec = clampInt(args.timeoutSec, DEFAULT_TIMEOUT_SEC, 10, 3600)
      const argv = Array.isArray(exePrefix) ? exePrefix.slice() : [String(exePrefix)]
      argv.push('run')
      if (args.prompt != null && String(args.prompt).length) argv.push(String(args.prompt))
      argv.push('--format', 'json', '--dangerously-skip-permissions')
      let mode = args.mode || o.defaultMode || 'auto'
      if (mode === 'auto') mode = o.planActive ? 'plan' : 'build'
      if (mode === 'accept-edits') mode = 'build'
      // mimo --agent: build | plan | compose
      const agent = args.agent || mode
      if (agent === 'plan' || agent === 'build' || agent === 'compose') argv.push('--agent', agent)
      // 模型：调用参数 > 设置 defaultModel > 不传（mimo CLI 自身默认）。
      const model = effectiveModel(args, o)
      if (model) argv.push('--model', String(model))
      // effort (low/medium/high) maps to mimo --variant; pass-through if already a variant name
      let variant = args.variant || args.effort
      if (variant === 'low') variant = 'minimal'
      else if (variant === 'medium') variant = undefined
      else if (variant === 'high') variant = 'high'
      if (variant) argv.push('--variant', String(variant))
      if (args.cwd) argv.push('--dir', String(args.cwd))
      if (args.sessionId) argv.push('--session', String(args.sessionId))
      else if (args.continueLatest) argv.push('--continue')
      if (args.title) argv.push('--title', String(args.title))
      return { argv, timeoutSec, mode: agent }
    },

    parseJson: parseMimoJson,
    buildResult,

    // 旧 foldStepUpdate 语义 verbatim（识别 tool/text/error 事件），trail 条目同时带
    // kit 展示层字段（stepIndex/tool/state/args）与旧字段（kind/label），这样
    // renderStatus 与 MCP 快照映射（buildMcpBridgePayload）都能直接渲染。
    foldStreamEvent(ev, p, summarizeArgsFn, maxArgLen, maxTrail) {
      if (!ev || typeof ev !== 'object') return
      const t = ev.type
      const pr = ev.properties || ev
      const cap = maxTrail || 12
      const idx = p.trail ? p.trail.length : 0
      let entry = null
      if (t === 'tool' || t === 'tool-call' || t === 'tool_use' || t === 'step_update') {
        const name = pr.tool_name || pr.tool || pr.name
        if (name) {
          const args = (summarizeArgsFn || summarizeArgs)(pr.arguments || pr.args || pr.input) || null
          const state = pr.state || pr.status || 'ACTIVE'
          entry = {
            at: Date.now(), kind: 'tool', stepIndex: idx, tool: String(name), args, state,
            label: shortLabel(name + ' ' + JSON.stringify(args || {}))
          }
          if (state === 'ACTIVE') p.current = { tool: String(name), args, stepIndex: idx, since: entry.at }
          else if (p.current && p.current.tool === String(name) && p.current.stepIndex === idx) p.current = null
        }
      } else if (t === 'text' || t === 'message') {
        const chunk = pr.text || pr.content || ''
        if (typeof chunk === 'string' && chunk) {
          const capLen = maxArgLen || 120
          entry = { at: Date.now(), kind: 'text', stepIndex: idx, tool: 'agent_response', args: { text: chunk.slice(0, capLen) }, state: 'ACTIVE', label: shortLabel(chunk) }
          p.current = { tool: 'agent_response', args: entry.args, stepIndex: idx, since: entry.at }
        }
      } else if (t === 'error') {
        const err = pr.error || pr
        const msg = (err.data && err.data.message) || err.message || 'error'
        entry = { at: Date.now(), kind: 'error', stepIndex: idx, tool: 'error', args: { message: String(msg).slice(0, maxArgLen || 120) }, state: 'FAILED', label: shortLabel(msg) }
      }
      if (entry && p.trail) {
        p.trail.push(entry)
        while (p.trail.length > cap) p.trail.shift()
      }
    },

    // 旧 LIMIT_RE 覆盖（kit 版不含 free API/登录/第三方等 MiMo 文案）。
    isLimited(res) {
      if (!res || res.ok) return false
      if (res.status === 'SPAWN_ERROR' || res.status === 'MIMO_UNAVAILABLE' || res.status === 'HUNG_TIMEOUT') return true
      const hay = String(res.stderr || '') + ' ' + String(res.response || '') + ' ' + String(res.status || '') + ' ' + String(res.errorMessage || '')
      return MIMO_LIMIT_RE.test(hay)
    },

    failureHint(res) {
      if (!res || res.ok) return ''
      const st = String(res.status || '')
      if (st === 'MIMO_UNAVAILABLE') return '[诊断] 未找到 mimo 可执行文件：请安装 MiMoCode CLI（mimo，官方便携安装位置 ~/.mimocode/bin/mimo.exe），或设置 MIMO_BIN 指向其绝对路径。'
      const hay = String(res.stderr || '') + ' ' + String(res.errorMessage || '') + ' ' + String(res.response || '')
      if (/free API service has ended|sign in|configure a third-party|登录|第三方|免费/i.test(hay)) {
        return '[诊断] MiMo 免费 API 已终止，请在 mimo CLI 用 `mimo auth login` 登录或配置第三方 API，并在 CLI Bridge 设置里指定模型。'
      }
      if (/model not found|unknown model|no models available|invalid model|unknown provider/i.test(hay)) {
        return '[诊断] mimo 模型不可用或模型名无效：先在本机运行 `mimo models` 列出可用模型，再把 provider/model 填进 CLI Bridge 的「默认模型」设置（或本次调用的 model 参数）。'
      }
      return ''
    },

    // ACCEPTED 计入成功态（指示灯不红；契约 §1）；desktop 取消后不再产生 ACCEPTED，
    // 但成功态集合逐字保持不变（兼容旧会话/测试语义）。
    isSuccessStatus(st) {
      if (!st) return false
      return st === 'SUCCESS' || st === 'ACCEPTED'
    },

    tools: {
      run: { name: 'mimo_run', description: 'Dispatch a coding/build/debug/investigation task to the local mimo agent CLI (Xiaomi MiMoCode) and return its final answer. DSH fully controls mimo (--dangerously-skip-permissions; mimo never prompts). On rate-limit/network failure DSH pops a fallback dialog; fallback=true means finish with native tools. Runs in the background by default (returns a jobId immediately; collect with job_output); set background=false to block for the final answer. While it runs, call mimo_status to watch what mimo is doing live.', inputSchema: RUN_PARAMS },
      continue: { name: 'mimo_continue', description: 'Continue an existing mimo session with a follow-up prompt. Pass sessionId or set latest=true. Same DSH-controlled, no-prompt execution and same fallback dialog as mimo_run.', inputSchema: CONTINUE_PARAMS },
      status: { name: 'mimo_status', description: 'Read a live snapshot of what the local mimo agent is currently doing. Returns one section per project (working directory): running count, current step, recent step trail, last completed run status + session id, per-project runs/token usage. Call this to check on an in-flight mimo_run/mimo_continue without waiting for it to finish.', inputSchema: STATUS_PARAMS }
    },

    // mimo_settings：入参键保持旧 prompt 连续性（backend/desktopModel → model），落统一
    // 分区 defaultModel（迁移映射 keystone 已做）。写盘仅在宿主注入 nodeFs + nodePath 时
    // 可用；否则回显（dynamic 沙箱旧 echo 语义）。
    extraTools: [{
      name: 'mimo_settings',
      description: SETTINGS_DESCRIPTION,
      inputSchema: SETTINGS_PARAMS,
      render: renderSettings,
      async logic(args) {
        const a = args || {}
        const live = liveSettings()
        const cur = Object.assign({ defaultModel: '' }, live.partition || {})
        let settingsPath = live.path || null
        let saved = false, saveError = null
        const home = live.home || deps.dshHome || null
        const patch = (typeof a.model === 'string' && a.model.trim()) ? { defaultModel: a.model.trim() } : null
        if (patch && nodeFs && nodePath && (settingsPath || home)) {
          try { settingsPath = await writePartition(nodeFs, nodePath, settingsPath, home, env, cur, patch); saved = true } catch (e) { saveError = String(e && e.message || e) }
        }
        const merged = Object.assign({}, cur)
        if (patch) merged.defaultModel = patch.defaultModel
        return {
          ok: !saveError,
          settingsPath: settingsPath || '(unified; not writable in this host)',
          defaultModel: merged.defaultModel || '',
          effective: merged.defaultModel ? ('settings:' + merged.defaultModel) : '(unset — 不传 --model，mimo CLI 自决)',
          exe: resolveMimoExePrefix(env).join(' '),
          saved, saveError,
          note: '默认模型在设置面板或本工具里指定（provider/model）；mimo_run/mimo_continue 的 model 参数可单次覆盖。可用模型：在本机运行 `mimo models` 查看。'
        }
      }
    }],

    // 设置分区（契约 §3）：keystone 读写/GUI；本处纯逻辑。diagnose/meta 必须同步。
    settings: {
      keys: ['defaultModel'],
      defaults: () => ({ defaultModel: '' }),
      normalize(raw) {
        const src = raw && typeof raw === 'object' ? raw : {}
        return { defaultModel: (typeof src.defaultModel === 'string' && src.defaultModel.trim()) ? src.defaultModel.trim() : '' }
      },
      meta(envArg) {
        const e = envArg && typeof envArg === 'object' ? envArg : env
        // 契约 §3.2：面板渲染**只读缓存**（命中就填 options，没命中留空），绝不 spawn。
        // 探测改由用户点「拉取可用模型」显式触发（settings.refreshModels）。
        const options = cachedMimoModels().map((m) => ({ value: m.id, label: m.id }))
        return {
          titleSuffix: 'MiMo',
          fields: [{
            key: 'defaultModel', label: '默认模型', type: 'select', allowCustom: true,
            options: options,
            refresh: { label: '拉取可用模型' },
            placeholder: '留空 = 不传 --model（由 mimo CLI 自身默认决定）',
            note: options.length
              ? '共 ' + options.length + ' 个可用模型（上次手动拉取的结果，来自 `mimo models`）。点「拉取可用模型」可重新拉取；mimo_run/mimo_continue 的 model 参数可单次覆盖。'
              : '还没拉取过可用模型清单 —— 点右侧「拉取可用模型」按钮拉取（面板不再自动探测，避免拖慢首屏）。拉取失败会显示具体原因（mimo CLI 未安装 / 未登录 / 免费 API 已终止）。仍可手动输入 provider/model，如 xiaomi/mimo-v2.6-flash。'
          }]
        }
      },
      /**
       * 契约 §3.2：手动拉取可用模型（面板按钮 → POST /cli-bridge/settings/models）。
       * 复用 fetchMimoModelsDetailed（同步探测包一层 async）；成功写回缓存让 meta() 命中；
       * 失败**必须** ok:false + 可操作原因，绝不返回 { ok:true, ids:[] } 或硬编码名称。
       */
      async refreshModels(settings, envArg) {
        const e = envArg && typeof envArg === 'object' ? envArg : env
        const r = fetchMimoModelsDetailed(e, 15000)
        const source = 'mimo-models'
        if (!r.ok) return { ok: false, ids: [], source: source, error: r.error }
        rememberMimoModels(r.models)
        const labels = Object.create(null)
        for (const m of r.models) labels[m.id] = m.id
        return { ok: true, ids: r.models.map((m) => String(m.id)), labels: labels, source: source }
      },
      // 同步一行诊断：当前模型 + exe 来源（env > 已知安装位置 > PATH）。
      diagnose(settings, envArg) {
        const s = settings && typeof settings === 'object' ? settings : {}
        const e = envArg && typeof envArg === 'object' ? envArg : env
        const model = s.defaultModel ? 'model=' + s.defaultModel : 'model=(未设置 → 不传 --model)'
        if (e.MIMO_BIN || e.MIMO_CLI) return model + ' · bin=env:' + (e.MIMO_BIN || e.MIMO_CLI)
        const found = mimoCandidateExePaths(e)
        return model + ' · ' + (found.length ? 'bin=' + found[0] : 'bin=PATH:mimo')
      }
    },

    // MCP 形态扩展：**不含 version**。历史：四处 `mcp: { version: '0.2.2' }` 与
    // mcp/version.mjs 的 packageVersion() 双源，漏改一处就出现「统一 server 报 0.2.3、
    // provider 面仍报 0.2.2」的自相矛盾输出；且 mcp/version.mjs 依赖 import.meta + node:fs，
    // 其函数体无法随本文件内联进 dynamic 沙箱（build 文本拼接会丢实现/炸语法）。
    // 定案：版本号单一来源 = mcp/version.mjs 的 packageVersion()，由 MCP 面（mcp/providers/
    // mimo.mjs 的 meta.version）读取；描述符不复制 version 字面量，宿主如需注入可经 deps.mcp。
    mcp: (deps.mcp && typeof deps.mcp === 'object') ? Object.assign({}, deps.mcp) : {}
  }

  // 统一分区写入（tmp→rename 原子写；与 keystone lib/settings.mjs 同文件同分区规则，
  // 本工具自实现落盘 —— 不 import home-plugin；宿主给出 settingsPath 或 dshHome）。
  async function writePartition(fsMod, pathMod, knownPath, home, environment, cur, patch) {
    const file = knownPath || environment.CLI_BRIDGE_SETTINGS_FILE || (home ? pathMod.join(home, 'cli-bridge-settings.json') : null)
    if (!file) throw new Error('dsh-home not resolved (set DSH_HOME or CLI_BRIDGE_SETTINGS_FILE)')
    let all = {}
    try { all = JSON.parse(fsMod.readFileSync(file, 'utf8')) } catch (e) { all = {} }
    if (!all || typeof all !== 'object') all = {}
    const next = Object.assign({}, all)
    const part = Object.assign({}, cur, next.mimo || {})
    if (patch && patch.defaultModel) part.defaultModel = patch.defaultModel
    next.mimo = descriptor.settings.normalize(part)
    next.updatedAt = Date.now()
    try { fsMod.mkdirSync(pathMod.dirname(file), { recursive: true }) } catch (e) { }
    const tmp = file + '.tmp-' + ((typeof process !== 'undefined' && process.pid) || 'mimo')
    fsMod.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fsMod.renameSync(tmp, file)
    return file
  }

  // 三形态共用的工具逻辑。签名保持不变（keystone 与队友按此接线）。
  // 旧 mimo preset 语义：background 默认 true（仅显式 false 才前台阻塞）。
  descriptor.runToolLogic = async function (args, exec) {
    const a = args || {}
    const normalized = a.background === undefined ? Object.assign({}, a, { background: true }) : a
    return this.runner.coreExecute(normalized, exec)
  }
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = { prompt: a.prompt, mode: a.mode, model: a.model, effort: a.effort, cwd: a.cwd, timeoutSec: a.timeoutSec, background: a.background, sessionId: a.sessionId }
    if (a.sessionId) mapped.sessionId = a.sessionId
    else if (a.latest) mapped.continueLatest = true
    return this.runToolLogic(mapped, exec)
  }
  // 旧 statusTool.execute verbatim：cwd 过滤到单项目（Object.assign 形式与 opencode 一致）。
  descriptor.statusToolLogic = async function (args) {
    const a = args || {}
    const snap = this.engine.statusSnapshot()
    if (a.cwd) {
      const key = String(a.cwd)
      snap.projects = (snap.projects || []).filter((p) => p.cwd === key)
      const g = snap.projects[0]
      if (g) {
        Object.assign(snap, {
          state: g.state, running: g.running, current: g.current, trail: g.trail,
          lastStatus: g.lastStatus, lastAt: g.lastAt, lastSessionId: g.lastSessionId,
          lastOk: g.lastOk, lastFailed: g.lastFailed, fallbackActive: g.fallbackActive,
          runs: g.runs, totalTokens: g.totalTokens, updatedAt: g.updatedAt
        })
      }
    }
    return snap
  }
  // 工厂装配（provider 无关骨架 + 描述符）；宿主注入 getSettings 时把面板偏好带进 buildArgv。
  descriptor.attach = function (hostOpts) {
    host = hostOpts || {}
    try {
      if (typeof host.getSettings === 'function') {
        const s = host.getSettings('mimo')
        if (s && typeof s === 'object') settingsRef = descriptor.settings.normalize(s)
      }
    } catch (e) { }
    this.engine = createStatusEngine({ provider: this, publish: host.publish })
    const runner = createRunner(Object.assign({}, host, { provider: this, engine: this.engine }))
    this.runner = runner
    return runner
  }
  // 测试/宿主可见的纯函数面（不进协议字段）。currentSettings/liveSettings/writePartition 是
  // 闭包函数，不依赖 attach（未 attach 时 host 为 null → 走 deps 注入或默认空值），测试可
  // 直接调用；writePartition 需要调用方自行传入可用的 fs/path 模块。
  descriptor._internals = { MIMO_LIMIT_RE, parseMimoJson, buildResult,
    mimoCandidateExePaths, resolveMimoExePrefix, parseMimoModels, fetchMimoModelsSync,
    fetchMimoModelsDetailed, cachedMimoModels, rememberMimoModels,
    currentSettings, liveSettings, writePartition
  }
  return descriptor
}
