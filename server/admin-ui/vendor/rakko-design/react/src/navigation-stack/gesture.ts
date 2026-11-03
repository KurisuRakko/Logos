// 左缘右滑返回（交互式）。NavigationStack 挂载时安装、卸载时摘掉。
// 'standalone'（默认）只在主屏模式启用：那里没有 Safari 自带的边缘手势；浏览器标签页里交给 Safari 自己
// （它触发的 popstate 由 browser.ts 瞬间切换，不叠动画）。'always' 任何环境都启用（桌面触摸模拟调试用）。
//
//   触发：有上一页、没有 dialog / alertdialog / menu 打开时，触摸起点距左缘 ≤ NAV_EDGE_WIDTH；第一次移动是向右的水平意图
//         才接管，接管后阻止纵向滚动（touchmove 非 passive）。起点在边缘区的触摸不交给 SwipeRow 等 pointer 手势。
//   跟手：顶层随手指 1:1 右移，下层从 -30% 线性回到 0，暗层随之变淡（见 transition.ts）。
//   松手：「当前位置 + 速度 × NAV_PROJECTION_MS」过半宽，或向右速度大于 NAV_COMPLETE_VELOCITY 就完成，否则取消；
//         从当前位置弹簧收尾（接上松手速度）。
//         跟手中又落下手指、或 touchend 丢了（下一次 touchstart 到来）时按最后的位置同样收尾；touchcancel 一律退回。
import type { EngineHandle } from './engine'
import { isStandalone } from './system-swipe'

export type EdgeSwipeBackMode = 'standalone' | 'always' | 'off'

/** 起点距左缘的上限（px）。 */
export const NAV_EDGE_WIDTH = 20
/** 判断意图前允许的移动（px）：超过它才决定接管还是放手。 */
export const NAV_DECIDE_DISTANCE = 4
/** 向右速度超过它（px/ms）直接完成。 */
export const NAV_COMPLETE_VELOCITY = 0.5
/** 速度投射的时长（ms）：松手位置 + 速度 × 它 过半宽就完成。 */
export const NAV_PROJECTION_MS = 150
/** 计算速度用的采样窗口（ms）。 */
export const NAV_VELOCITY_WINDOW_MS = 100

/** 有模态 / 菜单打开时不触发（它们自己处理手势与关闭）。 */
function overlayOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null
}

interface Track {
  id: number
  startX: number
  startY: number
  width: number
  session: ReturnType<EngineHandle['beginSwipeBack']>
  samples: { x: number; t: number }[]
}

/** 装一次；返回卸载函数。 */
export function installEdgeSwipeBack(engine: EngineHandle, mode: 'standalone' | 'always'): () => void {
  let track: Track | null = null

  const eligible = (x: number) =>
    x <= NAV_EDGE_WIDTH && (mode === 'always' || isStandalone()) && engine.canSwipeBack() && !overlayOpen()

  // 边缘起手的触摸不让列表行开始自己的滑动（行用 pointer 事件，先于 touch 事件派发）
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch' && eligible(event.clientX)) event.stopPropagation()
  }

  /**
   * 按此刻的位置与速度收尾（松手的同一套规则）。cancel：被系统取消的触摸一律退回。
   * 会话一旦开始就必须收尾：丢下不管的话两层会停在转场中途的 moving 状态（固定、不可点、整页滑不动）。
   */
  const finish = (current: Track, x: number, timeStamp: number, cancel: boolean) => {
    if (track === current) track = null
    const session = current.session
    if (!session) return
    const first = current.samples[0]!
    const elapsed = timeStamp - first.t
    const velocity = elapsed > 0 ? (x - first.x) / elapsed : 0
    const dx = Math.max(0, x - current.startX)
    const complete =
      !cancel && (dx + velocity * NAV_PROJECTION_MS > current.width / 2 || velocity > NAV_COMPLETE_VELOCITY)
    session.release(complete, velocity)
  }

  const onTouchStart = (event: TouchEvent) => {
    // 跟手中又落下手指（第二根手指 / 手掌），或上一次的 touchend 丢了：按上一个触摸最后的位置收尾，不丢下会话
    const previous = track
    if (previous) {
      const last = previous.samples[previous.samples.length - 1]!
      finish(previous, last.x, last.t, false)
    }
    track = null
    if (event.touches.length !== 1) return
    const touch = event.touches[0]!
    if (!eligible(touch.clientX)) return
    track = {
      id: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      width: window.innerWidth,
      session: null,
      samples: [{ x: touch.clientX, t: event.timeStamp }],
    }
  }

  const find = (list: TouchList, id: number): Touch | null => {
    for (const touch of Array.from(list)) if (touch.identifier === id) return touch
    return null
  }

  const onTouchMove = (event: TouchEvent) => {
    const current = track
    if (!current) return
    const touch = find(event.changedTouches, current.id)
    if (!touch) return
    const dx = touch.clientX - current.startX
    const dy = touch.clientY - current.startY
    // 会话已被别处收掉（popstate、浏览器去往别处）：不再拦截这次触摸的滚动
    if (current.session && !current.session.active()) {
      track = null
      return
    }
    if (!current.session) {
      if (Math.abs(dx) < NAV_DECIDE_DISTANCE && Math.abs(dy) < NAV_DECIDE_DISTANCE) return
      // 纵向为主或向左：放手，交给页面滚动
      if (dx <= 0 || Math.abs(dy) >= Math.abs(dx)) {
        track = null
        return
      }
      current.session = engine.beginSwipeBack()
      if (!current.session) {
        track = null
        return
      }
    }
    if (event.cancelable) event.preventDefault()
    current.samples.push({ x: touch.clientX, t: event.timeStamp })
    while (current.samples.length > 2 && event.timeStamp - current.samples[0]!.t > NAV_VELOCITY_WINDOW_MS) {
      current.samples.shift()
    }
    current.session.move(Math.max(0, dx) / current.width)
  }

  const onTouchEnd = (event: TouchEvent) => {
    const current = track
    const touch = current ? find(event.changedTouches, current.id) : null
    if (!current || !touch) return
    finish(current, touch.clientX, event.timeStamp, event.type === 'touchcancel')
  }

  const opts: AddEventListenerOptions = { capture: true }
  window.addEventListener('pointerdown', onPointerDown, opts)
  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
  window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
  window.addEventListener('touchend', onTouchEnd, opts)
  window.addEventListener('touchcancel', onTouchEnd, opts)
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, opts)
    window.removeEventListener('touchstart', onTouchStart, { capture: true })
    window.removeEventListener('touchmove', onTouchMove, { capture: true })
    window.removeEventListener('touchend', onTouchEnd, opts)
    window.removeEventListener('touchcancel', onTouchEnd, opts)
  }
}
