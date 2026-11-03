// 导航栈引擎：createMemoryNavigation 与 createBrowserNavigation 共用的那一半——
// 栈、层登记、推入（present）、带动画的返回、交互式返回的转场部分、转场期间的排队与打断。
// 与 URL 的对应（history.state、popstate 的三种来源）由 browser.ts 负责，内存版见 memory.ts。
//
// 栈里的页面都保持挂载：顶层可见、用 window 滚动；下层隐藏、不可交互、状态保留。
// 每个条目离开顶层时记下滚动位置，回到顶层时在首帧前恢复（settle）。
//
// 推入的就绪等待（present）分两步，总上限 readyTimeout（从 preload 开始算）：
//   1. 先 await preload(data)（失败也算完成）再挂载新层：chunk 没到时被浏览器后退打断，新页根本不会挂上；
//   2. 用 flushSync 挂载，useNavigationReady(false) 在 layout effect 里登记的 hold 此时已经登记好；
//      没有 hold 就立即推入，有就等它们全部解除。
//
// 并发规则：
//   - 转场或等待期间（op）忽略新的推入：连点两行只进一个页面；
//   - replace 排到转场结束后执行，只留最新一个（queued）；
//   - 推入转场期间点返回：从新页此刻的位置反向滑回去（op.reverse → reversePush，不先走完推入）；
//     新页还没开始推（等就绪中）时点返回先排队（只记一次），一开推就原地反向；
//   - 返回进行中（含推入已经在反向）再点返回直接忽略，不跳过一级；反向中的推入发出的 replace 不再执行；
//   - 浏览器的 popstate 回到出发页（推入时后退、返回时前进）：op.retreat 从此刻的位置反向走回去；
//     去别处的由 browser.ts 排到这段转场走完、或调 op.finishNow() 让它瞬间走完，之后挂起的异步步骤醒来什么都不做。
import { flushSync } from 'react-dom'

import { LayerRegistry } from './layers'
import { createNavTransition } from './transition'
import type { NavigationDirection, NavTransition } from './transition'

/** 栈里的一个条目；对象身份稳定（NavigationStack 按它 memo），key 是 React key。 */
export interface NavigationEntry<T> {
  readonly key: string
  readonly data: T
}

export interface StackItem<T> extends NavigationEntry<T> {
  /** 应用内深度（首个条目为 0）。 */
  depth: number
  /** 浏览器版：对应的 history 条目 key；按 prev 预先挂上的下层在 popstate 认领之前为 null。内存版不用。 */
  hkey: string | null
  /** 浏览器版：条目的路径（pathname + search）。内存版为空串。 */
  path: string
}

/**
 * 进行中的转场（等就绪 / 动画 / 手势）。finishNow() 立即跳到它的终点并收尾（被 popstate 打断时用），
 * 之后 cancelled 为 true，挂起的异步步骤醒来后什么都不做。
 */
export interface Op {
  /** push：present（推入 / 替换）；back：带动画的返回或右滑（推入中途反向之后也算 back）。 */
  kind: 'push' | 'back'
  cancelled: boolean
  finishNow(): void
  /** 推入转场已经开始：从此刻的位置反向退回出发页（应用内返回调）。只有普通的前进推入有。 */
  reverse?: () => void
  /**
   * 转场中途浏览器后退 / 前进回到了出发页（hkey 是 popstate 落到的条目）：从此刻的位置反向走回去，返回 true；
   * 别的去处返回 false，由调用方处理。
   */
  retreat?: (hkey: string) => boolean
  /** 已经在反向：要走的是新页，它发出的替换不再执行。 */
  reversed?: boolean
}

/** 交互式返回（左缘右滑）的一次会话；t 为返回进度 0…1，velocity 为手指水平速度（px/ms，向右为正）。 */
export interface SwipeBackSession {
  move(t: number): void
  release(complete: boolean, velocity: number): void
  /** 会话还在跟手（没被 popstate / 浏览器去往别处收掉，也还没松手）。 */
  active(): boolean
}

/**
 * 一段走到终点、等提交的返回转场（右滑完成、推入中途反向）：from 是要离开的那层，target 是回到的那层。
 * rollback 让它作废、回到 from（浏览器没响应时用）。
 */
export interface PendingBack<T> {
  from: StackItem<T>
  target: StackItem<T>
  transition: NavTransition
  op: Op
  rollback: () => void
}

