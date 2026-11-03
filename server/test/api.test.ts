import { createScheduledController, env, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reserveMicro } from '../src/pricing'
import worker from '../src/index'
import { MAX_CONTEXT_BYTES, MAX_MESSAGE_CHARS } from '../src/logs'
import { LOG_RATE_LIMIT_PER_MINUTE, RATE_LIMIT_PER_MINUTE } from '../src/quota/user-quota'
import { call, installFetchMock, readEvents, translate, uniqueSub } from './helpers'

// 2026-11-02 周一 10:00 北京时间（高峰）；2026-11-07 周六 10:00（空闲）。
const PEAK = new Date('2026-11-02T02:00:00Z')
const OFF_PEAK = new Date('2026-11-07T02:00:00Z')

let fx: ReturnType<typeof installFetchMock>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(PEAK)
  fx = installFetchMock()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function userStub(sub: string) {
  return env.USER_QUOTA.get(env.USER_QUOTA.idFromName(sub))
}

function globalStub() {
  return env.GLOBAL_QUOTA.get(env.GLOBAL_QUOTA.idFromName('global'))
}

async function pendingReservations(stub: DurableObjectStub): Promise<number> {
  return runInDurableObject(stub, async (_instance, state: DurableObjectState) =>
    state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM reservations').one().n
  )
}

async function setLimit(sub: string, limitMicro: number | null, disabled = 0) {
  await env.DB.prepare('INSERT OR REPLACE INTO user_settings (sub, limit_micro, disabled, updated_at) VALUES (?, ?, ?, ?)')
    .bind(sub, limitMicro, disabled, Math.floor(Date.now() / 1000))
    .run()
}

async function quota(token: string) {
  const res = await call('/v1/quota', token)
  expect(res.status).toBe(200)
  return (await res.json()) as { limit_micro: number; used_micro: number; remaining_ratio: number; resets_at: string }
}

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('condition not met')
}

describe('鉴权', () => {
  it('缺少 token 返回 401', async () => {
    const res = await call('/v1/quota', null)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } })
  })

  it('app_id 不是 logos 的 token 被拒绝', async () => {
    const token = fx.user({ sub: uniqueSub('other'), app_id: 'rakkopresenter' })
    const res = await translate(token)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } })
    expect(fx.deepseekCalls).toHaveLength(0)
  })

  it('/auth/me 结果缓存 60 秒', async () => {
    const token = fx.user({ sub: uniqueSub('cache') })
    await quota(token)
    await quota(token)
    const meCalls = () => fx.mock.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).endsWith('/auth/me'))
    expect(meCalls()).toHaveLength(1)
    vi.setSystemTime(PEAK.getTime() + 61_000)
    await quota(token)
    expect(meCalls()).toHaveLength(2)
  })

  it('有 PHAINON service binding 时优先走 binding', async () => {
    const sub = uniqueSub('binding')
    const token = fx.user({ sub })
    const seen: string[] = []
    const holder = env as { PHAINON?: Fetcher }
    holder.PHAINON = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init)
        seen.push(req.url)
        return fx.mock(req)
      }
    } as Fetcher
    try {
      expect((await call('/v1/quota', token)).status).toBe(200)
    } finally {
      delete holder.PHAINON
    }
    expect(seen).toEqual(['https://phainon.test/auth/me'])
  })

  it('非管理员访问管理接口返回 403', async () => {
    const token = fx.user({ sub: uniqueSub('plain') })
    for (const [method, path] of [
      ['GET', '/admin/api/users'],
      ['PATCH', '/admin/api/users/someone'],
      ['GET', '/admin/api/usage']
    ]) {
      const res = await call(path, token, { method, body: method === 'PATCH' ? '{}' : undefined })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: { code: 'forbidden' } })
    }
  })
})

