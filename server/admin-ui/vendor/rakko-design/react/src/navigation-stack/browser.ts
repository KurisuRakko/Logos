// 导航栈的 history 绑定：内存栈与 history 条目一一对应。只做「路径 ↔ 数据」这一层，路由表（parse）留在应用里。
// 路径 = location.pathname + location.search（不含 hash），parse 收到的就是它。
//
//   - 应用内跳转（navigate / back）带推入 / 返回转场；back 在有应用内历史时调 history.back()，popstate 到了再播返回动画。
//     推入转场中 back：从新页此刻的位置反向滑回去，落定后再 history.back()，popstate 只收尾（见 engine.reversePush）。
//   - 浏览器自己触发的 popstate（后退 / 前进键、菜单）也带转场：比深度定方向，后退同 back（栈里有就用已挂载的页面），
//     前进像推入一样把那一页挂上来（恢复它离开时的滚动位置）。
//     系统的边缘手势（Safari 标签页左缘右滑等）已经播过自己的翻页动画，它触发的 popstate（systemSwipe.ts 认）
//     直接切到目标页、不叠第二遍；栈的样子对不上（前进到的深度上还压着别的层）时也直接切。
//     转场中途来的：回到出发页的（推入时后退、返回时前进）从此刻的位置反向走回去（op.retreat）；
//     去别处的排到这段转场走完再转场过去；系统手势的让进行中的转场瞬间走完再切。排着的应用内返回作废（浏览器已经替它退过了）。
//   - 左缘右滑完成后调 history.back()，popstate 只做收尾；1 秒内没来就退回原页。
//
// history.state 形如 { rk: 1, depth, key, prev?, prevScrollY?, scrollY? }：
//   depth 应用内深度（首个条目为 0），back 据此判断能不能 history.back()；key 对应栈里的条目；
//   prev / prevScrollY 是上一条目的路径与离开时的滚动位置（刷新或深链进来时下层没挂载，返回 / 右滑时按它挂上）；
//   scrollY 是离开该条目时的滚动位置。
import { useSyncExternalStore } from 'react'
import type { MouseEvent } from 'react'

import { ENGINE, NavigationEngine, newEntryKey } from './engine'
import type { EngineHandle, NavigationSource, PendingBack, StackItem } from './engine'
import { installSystemSwipeWatch, systemSwipeLikely } from './system-swipe'
import type { NavigationDirection } from './transition'

export interface BrowserNavigationOptions<T> {
  /** 路径（pathname + search）→ 页面数据；路由表留在应用里。 */
  parse(path: string): T
  /** 挂载新层前先等它（懒加载 chunk）；失败也算完成。返回 undefined 表示不用等。 */
  preload?(data: T): Promise<unknown> | undefined
  /** 等 preload 加新页就绪的总上限（ms），默认 300。 */
  readyTimeout?: number
}

export interface NavigateOptions {
  /** true = replaceState（不新增历史条目，替换栈顶）。 */
  replace?: boolean
  /** 动画方向，默认 'forward'。 */
  direction?: NavigationDirection
}

export interface LinkProps {
  href: string
  onClick(event: MouseEvent<HTMLElement>): void
}

export interface BrowserNavigation<T> extends NavigationSource {
  /** 提前拿 chunk（异步建好再跳转的流程与请求并行等它）；失败也算完成。 */
  preload(data: T): Promise<void>
  /**
   * 应用内跳转。默认 push + 'forward' 推入动画，新页面从顶部开始。同一路径且非 replace 时什么也不做；
   * 转场进行或待定期间忽略非 replace 的跳转，replace 排到转场结束后（只留最新一个）。
   * 返回 true = 已跳转或已排队（调用方可以当作「要离开了」），false = 被忽略。
   */
  navigate(path: string, options?: NavigateOptions): boolean
  /**
   * 返回上一页：有应用内历史 → history.back()（带返回动画）；没有（直接打开的深链）→ 以 'back' 方向替换为 fallbackPath。
   * 推入转场进行中：从新页此刻的位置反向滑回去，落定后再 history.back()；还在等就绪：排队（只记一次），一开推就原地反向。
   * 返回值同 navigate。
   */
  back(fallbackPath: string): boolean
  /** 给 <a> 用的 href + onClick：普通左键点击走 navigate，带修饰键 / 中键 / 已被 preventDefault 的点击交给浏览器。 */
  linkProps(path: string, options?: NavigateOptions): LinkProps
  /** 当前地址对应的数据；地址变化（navigate / back / popstate）时重渲染。 */
  useRoute(): T
  /** 有没有应用内的上一页（history.state.depth > 0）。 */
  canGoBack(): boolean
}