/** NavigationStack 与左缘右滑看到的那一面；两种导航实例都在 [ENGINE] 上挂一个。 */
export interface EngineHandle {
  readonly layers: LayerRegistry
  getEntries(): readonly NavigationEntry<unknown>[]
  subscribeEntries(listener: () => void): () => void
  /** NavigationStack 挂载时调用（浏览器版在这里装 popstate 监听）；返回卸载函数。 */
  attach(): () => void
  canSwipeBack(): boolean
  beginSwipeBack(): SwipeBackSession | null
}

export const ENGINE: unique symbol = Symbol('rk-navigation-engine')

/** 两种导航实例共有的标记：NavigationStack 只认带 [ENGINE] 的对象。 */
export interface NavigationSource {
  readonly [ENGINE]: EngineHandle
}

export interface EngineOptions<T> {
  preload?(data: T): Promise<unknown> | undefined
  readyTimeout?: number
}

/** 等 preload 加新页就绪的默认总上限（ms）：超时照常推入，不让点按悬空太久。 */
export const NAV_READY_TIMEOUT_MS = 300

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

let keySeq = 0

export function newEntryKey(): string {
  keySeq += 1
  return `rk-nav-${keySeq}`
}

export class NavigationEngine<T> {
  readonly layers = new LayerRegistry()
  /** 自底向上；最后一个是顶层（转场中是即将离开 / 刚推入的那层，见各流程）。 */
  stack: StackItem<T>[] = []
  op: Op | null = null
  /** 转场期间到来的 replace / 返回：转场结束后执行（只留最新一个）。 */
  queued: { kind: 'replace' | 'back'; run: () => void } | null = null
  /** 浏览器版：发出 history.back() 后在等 popstate（期间算忙）。 */
  pendingBack: 'animate' | 'gesture' | null = null
  /**
   * 推入中途反向、画面已经回到出发页之后怎么提交：浏览器版要 history.back() 再等 popstate 收尾；
   * 为 null（内存版）时直接落定。
   */
  commitReverse: ((done: PendingBack<T>) => void) | null = null

  private entries: readonly NavigationEntry<unknown>[] = []
  private readonly entryListeners = new Set<() => void>()
  private readonly options: EngineOptions<T>

  constructor(options: EngineOptions<T>) {
    this.options = options
  }

  /* ---------------------------------------------------------------- 渲染侧 */

  readonly getEntries = (): readonly NavigationEntry<unknown>[] => this.entries

  readonly subscribeEntries = (listener: () => void): (() => void) => {
    this.entryListeners.add(listener)
    return () => {
      this.entryListeners.delete(listener)
    }
  }

  /** 初始条目：直接作为顶层登记，不经过转场。 */
  init(item: StackItem<T>): void {
    this.layers.create(item.key, 'top', 0)
    this.stack = [item]
    this.entries = [item]
  }

  top(): StackItem<T> {
    return this.stack[this.stack.length - 1]!
  }

  busy(): boolean {
    return this.op !== null || this.pendingBack !== null
  }

  /** 同步渲染栈（新层的元素在返回前已挂上、状态已写好、layout effect 已执行）。 */
  private publish(): void {
    this.entries = [...this.stack]
    flushSync(() => {
      for (const listener of [...this.entryListeners]) listener()
    })
  }

  mount(item: StackItem<T>, index: number, state: 'hidden' | 'pending', scrollY: number): void {
    this.layers.create(item.key, state, scrollY)
    this.stack.splice(index, 0, item)
    this.publish()
  }

  private remove(items: StackItem<T>[]): void {
    if (items.length === 0) return
    this.stack = this.stack.filter((item) => !items.includes(item))
    this.publish()
    for (const item of items) this.layers.delete(item.key)
  }

  /**
   * 让 target 成为顶层：其余层先隐藏（顶层的滚动位置在这一步记下），target 回到文档流，
   * 再把 window 滚到 scrollY；drop 里的层随后卸载（页面卸载时的保存 / 清理在这里触发）。
   * 最后通知各层。整个过程在同一任务里完成，不出中间帧。
   */
  settle(target: StackItem<T>, scrollY: number, drop: StackItem<T>[] = []): void {
    for (const item of this.stack) if (item !== target) this.layers.setState(item.key, 'hidden')
    this.layers.setState(target.key, 'top')
    window.scrollTo(0, scrollY)
    this.remove(drop)
    // 滚到 0 不会被截断（浏览器也不为它排版）：告诉监听者 window 就在 0，栏不用读 window.scrollY 强制排版
    this.layers.notify(scrollY === 0 ? 0 : undefined)
  }