describe('CORS', () => {
  it('允许列表内的来源通过预检，其他来源不返回 CORS 头', async () => {
    const ok = await call('/v1/translate', null, {
      method: 'OPTIONS',
      headers: { Origin: 'tauri://localhost', 'Access-Control-Request-Method': 'POST' }
    })
    expect(ok.status).toBe(204)
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('tauri://localhost')
    expect(ok.headers.get('Access-Control-Allow-Headers')).toMatch(/Authorization/)

    const denied = await call('/v1/translate', null, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
    })
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull()

    const unauthorized = await call('/v1/quota', null, { headers: { Origin: 'tauri://localhost' } })
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('Access-Control-Allow-Origin')).toBe('tauri://localhost')

    const token = fx.user({ sub: uniqueSub('cors') })
    const stream = await call('/v1/translate', token, {
      method: 'POST',
      headers: { Origin: 'http://localhost:1420' },
      body: JSON.stringify({ text: 'hi', from: 'auto', to: 'en' })
    })
    expect(stream.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:1420')
    await stream.text()

    const admin = await call('/admin/api/users', null, { headers: { Origin: 'tauri://localhost' } })
    expect(admin.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('翻译', () => {
  it('流式返回译文并按 usage 结算，请求体符合规格', async () => {
    const token = fx.user({ sub: uniqueSub('ok') })
    const res = await translate(token, 'hello world', 'en', 'ja')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/text\/event-stream/)
    const events = await readEvents(res)
    expect(events.slice(0, 2)).toEqual([{ delta: '你好' }, { delta: '，世界' }])
    expect(events[2]).toMatchObject({ done: true, cost_micro: 2640 })

    const body = fx.deepseekCalls[0] as Record<string, any>
    expect(body).toMatchObject({
      model: 'deepseek-flash',
      thinking: { type: 'disabled' },
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 4096
    })
    expect(body.messages[0].content).toContain('从英语翻译为日语')
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello world' })
  })

  it('超过 5000 字符返回 400', async () => {
    const token = fx.user({ sub: uniqueSub('long') })
    const res = await translate(token, 'あ'.repeat(5001))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'text_too_long' } })
    expect((await translate(token, 'あ'.repeat(5000))).status).toBe(200)
  })

  it('未知语言 key 返回 400', async () => {
    const token = fx.user({ sub: uniqueSub('lang') })
    const res = await translate(token, 'hi', 'auto', 'klingon')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_request' } })
  })
})

