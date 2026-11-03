/**
 * 换值不硬切（移植自 RakkoNotes 的 lists/SwapText、desktop/FadeText 与 lists/hooks 里的 useSwapText / useSwapFade）：
 *
 *   - useSwapText(ref, value)：元素里的文字换了（重命名后的标题、计数、按钮文字）——旧文字的拷贝留在原位淡出，
 *     新文字随后淡入，两段不重叠。拷贝插在元素旁边、按它的 offsetParent 绝对定位，跟着元素一起移动。
 *   - useSwapPresence(ref)：元素整个出现 / 消失与别的内容互换（空状态 ↔ 列表）——卸载时原位留一份拷贝淡出并略收，
 *     同一次提交里挂上的元素等它淡完再淡入（任何一帧只有一层文字）。页面首次渲染、整页卸载不受影响。
 *   - <SwapText value>：包一层 span 的现成组件。mode='sequence'（默认）走 useSwapText；
 *     mode='crossfade' 是两份叠在同一个格子里同时交叉淡化（宽度取两者较宽的，换字过程中不跳；第一次出现也淡入）。
 *
 * 时长：旧内容淡出 = --motion-duration-exit × 0.6（与 AnimatedList 交叉淡化同一个分寸），也是新内容淡入前的等待；
 * 新内容淡入 --motion-duration-enter；消失时的略收用 snappy 弹簧。减弱动态效果时直接换。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { cx } from '../cx'
import { MOTION } from '../motion'
import { reducedMotionQuery } from '../motion-dom'
import { SPRINGS, springEasing } from '../spring'

/** 旧内容淡出时长占 --motion-duration-exit 的比例（同 AnimatedList 的 GHOST_FADE_RATIO）。 */
export const SWAP_FADE_RATIO = 0.6
/** 被替换的内容（useSwapPresence 的卸载拷贝）淡出时收到多大。 */
export const SWAP_SHRINK = 0.96

/** 拷贝上去掉的属性：不被 AnimatedList 量到、不被长按菜单命中、id 不重复。 */
const SCRUB_ATTRS = [
  'id',
  'data-rk-flip-key',
  'data-rk-flip-root',
  'data-rk-flip-collapse',
  'data-context-id',
  'data-context-action',
]

function reduced(): boolean {
  return reducedMotionQuery()?.matches ?? false
}

/** 旧内容淡出的时长，也是新内容淡入前的等待。 */
function swapDelay(): number {
  return Math.round(MOTION.durationExitMs * SWAP_FADE_RATIO)
}

function canAnimate(el: Element): boolean {
  return typeof el.animate === 'function'
}

/** 把拷贝做成不可交互、读屏不读、里面的 CSS 进场动画不重播的静态快照，摆在 box 处。 */
function dressGhost(ghost: HTMLElement, box: { top: number; left: number; width: number; height?: number }): void {
  for (const node of [ghost, ...ghost.querySelectorAll<HTMLElement>('*')]) {
    for (const name of SCRUB_ATTRS) node.removeAttribute(name)
  }
  ghost.classList.add('rk-swap-ghost')
  ghost.dataset.rkSwapGhost = ''
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  Object.assign(ghost.style, {
    position: 'absolute',
    top: `${box.top}px`,
    left: `${box.left}px`,
    width: `${box.width}px`,
    ...(box.height === undefined ? {} : { height: `${box.height}px` }),
    boxSizing: 'border-box',
    margin: '0',
    pointerEvents: 'none',
  })
}

function fadeOutGhost(ghost: HTMLElement, from = 1): void {
  const done = () => ghost.remove()
  ghost
    .animate({ opacity: [from, 0] }, { duration: swapDelay(), easing: MOTION.easeStandard, fill: 'forwards' })
    .finished.then(done, done)
}

function fadeInAfterGhost(el: HTMLElement): void {
  el.animate(
    { opacity: [0, 1] },
    { duration: MOTION.durationEnterMs, delay: swapDelay(), easing: MOTION.easeStandard, fill: 'backwards' },
  )
}

/* ------------------------------------------------------------------ 出现 / 消失互换 */

/** 这一次提交里刚有元素留下了淡出的拷贝：同一次提交里挂上的元素据此等它淡完再淡入。 */
let ghostPending = false

