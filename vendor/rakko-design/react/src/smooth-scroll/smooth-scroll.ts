/**
 * 程序触发的弹簧滚动（移植自 RakkoNotes editor/smoothScroll 的滚动内核，去掉了 ProseMirror 光标 / 选区部分）。
 *
 * smoothScrollTo(target, top) 把滚动容器（或页面本身 window）的竖直位置用弹簧滚到 top：
 *   - 弹簧逐帧积分（4ms 步长），默认 response 0.4s、临界阻尼（不过冲）；
 *   - 同一个 target 上连续调用（连打回车让光标往下走）只改目标、保留当前速度，不重新起步、不跳；
 *   - 手指 / 鼠标一碰（touchstart / pointerdown / wheel）或按下会滚动的键（方向键、翻页、Home / End、空格；
 *     焦点在输入框 / 可编辑区里时不算）立即停住；滚动位置被别人改了（用户拖滚动条、iOS 键盘弹起时系统把光标顶进视野）
 *     也立即让出，不和它抢；
 *   - 目标按每帧的最大可滚距离钳住，内容变短时不会卡在越界处。
 * 减弱动态效果时瞬间到位。
 */
import { reducedMotionQuery } from '../motion-dom'
import type { SpringSpec } from '../spring'

/** 默认弹簧：response 0.4s、临界阻尼（不过冲）。 */
export const SMOOTH_SCROLL_SPRING: SpringSpec = { response: 0.4, damping: 1 }

export interface SmoothScrollOptions {
  /** 弹簧参数（SwiftUI 语义）。@default SMOOTH_SCROLL_SPRING */
  spring?: SpringSpec
}

export interface SmoothScrollHandle {
  /** 立即停在当前位置（同一 target 上的后续调用共用这一段滚动，cancel 停的是这一段）。 */
  cancel(): void
  /** 滚到目标 resolve true；被打断（cancel、触摸 / 滚轮 / 键盘、别人改了滚动位置）resolve false。不会 reject。 */
  readonly finished: Promise<boolean>
}

/** 积分步长（ms）。 */
const STEP = 4
/** 自己写进去的位置和实际读到的差超过它，就当是别人在滚（px）。 */
const FOREIGN_TOLERANCE = 2
/** 一帧最多积分这么久（ms）：切后台回来不一步跳到终点。 */
const MAX_FRAME = 64

/** 用户按了会让浏览器滚动的键：程序滚动让位。 */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '])

type ScrollTarget = Element | Window

interface Run {
  target: ScrollTarget
  goal: number
  position: number
  velocity: number
  stiffness: number
  friction: number
  /** 上一帧写进去的位置：读到的不一样说明有别人在滚。 */
  written: number
  frame: number
  last: number
  resolve: (done: boolean) => void
  handle: SmoothScrollHandle
}

const runs = new Map<ScrollTarget, Run>()

function isWindow(target: ScrollTarget): target is Window {
  return typeof window !== 'undefined' && target === window
}

function readTop(target: ScrollTarget): number {
  return isWindow(target) ? window.scrollY : target.scrollTop
}

function maxTop(target: ScrollTarget): number {
  if (!isWindow(target)) return target.scrollHeight - target.clientHeight
  const root = document.scrollingElement ?? document.documentElement
  return root.scrollHeight - window.innerHeight
}

function writeTop(target: ScrollTarget, top: number): void {
  if (typeof target.scrollTo === 'function') target.scrollTo({ top, behavior: 'instant' })
  else if (!isWindow(target)) target.scrollTop = top
}

function clampTop(target: ScrollTarget, top: number): number {
  return Math.max(0, Math.min(top, maxTop(target)))
}

/* ------------------------------------------------------------------ 打断 */

function stopAll(): void {
  for (const run of [...runs.values()]) stop(run, false)
}

function onKey(event: Event): void {
  if (!(event instanceof KeyboardEvent) || !SCROLL_KEYS.has(event.key)) return
  const el = event.target
  if (el instanceof HTMLElement && (el.isContentEditable || el.closest('input, textarea, select'))) return
  stopAll()
}

const PASSIVE_CAPTURE = { capture: true, passive: true } as const

function listen(on: boolean): void {
  const method = on ? 'addEventListener' : 'removeEventListener'
  // 手指 / 鼠标 / 滚轮一碰就停（捕获阶段、被动，不影响任何人的事件）
  window[method]('touchstart', stopAll, PASSIVE_CAPTURE)
  window[method]('pointerdown', stopAll, PASSIVE_CAPTURE)
  window[method]('wheel', stopAll, PASSIVE_CAPTURE)
  window[method]('keydown', onKey, PASSIVE_CAPTURE)
}

function stop(run: Run, done: boolean): void {
  if (runs.get(run.target) !== run) return
  cancelAnimationFrame(run.frame)
  runs.delete(run.target)
  if (runs.size === 0) listen(false)
  run.resolve(done)
}

/* ------------------------------------------------------------------ 积分 */

function tick(run: Run, now: number): void {
  if (runs.get(run.target) !== run) return
  if (Math.abs(readTop(run.target) - run.written) > FOREIGN_TOLERANCE) {
    stop(run, false)
    return
  }
  const elapsed = Math.min(MAX_FRAME, now - run.last)
  run.last = now
  const goal = clampTop(run.target, run.goal)
  for (let t = 0; t < elapsed; t += STEP) {
    const dt = Math.min(STEP, elapsed - t) / 1000
    run.velocity += (-run.stiffness * (run.position - goal) - run.friction * run.velocity) * dt
    run.position += run.velocity * dt
  }
  const done = Math.abs(run.position - goal) < 0.5 && Math.abs(run.velocity) < 5
  if (done) run.position = goal
  writeTop(run.target, Math.round(run.position))
  // 浏览器会把越界的位置钳住，按实际读回来的算
  run.written = readTop(run.target)
  if (done) {
    stop(run, true)
    return
  }
  run.frame = requestAnimationFrame((time) => tick(run, time))
}

/**
 * 把 target（滚动容器或 window）的竖直滚动位置弹簧滚到 top。同一 target 上已有滚动在走时只改目标、速度接着用，
 * 返回同一个句柄。减弱动态效果时瞬间到位，返回已完成的句柄。
 */
export function smoothScrollTo(target: ScrollTarget, top: number, options: SmoothScrollOptions = {}): SmoothScrollHandle {
  const existing = runs.get(target)
  if (existing) {
    existing.goal = top
    return existing.handle
  }
  if (reducedMotionQuery()?.matches || typeof requestAnimationFrame !== 'function') {
    writeTop(target, clampTop(target, top))
    return { cancel() {}, finished: Promise.resolve(true) }
  }
  const { response, damping } = options.spring ?? SMOOTH_SCROLL_SPRING
  const position = readTop(target)
  let resolve!: (done: boolean) => void
  const finished = new Promise<boolean>((r) => {
    resolve = r
  })
  const run: Run = {
    target,
    goal: top,
    position,
    velocity: 0,
    stiffness: ((2 * Math.PI) / response) ** 2,
    friction: (4 * Math.PI * damping) / response,
    written: position,
    frame: 0,
    last: performance.now(),
    resolve,
    handle: { cancel: () => stop(run, false), finished },
  }
  if (runs.size === 0) listen(true)
  runs.set(target, run)
  run.frame = requestAnimationFrame((time) => tick(run, time))
  return run.handle
}