describe('计价与结算', () => {
  it('高峰与空闲按不同单价结算（含缓存命中）', async () => {
    const usage = { prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 500, completion_tokens: 200 }
    fx.setDeepseek({ kind: 'ok', usage })

    const peakToken = fx.user({ sub: uniqueSub('peak') })
    const peak = await readEvents(await translate(peakToken))
    // (1000×0.04 + 500×2 + 200×8) / 1e6 元 = 2640 微元
    expect(peak.at(-1)).toMatchObject({ done: true, cost_micro: 2640 })
    expect((await quota(peakToken)).used_micro).toBe(2640)

    vi.setSystemTime(OFF_PEAK)
    const offToken = fx.user({ sub: uniqueSub('offpeak') })
    const off = await readEvents(await translate(offToken))
    expect(off.at(-1)).toMatchObject({ done: true, cost_micro: 1320 })
    expect((await quota(offToken)).used_micro).toBe(1320)
  })

  it('小数部分向上取整', async () => {
    fx.setDeepseek({ kind: 'ok', usage: { prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 0, completion_tokens: 0 } })
    const token = fx.user({ sub: uniqueSub('ceil') })
    const events = await readEvents(await translate(token))
    expect(events.at(-1)).toMatchObject({ cost_micro: 1 })
  })

  it('额度不足返回 402', async () => {
    const sub = uniqueSub('poor')
    await setLimit(sub, reserveMicro(11) - 1)
    const token = fx.user({ sub })
    const res = await translate(token, 'hello world')
    expect(res.status).toBe(402)
    expect(await res.json()).toMatchObject({ error: { code: 'quota_exhausted' } })
    expect(fx.deepseekCalls).toHaveLength(0)
  })

  it('并发两个请求不会超额预扣', async () => {
    const sub = uniqueSub('race')
    await setLimit(sub, Math.floor(reserveMicro(11) * 1.5))
    const token = fx.user({ sub })
    let release!: () => void
    fx.setDeepseek({ kind: 'ok', gate: new Promise<void>((r) => (release = r)) })

    const [a, b] = await Promise.all([translate(token), translate(token)])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 402])
    expect(fx.deepseekCalls).toHaveLength(1)

    release()
    const winner = a.status === 200 ? a : b
    expect((await readEvents(winner)).at(-1)).toMatchObject({ done: true })
    expect(await pendingReservations(userStub(sub))).toBe(0)
  })

  it('上游返回错误（重试后仍失败）时全额退回', { timeout: 15_000 }, async () => {
    const sub = uniqueSub('fail')
    await setLimit(sub, reserveMicro(11))
    const token = fx.user({ sub })

    fx.setDeepseek({ kind: 'status', status: 500 })
    const res = await translate(token)
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: { code: 'upstream_error' } })
    expect(fx.deepseekCalls).toHaveLength(3)

    fx.setDeepseek({ kind: 'throw' })
    expect((await translate(token)).status).toBe(502)

    expect((await quota(token)).used_micro).toBe(0)
    expect(await pendingReservations(userStub(sub))).toBe(0)
    // 额度只够一次预扣：退回干净才能再次通过
    fx.setDeepseek({ kind: 'ok' })
    expect((await translate(token)).status).toBe(200)
  })

  it('上游 503 两次后成功：重试后正常返回并结算', { timeout: 10_000 }, async () => {
    const sub = uniqueSub('retry')
    const token = fx.user({ sub })
    const busy = { kind: 'status', status: 503, body: { error: { message: 'Service is too busy', type: 'service_unavailable_error', code: 'server_busy' } } } as const
    fx.queueDeepseek(busy, busy)
    const res = await translate(token)
    expect(res.status).toBe(200)
    const events = await readEvents(res)
    expect(events.at(-1)).toMatchObject({ done: true, cost_micro: 2640 })
    expect(fx.deepseekCalls).toHaveLength(3)
    expect((await quota(token)).used_micro).toBe(2640)
  })

  it('上游连续 503 返回 upstream_busy，退回预扣并记录失败原因', { timeout: 10_000 }, async () => {
    const sub = uniqueSub('busy')
    await setLimit(sub, reserveMicro(11))
    const token = fx.user({ sub })
    fx.setDeepseek({ kind: 'status', status: 503 })
    const res = await translate(token)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: { code: 'upstream_busy', message: '翻译服务当前繁忙，请稍后重试。' } })
    expect(fx.deepseekCalls).toHaveLength(3)
    expect((await quota(token)).used_micro).toBe(0)
    expect(await pendingReservations(userStub(sub))).toBe(0)
    const row = await env.DB.prepare('SELECT ok, error FROM usage_log WHERE sub = ?').bind(sub).first()
    expect(row).toEqual({ ok: 0, error: 'upstream_503' })
  })

  it('上游 400 不重试', async () => {
    const token = fx.user({ sub: uniqueSub('nonretry') })
    fx.setDeepseek({ kind: 'status', status: 400 })
    const res = await translate(token)
    expect(res.status).toBe(502)
    expect(fx.deepseekCalls).toHaveLength(1)
  })

  it('上游已输出后中途断流：发送错误事件并按预扣额结算', async () => {
    const sub = uniqueSub('break')
    const token = fx.user({ sub })
    fx.setDeepseek({ kind: 'break' })
    const res = await translate(token)
    expect(res.status).toBe(200)
    const events = await readEvents(res)
    expect(events[0]).toEqual({ delta: '半截' })
    expect(events.at(-1)).toMatchObject({ error: { code: 'upstream_error' } })
    expect((await quota(token)).used_micro).toBe(reserveMicro(11))
    expect(await pendingReservations(userStub(sub))).toBe(0)
  })

  it('上游未输出任何内容就断流时全额退回', async () => {
    const sub = uniqueSub('break0')
    const token = fx.user({ sub })
    fx.setDeepseek({ kind: 'break', beforeDelta: true })
    const res = await translate(token)
    const events = await readEvents(res)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ error: { code: 'upstream_error' } })
    expect((await quota(token)).used_micro).toBe(0)
    expect(await pendingReservations(userStub(sub))).toBe(0)
    await waitFor(async () => {
      const row = await env.DB.prepare('SELECT error FROM usage_log WHERE sub = ?').bind(sub).first<{ error: string }>()
      return row?.error === 'stream_interrupted'
    })
  })

  it('全局结算失败时不退回，预扣保留给 alarm 按预扣额结算', async () => {
    const sub = uniqueSub('settlefail')
    const token = fx.user({ sub })
    const global = globalStub()
    const before = await pendingReservations(global)
    const renameReservations = (from: string, to: string) =>
      runInDurableObject(global, async (_instance, state: DurableObjectState) => {
        state.storage.sql.exec(`ALTER TABLE ${from} RENAME TO ${to}`)
      })
    let release!: () => void
    fx.setDeepseek({ kind: 'ok', gate: new Promise<void>((r) => (release = r)) })
    const res = await translate(token)
    const reader = res.body!.getReader()
    await reader.read()
    // 预扣已写入后让全局账本的结算抛错（表不存在）。
    await renameReservations('reservations', 'reservations_hidden')
    try {
      release()
      let text = ''
      const decoder = new TextDecoder()
      for (let r = await reader.read(); !r.done; r = await reader.read()) text += decoder.decode(r.value)
      expect(text).toContain('upstream_error')
    } finally {
      await renameReservations('reservations_hidden', 'reservations')
    }
    // 用户侧照常按 usage 结算；全局侧预扣仍在，没有被退回。
    expect((await quota(token)).used_micro).toBe(2640)
    expect(await pendingReservations(global)).toBe(before + 1)
  })

  it('客户端中途断开后仍读完上游并结算', async () => {
    const sub = uniqueSub('gone')
    const token = fx.user({ sub })
    let release!: () => void
    fx.setDeepseek({ kind: 'ok', gate: new Promise<void>((r) => (release = r)) })

    const res = await translate(token)
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    release()

    await waitFor(async () => (await pendingReservations(userStub(sub))) === 0)
    expect((await quota(token)).used_micro).toBe(2640)
  })

  it('长时间未结算的预扣由 alarm 按预扣额结算', async () => {
    const sub = uniqueSub('stale')
    const stub = userStub(sub)
    const amount = reserveMicro(10)
    expect(await stub.reserve(sub, 'stale-1', amount, Date.now())).toEqual({ ok: true })
    vi.setSystemTime(PEAK.getTime() + 16 * 60_000)
    await runInDurableObject(stub, (instance) => instance.alarm())
    expect(await pendingReservations(stub)).toBe(0)
    expect((await stub.snapshot(sub, Date.now())).used_micro).toBe(amount)
  })
})

