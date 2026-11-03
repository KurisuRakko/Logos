// NavigationStack：DOM 内常驻的导航栈。栈里每个条目一层 <div class="rk-nav-layer">，按条目 key 做 React key，
// 下层页面保持挂载、状态保留。层的显示状态（data-nav-state、inert）与转场属性（data-nav-role / -fx / -ghosted）
// 由 layers.ts / transition.ts 直接写 DOM，这里不渲染它们。一个文档只能有一个 NavigationStack。
import { memo, useCallback, useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import { ENGINE } from './engine'
import type { EngineHandle, NavigationEntry } from './engine'
import type { BrowserNavigation } from './browser'
import { installEdgeSwipeBack } from './gesture'
import type { EdgeSwipeBackMode } from './gesture'
import { NavigationLayerContext } from './layers'
import type { MemoryNavigation } from './memory'

export interface NavigationStackProps<T> {
  /** createMemoryNavigation / createBrowserNavigation 返回的实例。 */
  navigation: MemoryNavigation<T> | BrowserNavigation<T>
  /** 条目 → 页面。必须是稳定的函数（模块级），层按条目 memo，否则每次重渲染所有层。 */
  render(data: T, entry: NavigationEntry<T>): ReactNode
  /**
   * 左缘右滑返回：'standalone'（默认）只在主屏模式启用，浏览器标签页里交给浏览器自己的边缘手势；
   * 'always' 任何环境都启用；'off' 不装。
   */
  edgeSwipeBack?: EdgeSwipeBackMode
}

/** 已挂载的 NavigationStack 个数：超过一个时报错（层状态、window 滚动与 history 都只能有一个主人）。 */
let mounted = 0

export function NavigationStack<T>({ navigation, render, edgeSwipeBack = 'standalone' }: NavigationStackProps<T>) {
  const engine = navigation[ENGINE]
  const entries = useSyncExternalStore(engine.subscribeEntries, engine.getEntries, engine.getEntries)

  useEffect(() => {
    mounted += 1
    if (mounted > 1) {
      console.error(
        'Rakko Design: 一个文档只能有一个 NavigationStack（层状态、window 滚动与 history 都只有一个主人）。',
      )
    }
    const detach = engine.attach()
    return () => {
      mounted -= 1
      detach()
    }
  }, [engine])

  useEffect(() => {
    if (edgeSwipeBack === 'off') return
    return installEdgeSwipeBack(engine, edgeSwipeBack)
  }, [engine, edgeSwipeBack])

  return (
    <>
      {entries.map((entry) => (
        <NavigationStackLayer
          key={entry.key}
          engine={engine}
          entry={entry}
          render={render as NavigationStackProps<unknown>['render']}
        />
      ))}
    </>
  )
}

const NavigationStackLayer = memo(function NavigationStackLayer({
  engine,
  entry,
  render,
}: {
  engine: EngineHandle
  entry: NavigationEntry<unknown>
  render: NavigationStackProps<unknown>['render']
}) {
  const ref = useCallback((el: HTMLDivElement | null) => engine.layers.attach(entry.key, el), [engine, entry.key])
  const record = engine.layers.get(entry.key) ?? null
  return (
    <div ref={ref} className="rk-nav-layer">
      <NavigationLayerContext.Provider value={record}>{render(entry.data, entry)}</NavigationLayerContext.Provider>
    </div>
  )
})

