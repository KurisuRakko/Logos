/** 金额与时间的显示 / 解析。记账单位微元：1 元 = 1,000,000 微元（server/SPEC.md「计价与额度」）。 */
import type { AdminUser } from './api'

export const MICRO_PER_YUAN = 1_000_000

const yuanFormat = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** 微元 → 「12.34」（到 0.01 元，四舍五入）；不足 0.005 元但非零的显示为「< 0.01」，避免把真实花费显示成 0 */
export function formatYuan(micro: number): string {
  if (micro > 0 && micro < 5_000) return '< 0.01'
  return yuanFormat.format(Math.round(micro / 10_000) / 100)
}

/** 额度输入框的初值：微元 → 「10」或「12.5」这类不带千分位的数字 */
export function yuanInputValue(micro: number): string {
  return String(Math.round(micro / 10_000) / 100)
}

/** 以元为单位的输入 → 微元；格式不对返回 null。最多两位小数，上限 1,000,000 元 */
export function parseYuan(input: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim())
  if (!m) return null
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
  if (cents > 1_000_000 * 100) return null
  return cents * 10_000
}

/** 剩余比例 0..1；额度为 0 视为已用尽 */
export function remainingRatio(used: number, limit: number): number {
  if (limit <= 0) return 0
  return Math.min(1, Math.max(0, 1 - used / limit))
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio > 0 && ratio < 0.1 ? 1 : 0)}%`
}

/** 时间戳（秒或毫秒）/ ISO 字符串 → Date；规格未定秒还是毫秒，小于 1e12 按秒处理 */
export function toDate(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value)
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function formatTime(value: number | string | null | undefined): string {
  const d = toDate(value)
  return d ? timeFormat.format(d) : '—'
}

export function formatTokens(n: number): string {
  return n.toLocaleString('zh-CN')
}

/** 表格与提示里的用户名：有显示名用显示名，否则用 sub */
export function displayName(user: AdminUser): string {
  return user.display_name?.trim() || user.sub
}

/** usage_log.error → 管理页显示的失败原因；未知取值原样显示 */
export function failureReason(error: string | null | undefined): string | null {
  if (!error) return null
  const status = /^upstream_(\d{3})$/.exec(error)?.[1]
  if (status === '503') return '上游繁忙（HTTP 503）'
  if (status === '429') return '上游限流（HTTP 429）'
  if (status) return `上游错误（HTTP ${status}）`
  switch (error) {
    case 'upstream_timeout':
      return '上游请求超时'
    case 'upstream_network':
      return '上游网络错误'
    case 'upstream_empty_body':
      return '上游响应为空'
    case 'stream_interrupted':
      return '上游输出中断'
    case 'internal_error':
      return '服务内部错误'
    default:
      return error
  }
}
