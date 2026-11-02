import { useEffect, useState } from 'react'
import type { ComponentProps, CSSProperties } from 'react'
import { cx } from '../cx'
import { useMergedRefs } from '../merge-refs'
import { useNavigationLayer } from '../navigation-stack/layers'
import type { NavigationLayer } from '../navigation-stack/layers'

export type TopBarReveal = 'scroll' | 'always'

export interface TopBarRootProps extends ComponentProps<'header'> {
  /**
   * 'scroll'：页面顶部透明，滚动 revealDistance 像素内渐显为毛玻璃；'always'：常显。
   * @default 'scroll'
   */
  reveal?: TopBarReveal
  /** reveal="scroll" 时的渐显距离（px），写入 --rk-glass-reveal 供 animation-range 使用。 */
  revealDistance?: number
}

/**
 * 与 scroll(nearest) 同一个时间轴：最近的滚动容器祖先；到根都没有就是视口（返回 null，用 window）。
 * 导航栈的层（.rk-nav-layer）在 pending / moving 时是 overflow: hidden 的固定层，不算——
 * 顶层时它就是普通文档流，页面用 window 滚动。
 */
function nearestScroller(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node === document.body || node === document.documentElement) return null
    if (node.classList.contains('rk-nav-layer')) return null
    const { overflowY } = getComputedStyle(node)
    if (overflowY && overflowY !== 'visible' && overflowY !== 'clip') return node
  }
  return null
}

function windowScrollable(): boolean {
  const root = document.scrollingElement ?? document.documentElement
  return root.scrollHeight - window.innerHeight > 0
}

/**
 * 滚动渐显顶栏的「到顶」状态：滚动位置 ≤ 0，或页面根本滚不动。
 * scroll(nearest) 时间轴在容器不可滚动时无效，动画不生效，材质与发丝线会一直显示；
 * 栏上的 data-at-top 让 glass.css 把它压回透明（层保持常驻，只是 blur(0) 与透明底）。
 * 在导航栈里按本层自己的滚动位置算：不在顶层时 window 的滚动不属于这一页，不理；
 * 回到顶层（滚动已恢复）时层句柄会通知，立即重算。
 */
function useAtTop(el: HTMLElement | null, enabled: boolean, layer: NavigationLayer): boolean {
  const [atTop, setAtTop] = useState(() => typeof window === 'undefined' || layer.scrollY() <= 0)
  useEffect(() => {
    if (!enabled || !el) return
    const scroller = nearestScroller(el)
    const update = () => {
      if (!layer.isTop()) return
      if (scroller) setAtTop(scroller.scrollTop <= 0 || scroller.scrollHeight <= scroller.clientHeight)
      else setAtTop(layer.scrollY() <= 0 || !windowScrollable())
    }
    update()
    const off = layer.subscribe(update)
    const target: HTMLElement | Window = scroller ?? window
    target.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      off()
      target.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [el, enabled, layer])
  return atTop
}

/**
 * 毛玻璃顶栏 Root：sticky 顶层条，材质与滚动渐显由 glass.css 的
 * data-glass="chrome" 提供（渐显只改模糊半径与底色 alpha，不用 opacity 淡入）。
 * reveal="scroll" 时另写 data-at-top（见 useAtTop），页面不够长时也保持透明。
 */
function TopBarRoot({
  reveal = 'scroll',
  revealDistance = 120,
  className,
  style,
  ref,
  ...props
}: TopBarRootProps) {
  const layer = useNavigationLayer()
  const [el, setEl] = useState<HTMLElement | null>(null)
  const mergedRef = useMergedRefs<HTMLElement>(setEl, ref)
  const atTop = useAtTop(el, reveal === 'scroll', layer)
  return (
    <header
      {...props}
      ref={mergedRef}
      className={cx('rk-top-bar', className)}
      data-glass="chrome"
      data-reveal={reveal}
      data-at-top={reveal === 'scroll' && atTop ? '' : undefined}
      style={
        {
          ...style,
          '--rk-glass-reveal': `${revealDistance}px`,
        } as CSSProperties
      }
    />
  )
}

export interface TopBarTitleProps extends ComponentProps<'div'> {}

/** 顶栏标题：单行省略，超长截断。 */
function TopBarTitle({ className, ...props }: TopBarTitleProps) {
  return <div {...props} className={cx('rk-top-bar__title', className)} />
}

export interface TopBarActionsProps extends ComponentProps<'div'> {}

/** 顶栏动作区：role="group"，靠右排列，accessible name 由调用方传 aria-label。 */
function TopBarActions({ className, ...props }: TopBarActionsProps) {
  return <div {...props} role="group" className={cx('rk-top-bar__actions', className)} />
}

export const TopBar = {
  Root: TopBarRoot,
  Title: TopBarTitle,
  Actions: TopBarActions,
}
