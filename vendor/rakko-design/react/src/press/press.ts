import { SPRINGS, prefersReducedMotion, springEasing } from '../spring'

/**
 * 按压反馈：给整块可点的表面（卡片、磁贴、列表行）加 `data-press`，
 * 按下时缩到 `--press-scale`，松开用 snappy 弹簧平稳回位、不回弹。
 * 没设 `--press-scale` 时：大表面（行、卡片）0.96；`data-press="small"`（小按钮 / 图标）0.92，更夸张。
 * 取值移植自 RakkoNotes 的全局按压反馈（96552d4）。
 *
 * 只动独立的 `scale` 属性（不碰 `transform` / `transition`），所以不会盖掉组件自己的
 * 过渡，也能和 transform 动画叠加。按到一半松手会从当前缩放接着回去（可打断）。
 * 指针移动超过 10px（开始滚动 / 拖动）就当作取消。reduced-motion 下什么都不做。
 *
 * 与 ripple 一样是委托式的：应用根节点装一次，返回 disposer。
 */
const SELECTOR = '[data-press]'
const CANCEL_DISTANCE = 10
/** 没设 --press-scale 时的默认缩放：大表面 / data-press="small"。 */
export const PRESS_SCALE = 0.96
export const PRESS_SCALE_SMALL = 0.92
const running = new WeakMap<HTMLElement, Animation>()

function isDisabled(el: Element): boolean {
  return el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true'
}

export function pressedScale(el: HTMLElement): number {
  const text = getComputedStyle(el).getPropertyValue('--press-scale').trim()
  let raw = Number.parseFloat(text)
  if (text.endsWith('%')) raw /= 100
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw
  return el.getAttribute('data-press') === 'small' ? PRESS_SCALE_SMALL : PRESS_SCALE
}

function animateScale(el: HTMLElement, to: number): void {
  if (typeof el.animate !== 'function') return
  const current = getComputedStyle(el).scale
  const from = current === '' || current === 'none' ? '1' : current
  running.get(el)?.cancel()
  const { easing, durationMs } = springEasing(SPRINGS.snappy)
  const animation = el.animate([{ scale: from }, { scale: String(to) }], {
    duration: durationMs,
    easing,
    fill: 'forwards',
  })
  running.set(el, animation)
  if (to === 1) {
    // 回到原位后去掉 fill，不在元素上留下动画
    animation.onfinish = () => {
      if (running.get(el) === animation) {
        animation.cancel()
        running.delete(el)
      }
    }
  }
}

export function installPressFeedback(root: Document | HTMLElement = document): () => void {
  let pressed: HTMLElement | null = null
  let startX = 0
  let startY = 0

  const release = (): void => {
    if (pressed === null) return
    animateScale(pressed, 1)
    pressed = null
  }

  const onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent
    if (pointer.button !== 0 || prefersReducedMotion()) return
    const surface = (pointer.target as Element | null)?.closest?.(SELECTOR)
    if (!(surface instanceof HTMLElement) || isDisabled(surface)) return
    release()
    pressed = surface
    startX = pointer.clientX
    startY = pointer.clientY
    animateScale(surface, pressedScale(surface))
  }

  const onPointerMove = (event: Event): void => {
    if (pressed === null) return
    const pointer = event as PointerEvent
    if (Math.hypot(pointer.clientX - startX, pointer.clientY - startY) > CANCEL_DISTANCE) release()
  }

  const target = root as EventTarget
  const view = (root instanceof Document ? root.defaultView : root.ownerDocument.defaultView) ?? window
  target.addEventListener('pointerdown', onPointerDown)
  view.addEventListener('pointermove', onPointerMove, { passive: true })
  view.addEventListener('pointerup', release)
  view.addEventListener('pointercancel', release)
  view.addEventListener('blur', release)
  return () => {
    release()
    target.removeEventListener('pointerdown', onPointerDown)
    view.removeEventListener('pointermove', onPointerMove)
    view.removeEventListener('pointerup', release)
    view.removeEventListener('pointercancel', release)
    view.removeEventListener('blur', release)
  }
}