  /* ---------------------------------------------------------------- 排队 */

  beginOp(kind: Op['kind']): Op {
    const created: Op = { kind, cancelled: false, finishNow: () => {} }
    this.op = created
    return created
  }

  endOp(done: Op): void {
    done.cancelled = true
    if (this.op === done) this.op = null
    this.drainQueue()
  }

  drainQueue(): void {
    if (this.busy()) return
    const next = this.queued
    this.queued = null
    next?.run()
  }

  /** 转场期间的 replace：已经排着一次返回 / 推入正在反向就不再执行（页面要走了），否则只留最新一个。 */
  queueReplace(run: () => void): boolean {
    if (this.queued?.kind === 'back' || this.op?.reversed) return false
    this.queued = { kind: 'replace', run }
    return true
  }

  /** 返回的连点保护：上一次返回还没生效 / 返回转场进行中 / 已经排着一次返回时忽略。 */
  backBlocked(): boolean {
    return this.pendingBack !== null || this.op?.kind === 'back' || this.queued?.kind === 'back'
  }

  /** 推入期间点返回：已经在推就原地反向，还在等就绪就排队（只记一次），一开推就反向（见 present）。 */
  queueBack(run: () => void): void {
    if (this.op?.reverse) {
      this.op.reverse()
      return
    }
    this.queued = { kind: 'back', run }
  }

  /* ---------------------------------------------------------------- 就绪 */

  /** 提前拿到进入某页要等的东西（懒加载的 chunk）；失败也算完成。 */
  preload(data: T): Promise<void> {
    const loading = this.options.preload?.(data)
    return loading ? loading.then(noop, noop) : Promise.resolve()
  }

  private readyDeadline(): Promise<void> {
    return delay(this.options.readyTimeout ?? NAV_READY_TIMEOUT_MS)
  }

  /** 先等 preload，再挂载 item（pending），再等它的 hold；总上限是同一个 deadline。返回 false 表示等待期间被作废。 */
  private async prepare(item: StackItem<T>, index: () => number, scrollY: number, current: Op): Promise<boolean> {
    const deadline = this.readyDeadline()
    const loading = this.options.preload?.(item.data)
    if (loading) await Promise.race([loading.then(noop, noop), deadline])
    if (current.cancelled) return false
    this.mount(item, index(), 'pending', scrollY)
    if (this.layers.holding(item.key)) await Promise.race([this.layers.whenReady(item.key), deadline])
    return !current.cancelled
  }

  /* ---------------------------------------------------------------- 流程 */

  /**
   * 推入 item（或替换 from）：挂上不可见的新层 → 等它就绪 → 转场 → 新层成为顶层。
   * direction 'back' 的替换（深链里的「返回」）把新层垫在下面、旧页向右滑出；'none' 等就绪后瞬间切换。
   * scrollY 是新层要恢复的滚动位置（浏览器前进到已丢弃的条目时用，普通推入从顶部开始）。
   */
  async present(
    item: StackItem<T>,
    from: StackItem<T>,
    direction: NavigationDirection | 'none',
    replace: boolean,
    scrollY = 0,
  ): Promise<void> {
    const current = this.beginOp('push')
    const below = direction === 'back'
    let transition: NavTransition | null = null
    const index = () => (below ? this.stack.indexOf(from) : this.stack.length)

    const finish = () => {
      if (current.cancelled) return
      transition?.stop()
      if (!this.stack.includes(item)) this.mount(item, index(), 'hidden', 0)
      const el = this.layers.element(item.key)
      this.settle(item, transition && el ? el.scrollTop : 0, replace && this.stack.includes(from) ? [from] : [])
      transition?.cleanup()
      this.endOp(current)
    }
    current.finishNow = finish

    try {
      if (!(await this.prepare(item, index, scrollY, current))) return
      const fromEl = this.layers.element(from.key)
      const toEl = this.layers.element(item.key)
      if (direction === 'none' || !fromEl || !toEl) {
        finish()
        return
      }
      this.layers.setState(from.key, 'moving', window.scrollY)
      // 数据到了内容才够高：按记下的位置再滚一次（普通推入的新页是 0，不受影响）
      this.layers.setState(item.key, 'moving', scrollY)
      this.layers.notify()
      const pushing = createNavTransition({
        over: below ? fromEl : toEl,
        under: below ? toEl : fromEl,
        direction,
      })
      transition = pushing
      if (!replace && !below) {
        current.reverse = () => this.reversePush(current, pushing, item, from, false)
        current.retreat = (hkey) => hkey === from.hkey && this.reversePush(current, pushing, item, from, true)
      }
      // 等就绪时就点了返回：一开推就原地反向（画面还在出发页，不白推一趟）。
      // 交给排着的那次返回自己执行：它看到 op.reverse 就会反向（内存版顺带改 current）
      if (current.reverse && this.queued?.kind === 'back') {
        const queued = this.queued
        this.queued = null
        queued.run()
        if (current.reversed) return
      }
      await pushing.play()
      if (current.reversed) return
      finish()
    } catch (error) {
      // 中途出错（克隆栏失败等）：直接落到终点，层回到静止、ghost / 暗层撤掉，不让页面停在 moving（固定、不可点、滑不动）
      current.finishNow()
      throw error
    }
  }

