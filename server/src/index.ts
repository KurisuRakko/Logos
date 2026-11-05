import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import { admin } from './admin'
import { bearerToken, verifyToken } from './auth'
import type { AppEnv, Env } from './env'
import { errorResponse } from './errors'
import { handleLogUpload, purgeExpiredLogs } from './logs'
import { handleMt, mtErrorResponse } from './mt'
import { handleTranslate } from './translate'

export { GlobalQuota } from './quota/global-quota'
export { MtQuota } from './quota/mt-quota'
export { UserQuota } from './quota/user-quota'

export const ALLOWED_ORIGINS = [
  'tauri://localhost',
  'https://tauri.localhost',
  'http://localhost:1420',
  'http://127.0.0.1:5297',
  'http://100.114.125.104:5297'
]

const app = new Hono<AppEnv>()

// /v1/* 给桌面端与 demo 用，开 CORS；/admin/* 同源，不开。
app.use(
  '/v1/*',
  cors({
    origin: ALLOWED_ORIGINS,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86400
  })
)

const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  // /v1/mt 的错误体是扁平形状，鉴权失败也按它返回。
  const fail = (code: 'unauthorized' | 'upstream_error') =>
    c.req.path === '/v1/mt' ? mtErrorResponse(code) : errorResponse(code)
  const token = bearerToken(c.req.header('Authorization'))
  if (!token) return fail('unauthorized')
  const result = await verifyToken(c.env, token)
  if (!result.ok) return fail(result.reason)
  c.set('identity', result.identity)
  await next()
})
app.use('/v1/*', authenticate)
app.use('/admin/api/*', authenticate)

app.post('/v1/translate', handleTranslate)
app.post('/v1/logs', handleLogUpload)
app.post('/v1/mt', handleMt)

app.get('/v1/quota', async (c) => {
  const sub = c.get('identity').sub
  const quota = c.env.USER_QUOTA.get(c.env.USER_QUOTA.idFromName(sub))
  return c.json(await quota.snapshot(sub, Date.now()))
})

app.route('/admin/api', admin)

app.notFound(() => errorResponse('not_found'))
app.onError((err) => {
  console.error('unhandled error', err)
  return errorResponse('internal_error')
})

export default {
  fetch: app.fetch,
  // 每日 cron：清理过期客户端日志。
  async scheduled(controller, env) {
    const deleted = await purgeExpiredLogs(env, controller.scheduledTime)
    console.log('client_logs purged', { deleted })
  }
} satisfies ExportedHandler<Env>
