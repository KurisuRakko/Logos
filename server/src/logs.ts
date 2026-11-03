import type { Context } from 'hono'
import type { AppEnv, Env } from './env'
import { errorResponse } from './errors'

export const LOG_LEVELS = ['error', 'warn', 'info'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const MAX_LOG_ENTRIES = 20
export const MAX_EVENT_CHARS = 64
export const MAX_MESSAGE_CHARS = 2000
export const MAX_CONTEXT_BYTES = 4096
const MAX_META_CHARS = 64
export const LOG_RETENTION_DAYS = 30

const encoder = new TextEncoder()

function byteLength(s: string): number {
  return encoder.encode(s).length
}

// 按码点截断，避免切开代理对。
function truncateChars(s: string, max: number): string {
  const chars = [...s]
  return chars.length > max ? chars.slice(0, max).join('') : s
}

// context 序列化后超过 4KB 时，改存 {truncated: true, preview: <序列化结果的前缀>}，保证仍是合法 JSON 且不超过上限。
export function serializeContext(context: unknown): string | null {
  if (context === undefined || context === null) return null
  let json: string | undefined
  try {
    json = JSON.stringify(context)
  } catch {
    return JSON.stringify({ truncated: true, preview: '' })
  }
  if (json === undefined) return null
  if (byteLength(json) <= MAX_CONTEXT_BYTES) return json
  const chars = [...json]
  let keep = Math.min(chars.length, MAX_CONTEXT_BYTES)
  while (true) {
    const wrapped = JSON.stringify({ truncated: true, preview: chars.slice(0, keep).join('') })
    const over = byteLength(wrapped) - MAX_CONTEXT_BYTES
    if (over <= 0) return wrapped
    keep = Math.max(0, keep - Math.max(1, Math.ceil(over / 3)))
  }
}

interface LogRow {
  level: LogLevel
  event: string
  message: string
  context: string | null
  client_time: string
}

// 单条校验：level / event / client_time 不合格的条目整条丢弃；message 超长截断，context 超长按 serializeContext 处理。
function normalizeEntry(raw: unknown): LogRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { level, event, message, context, client_time } = raw as Record<string, unknown>
  if (typeof level !== 'string' || !(LOG_LEVELS as readonly string[]).includes(level)) return null
  if (typeof event !== 'string' || !event || [...event].length > MAX_EVENT_CHARS) return null
  if (typeof message !== 'string') return null
  if (typeof client_time !== 'string' || client_time.length > MAX_META_CHARS || Number.isNaN(Date.parse(client_time))) {
    return null
  }
  return {
    level: level as LogLevel,
    event,
    message: truncateChars(message, MAX_MESSAGE_CHARS),
    context: serializeContext(context),
    client_time
  }
}

function optionalMeta(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return undefined
  return truncateChars(value, MAX_META_CHARS)
}

export async function handleLogUpload(c: Context<AppEnv>): Promise<Response> {
  const env = c.env
  const sub = c.get('identity').sub
  const now = Date.now()

  const quota = env.USER_QUOTA.get(env.USER_QUOTA.idFromName(sub))
  if (!(await quota.allowLogUpload(now))) return errorResponse('rate_limited')

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('invalid_request')
  const appVersion = optionalMeta(body.app_version)
  const os = optionalMeta(body.os)
  if (appVersion === undefined || os === undefined) {
    return errorResponse('invalid_request', 'app_version 与 os 必须为字符串。')
  }
  if (!Array.isArray(body.entries)) return errorResponse('invalid_request', 'entries 必须为数组。')
  if (body.entries.length > MAX_LOG_ENTRIES) {
    return errorResponse('invalid_request', `单次上传的日志不得超过 ${MAX_LOG_ENTRIES} 条。`)
  }

  const rows = body.entries.map(normalizeEntry).filter((r): r is LogRow => r !== null)
  if (rows.length > 0) {
    const at = Math.floor(now / 1000)
    const insert = env.DB.prepare(
      'INSERT INTO client_logs (sub, created_at, level, event, message, context, app_version, os, client_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    await env.DB.batch(
      rows.map((r) => insert.bind(sub, at, r.level, r.event, r.message, r.context, appVersion, os, r.client_time))
    )
  }
  return c.json({ accepted: rows.length })
}

// cron 每日调用：删除保留期之外的客户端日志。
export async function purgeExpiredLogs(env: Env, now: number): Promise<number> {
  const cutoff = Math.floor(now / 1000) - LOG_RETENTION_DAYS * 86_400
  const result = await env.DB.prepare('DELETE FROM client_logs WHERE created_at < ?').bind(cutoff).run()
  return result.meta.changes ?? 0
}
