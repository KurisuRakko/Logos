import { MAX_OUTPUT_TOKENS, MODEL, type Usage } from './pricing'

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'

export function deepseekRequest(apiKey: string, system: string, text: string): Request {
  return new Request(DEEPSEEK_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text }
      ],
      thinking: { type: 'disabled' },
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: MAX_OUTPUT_TOKENS
    })
  })
}

export type StreamEvent = { type: 'delta'; text: string } | { type: 'usage'; usage: Usage }

interface Chunk {
  choices?: { delta?: { content?: string | null } }[]
  usage?: {
    prompt_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
    completion_tokens?: number
  } | null
}

function toUsage(raw: NonNullable<Chunk['usage']>): Usage {
  const hit = raw.prompt_cache_hit_tokens ?? 0
  // 缺少命中 / 未命中拆分时，把全部输入按未命中计。
  const miss = raw.prompt_cache_miss_tokens ?? Math.max(0, (raw.prompt_tokens ?? 0) - hit)
  return { cacheHitTokens: hit, cacheMissTokens: miss, outputTokens: raw.completion_tokens ?? 0 }
}

// 逐条解析 OpenAI 兼容的 SSE（data: {...} / data: [DONE]）。
export async function* readDeepseekStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        yield* parseLine(line)
      }
      if (done) {
        if (buffer) yield* parseLine(buffer)
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function* parseLine(line: string): Generator<StreamEvent> {
  if (!line.startsWith('data:')) return
  const data = line.slice(5).trim()
  if (!data || data === '[DONE]') return
  const chunk = JSON.parse(data) as Chunk
  const text = chunk.choices?.[0]?.delta?.content
  if (text) yield { type: 'delta', text }
  if (chunk.usage) yield { type: 'usage', usage: toUsage(chunk.usage) }
}

// 上游重试：只在尚未向客户端发出任何内容（拿到 2xx 响应之前）时进行。
export const RETRY_DELAYS_MS = [400, 1200]
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

// usage_log.error 的取值：upstream_<HTTP 状态>、upstream_timeout、upstream_network、upstream_empty_body。
export type UpstreamResult =
  | { ok: true; response: Response & { body: ReadableStream<Uint8Array> } }
  | { ok: false; code: 'upstream_busy' | 'upstream_error'; error: string }

interface Failure {
  status: number | null
  error: string
  retryable: boolean
}

// DeepSeek 错误体形如 {error: {message, type, code}}；只取 type/code 记日志，不记 message（可能回显原文）。
async function describeError(res: Response): Promise<{ type?: unknown; code?: unknown }> {
  const body = (await res.json().catch(() => null)) as { error?: { type?: unknown; code?: unknown } } | null
  return { type: body?.error?.type, code: body?.error?.code }
}

async function attempt(makeRequest: () => Request, n: number): Promise<UpstreamResult | Failure> {
  let res: Response
  try {
    res = await fetch(makeRequest())
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    const error = name === 'TimeoutError' || name === 'AbortError' ? 'upstream_timeout' : 'upstream_network'
    console.error('deepseek request failed', { attempt: n, error, name })
    return { status: null, error, retryable: true }
  }
  if (res.ok && res.body) return { ok: true, response: res as Response & { body: ReadableStream<Uint8Array> } }
  if (res.ok) {
    console.error('deepseek request failed', { attempt: n, status: res.status, error: 'upstream_empty_body' })
    return { status: res.status, error: 'upstream_empty_body', retryable: false }
  }
  const detail = await describeError(res)
  console.error('deepseek request failed', { attempt: n, status: res.status, type: detail.type, code: detail.code })
  return { status: res.status, error: `upstream_${res.status}`, retryable: RETRYABLE_STATUS.has(res.status) }
}

// 依次尝试 1 + RETRY_DELAYS_MS.length 次；全部失败时以最后一次的失败定错误码：503 → upstream_busy，其余 upstream_error。
export async function fetchDeepseekWithRetry(makeRequest: () => Request): Promise<UpstreamResult> {
  for (let n = 0; ; n++) {
    const result = await attempt(makeRequest, n + 1)
    if ('ok' in result) return result
    if (!result.retryable || n >= RETRY_DELAYS_MS.length) {
      return { ok: false, code: result.status === 503 ? 'upstream_busy' : 'upstream_error', error: result.error }
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[n]))
  }
}
