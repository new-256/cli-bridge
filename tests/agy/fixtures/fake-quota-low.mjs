// tests/agy/fixtures/fake-quota-low.mjs — 假额度脚本：Gemini 5h 余量 5%（应硬阻断）。
process.stdout.write(JSON.stringify({
  ok: true,
  tier: 'pro',
  groups: [
    { displayName: 'Gemini', buckets: [
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.05, resetTime: '2026-01-01T12:00:00Z' },
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: '2026-01-07T00:00:00Z' }
    ] }
  ],
  models: [{ name: 'gemini-3-pro', displayName: 'Gemini 3 Pro', percentage: 5, recommended: true }]
}) + '\n')
