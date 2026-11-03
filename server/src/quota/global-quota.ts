import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'
import { cnyToMicro } from '../pricing'
import { beijingMonth } from '../time'
import { Ledger, RESERVATION_TTL_MS, ensureAlarm } from './ledger'

export const GLOBAL_QUOTA_NAME = 'global'

// 全站保险丝：单例（idFromName('global')），与 UserQuota 同样预扣 / 结算。
export class GlobalQuota extends DurableObject<Env> {
  private readonly ledger: Ledger

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ledger = new Ledger(ctx.storage)
  }

  async reserve(id: string, amount: number, now: number): Promise<boolean> {
    if (!this.ledger.tryReserve(id, beijingMonth(now), amount, this.limit(), now)) return false
    await ensureAlarm(this.ctx.storage, now + RESERVATION_TTL_MS)
    return true
  }

  async settle(id: string, cost: number): Promise<void> {
    this.ledger.settle(id, cost)
  }

  async refund(id: string): Promise<void> {
    this.ledger.refund(id)
  }

  async usage(now: number): Promise<{ limit_micro: number; used_micro: number }> {
    return { limit_micro: this.limit(), used_micro: this.ledger.used(beijingMonth(now)) }
  }

  async alarm() {
    const next = this.ledger.expireStale(Date.now())
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }

  private limit(): number {
    return cnyToMicro(this.env.GLOBAL_MONTHLY_LIMIT_CNY, 200)
  }
}
