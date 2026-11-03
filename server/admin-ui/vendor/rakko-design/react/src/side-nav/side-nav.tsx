import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
} from 'react'
import type { ComponentProps, CSSProperties, ReactNode } from 'react'
import { IconButton } from '../button/button.js'
import type { IconButtonProps } from '../button/button.js'
import { cx } from '../cx.js'
import { Tabs } from '../tabs/tabs.js'
import type { TabsTabProps } from '../tabs/tabs.js'

/** 导航地标必须携带可访问名称：aria-label 或 aria-labelledby 二选一。 */
type SideNavAria = { 'aria-label': string } | { 'aria-labelledby': string }

interface SideNavContextValue {
  collapsed: boolean
  /** Provider 分配的 nav id；Root 的 id 与 Toggle 的 aria-controls 共用同一个值。 */
  navId: string
  setCollapsed: (collapsed: boolean) => void
}

const SideNavContext = createContext<SideNavContextValue | null>(null)

/** Root / Item / Toggle 都必须在 Provider 内：折叠状态与 aria-controls 的 id 都由它托管。 */
function useSideNavContext(component: string): SideNavContextValue {
  const context = useContext(SideNavContext)
  if (!context) {
    throw new Error(
      `${component} 必须放在 <SideNav.Provider> 内：折叠状态与 aria-controls 引用的 id 由 Provider 提供。`,
    )
  }
  return context
}

export interface SideNavProviderProps {
  children?: ReactNode
  /**
   * 受控折叠状态。传了它（含 false）就由调用方接管，组件不再自行改状态，
   * 只在 Toggle 点击时触发 onCollapsedChange。
   */
  collapsed?: boolean
  /**
   * 非受控初始折叠状态。
   * @default false
   */
  defaultCollapsed?: boolean
  /** 折叠状态变化回调；受控与非受控模式下都会触发。 */
  onCollapsedChange?: (collapsed: boolean) => void
}

/**
 * SideNav 的折叠状态与 id 提供者，本身不渲染 DOM。
 * 照 Base UI 的受控惯例：collapsed / defaultCollapsed / onCollapsedChange。
 *
 * 同一个 Tabs.Root 一次只能挂一个形态。SideNav.Root 与 BottomNav.Root 必须二选一挂载
 * （{isDesktop ? <SideNav.Root …/> : <BottomNav.Root …/>}），不要用 CSS 媒体查询把两个
 * 都留在 DOM 里：Tabs.Root 只保存一份 tab 注册表，每个 Tabs.List 都会把自己整份
 * collection 写进它，后挂载的那份整个覆盖前一份（与 value 是否相同无关）；侧栏的
 * indicator 再按 value 去这份「只剩底栏」的表里找元素，于是量到底栏那个 tab 的坐标，
 * 把指示条渲染到侧栏外——而且不会有任何报错。Tabs.Root 的 orientation
 * 是单值：窄屏用默认 horizontal（BottomNav），宽屏切 vertical（SideNav），断点切换时
 * 必须连 orientation 一起切，否则底栏会拿到 aria-orientation="vertical"、←/→ 失效。
 * 断点本身由消费方决定，组件不读媒体查询；Provider 放在两种形态的共同祖先上，
 * 折叠状态才能跨形态保留。
 */
function SideNavProvider({
  children,
  collapsed: collapsedProp,
  defaultCollapsed = false,
  onCollapsedChange,
}: SideNavProviderProps) {
  const [uncontrolledCollapsed, setUncontrolledCollapsed] =
    useState(defaultCollapsed)
  const controlled = collapsedProp !== undefined
  const collapsed = controlled ? collapsedProp : uncontrolledCollapsed

  // Root 的 id 与 Toggle 的 aria-controls 必须始终指同一个元素，
  // 所以 id 只在这里生成一次，两边都不得自行生成或覆盖。
  const navId = useId()

  const setCollapsed = useCallback(
    (next: boolean) => {
      if (!controlled) setUncontrolledCollapsed(next)
      onCollapsedChange?.(next)
    },
    [controlled, onCollapsedChange],
  )

  const value = useMemo(
    () => ({ collapsed, navId, setCollapsed }),
    [collapsed, navId, setCollapsed],
  )

  return <SideNavContext.Provider value={value}>{children}</SideNavContext.Provider>
}

/** 数字按 px 处理，字符串原样写入（与 BottomNav 的 maxWidth 一致）。 */
function toCssLength(value: number | string): string {
  return typeof value === 'number' ? `${value}px` : value
}

export type SideNavRootProps = Omit<
  ComponentProps<'nav'>,
  'className' | 'id'
> &
  SideNavAria & {
    className?: string
    /**
     * 展开态宽度；数字按 px 处理，写入 --rk-side-nav-width。
     * @default 220
     */
    width?: number | string
    /**
     * 折叠态宽度；数字按 px 处理，写入 --rk-side-nav-width-collapsed。
     * @default 64
     */
    collapsedWidth?: number | string
    /**
     * 顶栏高度，同时是 sticky 的 top 与自身高度的扣减项；数字按 px 处理，
     * 写入 --rk-side-nav-top。默认值对应 rk-top-bar 的 min-height。
     * @default 56
     */
    top?: number | string
  }

