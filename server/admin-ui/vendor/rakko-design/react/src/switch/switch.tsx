import { Switch as BaseSwitch } from '@base-ui/react/switch'
import type { ComponentProps } from 'react'
import { cx } from '../cx.js'

export interface SwitchRootProps
  extends Omit<ComponentProps<typeof BaseSwitch.Root>, 'className'> {
  className?: string
}

/**
 * rk-switch：48×32 热区控件（移植 .motion-switch__control），中心 ripple。
 * Root 内部渲染 34×14 轨道；调用方继续放 <Switch.Thumb />。
 * Base UI 保留隐藏的原生 checkbox input，供表单提交与 label 关联。
 */
function SwitchRoot({ className, children, ...props }: SwitchRootProps) {
  return (
    <BaseSwitch.Root
      {...props}
      data-ripple
      data-ripple-centered
      className={cx('rk-switch', className)}
    >
      <span className="rk-switch__track" aria-hidden="true" />
      {children}
    </BaseSwitch.Root>
  )
}

export interface SwitchThumbProps
  extends Omit<ComponentProps<typeof BaseSwitch.Thumb>, 'className'> {
  className?: string
}

function SwitchThumb({ className, ...props }: SwitchThumbProps) {
  return (
    <BaseSwitch.Thumb {...props} className={cx('rk-switch__thumb', className)} />
  )
}

export const Switch = {
  Root: SwitchRoot,
  Thumb: SwitchThumb,
}
