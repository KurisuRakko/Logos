import type { Env, Identity } from './env'

export const APP_ID = 'logos'
const CACHE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 1000

type AuthResult = { ok: true; identity: Identity } | { ok: false; reason: 'unauthorized' | 'upstream_error' }

// isolate 内存缓存：key = sha256(token)，只缓存校验通过的结果。
const cache = new Map<string, { identity: Identity; expiresAt: number }>()

export function clearAuthCache() {
  cache.clear()
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function bearerToken(header: string | undefined): string | null {
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  return match ? match[1] : null
}

export async function verifyToken(env: Env, token: string): Promise<AuthResult> {
  const key = await sha256Hex(token)
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > now) return { ok: true, identity: hit.identity }
  if (hit) cache.delete(key)

  const base = (env.PHAINON_BASE || 'https://api.rakko.cn').replace(/\/+$/, '')
  let res: Response
  try {
    const req = new Request(`${base}/auth/me`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
    // 同 zone 的 Worker 互相 fetch custom domain 可能被拒（1042），有 service binding 时走 binding。
    res = env.PHAINON ? await env.PHAINON.fetch(req) : await fetch(req)
  } catch {
    return { ok: false, reason: 'upstream_error' }
  }
  if (res.status >= 500) return { ok: false, reason: 'upstream_error' }
  if (!res.ok) return { ok: false, reason: 'unauthorized' }

  const body = (await res.json().catch(() => null)) as { app_id?: unknown; user?: Partial<Identity> } | null
  const user = body?.user
  if (body?.app_id !== APP_ID || !user || typeof user.sub !== 'string' || !user.sub) {
    return { ok: false, reason: 'unauthorized' }
  }
  const identity: Identity = {
    sub: user.sub,
    name: user.name,
    preferred_username: user.preferred_username,
    email: user.email,
    role: user.role === 'admin' ? 'admin' : 'user'
  }

  if (cache.size >= CACHE_MAX_ENTRIES) {
    for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k)
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!)
  }
  cache.set(key, { identity, expiresAt: now + CACHE_TTL_MS })
  return { ok: true, identity }
}

export function displayNameOf(identity: Identity): string | null {
  return identity.name || identity.preferred_username || identity.email || null
}
