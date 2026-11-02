import { useCallback, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { cx } from '../cx'

export interface SearchFieldProps
  extends Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type' | 'className'> {
  /** 输入框里的原始文字（受控）；防抖由调用方做。 */
  value: string
  onValueChange: (value: string) => void
  /** input 的可访问名称；不传 placeholder 时也作占位文字。 */
  label: string
  /** 清除按钮的可访问名称。 */
  clearLabel: string
  /** 取消按钮文字；不传就不渲染取消按钮。 */
  cancelLabel?: string
  onCancel?: () => void
  /** 加在根 form 上。 */
  className?: string
}

/**
 * iOS 式搜索框：圆角灰底、放大镜、有内容时的清除键；聚焦或有内容时（data-active）
 * 右侧滑出「取消」。受控组件，可见文案全部由调用方传入；布局（宽度、外边距）归调用方。
 */
export function SearchField({
  value,
  onValueChange,
  label,
  clearLabel,
  cancelLabel,
  onCancel,
  className,
  placeholder,
  ref,
  onFocus,
  onBlur,
  onKeyDown,
  ...rest
}: SearchFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [focused, setFocused] = useState(false)
  const active = focused || value !== ''

  // 内部要拿 input 做 focus / blur，同时把节点交给调用方的 ref。
  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    },
    [ref],
  )

  return (
    <form
      role="search"
      className={cx('rk-search-field', className)}
      data-active={active ? '' : undefined}
      onSubmit={(event) => {
        event.preventDefault()
        inputRef.current?.blur()
      }}
    >
      <label className="rk-search-field__box">
        <SearchGlyph />
        <input
          {...rest}
          ref={setInputRef}
          className="rk-search-field__input"
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={placeholder ?? label}
          aria-label={label}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onFocus={(event) => {
            setFocused(true)
            onFocus?.(event)
          }}
          onBlur={(event) => {
            setFocused(false)
            onBlur?.(event)
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event)
            if (event.key === 'Escape') {
              onValueChange('')
              inputRef.current?.blur()
            }
          }}
        />
        {value ? (
          <button
            type="button"
            className="rk-search-field__clear"
            aria-label={clearLabel}
            // 不抢焦点：清除后继续输入
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              onValueChange('')
              inputRef.current?.focus()
            }}
          >
            <ClearGlyph />
          </button>
        ) : null}
      </label>
      {cancelLabel != null ? (
        <button
          type="button"
          className="rk-search-field__cancel"
          tabIndex={active ? 0 : -1}
          aria-hidden={active ? undefined : true}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            onValueChange('')
            inputRef.current?.blur()
            onCancel?.()
          }}
        >
          <span className="rk-search-field__cancel-label">{cancelLabel}</span>
        </button>
      ) : null}
    </form>
  )
}

/** 放大镜。 */
function SearchGlyph() {
  return (
    <svg
      className="rk-search-field__icon"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  )
}

/** 实心圆 + 镂空叉（iOS xmark.circle.fill）：evenodd 把叉挖空，透出底下任何底色。 */
function ClearGlyph() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20ZM16.11 14.69 14.69 16.11 12 13.41 9.31 16.11 7.89 14.69 10.59 12 7.89 9.31 9.31 7.89 12 10.59 14.69 7.89 16.11 9.31 13.41 12Z"
      />
    </svg>
  )
}
