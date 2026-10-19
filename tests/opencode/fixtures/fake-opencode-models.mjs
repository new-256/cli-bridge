// tests/opencode/fixtures/fake-opencode-models.mjs — 假 opencode CLI `models` 子命令输出。
// 形态与本机实测 `opencode models` 一致：纯文本每行 `provider/model`，另带一行表头，
// 用于验证解析器会丢弃表头/说明行。免费模型（-free 结尾）与付费模型混合，
// 用于验证「免费优先」排序。仅供 settings.refreshModels / parseModelList 测试使用。
process.stdout.write('Available models:\n')
process.stdout.write('opencode/beam-free\n')
process.stdout.write('opencode/deepseek-v4.1-flash-free\n')
process.stdout.write('opencode/gpt-5.5\n')
process.stdout.write('opencode-go/longcat-2.5-preview-free\n')
process.exit(0)
