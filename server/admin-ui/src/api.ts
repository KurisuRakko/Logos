/**
 * /admin/api/* 客户端（同源，Bearer 鉴权）。接口定义见 server/SPEC.md「接口」。
 * 401 时强制续期重试一次；仍失败抛 AuthRequiredError，由 App 回到登录页。
 */
import { getAccessToken, signOut } from './auth'

export interface AdminUser {
  sub: string
  display_name: string | null
  limit_micro: number
  used_micro: number
  disabled: boolean
  /** 毫秒或秒级时间戳，尚未使用为 null（见 format.ts toDate） */
  last_used_at: number | string | null
}

export interface GlobalQuota {
  limit_micro: number
  used_micro: number
}

export interface UsersResult {
  users: AdminUser[]
  global: GlobalQuota | null
}

export interface UsageEntry {
  id: number
  sub: string
  created_at: number | string
  cache_hit_tokens: number
  cache_miss_tokens: number
  output_tokens: number
  cost_micro: number
  ok: boolean
  /** 失败原因（如 upstream_503、stream_interrupted），成功或旧记录为 null */
  error?: string | null
}

export type LogLevel = 'error' | 'warn' | 'info'

export interface ClientLog {
  id: number
  sub: string
  display_name: string | null
  /** 服务端接收时间（ISO） */
  created_at: string
  level: LogLevel
  event: string
  message: string
  context: unknown
  app_version: string | null
  os: string | null
  /** 客户端上报的发生时间（ISO） */
  client_time: string | null
}

export interface LogsQuery {
  sub?: string
  level?: LogLevel
  limit?: number
}

export interface UserPatch {
  /** null 表示恢复默认额度 */
  limit_micro?: number | null
  disabled?: boolean
  display_name?: string
}

export class AuthRequiredError extends Error {}

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const API_BASE = `${import.meta.env.BASE_URL}api`

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const send = (token: string) =>
    fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
        Authorization: `Bearer ${token}`,
      },
    })

  let token = await getAccessToken()
  if (!token) throw new AuthRequiredError()
  let res: Response
  try {
    res = await send(token)
    if (res.status === 401) {
      token = await getAccessToken(true)
      if (!token) throw new AuthRequiredError()
      res = await send(token)
    }
  } catch (err) {
    if (err instanceof AuthRequiredError) throw err
    throw new ApiError(0, 'network_error', '无法连接服务器，请检查网络后重试。')
  }

  const body: unknown = await res.json().catch(() => null)
  if (res.status === 401) {
    signOut()
    throw new AuthRequiredError()
  }
  if (!res.ok) {
    const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error
    throw new ApiError(
      res.status,
      typeof error?.code === 'string' ? error.code : 'http_error',
      typeof error?.message === 'string' && error.message
        ? error.message
        : `请求失败（HTTP ${res.status}）。`,
    )
  }
  return body
}

/** SPEC 写的是「用户数组外加 {global}」：同时接受 {users, global} 与裸数组两种形态 */
export async function fetchUsers(): Promise<UsersResult> {
  const body = await request('/users')
  const b = (Array.isArray(body) ? { users: body } : (body ?? {})) as {
    users?: AdminUser[]
    global?: GlobalQuota
  }
  // D1 的 disabled 是 0 / 1，统一成布尔
  const users = Array.isArray(b.users) ? b.users.map((u) => ({ ...u, disabled: Boolean(u.disabled) })) : []
  return { users, global: b.global ?? null }
}

export async function patchUser(sub: string, patch: UserPatch): Promise<void> {
  await request(`/users/${encodeURIComponent(sub)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/** 最近明细：同时接受 {items} / {usage} 与裸数组 */
export async function fetchUsage(sub: string, limit = 20): Promise<UsageEntry[]> {
  const params = new URLSearchParams({ sub, limit: String(limit) })
  const body = await request(`/usage?${params}`)
  const b = (body ?? {}) as { items?: UsageEntry[]; usage?: UsageEntry[] }
  const list = Array.isArray(body) ? (body as UsageEntry[]) : (b.items ?? b.usage)
  // D1 的 ok 是 0 / 1，统一成布尔
  return Array.isArray(list) ? list.map((e) => ({ ...e, ok: Boolean(e.ok) })) : []
}

/** 客户端日志（GET /admin/api/logs），按接收时间倒序 */
export async function fetchLogs(query: LogsQuery = {}): Promise<ClientLog[]> {
  const params = new URLSearchParams()
  if (query.sub) params.set('sub', query.sub)
  if (query.level) params.set('level', query.level)
  if (query.limit) params.set('limit', String(query.limit))
  const body = (await request(`/logs?${params}`)) as { items?: ClientLog[] } | null
  return Array.isArray(body?.items) ? body.items : []
}