  /**
   * 推入中途返回：两层从此刻的位置弹簧走回出发前（新页向右滑出）。
   * 应用内返回发起的（popped = false）落定后交给 commitReverse（浏览器版 history.back()，popstate 像右滑完成那样只收尾）；
   * 浏览器后退发起的（地址已经回到出发页）与内存版落定后直接收尾。
   * 期间这个转场算返回：再点返回、再推入都忽略；新页排着的替换作废。返回 true = 已接手。
   */
  reversePush(current: Op, transition: NavTransition, item: StackItem<T>, from: StackItem<T>, popped: boolean): boolean {
    if (current.cancelled || current.reversed) return false
    current.reversed = true
    current.kind = 'back'
    current.reverse = undefined
    if (this.queued?.kind === 'replace') this.queued = null
    let landed = popped || this.commitReverse === null
    // 反向途中浏览器又后退到出发页：地址已经到了，落定后不用再 history.back()
    current.retreat = (hkey) => {
      if (hkey !== from.hkey) return false
      landed = true
      return true
    }
    const land = () => {
      if (current.cancelled) return
      transition.stop()
      const el = this.layers.element(from.key)
      this.settle(from, el ? el.scrollTop : 0, [item])
      transition.cleanup()
      this.endOp(current)
    }
    // 被浏览器去往别处打断：瞬间退回出发页（随后按新地址切换）
    current.finishNow = land
    void transition.retarget(0).then(() => {
      if (current.cancelled) return
      if (landed || !this.commitReverse) {
        land()
        return
      }
      current.retreat = undefined
      this.commitReverse({
        from: item,
        target: from,
        transition,
        op: current,
        // 提交没成（浏览器没响应，地址还在新页）：就让推入落地
        rollback: () => {
          if (current.cancelled) return
          transition.stop()
          this.settle(item, 0)
          transition.cleanup()
          this.endOp(current)
        },
      })
    })
    return true
  }

  /**
   * 带动画的返回：target（不在栈里就先挂上并等就绪）从左侧回来，顶层向右滑出，target 以上的层随后卸载。
   * mountScrollY 是新挂上的 target 要恢复的滚动位置。
   */
  async popAnimated(target: StackItem<T>, mountScrollY = 0): Promise<void> {
    const from = this.top()
    if (target === from) {
      this.settle(from, window.scrollY)
      return
    }
    const current = this.beginOp('back')
    let transition: NavTransition | null = null
    const index = () => this.stack.indexOf(from)

    const finish = () => {
      if (current.cancelled) return
      transition?.stop()
      if (!this.stack.includes(target)) this.mount(target, index(), 'hidden', mountScrollY)
      const el = this.layers.element(target.key)
      const y = transition && el ? el.scrollTop : this.layers.scrollY(target.key)
      this.settle(target, y, this.stack.slice(this.stack.indexOf(target) + 1))
      transition?.cleanup()
      this.endOp(current)
    }
    current.finishNow = finish

    try {
      if (!this.stack.includes(target)) {
        if (!(await this.prepare(target, index, mountScrollY, current))) return
        // 超时先推了：数据晚到时再滚一次（刚挂上时内容不够高，scrollTop 会被截断）
        void this.layers.whenReady(target.key).then(() => this.layers.reapplyScroll(target.key))
      }

      const fromEl = this.layers.element(from.key)
      const toEl = this.layers.element(target.key)
      if (!fromEl || !toEl) {
        finish()
        return
      }
      this.layers.setState(from.key, 'moving', window.scrollY)
      this.layers.setState(target.key, 'moving', this.layers.scrollY(target.key))
      this.layers.notify()
      const leaving = createNavTransition({ over: fromEl, under: toEl, direction: 'back' })
      transition = leaving
      // 返回途中浏览器前进回到出发页：从此刻的位置滑回来（下层留着，状态照旧）
      current.retreat = (hkey) => {
        if (hkey !== from.hkey || current.reversed) return false
        current.reversed = true
        current.retreat = undefined
        const land = () => {
          if (current.cancelled) return
          leaving.stop()
          const el = this.layers.element(from.key)
          this.settle(from, el ? el.scrollTop : 0)
          leaving.cleanup()
          this.endOp(current)
        }
        current.finishNow = land
        void leaving.retarget(0).then(land)
        return true
      }
      await leaving.play()
      if (current.reversed) return
      finish()
    } catch (error) {
      // 中途出错：同上，直接落到终点
      current.finishNow()
      throw error
    }
  }

