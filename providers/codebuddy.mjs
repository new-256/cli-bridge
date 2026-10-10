// providers/codebuddy.mjs — codebuddy provider descriptor（真移植，替换 Lead 冒烟占位）。
//
// 移植基线：codebuddy-first-bridge v1.6.x core/codebuddy-core.mjs 的纯逻辑
// （后端注册表/端点对齐/凭据链/模型目录/buildArgv/parseCodebuddyJson/buildResult/
// foldEvent/settings 清洗/三工具 schema）与 preset/codebuddy-first 内联语义，
// 逐字保持（PROVIDER-CONTRACT.md §8 红线：工具入参语义与 schema 不许漂移）。
// 与 provider 无关的骨架（状态引擎/行流/回退弹窗/展示层）在 core/bridge-kit.mjs。
//
// TODO（Lead 定案，0.1.0 不做）：旧包 credits/促销面板的 modelPromotions /
// isPromotionActive / activePromotionFor（约 200 行）不进统一设置面板；本版
// modelCatalogDetailed 只给「倍率 + 授权」两标（无促销角标），行为差异在设置面板
// 单列，运行面（buildArgv/CLI 选择）不受影响。
//
// 红线（PROVIDER-CONTRACT.md §8）：
//  - 本文件会被 build 内联进 dynamic 沙箱（new Function）：绝不出现元环境字面量；
//    process/env/fs 只经 deps 注入或 typeof 守卫读取；宿主能力全部走 attach(hostOpts)。
//  - 只允许 import '../core/bridge-kit.mjs' 一行。
//  - isLimited 用本文件自定义的中文限流表（旧 core verbatim），不用 kit 通用表。
import { createStatusEngine, createRunner, clampInt } from '../core/bridge-kit.mjs'

// ── 提示词策略段（旧 preset POLICY_TEXT verbatim；systemPrompt order 5）────────
const POLICY_TEXT = [
  'codebuddy-first execution policy (local codebuddy CLI bridge, with fallback + live indicator + live status tool).',
  '',
  'A local sub-agent CLI named "codebuddy" (Tencent CodeBuddy Code) is available through the codebuddy_run and codebuddy_continue tools. DSH fully controls codebuddy: every invocation runs non-interactively with permissions auto-approved (--permission-mode bypassPermissions), so codebuddy never prompts and DSH decides all of its work. A header status light shows when codebuddy is working — one light per project (working directory), so parallel runs in different projects are tracked separately; call codebuddy_status any time to see what codebuddy is doing right now (per project: current tool/step, recent trail, and cumulative usage).',
  '',
  'Priority rule for EVERY mode (normal, plan, accept-edits, subagent/workflow/ralph delegation, and goal rounds):',
  '- For any real work — implementing features, editing/refactoring code, debugging, running builds, or multi-file investigation — prefer dispatching the task to codebuddy_run FIRST with a complete, self-contained prompt.',
  '- Use native read/write/shell tools mainly for quick read-only lookups and for the final build/test verification of what codebuddy produced.',
  '- In plan mode, call codebuddy_run with mode=auto (or mode=plan); in accept-edits/normal mode codebuddy_run applies edits directly.',
  '- When you delegate to a DSH subagent or workflow, instruct that delegate to also prefer codebuddy_run.',
  '- For long-running tasks, call codebuddy_run with background=true and collect the result with job_output; use codebuddy_status to watch progress.',
  '',
  'Fallback protocol: when codebuddy is rate-limited or the network is down, codebuddy_run/codebuddy_continue automatically pop a confirmation dialog asking the user whether to use the DSH local API config. If the returned result has fallback=true (status FALLBACK_TO_DSH), the user chose to fall back: complete the task with native DSH tools / the local model and DO NOT call codebuddy again for this task. If ok=false without fallback, report the codebuddy error. Never loop codebuddy calls; never ask codebuddy to call back into DSH.',
  '',
  'Model selection: codebuddy_run takes an optional model. When unspecified, the CLI default applies unless the user set a preferred default model in the plugin settings (then that is injected automatically per call). Which models ACTUALLY WORK depends on the ACCOUNT, and the authoritative live list comes from the server: running the CLI with a nonexistent model returns 400 followed by "Currently supported models for your account:" and one "- <id>" per line (core exposes parseAccountModels for this; the plugin caches the result automatically and the settings panel shows exactly those ids, with the credit multiplier of each). Do NOT trust the bundled product descriptor as a menu of usable models: it lists ids with an "-ioa" suffix (glm-5.3-ioa) and expensive flagships (claude-opus-4.8, gpt-5.4, gpt-6-astra) that are present in the catalogue but NOT licensed for this account, and picking one fails with 400 "only available for authorized users". The four backends are also not one pool: "codebuddy" and "codebuddy-intl" are the npm CLI and offer its catalogue - including the free tier (hy3 and deepseek-v4.1-flash cost x0.00 credits; hy4-preview costs x0.29 but is frequently free on promotional accounts); "codebuddy-en" (WorkBuddyAI) has its OWN catalogue which does NOT contain hy4-preview or deepseek-v4.1-flash - it offers hy3 (free), gpt-5.1-codex-mini, gemini-3.1-flash-lite, gemini-2.5-flash, minimax-m3, gemini-3.0-flash, deepseek-v3-2-volc, kimi-k2.5/2.6, glm-5.0/5.2/5.3, gpt-5.3-codex, gpt-5.4/5.5, gpt-5.6-sol/terra/luna and the role aliases (fast/balanced/primary/deep-model); "workbuddy" (domestic desktop) has a further catalogue (auto, hy4-preview, hy3, deepseek-v4.1-flash, glm-5.x, kimi-k2.6/2.7/2.8-preview/k3-1, minimax-m3/m2.7, deepseek-v4-pro). Within a face availability is still gated per ACCOUNT: an id outside the account catalogue fails with "400 model [...] service info not found", and one inside it but unlicensed fails with "400 model [...] is only available for authorized users". International ids (claude-sonnet-5, claude-opus-5, gemini-3.1-pro, ...) are per-account gated and return the latter for a domestic account. COST: every id carries a credit multiplier in the credits field of its descriptor (x0.00 means free, x3.31 means 3.31x the base rate); the settings panel shows each candidate with its multiplier and reads it live from the CLI descriptor, so it stays in sync when the CLI is upgraded. Measured free (x0.00) models for this account: hy3 and deepseek-v4.1-flash (both npm faces) and hy3 for WorkBuddyAI; hy4-preview is x0.29 on npm faces. Prefer the cheapest model that can do the job and use a free one for routine work; do not silently upgrade to an expensive id when the task is simple. To get the exact live list for a CLI, run it with a deliberately invalid model id - the reply prints "Currently supported models for your account:" followed by one "- <id>" per line (core exposes parseAccountModels for this). Pass a model only when the task clearly benefits from a specific one; the default is usually right. Optional effort: minimal/low/medium/high/xhigh/max. Optional maxTurns caps agentic turns (default unlimited).',
  '',
  'Backends: codebuddy_run/codebuddy_continue take an optional backend parameter choosing which CLI face of the same engine (Tencent CodeBuddy Code) runs the task. "codebuddy" is the domestic CodeBuddy (npm CLI @tencent-ai/codebuddy-code, product endpoint www.codebuddy.ai) — default for coding work. "codebuddy-intl" is the INTERNATIONAL face of that SAME npm CLI (product.ioa.json catalogue: claude-sonnet-5, claude-opus-5, gemini-3.1-pro, gpt-6-astra, hy3-ioa …); use it when the account is an international CodeBuddy account. Its aliases "codebuddy-ioa" and "codebuddy-international" are accepted and normalized to codebuddy-intl. "codebuddy-en" is the WorkBuddy INTERNATIONAL edition — the CLI bundled with the WorkBuddyAI desktop app (C:\\Program Files\\WorkBuddyAI, product endpoint www.workbuddy.ai); the aliases "workbuddy-en" and "workbuddy-ai" are also accepted and normalized to codebuddy-en. "workbuddy" is the CLI bundled with the domestic WorkBuddy desktop app (product endpoint copilot.tencent.com, zero config) — the office-scenario face: documents, slides, spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies. When the user asks for office/document/IM work, dispatch with backend="workbuddy"; for international accounts use "codebuddy-intl" (CodeBuddy 国际版) or "codebuddy-en" (WorkBuddy 国际版 / WorkBuddyAI). Sessions are kept per backend (login domains are exclusive), and continuing a session automatically routes back to the backend that owns it (explicit backend wins). A user-preferred default backend (plugin settings) applies when a call is new (no session) and no explicit backend is given.'
].join('\n')

