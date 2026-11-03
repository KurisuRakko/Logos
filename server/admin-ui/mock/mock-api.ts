/**
 * 本地自测用的 /admin/api/* 与 Phainon /auth/* 模拟实现（vite --mode mock 时挂进 dev / preview 服务器）。
 * 只在本机开发与截图时使用，不进产物。
 *
 * 登录流程按真实接口走一遍：/auth/login 记下 code_challenge 后回跳 return_to#login_code&state，
 * /auth/exchange 校验 S256(code_verifier) 与 challenge 一致才发 token，借此验证前端 PKCE 实现。
 * 环境变量 LOGOS_MOCK_ROLE=user 时登录账号不是管理员（/admin/api/* 返回 403），用于检查无权限页。
 */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Connect, Plugin } from 'vite'

const MICRO = 1_000_000
const DEFAULT_LIMIT = 10 * MICRO
const GLOBAL_LIMIT = 200 * MICRO
const ACCESS_TTL_S = 15 * 60

interface MockUser {
  sub: string
  display_name: string | null
  /** null = 默认额度 */
  limit_override: number | null
  used_micro: number
  disabled: boolean
  last_used_at: number | null
}

const now = Date.now()
const minutes = (n: number) => now - n * 60_000

const users: MockUser[] = [
  { sub: 'u_7f3a9c21', display_name: '杨博文', limit_override: 30 * MICRO, used_micro: 12_483_200, disabled: false, last_used_at: minutes(3) },
  { sub: 'u_19b0e6d4', display_name: '林知夏', limit_override: null, used_micro: 9_412_000, disabled: false, last_used_at: minutes(47) },
  { sub: 'u_c2d81f07', display_name: null, limit_override: null, used_micro: 10_000_000, disabled: false, last_used_at: minutes(60 * 26) },
  { sub: 'u_5e6a4b93', display_name: '周以宁', limit_override: null, used_micro: 3_150_400, disabled: false, last_used_at: minutes(60 * 5) },
  { sub: 'u_a04f2c88', display_name: '陈景行', limit_override: 5 * MICRO, used_micro: 4_870_000, disabled: true, last_used_at: minutes(60 * 24 * 6) },
  { sub: 'u_3b7d9e15', display_name: '王若溪', limit_override: null, used_micro: 612_300, disabled: false, last_used_at: minutes(60 * 24 * 2) },
  { sub: 'u_e81c0a5f', display_name: null, limit_override: null, used_micro: 0, disabled: false, last_used_at: null },
]

function usageFor(sub: string, limit: number) {
  const seed = [...sub].reduce((a, c) => a + c.charCodeAt(0), 0)
  return Array.from({ length: Math.min(limit, 12) }, (_, i) => {
    const hit = (seed * (i + 3)) % 900
    const miss = 200 + ((seed * (i + 7)) % 2600)
    const out = 150 + ((seed * (i + 11)) % 3200)
    const ok = (seed + i) % 9 !== 0
    // 按高峰价（元/百万 token）：命中 0.04、未命中 2、输出 8
    const cost = ok ? Math.round(hit * 0.04 + miss * 2 + out * 8) : 0
    return {
      id: seed * 100 + i,
      sub,
      month: '2026-11',
      created_at: now - (i * 37 + (seed % 13)) * 60_000,
      cache_hit_tokens: ok ? hit : 0,
      cache_miss_tokens: ok ? miss : 0,
      output_tokens: ok ? out : 0,
      cost_micro: cost,
      ok: ok ? 1 : 0,
    }
  })
}

const challenges = new Map<string, string>() // login_code → code_challenge
const accessTokens = new Map<string, number>() // access_token → 过期时刻
const refreshTokens = new Set<string>()

function issueTokens() {
  const access = `mock-access-${randomBytes(9).toString('base64url')}`
  const refresh = `mock-refresh-${randomBytes(9).toString('base64url')}`
  accessTokens.set(access, Date.now() + ACCESS_TTL_S * 1000)
  refreshTokens.add(refresh)
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_TTL_S }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } })
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function toView(u: MockUser) {
  return {
    sub: u.sub,
    display_name: u.display_name,
    limit_micro: u.limit_override ?? DEFAULT_LIMIT,
    used_micro: u.used_micro,
    disabled: u.disabled,
    last_used_at: u.last_used_at,
  }
}

