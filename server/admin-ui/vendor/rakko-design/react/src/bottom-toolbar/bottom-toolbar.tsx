import { useRef } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { cx } from '../cx.js'
import { useSlotCrossfade } from '../slot-crossfade/slot-crossfade.js'

export interface BottomToolbarProps
  extends Omit<ComponentProps<'div'>, 'children' | 'role' | 'aria-label'> {
  /** 工具栏的可访问名称（必填，例如「备忘录工具栏」）。 */
  'aria-label': string
  /** 左侧（plain 的 IconButton / Button）。 */
  start?: ReactNode
  /** 中间：状态文字（「共 23 条」），小号次要字、单行省略。 */
  center?: ReactNode
  /** 右侧。 */
  end?: ReactNode
}

/** 工具栏内容高度（px），不含底部安全区。CSS 里页面留底用 var(--rk-bottom-toolbar-space)。 */
export const BOTTOM_TOOLBAR_HEIGHT = 49

/**
 * iOS 式底部工具栏：固定贴底，data-glass="chrome" 常显（不做滚动渐显），发丝线翻到顶边；
 * 49px + 底部安全区，三栏 start / center / end。放当前页的操作；标签栏用 BottomNav。
 *
 * 根元素 role="group" 而不是 role="toolbar"：toolbar 按 APG 要求方向键在按钮间漫游，这里不承诺。
 * 页面要给它让位：滚动内容底部留 var(--rk-bottom-toolbar-space)（= 49px + 底部安全区）。
 * Snackbar 会自动抬到它上方（snackbar.css，:has()）。
 * 同一页里三格换内容（进出选择模式等）时自动交叉淡化 + 小位移弹簧（useSlotCrossfade），调用方不用管。
 *
 * 注意：iOS 软键盘弹出时 position: fixed 仍贴着布局视口底部（被键盘挡住），
 * 要贴键盘的栏（编辑器辅助栏）请用 --rk-keyboard-inset 自己定位，不要复用这个组件。
 *
 * 属性契约（导航栈转场时的栏克隆）：根 data-rk-nav-bar="bottom"。
 */
export function BottomToolbar({ start, center, end, className, ...props }: BottomToolbarProps) {
  const startRef = useRef<HTMLDivElement>(null)
  const centerRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  useSlotCrossfade(startRef)
  useSlotCrossfade(centerRef)
  useSlotCrossfade(endRef)
  return (
    <div
      {...props}
      role="group"
      data-glass="chrome"
      data-rk-nav-bar="bottom"
      className={cx('rk-bottom-toolbar', className)}
    >
      <div className="rk-bottom-toolbar__inner">
        <div ref={startRef} className="rk-bottom-toolbar__start">
          {start}
        </div>
        <div ref={centerRef} className="rk-bottom-toolbar__center">
          {center}
        </div>
        <div ref={endRef} className="rk-bottom-toolbar__end">
          {end}
        </div>
      </div>
    </div>
  )
}
