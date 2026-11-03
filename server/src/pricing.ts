// DeepSeek deepseek-flash 价格表。
// 源：api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-11-03）。
// 单位：元 / 百万 token，恰好等于「微元 / token」；为避免小数，表内存「百分之一微元 / token」。
export const MODEL = 'deepseek-flash'
export const MAX_OUTPUT_TOKENS = 4096

export interface PriceTier {
  cacheHit: number
  cacheMiss: number
  output: number
}

export const PRICES: { peak: PriceTier; offPeak: PriceTier } = {
  peak: { cacheHit: 4, cacheMiss: 200, output: 800 }, // 0.04 / 2 / 8 元
  offPeak: { cacheHit: 2, cacheMiss: 100, output: 400 } // 0.02 / 1 / 4 元
}

const PRICE_SCALE = 100
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

// 高峰 = 北京时间周一至周五 9:00–12:00、14:00–18:00；法定节假日不维护，按高峰计。
export function isPeak(at: number): boolean {
  const bj = new Date(at + BEIJING_OFFSET_MS)
  const day = bj.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

export interface Usage {
  cacheHitTokens: number
  cacheMissTokens: number
  outputTokens: number
}

export function costMicro(usage: Usage, at: number): number {
  return tierCost(usage, isPeak(at) ? PRICES.peak : PRICES.offPeak)
}

function tierCost(usage: Usage, tier: PriceTier): number {
  const scaled =
    usage.cacheHitTokens * tier.cacheHit + usage.cacheMissTokens * tier.cacheMiss + usage.outputTokens * tier.output
  return Math.ceil(scaled / PRICE_SCALE)
}

// 预扣：ceil(字符数 × 2) 个输入 token 按未命中高峰价 + 满额输出 token 按高峰价，与实际时段无关。
export function reserveMicro(charCount: number): number {
  return tierCost({ cacheHitTokens: 0, cacheMissTokens: Math.ceil(charCount * 2), outputTokens: MAX_OUTPUT_TOKENS }, PRICES.peak)
}

export function cnyToMicro(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  const cny = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  return Math.round(cny * 1_000_000)
}
