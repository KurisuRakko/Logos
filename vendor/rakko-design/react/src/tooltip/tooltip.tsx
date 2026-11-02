import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import type { ComponentProps } from 'react'
import { cx } from '../cx.js'
import { MOTION } from '../motion.js'

export interface TooltipProviderProps
  extends ComponentProps<typeof BaseTooltip.Provider> {}

/**
 * 共享 tooltip 延迟：默认 MOTION.tooltipDelayMs（500ms，与 --motion-delay-tooltip 同步）。
 */
function TooltipProvider({
  delay = MOTION.tooltipDelayMs,
  ...props
}: TooltipProviderProps) {
  return <BaseTooltip.Provider {...props} delay={delay} />
}

export interface TooltipPopupProps
  extends Omit<ComponentProps<typeof BaseTooltip.Popup>, 'className'> {
  className?: string
  /** 浮层相对触发器的方位，默认 top（tooltip 在触发器上方）。 */
  side?: ComponentProps<typeof BaseTooltip.Positioner>['side']
  sideOffset?: ComponentProps<typeof BaseTooltip.Positioner>['sideOffset']
}

/**
 * 组合 Portal > Positioner(sideOffset 8) > Popup：视觉类 rk-tooltip 落在 Popup 上。
 */
function TooltipPopup({
  className,
  side = 'top',
  sideOffset = 8,
  children,
  ...props
}: TooltipPopupProps) {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner
        side={side}
        sideOffset={sideOffset}
        className="rk-tooltip__positioner"
      >
        <BaseTooltip.Popup
          {...props}
          role="tooltip"
          className={cx('rk-tooltip', className)}
        >
          {children}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  )
}

export const Tooltip = {
  Provider: TooltipProvider,
  Root: BaseTooltip.Root,
  Trigger: BaseTooltip.Trigger,
  Popup: TooltipPopup,
}
