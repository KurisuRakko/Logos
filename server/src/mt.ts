import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppEnv, Env, Identity } from './env'
import { md5Hex } from './md5'
import type { MtProvider } from './quota/mt-quota'
import { beijingMonth } from './time'
import { rememberDisplayName } from './translate'

export const MT_MAX_TEXT_CHARS = 5000
export const BAIDU_ENDPOINT = 'https://fanyi-api.baidu.com/api/trans/vip/translate'
export const FALLBACK_MODEL = '@cf/meta/m2m100-1.2b'
const BAIDU_TIMEOUT_MS = 15_000

// /v1/mt 的错误体是扁平的 {error: code, message}，与 /v1/translate 的 {error: {code, message}} 不同（客户端按此约定实现）。
export type MtErrorCode =
  | 'unauthorized'
  | 'bad_request'
  | 'text_too_long'
  | 'unsupported_language'
  | 'quota_exhausted'
  | 'provider_not_configured'
  | 'upstream_error'
  | 'rate_limited'
  | 'user_disabled'

const STATUS: Record<MtErrorCode, ContentfulStatusCode> = {
  unauthorized: 401,
  bad_request: 400,
  text_too_long: 413,
  unsupported_language: 400,
  quota_exhausted: 429,
  provider_not_configured: 503,
  upstream_error: 502,
  rate_limited: 429,
  user_disabled: 403
}

const MESSAGES: Record<MtErrorCode, string> = {
  unauthorized: '身份验证失败，请重新登录。',
  bad_request: '请求格式不正确。',
  text_too_long: '单次翻译的原文不得超过 5000 个字符。',
  unsupported_language: '所选翻译服务不支持该语言。',
  quota_exhausted: '机器翻译的免费额度已用尽，请稍后再试或改用其他翻译服务。',
  provider_not_configured: '该翻译服务尚未配置，暂不可用。',
  upstream_error: '上游翻译服务暂时不可用，请稍后再试。',
  rate_limited: '请求过于频繁，请稍后再试。',
  user_disabled: '当前账户的翻译服务已被停用。'
}

export function mtErrorResponse(code: MtErrorCode): Response {
  return Response.json({ error: code, message: MESSAGES[code] }, { status: STATUS[code] })
}

// Logos 语言 key → 百度语言码（与客户端 src/services/translate/baidu/info.ts 一致，只收 /v1/mt 支持的语言）。
export const BAIDU_LANGUAGES: Record<string, string> = {
  auto: 'auto',
  zh_cn: 'zh',
  zh_tw: 'cht',
  en: 'en',
  ja: 'jp',
  ko: 'kor',
  fr: 'fra',
  es: 'spa',
  ru: 'ru',
  de: 'de',
  it: 'it',
  tr: 'tr',
  pt_pt: 'pt',
  pt_br: 'pot',
  vi: 'vie',
  id: 'id',
  th: 'th',
  ms: 'may',
  ar: 'ar',
  hi: 'hi'
}

// Logos 语言 key → m2m100 语言码（ISO 639-1）。m2m100 不区分简繁、葡萄牙与巴西葡萄牙语，合并为 zh / pt。
// auto 不在表内：fallback 下由 detectSource 判定源语言。
export const M2M100_LANGUAGES: Record<string, string> = {
  zh_cn: 'zh',
  zh_tw: 'zh',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  es: 'es',
  ru: 'ru',
  de: 'de',
  it: 'it',
  tr: 'tr',
  pt_pt: 'pt',
  pt_br: 'pt',
  vi: 'vi',
  id: 'id',
  th: 'th',
  ms: 'ms',
  ar: 'ar',
  hi: 'hi'
}

// from = auto 时的源语言判定（仅 fallback）：含 CJK 统一表意文字判 zh，否则 en。
export function detectSource(text: string): 'zh' | 'en' {
  return /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2fa1f}]/u.test(text) ? 'zh' : 'en'
}

// 计费字符数：取 UTF-16 码元数（不小于码点数），比百度按字符计费的口径略保守，保证不超出免费额度。
export function billedChars(text: string): number {
  return text.length
}

export function baiduSign(appid: string, q: string, salt: string, key: string): string {
  return md5Hex(appid + q + salt + key)
}

type ProviderResult = { ok: true; text: string } | { ok: false; code: 'upstream_error' | 'quota_exhausted' | 'unsupported_language'; error: string }

// 百度错误码：54004 账户余额不足 → quota_exhausted；58001 译文语言方向不支持 → unsupported_language；
// 其余（52001 超时、52002 系统错误、52003 未授权、54000 参数缺失、54001 签名错误、54003 访问频率受限、58002 服务已关闭等）→ upstream_error。
export function mapBaiduError(code: string): 'upstream_error' | 'quota_exhausted' | 'unsupported_language' {
  if (code === '54004') return 'quota_exhausted'
  if (code === '58001') return 'unsupported_language'
  return 'upstream_error'
}

