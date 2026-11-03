import { SELF } from 'cloudflare:test'
import { vi } from 'vitest'

export const ORIGIN = 'https://logos-api.rakko.cn'

export interface MockUser {
  sub: string
  app_id?: string
  role?: 'user' | 'admin'
  name?: string
}

export interface DeepseekUsage {
  prompt_cache_hit_tokens: number
  prompt_cache_miss_tokens: number
  completion_tokens: number
}

export type DeepseekBehavior =
  | { kind: 'ok'; deltas?: string[]; usage?: DeepseekUsage; gate?: Promise<void> }
  | { kind: 'status'; status: number }
  | { kind: 'throw' }
  | { kind: 'break'; beforeDelta?: boolean } // 输出一段（beforeDelta 时不输出）后上游断流，没有 usage

export const DEFAULT_USAGE: DeepseekUsage = {
  prompt_cache_hit_tokens: 1000,
  prompt_cache_miss_tokens: 500,
  completion_tokens: 200
}

// 把 Worker 发出的 fetch 换成 Phainon /auth/me 与 DeepSeek 的 mock。
export function installFetchMock() {
  const tokens = new Map<string, MockUser>()
  const deepseekCalls: unknown[] = []
  let deepseek: DeepseekBehavior = { kind: 'ok' }

  const encoder = new TextEncoder()
  const sse = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin === 'https://phainon.test' && url.pathname === '/auth/me') {
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''
      const user = tokens.get(token)
      if (!user) return Response.json({ error: 'invalid_token' }, { status: 401 })
      const { app_id = 'logos', ...rest } = user
      return Response.json({ app_id, user: rest })
    }
    if (url.href === 'https://api.deepseek.com/chat/completions') {
      deepseekCalls.push(await request.json())
      const behavior = deepseek
      if (behavior.kind === 'throw') throw new TypeError('network error')
      if (behavior.kind === 'status') return new Response('upstream failed', { status: behavior.status })
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const deltas = behavior.kind === 'ok' ? (behavior.deltas ?? ['你好', '，世界']) : ['半截']
          if (!(behavior.kind === 'break' && behavior.beforeDelta)) {
            controller.enqueue(sse({ choices: [{ delta: { content: deltas[0] } }] }))
          }
          if (behavior.kind === 'ok' && behavior.gate) await behavior.gate
          if (behavior.kind === 'break') {
            // 先让已入队的分片被读走，再模拟连接中断
            await new Promise((r) => setTimeout(r, 20))
            controller.error(new Error('connection reset'))
            return
          }
          for (const d of deltas.slice(1)) controller.enqueue(sse({ choices: [{ delta: { content: d } }] }))
          controller.enqueue(sse({ choices: [], usage: behavior.usage ?? DEFAULT_USAGE }))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error(`unexpected fetch ${request.method} ${request.url}`)
  })
  vi.stubGlobal('fetch', mock)

  return {
    mock,
    deepseekCalls,
    // 每个测试用独立 token / sub，避免缓存与 DO 状态互相影响。
    user(user: MockUser): string {
      const token = `tok-${crypto.randomUUID()}`
      tokens.set(token, user)
      return token
    },
    setDeepseek(behavior: DeepseekBehavior) {
      deepseek = behavior
    }
  }
}

export function call(path: string, token: string | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body) headers.set('Content-Type', 'application/json')
  return SELF.fetch(`${ORIGIN}${path}`, { ...init, headers })
}

export function translate(token: string, text = 'hello world', from = 'auto', to = 'zh_cn') {
  return call('/v1/translate', token, { method: 'POST', body: JSON.stringify({ text, from, to }) })
}

export async function readEvents(res: Response): Promise<Record<string, unknown>[]> {
  const body = await res.text()
  return body
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)))
}

export function uniqueSub(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}
