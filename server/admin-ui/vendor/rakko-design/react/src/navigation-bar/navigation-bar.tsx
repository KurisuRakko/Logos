import { useEffect, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { Button } from '../button/button.js'
import type { ButtonProps } from '../button/button.js'
import { cx } from '../cx.js'
import { useMergedRefs } from '../merge-refs.js'
import { useNavigationLayer } from '../navigation-stack/layers.js'
import { useSlotCrossfade } from '../slot-crossfade/slot-crossfade.js'
import { TopBar } from '../top-bar/top-bar.js'
import type { TopBarReveal } from '../top-bar/top-bar.js'

export type NavigationBarTitleDisplay = 'large' | 'inline'

export interface NavigationBarProps
  extends Omit<ComponentProps<'header'>, 'title' | 'children'> {
  /** 页面标题。inline 时居中显示在栏里；large 时渲染为栏下方的 <h1>，滚出后栏里淡入小标题。 */
  title?: ReactNode
  /** @default 'inline' */
  titleDisplay?: NavigationBarTitleDisplay
  /** 左侧，通常是 NavigationBar.Back。 */
  leading?: ReactNode
  /** 右侧动作区（plain 的 IconButton / Button、Menu.Trigger 等）。 */
  actions?: ReactNode
  /** 动作区 role="group" 的可访问名称。 */
  actionsLabel?: string
  /**
   * 'scroll'：页面在顶部（含不可滚动）时透明，滚动后渐显为毛玻璃；'always'：常显。
   * @default 'scroll'
   */
  reveal?: TopBarReveal
  /**
   * large 模式下强制收起（true）或展开（false）大标题；不传时同一导航层里有激活的 SearchField 就自动收起。
   * 收起期间栏里的小标题也不显示（大标题是被折叠的，不是滚走的）。
   */
  largeTitleCollapsed?: boolean
}

/** 栏内容高度（px），不含顶部安全区。 */
export const NAVIGATION_BAR_HEIGHT = 44

/**
 * iOS 式导航栏：基于 TopBar.Root（sticky + data-glass="chrome" 滚动渐显、到顶透明），
 * 44px + 顶部安全区，三栏 1fr / max-content / 1fr，小标题居中不受两侧宽度影响。
 *
 * large 模式：栏下方渲染页面的 <h1>，随内容滚动。用 IntersectionObserver 看它是否已整个滚进栏底下：
 * 滚出前栏里的小标题隐藏，滚出后淡入（带几 px 上移）。「滚出」按大标题自身的位置判断，不看它是否可见：
 * 搜索折叠时大标题被裁掉但没滚走，小标题不跟着出来；取消搜索、大标题展开的整个过程里小标题一直隐藏，
 * 不会与大标题叠在一起。
 * 小标题与大标题都按本页自己的滚动位置算（导航层句柄）：页面在导航栈下层或转场中时观察结果一律不理，
 * 回到顶层、滚动恢复后立即重算。
 *
 * 左右两区同一页里换内容（编辑态、选择模式）时交叉淡化 + 小位移弹簧（useSlotCrossfade），调用方不用管；
 * 小标题自己有滚出淡入的过渡，不参与。
 *
 * 属性契约（导航栈转场时的栏克隆）：栏根 data-rk-nav-bar="top"，部件 data-rk-nav-part="leading" | "title" | "actions"，
 * 到顶透明的 data-at-top 由 TopBar 写。
 */
function NavigationBarRoot({
  title,
  titleDisplay = 'inline',
  leading,
  actions,
  actionsLabel,
  reveal = 'scroll',
  largeTitleCollapsed,
  className,
  ref,
  ...props
}: NavigationBarProps) {
  const large = titleDisplay === 'large'
  const layer = useNavigationLayer()
  const barRef = useRef<HTMLElement>(null)
  const mergedRef = useMergedRefs<HTMLElement>(barRef, ref)
  const largeRef = useRef<HTMLHeadingElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const leadingRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  useSlotCrossfade(leadingRef)
  useSlotCrossfade(actionsRef)
  // 大标题完全滚进栏底下 = scrolledPast；inline 时恒为 true（小标题常显）
  const [scrolledPast, setScrolledPast] = useState(!large)

  useEffect(() => {
    const bar = barRef.current
    const heading = largeRef.current
    const wrap = wrapRef.current
    if (!large || !bar || !heading || !wrap) {
      setScrolledPast(!large)
      return
    }
    const measure = () => {
      if (layer.isTop()) setScrolledPast(heading.getBoundingClientRect().bottom <= bar.offsetHeight)
    }
    measure()
    const off = layer.subscribe(measure)
    // 折叠 / 展开结束时补量一次：搜索期间滚动过，展开后大标题可能已在栏底下，而观察器不一定再回调
    wrap.addEventListener('transitionend', measure)
    const cleanup = () => {
      off()
      wrap.removeEventListener('transitionend', measure)
    }
    if (typeof IntersectionObserver !== 'function') return cleanup
    // 观察器只用来在穿过栏底边时唤醒；判断用大标题自身的矩形（不含祖先裁剪），搜索折叠不算滚出。
    // rootMargin 是建观察器那一刻的栏高：栏高之后变了（样式晚到、安全区变化）要按新高度重建，
    // 否则阈值线停在旧位置，大标题滚过真正的栏底边时观察器不回调（WebKit 开发模式下实测过 95px → 44px）。
    let observer: IntersectionObserver | null = null
    let observedHeight = -1
    const observe = () => {
      const height = bar.offsetHeight
      if (height === observedHeight) return
      observedHeight = height
      observer?.disconnect()
      observer = new IntersectionObserver(
        ([entry]) => {
          if (entry && layer.isTop()) setScrolledPast(entry.boundingClientRect.bottom <= bar.offsetHeight)
        },
        { rootMargin: `-${height}px 0px 0px 0px`, threshold: 0 },
      )
      observer.observe(heading)
    }
    observe()
    const resize =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            observe()
            measure()
          })
        : null
    resize?.observe(bar)
    return () => {
      cleanup()
      resize?.disconnect()
      observer?.disconnect()
    }
  }, [large, layer])

  // auto：交给 CSS 按同一导航层里的 SearchField[data-active] 决定；显式值覆盖
  const collapse = largeTitleCollapsed === undefined ? 'auto' : largeTitleCollapsed ? 'collapsed' : 'expanded'

  return (
    <>
      <TopBar.Root
        {...props}
        ref={mergedRef}
        className={cx('rk-navigation-bar', className)}
        reveal={reveal}
        revealDistance={large ? NAVIGATION_BAR_HEIGHT : 12}
        data-rk-nav-bar="top"
        data-title-display={titleDisplay}
        data-collapse={large ? collapse : undefined}
      >
        <div className="rk-navigation-bar__inner">
          <div ref={leadingRef} className="rk-navigation-bar__leading" data-rk-nav-part="leading">
            {leading}
          </div>
          <TopBar.Title
            className="rk-navigation-bar__title"
            data-rk-nav-part="title"
            data-visible={scrolledPast ? '' : undefined}
            aria-hidden={large ? true : undefined}
          >
            {title}
          </TopBar.Title>
          {actions != null ? (
            <TopBar.Actions
              ref={actionsRef}
              className="rk-navigation-bar__actions"
              data-rk-nav-part="actions"
              aria-label={actionsLabel}
            >
              {actions}
            </TopBar.Actions>
          ) : (
            <div ref={actionsRef} className="rk-navigation-bar__actions" data-rk-nav-part="actions" />
          )}
        </div>
      </TopBar.Root>
      {large ? (
        // 外两层是折叠大标题用的（grid 0fr ↔ 1fr，见 navigation-bar.css）
        <div ref={wrapRef} className="rk-navigation-bar__large-title-wrap" data-collapse={collapse}>
          <div className="rk-navigation-bar__large-title-clip">
            <h1 ref={largeRef} className="rk-navigation-bar__large-title">
              {title}
            </h1>
          </div>
        </div>
      ) : null}
    </>
  )
}

function ChevronLeftIcon() {
  return (
    <svg
      className="rk-navigation-bar__chevron"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15 4.5L7.5 12l7.5 7.5" />
    </svg>
  )
}

type BackBaseProps = Omit<ButtonProps, 'variant' | 'icon' | 'children' | 'aria-label'>

/** 文字是上一页的标题（过长省略）；只有图标时必须给 aria-label。 */
export type NavigationBarBackProps = BackBaseProps &
  (
    | { children: ReactNode; 'aria-label'?: string }
    | { children?: undefined; 'aria-label': string }
  )

/** 返回键：plain 按钮 + 内置左 chevron，文字是上一页的标题。 */
function NavigationBarBack({ className, children, ...props }: NavigationBarBackProps) {
  return (
    <Button
      {...props}
      variant="plain"
      icon={<ChevronLeftIcon />}
      className={cx('rk-navigation-bar__back', children == null && 'rk-navigation-bar__back--icon', className)}
    >
      {children}
    </Button>
  )
}

export const NavigationBar = Object.assign(NavigationBarRoot, { Back: NavigationBarBack })