const handler: Connect.NextHandleFunction = (req, res, next) => {
  const url = new URL(req.url ?? '/', 'http://mock.local')
  const path = url.pathname
  if (!path.startsWith('/auth/') && !path.startsWith('/admin/api/')) return next()

  void (async () => {
    // ---------------------------------------------------------------- Phainon
    if (req.method === 'GET' && path === '/auth/login') {
      const returnTo = url.searchParams.get('return_to') ?? ''
      const challenge = url.searchParams.get('code_challenge') ?? ''
      if (url.searchParams.get('app_id') !== 'logos' || url.searchParams.get('code_challenge_method') !== 'S256' || !challenge) {
        return fail(res, 400, 'invalid_request', '登录请求参数不完整。')
      }
      const code = randomBytes(12).toString('base64url')
      challenges.set(code, challenge)
      const hash = new URLSearchParams({ login_code: code, state: url.searchParams.get('state') ?? '' })
      res.statusCode = 302
      res.setHeader('Location', `${returnTo}#${hash}`)
      return res.end()
    }
    if (req.method === 'POST' && path === '/auth/exchange') {
      const body = await readBody(req)
      const challenge = challenges.get(String(body.login_code))
      challenges.delete(String(body.login_code))
      const computed = createHash('sha256').update(String(body.code_verifier ?? '')).digest('base64url')
      if (!challenge || challenge !== computed) {
        return fail(res, 400, 'invalid_grant', '登录码无效或校验失败。')
      }
      return send(res, 200, issueTokens())
    }
    if (req.method === 'POST' && path === '/auth/refresh') {
      const body = await readBody(req)
      const token = String(body.refresh_token)
      if (!refreshTokens.delete(token)) return fail(res, 401, 'unauthorized', '会话已失效，请重新登录。')
      return send(res, 200, issueTokens())
    }

    // ---------------------------------------------------------------- /admin/api/*
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const expiresAt = bearer ? accessTokens.get(bearer) : undefined
    if (!expiresAt || expiresAt < Date.now()) return fail(res, 401, 'unauthorized', '登录已失效，请重新登录。')
    if (process.env.LOGOS_MOCK_ROLE === 'user') return fail(res, 403, 'forbidden', '当前账号无管理权限。')

    if (req.method === 'GET' && path === '/admin/api/users') {
      return send(res, 200, {
        users: users.map(toView),
        global: { limit_micro: GLOBAL_LIMIT, used_micro: users.reduce((a, u) => a + u.used_micro, 0) },
      })
    }
    const m = /^\/admin\/api\/users\/([^/]+)$/.exec(path)
    if (req.method === 'PATCH' && m) {
      const user = users.find((u) => u.sub === decodeURIComponent(m[1]))
      if (!user) return fail(res, 404, 'not_found', '用户不存在。')
      const body = await readBody(req)
      if ('limit_micro' in body) {
        const v = body.limit_micro
        if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) {
          return fail(res, 400, 'invalid_request', '额度必须是非负整数（微元）。')
        }
        user.limit_override = v as number | null
      }
      if (typeof body.disabled === 'boolean') user.disabled = body.disabled
      if (typeof body.display_name === 'string') user.display_name = body.display_name.trim() || null
      return send(res, 200, toView(user))
    }
    if (req.method === 'GET' && path === '/admin/api/usage') {
      const sub = url.searchParams.get('sub') ?? ''
      const limit = Number(url.searchParams.get('limit') ?? 20)
      const user = users.find((u) => u.sub === sub)
      return send(res, 200, { items: user && user.last_used_at ? usageFor(sub, limit) : [] })
    }
    return fail(res, 404, 'not_found', '接口不存在。')
  })().catch((err: unknown) => {
    fail(res, 500, 'internal_error', `模拟服务异常：${String(err)}`)
  })
}

export function mockApi(): Plugin {
  return {
    name: 'logos-admin:mock-api',
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}
