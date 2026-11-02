import { Drawer } from '@base-ui/react/drawer'
import type { ComponentProps } from 'react'
import { cx } from '../cx'
import { useViewportTracking } from '../viewport/viewport'

export interface SheetRootProps extends ComponentProps<typeof Drawer.Root> {}

/**
 * 抽屉 Root：默认底部抽屉、下滑关闭（swipeDirection="down"）。
 * swipeDirection="right" 变成右侧抽屉：贴右全高、从右滑入、右滑关闭（样式见 sheet.css）。
 * 真实应用保持默认 modal；内嵌演示场景传 modal={false} 以免锁定整页滚动。
 * 注意：Base UI Drawer.Root 不渲染 DOM（无 className）。
 */
function SheetRoot({ swipeDirection = 'down', ...props }: SheetRootProps) {
  return <Drawer.Root {...props} swipeDirection={swipeDirection} />
}

export interface SheetPopupProps {
  className?: string
  /** Portal 的挂载容器；缺省挂到 body。 */
  container?: ComponentProps<typeof Drawer.Portal>['container']
  children: React.ReactNode
}

/** 渲染在 Popup 内：弹层挂载期间安装可见区追踪（键盘避让，见 viewport.ts）。 */
function ViewportTracking() {
  useViewportTracking()
  return null
}

/**
 * 组合 Portal > Backdrop + Viewport > Popup > Content。
 * backdrop 视觉与滑动进度、viewport 定位都在 rk-sheet.css 完成；
 * viewport 底边贴 iOS 键盘上沿（消费 --rk-visual-top / --rk-keyboard-inset）。
 */
function SheetPopup({ className, container, children }: SheetPopupProps) {
  return (
    <Drawer.Portal container={container}>
      <Drawer.Backdrop className="rk-sheet__backdrop" />
      <Drawer.Viewport className="rk-sheet__viewport">
        <Drawer.Popup
          className={cx('rk-sheet', className)}
          data-glass="panel"
        >
          <ViewportTracking />
          <Drawer.Content className="rk-sheet__content">
            {children}
          </Drawer.Content>
        </Drawer.Popup>
      </Drawer.Viewport>
    </Drawer.Portal>
  )
}

export interface SheetHandleProps {
  className?: string
}

/**
 * 抓手：Base UI Drawer.Handle 是命令式 handle（关联 detached trigger），
 * 不是可渲染组件，这里渲染纯视觉抓手。
 */
function SheetHandle({ className }: SheetHandleProps) {
  return <div className={cx('rk-sheet__handle', className)} aria-hidden="true" />
}

export interface SheetTitleProps
  extends Omit<ComponentProps<typeof Drawer.Title>, 'className'> {
  className?: string
}

function SheetTitle({ className, ...props }: SheetTitleProps) {
  return (
    <Drawer.Title {...props} className={cx('rk-sheet__title', className)} />
  )
}

export interface SheetDescriptionProps
  extends Omit<ComponentProps<typeof Drawer.Description>, 'className'> {
  className?: string
}

function SheetDescription({ className, ...props }: SheetDescriptionProps) {
  return (
    <Drawer.Description
      {...props}
      className={cx('rk-sheet__description', className)}
    />
  )
}

export interface SheetCloseProps
  extends Omit<ComponentProps<typeof Drawer.Close>, 'className'> {
  className?: string
}

/** 无默认视觉；配合 <Button render={<Sheet.Close />} /> 或自行加类。 */
function SheetClose({ className, ...props }: SheetCloseProps) {
  return <Drawer.Close {...props} className={className} />
}

export const Sheet = {
  Root: SheetRoot,
  Trigger: Drawer.Trigger,
  Popup: SheetPopup,
  Handle: SheetHandle,
  Title: SheetTitle,
  Description: SheetDescription,
  Close: SheetClose,
}
