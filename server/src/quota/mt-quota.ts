import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'
import { beijingMonth, utcDay } from '../time'
import { Ledger, RESERVATION_TTL_MS, ensureAlarm } from './ledger'

export type MtProvider = 'baidu' | 'fallback'

export const DEFAULT_BAIDU_MONTHLY_CHARS = 50_000
export const DEFAULT_FALLBACK_DAILY_CHARS = 40_000

// 机器翻译的全站字符额度：每个 provider 一个单例（idFromName(provider)），复用 Ledger，记账单位为字符。
// baidu 按北京时间自然月（百度免费额度口径），fallback 按 UTC 日（Workers AI 每日免费 neurons 口径）。
export class MtQuota extends DurableObject<Env> {
  private readonly ledger: Ledger

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ledger = new Ledger(ctx.storage)
  }

  async reserve(provider: MtProvider, id: string, chars: number, now: number): Promise<boolean> {
    if (!this.ledger.tryReserve(id, periodOf(provider, now), chars, mtLimit(this.env, provider), now)) return false
    await ensureAlarm(this.ctx.storage, now + RESERVATION_TTL_MS)
    return true
  }

  async settle(id: string, chars: number): Promise<void> {
    this.ledger.settle(id, chars)
  }

  async refund(id: string): Promise<void> {
    this.ledger.refund(id)
  }

  async usage(provider: MtProvider, now: number): Promise<{ limit_chars: number; used_chars: number }> {
    return { limit_chars: mtLimit(this.env, provider), used_chars: this.ledger.used(periodOf(provider, now)) }
  }

  async alarm() {
    const next = this.ledger.expireStale(Date.now())
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }
}

export function periodOf(provider: MtProvider, now: number): string {
  return provider === 'baidu' ? beijingMonth(now) : utcDay(now)
}

// var 缺省或非法时用默认值；允许设为 0 以关闭该 provider。
export function mtLimit(env: Env, provider: MtProvider): number {
  const [raw, fallback] =
    provider === 'baidu'
      ? [env.BAIDU_MONTHLY_CHARS, DEFAULT_BAIDU_MONTHLY_CHARS]
      : [env.FALLBACK_DAILY_CHARS, DEFAULT_FALLBACK_DAILY_CHARS]
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= 0 ? n : fallback
}
