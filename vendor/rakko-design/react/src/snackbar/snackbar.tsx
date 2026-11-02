import { Toast } from '@base-ui/react/toast'
import type { ComponentProps } from 'react'
import { cx } from '../cx'
import { SNACKBAR_TIMEOUT_MS } from '../motion'
import { useViewportTracking } from '../viewport/viewport'

export interface SnackbarProviderProps
  extends ComponentProps<typeof Toast.Provider> {}

/**
 * Snackbar 全局 provider：一次只显示一条（limit=1），4 秒自动关闭
 * （motion.md），hover / focus 时 Base UI 暂停计时；均可被调用方覆盖。
 * 挂载期间安装可见区追踪：iOS 键盘弹出时 Viewport 抬到键盘之上（snackbar.css）。
 */
function SnackbarProvider({
  limit = 1,
  timeout = SNACKBAR_TIMEOUT_MS,
  ...props
}: SnackbarProviderProps) {
  useViewportTracking()
  return <Toast.Provider {...props} limit={limit} timeout={timeout} />
}

export interface SnackbarViewportProps
  extends Omit<ComponentProps<typeof Toast.Viewport>, 'className'> {
  className?: string
}

/** 视口固定于视口底部居中；hover / focus 暂停由 Base UI 在此元素上监听。 */
function SnackbarViewport({ className, ...props }: SnackbarViewportProps) {
  return (
    <Toast.Viewport
      {...props}
      className={cx('rk-snackbar-viewport', className)}
    />
  )
}

export interface SnackbarRootProps
  extends Omit<ComponentProps<typeof Toast.Root>, 'className'> {
  className?: string
}

/** 单条 snackbar；必传 Base UI 的 toast 对象（来自 useSnackbar().toasts）。 */
function SnackbarRoot({ className, ...props }: SnackbarRootProps) {
  return (
    <Toast.Root
      {...props}
      className={cx('rk-snackbar', className)}
      data-glass="inverse"
    />
  )
}

export interface SnackbarTitleProps
  extends Omit<ComponentProps<typeof Toast.Title>, 'className'> {
  className?: string
}

function SnackbarTitle({ className, ...props }: SnackbarTitleProps) {
  return (
    <Toast.Title {...props} className={cx('rk-snackbar__title', className)} />
  )
}

export interface SnackbarActionProps
  extends Omit<ComponentProps<typeof Toast.Action>, 'className'> {
  className?: string
}

function SnackbarAction({ className, ...props }: SnackbarActionProps) {
  return (
    <Toast.Action
      {...props}
      data-ripple
      className={cx('rk-snackbar__action', className)}
    />
  )
}

export interface SnackbarCloseProps
  extends Omit<ComponentProps<typeof Toast.Close>, 'className'> {
  className?: string
}

/** 无默认视觉；配合 <Button render={<Snackbar.Close />} /> 或自行加类。 */
function SnackbarClose({ className, ...props }: SnackbarCloseProps) {
  return <Toast.Close {...props} className={className} />
}

export const Snackbar = {
  Provider: SnackbarProvider,
  Viewport: SnackbarViewport,
  Root: SnackbarRoot,
  Title: SnackbarTitle,
  Action: SnackbarAction,
  Close: SnackbarClose,
}

/** Base UI Toast.useToastManager 的再导出：{ toasts, add, close, update, ... }。 */
export const useSnackbar = Toast.useToastManager
