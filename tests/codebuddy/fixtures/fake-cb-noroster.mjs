// tests/codebuddy/fixtures/fake-cb-noroster.mjs — 假 codebuddy CLI：`--help` 无名册、
// 账号探测也无清单（模拟「该产品面未登录 / 端点拒绝」）。用于验证：
//   拿不到任何实时名册时必须 ok:false + 可操作错误，绝不静默返回空列表或伪造。
process.stdout.write('codebuddy: not logged in for this face (probe stub)\n')
process.exit(1)
