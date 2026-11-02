import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../button/button'
import { cx } from '../cx'
import { SPRINGS, prefersReducedMotion, springEasing } from '../spring'
import type { SpringSpec } from '../spring'

export interface MorphSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 被点开的卡片：sheet 从它的位置和圆角长出来，关闭时缩回去；打开期间它本身隐藏。 */
  origin: RefObject<HTMLElement | null>
  /** 背后要「退后」的页面容器（缩小下移、被遮罩压暗）；不给就只有遮罩。 */
  recede?: RefObject<HTMLElement | null>
  'aria-label'?: string
  'aria-labelledby'?: string
  /** 顶栏右侧关闭按钮的文字，默认「完成」 */
  closeLabel?: string
  className?: string
  children: ReactNode
}

interface Inset {
  top: number
  right: number
  bottom: number
  left: number
}

/** sheet 顶边离视口顶部的距离：露出一条退后的页面，抓手才有意义。与 CSS 同步。 */
const SHEET_TOP = 44
const SHEET_MAX_WIDTH = 720
const SHEET_RADIUS = 22
/** 关闭比打开稍快一点 */
const CLOSE_SPRING: SpringSpec = { response: 0.7, damping: 1 }
const RECEDE_SCALE = 0.92
const RECEDE_SHIFT = 14

/** 根节点滚动锁：计数式，多个 sheet / 嵌套弹层按任意顺序关闭都能还原成最初的值。 */
let lockCount = 0
let lockedFrom = ''

function lockScroll(): void {
  if (lockCount === 0) {
    lockedFrom = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
  }
  lockCount += 1
}

function unlockScroll(): void {
  if (lockCount === 0) return
  lockCount -= 1
  if (lockCount === 0) document.documentElement.style.overflow = lockedFrom
}

/** 不 inert 的 body 子节点：自带 live region 的宿主（Snackbar 等），否则 sheet 里弹的提示点不到、读屏也读不到。 */
function keepInteractive(el: Element): boolean {
  return el.matches('[aria-live], [data-rk-overlay-host]') || el.querySelector('[aria-live]') !== null
}

function clip(inset: Inset, radius: number): string {
  return `inset(${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px round ${radius}px)`
}

function sheetInset(width: number): Inset {
  const side = Math.max(0, (width - SHEET_MAX_WIDTH) / 2)
  return { top: SHEET_TOP, right: side, bottom: 0, left: side }
}

/** 没有 WAAPI（jsdom、老浏览器）时返回 null，调用方直接落到终态。 */
function fx(el: Element, frames: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  return typeof el.animate === 'function' ? el.animate(frames, options) : null
}

function play(el: Element, frames: Keyframe[], spring: SpringSpec, extra: KeyframeAnimationOptions = {}): Animation | null {
  const { easing, durationMs } = springEasing(spring)
  return fx(el, frames, { duration: durationMs, easing, ...extra })
}

function settle(animation: Animation | null): Promise<void> {
  if (animation === null) return Promise.resolve()
  return animation.finished.then(
    () => undefined,
    () => undefined,
  )
}

function cancelAll(el: Element | null | undefined): void {
  if (el === null || el === undefined || typeof el.getAnimations !== 'function') return
  for (const animation of el.getAnimations()) animation.cancel()
}

/**
 * 卡片原地展开成 sheet（App Store Today 式共享元素过渡）：
 *  - 打开：裁剪框从卡片的位置和圆角长成 sheet，内容从卡片位置滑上来；背后页面以视口顶边为轴
 *    缩小、下移一点并压暗，从 sheet 上方那条缝里露出来。曲线是 gentle 弹簧（慢、不回弹）。
 *  - 关闭：反向缩回卡片；途中真卡片在框下面渐显、框在最后一段淡出，不会出现空框再闪出卡片。
 *  - 往下拖（内容滚到顶时）跟手，拖够远或甩得够快就关，否则弹回；点上方那条、按 Escape 也关。
 *  - 打开期间锁住页面滚动，页面其余部分 inert；焦点进 sheet，关闭后回到卡片。
 *  - reduced-motion：没有形变和位移，只做很短的淡入淡出。
 * 材质用实色 paper 而不是玻璃：要和卡片连续地「长」出来，半透明会穿帮。
 */
