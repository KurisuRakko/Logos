// 与路由无关的内存导航栈：没有 URL，也不碰 history（showcase、测试、嵌在别的路由里的流程用）。
// 栈操作、转场、排队规则与浏览器版共用 engine.ts；这里只维护「逻辑上的当前条目」。
import { ENGINE, NavigationEngine, newEntryKey } from './engine'
import type { EngineHandle, NavigationEntry, NavigationSource, StackItem } from './engine'

export interface MemoryNavigationOptions<T> {
  /** 初始页面的数据。 */
  initial: T
  /** 挂载新层前先等它（懒加载 chunk）；失败也算完成。返回 undefined 表示不用等。 */
  preload?(data: T): Promise<unknown> | undefined
  /** 等 preload 加新页就绪的总上限（ms），默认 300。 */
  readyTimeout?: number
}

export interface MemoryNavigation<T> extends NavigationSource {
  /** 提前拿 chunk（异步建好再跳转的流程与请求并行等它）；失败也算完成。 */
  preload(data: T): Promise<void>
  /** 推入新页；转场或等待期间调用会被忽略。返回 true = 已执行，false = 被忽略。 */
  push(data: T, options?: { animated?: boolean }): boolean
  /**
   * 返回上一页。推入转场进行中：从新页此刻的位置反向滑回去；还在等就绪：排队（只记一次），一开推就原地反向。
   * 返回 true = 已执行或已排队，false = 被忽略。
   */
  pop(options?: { animated?: boolean }): boolean
  /** 替换当前页；direction 默认 'none'（等就绪后瞬间切换）。转场期间排队、只留最新一个。 */
  replace(data: T, options?: { direction?: 'forward' | 'back' | 'none' }): boolean
  /** 有没有上一页。 */
  canGoBack(): boolean
  /** 逻辑上的当前条目：push / pop / replace 一调用就变（不等转场结束），右滑在完成时才变。 */
  current(): NavigationEntry<T>
  /** current() 变化时回调；返回取消订阅。 */
  subscribe(listener: () => void): () => void
}

export function createMemoryNavigation<T>(options: MemoryNavigationOptions<T>): MemoryNavigation<T> {
  const engine = new NavigationEngine<T>(options)
  const makeItem = (data: T, depth: number): StackItem<T> => ({ key: newEntryKey(), data, depth, hkey: null, path: '' })
  let current = makeItem(options.initial, 0)
  engine.init(current)
  const listeners = new Set<() => void>()

  const setCurrent = (item: StackItem<T>) => {
    if (item === current) return
    current = item
    for (const listener of [...listeners]) listener()
  }

  const push: MemoryNavigation<T>['push'] = (data, { animated = true } = {}) => {
    if (engine.busy()) return false
    const from = engine.top()
    const item = makeItem(data, from.depth + 1)
    setCurrent(item)
    void engine.present(item, from, animated ? 'forward' : 'none', false)
    return true
  }

  const pop: MemoryNavigation<T>['pop'] = (popOptions = {}) => {
    if (current.depth < 1 || engine.backBlocked()) return false
    if (engine.busy()) {
      // 推入已经在动：从此刻的位置反向回到出发页（current 随即回到它）；还在等就绪：排队，一开推就反向
      if (engine.op?.reverse) {
        const target = engine.stack[engine.stack.length - 2]
        if (target) setCurrent(target)
      }
      engine.queueBack(() => pop(popOptions))
      return true
    }
    const index = engine.stack.length - 2
    const target = engine.stack[index]
    if (!target) return false
    setCurrent(target)
    if (popOptions.animated === false) {
      engine.settle(target, engine.layers.scrollY(target.key), engine.stack.slice(index + 1))
    } else {
      void engine.popAnimated(target)
    }
    return true
  }

  const replace: MemoryNavigation<T>['replace'] = (data, replaceOptions = {}) => {
    if (engine.busy()) return engine.queueReplace(() => replace(data, replaceOptions))
    const from = engine.top()
    const item = makeItem(data, from.depth)
    setCurrent(item)
    void engine.present(item, from, replaceOptions.direction ?? 'none', true)
    return true
  }

  const handle: EngineHandle = {
    layers: engine.layers,
    getEntries: engine.getEntries,
    subscribeEntries: engine.subscribeEntries,
    attach: () => () => {},
    canSwipeBack: () => !engine.busy() && engine.stack.length >= 2,
    beginSwipeBack: () => {
      if (!handle.canSwipeBack()) return null
      const target = engine.stack[engine.stack.length - 2]!
      return engine.beginSwipe(target, (swipe) => {
        // 内存版没有 history 要等：画面已在终点，直接提交（先改 current：提交会放行排着的 replace）
        setCurrent(target)
        engine.commitSwipe(swipe)
      })
    },
  }

  return {
    [ENGINE]: handle,
    preload: (data) => engine.preload(data),
    push,
    pop,
    replace,
    canGoBack: () => current.depth > 0,
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
