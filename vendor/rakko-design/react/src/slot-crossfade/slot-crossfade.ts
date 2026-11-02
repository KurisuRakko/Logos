/**
 * 栏内插槽的换内容动效（NavigationBar 的左右区、BottomToolbar 的三格），移植自 RakkoNotes 的 slotCrossfade：
 * 同一页里插槽内容换了（进出选择模式「选择」→「完成」、编辑态换按钮），旧内容的克隆留在原位淡出、略上移，
 * 新内容从略下方弹簧（SPRINGS.snappy）落位并淡入，不硬切。
 *
 *   const ref = useRef<HTMLDivElement>(null)
 *   useSlotCrossfade(ref)
 *   <div ref={ref} className="my-bar__slot">{children}</div>
 *
 * 插槽的父元素要是定位容器（position: relative），旧内容的克隆按插槽上一次的位置绝对定位在里面。
 * 「换了」按插槽里的子元素个数、文字和 aria-label 判断，按钮禁用 / 按下这类状态变化不算。首次挂载不做动画。
 * 可打断：动画中途又换了，新内容从此刻的透明度 / 位移接着走，旧克隆从此刻的透明度接着淡出。
 * 减弱动态效果：不留旧克隆、不位移，新内容只用 state 时长淡入。
 *
 * 性能：栏每次挂载、重渲染都会走这里（导航转场里很频繁）。首次挂载和内容没换时不当场量位置
 * （那会强制刷样式和布局），交给一次性的 IntersectionObserver：浏览器下一帧自己排版时顺带给出矩形，不额外重排；
 * 进场动画自己记账，不调 getAnimations()。内容真换了的那一次仍当场量（要的是动画开始前、不带位移的位置）。
 */
import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { MOTION } from '../motion'
import { SPRINGS, prefersReducedMotion, springEasing } from '../spring'

/** 换内容时的位移（px）：新内容从下方这么远落位，旧内容往上移这么远淡出。 */
export const SLOT_CROSSFADE_SHIFT = 4

interface Snapshot {
  signature: string
  clone: HTMLElement
  left: number
  top: number
  width: number
  height: number
}

/** 首次挂载后、快照还没拍到时只记内容标识。 */
type Taken = Snapshot | { signature: string; clone: null }

function signatureOf(slot: HTMLElement): string {
  const labels = Array.from(slot.querySelectorAll('[aria-label]'), (el) => el.getAttribute('aria-label'))
  return `${slot.childElementCount}|${slot.textContent ?? ''}|${labels.join('\u0000')}`
}

function snapshot(slot: HTMLElement): Snapshot | null {
  const parent = slot.parentElement
  if (!parent) return null
  return shoot(slot, parent, slot.getBoundingClientRect(), parent.getBoundingClientRect())
}

/** 按给定的插槽 / 父元素矩形拍快照（克隆当前内容）。 */
function shoot(slot: HTMLElement, parent: HTMLElement, rect: DOMRectReadOnly, base: DOMRectReadOnly): Snapshot {
  const clone = slot.cloneNode(true) as HTMLElement
  // 克隆只是画面：不可聚焦、不进无障碍树、不留重复 id；也不算栏的部件（导航栈克隆栏时按 data-rk-nav-part 找真部件）
  clone.removeAttribute('id')
  clone.removeAttribute('data-rk-nav-part')
  for (const el of clone.querySelectorAll('[id]')) el.removeAttribute('id')
  clone.setAttribute('aria-hidden', 'true')
  clone.inert = true
  return {
    signature: signatureOf(slot),
    clone,
    left: rect.left - base.left - parent.clientLeft,
    top: rect.top - base.top - parent.clientTop,
    width: rect.width,
    height: rect.height,
  }
}

/** 旧内容的克隆：用内联 transition 淡出（不用 WAAPI），导航转场克隆整条栏时拷到的是终值（透明），不会把旧内容带过去。 */
function fadeOutGhost(snap: Snapshot, parent: HTMLElement, from: { opacity: number; transform: string }): void {
  const ghost = snap.clone
  const spring = springEasing(SPRINGS.snappy)
  Object.assign(ghost.style, {
    position: 'absolute',
    left: `${snap.left}px`,
    top: `${snap.top}px`,
    width: `${snap.width}px`,
    height: `${snap.height}px`,
    margin: '0',
    pointerEvents: 'none',
    opacity: String(from.opacity),
    transform: from.transform,
    translate: 'none',
    transition: 'none',
  })
  parent.append(ghost)
  void ghost.offsetWidth
  ghost.style.transition = [
    `opacity ${MOTION.durationExitMs}ms ${MOTION.easeStandard}`,
    `translate ${spring.durationMs}ms ${spring.easing}`,
  ].join(', ')
  ghost.style.opacity = '0'
  ghost.style.translate = `0 ${-SLOT_CROSSFADE_SHIFT}px`
  // 透明度先走完就可以拿掉了；再兜一个定时，免得 transitionend 没来（标签页在后台等）留下残影
  const remove = () => ghost.remove()
  ghost.addEventListener('transitionend', (event) => {
    if (event.target === ghost && event.propertyName === 'opacity') remove()
  })
  window.setTimeout(remove, MOTION.durationExitMs + 100)
}

