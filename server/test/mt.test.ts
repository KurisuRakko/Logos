import { env, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { md5Hex } from '../src/md5'
import { BAIDU_ENDPOINT, FALLBACK_MODEL, baiduSign, detectSource } from '../src/mt'
import { DEFAULT_BAIDU_MONTHLY_CHARS, DEFAULT_FALLBACK_DAILY_CHARS, type MtProvider } from '../src/quota/mt-quota'
import { MT_RATE_LIMIT_PER_MINUTE } from '../src/quota/user-quota'
import { call, installFetchMock, uniqueSub } from './helpers'

// 2026-11-02 周一 10:00 北京时间。
const NOW = new Date('2026-11-02T02:00:00Z')

type BaiduBehavior = { kind: 'ok'; parts?: string[] } | { kind: 'error'; code: string } | { kind: 'status'; status: number }

let fx: ReturnType<typeof installFetchMock>
let baidu: BaiduBehavior
let baiduCalls: URLSearchParams[]
let aiRun: ReturnType<typeof vi.fn>

const mutableEnv = env as unknown as Record<string, unknown>

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  fx = installFetchMock()
  baidu = { kind: 'ok' }
  baiduCalls = []
  // 在 Phainon / DeepSeek mock 外再接管百度请求。
  const inner = fx.mock
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url !== BAIDU_ENDPOINT) return inner(input, init)
      const form = new URLSearchParams(await request.text())
      baiduCalls.push(form)
      if (baidu.kind === 'status') return new Response('bad gateway', { status: baidu.status })
      if (baidu.kind === 'error') return Response.json({ error_code: baidu.code, error_msg: 'mock' })
      const parts = baidu.parts ?? form.get('q')!.split('\n').map((line) => `[${line}]`)
      return Response.json({ from: form.get('from'), to: form.get('to'), trans_result: parts.map((dst) => ({ src: '', dst })) })
    })
  )
  aiRun = vi.fn(async (_model: string, input: { text: string }) => ({ translated_text: `<${input.text}>` }))
  mutableEnv.AI = { run: aiRun }
  mutableEnv.BAIDU_APPID = 'test-appid'
  mutableEnv.BAIDU_KEY = 'test-baidu-key'
  // MtQuota 是全站单例，每个用例从空账本开始。
  for (const provider of ['baidu', 'fallback'] as const) {
    await runInDurableObject(quotaStub(provider), async (_i, state: DurableObjectState) => {
      state.storage.sql.exec('DELETE FROM months')
      state.storage.sql.exec('DELETE FROM reservations')
    })
  }
})

