import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { ComponentProps } from 'react'
import { cx } from '../cx.js'
import { useViewportTracking } from '../viewport/viewport.js'

export interface DialogPopupProps
  extends Omit<ComponentProps<typeof BaseDialog.Popup>, 'className'> {
  className?: string
}

/** 渲染在 Popup 内：弹层挂载期间安装可见区追踪（键盘避让，见 viewport.ts）。 */
function ViewportTracking() {
  useViewportTracking()
  return null
}

/**
 * 组合 Portal > Backdrop + Popup：视觉移植 showcase Modal.tsx 的 scrim/panel。
 * 在 iOS 可见区内居中，键盘弹出时跟着上移（dialog.css 消费 --rk-visual-*）。
 */
function DialogPopup({ className, children, ...props }: DialogPopupProps) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="rk-dialog__backdrop" />
      {/* Base UI 1.8 用 inert 实现模态而不渲染 aria-modal；契约语义要求补上该属性。 */}
      <BaseDialog.Popup
        aria-modal="true"
        {...props}
        className={cx('rk-dialog', className)}
        data-glass="panel"
      >
        <ViewportTracking />
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  )
}

export interface DialogTitleProps
  extends Omit<ComponentProps<typeof BaseDialog.Title>, 'className'> {
  className?: string
}

function DialogTitle({ className, ...props }: DialogTitleProps) {
  return <BaseDialog.Title {...props} className={cx('rk-dialog__title', className)} />
}

export interface DialogDescriptionProps
  extends Omit<ComponentProps<typeof BaseDialog.Description>, 'className'> {
  className?: string
}

function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return (
    <BaseDialog.Description
      {...props}
      className={cx('rk-dialog__description', className)}
    />
  )
}

export interface DialogCloseProps
  extends Omit<ComponentProps<typeof BaseDialog.Close>, 'className'> {
  className?: string
}

/** 无默认视觉；配合 <Button render={<Dialog.Close />} /> 或自行加类。 */
function DialogClose({ className, ...props }: DialogCloseProps) {
  return <BaseDialog.Close {...props} className={className} />
}

export const Dialog = {
  Root: BaseDialog.Root,
  Trigger: BaseDialog.Trigger,
  Popup: DialogPopup,
  Title: DialogTitle,
  Description: DialogDescription,
  Close: DialogClose,
}
