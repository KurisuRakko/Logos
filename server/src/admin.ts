import { Hono } from 'hono'
import type { AppEnv, Env } from './env'
import { errorResponse } from './errors'
import { GLOBAL_QUOTA_NAME } from './quota/global-quota'
import { beijingMonth } from './time'

const MAX_DISPLAY_NAME = 100
const DEFAULT_USAGE_LIMIT = 50
const MAX_USAGE_LIMIT = 500

interface SettingsRow {
  sub: string
  display_name: string | null
  limit_micro: number | null
  disabled: number
  updated_at: number
}

// D1 存 Unix 秒，对外一律返回 ISO 8601。
function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

export const admin = new Hono<AppEnv>()

admin.use('*', async (c, next) => {
  if (c.get('identity').role !== 'admin') return errorResponse('forbidden')
  await next()
})

async function userEntry(env: Env, sub: string, settings: SettingsRow | null, lastUsedAt: number | null, now: number) {
  const quota = env.USER_QUOTA.get(env.USER_QUOTA.idFromName(sub))
  const snapshot = await quota.snapshot(sub, now)
  return {
    sub,
    display_name: settings?.display_name ?? null,
    limit_micro: snapshot.limit_micro,
    limit_is_default: settings?.limit_micro == null,
    used_micro: snapshot.used_micro,
    disabled: Boolean(settings?.disabled),
    last_used_at: lastUsedAt === null ? null : isoFromSeconds(lastUsedAt)
  }
}

// 本月有调用记录或有设置的用户；已用额度取自各自的 UserQuota（权威）。
admin.get('/users', async (c) => {
  const env = c.env
  const now = Date.now()
  const month = beijingMonth(now)
  const { results } = await env.DB.prepare(
    `SELECT a.sub AS sub, s.display_name, s.limit_micro, s.disabled, s.updated_at,
            (SELECT MAX(created_at) FROM usage_log l WHERE l.sub = a.sub) AS last_used_at
       FROM (SELECT sub FROM user_settings UNION SELECT sub FROM usage_log WHERE month = ?) a
       LEFT JOIN user_settings s ON s.sub = a.sub
      ORDER BY last_used_at DESC, a.sub`
  )
    .bind(month)
    .all<SettingsRow & { last_used_at: number | null }>()

  const users = await Promise.all(
    results.map((row) => userEntry(env, row.sub, row.updated_at === null ? null : row, row.last_used_at, now))
  )
  const global = await env.GLOBAL_QUOTA.get(env.GLOBAL_QUOTA.idFromName(GLOBAL_QUOTA_NAME)).usage(now)
  return c.json({ users, global })
})

admin.patch('/users/:sub', async (c) => {
  const env = c.env
  const sub = c.req.param('sub')
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('invalid_request')

  const { limit_micro, disabled, display_name } = body
  if (
    limit_micro !== undefined &&
    limit_micro !== null &&
    !(typeof limit_micro === 'number' && Number.isSafeInteger(limit_micro) && limit_micro >= 0)
  ) {
    return errorResponse('invalid_request', '额度必须为非负整数（微元），或为 null 以恢复默认额度。')
  }
  if (disabled !== undefined && typeof disabled !== 'boolean') {
    return errorResponse('invalid_request', '停用状态必须为布尔值。')
  }
  if (display_name !== undefined && (typeof display_name !== 'string' || display_name.length > MAX_DISPLAY_NAME)) {
    return errorResponse('invalid_request', `显示名必须为不超过 ${MAX_DISPLAY_NAME} 个字符的字符串。`)
  }

  const now = Date.now()
  const current = await env.DB.prepare('SELECT * FROM user_settings WHERE sub = ?').bind(sub).first<SettingsRow>()
  const next: SettingsRow = {
    sub,
    display_name:
      display_name === undefined ? (current?.display_name ?? null) : (display_name as string).trim() || null,
    limit_micro: limit_micro === undefined ? (current?.limit_micro ?? null) : (limit_micro as number | null),
    disabled: disabled === undefined ? (current?.disabled ?? 0) : disabled ? 1 : 0,
    updated_at: Math.floor(now / 1000)
  }
  await env.DB.prepare(
    `INSERT INTO user_settings (sub, display_name, limit_micro, disabled, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET display_name = excluded.display_name, limit_micro = excluded.limit_micro,
       disabled = excluded.disabled, updated_at = excluded.updated_at`
  )
    .bind(next.sub, next.display_name, next.limit_micro, next.disabled, next.updated_at)
    .run()

  const quota = env.USER_QUOTA.get(env.USER_QUOTA.idFromName(sub))
  await quota.invalidateSettings()

  const last = await env.DB.prepare('SELECT MAX(created_at) AS t FROM usage_log WHERE sub = ?')
    .bind(sub)
    .first<{ t: number | null }>()
  return c.json(await userEntry(env, sub, next, last?.t ?? null, now))
})

admin.get('/usage', async (c) => {
  const sub = c.req.query('sub') || null
  const rawLimit = Number(c.req.query('limit') ?? DEFAULT_USAGE_LIMIT)
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_USAGE_LIMIT) : DEFAULT_USAGE_LIMIT
  const { results } = await c.env.DB.prepare(
    `SELECT id, sub, created_at, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_micro, ok
       FROM usage_log WHERE (?1 IS NULL OR sub = ?1) ORDER BY created_at DESC, id DESC LIMIT ?2`
  )
    .bind(sub, limit)
    .all<{
      id: number
      sub: string
      created_at: number
      cache_hit_tokens: number
      cache_miss_tokens: number
      output_tokens: number
      cost_micro: number
      ok: number
    }>()
  return c.json({
    items: results.map((r) => ({ ...r, created_at: isoFromSeconds(r.created_at), ok: Boolean(r.ok) }))
  })
})
