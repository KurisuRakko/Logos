import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'
import { cnyToMicro } from '../pricing'
import { beijingMonth, nextMonthStart } from '../time'
import { Ledger, RESERVATION_TTL_MS, ensureAlarm } from './ledger'

export const RATE_LIMIT_PER_MINUTE = 30
const RATE_WINDOW_MS = 60_000
const SETTINGS_TTL_MS = 30_000

export type ReserveResult = { ok: true } | { ok: false; code: 'user_disabled' | 'rate_limited' | 'quota_exhausted' }

export interface QuotaSnapshot {
  limit_micro: number
  used_micro: number
  remaining_ratio: number
  resets_at: string
}

interface Settings {
  limitMicro: number | null
  disabled: boolean
}

// 每个用户一个实例（idFromName(sub)）：限频、预扣、结算。额度的权威。
export class UserQuota extends DurableObject<Env> {
  private readonly ledger: Ledger
  private settings: { value: Settings; fetchedAt: number } | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ledger = new Ledger(ctx.storage)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS hits (ts INTEGER NOT NULL)')
  }

  async reserve(sub: string, id: string, amount: number, now: number): Promise<ReserveResult> {
    const settings = await this.loadSettings(sub, now)
    if (settings.disabled) return { ok: false, code: 'user_disabled' }

    // 滑动窗口：只统计被放行的请求，被限频的请求不延长封锁。
    const sql = this.ctx.storage.sql
    sql.exec('DELETE FROM hits WHERE ts <= ?', now - RATE_WINDOW_MS)
    const hits = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM hits').one().n
    if (hits >= RATE_LIMIT_PER_MINUTE) return { ok: false, code: 'rate_limited' }
    sql.exec('INSERT INTO hits (ts) VALUES (?)', now)

    if (!this.ledger.tryReserve(id, beijingMonth(now), amount, this.limitOf(settings), now)) {
      return { ok: false, code: 'quota_exhausted' }
    }
    await ensureAlarm(this.ctx.storage, now + RESERVATION_TTL_MS)
    return { ok: true }
  }

  async settle(sub: string, id: string, cost: number, now: number): Promise<QuotaSnapshot> {
    this.ledger.settle(id, cost)
    return this.snapshot(sub, now)
  }

  async refund(id: string): Promise<void> {
    this.ledger.refund(id)
  }

  async snapshot(sub: string, now: number): Promise<QuotaSnapshot> {
    const limit = this.limitOf(await this.loadSettings(sub, now))
    const used = this.ledger.used(beijingMonth(now))
    return {
      limit_micro: limit,
      used_micro: used,
      remaining_ratio: limit > 0 ? Math.min(1, Math.max(0, (limit - used) / limit)) : 0,
      resets_at: nextMonthStart(now)
    }
  }

  // 管理页 PATCH 后调用，下次请求重新从 D1 读取。
  async invalidateSettings(): Promise<void> {
    this.settings = null
  }

  async alarm() {
    const next = this.ledger.expireStale(Date.now())
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }

  private limitOf(settings: Settings): number {
    return settings.limitMicro ?? cnyToMicro(this.env.DEFAULT_MONTHLY_LIMIT_CNY, 10)
  }

  private async loadSettings(sub: string, now: number): Promise<Settings> {
    if (this.settings && now - this.settings.fetchedAt < SETTINGS_TTL_MS) return this.settings.value
    const row = await this.env.DB.prepare('SELECT limit_micro, disabled FROM user_settings WHERE sub = ?')
      .bind(sub)
      .first<{ limit_micro: number | null; disabled: number }>()
    const value: Settings = { limitMicro: row?.limit_micro ?? null, disabled: Boolean(row?.disabled) }
    this.settings = { value, fetchedAt: now }
    return value
  }
}
