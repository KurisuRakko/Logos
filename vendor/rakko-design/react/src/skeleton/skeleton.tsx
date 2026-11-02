import type { CSSProperties, ComponentProps } from 'react'
import { cx } from '../cx'

export type SkeletonVariant = 'text' | 'circle' | 'rect'

export interface SkeletonProps extends Omit<ComponentProps<'div'>, 'children'> {
  /** 形状：text 是一行或多行文字条，circle 是圆（头像位），rect 是圆角块（图片 / 卡片位）。默认 text。 */
  variant?: SkeletonVariant
  /** 宽度；数字按 px。text / rect 默认撑满，circle 默认 40px。 */
  width?: number | string
  /** 高度；数字按 px。text 默认一行字高，rect 默认 80px，circle 默认等于宽度。 */
  height?: number | string
  /** text 的行数，默认 1；多行时最后一行收窄到 60%。其他形状忽略。 */
  lines?: number
}

function toLength(value: number | string | undefined): string | undefined {
  return typeof value === 'number' ? `${value}px` : value
}

/**
 * rk-skeleton：加载占位。整体 aria-hidden，忙碌状态由调用方在真实容器上用 aria-busy 表达。
 * 微光是一条缓慢扫过的低对比渐变；prefers-reduced-motion 下静止。
 */
export function Skeleton({
  variant = 'text',
  width,
  height,
  lines = 1,
  className,
  style,
  ...props
}: SkeletonProps) {
  const sizeStyle: CSSProperties = {
    width: toLength(width),
    height: toLength(height),
  }

  if (variant === 'text') {
    const count = Math.max(1, Math.floor(lines))
    return (
      <div
        {...props}
        aria-hidden="true"
        className={cx('rk-skeleton-text', className)}
        style={{ width: sizeStyle.width, ...style }}
      >
        {Array.from({ length: count }, (_, index) => (
          <div
            key={index}
            className="rk-skeleton"
            data-variant="text"
            style={{ height: sizeStyle.height }}
          />
        ))}
      </div>
    )
  }

  if (variant === 'circle' && sizeStyle.height === undefined) {
    sizeStyle.height = sizeStyle.width
  }

  return (
    <div
      {...props}
      aria-hidden="true"
      className={cx('rk-skeleton', className)}
      data-variant={variant}
      style={{ ...sizeStyle, ...style }}
    />
  )
}
