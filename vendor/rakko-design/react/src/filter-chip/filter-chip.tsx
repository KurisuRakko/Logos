import { Toggle } from '@base-ui/react/toggle'
import type { ToggleProps } from '@base-ui/react/toggle'
import { cx } from '../cx'

export interface FilterChipProps
  extends Omit<ToggleProps<string>, 'className'> {
  className?: string
}

/**
 * 多选过滤 chip：pressed 切换语义（aria-pressed + data-pressed）。
 * selected 同时改变边框与文字色，不只换填充色（motion.md）。
 */
export function FilterChip({ className, ...props }: FilterChipProps) {
  return (
    <Toggle {...props} data-ripple className={cx('rk-filter-chip', className)} />
  )
}
