import { Hono } from 'hono'
import type { AppEnv, Env } from './env'
import { errorResponse } from './errors'
import { LOG_LEVELS } from './logs'
import { GLOBAL_QUOTA_NAME } from './quota/global-quota'
import { beijingMonth } from './time'

const MAX_DISPLAY_NAME = 100
const DEFAULT_USAGE_LIMIT = 50
const MAX_USAGE_LIMIT = 500
const DEFAULT_LOGS_LIMIT = 100
const MAX_LOGS_LIMIT = 500

interface SettingsRow {
  sub: string
  display_name: string | null
  limit_micro: number | null
  disabled: number
  updated_at: number
}

// D1 存 Unix 秒，对外一律返回 ISO 8601。
function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw ?? fallback)
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback
}

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
  const limit = parseLimit(c.req.query('limit'), DEFAULT_USAGE_LIMIT, MAX_USAGE_LIMIT)
  const { results } = await c.env.DB.prepare(
    `SELECT id, sub, created_at, cache_hit_tokens, cache_miss_tokens, output_tokens, cost_micro, ok, error
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
      error: string | null
    }>()
  return c.json({
    items: results.map((r) => ({ ...r, created_at: isoFromSeconds(r.created_at), ok: Boolean(r.ok) }))
  })
})

// 客户端日志，按接收时间倒序；context 原样解析回 JSON。
admin.get('/logs', async (c) => {
  const sub = c.req.query('sub') || null
  const level = c.req.query('level') || null
  if (level !== null && !(LOG_LEVELS as readonly string[]).includes(level)) {
    return errorResponse('invalid_request', `level 必须为 ${LOG_LEVELS.join('、')} 之一。`)
  }
  const limit = parseLimit(c.req.query('limit'), DEFAULT_LOGS_LIMIT, MAX_LOGS_LIMIT)
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.sub, s.display_name, l.created_at, l.level, l.event, l.message, l.context, l.app_version, l.os, l.client_time
       FROM client_logs l LEFT JOIN user_settings s ON s.sub = l.sub
      WHERE (?1 IS NULL OR l.sub = ?1) AND (?2 IS NULL OR l.level = ?2)
      ORDER BY l.created_at DESC, l.id DESC LIMIT ?3`
  )
    .bind(sub, level, limit)
    .all<{
      id: number
      sub: string
      display_name: string | null
      created_at: number
      level: string
      event: string
      message: string
      context: string | null
      app_version: string | null
      os: string | null
      client_time: string | null
    }>()
  return c.json({
    items: results.map((r) => ({ ...r, created_at: isoFromSeconds(r.created_at), context: parseContext(r.context) }))
  })
})

function parseContext(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
