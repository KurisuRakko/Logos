import type { ComponentProps, CSSProperties, ReactNode } from 'react'
import { cx } from '../cx.js'
import { Tabs } from '../tabs/tabs.js'
import type { TabsTabProps } from '../tabs/tabs.js'

/** 导航地标必须携带可访问名称：aria-label 或 aria-labelledby 二选一。 */
type BottomNavAria =
  | { 'aria-label': string }
  | { 'aria-labelledby': string }

export type BottomNavRootProps = Omit<ComponentProps<'nav'>, 'className'> &
  BottomNavAria & {
    className?: string
    /**
     * 里层 tab 列表的限宽（玻璃条本身三边贴满，只有列表居中限宽）；数字按 px 处理。
     * @default '640px'
     */
    maxWidth?: number | string
  }

/**
 * 移动端底部导航：语义、键盘与指示条全部复用 Tabs——必须放在 Tabs.Root 内，
 * Tabs.Panel 留在页面里。材质取 glass.css 的 data-glass="chrome" 常显（底栏
 * 始终压在内容上，没有滚动渐显的余地，故不写 data-reveal）；chrome 的底边
 * 发丝线由组件 CSS 翻到顶边（glass.md 允许改 box-shadow）。
 */
function BottomNavRoot({
  maxWidth = '640px',
  className,
  style,
  children,
  ...props
}: BottomNavRootProps) {
  return (
    <nav
      {...props}
      className={cx('rk-bottom-nav', className)}
      data-glass="chrome"
      style={
        {
          ...style,
          '--rk-bottom-nav-max-width':
            typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth,
        } as CSSProperties
      }
    >
      <Tabs.List className="rk-bottom-nav__list">
        {children}
        <Tabs.Indicator className="rk-bottom-nav__indicator" />
      </Tabs.List>
    </nav>
  )
}

export interface BottomNavItemProps extends TabsTabProps {
  /** 图标：渲染进 aria-hidden 的 20px 容器，可访问名称只来自文本标签。 */
  icon?: ReactNode
}

/** 底部导航项：Tabs.Tab 的竖排「图标 + 文本」排版，行为与 Tabs.Tab 完全一致。 */
function BottomNavItem({
  icon,
  className,
  children,
  ...props
}: BottomNavItemProps) {
  return (
    <Tabs.Tab {...props} className={cx('rk-bottom-nav__item', className)}>
      <span className="rk-bottom-nav__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="rk-bottom-nav__label">{children}</span>
    </Tabs.Tab>
  )
}

export const BottomNav = {
  Root: BottomNavRoot,
  Item: BottomNavItem,
}
