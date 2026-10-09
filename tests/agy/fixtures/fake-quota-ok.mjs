// tests/agy/fixtures/fake-quota-ok.mjs — 假额度脚本：Gemini 5h 余量 50%（放行）。
process.stdout.write(JSON.stringify({
  ok: true,
  tier: 'pro',
  groups: [
    { displayName: 'Gemini', buckets: [
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, resetTime: '2026-01-01T12:00:00Z' },
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.8, resetTime: '2026-01-07T00:00:00Z' }
    ] }
  ],
  models: [
    { name: 'gemini-3-pro', displayName: 'Gemini 3 Pro', percentage: 50, recommended: true },
    { name: 'claude-opus-4', displayName: 'Claude Opus 4', percentage: 90, recommended: false }
  ]
}) + '\n')