export function MorphSheet({
  open,
  onOpenChange,
  origin,
  recede,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  closeLabel = '完成',
  className,
  children,
}: MorphSheetProps) {
  const [mounted, setMounted] = useState(open)
  const host = useRef<HTMLDivElement>(null)
  const dim = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const openRef = useRef(open)
  openRef.current = open
  const from = useRef<{ inset: Inset; radius: number } | null>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const inerted = useRef<Element[]>([])
  const scrollLocked = useRef(false)
  const generation = useRef(0)
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  const close = useCallback(() => onOpenChangeRef.current(false), [])

  if (open && !mounted) setMounted(true)

  /** 页面恢复原状：解锁滚动、去掉 inert、还原卡片和背景。 */
  const restorePage = useCallback(() => {
    if (scrollLocked.current) {
      unlockScroll()
      scrollLocked.current = false
    }
    for (const el of inerted.current) el.removeAttribute('inert')
    inerted.current = []
    const back = recede?.current
    if (back) {
      cancelAll(back)
      back.style.scale = ''
      back.style.translate = ''
      back.style.transformOrigin = ''
    }
    if (origin.current) origin.current.style.opacity = ''
  }, [origin, recede])

  useLayoutEffect(() => {
    if (!mounted) return
    const p = panel.current
    const c = content.current
    const d = dim.current
    if (p === null || c === null || d === null) return
    const reduced = prefersReducedMotion() || typeof p.animate !== 'function'
    generation.current += 1
    const token = generation.current

    if (open) {
      // ---------------------------------------------------------------- 打开
      if (restoreFocus.current === null && document.activeElement instanceof HTMLElement) {
        restoreFocus.current = document.activeElement
      }
      if (!scrollLocked.current) {
        lockScroll()
        scrollLocked.current = true
      }
      if (inerted.current.length === 0) {
        for (const el of Array.from(document.body.children)) {
          if (el !== host.current && !el.hasAttribute('inert') && !keepInteractive(el)) {
            el.setAttribute('inert', '')
            inerted.current.push(el)
          }
        }
      }
      const box = p.getBoundingClientRect()
      const card = origin.current
      // 先停掉卡片上的按压回弹，再量：否则起点是缩小到 0.97 的矩形
      if (card) cancelAll(card)
      if (from.current === null && card) {
        const r = card.getBoundingClientRect()
        from.current = {
          inset: { top: r.top - box.top, left: r.left - box.left, right: box.right - r.right, bottom: box.bottom - r.bottom },
          radius: Number.parseFloat(getComputedStyle(card).borderTopLeftRadius) || 8,
        }
      }
      const target = clip(sheetInset(box.width), SHEET_RADIUS)
      const fromClip = getComputedStyle(p).clipPath
      const fromOpacity = getComputedStyle(p).opacity
      cancelAll(p)
      cancelAll(c)
      p.style.clipPath = target
      p.style.opacity = ''
      d.style.opacity = '1'
      c.focus({ preventScroll: true })

      if (reduced || from.current === null) {
        fx(p, [{ opacity: fromOpacity === '1' ? 0 : fromOpacity }, { opacity: 1 }], { duration: 140 })
        fx(d, [{ opacity: 0 }, { opacity: 1 }], { duration: 140 })
        if (card) card.style.opacity = '0'
        return
      }
      const start = fromClip !== 'none' && fromClip !== '' ? fromClip : clip(from.current.inset, from.current.radius)
      play(p, [{ clipPath: start }, { clipPath: target }], SPRINGS.gentle)
      play(c, [{ translate: `0 ${from.current.inset.top - SHEET_TOP}px` }, { translate: '0 0' }], SPRINGS.gentle)
      fx(c, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 40, fill: 'backwards' })
      fx(d, [{ opacity: 0 }, { opacity: 1 }], { duration: 320 })
      if (card) {
        cancelAll(card)
        card.style.opacity = '0'
      }
      const back = recede?.current
      if (back) {
        const current = getComputedStyle(back)
        const fromScale = current.scale === 'none' ? '1' : current.scale
        const fromTranslate = current.translate === 'none' ? '0 0' : current.translate
        cancelAll(back)
        back.style.transformOrigin = `50% ${-back.getBoundingClientRect().top}px`
        back.style.scale = String(RECEDE_SCALE)
        back.style.translate = `0 ${RECEDE_SHIFT}px`
        play(
          back,
          [
            { scale: fromScale, translate: fromTranslate },
            { scale: String(RECEDE_SCALE), translate: `0 ${RECEDE_SHIFT}px` },
          ],
          SPRINGS.gentle,
        )
      }
      return
    }

    // ---------------------------------------------------------------- 关闭
    const card = origin.current
    const finish = (): void => {
      if (token !== generation.current) return
      restorePage()
      from.current = null
      setMounted(false)
      const focusTarget = restoreFocus.current
      restoreFocus.current = null
      focusTarget?.focus({ preventScroll: true })
    }
    const fromClip = getComputedStyle(p).clipPath
    const fromTranslate = getComputedStyle(p).translate
    const fromScale = getComputedStyle(p).scale
    const fromDim = getComputedStyle(d).opacity
    cancelAll(p)
    cancelAll(d)
    p.style.translate = ''
    p.style.scale = ''
    d.style.opacity = '0'
    fx(d, [{ opacity: fromDim }, { opacity: 0 }], { duration: reduced ? 140 : 280 })

    if (reduced || from.current === null) {
      if (card) card.style.opacity = ''
      void settle(fx(p, [{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' })).then(finish)
      return
    }
    const target = clip(from.current.inset, from.current.radius)
    p.style.clipPath = target
    const shrink = play(
      p,
      [
        {
          clipPath: fromClip === 'none' ? clip(sheetInset(p.getBoundingClientRect().width), SHEET_RADIUS) : fromClip,
          translate: fromTranslate === 'none' ? '0 0' : fromTranslate,
          scale: fromScale === 'none' ? '1' : fromScale,
        },
        { clipPath: target, translate: '0 0', scale: '1' },
      ],
      CLOSE_SPRING,
    )
    fx(c, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' })
    // 交接：真卡片在缩回的框下面渐显，框在最后一段淡掉
    const handoff = springEasing(CLOSE_SPRING).durationMs * 0.8
    if (card) {
      cancelAll(card)
      card.style.opacity = ''
      fx(card, [{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], { duration: handoff })
    }
    fx(p, [{ opacity: 1 }, { opacity: 1, offset: 0.55 }, { opacity: 0 }], { duration: handoff, fill: 'forwards' })
    const back = recede?.current
    if (back) {
      const current = getComputedStyle(back)
      const fromBackScale = current.scale === 'none' ? '1' : current.scale
      const fromBackTranslate = current.translate === 'none' ? '0 0' : current.translate
      cancelAll(back)
      back.style.scale = ''
      back.style.translate = ''
      play(back, [{ scale: fromBackScale, translate: fromBackTranslate }, { scale: '1', translate: '0 0' }], CLOSE_SPRING)
    }
    void settle(shrink).then(finish)
  }, [open, mounted, origin, recede, restorePage])

  // 卸载（比如路由切走）时别把页面留在锁住 / inert 的状态
  useEffect(
    () => () => {
      restorePage()
      const focusTarget = restoreFocus.current
      if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true })
    },
    [restorePage],
  )

  // Escape 关闭；窗口尺寸变化时 sheet 跟着重新居中
  useEffect(() => {
    if (!mounted) return
    const onKey = (event: KeyboardEvent): void => {
      // 里面的 Select / Popover 等先处理自己的 Escape（会 preventDefault），轮不到 sheet
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const active = document.activeElement
      if (active === null || active === document.body || host.current?.contains(active)) close()
    }
    const onResize = (): void => {
      const p = panel.current
      if (p !== null && open) p.style.clipPath = clip(sheetInset(p.getBoundingClientRect().width), SHEET_RADIUS)
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [mounted, open, close])

  useDragToDismiss(scroller, bar, panel, open && mounted, openRef, close)

  if (!mounted || typeof document === 'undefined') return null

  return createPortal(
    <div ref={host} className={cx('rk-morph-sheet', className)}>
      <div ref={dim} className="rk-morph-sheet__dim" onClick={close} aria-hidden="true" />
      <div ref={panel} className="rk-morph-sheet__panel">
        <div
          ref={content}
          className="rk-morph-sheet__content"
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          tabIndex={-1}
        >
          <div ref={bar} className="rk-morph-sheet__bar">
            <span className="rk-morph-sheet__handle" aria-hidden="true" />
            <Button variant="ghost" className="rk-morph-sheet__close" onClick={close}>
              {closeLabel}
            </Button>
          </div>
          <div ref={scroller} className="rk-morph-sheet__scroll">
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * 往下拖关闭。触摸：内容滚到顶时从任意位置接管（touch 事件，要能截住原生滚动）；
 * 鼠标：只从顶栏（抓手那一条）拖，免得和选字冲突。跟手时整块 sheet 下移并缩小一点；
 * 松手拖够 110px 或速度 > 700px/s 就关，否则弹回。
 */
function useDragToDismiss(
  scroller: RefObject<HTMLDivElement | null>,
  bar: RefObject<HTMLDivElement | null>,
  panel: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  openRef: RefObject<boolean>,
  close: () => void,
): void {
  useEffect(() => {
    const el = scroller.current
    const handle = bar.current
    if (!enabled || el === null || handle === null) return
    let start: { x: number; y: number } | null = null
    let active = false
    let dy = 0
    let samples: { t: number; y: number }[] = []
    /** 鼠标从顶栏拖：不看内容滚动位置 */
    let fromBar = false

    const begin = (x: number, y: number, viaBar: boolean): void => {
      start = { x, y }
      active = false
      fromBar = viaBar
      dy = 0
      samples = [{ t: performance.now(), y }]
    }
    const update = (x: number, y: number): boolean => {
      if (start === null) return false
      if (!active && !fromBar && el.scrollTop > 0) {
        // 内容还在滚：起点跟着手指走，滚回顶以后才从这里开始算下拉距离
        start = { x, y }
        samples = [{ t: performance.now(), y }]
        return false
      }
      const nextDy = y - start.y
      if (!active) {
        if (nextDy > 6 && nextDy > Math.abs(x - start.x)) active = true
        else if (Math.abs(x - start.x) > 6 || nextDy < -6) {
          start = null
          return false
        } else return false
      }
      dy = Math.max(0, nextDy)
      samples.push({ t: performance.now(), y })
      if (samples.length > 12) samples.shift()
      const p = panel.current
      if (p !== null) {
        cancelAll(p)
        p.style.translate = `0 ${dy * 0.5}px`
        p.style.scale = String(1 - Math.min(1, dy / 600) * 0.2)
      }
      return true
    }
    const springBack = (): void => {
      const p = panel.current
      if (p === null) return
      const fromTranslate = getComputedStyle(p).translate
      const fromScale = getComputedStyle(p).scale
      p.style.translate = ''
      p.style.scale = ''
      if (!prefersReducedMotion()) {
        play(p, [{ translate: fromTranslate, scale: fromScale }, { translate: '0 0', scale: '1' }], SPRINGS.smooth)
      }
    }
    const finish = (): void => {
      if (!active) {
        start = null
        return
      }
      active = false
      start = null
      const last = samples[samples.length - 1]
      const first = samples.find((s) => last !== undefined && last.t - s.t <= 100) ?? samples[0]
      const velocity =
        last !== undefined && first !== undefined && last.t > first.t && performance.now() - last.t < 80
          ? ((last.y - first.y) / (last.t - first.t)) * 1000
          : 0
      // 吞掉松手后浏览器补发的 click，免得拖动被当成点了 sheet 里的东西
      const block = (event: Event): void => {
        event.stopPropagation()
        event.preventDefault()
      }
      window.addEventListener('click', block, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', block, { capture: true }), 0)
      if (dy > 110 || velocity > 700) {
        close()
        // 父组件没接受关闭（open 还是 true）：别把 sheet 留在拖了一半的样子
        requestAnimationFrame(() => {
          if (openRef.current) springBack()
        })
        return
      }
      springBack()
    }

    const onTouchStart = (event: TouchEvent): void => {
      const touch = event.touches[0]
      if (touch !== undefined && event.touches.length === 1) begin(touch.clientX, touch.clientY, false)
    }
    const onBarTouchStart = (event: TouchEvent): void => {
      const touch = event.touches[0]
      if (touch !== undefined && event.touches.length === 1) begin(touch.clientX, touch.clientY, true)
    }
    const onTouchMove = (event: TouchEvent): void => {
      const touch = event.touches[0]
      if (touch !== undefined && update(touch.clientX, touch.clientY) && event.cancelable) event.preventDefault()
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return
      // 顶栏上的「完成」按钮照常点击，不当拖动起点
      if ((event.target as Element | null)?.closest('button')) return
      begin(event.clientX, event.clientY, true)
      try {
        handle.setPointerCapture(event.pointerId)
      } catch {
        // 指针已经没了
      }
      const onMove = (move: PointerEvent): void => {
        update(move.clientX, move.clientY)
      }
      const onUp = (): void => {
        finish()
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', onUp)
        handle.removeEventListener('pointercancel', onUp)
        handle.removeEventListener('lostpointercapture', onUp)
      }
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', onUp)
      handle.addEventListener('pointercancel', onUp)
      handle.addEventListener('lostpointercapture', onUp)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', finish)
    el.addEventListener('touchcancel', finish)
    handle.addEventListener('touchstart', onBarTouchStart, { passive: true })
    handle.addEventListener('touchmove', onTouchMove, { passive: false })
    handle.addEventListener('touchend', finish)
    handle.addEventListener('touchcancel', finish)
    handle.addEventListener('pointerdown', onPointerDown)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', finish)
      el.removeEventListener('touchcancel', finish)
      handle.removeEventListener('touchstart', onBarTouchStart)
      handle.removeEventListener('touchmove', onTouchMove)
      handle.removeEventListener('touchend', finish)
      handle.removeEventListener('touchcancel', finish)
      handle.removeEventListener('pointerdown', onPointerDown)
    }
  }, [scroller, bar, panel, enabled, openRef, close])
}
