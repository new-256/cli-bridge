// tests/mimo/fixtures/fake-mimo-models.mjs — 假 mimo CLI `models` 子命令输出。
// 形态与本机实测 `mimo models` 一致：每行 `provider/model — window 1.05M, compacts at 944K`
// （分隔符是中文破折号 U+2014），表头一行 `Available models:` 应被解析器丢弃。
// 仅供 fetchMimoModelsSync / settings.meta 的下拉数据源测试使用。
process.stdout.write('Available models:\n')
process.stdout.write('xiaomi/mimo-v2.6-flash — window 1.05M, compacts at 944K\n')
process.stdout.write('xiaomi/mimo-v2.6-pro — window 1.05M, compacts at 944K\n')
