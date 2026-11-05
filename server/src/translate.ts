import type { Context } from 'hono'
import { displayNameOf } from './auth'
import { deepseekRequest, fetchDeepseekWithRetry, readDeepseekStream } from './deepseek'
import type { AppEnv, Env, Identity } from './env'
import { MESSAGES, errorBody, errorResponse } from './errors'
import { isKnownLanguage, systemPrompt } from './languages'
import { costMicro, reserveMicro, type Usage } from './pricing'
import { GLOBAL_QUOTA_NAME } from './quota/global-quota'
import { beijingMonth } from './time'

export const MAX_TEXT_CHARS = 5000

interface Billing {
  env: Env
  identity: Identity
  id: string
  amount: number
  startedAt: number
}

export async function handleTranslate(c: Context<AppEnv>): Promise<Response> {
  const env = c.env
  const identity = c.get('identity')
  const body = (await c.req.json().catch(() => null)) as { text?: unknown; from?: unknown; to?: unknown } | null
  const { text, from, to } = body ?? {}
  if (
    typeof text !== 'string' ||
    !text.trim() ||
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    (from !== 'auto' && !isKnownLanguage(from)) ||
    !isKnownLanguage(to)
  ) {
    return errorResponse('invalid_request')
  }
  const chars = [...text].length
  if (chars > MAX_TEXT_CHARS) return errorResponse('text_too_long')

  const startedAt = Date.now()
  const id = crypto.randomUUID()
  const amount = reserveMicro(chars)
  const user = env.USER_QUOTA.get(env.USER_QUOTA.idFromName(identity.sub))
  const reserved = await user.reserve(identity.sub, id, amount, startedAt)
  if (!reserved.ok) return errorResponse(reserved.code)

  const global = env.GLOBAL_QUOTA.get(env.GLOBAL_QUOTA.idFromName(GLOBAL_QUOTA_NAME))
  let globalOk = false
  try {
    globalOk = await global.reserve(id, amount, startedAt)
  } finally {
    if (!globalOk) await user.refund(id)
  }
  if (!globalOk) return errorResponse('global_quota_exhausted')

  const billing: Billing = { env, identity, id, amount, startedAt }
  const upstream = await fetchDeepseekWithRetry(() => deepseekRequest(env.DEEPSEEK_API_KEY, systemPrompt(from, to), text))
  if (!upstream.ok) {
    await refundAll(billing, upstream.error)
    return errorResponse(upstream.code)
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  // 流转发与结算放进 waitUntil：客户端中途断开后仍读完上游拿到 usage 再结算，不泄漏预扣。
  c.executionCtx.waitUntil(pump(upstream.response.body, writable, billing))
  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' }
  })
}

async function pump(upstream: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, billing: Billing) {
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  let clientGone = false
  const send = async (payload: unknown) => {
    if (clientGone) return
    try {
      await writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
    } catch {
      clientGone = true
    }
  }

  let usage: Usage | null = null
  let sentDelta = false
  // committed 之后不再退回：结算请求已发出，任一方失败都交给 alarm 按预扣额结算。
  let committed = false
  try {
    try {
      for await (const event of readDeepseekStream(upstream)) {
        if (event.type === 'delta') {
          sentDelta = true
          await send({ delta: event.text })
        } else usage = event.usage
      }
    } catch {
      usage = null
    }

    if (!usage) {
      committed = true
      if (sentDelta) {
        // 上游已产出内容后中断：拿不到 usage，保守按预扣额结算。
        await settleAll(billing, null, billing.amount, 'stream_interrupted').catch((err) =>
          console.error('settle failed', err)
        )
      } else {
        // 一个 delta 都没产出就中断：视为未产生费用，全额退回。
        await refundAll(billing, 'stream_interrupted')
      }
      await send(errorBody('upstream_error', MESSAGES.upstream_error))
      return
    }
    const cost = costMicro(usage, billing.startedAt)
    committed = true
    let snapshot
    try {
      snapshot = await settleAll(billing, usage, cost)
    } catch (err) {
      console.error('settle failed', err)
      await send(errorBody('upstream_error', MESSAGES.upstream_error))
      return
    }
    await send({ done: true, cost_micro: cost, remaining_ratio: snapshot.remaining_ratio })
  } finally {
    if (!committed) await refundAll(billing, 'internal_error').catch(() => {})
    if (!clientGone) await writer.close().catch(() => {})
  }
}

function stubs(env: Env, sub: string) {
  return {
    user: env.USER_QUOTA.get(env.USER_QUOTA.idFromName(sub)),
    global: env.GLOBAL_QUOTA.get(env.GLOBAL_QUOTA.idFromName(GLOBAL_QUOTA_NAME))
  }
}

// error 为失败原因，写入 usage_log.error 供管理页展示。
async function refundAll(b: Billing, error: string) {
  const { user, global } = stubs(b.env, b.identity.sub)
  await Promise.all([user.refund(b.id), global.refund(b.id)])
  await logUsage(b, { cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0 }, 0, error)
}

// 两方并行结算；任一方失败都抛错且不退回，失败一方的预扣留给 alarm 按预扣额结算。
// usage 为 null 表示按预扣额结算（无 usage 可记），此时 error 记失败原因。
async function settleAll(b: Billing, usage: Usage | null, cost: number, error: string | null = null) {
  const { user, global } = stubs(b.env, b.identity.sub)
  const [userResult, globalResult] = await Promise.allSettled([
    user.settle(b.identity.sub, b.id, cost, Date.now()),
    global.settle(b.id, cost)
  ])
  const empty = { cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0 }
  await logUsage(b, usage ?? empty, cost, usage === null ? (error ?? 'unknown') : null)
  if (userResult.status === 'rejected') throw userResult.reason
  if (globalResult.status === 'rejected') throw globalResult.reason
  return userResult.value
}

// usage_log 只供展示，写失败不影响结算。error 为 null 表示成功（ok = 1）。
async function logUsage(b: Billing, usage: Usage, cost: number, error: string | null) {
  const db = b.env.DB
  const at = Math.floor(b.startedAt / 1000)
  const statements = [
    db
      .prepare(
        'INSERT INTO usage_log (sub, month, created_at, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_micro, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        b.identity.sub,
        beijingMonth(b.startedAt),
        at,
        usage.cacheHitTokens,
        usage.cacheMissTokens,
        usage.outputTokens,
        cost,
        error === null ? 1 : 0,
        error
      )
  ]
  const remember = rememberDisplayName(db, b.identity, at)
  if (remember) statements.push(remember)
  await db.batch(statements).catch((err) => console.error('usage_log write failed', err))
}

// 记下 Phainon 的显示名供管理页展示；管理员手动设置过的不覆盖。没有可用显示名时返回 null。
export function rememberDisplayName(db: D1Database, identity: Identity, at: number): D1PreparedStatement | null {
  const name = displayNameOf(identity)
  if (!name) return null
  return db
    .prepare(
      'INSERT INTO user_settings (sub, display_name, limit_micro, disabled, updated_at) VALUES (?, ?, NULL, 0, ?) ON CONFLICT(sub) DO UPDATE SET display_name = COALESCE(user_settings.display_name, excluded.display_name)'
    )
    .bind(identity.sub, name, at)
}
