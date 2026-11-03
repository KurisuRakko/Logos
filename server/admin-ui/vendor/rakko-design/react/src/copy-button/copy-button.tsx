import { useCallback, useEffect, useRef, useState } from 'react'
import { IconButton } from '../button/button'
import type { IconButtonProps } from '../button/button'
import { cx } from '../cx'
import { COPY_FEEDBACK_MS } from '../motion'

export interface CopyButtonProps
  extends Omit<
    IconButtonProps,
    'onClick' | 'pressed' | 'children' | 'aria-label' | 'className'
  > {
  /** 要复制的内容；函数形式在点击时求值。 */
  text: string | (() => string)
  /** 默认态的可访问名称。 */
  'aria-label': string
  /** 成功态的可访问名称（例如「已复制」）。 */
  copiedLabel: string
  onCopied?: () => void
  onCopyError?: (error: unknown) => void
  className?: string
}

const ICON_PATH = (
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>
)

const CHECK_PATH = (
  <>
    <circle cx="12" cy="12" r="9" />
    <path pathLength={1} d="m8 12.5 2.8 2.8L16.5 9.5" />
  </>
)

/**
 * 复制按钮：只有 navigator.clipboard.writeText resolve（真正成功）才进入成功态，
 * 保持 COPY_FEEDBACK_MS 后恢复；失败一律交给 onCopyError，不做旧式降级复制
 * （无法确认真正写入剪贴板）。成功态期间再次点击会重新复制并重置计时。
 */
export function CopyButton({
  text,
  'aria-label': label,
  copiedLabel,
  onCopied,
  onCopyError,
  className,
  ...rest
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current)
      }
    }
  }, [])

  const handleClick = useCallback(async () => {
    const content = typeof text === 'function' ? text() : text
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      onCopyError?.(new Error('Clipboard API unavailable'))
      return
    }
    try {
      await navigator.clipboard.writeText(content)
      // resolve 才算成功
      setCopied(true)
      onCopied?.()
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current)
      }
      resetTimer.current = window.setTimeout(() => {
        setCopied(false)
        resetTimer.current = null
      }, COPY_FEEDBACK_MS)
    } catch (error) {
      onCopyError?.(error)
    }
  }, [onCopied, onCopyError, text])

  return (
    <IconButton
      {...rest}
      aria-label={copied ? copiedLabel : label}
      data-copied={copied || undefined}
      className={cx('rk-copy-button', className)}
      onClick={() => {
        void handleClick()
      }}
    >
      <span className="rk-copy-button__icon" aria-hidden="true">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {ICON_PATH}
        </svg>
      </span>
      <span className="rk-copy-button__check" aria-hidden="true">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {CHECK_PATH}
        </svg>
      </span>
    </IconButton>
  )
}
