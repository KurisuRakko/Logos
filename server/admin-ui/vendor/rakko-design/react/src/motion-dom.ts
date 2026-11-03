// 动效用的 DOM 小工具（内部模块，不从 index 导出）：带缓存的 :root token 读取、缓存的 reduced-motion 查询、
// FLIP 几何。移植自 RakkoNotes web/src/lists/motion.ts，给 LiftMenu 浮起、FlipList、导航转场这类组件共用。

/* ------------------------------------------------------------------ reduced-motion 查询 */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

let reducedQuery: MediaQueryList | null = null
let reducedSource: typeof window.matchMedia | null = null

/**
 * 缓存的 reduced-motion MediaQueryList（matches 是活的，可以 addEventListener('change')）。
 * window.matchMedia 被换掉（测试打桩）时重新查询；没有 matchMedia 时返回 null。
 */
export function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  if (reducedQuery === null || reducedSource !== window.matchMedia) {
    reducedSource = window.matchMedia
    reducedQuery = window.matchMedia(REDUCED_MOTION)
  }
  return reducedQuery
}

/* ------------------------------------------------------------------ :root token */

/*
 * getComputedStyle(documentElement) 每次都会先把整页挂起的样式算完，动画一多就是一串强制样式刷新，所以缓存读数。
 * token 只在 <html> 的属性变了（data-theme、lang、style / class）、系统明暗或减弱动效切换时才可能变，这些时候清空重读。
 */
const tokenCache = new Map<string, string>()
let watching = false

function clearTokens(): void {
  tokenCache.clear()
}

function watchTokens(): void {
  if (watching) return
  watching = true
  if (typeof MutationObserver === 'function') {
    new MutationObserver(clearTokens).observe(document.documentElement, { attributes: true })
  }
  if (typeof window.matchMedia === 'function') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', clearTokens)
  }
  reducedMotionQuery()?.addEventListener?.('change', clearTokens)
}

/** :root 上自定义属性的计算值（去掉首尾空白），带缓存；没有 document 时返回空串。 */
export function rootToken(name: string): string {
  if (typeof document === 'undefined') return ''
  watchTokens()
  let value = tokenCache.get(name)
  if (value === undefined) {
    value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    // 样式表还没生效时读到空串，不缓存，等下次再读
    if (value) tokenCache.set(name, value)
  }
  return value
}

/**
 * 把 CSS 时间解析成毫秒：'475ms' → 475、'0.475s' → 475（@property 注册为 <time> 的 token 计算值是秒），
 * 无单位按毫秒；解析不了用 fallback。
 */
export function parseTimeMs(value: string, fallback: number): number {
  const n = parseFloat(value)
  if (!Number.isFinite(n)) return fallback
  const unit = value.trim().toLowerCase()
  if (unit.endsWith('ms')) return n
  if (unit.endsWith('s')) return n * 1000
  return n
}

/** 时长 token（如 --motion-spring-smooth-duration）的毫秒数，带缓存；读不到用 fallback。 */
export function rootTimeMs(name: string, fallback: number): number {
  return parseTimeMs(rootToken(name), fallback)
}

/* ------------------------------------------------------------------ FLIP 几何 */

/** 视口坐标的矩形（DOMRect 的子集，自己算出来的位置也用它）。 */
export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** 可视视口尺寸（手机上键盘弹出时比 innerHeight 小）。 */
export function viewportSize(): { width: number; height: number } {
  const vv = window.visualViewport
  return { width: vv?.width ?? window.innerWidth, height: vv?.height ?? window.innerHeight }
}

/**
 * 把 left / top 摆在 at、布局尺寸为 size、transform-origin 为 0 0 的元素变换到 box 的位置和大小。
 * FLIP 的起点、终点都用它写：from → rest 两个 box 各算一次，作为关键帧。
 */
export function boxTransform(
  box: Box,
  at: { left: number; top: number },
  size: { width: number; height: number },
): string {
  return `translate(${box.left - at.left}px, ${box.top - at.top}px) scale(${box.width / size.width}, ${box.height / size.height})`
}

/** 元素此刻的 transform（含进行中的动画）：打断时从这里接着走。 */
export function currentTransform(el: Element): string {
  const value = getComputedStyle(el).transform
  return value && value !== 'none' ? value : 'none'
}

/** 矩形是否还有一部分在可视视口里（飞回去的目标已经滚走 / 被摘掉就不飞了）。 */
export function boxVisible(box: Box): boolean {
  const vp = viewportSize()
  return (
    box.width > 0 &&
    box.top + box.height > 0 &&
    box.left + box.width > 0 &&
    box.top < vp.height &&
    box.left < vp.width
  )
}