  /**
   * 瞬间切到 target（浏览器自己的前进 / 后退）：栈里有就用已挂载的页面（状态与滚动位置都在），
   * 没有就按 restoreY 新挂一层，等页面就绪后再恢复离开时的滚动位置（用户已经滚动过就不动）。
   * drop 是随后卸载的层。
   */
  jump(target: StackItem<T>, drop: StackItem<T>[], insertAt: number, restoreY: number): void {
    if (this.stack.includes(target)) {
      this.settle(target, this.layers.scrollY(target.key), drop)
      return
    }
    this.mount(target, insertAt, 'hidden', 0)
    this.settle(target, 0, drop)
    if (restoreY <= 0) return
    void this.layers.whenReady(target.key).then(() => {
      if (this.top() !== target || window.scrollY !== 0) return
      window.scrollTo(0, restoreY)
      this.layers.touch(target.key)
      this.layers.notify()
    })
  }

  /**
   * 开始右滑返回：target 是下层（调用方已确保挂上），两层进入跟手转场。
   * 松手完成时弹簧走到终点后调用 complete(done)，由调用方决定怎么提交（浏览器版等 popstate、内存版直接提交）；
   * 取消时弹簧走回、恢复原状。
   */
  beginSwipe(
    target: StackItem<T>,
    complete: (swipe: PendingBack<T>) => void,
  ): SwipeBackSession | null {
    const from = this.top()
    const fromEl = this.layers.element(from.key)
    const toEl = this.layers.element(target.key)
    if (!fromEl || !toEl) return null

    // 收起键盘（编辑页的辅助栏随之消失）
    const focused = document.activeElement
    if (focused instanceof HTMLElement) focused.blur()

    const current = this.beginOp('back')
    const fromScroll = window.scrollY
    let created: NavTransition | null = null
    try {
      this.layers.setState(from.key, 'moving', fromScroll)
      this.layers.setState(target.key, 'moving', this.layers.scrollY(target.key))
      this.layers.notify()
      created = createNavTransition({ over: fromEl, under: toEl, direction: 'back', interactive: true })
      created.setProgress(0)
    } catch (error) {
      // 建转场出错（克隆栏失败等）：退回原页、层回到静止、撤掉克隆，这次触摸不接管
      created?.stop()
      this.settle(from, fromScroll)
      created?.cleanup()
      this.endOp(current)
      reportError(error)
      return null
    }
    const transition = created

    const rollback = () => {
      if (current.cancelled) return
      transition.stop()
      this.settle(from, fromScroll)
      transition.cleanup()
      this.endOp(current)
    }
    current.finishNow = rollback

    let released = false
    return {
      move: (t) => {
        if (!current.cancelled && !released) transition.setProgress(t)
      },
      active: () => !current.cancelled && !released,
      release: (done, velocity) => {
        if (current.cancelled || released) return
        released = true
        void transition.settle(done ? 1 : 0, velocity).then(() => {
          if (current.cancelled) return
          if (!done) {
            rollback()
            return
          }
          complete({ from, target, transition, op: current, rollback })
        })
      },
    }
  }

  /** 右滑完成 / 推入反向后的提交：画面已经在终点，只切状态。 */
  commitSwipe(swipe: { target: StackItem<T>; transition: NavTransition; op: Op }): void {
    swipe.transition.stop()
    const el = this.layers.element(swipe.target.key)
    const index = this.stack.indexOf(swipe.target)
    this.settle(swipe.target, el ? el.scrollTop : 0, this.stack.slice(index + 1))
    swipe.transition.cleanup()
    this.endOp(swipe.op)
  }
}

function noop(): void {}

/** 报告错误但不打断调用方（没有 reportError 的环境退回 console.error）。 */
function reportError(error: unknown): void {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(error)
  else console.error(error)
}
