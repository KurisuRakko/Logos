// 导航栈每一层的 DOM、显示状态、滚动位置与就绪登记（一个导航实例一份，见 engine.ts）。
//
// 层状态写在层根元素 .rk-nav-layer 的 data-nav-state 上（样式见 navigation-stack.css）：
//   top      顶层：正常文档流，用 window 滚动，可交互；
//   hidden   下层：display: none + inert，不占布局、不进无障碍树，React 状态保留；
//   pending  刚挂载、等就绪的页面：固定在视口、透明、不可点（有布局，页面能量尺寸、能聚焦）；
//   moving   转场 / 手势进行中：固定在视口，scrollTop = 该页的滚动位置，位移由 transition.ts 写。
// data-nav-state 与 inert 只由这里直接写 DOM，React 不渲染这两个属性，重渲染不会把它们改回去。
//
// 页面经 useNavigationLayer() 拿到所在层的句柄；不在导航栈里渲染时句柄恒为「顶层、用 window 滚动」。
// useNavigationReady(false) 在本层登记一个 hold：推入前栈会等本层所有 hold 解除（有上限）。
//
// 切页时少强制排版：属性只写变了的；pending / moving 的 scrollTop 不在改状态时当场写（写 scrollTop 会强制同步排版，
// 几层一起切状态时每层各排一次），先排进 scrollQueue，notify() 开头在所有状态都写完之后统一写，只排一次版。
// notify(knownWindowY) 期间顶层句柄的 scrollY() 直接用调用方给的 window 位置（刚滚到 0 这类不可能被截断的值），
// 不去读 window.scrollY——刚切完层状态时布局正是脏的，读它会再强制排一次版。
import { createContext, useContext, useLayoutEffect } from 'react'

export type NavigationLayerState = 'top' | 'hidden' | 'pending' | 'moving'

export interface NavigationLayer {
  /** 本层是可交互的顶层（正常文档流、window 滚动属于它）。 */
  isTop(): boolean
  /** 本层当前的状态。 */
  state(): NavigationLayerState
  /** 本页的滚动位置：顶层时就是 window.scrollY，否则是离开顶层时记下 / 转场中设定的值。 */
  scrollY(): number
  /** 层状态变化（含回到顶层、滚动已恢复）时回调；返回取消订阅。 */
  subscribe(listener: () => void): () => void
}

/** notify(knownWindowY) 通知期间 window 的滚动位置；其余时候为 null（照常读 window.scrollY）。 */
let knownWindowScrollY: number | null = null

function windowScrollY(): number {
  return knownWindowScrollY ?? window.scrollY
}

export interface LayerRecord {
  el: HTMLElement | null
  state: NavigationLayerState
  scrollY: number
  listeners: Set<() => void>
  /** 状态变过、还没通知监听者。 */
  dirty: boolean
  /** 未解除的 useNavigationReady(false) 个数。 */
  holds: number
  /** 等 holds 归零的回调。 */
  readyWaiters: Set<() => void>
  handle: NavigationLayer
}

/** 一个导航实例的全部层。 */
export class LayerRegistry {
  private readonly layers = new Map<string, LayerRecord>()
  /** 等着写 scrollTop 的层（状态已写好，见 applyState）。 */
  private readonly scrollQueue = new Set<LayerRecord>()

  /** 挂载前登记一层（NavigationStack 渲染出元素时按这里的状态初始化）。 */
  create(key: string, state: NavigationLayerState, scrollY: number): LayerRecord {
    const record: LayerRecord = {
      el: null,
      state,
      scrollY,
      listeners: new Set(),
      dirty: false,
      holds: 0,
      readyWaiters: new Set(),
      handle: {
        isTop: () => record.state === 'top',
        state: () => record.state,
        scrollY: () => (record.state === 'top' ? windowScrollY() : record.scrollY),
        subscribe: (listener) => {
          record.listeners.add(listener)
          return () => {
            record.listeners.delete(listener)
          }
        },
      },
    }
    this.layers.set(key, record)
    return record
  }

