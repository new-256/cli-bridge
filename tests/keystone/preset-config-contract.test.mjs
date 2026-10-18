// tests/keystone/preset-config-contract.test.mjs — preset 行 config 的 **schema 派生**契约闸门。
//
// 为什么必须有（替代手写字段名单）：
//   `persona-prompt-vars.test.mjs` 的死字段断言依赖 `REMOVED_TOOL_SUBAGENT_FIELDS =
//   ['persona','toolFilter','backgroundMode']` —— 一份**手写名单**，且只作用于
//   `dsh-tool-subagent` 这一个包。上游删掉/改类型任何**别的**配置键时，那份名单照旧全绿，
//   预设会带着一个无人读、也不报错的死键发出去。
//
//   而且运行期抓不到这类漂移：cordis 用 Standard Schema 校验行 config ——
//   `cordis/lib/index.js:958` `runtime.Config["~standard"].validate(config)`，
//   `:960` 有 `issues` 才抛 `ValidationError`；而 schemastery 的 schema **保留**未知键
//   （2026-10-18 实测：`validate({provider:'spawn', backgroundMode:'continuable'})` →
//   `issues: none` 且 `value.backgroundMode` 原样幸存；`Config.strict` 为 undefined）。
//   即未知键是被「静默忽略」而非「拒绝」。
//   ⇒ 只有把行 config 对着**实装包现场取到的 schema**做静态比对，才能第一时间暴露漂移。
//
// 判定策略（三类模块形态，按实装模块现场分支；**不维护任何字段名单**）：
//   ① 导出 `Config`（或 `default.Config`，schemastery 对象 schema）：
//      - 断言 `Config['~standard'].validate(rowConfig)` 的 `issues` 为空；
//      - 断言 rowConfig 每个键 ∈ 声明键集（`Config.dict`）。
//   ② 只导出 `resolveConfig()`（如 dsh-plan-mode）：调用它、断言不抛。
//      该形态拿不到声明键集 ⇒ 键集断言不可用，**显式记入 limitations 并在输出里打印**。
//   ③ 都不导出（如 dsh-command-goal / dsh-command-compact / dsh-tool-subagent-control）：
//      该包不接受任何 config 键 ⇒ 断言该行**没有传** config。
//      `disabled` 是**行元数据**（由 loader 求值），不算 config，故不参与本判定。
//
// 环境依赖（显式，不静默降级）：
//   实装包根取 `DSH_NODE_MODULES`；否则 `%APPDATA%\DSH Desktop\backend\dsh\node_modules`。
//   **整棵实装树都找不到**（换机/无 DSH）⇒ 整组 `skip`，skip 原因里列出**尝试过的路径**
//   —— 这是"环境不具备"，不是"检查通过"。
//   **树在、但某个 preset 行引用的包解析不到** ⇒ 该行标为「未校验」并在汇总测试里**硬失败**
//   （逐条点名）。理由：树在却解析不到 = 真实的契约破裂（该预设会在宿主挂载失败），
//   属用户规则「真实缺陷第一时间暴露」要拦的形状。故 `unchecked` 不是容忍计数，而是红。
//   自引用子路径（`@luchenglong/cli-bridge/preset-*`）解析失败同样直接判为 problem
//   —— 那是本仓 exports 与 preset 行不一致，与"环境缺包"无关。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 覆盖对象：4 个 provider 预设 + 1 个成员预设（单源 plugin-list.mjs，无生成物 yml）。 */
const PRESET_DIRS = ['agy-first', 'codebuddy-first', 'mimo-first', 'mimo-member', 'opencode-first']

// ── 实装包根解析（DSH_NODE_MODULES 优先）──────────────────────────────────────
const DSH_NM_CANDIDATES = [
  process.env.DSH_NODE_MODULES,
  process.env.APPDATA ? join(process.env.APPDATA, 'DSH Desktop', 'backend', 'dsh', 'node_modules') : null,
].filter((p) => typeof p === 'string' && p.length > 0)
const DSH_NM = DSH_NM_CANDIDATES.find((p) => existsSync(p)) || null

const SELF_ANCHOR = join(ROOT, 'package.json')
const SELF_PKG = JSON.parse(readFileSync(SELF_ANCHOR, 'utf8'))
const SELF_PREFIX = SELF_PKG.name + '/'

