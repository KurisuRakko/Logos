import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox'
import type { ComponentProps } from 'react'
import { cx } from '../cx'

export interface CheckboxRootProps
  extends Omit<ComponentProps<typeof BaseCheckbox.Root>, 'className'> {
  className?: string
}

/**
 * rk-checkbox：18px 方形勾选控件；center ripple；Base UI 保留隐藏原生 input。
 * checked / indeterminate 状态分别用 [data-checked] / [data-indeterminate] 表达。
 */
function CheckboxRoot({ className, children, ...props }: CheckboxRootProps) {
  return (
    <BaseCheckbox.Root
      {...props}
      data-ripple
      data-ripple-centered
      className={cx('rk-checkbox', className)}
    >
      {children}
    </BaseCheckbox.Root>
  )
}

export interface CheckboxIndicatorProps
  extends Omit<ComponentProps<typeof BaseCheckbox.Indicator>, 'className'> {
  className?: string
}

/**
 * 勾选指示：默认渲染一个内联勾 SVG（12px 视口 16）；调用方传 children 可覆盖
 * （例如 indeterminate 状态改用横线图形）。
 */
function CheckboxIndicator({
  className,
  children,
  ...props
}: CheckboxIndicatorProps) {
  return (
    <BaseCheckbox.Indicator
      {...props}
      className={cx('rk-checkbox__indicator', className)}
    >
      {children ?? (
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </BaseCheckbox.Indicator>
  )
}

export const Checkbox = {
  Root: CheckboxRoot,
  Indicator: CheckboxIndicator,
}
