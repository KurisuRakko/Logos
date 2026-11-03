import { Tabs as BaseTabs } from '@base-ui/react/tabs'
import type { ComponentProps } from 'react'
import { cx } from '../cx.js'

export interface TabsListProps
  extends Omit<ComponentProps<typeof BaseTabs.List>, 'className'> {
  className?: string
}

/**
 * 契约约定（motion.md）：方向键移动即切换当前 tab，故默认 activateOnFocus=true
 * （Base UI 默认 false，手工激活模式）；调用方传 false 可切回。
 */
function TabsList({
  activateOnFocus = true,
  className,
  ...props
}: TabsListProps) {
  return (
    <BaseTabs.List
      {...props}
      activateOnFocus={activateOnFocus}
      className={cx('rk-tabs', className)}
    />
  )
}

export interface TabsTabProps
  extends Omit<ComponentProps<typeof BaseTabs.Tab>, 'className'> {
  className?: string
}

function TabsTab({ className, ...props }: TabsTabProps) {
  return (
    <BaseTabs.Tab {...props} data-ripple className={cx('rk-tab', className)} />
  )
}

export interface TabsIndicatorProps
  extends Omit<ComponentProps<typeof BaseTabs.Indicator>, 'className'> {
  className?: string
}

function TabsIndicator({ className, ...props }: TabsIndicatorProps) {
  return (
    <BaseTabs.Indicator
      {...props}
      className={cx('rk-tabs__indicator', className)}
    />
  )
}

export interface TabsPanelProps
  extends Omit<ComponentProps<typeof BaseTabs.Panel>, 'className'> {
  className?: string
}

function TabsPanel({ className, ...props }: TabsPanelProps) {
  return (
    <BaseTabs.Panel {...props} className={cx('rk-tabpanel', className)} />
  )
}

export const Tabs = {
  Root: BaseTabs.Root,
  List: TabsList,
  Tab: TabsTab,
  Indicator: TabsIndicator,
  Panel: TabsPanel,
}