describe('月份与保险丝', () => {
  it('北京时间月初清零', async () => {
    vi.setSystemTime(new Date('2026-11-30T15:59:00Z')) // 北京时间 11-30 23:59
    const token = fx.user({ sub: uniqueSub('month') })
    await readEvents(await translate(token))
    const before = await quota(token)
    expect(before.used_micro).toBeGreaterThan(0)
    expect(before.resets_at).toBe('2026-11-30T16:00:00.000Z')

    vi.setSystemTime(new Date('2026-11-30T16:00:01Z')) // 北京时间 12-01 00:00:01
    const after = await quota(token)
    expect(after.used_micro).toBe(0)
    expect(after.remaining_ratio).toBe(1)
    expect(after.resets_at).toBe('2026-12-31T16:00:00.000Z')
  })

  it('全站保险丝到顶后所有人返回 503，且退回用户预扣', async () => {
    const month = '2026-11'
    const limit = 200 * 1_000_000
    await runInDurableObject(globalStub(), (_i, state: DurableObjectState) => {
      state.storage.sql.exec(
        'INSERT INTO months (month, used_micro) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET used_micro = excluded.used_micro',
        month,
        limit - 1000
      )
    })
    try {
      const sub = uniqueSub('fuse')
      const token = fx.user({ sub })
      const res = await translate(token)
      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ error: { code: 'global_quota_exhausted' } })
      expect(await pendingReservations(userStub(sub))).toBe(0)
      expect(fx.deepseekCalls).toHaveLength(0)
    } finally {
      await runInDurableObject(globalStub(), (_i, state: DurableObjectState) => {
        state.storage.sql.exec('DELETE FROM months WHERE month = ?', month)
      })
    }
  })
})

describe('限频', () => {
  it(`每分钟超过 ${RATE_LIMIT_PER_MINUTE} 次返回 429，窗口滑过后恢复`, async () => {
    const token = fx.user({ sub: uniqueSub('rate') })
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      const res = await translate(token, 'hi')
      expect(res.status).toBe(200)
      await res.text()
    }
    const limited = await translate(token, 'hi')
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } })

    vi.setSystemTime(PEAK.getTime() + 61_000)
    const res = await translate(token, 'hi')
    expect(res.status).toBe(200)
    await res.text()
  })
})