/**
 * 桌面端左侧常驻导航：语义、键盘与指示条全部复用 Tabs——必须放在 Tabs.Root 内，
 * Tabs.Panel 留在页面里，且 Tabs.Root 要给 orientation="vertical"。
 * id 由 Provider 统一分配（Toggle 的 aria-controls 指向它），因此不接受 id prop。
 *
 * 材质是纸底 + 右侧发丝线，不是 data-glass="chrome"：glass.md 的表面预算按
 * 同时可见的 backdrop 表面数计，常驻 chrome 的预算是一个 bar，顶栏 + 全高侧栏
 * 会是两块常驻 backdrop，故侧栏走不透明纸底（依据见 docs/2026-09-20-side-nav.md）。
 *
 * 它是 position: sticky 的列，因此对消费方有布局前提：页面走根滚动（nav 与视口之间
 * 不能有 overflow: hidden|auto|scroll 的祖先）、top 与顶栏真实高度一致、两栏那一层
 * 要 display: flex、直接父级要比 nav 高；完整表述见 react/README.md 的 SideNav 一节。
 */
function SideNavRoot({
  width = 220,
  collapsedWidth = 64,
  top = 56,
  className,
  style,
  children,
  ...props
}: SideNavRootProps) {
  const { collapsed, navId } = useSideNavContext('SideNav.Root')

  return (
    <nav
      {...props}
      id={navId}
      className={cx('rk-side-nav', className)}
      data-collapsed={collapsed ? '' : undefined}
      style={
        {
          ...style,
          '--rk-side-nav-width': toCssLength(width),
          '--rk-side-nav-width-collapsed': toCssLength(collapsedWidth),
          '--rk-side-nav-top': toCssLength(top),
        } as CSSProperties
      }
    >
      <Tabs.List className="rk-side-nav__list">
        {children}
        <Tabs.Indicator className="rk-side-nav__indicator" />
      </Tabs.List>
    </nav>
  )
}

export interface SideNavItemProps extends TabsTabProps {
  /** 图标：渲染进 aria-hidden 的 20px 容器，可访问名称只来自文本标签。 */
  icon?: ReactNode
}

/**
 * 侧边导航项：Tabs.Tab 的横排「图标 + 文本」排版，行为与 Tabs.Tab 完全一致。
 * 折叠态下文本标签视觉隐藏但保留在 DOM 里（可访问名称不丢），并在 children
 * 是纯字符串时自动补 title 作为鼠标悬停提示；展开态不写 title。
 * 想要正式 Tooltip 的调用方可以自己把 Item 包进 Tooltip.Provider 的 Trigger。
 */
function SideNavItem({
  icon,
  title,
  className,
  children,
  ...props
}: SideNavItemProps) {
  const { collapsed } = useSideNavContext('SideNav.Item')
  const collapsedTitle =
    collapsed && typeof children === 'string' ? children : undefined

  return (
    <Tabs.Tab
      {...props}
      title={title ?? collapsedTitle}
      className={cx('rk-side-nav__item', className)}
    >
      <span className="rk-side-nav__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="rk-side-nav__label">{children}</span>
    </Tabs.Tab>
  )
}

export interface SideNavToggleLabels {
  /** 展开态的按钮名称（点击会收起）。 @default '收起侧边栏' */
  collapse?: string
  /** 折叠态的按钮名称（点击会展开）。 @default '展开侧边栏' */
  expand?: string
}

export interface SideNavToggleProps
  extends Omit<
    IconButtonProps,
    'aria-label' | 'pressed' | 'onClick' | 'aria-expanded' | 'aria-controls'
  > {
  /**
   * 覆盖默认的收起 / 展开文案，供非中文界面使用。
   */
  labels?: SideNavToggleLabels
  /**
   * 点击回调，在切换折叠**之前**调用；在里面调 `event.preventDefault()` 会取消这次
   * 切换（留给埋点上报、二次确认这类需要先问一句的场景）。README 的 SideNav 一节
   * 有用例说明。
   */
  onClick?: ComponentProps<'button'>['onClick']
}

const DEFAULT_TOGGLE_LABELS: Required<SideNavToggleLabels> = {
  collapse: '收起侧边栏',
  expand: '展开侧边栏',
}

/**
 * 折叠开关：一个 IconButton，消费方通常放在 TopBar 的左上角（标题之前）。
 * aria-expanded 反映侧栏是否展开，aria-controls 指向 Root 的 id；
 * 图标可用 children 覆盖，默认是 currentColor 的内联「侧栏」符号。
 * onClick 在切换**之前**调用：在里面调 event.preventDefault() 会取消这次切换。
 */
function SideNavToggle({
  labels,
  children,
  className,
  onClick,
  ...props
}: SideNavToggleProps) {
  const { collapsed, navId, setCollapsed } = useSideNavContext('SideNav.Toggle')

  const label = collapsed
    ? (labels?.expand ?? DEFAULT_TOGGLE_LABELS.expand)
    : (labels?.collapse ?? DEFAULT_TOGGLE_LABELS.collapse)

  return (
    <IconButton
      {...props}
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls={navId}
      className={className}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        setCollapsed(!collapsed)
      }}
    >
      {children ?? (
        <svg
          viewBox="0 0 20 20"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
          <path d="M7.5 3.5v13" />
        </svg>
      )}
    </IconButton>
  )
}

export const SideNav = {
  Provider: SideNavProvider,
  Root: SideNavRoot,
  Item: SideNavItem,
  Toggle: SideNavToggle,
}