// ── 限流/网络/认证失败判定（旧 core verbatim）。仅匹配 stderr + status；数字码
// 加词边界（避免 "1500" 命中 500、"4013" 命中 401）。中文码（流量/受限/金额/
// 余额/额度/认证/连接/断开 等）为 codebuddy 面专属，必须逐字保留。
// 命名纪律（mimo 同款）：本文件顶层名绝不与 core/bridge-kit.mjs 顶层导出同名 ——
// dynamic 形态把 kit 与 provider 内联进同一脚本作用域，同名 const 直接炸语法
// （LIMIT_RE 在 kit L33 已有，故此处带 CODEBUDDY_ 前缀）。
const CODEBUDDY_LIMIT_RE = /rate.?limit|ratelimit|\b429\b|too many|quota|insufficient|credit|balance|exhausted|exceed|\bnetwork\b|offline|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|\btimeouts?\b|timed out|unavailable|\b50[023]\b|\b40[13]\b|unauthorized|invalid api|api key|proxy|socket|tls|ssl|\bdns\b|网络|超时|限流|流量|受限|配额|金额|余额|额度|认证|连接|断开/i

// ── 后端注册表（旧 core verbatim：端点按登录域自动对齐）───────────────────────
const BACKENDS = ['codebuddy', 'codebuddy-intl', 'codebuddy-en', 'workbuddy']

const BACKEND_ENDPOINTS = {
  'codebuddy': 'https://www.codebuddy.ai/v2',
  'codebuddy-intl': 'https://www.codebuddy.ai/v2',
  'codebuddy-en': 'https://www.workbuddy.ai/v2',
  'workbuddy': 'https://copilot.tencent.com/v2'
}

const AUTH_DOMAIN_ENDPOINTS = {
  'www.codebuddy.cn': 'https://www.codebuddy.cn/v2',
  'www.codebuddy.ai': 'https://www.codebuddy.ai/v2',
  'www.workbuddy.ai': 'https://www.workbuddy.ai/v2',
  'copilot.tencent.com': 'https://copilot.tencent.com/v2'
}

const BACKEND_AUTH_IDS = {
  'codebuddy': 'Tencent-Cloud.coding-copilot',
  'codebuddy-intl': 'Tencent-Cloud.coding-copilot',
  'codebuddy-en': 'workbuddy-desktop-ai',
  'workbuddy': 'workbuddy-desktop'
}

const BACKEND_LABELS = {
  'codebuddy': 'CodeBuddy 国内版（npm CLI）',
  'codebuddy-intl': 'CodeBuddy 国际版（npm CLI · 国际面）',
  'codebuddy-en': 'WorkBuddy 国际版（WorkBuddyAI 桌面 CLI）',
  'workbuddy': 'WorkBuddy 国内版（桌面 CLI）'
}

const BACKEND_ALIASES = {
  'workbuddy-en': 'codebuddy-en',
  'workbuddy-ai': 'codebuddy-en',
  'codebuddy-ioa': 'codebuddy-intl',
  'codebuddy-international': 'codebuddy-intl',
  'codebuddy-oversea': 'codebuddy-intl'
}

const DEFAULT_BACKEND = 'codebuddy'

const SETTINGS_KEYS = ['preferredBackend', 'defaultModel', 'codebuddyEnToken', 'endpointOverride']

// codebuddy-en 凭据的第三条通道：DSH 凭据库里可能已有的 workbuddy key（旧 core verbatim）。
const CREDENTIAL_KEYS = ['WORKBUDDY_TOKEN', 'WORKBUDDY_AI_TOKEN', 'CODEBUDDY_EN_TOKEN']

// 离线/读不到描述文件时的回退静态表（真机按账号实测快照，2026-09）。
const BACKEND_MODEL_IDS = {
  'codebuddy': ['hy4-preview', 'hy3', 'hy3-x', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'minimax-m2.7', 'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro'],
  'codebuddy-intl': ['claude-sonnet-5', 'claude-sonnet-5-1m', 'claude-opus-5', 'claude-opus-4.8', 'claude-opus-4.8-1m', 'gemini-3.1-pro', 'gemini-3.5-flash', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'glm-5.3-ioa', 'glm-5.3-flash-ioa', 'glm-5.2-ioa', 'kimi-k3-ioa', 'kimi-k2.8-preview', 'kimi-k2.6-ioa', 'minimax-m3-ioa', 'minimax-m2.7-ioa', 'deepseek-v4.1-flash', 'deepseek-v4-pro-ioa'],
  // WorkBuddyAI 自制目录（product.json 顶层 37 项，按其 credits 排序：免费的在前）
  'codebuddy-en': ['hy3', 'gpt-5.1-codex-mini', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'minimax-m3', 'gemini-3.0-flash', 'fast-model', 'deepseek-v3-2-volc', 'balanced-model', 'kimi-k2.5', 'kimi-k2.6', 'default-model-lite', 'glm-5.3', 'glm-5.2', 'glm-5.0', 'gpt-5.1-codex', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gpt-5.3-codex', 'gemini-3.1-pro', 'gpt-5.6-terra', 'kimi-k3', 'gpt-5.4', 'primary-model', 'default-model', 'deep-model', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-luna'],
  // WorkBuddy 国内桌面自制目录（product.json：applicationName=WorkBuddy）
  'workbuddy': ['auto', 'hy4-preview', 'hy3', 'hy3-x', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo', 'minimax-m3', 'minimax-m2.7', 'kimi-k3-1', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4-pro']
}

