import { useState } from 'react'
import type { ComponentProps } from 'react'
import { cx } from '../cx'

export type AvatarSize = 24 | 32 | 40 | 64 | 80

export interface AvatarProps extends Omit<ComponentProps<'span'>, 'children'> {
  /** 头像图片地址；不传或加载失败时显示 name 的首字。 */
  src?: string
  /** 图片与首字占位共用的可访问名称；不传时用 name。 */
  alt?: string
  /** 用户名，取首字作为占位：中文取第一个字，拉丁字母取首字母大写。 */
  name: string
  /** 直径（px），默认 40。 */
  size?: AvatarSize
}

/** 取第一个字符（按码点，emoji / 扩展区汉字不会被劈开）；拉丁字母转大写。 */
export function avatarInitial(name: string): string {
  const first = Array.from(name.trim())[0]
  return first ? first.toLocaleUpperCase() : ''
}

/**
 * rk-avatar：圆形头像。有 src 且加载成功时是 <img>；无 src 或 onError 后退回首字占位，
 * 占位整体是 role="img" + aria-label，首字本身 aria-hidden，读屏只读一次名字。
 */
export function Avatar({ src, alt, name, size = 40, className, ...props }: AvatarProps) {
  // 记下失败的是哪个地址：换图后自然重新尝试，不需要 effect 重置。
  const [failedSrc, setFailedSrc] = useState<string>()

  const label = alt ?? name
  const showImage = src != null && src !== '' && src !== failedSrc

  return (
    <span
      {...props}
      className={cx('rk-avatar', className)}
      data-size={size}
      role={showImage ? undefined : 'img'}
      aria-label={showImage ? undefined : label}
    >
      {showImage ? (
        <img
          className="rk-avatar__image"
          src={src}
          alt={label}
          draggable={false}
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <span className="rk-avatar__initial" aria-hidden="true">
          {avatarInitial(name)}
        </span>
      )}
    </span>
  )
}