describe('管理接口', () => {
  it('PATCH 覆盖额度立即生效，null 恢复默认，停用返回 user_disabled', async () => {
    const sub = uniqueSub('managed')
    const token = fx.user({ sub, name: '测试用户' })
    const adminToken = fx.user({ sub: uniqueSub('admin'), role: 'admin' })
    expect((await quota(token)).limit_micro).toBe(10_000_000)

    const patch = (body: unknown) =>
      call(`/admin/api/users/${encodeURIComponent(sub)}`, adminToken, { method: 'PATCH', body: JSON.stringify(body) })

    const res = await patch({ limit_micro: 0, display_name: '张三' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ sub, limit_micro: 0, limit_is_default: false, display_name: '张三', disabled: false })
    expect((await quota(token)).limit_micro).toBe(0)
    expect((await translate(token)).status).toBe(402)

    await patch({ limit_micro: null })
    expect((await quota(token)).limit_micro).toBe(10_000_000)
    const ok = await translate(token)
    expect(ok.status).toBe(200)
    await ok.text()

    await patch({ disabled: true })
    const disabled = await translate(token)
    expect(disabled.status).toBe(403)
    expect(await disabled.json()).toMatchObject({ error: { code: 'user_disabled' } })

    expect((await patch({ limit_micro: -1 })).status).toBe(400)
    expect((await patch({ disabled: 'yes' })).status).toBe(400)
  })

  it('用户列表与明细', async () => {
    const sub = uniqueSub('listed')
    const token = fx.user({ sub, name: 'Alice' })
    await readEvents(await translate(token))
    const adminToken = fx.user({ sub: uniqueSub('admin'), role: 'admin' })

    await waitFor(async () => {
      const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_log WHERE sub = ?').bind(sub).first<{ n: number }>()
      return (row?.n ?? 0) > 0
    })

    const res = await call('/admin/api/users', adminToken)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { users: any[]; global: { limit_micro: number; used_micro: number } }
    expect(data.global.limit_micro).toBe(200_000_000)
    expect(data.users.find((u) => u.sub === sub)).toMatchObject({
      display_name: 'Alice',
      limit_micro: 10_000_000,
      limit_is_default: true,
      used_micro: 2640,
      disabled: false,
      last_used_at: PEAK.toISOString()
    })
    expect(Object.keys(data.users.find((u) => u.sub === sub)).sort()).toEqual(
      ['disabled', 'display_name', 'last_used_at', 'limit_is_default', 'limit_micro', 'sub', 'used_micro']
    )

    const usage = await call(`/admin/api/usage?sub=${encodeURIComponent(sub)}&limit=5`, adminToken)
    const items = ((await usage.json()) as { items: any[] }).items
    expect(items).toHaveLength(1)
    expect(Object.keys(items[0]).sort()).toEqual(
      ['cache_hit_tokens', 'cache_miss_tokens', 'cost_micro', 'created_at', 'error', 'id', 'ok', 'output_tokens', 'sub']
    )
    expect(items[0]).toMatchObject({ sub, created_at: PEAK.toISOString(), cache_hit_tokens: 1000, cache_miss_tokens: 500, output_tokens: 200, cost_micro: 2640, ok: true, error: null })
  })
})

function uploadLogs(token: string | null, body: unknown) {
  return call('/v1/logs', token, { method: 'POST', body: JSON.stringify(body) })
}

function logEntry(overrides: Record<string, unknown> = {}) {
  return { level: 'error', event: 'translate_failed', message: '请求失败', client_time: '2026-11-02T02:00:00.000Z', ...overrides }
}

