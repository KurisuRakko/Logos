/**
 * Phainon 原生登录（app_id = logos，S256 PKCE），流程见 server/SPEC.md「身份」：
 *   startLogin()            生成 verifier / state 存 sessionStorage → 跳 /auth/login
 *   completeLoginFromHash() 回跳后读 #login_code&state → 校验 state → POST /auth/exchange
 *   getAccessToken()        过期前 30 秒用 /auth/refresh 续期（refresh 会轮换，单飞避免并发续期互相作废）
 * access / refresh 只放内存与 sessionStorage（关掉标签页即失效），不写 localStorage。
 */

const PHAINON_BASE = (import.meta.env.VITE_PHAINON_BASE ?? 'https://api.rakko.cn').replace(/\/+$/, '')
const APP_ID = 'logos'

const PENDING_KEY = 'logos-admin.pkce'
const SESSION_KEY = 'logos-admin.session'

/** 交换结果没给 expires_in 时按 SPEC 的 15 分钟算 */
const DEFAULT_ACCESS_TTL_S = 15 * 60
/** 提前这么久续期，避免请求在路上过期 */
const REFRESH_LEEWAY_MS = 30_000

interface PendingLogin {
  verifier: string
  state: string
}

interface Session {
  accessToken: string
  refreshToken: string
  /** access 过期时刻（ms） */
  expiresAt: number
}

export class LoginError extends Error {}

let session: Session | null = readSession()
let refreshing: Promise<Session | null> | null = null

/** 回跳地址：当前 origin 下的 /admin/（与 Phainon allowed_return_urls 逐字一致） */
function returnTo(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).href
}

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomToken(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储不可用时只留在内存里，刷新页面需要重新登录
  }
}

function readSession(): Session | null {
  const s = readJson<Session>(SESSION_KEY)
  return s && typeof s.accessToken === 'string' && typeof s.refreshToken === 'string' ? s : null
}

function saveSession(next: Session | null): void {
  session = next
  writeJson(SESSION_KEY, next)
}

/** 把 /auth/exchange 与 /auth/refresh 的响应体转成会话；字段不全视为失败 */
function toSession(body: unknown): Session | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.access_token !== 'string' || typeof b.refresh_token !== 'string') return null
  const ttl = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : DEFAULT_ACCESS_TTL_S
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt: Date.now() + ttl * 1000 }
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } }
    if (typeof body.error?.message === 'string' && body.error.message) return body.error.message
  } catch {
    // 非 JSON 响应用兜底文案
  }
  return fallback
}

export function hasSession(): boolean {
  return session !== null
}

/** 跳转到 Phainon 登录页；不返回（页面即将卸载） */
export async function startLogin(): Promise<void> {
  const pending: PendingLogin = { verifier: randomToken(32), state: randomToken(16) }
  writeJson(PENDING_KEY, pending)
  const params = new URLSearchParams({
    app_id: APP_ID,
    return_to: returnTo(),
    state: pending.state,
    code_challenge: await s256(pending.verifier),
    code_challenge_method: 'S256',
  })
  window.location.assign(`${PHAINON_BASE}/auth/login?${params}`)
}

/**
 * 处理登录回跳：地址栏 hash 里没有 login_code 时返回 false；
 * 有则无论成败都先把 hash 从地址栏抹掉，成功返回 true，失败抛 LoginError。
 */
export async function completeLoginFromHash(): Promise<boolean> {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const code = hash.get('login_code')
  const returnedError = hash.get('error')
  if (!code && !returnedError) return false

  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  const pending = readJson<PendingLogin>(PENDING_KEY)
  writeJson(PENDING_KEY, null)

  if (!code) throw new LoginError('登录未完成，请重新登录。')
  if (!pending || pending.state !== hash.get('state')) {
    throw new LoginError('登录状态校验失败，请重新登录。')
  }

  let res: Response
  try {
    res = await fetch(`${PHAINON_BASE}/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login_code: code, code_verifier: pending.verifier }),
    })
  } catch {
    throw new LoginError('无法连接登录服务，请稍后重试。')
  }
  if (!res.ok) throw new LoginError(await errorMessage(res, '登录凭据交换失败，请重新登录。'))
  const next = toSession(await res.json().catch(() => null))
  if (!next) throw new LoginError('登录服务返回的数据不完整，请重新登录。')
  saveSession(next)
  return true
}

/** 用 refresh_token 换新会话；refresh 失效时清空会话并返回 null，网络错误照常抛出 */
function refresh(): Promise<Session | null> {
  if (refreshing) return refreshing
  const current = session
  if (!current) return Promise.resolve(null)
  refreshing = (async () => {
    try {
      const res = await fetch(`${PHAINON_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
      })
      if (!res.ok) {
        // 5xx 视为暂时故障，保留会话；其余（401 / 400 等）说明 refresh 已失效或被撤销
        if (res.status >= 500) throw new Error(`refresh ${res.status}`)
        saveSession(null)
        return null
      }
      const next = toSession(await res.json().catch(() => null))
      saveSession(next)
      return next
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/** 取可用的 access token；没有会话或续期失败返回 null */
export async function getAccessToken(force = false): Promise<string | null> {
  if (!session) return null
  if (force || session.expiresAt - REFRESH_LEEWAY_MS <= Date.now()) {
    const next = await refresh()
    return next?.accessToken ?? null
  }
  return session.accessToken
}

export function signOut(): void {
  saveSession(null)
  writeJson(PENDING_KEY, null)
}
