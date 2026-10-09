#!/usr/bin/env node
// bin/agy-quota.mjs
//
// 查询 agy 所用 Google AI 套餐（Antigravity OAuth consumer）的池子额度。
// 链路（参考开源项目 lbjlaq/Antigravity-Manager，已实测打通）：
//   1. 读 Windows 凭据管理器 gemini:antigravity（agy 登录时写入的 OAuth token）
//   2. 用 refresh_token + 公开的 Antigravity OAuth client 刷新 access_token
//   3. POST fetchAvailableModels        -> 每模型池子剩余百分比 remainingFraction
//   4. POST retrieveUserQuotaSummary    -> 分组套餐余量（weekly + 5h 双窗口）
//
// 用法：
//   node bin/agy-quota.mjs            # stdout 输出 JSON
//   node bin/agy-quota.mjs --summary  # 仅输出一行紧凑摘要（灯 tooltip 用）
//
// 输出 JSON：
//   { ok, models: [{name, percentage, resetTime, displayName}...],
//     groups: [{displayName, buckets: [{bucketId, window, remainingFraction, resetTime}]}],
//     tier, tokenSource, error? }
//
// 独立运行，无 npm 依赖（Node 18+ fetch + child_process）。

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const CLOUDCODE_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
]
const SUMMARY_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
]
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Antigravity 官方 OAuth client（consumer 登录用）。为避免在仓库中硬编码凭据
// （GitHub secret-scanning 会拦截），运行时优先读环境变量，否则从本机已安装的
// Antigravity 扩展文件动态提取（jlcodes.antigravity-cockpit 扩展的 out/extension.js
// 中硬编码了官方 client_id / client_secret）。
const OAUTH_CLIENT_ID = process.env.AGY_OAUTH_CLIENT_ID || detectAntigravityOAuth()[0]
const OAUTH_CLIENT_SECRET = process.env.AGY_OAUTH_CLIENT_SECRET || detectAntigravityOAuth()[1]

