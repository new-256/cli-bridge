// tests/keystone/persona-prompt-vars.test.mjs — 预设的红线闸门。
//
// 两类会**让整个预设不可用**的缺陷，都在这台 DSH（0.2.1-alpha.5）上实测踩过：
//
// ① 未注册的提示词变量（2026-10-18 事故）
//    用户选中 agy 预设即整轮失败：
//      unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
//      registered variables: provider, model
//    dsh-system-prompt 的 interpolate() 对 {{name}} 严格解析：名字须匹配
//    /^[a-z][a-z0-9_]*$/ 且必须**已注册**，否则在【任何模型请求之前】抛错。
//    当前只注册 provider / model（dsh-agent-loop），工作目录由 working-directory
//    服务以「不插值的用户上下文」提供 ⇒ persona 里绝不能出现 {{cwd}}。
//
// ② dsh-tool-subagent 已删除的配置字段
//    - persona / toolFilter：apply() 里**显式 throw**
//      （"…no longer supported; configure persona and tool plugins in an Agent Preset
//        and select it with agentPreset (spawn only)"）⇒ 整个预设挂载失败；
//      角色人格只能作为独立 Agent Preset，由委派行经 agentPreset 选择。
//    - backgroundMode：已从 schema 删除。机制经实装包双路径实测：未知/已删键会
//      **通过校验并被原样保留**（`Config['~standard'].validate({provider,backgroundMode})`
//      无 issues、值幸存；schemastery 无 strict 开关），只是**无人读取**该键
//      ⇒ 属「静默**忽略**」而非「静默丢弃」。所以**运行时不报错**，静态闸门是唯一防线。
//    当前 schema 接受：provider / toolName / modelSelectionSettings / agentOptions /
//                      agentPreset / allowedAgentPresets / maxDepth。
//
// 双管齐下：① 内存里的单源定义（plugin-list.mjs 的 buildPlugins 输出）；
//           ② 磁盘上的生成物（agent.cordis.yml 全文，防只手改生成物）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRESET_DIRS } from '../../providers/registry.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** DSH 提示词循环当前注册的变量（dsh-agent-loop：provider / model）。 */
const REGISTERED = ['provider', 'model']

/** provider id → preset 目录名：单一来源 = providers/registry.mjs 的 PRESET_DIRS。
 *  （此处曾自带一份硬编码副本，新增 provider 漏改 → 新预设静默不受本测试覆盖。） */

/** 成员预设目录（0.2.1 起角色人格只能作为独立预设存在；无生成物 yml）。 */
const MEMBER_DIRS = ['mimo-member']

/** dsh-tool-subagent 0.2.1 起已删除的配置字段（写进去要么被显式拒绝、要么被静默忽略）。 */
const REMOVED_TOOL_SUBAGENT_FIELDS = ['persona', 'toolFilter', 'backgroundMode']

/** 抽取文本里全部 {{...}} 变量名。 */
function extractVars(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(/\{\{([^{}]*)\}\}/g)) out.push(m[1])
  return out
}

/**
 * 判断 YAML 文本里是否把某字段当作【键】使用。
 * 不能用 `includes(field)`：`name: '@deepseek-ai/dsh-persona'` 与 `- id: persona`
 * 都会命中子串 'persona'，但那是插件名/行 id，不是被拒的 config 字段。
 */
function hasFieldKey(yml, field) {
  return new RegExp(`(^|\\n)[ \\t]*${field}[ \\t]*:`, 'm').test(yml)
}

/** 展平预设行表：把 cordis:group 的 config 数组展开成一维（成员可能出现在任意层级）。 */
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

async function loadRows(dir) {
  const mod = await import(new URL(`../../preset/${dir}/plugin-list.mjs`, import.meta.url).href)
  return flattenRows(mod.buildPlugins({}))
}

