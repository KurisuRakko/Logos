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
