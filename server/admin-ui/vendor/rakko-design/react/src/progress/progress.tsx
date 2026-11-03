import { Progress as BaseProgress } from '@base-ui/react/progress'
import type { ComponentProps } from 'react'
import { cx } from '../cx'

export interface ProgressRootProps
  extends Omit<ComponentProps<typeof BaseProgress.Root>, 'className'> {
  className?: string
}

/**
 * rk-progress：只用于可检测的真实进度，value 必须是 0–100 或 null（indeterminate）；
 * 不做装饰用途（motion.md / components.md）。
 */
function ProgressRoot({ className, ...props }: ProgressRootProps) {
  return <BaseProgress.Root {...props} className={cx('rk-progress', className)} />
}

export interface ProgressLabelProps
  extends Omit<ComponentProps<typeof BaseProgress.Label>, 'className'> {
  className?: string
}

function ProgressLabel({ className, ...props }: ProgressLabelProps) {
  return (
    <BaseProgress.Label {...props} className={cx('rk-progress__label', className)} />
  )
}

export interface ProgressValueProps
  extends Omit<ComponentProps<typeof BaseProgress.Value>, 'className'> {
  className?: string
}

function ProgressValue({ className, ...props }: ProgressValueProps) {
  return (
    <BaseProgress.Value
      {...props}
      className={cx('rk-progress__value', className)}
    />
  )
}

export interface ProgressTrackProps
  extends Omit<ComponentProps<typeof BaseProgress.Track>, 'className'> {
  className?: string
}

function ProgressTrack({ className, ...props }: ProgressTrackProps) {
  return (
    <BaseProgress.Track {...props} className={cx('rk-progress__track', className)} />
  )
}

export interface ProgressIndicatorProps
  extends Omit<ComponentProps<typeof BaseProgress.Indicator>, 'className'> {
  className?: string
}

function ProgressIndicator({ className, ...props }: ProgressIndicatorProps) {
  return (
    <BaseProgress.Indicator
      {...props}
      className={cx('rk-progress__indicator', className)}
    />
  )
}

export const Progress = {
  Root: ProgressRoot,
  Label: ProgressLabel,
  Value: ProgressValue,
  Track: ProgressTrack,
  Indicator: ProgressIndicator,
}
