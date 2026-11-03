import { Popover as BasePopover } from '@base-ui/react/popover'
import type { ComponentProps } from 'react'
import { cx } from '../cx'

export interface PopoverPopupProps
  extends Omit<ComponentProps<typeof BasePopover.Popup>, 'className'> {
  className?: string
}

/** 组合 Portal > Positioner(sideOffset 8) > Popup：视觉类落在 Popup 上。 */
function PopoverPopup({ className, children, ...props }: PopoverPopupProps) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner sideOffset={8} className="rk-popover__positioner">
        <BasePopover.Popup
          {...props}
          className={cx('rk-popover', className)}
          data-glass="panel"
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  )
}

export interface PopoverTitleProps
  extends Omit<ComponentProps<typeof BasePopover.Title>, 'className'> {
  className?: string
}

function PopoverTitle({ className, ...props }: PopoverTitleProps) {
  return (
    <BasePopover.Title {...props} className={cx('rk-popover__title', className)} />
  )
}

export interface PopoverDescriptionProps
  extends Omit<ComponentProps<typeof BasePopover.Description>, 'className'> {
  className?: string
}

function PopoverDescription({ className, ...props }: PopoverDescriptionProps) {
  return (
    <BasePopover.Description
      {...props}
      className={cx('rk-popover__description', className)}
    />
  )
}

export interface PopoverCloseProps
  extends Omit<ComponentProps<typeof BasePopover.Close>, 'className'> {
  className?: string
}

/** 无默认视觉；配合 <Button render={<Popover.Close />} /> 或自行加类。 */
function PopoverClose({ className, ...props }: PopoverCloseProps) {
  return <BasePopover.Close {...props} className={className} />
}

export const Popover = {
  Root: BasePopover.Root,
  Trigger: BasePopover.Trigger,
  Popup: PopoverPopup,
  Title: PopoverTitle,
  Description: PopoverDescription,
  Close: PopoverClose,
}
