const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

// 北京时间自然月，形如 2026-11。
export function beijingMonth(at: number): string {
  const bj = new Date(at + BEIJING_OFFSET_MS)
  return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}`
}

// 下个北京时间月初 0 点（ISO，UTC 表示）。
export function nextMonthStart(at: number): string {
  const bj = new Date(at + BEIJING_OFFSET_MS)
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth() + 1, 1) - BEIJING_OFFSET_MS).toISOString()
}