function detectAntigravityOAuth() {
  try {
    const fs = require('node:fs')
    const { homedir } = require('node:os')
    const { join } = require('node:path')
    const exts = join(homedir(), '.antigravity', 'extensions')
    const entries = fs.readdirSync(exts, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.includes('antigravity-cockpit'))
    for (const dir of entries) {
      const f = join(exts, dir.name, 'out', 'extension.js')
      if (!fs.existsSync(f)) continue
      const txt = fs.readFileSync(f, 'utf8')
      const idm = txt.match(/["']([0-9]{12,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com)["']/)
      const sm = txt.match(/["'](GOCSPX-[A-Za-z0-9_-]{20,})["']/)
      if (idm && sm) return [idm[1], sm[1]]
    }
  } catch (e) { /* ignore */ }
  return ['', '']
}
const USER_AGENT = 'vscode/1.95.3 (Antigravity/4.3.0)'
const CRED_TARGET = 'gemini:antigravity'

// 读 Windows 凭据管理器条目（CredRead P/Invoke），返回 blob 的 UTF-8 文本。
// 方案：用 csc.exe 现编译一个最小 C# 程序（避免 PowerShell Add-Type 在
// 本机因 LIB 自引用失效的问题；编译只需几秒，成功后在 %TEMP% 缓存）。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CRED_CS = `
using System;
using System.Runtime.InteropServices;
using System.Text;
class AGYCredDump {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CRED { public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int BlobSize; public IntPtr Blob; public int Persist; public int AttrCount; public IntPtr Attr; public IntPtr Alias; public IntPtr UserName; }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CredRead(string target, int type, int reserved, out IntPtr cred);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern void CredFree(IntPtr p);
  static int Main(string[] args) {
    string target = args.Length > 0 ? args[0] : "gemini:antigravity";
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) { Console.Error.WriteLine("ERR credread " + Marshal.GetLastWin32Error()); return 1; }
    try {
      CRED c = (CRED)Marshal.PtrToStructure(p, typeof(CRED));
      byte[] b = new byte[c.BlobSize];
      Marshal.Copy(c.Blob, b, 0, c.BlobSize);
      Console.OutputEncoding = Encoding.UTF8;
      Console.WriteLine(Encoding.UTF8.GetString(b));
      return 0;
    } finally { CredFree(p); }
  }
}
`

function getCredDumpExe() {
  const dir = join(tmpdir(), 'agy-quota-tool')
  const exe = join(dir, 'agy-cred-dump.exe')
  if (existsSync(exe)) return exe
  mkdirSync(dir, { recursive: true })
  const csPath = join(dir, 'agy-cred-dump.cs')
  writeFileSync(csPath, CRED_CS, 'utf8')
  const csc = process.env.WINDIR + '\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
  const r = spawnSync(csc, ['/nologo', '/out:' + exe, csPath], { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  if (r.status !== 0 || !existsSync(exe)) throw new Error('csc compile failed: ' + String(r.stderr || r.stdout || '').slice(0, 400))
  return exe
}

function readWindowsCredential(target) {
  const exe = getCredDumpExe()
  const r = spawnSync(exe, [target], { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 })
  if (r.error) throw new Error('cred-dump spawn: ' + r.error.message)
  const out = String(r.stdout || '').trim()
  if (r.status !== 0 || out.startsWith('ERR:')) throw new Error('CredRead failed (status=' + r.status + ') ' + String(r.stderr || '').slice(0, 200))
  return out
}

// 用 refresh_token 换新 access_token
async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error('token refresh HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300))
  const j = await res.json()
  if (!j.access_token) throw new Error('token refresh: no access_token')
  return j
}

async function postJson(url, token, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

// 依次尝试端点，全部失败抛错
async function firstOk(urls, token, payload) {
  let lastErr = null
  for (const u of urls) {
    try { return await postJson(u, token, payload) } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('all endpoints failed')
}

function roundPct(f) { return typeof f === 'number' ? Math.round(f * 100) : null }

// 模型家族识别：Claude / GPT 属于 3p 池子（Antigravity 上基本不可用，DSH 不应
// 主动选择），Gemini 是主力可用池子，其余（tab_*、chat_* 等）归 other。
function modelFamily(name) {
  const n = String(name || '').toLowerCase()
  if (n.includes('claude')) return 'claude'
  if (n.includes('gpt')) return 'gpt'
  if (n.includes('gemini')) return 'gemini'
  return 'other'
}

async function main() {
  const summaryOnly = process.argv.includes('--summary')
  try {
    // 1. 读凭据
    const blobText = readWindowsCredential(CRED_TARGET)
    let tok
    try { tok = JSON.parse(blobText).token } catch (e) { throw new Error('credential blob is not JSON: ' + blobText.slice(0, 120)) }
    const refreshToken = tok && tok.refresh_token
    if (!refreshToken) throw new Error('no refresh_token in credential')
    // 2. 刷新 access_token
    const fresh = await refreshAccessToken(refreshToken)
    const accessToken = fresh.access_token
    // 3. fetchAvailableModels（每模型池子%）
    const quotaResp = await firstOk(CLOUDCODE_ENDPOINTS, accessToken, {})
    const models = []
    if (quotaResp && quotaResp.models && typeof quotaResp.models === 'object') {
      for (const [name, info] of Object.entries(quotaResp.models)) {
        const q = info && info.quotaInfo
        if (q) {
          const family = modelFamily(name)
          models.push({ name, percentage: roundPct(q.remainingFraction), resetTime: q.resetTime || '', displayName: (info && info.displayName) || '', family, recommended: family === 'gemini' || family === 'other' })
        }
      }
      models.sort((a, b) => (b.percentage || 0) - (a.percentage || 0))
    }
    // 4. retrieveUserQuotaSummary（分组套餐余量）
    let groups = []
    try {
      const sum = await firstOk(SUMMARY_ENDPOINTS, accessToken, {})
      if (sum && Array.isArray(sum.groups)) {
        groups = sum.groups.map((g) => ({
          displayName: g.displayName || '',
          buckets: (g.buckets || []).map((b) => ({ bucketId: b.bucketId || '', window: b.window || '', remainingFraction: typeof b.remainingFraction === 'number' ? b.remainingFraction : null, resetTime: b.resetTime || '' })),
        }))
      }
    } catch (e) { /* summary 失败不阻塞主结果 */ }
    const out = { ok: true, models, groups, tier: (tok.auth_method || 'consumer'), tokenSource: 'windows-credential:gemini:antigravity' }
    if (summaryOnly) {
      // 一行紧凑摘要
      const weekBuckets = groups.flatMap((g) => g.buckets.filter((b) => b.window === 'weekly').map((b) => ({ g: g.displayName, id: b.bucketId, pct: roundPct(b.remainingFraction), reset: b.resetTime })))
      // topModels 只列推荐模型（Gemini/other），Claude/GPT 3p 不推荐故不列出。
      const recommended = models.filter((m) => m.recommended)
      const pool = recommended.length ? recommended : models
      const modelSummary = pool.slice(0, 4).map((m) => m.name.split('-').slice(0, 2).join('-') + ' ' + m.percentage + '%').join(', ')
      console.log(JSON.stringify({ ok: true, weekly: weekBuckets, topModels: modelSummary }))
    } else {
      console.log(JSON.stringify(out))
    }
    process.exit(0)
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }))
    process.exit(1)
  }
}

main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) })); process.exit(1) })