afterEach(() => {
  delete mutableEnv.BAIDU_APPID
  delete mutableEnv.BAIDU_KEY
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function quotaStub(provider: MtProvider) {
  return env.MT_QUOTA.get(env.MT_QUOTA.idFromName(provider))
}

async function used(provider: MtProvider) {
  return (await quotaStub(provider).usage(provider, Date.now())).used_chars
}

async function pending(provider: MtProvider) {
  return runInDurableObject(quotaStub(provider), async (_i, state: DurableObjectState) =>
    state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM reservations').one().n
  )
}

// 把账本预先用到 limit - remaining。
async function fillQuota(provider: MtProvider, limit: number, remaining: number) {
  const stub = quotaStub(provider)
  expect(await stub.reserve(provider, 'prefill', limit - remaining, Date.now())).toBe(true)
  await stub.settle('prefill', limit - remaining)
}

function mt(token: string | null, body: Record<string, unknown>) {
  return call('/v1/mt', token, { method: 'POST', body: JSON.stringify(body) })
}

describe('/v1/mt 基础', () => {
  it('MD5 与百度签名', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6')
    expect(md5Hex('你好')).toBe('7eca689f0d3389d9dea66ae112e5cfd7')
    expect(md5Hex('a'.repeat(1000))).toBe('cabe45dcc9ae5b66ba86600cca6b8ba8')
    // 百度文档示例：appid 2015063000000001 + q apple + salt 1435660288 + key 12345678
    expect(baiduSign('2015063000000001', 'apple', '1435660288', '12345678')).toBe('f89f9594663708c1605f3d736d01d2d4')
  })

  it('auto 判语：含 CJK 统一表意文字判 zh，否则 en', () => {
    expect(detectSource('今天天气不错')).toBe('zh')
    expect(detectSource('Hello 世界')).toBe('zh')
    expect(detectSource('Bonjour')).toBe('en')
    expect(detectSource('こんにちは')).toBe('en')
  })

  it('未登录返回扁平 401', async () => {
    const res = await mt(null, { provider: 'baidu', text: 'hi', from: 'en', to: 'zh_cn' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized', message: expect.any(String) })
  })

  it('请求校验：bad_request、413、unsupported_language', async () => {
    const token = fx.user({ sub: uniqueSub('mt-validate') })
    const cases: [Record<string, unknown>, number, string][] = [
      [{ provider: 'google', text: 'hi', from: 'en', to: 'zh_cn' }, 400, 'bad_request'],
      [{ provider: 'baidu', text: '  ', from: 'en', to: 'zh_cn' }, 400, 'bad_request'],
      [{ provider: 'baidu', text: 'hi', from: 'en' }, 400, 'bad_request'],
      [{ provider: 'baidu', text: 'x'.repeat(5001), from: 'en', to: 'zh_cn' }, 413, 'text_too_long'],
      [{ provider: 'baidu', text: 'hi', from: 'en', to: 'auto' }, 400, 'unsupported_language'],
      [{ provider: 'baidu', text: 'hi', from: 'mn_mo', to: 'zh_cn' }, 400, 'unsupported_language'],
      [{ provider: 'fallback', text: 'hi', from: 'en', to: 'km' }, 400, 'unsupported_language']
    ]
    for (const [body, status, code] of cases) {
      const res = await mt(token, body)
      expect(res.status, code).toBe(status)
      expect(await res.json()).toMatchObject({ error: code })
    }
    expect(baiduCalls).toHaveLength(0)
    expect(aiRun).not.toHaveBeenCalled()
  })

  it(`每用户每分钟超过 ${MT_RATE_LIMIT_PER_MINUTE} 次返回 429 rate_limited`, async () => {
    const token = fx.user({ sub: uniqueSub('mt-rate') })
    for (let i = 0; i < MT_RATE_LIMIT_PER_MINUTE; i++) {
      const res = await mt(token, { provider: 'fallback', text: 'hi', from: 'en', to: 'de' })
      expect(res.status).toBe(200)
    }
    const limited = await mt(token, { provider: 'fallback', text: 'hi', from: 'en', to: 'de' })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' })
  })
})

describe('/v1/mt provider=baidu', () => {
  it('签名、语言映射、多段以换行拼回，并按字符结算', async () => {
    const sub = uniqueSub('mt-baidu')
    const token = fx.user({ sub })
    const text = '第一行\n第二行'
    const res = await mt(token, { provider: 'baidu', text, from: 'zh_tw', to: 'ja' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: '[第一行]\n[第二行]', provider: 'baidu' })

    const form = baiduCalls[0]
    expect(form.get('from')).toBe('cht')
    expect(form.get('to')).toBe('jp')
    expect(form.get('appid')).toBe('test-appid')
    expect(form.get('sign')).toBe(md5Hex(`test-appid${text}${form.get('salt')}test-baidu-key`))
    expect(await used('baidu')).toBe(text.length)
    expect(await pending('baidu')).toBe(0)

    // usage_log 在 waitUntil 里写入，稍等片刻。
    let row = null
    for (let i = 0; i < 50 && !row; i++) {
      row = await env.DB.prepare('SELECT provider, chars, ok, error, cost_micro FROM usage_log WHERE sub = ?').bind(sub).first()
      if (!row) await new Promise((r) => setTimeout(r, 20))
    }
    expect(row).toEqual({ provider: 'baidu', chars: text.length, ok: 1, error: null, cost_micro: 0 })
  })

  it('from auto 原样传给百度', async () => {
    const token = fx.user({ sub: uniqueSub('mt-baidu-auto') })
    const res = await mt(token, { provider: 'baidu', text: 'hello', from: 'auto', to: 'pt_br' })
    expect(res.status).toBe(200)
    expect(baiduCalls[0].get('from')).toBe('auto')
    expect(baiduCalls[0].get('to')).toBe('pot')
  })

  it('密钥未配置返回 503 provider_not_configured，不占额度', async () => {
    delete mutableEnv.BAIDU_KEY
    const token = fx.user({ sub: uniqueSub('mt-baidu-unset') })
    const res = await mt(token, { provider: 'baidu', text: 'hello', from: 'en', to: 'zh_cn' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'provider_not_configured' })
    expect(baiduCalls).toHaveLength(0)
    expect(await used('baidu')).toBe(0)
    expect(await pending('baidu')).toBe(0)
  })

  it('月度字符额度不足时直接 429 quota_exhausted，不发请求', async () => {
    await fillQuota('baidu', DEFAULT_BAIDU_MONTHLY_CHARS, 4)
    const token = fx.user({ sub: uniqueSub('mt-baidu-quota') })
    const res = await mt(token, { provider: 'baidu', text: 'hello', from: 'en', to: 'zh_cn' })
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'quota_exhausted' })
    expect(baiduCalls).toHaveLength(0)

    // 恰好用满仍放行。
    const ok = await mt(token, { provider: 'baidu', text: 'four', from: 'en', to: 'zh_cn' })
    expect(ok.status).toBe(200)
    expect(await used('baidu')).toBe(DEFAULT_BAIDU_MONTHLY_CHARS)
  })

  it('北京时间换月后额度重置', async () => {
    await fillQuota('baidu', DEFAULT_BAIDU_MONTHLY_CHARS, 0)
    vi.setSystemTime(new Date('2026-11-30T16:00:00Z')) // 北京时间 12-01 0:00
    const token = fx.user({ sub: uniqueSub('mt-baidu-month') })
    const res = await mt(token, { provider: 'baidu', text: 'hello', from: 'en', to: 'zh_cn' })
    expect(res.status).toBe(200)
  })

  it('百度错误码映射并退回预留', async () => {
    const token = fx.user({ sub: uniqueSub('mt-baidu-error') })
    const cases: [BaiduBehavior, number, string][] = [
      [{ kind: 'error', code: '54004' }, 429, 'quota_exhausted'],
      [{ kind: 'error', code: '58002' }, 502, 'upstream_error'],
      [{ kind: 'error', code: '54001' }, 502, 'upstream_error'],
      [{ kind: 'status', status: 500 }, 502, 'upstream_error']
    ]
    for (const [behavior, status, code] of cases) {
      baidu = behavior
      const res = await mt(token, { provider: 'baidu', text: 'hello', from: 'en', to: 'zh_cn' })
      expect(res.status).toBe(status)
      expect(await res.json()).toMatchObject({ error: code })
    }
    expect(await used('baidu')).toBe(0)
    expect(await pending('baidu')).toBe(0)
  })
})

describe('/v1/mt provider=fallback', () => {
  it('调用 m2m100，auto 按 CJK 判源语言，简繁与葡语变体合并', async () => {
    const token = fx.user({ sub: uniqueSub('mt-fallback') })
    const zh = await mt(token, { provider: 'fallback', text: '你好世界', from: 'auto', to: 'pt_br' })
    expect(zh.status).toBe(200)
    expect(await zh.json()).toEqual({ text: '<你好世界>', provider: 'fallback' })
    expect(aiRun).toHaveBeenLastCalledWith(FALLBACK_MODEL, { text: '你好世界', source_lang: 'zh', target_lang: 'pt' })

    await mt(token, { provider: 'fallback', text: 'Hello', from: 'auto', to: 'zh_tw' })
    expect(aiRun).toHaveBeenLastCalledWith(FALLBACK_MODEL, { text: 'Hello', source_lang: 'en', target_lang: 'zh' })

    await mt(token, { provider: 'fallback', text: 'Hallo', from: 'de', to: 'ja' })
    expect(aiRun).toHaveBeenLastCalledWith(FALLBACK_MODEL, { text: 'Hallo', source_lang: 'de', target_lang: 'ja' })
    expect(await used('fallback')).toBe(4 + 5 + 5)
  })

  it('日字符额度不足返回 429，UTC 换日后恢复', async () => {
    await fillQuota('fallback', DEFAULT_FALLBACK_DAILY_CHARS, 2)
    const token = fx.user({ sub: uniqueSub('mt-fallback-quota') })
    const res = await mt(token, { provider: 'fallback', text: 'hello', from: 'en', to: 'de' })
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'quota_exhausted' })
    expect(aiRun).not.toHaveBeenCalled()

    vi.setSystemTime(new Date('2026-11-03T00:00:00Z'))
    const next = await mt(token, { provider: 'fallback', text: 'hello', from: 'en', to: 'de' })
    expect(next.status).toBe(200)
  })

  it('Workers AI 失败返回 502 并退回预留', async () => {
    aiRun.mockRejectedValueOnce(new Error('AiError: capacity'))
    aiRun.mockResolvedValueOnce({})
    const token = fx.user({ sub: uniqueSub('mt-fallback-error') })
    for (let i = 0; i < 2; i++) {
      const res = await mt(token, { provider: 'fallback', text: 'hello', from: 'en', to: 'de' })
      expect(res.status).toBe(502)
      expect(await res.json()).toMatchObject({ error: 'upstream_error' })
    }
    expect(await used('fallback')).toBe(0)
    expect(await pending('fallback')).toBe(0)
  })
})