/**
 * 不强制重排地量插槽和父元素：一次性 IntersectionObserver，首个回调里带着浏览器这一帧排版算出的矩形。
 * 返回取消函数。不支持时退回当场量。
 */
function measureLater(slot: HTMLElement, done: (rect: DOMRectReadOnly, base: DOMRectReadOnly) => void): () => void {
  const parent = slot.parentElement
  if (!parent) return () => {}
  if (typeof IntersectionObserver !== 'function') {
    done(slot.getBoundingClientRect(), parent.getBoundingClientRect())
    return () => {}
  }
  const observer = new IntersectionObserver((entries) => {
    observer.disconnect()
    const rect = entries.find((entry) => entry.target === slot)?.boundingClientRect
    const base = entries.find((entry) => entry.target === parent)?.boundingClientRect
    if (rect && base) done(rect, base)
  })
  observer.observe(slot)
  observer.observe(parent)
  return () => observer.disconnect()
}

const isRunning = (animation: Animation) => animation.playState === 'running' || animation.playState === 'paused'

/** 插槽内容换了就交叉淡化 + 小位移弹簧（见文件头）。ref 指向插槽元素，它的父元素要是定位容器。 */
export function useSlotCrossfade(ref: RefObject<HTMLElement | null>): void {
  const last = useRef<Taken | null>(null)
  /** 进行中的进场动画（淡入 + 落位）：代替 slot.getAnimations()。 */
  const entering = useRef<Animation[]>([])
  /** 还没回来的快照（measureLater 的取消函数）。 */
  const pending = useRef<(() => void) | null>(null)

  const cancelPending = () => {
    pending.current?.()
    pending.current = null
  }
  useLayoutEffect(() => cancelPending, [])

  const isEntering = () => entering.current.some(isRunning)
  /** 下一帧补拍快照：那时内容没变、进场动画没在走（矩形不带位移）才收下。 */
  const refresh = (slot: HTMLElement) => {
    pending.current = measureLater(slot, (rect, base) => {
      pending.current = null
      const current = last.current
      const parent = slot.parentElement
      if (!slot.isConnected || !parent || !current || current.signature !== signatureOf(slot) || isEntering()) return
      last.current = shoot(slot, parent, rect, base)
    })
  }

  // 不给依赖：每次渲染后都比一次（插槽内容是 ReactNode，引用每次都变，只能看渲染结果）
  useLayoutEffect(() => {
    const slot = ref.current
    if (!slot) return
    const prev = last.current
    const signature = signatureOf(slot)
    if (prev && prev.signature === signature) return
    cancelPending()
    if (!prev) {
      // 首次挂载：不做动画，快照只给以后换内容用，下一帧再拍。拍到之前就换了内容（不到一帧、还没画出来）不留克隆
      last.current = { signature, clone: null }
      refresh(slot)
      return
    }
    const next = snapshot(slot)
    last.current = next
    // 没有 WAAPI 的环境（jsdom 等）直接换
    if (!next || !slot.parentElement || typeof slot.animate !== 'function') return

    // 动画中途又换了：上一份内容此刻还没完全落位，它的克隆从此刻的透明度 / 位移接着淡出
    const running = entering.current.filter(isRunning)
    let from = { opacity: 1, transform: 'none' }
    if (running.length) {
      const style = getComputedStyle(slot)
      const opacity = Number.parseFloat(style.opacity)
      from = { opacity: Number.isFinite(opacity) ? opacity : 1, transform: style.transform || 'none' }
    }
    for (const animation of running) animation.cancel()
    entering.current = []

    const reduced = prefersReducedMotion()
    if (!reduced && prev.clone) fadeOutGhost(prev, slot.parentElement, from)

    const fade = slot.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: reduced ? MOTION.durationStateMs : MOTION.durationEnterMs,
      easing: MOTION.easeStandard,
    })
    fade.id = 'rk-slot-in'
    entering.current = [fade]
    if (reduced) return
    const spring = springEasing(SPRINGS.snappy)
    const move = slot.animate([{ transform: `translateY(${SLOT_CROSSFADE_SHIFT}px)` }, { transform: 'none' }], {
      duration: spring.durationMs,
      easing: spring.easing,
    })
    move.id = 'rk-slot-in'
    entering.current.push(move)
  })

  // 内容没换时也要跟上最新的位置 / 画面（按钮启用状态等），下次换内容时克隆的是最近一次的样子。
  // 不当场量：下一帧排版时顺带拍（measureLater）；拍到之前内容又换了就用上一份快照，差的只是这不到一帧里的变化
  useLayoutEffect(() => {
    const slot = ref.current
    const prev = last.current
    if (!slot || !prev || pending.current || prev.signature !== signatureOf(slot)) return
    if (isEntering()) return
    refresh(slot)
  })
}