describe('客户端日志', () => {
  it('未登录返回 401', async () => {
    const res = await uploadLogs(null, { entries: [logEntry()] })
    expect(res.status).toBe(401)
  })

  it('校验与截断：不合格条目丢弃，message 与 context 超长截断', async () => {
    const sub = uniqueSub('logs')
    const token = fx.user({ sub })
    const big = { blob: '字'.repeat(3000) }
    const res = await uploadLogs(token, {
      app_version: '0.3.1',
      os: 'windows',
      entries: [
        logEntry({ message: 'x'.repeat(MAX_MESSAGE_CHARS + 100), context: { status: 503 } }),
        logEntry({ level: 'warn', event: 'big_context', context: big }),
        logEntry({ level: 'debug' }),
        logEntry({ event: 'e'.repeat(65) }),
        logEntry({ client_time: 'yesterday' }),
        'not an object'
      ]
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accepted: 2 })

    const { results } = await env.DB.prepare('SELECT * FROM client_logs WHERE sub = ? ORDER BY id').bind(sub).all<any>()
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ level: 'error', event: 'translate_failed', context: '{"status":503}', app_version: '0.3.1', os: 'windows', created_at: PEAK.getTime() / 1000 })
    expect(results[0].message).toHaveLength(MAX_MESSAGE_CHARS)
    expect(new TextEncoder().encode(results[1].context).length).toBeLessThanOrEqual(MAX_CONTEXT_BYTES)
    expect(JSON.parse(results[1].context)).toMatchObject({ truncated: true })

    expect((await uploadLogs(token, { entries: Array.from({ length: 21 }, () => logEntry()) })).status).toBe(400)
    expect((await uploadLogs(token, { entries: 'x' })).status).toBe(400)
    expect((await uploadLogs(token, { app_version: 1, entries: [] })).status).toBe(400)
  })

  it('停用用户也可上传', async () => {
    const sub = uniqueSub('logs-disabled')
    await setLimit(sub, null, 1)
    const token = fx.user({ sub })
    const res = await uploadLogs(token, { entries: [logEntry()] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accepted: 1 })
  })

  it(`每分钟超过 ${LOG_RATE_LIMIT_PER_MINUTE} 次返回 429，且不占翻译限频`, async () => {
    const token = fx.user({ sub: uniqueSub('logs-rate') })
    for (let i = 0; i < LOG_RATE_LIMIT_PER_MINUTE; i++) {
      expect((await uploadLogs(token, { entries: [] })).status).toBe(200)
    }
    const limited = await uploadLogs(token, { entries: [] })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } })
    const res = await translate(token, 'hi')
    expect(res.status).toBe(200)
    await res.text()

    vi.setSystemTime(PEAK.getTime() + 61_000)
    expect((await uploadLogs(token, { entries: [] })).status).toBe(200)
  })

  it('管理接口：非管理员 403，管理员按用户与级别筛选', async () => {
    const sub = uniqueSub('logs-admin')
    const token = fx.user({ sub })
    await uploadLogs(token, { app_version: '0.3.1', os: 'macos', entries: [logEntry({ context: { a: 1 } }), logEntry({ level: 'info', event: 'started' })] })

    expect((await call('/admin/api/logs', token)).status).toBe(403)

    const adminToken = fx.user({ sub: uniqueSub('admin'), role: 'admin' })
    const res = await call(`/admin/api/logs?sub=${encodeURIComponent(sub)}&level=error`, adminToken)
    expect(res.status).toBe(200)
    const items = ((await res.json()) as { items: any[] }).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      sub,
      level: 'error',
      event: 'translate_failed',
      context: { a: 1 },
      app_version: '0.3.1',
      os: 'macos',
      created_at: PEAK.toISOString(),
      client_time: '2026-11-02T02:00:00.000Z'
    })
    const all = await call(`/admin/api/logs?sub=${encodeURIComponent(sub)}`, adminToken)
    expect(((await all.json()) as { items: any[] }).items).toHaveLength(2)
    expect((await call('/admin/api/logs?level=debug', adminToken)).status).toBe(400)
  })

  it('cron 删除 30 天前的日志', async () => {
    const sub = uniqueSub('logs-purge')
    const now = Math.floor(PEAK.getTime() / 1000)
    const insert = env.DB.prepare(
      "INSERT INTO client_logs (sub, created_at, level, event, message, client_time) VALUES (?, ?, 'info', 'e', 'm', '2026-01-01T00:00:00Z')"
    )
    await env.DB.batch([insert.bind(sub, now - 31 * 86_400), insert.bind(sub, now - 29 * 86_400)])

    await worker.scheduled(createScheduledController({ scheduledTime: PEAK.getTime(), cron: '17 19 * * *' }), env)
    const { results } = await env.DB.prepare('SELECT created_at FROM client_logs WHERE sub = ?').bind(sub).all()
    expect(results).toEqual([{ created_at: now - 29 * 86_400 }])
  })
})