interface HistoryState {
  rk: 1
  depth: number
  key: string
  prev?: string
  prevScrollY?: number
  scrollY?: number
  /** 本页之上叠着的页内锚点条目数（同一路径上的 hash 跳转产生）；应用内返回与右滑返回一并跳过它们。 */
  hash?: number
}

/** back / 右滑完成后发出 history.back() 等 popstate 的上限（ms）：浏览器没有响应时解除锁定。 */
export const NAV_POP_TIMEOUT_MS = 1000

function newHistoryKey(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function locationPath(): string {
  return window.location.pathname + window.location.search
}

/** 当前条目的 state；没有 key（首次打开、别处写的 state）时补上并写回。 */
function readState(): HistoryState {
  const raw = window.history.state as Partial<HistoryState> | null
  if (raw && raw.rk === 1 && typeof raw.depth === 'number' && typeof raw.key === 'string') return raw as HistoryState
  const state: HistoryState = {
    rk: 1,
    depth: raw && raw.rk === 1 && typeof raw.depth === 'number' ? raw.depth : 0,
    key: newHistoryKey(),
  }
  if (raw && typeof raw.scrollY === 'number') state.scrollY = raw.scrollY
  window.history.replaceState(state, '')
  return state
}

export function createBrowserNavigation<T>(options: BrowserNavigationOptions<T>): BrowserNavigation<T> {
  const engine = new NavigationEngine<T>(options)
  const makeItem = (path: string, depth: number, hkey: string | null): StackItem<T> => ({
    key: newEntryKey(),
    data: options.parse(path),
    depth,
    hkey,
    path,
  })

  // 滚动由导航栈按条目恢复，不交给浏览器
  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'

  const initialState = readState()
  const first = makeItem(locationPath(), initialState.depth, initialState.key)
  engine.init(first)
  let currentPath = first.path
  let currentData = first.data
  /** 最近一次读到 / 写入的顶层条目 state：页内锚点跳转时照它补写新条目（见 onPopState）。 */
  let topState: HistoryState = initialState
  const listeners = new Set<() => void>()

  const setRoute = (path: string) => {
    if (path === currentPath) return
    currentPath = path
    currentData = options.parse(path)
    for (const listener of [...listeners]) listener()
  }

  /** popstate 回到的条目在栈里的位置；手势 / 返回前按 prev 挂上的下层还没有 key，按路径认领。 */
  const findItem = (state: HistoryState): number => {
    const stack = engine.stack
    const index = stack.findIndex((item) => item.hkey === state.key)
    if (index >= 0) return index
    const below = stack[stack.length - 2]
    if (below && below.hkey === null && below.path === locationPath()) {
      below.hkey = state.key
      return stack.length - 2
    }
    return -1
  }

  let pendingBackTimer = 0

  const requestBack = (mode: 'animate' | 'gesture', onTimeout: () => void) => {
    engine.pendingBack = mode
    window.clearTimeout(pendingBackTimer)
    pendingBackTimer = window.setTimeout(() => {
      if (engine.pendingBack !== mode) return
      engine.pendingBack = null
      onTimeout()
      engine.drainQueue()
    }, NAV_POP_TIMEOUT_MS)
    // 本页之上有页内锚点条目时一次跳过：退到上一页，而不是先退回本页的另一个锚点
    const steps = 1 + (readState().hash ?? 0)
    if (steps > 1) window.history.go(-steps)
    else window.history.back()
  }

  /** back() 的 popstate：下层（不在栈里就按当前地址挂上并等就绪）从左侧回来，顶层向右滑出。 */
  const popAnimated = (state: HistoryState) => {
    const index = findItem(state)
    const target = index >= 0 ? engine.stack[index]! : makeItem(locationPath(), state.depth, state.key)
    return engine.popAnimated(target, state.scrollY ?? 0)
  }

  /** 直接切过去、不做动画（栈里有就用已挂载的页面，状态与滚动位置都在）：系统手势已经播过动画的后退 / 前进。 */
  const popInstant = (state: HistoryState) => {
    const index = findItem(state)
    if (index >= 0) {
      engine.jump(engine.stack[index]!, engine.stack.slice(index + 1), index, 0)
      return
    }
    // 栈里没有：按地址新建，深度不小于它的层都丢掉
    const target = makeItem(locationPath(), state.depth, state.key)
    const drop = engine.stack.filter((item) => item.depth >= state.depth)
    engine.jump(target, drop, engine.stack.length - drop.length, state.scrollY ?? 0)
  }

  /**
   * 浏览器自己的后退 / 前进：后退（目标在栈里，或比栈顶浅）走返回转场，前进（栈里没有、比栈顶深）走推入转场；
   * 系统边缘手势触发的、或栈的样子对不上（前进到的深度上还压着别的层）时直接切换。
   */
  const popBrowser = (state: HistoryState) => {
    if (systemSwipeLikely()) {
      popInstant(state)
      return
    }
    const index = findItem(state)
    const from = engine.top()
    if (index === engine.stack.length - 1) {
      popInstant(state)
      return
    }
    if (index >= 0 || state.depth < from.depth) {
      void popAnimated(state)
      return
    }
    if (engine.stack.some((item) => item.depth >= state.depth)) {
      popInstant(state)
      return
    }
    const target = makeItem(locationPath(), state.depth, state.key)
    void engine.present(target, from, 'forward', false, state.scrollY ?? 0)
  }

  /** 走到终点、在等 popstate 收尾的那段返回（右滑完成、推入中途反向）。 */
  let swipeDone: PendingBack<T> | null = null

  // 推入中途反向落定后：history.back() 退掉新页的条目，popstate 只收尾；没来（浏览器没响应）就让推入落地
  engine.commitReverse = (done) => {
    swipeDone = done
    requestBack('gesture', () => {
      swipeDone = null
      done.rollback()
    })
  }

  const finishSwipe = (state: HistoryState) => {
    const done = swipeDone
    swipeDone = null
    if (!done) return
    const index = findItem(state)
    if (engine.stack[index] !== done.target) {
      // 回到的不是预期的那页：退回原页，再按普通 popstate 处理
      done.transition.stop()
      engine.settle(done.from, engine.layers.scrollY(done.from.key))
      done.transition.cleanup()
      engine.endOp(done.op)
      popInstant(state)
      return
    }
    engine.commitSwipe(done)
  }

  const onPopState = () => {
    const mode = engine.pendingBack
    // 同一路径上的页内锚点 / hash 跳转：浏览器同样派发 popstate，新条目的 state 是 null。
    // 这不是页面切换——给新条目补上当前顶层的 state（同一个 key），栈不动；
    // 否则它会被当成「不在栈里的新条目」，把整个栈换成一层、页面状态全丢。
    const raw = window.history.state as Partial<HistoryState> | null
    if (mode === null && !(raw && raw.rk === 1) && locationPath() === currentPath) {
      const top = engine.top()
      const base: HistoryState =
        topState.key === top.hkey ? topState : { rk: 1, depth: top.depth, key: top.hkey ?? newHistoryKey() }
      const next: HistoryState = { rk: 1, depth: base.depth, key: base.key }
      if (base.prev !== undefined) next.prev = base.prev
      if (base.prevScrollY !== undefined) next.prevScrollY = base.prevScrollY
      next.hash = (base.hash ?? 0) + 1
      window.history.replaceState(next, '')
      topState = next
      return
    }
    engine.pendingBack = null
    window.clearTimeout(pendingBackTimer)
    const state = readState()
    topState = state
    setRoute(locationPath())
    if (mode === 'gesture') {
      finishSwipe(state)
      return
    }
    // 转场进行中又后退 / 前进：回到出发页的，从此刻的位置反向走回去（retreat）；去别处的，排到这段转场走完再转场过去
    // （系统边缘手势的照旧瞬间走完再切，画面已经被系统换过了）。排着的应用内返回作废（浏览器已经替它退过了）
    if (engine.queued?.kind === 'back') engine.queued = null
    const system = mode === null && systemSwipeLikely()
    if (mode === null && !system && engine.op?.retreat?.(state.key)) return
    if (mode === null && !system && engine.op) {
      engine.queued = { kind: 'back', run: () => popBrowser(readState()) }
      return
    }
    engine.op?.finishNow()
    if (mode === 'animate') void popAnimated(state)
    else popBrowser(state)
    engine.drainQueue()
  }

  const navigate = (path: string, navigateOptions: NavigateOptions = {}): boolean => {
    const { replace = false, direction = 'forward' } = navigateOptions
    if (path === currentPath && !replace) return false
    if (engine.busy()) {
      if (!replace) return false
      return engine.queueReplace(() => navigate(path, navigateOptions))
    }
    const state = readState()
    const from = engine.top()
    const item = makeItem(path, replace ? state.depth : state.depth + 1, newHistoryKey())
    if (replace) {
      const next: HistoryState = { rk: 1, depth: state.depth, key: item.hkey! }
      if (state.prev !== undefined) next.prev = state.prev
      if (state.prevScrollY !== undefined) next.prevScrollY = state.prevScrollY
      window.history.replaceState(next, '', path)
      topState = next
    } else {
      // 离开时的滚动位置记在当前条目上，也作为新条目的 prevScrollY（刷新后右滑返回时用）
      const y = window.scrollY
      window.history.replaceState({ ...state, scrollY: y } satisfies HistoryState, '')
      const pushed: HistoryState = { rk: 1, depth: item.depth, key: item.hkey!, prev: currentPath, prevScrollY: y }
      window.history.pushState(pushed, '', path)
      topState = pushed
    }
    setRoute(path)
    void engine.present(item, from, direction, replace)
    return true
  }

  const back = (fallbackPath: string): boolean => {
    // 上一次返回还没生效 / 返回转场进行中：连点只算一次，不跳过一级
    if (engine.backBlocked()) return false
    if (engine.op) {
      engine.queueBack(() => back(fallbackPath))
      return true
    }
    if (readState().depth > 0) {
      requestBack('animate', () => {})
      return true
    }
    return navigate(fallbackPath, { replace: true, direction: 'back' })
  }

  const canSwipeBack = (): boolean => {
    if (engine.busy()) return false
    const state = readState()
    return state.depth > 0 && (engine.stack.length >= 2 || typeof state.prev === 'string')
  }

  const handle: EngineHandle = {
    layers: engine.layers,
    getEntries: engine.getEntries,
    subscribeEntries: engine.subscribeEntries,
    attach: () => {
      window.addEventListener('popstate', onPopState)
      // 标签页里系统边缘手势的痕迹（据此不给它触发的 popstate 再加转场）
      const unwatch = installSystemSwipeWatch()
      return () => {
        unwatch()
        window.removeEventListener('popstate', onPopState)
      }
    },
    canSwipeBack,
    beginSwipeBack: () => {
      if (!canSwipeBack()) return null
      const state = readState()
      let target = engine.stack[engine.stack.length - 2]
      if (!target) {
        // 下层没挂载（刷新或深链进来）：按 state.prev 挂上，来不及等数据，边拖边出内容
        if (typeof state.prev !== 'string') return null
        const mounted = makeItem(state.prev, state.depth - 1, null)
        engine.mount(mounted, engine.stack.length - 1, 'hidden', state.prevScrollY ?? 0)
        // 就绪了再滚到离开时的位置（刚挂上时内容不够高，scrollTop 会被截断）
        void engine.layers.whenReady(mounted.key).then(() => engine.layers.reapplyScroll(mounted.key))
        target = mounted
      }
      return engine.beginSwipe(target, (swipe) => {
        swipeDone = swipe
        // popstate 没来（浏览器没响应）：退回原页
        requestBack('gesture', () => {
          swipeDone = null
          swipe.rollback()
        })
      })
    },
  }

  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const getRoute = () => currentData

  return {
    [ENGINE]: handle,
    preload: (data) => engine.preload(data),
    navigate,
    back,
    linkProps: (path, linkOptions) => ({
      href: path,
      onClick: (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return
        }
        event.preventDefault()
        navigate(path, linkOptions)
      },
    }),
    // useRoute 是 hook：只在组件里调用
    useRoute: () => useSyncExternalStore(subscribe, getRoute, getRoute),
    canGoBack: () => readState().depth > 0,
  }
}
