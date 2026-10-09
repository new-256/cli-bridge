// providers/agy.mjs — agy provider descriptor.
// ⚠️ PLACEHOLDER（Lead 建的图占位）：真实移植见 PROVIDER-CONTRACT.md §7-agy，
// 由 provider-agy 任务替换本文件。保持导出签名不变，集成测试即可跑通。
import { createStatusEngine, createRunner, projectName, clampInt, shortLabel, summarizeArgs, isLimited, fallbackResult, renderResult, renderStatus } from '../core/bridge-kit.mjs'

export default function defineProvider(deps = {}) {
  const descriptor = {
    id: 'agy', label: 'AGY', presetId: 'cordis-agy', defaultBackend: null, defaultMode: 'auto',
    exeName: 'agy', binEnvVars: ['AGY_BIN', 'AGY_CLI'], unavailableStatus: 'CLI_UNAVAILABLE',
    backends() { return null },
    normalizeBackend(v) { return v === undefined || v === null ? null : String(v) },
    resolveBackend(args, target, preferred) { return preferred || null },
    buildArgv(exePrefix, args, opts) {
      const argv = Array.isArray(exePrefix) ? exePrefix.slice() : [String(exePrefix)]
      argv.push('-p', String(args.prompt || ''))
      return { argv, mode: opts && opts.defaultMode ? opts.defaultMode : 'auto', timeoutSec: clampInt(args.timeoutSec, 600, 10, 3600) }
    },
    parseJson(stdoutText) {
      const lines = String(stdoutText || '').split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
      for (let i = lines.length - 1; i >= 0; i--) { try { const o = JSON.parse(lines[i]); if (o && o.type === 'result') return o } catch (e) {} }
      return null
    },
    buildResult(parsed, outcome, mode, stderrText, stdoutText, backend) {
      if (!parsed) return { ok: false, status: outcome && outcome.exitCode === 0 ? 'PARSE_ERROR' : 'FAILED', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: outcome ? outcome.exitCode : null, mode, backend, stderr: String(stderrText || '').slice(-2000) }
      return { ok: parsed.subtype === 'success', status: parsed.subtype === 'success' ? 'SUCCESS' : 'FAILED', response: String(parsed.result || ''), sessionId: parsed.conversationId || parsed.sessionId || null, durationSeconds: parsed.durationSeconds == null ? null : Number(parsed.durationSeconds), numTurns: parsed.numTurns == null ? null : Number(parsed.numTurns), totalTokens: parsed.totalTokens == null ? null : Number(parsed.totalTokens), exitCode: outcome ? outcome.exitCode : null, mode, backend, stderr: String(stderrText || '').slice(-2000) }
    },
    tools: {
      run: { name: 'agy_run', description: 'PLACEHOLDER: dispatch a task to the local agy CLI.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, cwd: { type: 'string' }, timeoutSec: { type: 'integer' } }, required: ['prompt'], additionalProperties: true } },
      continue: { name: 'agy_continue', description: 'PLACEHOLDER: continue an agy conversation.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, conversationId: { type: 'string' }, latest: { type: 'boolean' } }, required: ['prompt'], additionalProperties: true } },
      status: { name: 'agy_status', description: 'PLACEHOLDER: live snapshot of agy activity.', inputSchema: { type: 'object', properties: { cwd: { type: 'string' } }, additionalProperties: true } }
    },
    settings: { keys: [], defaults: () => ({}), normalize: () => ({}), meta: () => ({}), diagnose: () => '' },
    mcp: { version: '0.1.0' }
  }

  descriptor.runToolLogic = async function (args, exec) { return this.runner.coreExecute(args, exec) }
  descriptor.continueToolLogic = async function (args, exec) { return this.runner.coreExecute(args, exec) }
  descriptor.statusToolLogic = async function (args) { return this.engine.statusSnapshot() }

  // 工厂装配（provider 无关骨架 + 描述符）：宿主形态通过 deps 注入 runner 依赖。
  descriptor.attach = function (hostOpts) {
    this.engine = createStatusEngine({ provider: this, publish: hostOpts.publish })
    const runner = createRunner(Object.assign({}, hostOpts, { provider: this, engine: this.engine }))
    this.runner = runner
    return runner
  }
  return descriptor
}