  delete(key: string): void {
    const record = this.layers.get(key)
    if (!record) return
    this.layers.delete(key)
    this.scrollQueue.delete(record)
    // 层卸载了就不会再就绪：放行还在等它的流程（它们醒来后自己判断是否作废）
    const waiters = [...record.readyWaiters]
    record.readyWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  get(key: string): LayerRecord | undefined {
    return this.layers.get(key)
  }

  /**
   * NavigationStack 的 ref 回调：元素挂上 / 摘下。挂上时立即写入状态和滚动位置（在首帧之前）；
   * 新元素的 scrollTop 本来就是 0，要滚到 0 时不写（写了也只是白白强制一次排版）。
   */
  attach(key: string, el: HTMLElement | null): void {
    const record = this.layers.get(key)
    if (!record) return
    if (!el) this.scrollQueue.delete(record)
    record.el = el
    this.apply(record)
    if (!el || !this.scrollQueue.has(record)) return
    this.scrollQueue.delete(record)
    if (record.scrollY !== 0) el.scrollTop = record.scrollY
  }

  element(key: string): HTMLElement | null {
    return this.layers.get(key)?.el ?? null
  }

  /** 该层记着的滚动位置（顶层时以 window 为准）。 */
  scrollY(key: string): number {
    const record = this.layers.get(key)
    if (!record) return 0
    return record.state === 'top' ? windowScrollY() : record.scrollY
  }

  /**
   * 改一层的状态。scrollY 给出时同时记下（pending / moving 的 scrollTop 在 notify() 时统一写下）；
   * 从 top 离开且没给 scrollY 时，先记下当时的 window.scrollY。监听者等 notify() 再统一通知。
   */
  setState(key: string, state: NavigationLayerState, scrollY?: number): void {
    const record = this.layers.get(key)
    if (!record) return
    if (scrollY !== undefined) record.scrollY = scrollY
    else if (record.state === 'top' && state !== 'top') record.scrollY = window.scrollY
    if (record.state !== state) record.dirty = true
    record.state = state
    this.apply(record)
  }

  /** 内容变高之后（数据到了）重新把 pending / moving 层滚到记下的位置（之前可能因为内容不够高被截断）。 */
  reapplyScroll(key: string): void {
    const record = this.layers.get(key)
    if (record && (record.state === 'pending' || record.state === 'moving') && record.el) {
      record.el.scrollTop = record.scrollY
    }
  }

  /** 标记一层要通知（状态没变，但滚动位置刚恢复）。 */
  touch(key: string): void {
    const record = this.layers.get(key)
    if (record) record.dirty = true
  }

  /**
   * 写下排着的滚动位置，再通知所有状态变过的层（在滚动位置恢复之后调用，监听者读到的就是最终状态）。
   * knownWindowY：调用方刚把 window 滚到的、必然准确的位置（见文件头），通知期间句柄的 scrollY() 用它。
   */
  notify(knownWindowY?: number): void {
    this.flushScroll()
    knownWindowScrollY = knownWindowY ?? null
    try {
      for (const record of [...this.layers.values()]) {
        if (!record.dirty) continue
        record.dirty = false
        for (const listener of [...record.listeners]) listener()
      }
    } finally {
      knownWindowScrollY = null
    }
  }

  /** 把状态写到 DOM，只写变了的属性（没变的不再写，免得白白让样式失效）；scrollTop 排进 scrollQueue。 */
  private apply(record: LayerRecord): void {
    const el = record.el
    if (!el) return
    if (el.dataset.navState !== record.state) el.dataset.navState = record.state
    const inert = record.state === 'hidden'
    if (el.inert !== inert) el.inert = inert
    if (record.state === 'pending' || record.state === 'moving') this.scrollQueue.add(record)
    else this.scrollQueue.delete(record)
  }

  /** 把排着的 scrollTop 一起写下去：第一笔触发一次排版，之后的写入不会再让布局失效。 */
  private flushScroll(): void {
    for (const record of this.scrollQueue) {
      if (record.el && (record.state === 'pending' || record.state === 'moving')) record.el.scrollTop = record.scrollY
    }
    this.scrollQueue.clear()
  }

  /** 本层此刻有没有未解除的 hold（挂载用 flushSync，返回之后读它，不会漏掉挂载中登记的）。 */
  holding(key: string): boolean {
    return (this.layers.get(key)?.holds ?? 0) > 0
  }

  /** 等本层的 hold 全部解除；层已删除或本来就没有 hold 时立即兑现。 */
  whenReady(key: string): Promise<void> {
    const record = this.layers.get(key)
    if (!record || record.holds === 0) return Promise.resolve()
    return new Promise((resolve) => record.readyWaiters.add(resolve))
  }
}

/** 登记一个 hold，返回解除函数（只生效一次）。 */
export function holdLayer(record: LayerRecord): () => void {
  record.holds += 1
  let released = false
  return () => {
    if (released) return
    released = true
    record.holds -= 1
    // 推迟到微任务再判断：StrictMode 下 layout effect 会「解除 → 立即重新登记」，
    // 同步判断会在两步之间误判为已就绪。
    queueMicrotask(() => {
      if (record.holds > 0) return
      const waiters = [...record.readyWaiters]
      record.readyWaiters.clear()
      for (const resolve of waiters) resolve()
    })
  }
}

/* ------------------------------------------------------------------ Context */

/** 不在导航栈里时的默认句柄：恒为顶层。 */
const topHandle: NavigationLayer = {
  isTop: () => true,
  state: () => 'top',
  scrollY: () => windowScrollY(),
  subscribe: () => () => {},
}

export const NavigationLayerContext = createContext<LayerRecord | null>(null)

/** 当前页面所在导航层的句柄；不在导航栈里时恒为顶层、用 window 滚动。 */
export function useNavigationLayer(): NavigationLayer {
  return useContext(NavigationLayerContext)?.handle ?? topHandle
}

/**
 * 页面就绪信号：首次渲染传 false 的组件在本层登记一个 hold，推入转场会等到它变成 true
 * （从开始 preload 算起最多 readyTimeout）。数据加载失败也要传 true。组件卸载时自动解除。
 * 不在导航栈里时什么也不做。
 */
export function useNavigationReady(ready: boolean): void {
  const record = useContext(NavigationLayerContext)
  useLayoutEffect(() => {
    if (!record || ready) return
    return holdLayer(record)
  }, [record, ready])
}