for (const dir of [...Object.values(PRESET_DIRS), ...MEMBER_DIRS]) {
  test(`preset '${dir}'（内存单源）：persona 只用已注册变量 ${REGISTERED.join('/')}，且不设 suffix`, async () => {
    const rows = await loadRows(dir)
    const personas = rows.filter((r) => r.name === '@deepseek-ai/dsh-persona')
    assert.ok(personas.length > 0, 'persona row present')
    for (const p of personas) {
      const cfg = p.config || {}
      for (const field of ['prefix', 'suffix']) {
        for (const v of extractVars(cfg[field])) {
          assert.ok(
            REGISTERED.includes(v),
            `persona.${field} 引用了未注册变量 {{${v}}}（已注册：${REGISTERED.join(', ')}）—— 会让整个预设组装失败`,
          )
        }
      }
      assert.equal(
        cfg.suffix,
        undefined,
        'persona.suffix 必须缺席：{{cwd}} 不是注册变量，工作目录由 working-directory 服务提供',
      )
    }
  })

  test(`preset '${dir}'（内存单源）：tool-subagent 行不含已删除字段（${REMOVED_TOOL_SUBAGENT_FIELDS.join('/')}）`, async () => {
    const rows = await loadRows(dir)
    const subagentRows = rows.filter((r) => r.name === '@deepseek-ai/dsh-tool-subagent')
    // 成员预设是叶子代理（只挂 persona + 只读文件面 + 桥接行），本来就没有委派行；
    // provider 主预设必须有委派行 —— 两者分开断言，避免把"没有"误当成"没检查"。
    const isMember = MEMBER_DIRS.includes(dir)
    if (!isMember) assert.ok(subagentRows.length > 0, 'provider preset must carry tool-subagent rows')
    for (const row of subagentRows) {
      for (const field of REMOVED_TOOL_SUBAGENT_FIELDS) {
        assert.ok(
          !Object.hasOwn(row.config || {}, field),
          `tool-subagent 行 '${row.id}' 仍带已删除字段 ${field} —— 会被显式拒绝或静默忽略（运行时不报错），必须删掉`,
        )
      }
    }
  })
}

for (const dir of Object.values(PRESET_DIRS)) {
  test(`preset '${dir}'（磁盘生成物）：agent.cordis.yml 只用已注册变量且无残留死字段`, () => {
    const yml = readFileSync(join(ROOT, 'preset', dir, 'agent.cordis.yml'), 'utf8')
    for (const v of extractVars(yml)) {
      assert.ok(
        REGISTERED.includes(v),
        `agent.cordis.yml 引用了未注册变量 {{${v}}}（已注册：${REGISTERED.join(', ')}）`,
      )
    }
    assert.ok(!yml.includes('{{cwd}}'), 'agent.cordis.yml 不得残留 {{cwd}}')
    for (const field of REMOVED_TOOL_SUBAGENT_FIELDS) {
      assert.ok(!hasFieldKey(yml, field), `agent.cordis.yml 仍含已删除字段 ${field}`)
    }
  })
}

// ── 跨文件一致性：委派行引用的成员预设必须真实存在且 id 对得上 ──────────────────
// 引用的 id 与成员预设的 meta.id 不一致 ⇒ 委派行 validate() 时 readDocument 抛
// agent-preset/not-found ⇒ 整组预设挂载失败。这条只能跨文件查，故放在这里。
for (const [providerId, dir] of Object.entries(PRESET_DIRS)) {
  const memberDir = MEMBER_DIRS.find((d) => d.startsWith(providerId))
  if (!memberDir) continue
  test(`preset '${dir}'：委派行 agentPreset 指向真实成员预设 '${memberDir}'`, async () => {
    const member = await import(new URL(`../../preset/${memberDir}/plugin-list.mjs`, import.meta.url).href)
    const referenced = []
    for (const row of await loadRows(dir)) {
      if (row.name === '@deepseek-ai/dsh-tool-subagent' && row.config && row.config.agentPreset !== undefined) {
        referenced.push({ row: row.id, provider: row.config.provider, id: row.config.agentPreset })
      }
    }
    assert.ok(referenced.length > 0, '本 provider 应至少有一行经 agentPreset 选择成员预设')
    for (const ref of referenced) {
      assert.equal(ref.id, member.meta.id, `tool-subagent 行 '${ref.row}' 的 agentPreset 与成员预设 id 不一致`)
      // agentPreset 只有 in-process spawn 支持；fork 与外部后端会 reject 它。
      assert.equal(ref.provider, 'spawn', `只有 spawn 行可以带 agentPreset（'${ref.row}' 的 provider=${ref.provider}）`)
    }
  })
}
