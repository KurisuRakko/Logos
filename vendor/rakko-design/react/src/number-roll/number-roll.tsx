import { useLayoutEffect, useRef } from 'react'
import { cx } from '../cx'
import { SPRINGS, prefersReducedMotion, springEasing } from '../spring'

export interface NumberRollProps {
  /** 已经格式化好的字符串，例如 "$12,480.32"、"+1.24%"、"−0.42%" */
  value: string
  className?: string
}

/** "−" (U+2212) 也当负号；解析不了就当 0（只用来判断滚动方向）。 */
function numeric(value: string): number {
  const parsed = Number(value.replace(/−/g, '-').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 滚动数字：值变化时每一位数字单独上下滚动换成新值（变大往上滚、变小往下滚），
 * 从个位开始依次错开 35ms，曲线是 smooth 弹簧。没变的位不动；位数变化时按右对齐。
 *
 * 格子里的数字由本组件直接操作 DOM，React 只渲染格子本身（按「从右数第几位」做 key）。
 * 读屏读隐藏的完整文本，不读逐位格子。reduced-motion 下直接换字，不滚动。
 */
export function NumberRoll({ value, className }: NumberRollProps) {
  const root = useRef<HTMLSpanElement>(null)
  const previous = useRef(value)
  const chars = Array.from(value)

  useLayoutEffect(() => {
    const el = root.current
    if (el === null) return
    const old = previous.current
    previous.current = value
    const dir = numeric(value) >= numeric(old) ? 1 : -1
    const animate = !prefersReducedMotion()
    const cells = Array.from(el.querySelectorAll<HTMLElement>('[data-r]')).sort(
      (a, b) => Number(a.dataset.r) - Number(b.dataset.r),
    )
    let order = 0
    for (const cell of cells) {
      const want = chars[chars.length - 1 - Number(cell.dataset.r)] ?? ''
      const has = cell.dataset.d
      cell.dataset.d = want
      if (has === want) continue
      if (has === undefined || !animate || typeof cell.animate !== 'function') {
        const span = document.createElement('span')
        span.textContent = want
        cell.replaceChildren(span)
        continue
      }
      roll(cell, want, dir, order)
      order += 1
    }
  })

  return (
    <span ref={root} className={cx('rk-number-roll', className)}>
      <span className="rk-number-roll__text">{value}</span>
      {chars.map((char, index) => {
        const r = chars.length - 1 - index
        return /[0-9]/.test(char) ? (
          // data-c：格子还空着时（SSR、首帧前）由 CSS ::before 显示这一位，不会整串不可见
          <span key={`d${r}`} className="rk-number-roll__digit" data-r={r} data-c={char} aria-hidden="true" />
        ) : (
          <span key={`c${r}-${char}`} aria-hidden="true">
            {char}
          </span>
        )
      })}
    </span>
  )
}

/** 新数字从下（或上）滚进来，旧数字同时滚出去；旧的播完就删。 */
function roll(cell: HTMLElement, to: string, dir: 1 | -1, order: number): void {
  while (cell.children.length > 1) cell.firstElementChild?.remove()
  const old = cell.firstElementChild as HTMLElement | null
  const next = document.createElement('span')
  next.textContent = to
  cell.append(next)
  const { easing, durationMs } = springEasing(SPRINGS.smooth)
  const timing = { duration: durationMs, easing, delay: order * 35 }
  if (old !== null) {
    // 上一次的新数字可能还没滚到位：从它当前的位置接着滚出去，不要跳回原位
    const current = getComputedStyle(old).translate
    for (const animation of old.getAnimations()) animation.cancel()
    const out = old.animate([{ translate: current === 'none' || current === '' ? '0 0' : current }, { translate: `0 ${-dir * 100}%` }], {
      ...timing,
      fill: 'forwards',
    })
    out.onfinish = () => old.remove()
    out.oncancel = () => old.remove()
  }
  next.animate([{ translate: `0 ${dir * 100}%` }, { translate: '0 0' }], { ...timing, fill: 'backwards' })
}