async function callBaidu(env: Env, text: string, from: string, to: string): Promise<ProviderResult> {
  const appid = env.BAIDU_APPID!
  const salt = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const form = new URLSearchParams({ q: text, from, to, appid, salt, sign: baiduSign(appid, text, salt, env.BAIDU_KEY!) })
  let res: Response
  try {
    res = await fetch(BAIDU_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(BAIDU_TIMEOUT_MS)
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    const error = name === 'TimeoutError' || name === 'AbortError' ? 'upstream_timeout' : 'upstream_network'
    console.error('baidu request failed', { error, name })
    return { ok: false, code: 'upstream_error', error }
  }
  if (!res.ok) {
    console.error('baidu request failed', { status: res.status })
    return { ok: false, code: 'upstream_error', error: `upstream_${res.status}` }
  }
  const body = (await res.json().catch(() => null)) as {
    error_code?: unknown
    trans_result?: { dst?: unknown }[]
  } | null
  // 成功响应不带 error_code（或为 52000）；只记错误码，不记 error_msg 与原文。
  const errorCode = body?.error_code === undefined ? null : String(body.error_code)
  if (errorCode !== null && errorCode !== '52000') {
    console.error('baidu request failed', { error_code: errorCode })
    return { ok: false, code: mapBaiduError(errorCode), error: `baidu_${errorCode}` }
  }
  const parts = body?.trans_result
  if (!Array.isArray(parts) || parts.some((p) => typeof p?.dst !== 'string')) {
    console.error('baidu request failed', { error: 'upstream_bad_body' })
    return { ok: false, code: 'upstream_error', error: 'upstream_bad_body' }
  }
  return { ok: true, text: parts.map((p) => p.dst as string).join('\n') }
}

async function callFallback(env: Env, text: string, source: string, target: string): Promise<ProviderResult> {
  try {
    const out = (await env.AI.run(FALLBACK_MODEL, { text, source_lang: source, target_lang: target })) as {
      translated_text?: unknown
    }
    if (typeof out?.translated_text !== 'string') {
      console.error('workers ai request failed', { error: 'upstream_bad_body' })
      return { ok: false, code: 'upstream_error', error: 'upstream_bad_body' }
    }
    return { ok: true, text: out.translated_text }
  } catch (err) {
    console.error('workers ai request failed', { name: err instanceof Error ? err.name : typeof err })
    return { ok: false, code: 'upstream_error', error: 'upstream_ai' }
  }
}

export async function handleMt(c: Context<AppEnv>): Promise<Response> {
  const env = c.env
  const identity = c.get('identity')
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  const { provider, text, from, to } = body ?? {}
  if (
    (provider !== 'baidu' && provider !== 'fallback') ||
    typeof text !== 'string' ||
    !text.trim() ||
    typeof from !== 'string' ||
    typeof to !== 'string'
  ) {
    return mtErrorResponse('bad_request')
  }
  if ([...text].length > MT_MAX_TEXT_CHARS) return mtErrorResponse('text_too_long')

  let source: string
  let target: string
  if (provider === 'baidu') {
    if (!Object.hasOwn(BAIDU_LANGUAGES, from) || to === 'auto' || !Object.hasOwn(BAIDU_LANGUAGES, to)) {
      return mtErrorResponse('unsupported_language')
    }
    source = BAIDU_LANGUAGES[from]
    target = BAIDU_LANGUAGES[to]
  } else {
    if ((from !== 'auto' && !Object.hasOwn(M2M100_LANGUAGES, from)) || !Object.hasOwn(M2M100_LANGUAGES, to)) {
      return mtErrorResponse('unsupported_language')
    }
    source = from === 'auto' ? detectSource(text) : M2M100_LANGUAGES[from]
    target = M2M100_LANGUAGES[to]
  }

  const now = Date.now()
  const user = env.USER_QUOTA.get(env.USER_QUOTA.idFromName(identity.sub))
  const admitted = await user.allowMt(identity.sub, now)
  if (!admitted.ok) return mtErrorResponse(admitted.code)

  const chars = billedChars(text)
  const log = (error: string | null) => c.executionCtx.waitUntil(logMtUsage(env, identity, provider, chars, now, error))

  if (provider === 'baidu' && (!env.BAIDU_APPID || !env.BAIDU_KEY)) {
    log('provider_not_configured')
    return mtErrorResponse('provider_not_configured')
  }

  // 先预留字符额度，超出则不发上游请求；上游失败退回预留，成功按预留额结算。
  const quota = env.MT_QUOTA.get(env.MT_QUOTA.idFromName(provider))
  const id = crypto.randomUUID()
  if (!(await quota.reserve(provider, id, chars, now))) {
    log('quota_exhausted')
    return mtErrorResponse('quota_exhausted')
  }

  let result: ProviderResult
  try {
    result = provider === 'baidu' ? await callBaidu(env, text, source, target) : await callFallback(env, text, source, target)
  } catch (err) {
    await quota.refund(id)
    throw err
  }
  if (!result.ok) {
    await quota.refund(id)
    log(result.error)
    return mtErrorResponse(result.code)
  }
  // 结算失败时预扣留给 alarm 按预留额结算，不影响本次返回。
  try {
    await quota.settle(id, chars)
  } catch (err) {
    console.error('mt settle failed', err)
  }
  log(null)
  return c.json({ text: result.text, provider })
}

// usage_log 只供展示：记 provider 与计费字符数，不记原文与译文；token 与金额列为 0。写失败不影响请求。
async function logMtUsage(env: Env, identity: Identity, provider: MtProvider, chars: number, at: number, error: string | null) {
  const db = env.DB
  const seconds = Math.floor(at / 1000)
  const statements = [
    db
      .prepare(
        'INSERT INTO usage_log (sub, month, created_at, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_micro, ok, error, provider, chars) VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?)'
      )
      .bind(identity.sub, beijingMonth(at), seconds, error === null ? 1 : 0, error, provider, chars)
  ]
  const remember = rememberDisplayName(db, identity, seconds)
  if (remember) statements.push(remember)
  await db.batch(statements).catch((err) => console.error('usage_log write failed', err))
}
