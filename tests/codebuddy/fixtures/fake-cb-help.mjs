// tests/codebuddy/fixtures/fake-cb-help.mjs — 假 codebuddy CLI：`--help` 输出带模型名册。
//
// 关键：名册刻意**折行**（模拟 yargs 在窄终端下的换行），且把 `minimax-m3-pay`
// 从中间断开 —— 这正是线上 19↔18 抖动的真实成因（实测踩到）。解析器必须靠
// 「去掉括号内所有空白再按逗号切」才能稳定还原。
const ROSTER = [
  'hy4-preview', 'hy3', 'hy3-x', 'step-5-preview', 'space-bunny', 'deepseek-v4.1-flash',
  'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo',
  'minimax-m3-pay', 'minimax-m2.7', 'kimi-k3-2', 'kimi-k2.8-preview', 'kimi-k2.7',
  'kimi-k2.6', 'deepseek-v4-pro'
]

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  // 每 6 个换一行，并在 minimax-m3-pay 中间插入换行（还原真实折行行为）
  const chunks = []
  for (let i = 0; i < ROSTER.length; i += 6) chunks.push(ROSTER.slice(i, i + 6).join(', '))
  let body = chunks.join(',\n                                   ')
  body = body.replace('minimax-m3-pay', 'minimax-\nm3-pay')
  process.stdout.write('  --model <model>  Model for the current session. Please provide the model ID.\n' +
    '                          Currently supported: (' + body + ')\n')
  process.exit(0)
}

// 账号探测路径：打印 400 报文形态的账号清单
process.stdout.write('Error: 400 model [__clb_probe_invalid__] service info not found\n' +
  'Currently supported models for your account:\n' +
  ROSTER.map((id) => '- ' + id).join('\n') + '\n')
process.exit(1)
