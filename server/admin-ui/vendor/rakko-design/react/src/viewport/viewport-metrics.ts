/**
 * 键盘 / 可见区的纯计算（viewport.ts 用）：读到的尺寸 → 要写到 <html> 上的值，以及和上次相比哪些要写。
 * 不碰 DOM，便于单测。移植自 RakkoNotes f20643c 的 viewportMetrics.ts。
 */

/** 遮挡低于这个值视为没有键盘（工具条、地址栏抖动）。 */
export const KEYBOARD_MIN = 80

export interface ViewportInput {
  /** window.innerHeight（布局视口高度）。 */
  layoutHeight: number
  /** 当前是否有会唤起键盘的文本输入聚焦。 */
  typing: boolean
  /** visualViewport.height；没有 visualViewport（或不必读）时省略。 */
  vvHeight?: number
  /** visualViewport.offsetTop；同上。 */
  vvTop?: number
}

/** 写到 <html> 上的值（px 取整）。 */
export interface ViewportVars {
  inset: number
  top: number
  height: number
  keyboard: boolean
}

export function viewportVars({ layoutHeight, typing, vvHeight, vvTop }: ViewportInput): ViewportVars {
  let top = vvTop === undefined ? 0 : Math.max(0, vvTop)
  let height = vvHeight === undefined ? layoutHeight : vvHeight
  // 没有文本输入聚焦就不会有键盘：残留的 offsetTop / 缩小的高度一律当作 0 遮挡
  if (!typing) {
    top = 0
    height = layoutHeight
  }
  const inset = Math.max(0, Math.round(layoutHeight - height - top))
  return { inset, top: Math.round(top), height: Math.round(height), keyboard: inset > KEYBOARD_MIN }
}

export interface ViewportWrites {
  /** 要 setProperty 的自定义属性（名, 值）。 */
  props: [name: string, value: string][]
  /** 要 toggleAttribute('data-rk-keyboard') 成的状态；null = 不用动。 */
  keyboard: boolean | null
}

/** 只写变了的：根上的继承属性每写一次都让整页样式失效，值没变就一个都不写。prev 为 null（首次）时全写。 */
export function viewportWrites(prev: ViewportVars | null, next: ViewportVars): ViewportWrites {
  const props: [string, string][] = []
  if (prev?.inset !== next.inset) props.push(['--rk-keyboard-inset', `${next.inset}px`])
  if (prev?.top !== next.top) props.push(['--rk-visual-top', `${next.top}px`])
  if (prev?.height !== next.height) props.push(['--rk-visual-height', `${next.height}px`])
  return { props, keyboard: prev?.keyboard === next.keyboard ? null : next.keyboard }
}
