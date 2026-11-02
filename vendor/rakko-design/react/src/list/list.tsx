import { useContext, useId } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { cx } from '../cx'
import { ListGroupContext, SwipeRowContext } from './list-context'

export interface ListGroupProps extends Omit<ComponentProps<'section'>, 'children'> {
  /** 组标题：渲染为卡片上方的 <h2>，卡片 aria-labelledby 指向它。 */
  header?: ReactNode
  /** 卡片下方的说明文字。 */
  footer?: ReactNode
  /** 放在 AnimatedList 里时的 FLIP 标识（容器内唯一），写到根元素的 data-rk-flip-key。 */
  flipKey?: string
  children: ReactNode
}

/**
 * iOS inset grouped 列表的一组：卡片外上方小号标题 + 圆角卡片 + 可选说明。
 * 卡片承担 role="list"；行之间的分隔线由 list.css 统一绘制（含 SwipeRow 包着的行）。
 */
function ListGroup({ header, footer, flipKey, className, children, ...props }: ListGroupProps) {
  const headerId = useId()
  return (
    <section {...props} className={cx('rk-list-group', className)} data-rk-flip-key={flipKey}>
      {header != null ? (
        <h2 id={headerId} className="rk-list-group__header">
          {header}
        </h2>
      ) : null}
      <div
        className="rk-list-group__card"
        role="list"
        aria-labelledby={header != null ? headerId : undefined}
      >
        <ListGroupContext.Provider value={true}>{children}</ListGroupContext.Provider>
      </div>
      {footer != null ? <p className="rk-list-group__footer">{footer}</p> : null}
    </section>
  )
}

export interface ListRowProps extends Omit<ComponentProps<'div'>, 'children' | 'onClick'> {
  /** 行首图标位。 */
  leading?: ReactNode
  /** 右侧次要文字（数量、当前值）。 */
  detail?: ReactNode
  /** 行尾 ›，表示可进入下一层。 */
  chevron?: boolean
  /** 传入后整行可点（内部渲染撑满整行的 <button>）。 */
  onPress?: () => void
  /** 放在 AnimatedList 里时的 FLIP 标识（容器内唯一），写到根元素的 data-rk-flip-key。 */
  flipKey?: string
  /** 主内容：单行标题，或调用方自定义的多行内容。 */
  children: ReactNode
}

/**
 * 列表行：默认 role="listitem"；处在 SwipeRow 内容层里时不加（由 SwipeRow 根节点承担）。
 * 有 onPress 时 listitem 留在外层 div，可点表面是内层 button，按下高亮走 state-layer.css 的 data-ripple。
 */
function ListRow({
  leading,
  detail,
  chevron = false,
  onPress,
  flipKey,
  className,
  children,
  ...props
}: ListRowProps) {
  const inSwipeRow = useContext(SwipeRowContext)
  // 纯文本主内容按单行标题处理（超长省略）；自定义节点的排版交给调用方。
  const singleLine = typeof children === 'string' || typeof children === 'number'
  const content = (
    <>
      {leading != null ? <span className="rk-list-row__leading">{leading}</span> : null}
      <span className="rk-list-row__body" data-single-line={singleLine ? '' : undefined}>
        {children}
      </span>
      {detail != null ? <span className="rk-list-row__detail">{detail}</span> : null}
      {chevron ? <ChevronGlyph /> : null}
    </>
  )

  return (
    <div
      {...props}
      className={cx('rk-list-row', className)}
      role={inSwipeRow ? undefined : 'listitem'}
      data-leading={leading != null ? '' : undefined}
      data-pressable={onPress ? '' : undefined}
      data-rk-flip-key={flipKey}
    >
      {onPress ? (
        <button type="button" className="rk-list-row__surface" data-ripple onClick={onPress}>
          {content}
        </button>
      ) : (
        content
      )}
    </div>
  )
}

/** 行尾 ›（iOS chevron.right）。 */
function ChevronGlyph() {
  return (
    <svg
      className="rk-list-row__chevron"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

export const List = {
  Group: ListGroup,
  Row: ListRow,
}