// 锚在实装 DSH 树里解析裸名与**子路径导出**（exports map 生效，不按目录名拼路径）：
// 实测 `createRequire(<dsh>/node_modules/@deepseek-ai/dsh/package.json).resolve(...)`
// 对 26 个 specifier 全部成功，含 `@deepseek-ai/dsh-plugin-manager/tools`、
// `@deepseek-ai/dsh-tool-subagent-control/list-agents` 两个子路径导出。
const requireFromDsh = DSH_NM ? createRequire(join(DSH_NM, '@deepseek-ai', 'dsh', 'package.json')) : null
// 自引用（`@luchenglong/cli-bridge/preset-*`）：锚在本包 package.json，走 exports 自引用语义。
const requireFromSelf = createRequire(SELF_ANCHOR)

const SKIP_REASON = 'installed DSH node_modules not found — tried: ' +
  (DSH_NM_CANDIDATES.length ? DSH_NM_CANDIDATES.join(' | ') : '(no DSH_NODE_MODULES and no APPDATA env)')

/** 展平 preset 行表：`cordis:group` 的 config 数组展开成一维（成员可出现于任意层级）。 */
function flattenRows(rows) {
  const out = []
  const walk = (list) => {
    for (const row of list || []) {
      if (!row || typeof row !== 'object') continue
      out.push(row)
      if (Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(rows)
  return out
}

/** 取实装模块的 config 校验器；返回该模块的形态描述。 */
function makeValidator(mod) {
  const schema = pickSchema(mod)
  if (schema) {
    return {
      form: 'Config[' + "'~standard'" + '] v' + schema['~standard'].version + ' (' + schema['~standard'].vendor + ')',
      declared: schema.dict ? Object.keys(schema.dict) : null,
      validate: (raw) => schema['~standard'].validate(raw),
    }
  }
  if (typeof mod.resolveConfig === 'function') {
    return {
      form: 'resolveConfig()',
      declared: null,
      validate: (raw) => {
        try { mod.resolveConfig(raw); return { value: raw } }
        catch (e) { return { issues: [{ message: String((e && e.message) || e) }] } }
      },
    }
  }
  return { form: null, declared: null, validate: null }
}

/** 实装模块自带的 schemastery schema：优先同名导出，其次 default 上的静态 Config。 */
function pickSchema(mod) {
  if (mod.Config && mod.Config['~standard']) return mod.Config
  if (mod.default && mod.default.Config && mod.default.Config['~standard']) return mod.default.Config
  return null
}

/** 把 preset 行的 `name` 解析成实装模块的绝对文件路径。抛错由调用方分类处理。 */
function resolveRowModule(spec) {
  if (spec.startsWith(SELF_PREFIX)) return requireFromSelf.resolve(spec)
  return requireFromDsh.resolve(spec)
}

/**
 * 审计全部 5 个 preset 的每一行（结果记忆化：多次调用只算一次）。
 * @returns {Promise<{rows: object[], problems: string[], unchecked: object[], limitations: string[]}>}
 */
let auditPromise = null
function auditAll() {
  auditPromise ??= (async () => {
    const report = { rows: [], problems: [], unchecked: [], limitations: [] }

    for (const dir of PRESET_DIRS) {
      const mod = await import(pathToFileURL(join(ROOT, 'preset', dir, 'plugin-list.mjs')).href)
      const rows = flattenRows(mod.buildPlugins({}))

      for (const row of rows) {
        if (row.name === 'cordis:group') continue // 结构行：config 是子行列表，不是插件 config
        const where = `preset '${dir}' row '${row.id}' (${row.name})`
        const entry = { dir, id: row.id, name: row.name, where, status: 'verified', form: null }
        report.rows.push(entry)

        const cfg = row.config && !Array.isArray(row.config) ? row.config : {}
        const keys = Object.keys(cfg)

        let modulePath
        try {
          modulePath = resolveRowModule(row.name)
        } catch (e) {
          if (row.name.startsWith(SELF_PREFIX)) {
            // 本仓自己的 exports 子路径解析不到 = 真实的契约破裂（不是环境缺包）。
            entry.status = 'problem'
            report.problems.push(`${where}: 自引用子路径解析失败 (${e.code}) —— 与package.json exports 不一致`)
          } else {
            entry.status = 'unchecked'
            report.unchecked.push({ where, reason: e.code || String(e && e.message) })
          }
          continue
        }

        const implMod = await import(pathToFileURL(modulePath).href)
        const v = makeValidator(implMod)
        entry.form = v.form || 'no-schema'

        if (!v.validate) {
          // 形态③：该包不导出 schema ⇒ 不接受任何 config 键。
          if (keys.length > 0) {
            entry.status = 'problem'
            report.problems.push(`${where}: 该包未导出 config schema（不接受任何键），但行里传了 ${JSON.stringify(keys)} [${v.form || 'no Config / no resolveConfig'}]`)
          }
          continue
        }

        const result = v.validate(cfg)
        if (result.issues) {
          entry.status = 'problem'
          report.problems.push(`${where}: 实装 schema 拒绝该 config [${v.form}] —— ` +
            result.issues.map((i) => i.message).join('; '))
          continue
        }

        if (v.declared) {
          const undeclared = keys.filter((k) => !v.declared.includes(k))
          if (undeclared.length > 0) {
            entry.status = 'problem'
            report.problems.push(`${where}: 键 ${JSON.stringify(undeclared)} 不在实装 schema 的声明键集里 ` +
              `[${v.form}]（声明键：${v.declared.join(', ')}）—— schemastery 会原样保留该键但无人读取 ⇒ 静默忽略的错误配置`)
          }
        } else if (keys.length > 0) {
          // 形态②：无声明键集可用 —— 显式记账，绝不当作"已校验"糊过去。
          entry.status = 'verified-nokeyset'
          report.limitations.push(`${where}: 该包只导出 resolveConfig()、无声明键集，键集断言不可用（已按"调用不抛"判定）[${v.form}]`)
        }
      }
    }
    return report
  })()
  return auditPromise
}

const dirRows = (report, dir) => report.rows.filter((r) => r.dir === dir)

for (const dir of PRESET_DIRS) {
  test(`preset '${dir}'：每一行的 config 都被实装包 schema 接受（schema 派生·无字段名单）`, { skip: DSH_NM ? false : SKIP_REASON }, async (t) => {
    const report = await auditAll()
    const mine = dirRows(report, dir)
    assert.ok(mine.length > 0, `preset '${dir}' 解析出 0 行 —— plugin-list.mjs 可能坏了`)

    const bad = mine.filter((r) => r.status === 'problem')
    const unchecked = mine.filter((r) => r.status === 'unchecked')
    for (const u of unchecked) t.diagnostic(`WARNING 未校验: ${u.where} — ${u.reason}`)
    for (const l of mine.filter((r) => r.status === 'verified-nokeyset')) {
      t.diagnostic(`NOTE 键集断言不可用: ${l.where} [${l.form}]`)
    }
    t.diagnostic(`preset '${dir}': ${mine.length} 行 = ${mine.length - bad.length - unchecked.length} 已校验 + ${unchecked.length} 未校验`)

    assert.deepEqual(
      bad.map((r) => `${r.where} [${r.form}]`),
      [],
      `preset '${dir}' 有 ${bad.length} 行 config 与实装包 schema 不符：\n` +
        report.problems.filter((p) => p.includes(`preset '${dir}' `)).join('\n'),
    )
  })
}

test('preset config 契约：汇总（已校验 / 未校验 行数必须对得上）', { skip: DSH_NM ? false : SKIP_REASON }, async (t) => {
  const report = await auditAll()
  const problem = report.rows.filter((r) => r.status === 'problem').length
  const unchecked = report.rows.filter((r) => r.status === 'unchecked').length
  const noKeyset = report.rows.filter((r) => r.status === 'verified-nokeyset').length
  const verified = report.rows.length - problem - unchecked

  t.diagnostic(`行总计 ${report.rows.length} = 已校验 ${verified}（其中 ${noKeyset} 行仅"调用不抛"、键集断言不可用） + 未校验 ${unchecked} + 不符 ${problem}`)
  t.diagnostic(`实装包根: ${DSH_NM}`)
  t.diagnostic(`覆盖 preset: ${PRESET_DIRS.join(', ')}`)
  for (const l of report.limitations) t.diagnostic(`NOTE ${l}`)

  assert.ok(report.rows.length > 0, '未解析出任何 preset 行')
  assert.equal(verified + unchecked + problem, report.rows.length, '行数分类和对不上（统计逻辑坏了）')
  // 未校验必须为零才算真正覆盖到；>0 时逐条点名，绝不让它悄悄过去。
  assert.deepEqual(
    report.unchecked.map((u) => `${u.where} — ${u.reason}`),
    [],
    `有 ${unchecked} 行因缺包未校验（preset 引用的实装包在当前 DSH 树里解析不到）：`,
  )
})
