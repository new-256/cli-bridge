// tests/mimo/fixtures/fake-mimo-limit.mjs — 假 mimo CLI：输出 MiMo 免费 API 已结束错误
// （旧 core.test.mjs 同款真实文案），退出码 1。验证 mimo 专属 LIMIT_RE（含 sign in /
// configure a third-party / free API service has ended）与 kit 版 LIMIT_RE 的差异锁定。
process.stdout.write('{"type":"error","timestamp":1790189983335,"sessionID":"ses_err_1","error":{"name":"UnknownError","data":{"message":"MiMo free API service has ended. Sign in or configure a third-party API."}}}\n')
process.exit(1)
