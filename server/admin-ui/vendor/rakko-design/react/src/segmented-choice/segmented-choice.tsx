import { RadioGroup } from '@base-ui/react/radio-group'
import type { RadioGroupProps } from '@base-ui/react/radio-group'
import { Radio } from '@base-ui/react/radio'
import type { RadioRootProps } from '@base-ui/react/radio'
import { cx } from '../cx'

/** 分组必须携带可访问名称：aria-label 或 aria-labelledby 二选一。 */
type RadioGroupAria =
  | { 'aria-label': string }
  | { 'aria-labelledby': string }

export type SegmentedChoiceRootProps = Omit<
  RadioGroupProps<string>,
  'className'
> &
  RadioGroupAria & { className?: string }

/**
 * 互斥分段选择：radiogroup / radio 语义（Base UI 保留隐藏原生 input 供表单提交），
 * 方向键在分段间移动并选中（motion.md）。
 */
function SegmentedChoiceRoot({
  className,
  ...props
}: SegmentedChoiceRootProps) {
  return <RadioGroup {...props} className={cx('rk-segments', className)} />
}

export interface SegmentedChoiceItemProps
  extends Omit<RadioRootProps<string>, 'className'> {
  className?: string
}

function SegmentedChoiceItem({
  className,
  children,
  ...props
}: SegmentedChoiceItemProps) {
  return (
    <Radio.Root {...props} data-ripple className={cx('rk-segment', className)}>
      {children}
    </Radio.Root>
  )
}

export const SegmentedChoice = {
  Root: SegmentedChoiceRoot,
  Item: SegmentedChoiceItem,
}
