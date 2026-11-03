// UserQuota 与 GlobalQuota 共用的按月账本（DO 内 SQLite）。
// used_micro 只记已结算花费；未结算的预扣单独放在 reservations，余额 = 上限 − 已结算 − 预扣中。
// DO 单线程且 SQL 同步执行，所以「查余额 + 写预扣」天然原子，并发请求不会超额。

// 预扣超过这个时长仍未结算（Worker 中途被回收等），由 alarm 按预扣额结算，避免永久占用余额。
export const RESERVATION_TTL_MS = 15 * 60 * 1000

export class Ledger {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS months (month TEXT PRIMARY KEY, used_micro INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY, month TEXT NOT NULL, amount INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
    `)
  }

  used(month: string): number {
    const row = this.storage.sql.exec<{ used_micro: number }>('SELECT used_micro FROM months WHERE month = ?', month).toArray()[0]
    return row?.used_micro ?? 0
  }

  reserved(month: string): number {
    return this.storage.sql
      .exec<{ total: number }>('SELECT COALESCE(SUM(amount), 0) AS total FROM reservations WHERE month = ?', month)
      .one().total
  }

  // 余额足够则写入预扣并返回 true。
  tryReserve(id: string, month: string, amount: number, limit: number, now: number): boolean {
    if (this.used(month) + this.reserved(month) + amount > limit) return false
    this.storage.sql.exec(
      'INSERT INTO reservations (id, month, amount, created_at) VALUES (?, ?, ?, ?)',
      id,
      month,
      amount,
      now
    )
    return true
  }

  // 按实际花费结算到预扣所属月份；预扣已不存在（已退回或已过期结算）时不重复记账。
  settle(id: string, cost: number): boolean {
    const row = this.storage.sql
      .exec<{ month: string }>('SELECT month FROM reservations WHERE id = ?', id)
      .toArray()[0]
    if (!row) return false
    this.storage.transactionSync(() => {
      this.storage.sql.exec('DELETE FROM reservations WHERE id = ?', id)
      this.charge(row.month, cost)
    })
    return true
  }

  refund(id: string): void {
    this.storage.sql.exec('DELETE FROM reservations WHERE id = ?', id)
  }

  // 结算过期预扣；返回下一条预扣的过期时刻（没有则 null）。
  expireStale(now: number): number | null {
    const stale = this.storage.sql
      .exec<{ id: string; month: string; amount: number }>(
        'SELECT id, month, amount FROM reservations WHERE created_at <= ?',
        now - RESERVATION_TTL_MS
      )
      .toArray()
    for (const r of stale) {
      this.storage.transactionSync(() => {
        this.storage.sql.exec('DELETE FROM reservations WHERE id = ?', r.id)
        this.charge(r.month, r.amount)
      })
    }
    const next = this.storage.sql
      .exec<{ oldest: number | null }>('SELECT MIN(created_at) AS oldest FROM reservations')
      .one().oldest
    return next === null ? null : next + RESERVATION_TTL_MS
  }

  private charge(month: string, cost: number) {
    this.storage.sql.exec(
      'INSERT INTO months (month, used_micro) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET used_micro = used_micro + excluded.used_micro',
      month,
      cost
    )
  }
}

export async function ensureAlarm(storage: DurableObjectStorage, at: number) {
  const current = await storage.getAlarm()
  if (current === null || current > at) await storage.setAlarm(at)
}
