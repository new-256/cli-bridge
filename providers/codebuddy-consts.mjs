// providers/codebuddy-consts.mjs — codebuddy 的提示词策略与后端注册表常量（纯数据）。
//
// 从 providers/codebuddy.mjs 拆出，让主描述符留在 600 行红线内（规则 §26）。
// build 会把 providers/codebuddy-*.mjs 全部内联进 dynamic 沙箱同一作用域。
// 命名纪律：顶层名绝不与 core/bridge-kit.mjs 同名（同作用域重复声明 = 语法错）。
// ⚠️ 注释里绝不写出口令标记字面量（build 全局替换会把注释劈开）。

// ── 提示词策略段（旧 preset POLICY_TEXT verbatim；systemPrompt order 5）────────
export const POLICY_TEXT = [
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

// ── 后端注册表（旧 core verbatim：端点按登录域自动对齐）───────────────────────
export const CODEBUDDY_LIMIT_RE = /rate.?limit|ratelimit|\b429\b|too many|quota|insufficient|credit|balance|exhausted|exceed|\bnetwork\b|offline|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|\btimeouts?\b|timed out|unavailable|\b50[023]\b|\b40[13]\b|unauthorized|invalid api|api key|proxy|socket|tls|ssl|\bdns\b|网络|超时|限流|流量|受限|配额|金额|余额|额度|认证|连接|断开/i

// ── 后端注册表（旧 core verbatim：端点按登录域自动对齐）───────────────────────
export const BACKENDS = ['codebuddy', 'codebuddy-intl', 'codebuddy-en', 'workbuddy']

export const BACKEND_ENDPOINTS = {
  'codebuddy': 'https://www.codebuddy.ai/v2',
  'codebuddy-intl': 'https://www.codebuddy.ai/v2',
  'codebuddy-en': 'https://www.workbuddy.ai/v2',
  'workbuddy': 'https://copilot.tencent.com/v2'
}

export const AUTH_DOMAIN_ENDPOINTS = {
  'www.codebuddy.cn': 'https://www.codebuddy.cn/v2',
  'www.codebuddy.ai': 'https://www.codebuddy.ai/v2',
  'www.workbuddy.ai': 'https://www.workbuddy.ai/v2',
  'copilot.tencent.com': 'https://copilot.tencent.com/v2'
}

export const BACKEND_LABELS = {
  'codebuddy': 'CodeBuddy 国内版（npm CLI）',
  'codebuddy-intl': 'CodeBuddy 国际版（npm CLI · 国际面）',
  'codebuddy-en': 'WorkBuddy 国际版（WorkBuddyAI 桌面 CLI）',
  'workbuddy': 'WorkBuddy 国内版（桌面 CLI）'
}

export const BACKEND_ALIASES = {
  'workbuddy-en': 'codebuddy-en',
  'workbuddy-ai': 'codebuddy-en',
  'codebuddy-ioa': 'codebuddy-intl',
  'codebuddy-international': 'codebuddy-intl',
  'codebuddy-oversea': 'codebuddy-intl'
}

export const DEFAULT_BACKEND = 'codebuddy'

export const SETTINGS_KEYS = ['preferredBackend', 'defaultModel', 'codebuddyEnToken', 'endpointOverride']