// 各后端真正生效的 product 描述文件位置（旧 core v1.6.1 verbatim）。
const PRODUCT_DESCRIPTOR_ENV = {
  'codebuddy': { env: 'CODEBUDDY_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: null },
  'codebuddy-intl': { env: 'CODEBUDDY_INTL_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: null },
  'codebuddy-en': { env: 'CODEBUDDY_EN_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: '.workbuddy-ai' },
  'workbuddy': { env: 'WORKBUDDY_MODELS_FILE', rel: 'product.ioa.json', fallbackRel: 'product.json', accountDir: '.workbuddy' }
}

// 倍率跨命名匹配（账号清单 id → 描述文件 id，旧 core verbatim）。
const CREDIT_ID_ALIASES = {
  'kimi-k3-1': ['kimi-k3', 'kimi-k3-ioa'],
  'hy3-x': ['hy3', 'hy3-ioa'],
  'default': ['codewise-default-model-v2'],
  'auto': ['hy3', 'hy3-ioa']
}

const MODEL_DESCRIPTION = 'Optional model id. When unspecified, the user-preferred default model (plugin settings) is used if set, else the CLI default. Two layers decide: the PRODUCT FACE decides whether the id exists in its catalogue, then the ACCOUNT decides whether it is licensed. The free tier (hy3, deepseek-v4.1-flash at x0.00 credits; hy4-preview at x0.29) belongs to the npm CLI faces codebuddy/codebuddy-intl: hy4-preview, hy3, hy3-x, deepseek-v4.1-flash, glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo, minimax-m3, minimax-m2.7, kimi-k3-1, kimi-k2.8-preview, kimi-k2.7, kimi-k2.6, deepseek-v4-pro. codebuddy-en (WorkBuddyAI) carries NO hy4-preview and NO deepseek-v4.1-flash; its only free model is hy3. International ids (claude-sonnet-5, gemini-3.1-pro, ...) are account-gated. Availability is per ACCOUNT: the CLI rejects an id outside the account catalogue with "400 service info not found" and one inside it but unlicensed with "400 only available for authorized users" (many catalogue flagships such as claude-opus-4.8, gpt-5.4 and gpt-6-astra are in this second group for a domestic account). Run the CLI with a deliberately invalid model id to print "Currently supported models for your account:" and get the authoritative list; the plugin caches that result and the settings panel lists exactly those ids with their credit multiplier (x0.00 = free), read live from the CLI descriptor so it stays in sync with CLI upgrades. Prefer the cheapest model that can do the job, and prefer a free (x0.00) one for routine work. Pass a model only when the task clearly benefits from a specific one.'

const BACKEND_ENUM = ['codebuddy', 'codebuddy-intl', 'codebuddy-ioa', 'codebuddy-international', 'codebuddy-en', 'workbuddy-en', 'workbuddy-ai', 'workbuddy']

// ── 三工具 schema（旧 preset/codebuddy-first verbatim；契约 §8）────────────────
const RUN_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'The full task/instruction for codebuddy. Be complete and self-contained.' },
    backend: { type: 'string', enum: BACKEND_ENUM, description: 'Which CLI face to dispatch to. codebuddy (default; domestic CodeBuddy npm CLI, product endpoint www.codebuddy.ai) for coding work; codebuddy-intl = CodeBuddy INTERNATIONAL face of the same npm CLI (product.ioa.json catalogue: claude-sonnet-5 / claude-opus-5 / gemini-3.1-pro / gpt-6-astra / hy3-ioa ...; aliases codebuddy-ioa / codebuddy-international) when the account is an international CodeBuddy account; codebuddy-en = WorkBuddy international edition (the WorkBuddyAI desktop bundled CLI at C:\\Program Files\\WorkBuddyAI, product endpoint www.workbuddy.ai; needs codebuddyEnToken unless DSH already holds a workbuddy key) — aliases workbuddy-en / workbuddy-ai also accepted; workbuddy = WorkBuddy domestic desktop CLI (product endpoint copilot.tencent.com, zero config), the office-scenario face: documents/slides/spreadsheets, knowledge-base lookups, image/video generation, WeChat/WeCom replies. New calls without a backend follow the user-preferred default backend (plugin settings). Continuing a session routes back to its owning backend automatically.' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'auto follows DSH plan state; plan = no writes; accept-edits = allow edits. Default auto.' },
    model: { type: 'string', description: MODEL_DESCRIPTION },
    effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' },
    maxTurns: { type: 'integer', description: 'Optional max agentic turns (1-500, default unlimited).' },
    cwd: { type: 'string', description: 'Working directory for codebuddy. Defaults to the DSH workspace root.' },
    addDirs: { type: 'array', items: { type: 'string' }, description: 'Extra directories to add to codebuddy workspace.' },
    timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' },
    background: { type: 'boolean', description: 'Run as a background job and return a jobId immediately.' }
  }
}
const CONTINUE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', description: 'Follow-up instruction for the ongoing codebuddy conversation.' },
    sessionId: { type: 'string', description: 'codebuddy session id to resume (from a prior codebuddy_run result).' },
    latest: { type: 'boolean', description: 'Continue the most recent codebuddy conversation instead of a specific id.' },
    backend: { type: 'string', enum: BACKEND_ENUM, description: 'Which CLI face to resume on. codebuddy-en = WorkBuddy international (WorkBuddyAI desktop CLI; aliases workbuddy-en / workbuddy-ai accepted), workbuddy = WorkBuddy domestic desktop CLI. When omitted, the backend that owns the sessionId is used automatically; brand-new conversations follow the user-preferred default backend (plugin settings).' },
    mode: { type: 'string', enum: ['auto', 'plan', 'accept-edits'], description: 'Execution mode; default auto.' },
    model: { type: 'string', description: 'Optional model id (two layers: product face carries it, account licenses it; the credit multiplier of each id comes from the CLI descriptor — see codebuddy_run).' },
    effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Optional reasoning effort.' },
    maxTurns: { type: 'integer', description: 'Optional max agentic turns.' },
    cwd: { type: 'string', description: "Working directory for codebuddy; when resuming, defaults to the resumed session's project directory." },
    timeoutSec: { type: 'integer', description: 'Run timeout seconds (10-3600, default 300); a DSH-side hang guard force-terminates at timeout+60s.' },
    background: { type: 'boolean', description: 'Run as a background job and return a jobId immediately.' }
  }
}
const STATUS_PARAMS = { type: 'object', additionalProperties: false, required: [], properties: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' } } }

export default function defineProvider(deps = {}) {
  const env = deps.env || {}
  let host = null // attach 后保存 hostOpts（preset/dynamic/MCP 形态宿主能力）

  // 宿主 fs/path 访问的统一入口：deps 注入优先；dynamic 内联体（无 import，运行在
  // 后端 Node 上下文）回退到 getBuiltinModule —— 与旧 core builtinModule() 的
  // typeof 守卫模式一致（这是旧 dynamic 端点修复生效的同一条通道，缺了它默认
  // 后端会回到 401 老病）。两者皆不可用时自然降级：读不到文件 = 静态表兜底。
  function builtinModule(name) {
    try {
      const proc = globalThis.process
      return (proc && typeof proc.getBuiltinModule === 'function') ? proc.getBuiltinModule(name) : null
    } catch (e) { return null }
  }
  function fsRead(p) {
    const nf = deps.nodeFs || builtinModule('node:fs')
    if (!nf || typeof nf.readFileSync !== 'function') return null
    try { return nf.readFileSync(p, 'utf8') } catch (e) { return null }
  }
  function pathJoin(...parts) {
    const np = deps.nodePath || builtinModule('node:path')
    if (np && typeof np.join === 'function') return np.join(...parts)
    return parts.join('/')
  }
  const pathSep = (deps.nodePath && deps.nodePath.sep) || (/[A-Za-z]:[\\/]/.test(env.USERPROFILE || env.APPDATA || '') ? '\\' : '/')

  // ── 端点/登录域（旧 core endpointHost verbatim：非法 URL 容错）───────────────
  function endpointHost(url) {
    const s = String(url || '').trim()
    if (!s) return ''
    try { return new URL(s).hostname.toLowerCase() } catch (e) { }
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(s)
    return m ? m[1].toLowerCase() : ''
  }

  function resolveEndpoint(explicitBaseUrl, authDomain) {
    const explicit = String(explicitBaseUrl || '').trim()
    if (explicit) return explicit
    const d = String(authDomain || '').trim().toLowerCase()
    if (d && AUTH_DOMAIN_ENDPOINTS[d]) return AUTH_DOMAIN_ENDPOINTS[d]
    return null
  }

  function isBackend(v) { return BACKENDS.indexOf(v) >= 0 }

  // 后端名规范化（v1.3.3 verbatim）：别名 + 大小写不敏感；非后端名原样返回。
  function normalizeBackend(v) {
    if (typeof v !== 'string') return v
    const lower = v.trim().toLowerCase()
    const aliased = BACKEND_ALIASES[lower] || lower
    return BACKENDS.indexOf(aliased) >= 0 ? aliased : v
  }

  // 后端解析优先级（旧 core verbatim）：显式 > 会话归属 > 用户偏好 > 默认。
  function resolveBackend(args, target, preferredBackend) {
    if (args && isBackend(normalizeBackend(args.backend))) return normalizeBackend(args.backend)
    if (target && target.backend && isBackend(normalizeBackend(target.backend))) return normalizeBackend(target.backend)
    if (preferredBackend && isBackend(normalizeBackend(preferredBackend))) return normalizeBackend(preferredBackend)
    return DEFAULT_BACKEND
  }

  // 本次调用的端点/凭据 env 注入（旧 core endpointEnv verbatim 三规则）。
  function endpointEnv(backend, explicitBaseUrl, authDomain, authToken) {
    const out = {}
    const endpoint = resolveEndpoint(explicitBaseUrl, authDomain)
    const product = BACKEND_ENDPOINTS[backend]
    if (endpoint && endpointHost(endpoint) !== endpointHost(product)) {
      out.CODEBUDDY_BASE_URL = endpoint
    }
    if (backend === 'codebuddy-en') {
      const tok = String(authToken || '').trim()
      if (tok) out.CODEBUDDY_AUTH_TOKEN = tok
    }
    return Object.keys(out).length ? out : null
  }

  // 可操作提示（旧 core endpointMismatchHint 三分支 verbatim）。
  function endpointMismatchHint(backend, authDomain, hasToken) {
    if (backend === 'codebuddy-en' && !hasToken) {
      return 'codebuddy-en（WorkBuddy 国际版）没有可用凭据。国际版的登录 token 被桌面 App 的 protector key 封装，该密钥不落盘、headless CLI 无法自行读取（CLI 自身报 category:"missing-key"）。桥接会依次尝试：插件设置 codebuddyEnToken → 环境变量 CODEBUDDY_AUTH_TOKEN → DSH 凭据库（.credentials.yaml / .env 里的 WORKBUDDY_TOKEN）——三者皆空。请在 DSH 里配好 workbuddy provider 的 key，或把国际版 token 填入插件设置；也可直接用 backend="workbuddy"（国内版桌面 CLI，免配置）。'
    }
    if (backend === 'codebuddy-intl') {
      return 'codebuddy-intl（CodeBuddy 国际版）使用同一个 npm CLI，但国际面模型由服务端按账号授权放行：未授权时 CLI 返回 400「model [...] is only available for authorized users」。若你用的是国内账号，请改用 backend="codebuddy"（国内面模型清单）或 backend="codebuddy-en"（WorkBuddy 国际版）。'
    }
    const d = String(authDomain || '').trim().toLowerCase()
    if (d && endpointHost(resolveEndpoint(null, d)) !== endpointHost(BACKEND_ENDPOINTS[backend])) {
      return backend + ' 的登录域是 ' + d + '，与产品端点 ' + BACKEND_ENDPOINTS[backend] + ' 不一致；桥接层已自动注入 CODEBUDDY_BASE_URL=' + AUTH_DOMAIN_ENDPOINTS[d] + '。若仍 401，请重新登录对应客户端。'
    }
    return null
  }

  // 从 auth 库读某后端登录域（旧 core readBackendAuthDomain verbatim 语义；fs 经
  // deps 注入。io 可覆盖 readFileSync/dir/env，供测试夹具与 MCP 面注入真实 fs）。
  function readBackendAuthDomain(backend, io) {
    const o = io || {}
    const id = BACKEND_AUTH_IDS[backend]
    if (!id) return null
    try {
      const read = o.readFileSync || fsRead
      if (typeof read !== 'function') return null
      const e = o.env || env
      let dir = o.dir
      if (!dir) {
        dir = e.CODEBUDDY_AUTH_DIR ||
          pathJoin(e.LOCALAPPDATA || 'C:\\Users\\lcl\\AppData\\Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
      }
      const sep = String(dir).indexOf('\\') >= 0 ? '\\' : '/'
      const txt = read(dir + sep + id + '.info', 'utf8')
      if (txt == null) return null
      const raw = JSON.parse(txt)
      const d = raw && raw.auth && raw.auth.domain
      return typeof d === 'string' && d.trim() ? d.trim() : null
    } catch (e) { return null }
  }

  // DSH 凭据库第三通道（旧 core readDshWorkbuddyToken verbatim 语义；CODEBUDDY_
  // CREDENTIALS_DIR 覆盖测试夹具；fs 经 deps 注入）。
  function readDshWorkbuddyToken() {
    const overrideDir = env.CODEBUDDY_CREDENTIALS_DIR || null
    const home = overrideDir || env.DSH_HOME || null
    if (!home) return null
    const files = [home + '\\.credentials.yaml', home + '\\.env', home + '/.credentials.yaml', home + '/.env']
    for (const f of files) {
      const text = fsRead(f)
      if (!text) continue
      for (const key of CREDENTIAL_KEYS) {
        const m = text.match(new RegExp('^[ \\t]*' + key + '[ \\t]*[:=][ \\t]*(.+)$', 'm'))
        if (!m) continue
        const v = m[1].trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '').trim()
        // 只接受看起来是真实 token 的值（避免把 $VAR 引用或占位符当凭据）。
        if (v.length >= 40 && !v.startsWith('$') && !/^<.*>$/.test(v)) return v
      }
    }
    return null
  }

  // codebuddy-en 凭据链（旧 core verbatim）：设置面板 > CODEBUDDY_AUTH_TOKEN >
  // DSH 凭据库。dynamic 沙箱无 fs → 第三通道自然缺席（旧 dynamic 本也有限）。
  function resolveEnToken(settingToken) {
    const s = String(settingToken || '').trim()
    if (s) return { token: s, source: 'setting' }
    const envTok = env.CODEBUDDY_AUTH_TOKEN || ''
    if (String(envTok).trim()) return { token: String(envTok).trim(), source: 'env' }
    const fromStore = readDshWorkbuddyToken()
    if (fromStore) return { token: fromStore, source: 'dsh-store' }
    return { token: null, source: null }
  }

  // ── 模型目录（面板/诊断用；无促销角标版，见头注 TODO）───────────────────────
  function accountConfigCandidates(backend) {
    const spec = PRODUCT_DESCRIPTOR_ENV[backend]
    if (!spec || !spec.accountDir) return []
    const home = env.USERPROFILE || env.HOME
    if (!home) return []
    const base = pathJoin(home, spec.accountDir.split('/').join(pathSep))
    return [
      pathJoin(base, 'cache', 'acc-product-config-v3.json'),
      pathJoin(base, 'local_storage', 'entry_d43e96994f944cfb77961c2ea7d04605.info'),
      pathJoin(base, 'local_storage', 'wb_entry_d43e96994f944cfb77961c2ea7d04605.info')
    ]
  }

  function productDescriptorCandidates(backend) {
    const spec = PRODUCT_DESCRIPTOR_ENV[backend]
    if (!spec) return []
    const out = []
    for (const p of accountConfigCandidates(backend)) out.push(p)
    if (env[spec.env]) out.push(env[spec.env])
    const rels = spec.fallbackRel ? [spec.rel, spec.fallbackRel] : [spec.rel]
    const push = (root) => { if (root) for (const r of rels) out.push(pathJoin(root, ...r.split('/'))) }
    if (backend === 'codebuddy' || backend === 'codebuddy-intl') {
      push(env.APPDATA ? pathJoin(env.APPDATA, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code') : null)
    } else if (backend === 'codebuddy-en') {
      push('C:\\Program Files\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli')
    } else if (backend === 'workbuddy') {
      push('C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli')
    }
    return out
  }

  function normalizeProductConfig(raw) {
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!obj) return null
      if (Array.isArray(obj)) {
        // 数组形态：从后往前找第一个带 data 的条目（末尾最新）。
        for (let i = obj.length - 1; i >= 0; i--) {
          const e = obj[i]
          if (e && typeof e === 'object' && e.data && typeof e.data === 'object') return e.data
        }
        return null
      }
      if (typeof obj !== 'object') return null
      if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.models) && !Array.isArray(obj.agents)) return obj.data
      return obj
    } catch (e) { return null }
  }

  function extractModelIds(productJson) {
    try {
      const obj = normalizeProductConfig(productJson)
      if (!obj || typeof obj !== 'object') return null
      const pick = (arr) => {
        if (!Array.isArray(arr) || !arr.length) return null
        const ids = arr.map((m) => (typeof m === 'string' ? m : m && m.id)).filter((s) => typeof s === 'string' && s.trim())
        return ids.length ? [...new Set(ids)] : null
      }
      const agents = Array.isArray(obj.agents) ? obj.agents : []
      const cli = agents.find((a) => a && a.name === 'cli')
      const fromCli = cli ? pick(cli.models) : null
      const fromTop = pick(obj.models)
      if (fromCli && fromTop) return fromTop.length > fromCli.length ? fromTop : fromCli
      return fromCli || fromTop || null
    } catch (e) { return null }
  }

  function parseCreditValue(raw) {
    if (typeof raw !== 'string') return null
    const s = raw.trim()
    let m = s.match(/^[xX×]\s*([0-9]+(?:\.[0-9]+)?)/)
    if (!m) m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*[xX×]/)
    if (!m) return null
    const n = Number(m[1])
    return Number.isFinite(n) ? n : null
  }

  function formatCreditLabel(credits) {
    if (typeof credits !== 'number' || !Number.isFinite(credits)) return ''
    if (credits === 0) return '免费'
    return `x${credits.toFixed(2)}`
  }

  function extractModelCredits(productJson) {
    try {
      const obj = normalizeProductConfig(productJson)
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.models)) return null
      const map = new Map()
      for (const m of obj.models) {
        if (!m || typeof m !== 'object') continue
        const id = typeof m.id === 'string' ? m.id.trim() : ''
        if (!id) continue
        const n = parseCreditValue(m.credits)
        if (n !== null) map.set(id, n)
      }
      return map.size ? map : null
    } catch (e) { return null }
  }

  function lookupModelCredits(creditsMap, id) {
    if (!creditsMap || typeof id !== 'string') return null
    const norm = id.trim()
    const cands = [norm]
    if (norm.endsWith('-ioa')) cands.push(norm.slice(0, -4))
    else cands.push(norm + '-ioa')
    if (CREDIT_ID_ALIASES[norm]) cands.push(...CREDIT_ID_ALIASES[norm])
    for (const c of cands) {
      if (creditsMap.has(c)) {
        const v = creditsMap.get(c)
        if (typeof v === 'number') return v
      }
    }
    return null
  }

  function backendModelCatalog(backend, io) {
    const known = BACKEND_MODEL_IDS[backend] || []
    const read = (io && io.readFileSync) || fsRead
    let fromFile = null
    let fromFileRich = null
    // 旧 v1.6.1 语义：第一份有内容的 + 第一份带促销的，优先后者。
    for (const p of productDescriptorCandidates(backend)) {
      let txt = null
      try { txt = read ? read(p, 'utf8') : null } catch (e) { continue }
      if (txt == null) continue
      const ids = extractModelIds(txt)
      if (ids && ids.length) {
        if (!fromFile) fromFile = ids
        const obj = normalizeProductConfig(txt)
        if (!fromFileRich && obj && Array.isArray(obj.modelPromotions)) fromFileRich = ids
      }
      if (fromFileRich) break
    }
    if (!fromFile) return known
    return fromFileRich || fromFile
  }

  // 服务端回吐的账号清单缓存（进程内，旧 core verbatim）。
  const ACCOUNT_CATALOG_CACHE = new Map()
  function rememberAccountCatalog(backend, ids) {
    if (Array.isArray(ids) && ids.length) ACCOUNT_CATALOG_CACHE.set(backend, ids.slice())
  }
  function getAccountCatalog(backend) {
    const v = ACCOUNT_CATALOG_CACHE.get(backend)
    return v && v.length ? v.slice() : null
  }

  // CLI 报错里解析「该账号当前支持的模型」（旧 core parseAccountModels verbatim）。
  function parseAccountModels(text) {
    const s = String(text || '')
    const anchor = s.indexOf('Currently supported models for your account')
    if (anchor < 0) return null
    const tail = s.slice(anchor)
    const ids = []
    for (const line of tail.split(/\r?\n/)) {
      const m = /^\s*[-*]\s+(\S+)\s*$/.exec(line)
      if (!m) {
        if (ids.length) break
        continue
      }
      if (!ids.includes(m[1])) ids.push(m[1])
    }
    return ids.length ? ids : null
  }

  // 带倍率/授权的详细清单（无促销角标，旧 v1.6.1 的 0.1.0 子集；排序规则 verbatim：
  // 已授权在前 → 有倍率升序 → 无倍率殿后）。
  function modelCatalogDetailed(backend, io) {
    const o = io || {}
    const fromFile = backendModelCatalog(backend, o)
    const acct = (Array.isArray(o.accountModels) && o.accountModels.length) ? o.accountModels : getAccountCatalog(backend)
    const ids = []
    const authorized = new Set()
    if (acct) for (const id of acct) { if (!ids.includes(id)) ids.push(id); authorized.add(id) }
    for (const id of fromFile) if (!ids.includes(id)) ids.push(id)
    const read = o.readFileSync || fsRead
    let creditsMap = null
    for (const p of productDescriptorCandidates(backend)) {
      let txt = null
      try { txt = read ? read(p, 'utf8') : null } catch (e) { continue }
      if (txt == null) continue
      const map = extractModelCredits(txt)
      if (map) { creditsMap = map; break }
    }
    const items = ids.map((id) => {
      const base = lookupModelCredits(creditsMap, id)
      const credits = base
      const hasCredits = typeof credits === 'number'
      const suffix = formatCreditLabel(credits)
      const marks = []
      if (suffix) marks.push(suffix)
      if (acct && !authorized.has(id)) marks.push('未授权')
      return {
        id,
        credits,
        baseCredits: base,
        free: hasCredits && credits === 0,
        hasCredits,
        authorized: acct ? authorized.has(id) : null,
        promotion: null,
        label: marks.length ? `${id} · ${marks.join(' · ')}` : id
      }
    })
    const rank = (x) => (x.authorized === false ? 1 : 0)
    const withC = items.filter((x) => x.hasCredits).sort((a, b) => rank(a) - rank(b) || a.credits - b.credits)
    const withoutC = items.filter((x) => !x.hasCredits).sort((a, b) => rank(a) - rank(b))
    return [...withC, ...withoutC]
  }

  function formatModelCatalogText(backend, io) {
    return modelCatalogDetailed(backend, io).map((x) => x.label).join(', ')
  }

  // ── 设置清洗（旧 normalizeBridgeSettings verbatim；updatedAt 透传）───────────
  function normalizeSettings(raw) {
    const snap = { preferredBackend: DEFAULT_BACKEND, defaultModel: '', codebuddyEnToken: '', endpointOverride: '' }
    if (!raw || typeof raw !== 'object') return snap
    if (typeof raw.preferredBackend === 'string') {
      const nb = normalizeBackend(raw.preferredBackend)
      if (typeof nb === 'string' && BACKENDS.indexOf(nb) >= 0) snap.preferredBackend = nb
    }
    if (typeof raw.defaultModel === 'string') snap.defaultModel = raw.defaultModel.trim()
    if (typeof raw.codebuddyEnToken === 'string') snap.codebuddyEnToken = raw.codebuddyEnToken.trim()
    if (typeof raw.endpointOverride === 'string') snap.endpointOverride = raw.endpointOverride.trim()
    if (typeof raw.updatedAt === 'number' && raw.updatedAt > 0) snap.updatedAt = raw.updatedAt
    return snap
  }

  // 诊断（旧 diagnoseBackend verbatim；fs/env 走 deps）。
  function diagnoseBackend(backend, settings, io) {
    const o = io || {}
    const e = o.env || env
    const s = settings || normalizeSettings(null)
    const authDomain = readBackendAuthDomain(backend, Object.assign({ env: e }, o))
    const override = String(s.endpointOverride || '').trim()
    const byDomain = resolveEndpoint(null, authDomain)
    const endpoint = override || byDomain || BACKEND_ENDPOINTS[backend] || null
    const endpointSource = override ? 'override' : (byDomain ? 'auth-domain' : 'product')
    const tok = resolveEnToken(backend === 'codebuddy-en' ? s.codebuddyEnToken : null)
    return {
      backend: backend,
      authDomain: authDomain,
      endpoint: endpoint,
      endpointSource: endpointSource,
      tokenSource: backend === 'codebuddy-en' ? tok.source : 'not-needed',
      tokenHint: tok.source === 'setting' ? '来自设置面板'
        : tok.source === 'env' ? '来自环境变量 CODEBUDDY_AUTH_TOKEN'
          : tok.source === 'dsh-store' ? '来自 DSH 凭据库（自动复用 WORKBUDDY_TOKEN）'
            : backend === 'codebuddy-en' ? '缺失：国际版 token 不落盘，需在设置面板填写或先在 DSH 配 workbuddy provider'
              : '无需填写（国内版由 CLI 自行登录）',
      mismatch: endpointMismatchHint(backend, authDomain, !!tok.token) !== null,
      hint: endpointMismatchHint(backend, authDomain, !!tok.token) || null,
      defaultModel: String(s.defaultModel || '').trim() || '(CLI 默认)'
    }
  }

  // ── 结果判定（旧 isLimited/isTransientCliError/failureHint verbatim）─────────
  function isLimitedCodebuddy(res) {
    if (!res || res.ok) return false
    // 前置凭据缺失：配置问题，不是限流（弹窗重试不会让 token 出现）。
    if (res.status === 'AUTH_REQUIRED') return false
    if (res.status === 'SPAWN_ERROR' || res.status === 'CODEBUDDY_UNAVAILABLE' || res.status === 'HUNG_TIMEOUT') return true
    const hay = String(res.stderr || '') + ' ' + String(res.status || '')
    // 401/端点域不匹配：需要用户换登录域，不归限流类（旧 v1.3.0 verbatim）。
    if (/401 authentication failed|differs from the current product endpoint/i.test(hay)) return false
    return CODEBUDDY_LIMIT_RE.test(hay)
  }

  function isTransientCliError(res) {
    if (!res || res.ok) return false
    if (isLimitedCodebuddy(res)) return false
    return res.status === 'ERROR_DURING_EXECUTION'
  }

  function failureHint(res) {
    if (!res || res.ok) return ''
    // AUTH_REQUIRED：stderr 已带完整指引，透传（旧 v1.3.1 verbatim）。
    if (res.status === 'AUTH_REQUIRED') return '[诊断] ' + String(res.stderr || '')
    if (isTransientCliError(res)) {
      return res.retried
        ? '[诊断] codebuddy CLI 侧瞬时错误（error_during_execution，CLI 未给出原因），已自动重试 1 次仍失败。可换 model 再试一次；若仍失败请改用原生工具完成，或告知用户。'
        : '[诊断] codebuddy CLI 侧瞬时错误（error_during_execution，CLI 未给出原因）。直接重试同一请求通常即可通过；也可显式指定 model。不要据此认为任务本身有问题。'
    }
    if (res.status === 'PARSE_ERROR') {
      return '[诊断] 未能从 codebuddy 输出解析出 result 事件（进程可能被中断或输出被截断）。可重试；持续出现请检查 codebuddy CLI 版本。'
    }
    if (/401 authentication failed|differs from the current product endpoint/i.test(String(res.stderr || ''))) {
      return '[诊断] 认证失败（401）：请求被送到的端点与当前 CLI 登录域不匹配（国际/国内登录互斥）。请让用户在对应产品域完成 `codebuddy` CLI 登录后重试；这不是限流，重试与回退都无效。'
    }
    return ''
  }

  // stream-json 解析（旧 parseCodebuddyJson verbatim）。
  function parseCodebuddyJson(stdoutText) {
    const trimmed = String(stdoutText || '').trim()
    if (!trimmed) return null
    const lines = trimmed.split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i].trim()
      if (!ln.startsWith('{')) continue
      try {
        const obj = JSON.parse(ln)
        if (obj && obj.type === 'result') return obj
      } catch (e) {}
    }
    try { return JSON.parse(trimmed) } catch (e) {}
    return null
  }

  // result 事件 → 统一结果对象（旧 buildResult verbatim，含账号清单收割）。
  function buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
    const bk = backend || 'codebuddy'
    const exitCode = outcome ? outcome.exitCode : null
    const errText = parsed && typeof parsed.error === 'string' && parsed.error ? parsed.error : ''
    const stderr = (stderrText ? String(stderrText).slice(-2000) : '') + (errText ? (stderrText ? ' ' : '') + errText : '')
    // v1.6.0：顺手收割服务端回吐的「本账号可用模型」清单（失败静默）。
    try {
      const harvest = parseAccountModels(stderr) || parseAccountModels(String(stdoutText || ''))
      if (harvest && harvest.length) rememberAccountCatalog(bk, harvest)
    } catch (e) { /* 收割失败不影响主流程 */ }
    if (parsed && parsed.type === 'result') {
      const isOk = exitCode === 0 && parsed.is_error === false && parsed.subtype === 'success'
      let modelUsed = null
      try {
        if (parsed.modelUsage && typeof parsed.modelUsage === 'object') {
          const names = Object.keys(parsed.modelUsage)
          if (names.length) modelUsed = names.join('+')
        }
      } catch (e) { }
      return {
        ok: isOk,
        status: String(parsed.subtype || (isOk ? 'SUCCESS' : 'ERROR')).toUpperCase(),
        response: typeof parsed.result === 'string' ? parsed.result : '',
        sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
        durationSeconds: typeof parsed.duration_ms === 'number' ? parsed.duration_ms / 1000 : null,
        numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
        totalTokens: (parsed.usage && typeof parsed.usage.input_tokens === 'number' && typeof parsed.usage.output_tokens === 'number')
          ? (parsed.usage.input_tokens + parsed.usage.output_tokens) : null,
        exitCode: exitCode,
        mode: mode,
        backend: bk,
        modelUsed: modelUsed,
        stderr: stderr
      }
    }
    return {
      ok: false,
      status: 'PARSE_ERROR',
      response: '',
      sessionId: null,
      durationSeconds: null,
      numTurns: null,
      totalTokens: null,
      exitCode: exitCode,
      mode: mode,
      backend: bk,
      stderr: stderr,
      rawStdout: String(stdoutText || '').slice(-2000)
    }
  }

  // 统一 argv 构造（旧 buildArgv verbatim；env 端点/凭据注入在本 provider 内完成，
  // 因为 kit 只透传 opts，宿主三形态都从本函数的返回值取 built.env 下发 spawn）。
  function buildArgvCodebuddy(prefix, args, opts) {
    const o = opts || {}
    const argv = [prefix[0], ...prefix.slice(1), '-p', String(args.prompt), '--output-format', 'stream-json']
    let mode = args.mode || o.defaultMode || 'auto'
    if (mode === 'auto') mode = o.planActive ? 'plan' : 'bypassPermissions'
    if (mode === 'plan') {
      argv.push('--permission-mode', 'plan')
      argv.push('--allowedTools', 'Bash')
    } else {
      mode = 'bypassPermissions'
      argv.push('--permission-mode', 'bypassPermissions')
    }
    // 模型优先级：显式 args.model > 用户偏好 defaultModel > CLI 默认。
    const model = args.model || o.defaultModel
    if (model) argv.push('--model', String(model))
    if (args.effort) argv.push('--effort', String(args.effort))
    if (args.maxTurns !== undefined && args.maxTurns !== null) argv.push('--max-turns', String(clampInt(args.maxTurns, 50, 1, 500)))
    if (Array.isArray(args.addDirs)) for (const d of args.addDirs) { if (d) argv.push('--add-dir', String(d)) }
    if (args.sessionId) argv.push('--resume', String(args.sessionId))
    else if (args.continueLatest) argv.push('--continue')
    const timeoutSec = clampInt(args.timeoutSec, 300, 10, 3600)
    // 端点/凭据注入（旧 preset/dynamic/MCP 三形态一致语义，宿主不必自算）：
    // authDomain 只在有 fs 能力的宿主读得到；dynamic 沙箱 → 沿用 CLI 自身端点。
    const bk = o.backend || DEFAULT_BACKEND
    const settings = o.settings || null
    const authDomain = readBackendAuthDomain(bk, {})
    const tok = resolveEnToken(bk === 'codebuddy-en' && settings ? settings.codebuddyEnToken : null)
    const inject = endpointEnv(bk, settings ? settings.endpointOverride : null, authDomain, tok.token)
    return { argv: argv, timeoutSec: timeoutSec, mode: mode, env: o.env || inject }
  }

  // 流事件折叠（旧 foldEvent 主体 verbatim；project 状态由 kit engine 持有）。
  function foldStreamEvent(ev, p, summarizeArgs, MAX_ARG_LEN, MAX_TRAIL) {
    if (!ev || !ev.type) return
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_use') {
          p._stepCounter = (p._stepCounter || 0) + 1
          const stepIndex = p._stepCounter
          if (!p._toolMap) p._toolMap = {}
          p._toolMap[block.id] = { stepIndex: stepIndex, name: block.name }
          const args = summarizeArgs(block.input)
          p.trail.push({ stepIndex: stepIndex, state: 'ACTIVE', tool: block.name, args: args, at: new Date().toISOString() })
          if (p.trail.length > MAX_TRAIL) p.trail.shift()
          p.current = { tool: block.name, args: args, stepIndex: stepIndex, since: new Date().toISOString() }
        } else if (block.type === 'thinking') {
          p.current = { tool: 'thinking', args: { text: String(block.thinking || '').slice(0, MAX_ARG_LEN) }, stepIndex: 0, since: new Date().toISOString() }
        } else if (block.type === 'text') {
          p.current = { tool: 'typing', args: { text: String(block.text || '').slice(0, MAX_ARG_LEN) }, stepIndex: 0, since: new Date().toISOString() }
        }
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'tool_result' && p._toolMap && p._toolMap[block.tool_use_id]) {
          const rec = p._toolMap[block.tool_use_id]
          p.trail.push({ stepIndex: rec.stepIndex, state: block.is_error ? 'ERROR' : 'DONE', tool: rec.name, args: null, at: new Date().toISOString() })
          if (p.trail.length > MAX_TRAIL) p.trail.shift()
          if (p.current && p.current.stepIndex === rec.stepIndex) p.current = null
        }
      }
    }
  }

  const descriptor = {
    id: 'codebuddy',
    label: 'CB',
    presetId: 'codebuddy-first',
    defaultBackend: DEFAULT_BACKEND,
    defaultMode: 'auto',
    exeName: 'codebuddy',
    binEnvVars: ['CODEBUDDY_BIN', 'CODEBUDDY_EN_BIN', 'WORKBUDDY_BIN'],
    unavailableStatus: 'CODEBUDDY_UNAVAILABLE',
    // 旧 renderResult verbatim 语义：标头用具体 backend（'workbuddy OK'），仅当结果
    // 无 backend 字段时回落 'codebuddy'（= provider.id）。agy/mimo 旧包标头硬编码
    // provider 名，不设此旗。
    backendLabel: true,

    backends: () => BACKENDS.slice(),
    normalizeBackend,
    resolveBackend,

    buildArgv: buildArgvCodebuddy,
    parseJson: parseCodebuddyJson,
    buildResult,
    foldStreamEvent,
    isLimited: isLimitedCodebuddy,
    isTransientCliError,
    failureHint,

    // codebuddy-en 无凭据的确定性前置（v1.3.1 语义，经 kit preflight 钩子实现）：
    // 三通道皆空 → 直接 AUTH_REQUIRED（可操作指引进 stderr），不白跑一次 spawn。
    // 其它后端一律放行。dynamic 沙箱无 fs → dsh-store 通道缺席，abort 提示即可。
    preflight({ args, backend, engine, o }) {
      if (backend !== 'codebuddy-en') return null
      const settings = (o && o.getSettings && o.getSettings()) || null
      const tok = resolveEnToken(settings ? settings.codebuddyEnToken : null)
      if (tok.token) return null
      const authDomain = readBackendAuthDomain('codebuddy-en', {})
      const hint = endpointMismatchHint('codebuddy-en', authDomain, false)
      return {
        abort: {
          ok: false,
          status: 'AUTH_REQUIRED',
          response: '',
          sessionId: null,
          durationSeconds: null,
          numTurns: null,
          totalTokens: null,
          exitCode: null,
          mode: (args && args.mode) || descriptor.defaultMode || 'auto',
          backend: 'codebuddy-en',
          stderr: hint
        }
      }
    },

    tools: {
      run: {
        name: 'codebuddy_run',
        description: 'Dispatch a coding/build/debug/investigation task to the local codebuddy agent CLI and return its final answer. Prefer this for implementation, edits, refactors, multi-file investigation and debugging in every mode. DSH fully controls codebuddy: it always runs non-interactively with permissions auto-approved (codebuddy never prompts). Use read-only native tools only for quick lookups and for final build/test verification. In mode=auto the DSH plan state decides plan vs bypassPermissions. Set background=true for long tasks and collect the result via job_output.',
        inputSchema: RUN_PARAMS
      },
      continue: {
        name: 'codebuddy_continue',
        description: 'Continue an existing codebuddy conversation with a follow-up prompt, reusing codebuddy context. Pass sessionId from a prior codebuddy_run result, or set latest=true to continue the most recent codebuddy conversation. Same DSH-controlled, no-prompt execution as codebuddy_run.',
        inputSchema: CONTINUE_PARAMS
      },
      status: {
        name: 'codebuddy_status',
        description: 'Read a live snapshot of what the local codebuddy agent is currently doing. Returns one section per project (working directory): running count, the current step (tool name + arguments being executed, or agent_response thinking/typing), the recent step trail (tools executed, done/error), the last completed run status + session id, and per-project cumulative usage (runs + total tokens, since codebuddy exposes no quota API). Optional cwd filters to a single project. Call this to check on an in-flight codebuddy_run/codebuddy_continue without waiting for it to finish.',
        inputSchema: STATUS_PARAMS
      }
    },

    extraTools: [],

    // 设置分区（契约 §3）：keystone 统一文件 {codebuddy:{...}}；旧扁平文件的字段
    // 级迁移由 keystone LEGACY_SOURCES 承担（字段名逐字相同）。
    settings: {
      keys: SETTINGS_KEYS,
      secretKeys: ['codebuddyEnToken'],
      defaults: () => normalizeSettings(null),
      normalize: (raw) => normalizeSettings(raw),
      meta() {
        // defaultModel 下拉 = 默认后端（codebuddy 面）的带倍率目录（升级 CLI 后
        // 自动同步）；其余三面目录不同，字段允许自定义输入即可覆盖。促销角标为
        // 0.1.0 有意省略（见头注 TODO）。
        const options = modelCatalogDetailed(DEFAULT_BACKEND, {}).map((x) => ({ value: x.id, label: x.label }))
        return {
          titleSuffix: 'CodeBuddy',
          fields: [
            {
              key: 'preferredBackend', label: '默认后端', type: 'select',
              options: BACKENDS.map((b) => ({ value: b, label: BACKEND_LABELS[b] })),
              note: '新会话未显式指定 backend 时用这里选的后端；单次调用可覆盖。codebuddy-en 需要 codebuddyEnToken 或 DSH 已配 workbuddy key。'
            },
            {
              key: 'defaultModel', label: '默认模型', type: 'select', allowCustom: true, placeholder: '(CLI 默认)',
              options,
              note: '账号实际可用性以服务端实时裁决（400 报文回吐权威清单，桥接自动缓存）。优先选能完成任务里最便宜的，日常任务优先免费（x0.00）。'
            },
            { key: 'codebuddyEnToken', label: 'WorkBuddy 国际版 Token', type: 'secret', note: '仅 backend="codebuddy-en" 需要。国际版登录 token 被 protector key 封装不落盘，只能手工提供；留空则自动尝试 DSH 凭据库的 WORKBUDDY_TOKEN。' },
            { key: 'endpointOverride', label: '端点覆盖', type: 'text', placeholder: 'https://…/v2', note: '一般留空：端点按登录域自动对齐（www.codebuddy.cn 等）。仅在需要强制指定 API 端点时填写，且必须自带 /v2。' }
          ]
        }
      },
      diagnose(snap) {
        const s = normalizeSettings(snap)
        const lines = []
        const seen = new Set()
        // 默认后端一行；codebuddy-en 是 4 面里唯一需要凭据的，恒附一行状态。
        for (const b of [s.preferredBackend, 'codebuddy-en']) {
          if (seen.has(b)) continue
          seen.add(b)
          const d = diagnoseBackend(b, s, {})
          lines.push(b + ': ' + (d.endpoint || '?') + '（登录域 ' + (d.authDomain || '未读到') + '，' + d.tokenHint + '）')
          if (d.hint) lines.push('  ⚠ ' + d.hint)
        }
        return lines.join('\n')
      }
    },

    mcp: { version: '0.2.0' }
  }

  // 三形态共用的工具逻辑（签名保持 keystone/队友接线契约不变）。
  descriptor.runToolLogic = async function (args, exec) {
    return this.runner.coreExecute(args, exec)
  }
  // 旧 preset continueTool.execute verbatim 映射（sessionId 优先，否则 latest）。
  descriptor.continueToolLogic = async function (args, exec) {
    const a = args || {}
    const mapped = { prompt: a.prompt, backend: a.backend, mode: a.mode, model: a.model, effort: a.effort, maxTurns: a.maxTurns, cwd: a.cwd, timeoutSec: a.timeoutSec, background: a.background }
    if (a.sessionId) mapped.sessionId = a.sessionId
    else if (a.latest) mapped.continueLatest = true
    return this.runner.coreExecute(mapped, exec)
  }
  // 旧 statusTool.execute verbatim：cwd 过滤 + 单项目聚合覆写（含 runs/totalTokens）。
  descriptor.statusToolLogic = function (args) {
    const a = args || {}
    const snap = this.engine.statusSnapshot()
    if (a.cwd) {
      const key = String(a.cwd)
      snap.projects = snap.projects.filter((p) => p.cwd === key)
      const g = snap.projects[0]
      if (g) { snap.state = g.state; snap.running = g.running; snap.current = g.current; snap.trail = g.trail; snap.lastStatus = g.lastStatus; snap.lastAt = g.lastAt; snap.lastSessionId = g.lastSessionId; snap.lastBackend = g.lastBackend; snap.fallbackActive = g.fallbackActive; snap.runs = g.runs; snap.totalTokens = g.totalTokens; snap.updatedAt = g.updatedAt }
    }
    return snap
  }

  // 供 preset/dynamic/MCP/测试形态复用的领域函数（不 import home-plugin，全部经
  // 描述符暴露；MCP 面据 buildArgv/parseJson/buildResult/isLimited/failureHint 组
  // 装真实 spawn 执行，语义与旧 mcp/codebuddy-mcp-server.mjs 一致）。
  descriptor.policyText = POLICY_TEXT
  descriptor.limits = { LIMIT_RE: CODEBUDDY_LIMIT_RE }
  descriptor.backendLabels = BACKEND_LABELS
  descriptor.backendEndpoints = BACKEND_ENDPOINTS
  descriptor.authDomainEndpoints = AUTH_DOMAIN_ENDPOINTS
  descriptor.backendAuthIds = BACKEND_AUTH_IDS
  descriptor.staticModelIds = BACKEND_MODEL_IDS
  descriptor.endpointHost = endpointHost
  descriptor.resolveEndpoint = resolveEndpoint
  descriptor.endpointEnv = endpointEnv
  descriptor.endpointMismatchHint = endpointMismatchHint
  descriptor.resolveEnToken = resolveEnToken
  descriptor.readDshWorkbuddyToken = readDshWorkbuddyToken
  descriptor.readBackendAuthDomain = readBackendAuthDomain
  descriptor.diagnoseBackend = diagnoseBackend
  descriptor.backendModelCatalog = backendModelCatalog
  descriptor.modelCatalogDetailed = modelCatalogDetailed
  descriptor.formatModelCatalogText = formatModelCatalogText
  descriptor.parseAccountModels = parseAccountModels
  descriptor.rememberAccountCatalog = rememberAccountCatalog
  descriptor.getAccountCatalog = getAccountCatalog
  descriptor.normalizeProductConfig = normalizeProductConfig
  descriptor.extractModelIds = extractModelIds
  descriptor.extractModelCredits = extractModelCredits
  descriptor.parseCreditValue = parseCreditValue
  descriptor.formatCreditLabel = formatCreditLabel
  descriptor.lookupModelCredits = lookupModelCredits
  descriptor.normalizeSettings = normalizeSettings

  descriptor.attach = function (hostOpts) {
    host = hostOpts || {}
    this.engine = createStatusEngine({ provider: this, publish: host.publish })
    const runner = createRunner(Object.assign({}, host, { provider: this, engine: this.engine }))
    this.runner = runner
    return runner
  }
  descriptor.hostOptions = () => host
  return descriptor
}
