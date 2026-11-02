/**
 * 工具栏收纳（移植自 RakkoNotes desktop/toolbarOverflow 的算法）：宽度不够时按优先级把不常用的按钮收进「•••」。
 *
 * 纯函数部分不碰 DOM：每个按钮、常驻段的宽度和两种间距都由调用方传入（按自己的 CSS 尺寸写成常量，不量按钮，
 * 量按钮会让收起来的按钮量不到、来回抖），只给工具栏内容区宽度。
 *
 * 模型：工具栏是 flex 一行，直接子元素（段）之间隔 gap；组内按钮之间隔 inner。组里的按钮全收掉时整组不渲染，
 * 它前面那道段间距一起省掉。成对的按钮（撤销 / 重做）用同一个 id，一起收、一起回来。
 *
 * useToolbarOverflow(ref, segments, gaps) 用 ResizeObserver 订阅工具栏内容宽度，只在收起的集合变了时才重渲染。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export interface ToolbarItem {
  /** 收纳单位；成对的按钮用同一个 id。 */
  id: string
  width: number
  /** 越小越先收；不给 = 一直显示（同组里常驻的按钮，如 •••）。同 id 的取第一个。 */
  priority?: number
}

/** 工具栏的一个直接子元素：常驻的固定宽度（插槽、弹性空白按 0 算），或一组可收的按钮。 */
export type ToolbarSegment = { width: number } | { items: readonly ToolbarItem[] }

export interface ToolbarGaps {
  /** 直接子元素（段）之间的间距（flex gap）。 */
  gap: number
  /** 组内按钮之间的间距。 */
  inner: number
}

/** 某几个 id 收掉之后整排的宽度。 */
export function toolbarWidth(
  segments: readonly ToolbarSegment[],
  hidden: ReadonlySet<string>,
  { gap, inner }: ToolbarGaps,
): number {
  let total = 0
  let children = 0
  for (const segment of segments) {
    if ('width' in segment) {
      total += segment.width
      children += 1
      continue
    }
    let shown = 0
    for (const item of segment.items) {
      if (hidden.has(item.id)) continue
      total += item.width
      shown += 1
    }
    if (shown === 0) continue
    total += inner * (shown - 1)
    children += 1
  }
  return total + gap * Math.max(children - 1, 0)
}

/** 放进 available 宽度要收掉的 id：按优先级从小到大一个个收，直到放得下（都收了还放不下就全收）。 */
export function overflowIds(segments: readonly ToolbarSegment[], available: number, gaps: ToolbarGaps): Set<string> {
  const priority = new Map<string, number>()
  for (const segment of segments) {
    if ('width' in segment) continue
    for (const item of segment.items) {
      if (item.priority !== undefined && !priority.has(item.id)) priority.set(item.id, item.priority)
    }
  }
  const order = [...priority].sort((a, b) => a[1] - b[1]).map(([id]) => id)
  const hidden = new Set<string>()
  for (const id of order) {
    if (toolbarWidth(segments, hidden, gaps) <= available) break
    hidden.add(id)
  }
  return hidden
}

/** 两个 id 集合成员是否相同。 */
export function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

/** 段的排布可以随可用宽度变（例如窄于某阈值时两组合并成一个按钮，阈值与 CSS 容器查询保持一致）。 */
export type ToolbarLayout = readonly ToolbarSegment[] | ((available: number) => readonly ToolbarSegment[])

function solve(segments: ToolbarLayout, available: number, gaps: ToolbarGaps): Set<string> {
  return overflowIds(typeof segments === 'function' ? segments(available) : segments, available, gaps)
}

/** 元素内容区宽度（去掉左右 padding）：ResizeObserver 回调之前的首次估算。 */
function contentWidth(el: HTMLElement): number {
  const style = getComputedStyle(el)
  return el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
}

/**
 * 订阅 ref 元素（工具栏本身）的内容宽度，返回要收进 ••• 的 id 集合；集合没变时返回同一个对象（不重渲染）。
 * segments / gaps 每次渲染都可以是新对象：按最近一次量到的宽度重算，结果相同就不更新。
 */
export function useToolbarOverflow(
  ref: RefObject<HTMLElement | null>,
  segments: ToolbarLayout,
  gaps: ToolbarGaps,
): ReadonlySet<string> {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const width = useRef<number | null>(null)
  const latest = useRef({ segments, gaps })

  useLayoutEffect(() => {
    latest.current = { segments, gaps }
    if (width.current === null) return
    const next = solve(segments, width.current, gaps)
    setHidden((prev) => (sameIds(prev, next) ? prev : next))
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (available: number) => {
      width.current = available
      const next = solve(latest.current.segments, available, latest.current.gaps)
      setHidden((prev) => (sameIds(prev, next) ? prev : next))
    }
    update(contentWidth(el))
    if (typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) update(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return hidden
}