/** 卸载前在原位留一份静态拷贝淡出；拷贝插在原父元素里，父元素一起被卸掉时跟着走。 */
function leavePresenceGhost(el: HTMLElement): void {
  if (!el.isConnected || !el.parentElement || el.offsetWidth === 0 || !canAnimate(el) || reduced()) return
  // 正在淡入 / 淡出到一半的从此刻的不透明度接着淡；读不到（没有样式引擎）按 1
  const raw = getComputedStyle(el).opacity
  const opacity = raw === '' ? 1 : Number(raw)
  if (!(opacity > 0.01)) return
  const ghost = el.cloneNode(true) as HTMLElement
  dressGhost(ghost, { top: el.offsetTop, left: el.offsetLeft, width: el.offsetWidth })
  el.after(ghost)
  ghostPending = true
  queueMicrotask(() => {
    ghostPending = false
  })
  fadeOutGhost(ghost, opacity)
  // 淡出的同时略收（snappy 弹簧）：让位给接替它的内容，不是原地消失
  const { easing, durationMs } = springEasing(SPRINGS.snappy)
  ghost.animate({ scale: [1, SWAP_SHRINK] }, { duration: durationMs, easing, fill: 'forwards' })
}

/**
 * 元素与别的内容互换时不硬切（删掉最后一行后空状态出现、新建第一条后空状态让位）：
 * 卸载时原位留一份拷贝淡出并略收；挂载时若同一次提交里刚有元素淡出，等它淡完再淡入。
 * 拷贝带 data-rk-swap-ghost 与 .rk-swap-ghost。
 */
export function useSwapPresence(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (ghostPending && canAnimate(el) && !reduced()) fadeInAfterGhost(el)
    return () => leavePresenceGhost(el)
  }, [ref])
}

/* ------------------------------------------------------------------ 文字换了 */

interface TextSnapshot {
  clone: HTMLElement
  top: number
  left: number
  width: number
  height: number
}

/**
 * 元素里的文字换了不硬切：旧文字的拷贝留在原位淡出，新文字随后淡入。
 * value 是「内容」的标识（不含搜索高亮这类不算换内容的变化）；首次挂载不动。
 * 渲染时（React 改 DOM 之前）拍下旧内容，layout effect 里插拷贝、起动画。
 */
export function useSwapText(ref: RefObject<HTMLElement | null>, value: string): void {
  const prev = useRef(value)
  const snapshot = useRef<TextSnapshot | null>(null)
  // 渲染期读 DOM 是有意的：这是 React 把旧文字换掉之前最后一次能拍到它的时机
  const el = ref.current
  if (prev.current !== value && el && !snapshot.current && el.isConnected) {
    snapshot.current = {
      clone: el.cloneNode(true) as HTMLElement,
      top: el.offsetTop,
      left: el.offsetLeft,
      width: el.offsetWidth,
      height: el.offsetHeight,
    }
  }
  useLayoutEffect(() => {
    if (prev.current === value) return
    prev.current = value
    const snap = snapshot.current
    snapshot.current = null
    const node = ref.current
    if (!node || !snap || !node.isConnected || snap.width === 0 || !canAnimate(node) || reduced()) return
    const ghost = snap.clone
    dressGhost(ghost, snap)
    node.after(ghost)
    fadeOutGhost(ghost)
    fadeInAfterGhost(node)
  }, [ref, value])
}

/* ------------------------------------------------------------------ 组件 */

export type SwapTextMode = 'sequence' | 'crossfade'

export interface SwapTextProps {
  value: string
  /**
   * 'sequence'：旧字拷贝原位淡出、新字随后淡入（两段不重叠），不改元素自身布局；
   * 'crossfade'：两份叠在同一格子里同时交叉淡化（--motion-duration-state），单行省略号，宽度取较宽者、换字时不跳。
   * @default 'sequence'
   */
  mode?: SwapTextMode
  className?: string
}

/** 一段会变的文字（标题、计数、按钮文字）：换了不硬切。 */
export function SwapText({ value, mode = 'sequence', className }: SwapTextProps) {
  return mode === 'crossfade' ? (
    <CrossfadeText value={value} className={className} />
  ) : (
    <SequenceText value={value} className={className} />
  )
}

function SequenceText({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useSwapText(ref, value)
  return (
    <span ref={ref} className={cx('rk-swap-text', className)}>
      {value}
    </span>
  )
}

/** 连着换只留最近的一份旧字；空串不画旧字；旧字淡完（animationend）就摘掉。 */
function CrossfadeText({ value, className }: { value: string; className?: string }) {
  const [shown, setShown] = useState(value)
  const [leaving, setLeaving] = useState<{ text: string; id: number } | null>(null)
  if (shown !== value) {
    setShown(value)
    setLeaving(shown === '' ? null : { text: shown, id: (leaving?.id ?? 0) + 1 })
  }
  return (
    <span className={cx('rk-swap-text', 'rk-swap-text--crossfade', className)}>
      <span key={`in-${value}`} className="rk-swap-text__in">
        {value}
      </span>
      {leaving ? (
        <span
          key={`out-${leaving.id}`}
          className="rk-swap-text__out"
          aria-hidden="true"
          onAnimationEnd={() => setLeaving((current) => (current?.id === leaving.id ? null : current))}
        >
          {leaving.text}
        </span>
      ) : null}
    </span>
  )
}
