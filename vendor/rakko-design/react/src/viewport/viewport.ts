/**
 * 键盘 / 可见区追踪：iOS 弹键盘只缩 visualViewport，position: fixed 仍按布局视口定位，
 * 所以弹层要自己知道「可见区在哪」。这里在 <html> 上写：
 *   --rk-keyboard-inset  底部被键盘遮挡的高度（px）
 *   --rk-visual-top      可见区上沿相对布局视口的偏移（px）
 *   --rk-visual-height   可见区高度（px）
 *   data-rk-keyboard     遮挡超过 KEYBOARD_MIN 时存在
 * 样式侧见 dialog.css / sheet.css / snackbar.css（变量都带回退，未安装时表现不变）。
 *
 * Dialog / Sheet 弹层挂载时、Snackbar.Provider 挂载时自动安装（引用计数），应用零配置；
 * 最后一个使用方卸载后摘掉监听并清除变量。移植自 RakkoNotes 9586e27 的实机修复，
 * 决策记录见 docs/2026-10-18-keyboard-avoidance.md。
 *
 * 性能（RakkoNotes f20643c，见 docs/2026-10-24-overlay-motion.md）：这些是根上的继承属性，写一次整页样式失效，
 * 所以只写和上次不同的值，没变就零写入（计算见 viewport-metrics.ts）。读尺寸也会强制布局：没有文本输入聚焦时
 * 结果只取决于 innerHeight，而它只随 resize 变，所以缓存 innerHeight（resize / scroll 事件、focusout 后的补算、
 * 或正在输入时才重读），不在输入时也不读 visualViewport。
 */
import { useLayoutEffect, useSyncExternalStore } from 'react'
import { viewportVars, viewportWrites } from './viewport-metrics'
import type { ViewportVars } from './viewport-metrics'
/** iOS 26 键盘收起后 offsetTop 会残留，focusout 后隔一会儿再算一次。 */
const SETTLE_DELAY = 350

const NON_TEXT_INPUT_TYPES = [
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]

/** 当前是否有会唤起键盘的文本输入聚焦。 */
function isTextInputFocused(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.includes(el.type) && !el.readOnly && !el.disabled
  }
  return false
}

let refCount = 0
let teardown: (() => void) | null = null
let keyboardInset = 0
const listeners = new Set<() => void>()

function setInset(next: number) {
  if (next === keyboardInset) return
  keyboardInset = next
  for (const listener of listeners) listener()
}

function start(): () => void {
  const root = document.documentElement
  let frame = 0
  let settleTimer = 0
  /** 上次写到 <html> 上的值；null = 还没写过（每次安装都从全写开始）。 */
  let written: ViewportVars | null = null
  /** 上次读到的 innerHeight；sizeStale 时（resize / scroll 事件、focusout 后的补算）重读。 */
  let layoutHeight = 0
  let sizeStale = true

  const measure = () => {
    frame = 0
    const typing = isTextInputFocused()
    if (sizeStale || typing) {
      layoutHeight = window.innerHeight
      sizeStale = false
    }
    // 不在输入时 visualViewport 的值反正不用（见 viewportVars），不读
    const vv = typing ? window.visualViewport : null
    const next = viewportVars({ layoutHeight, typing, vvHeight: vv?.height, vvTop: vv?.offsetTop })
    const writes = viewportWrites(written, next)
    written = next
    for (const [name, value] of writes.props) root.style.setProperty(name, value)
    if (writes.keyboard !== null) root.toggleAttribute('data-rk-keyboard', writes.keyboard)
    setInset(next.inset)
  }

  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(measure)
  }

  const resized = () => {
    sizeStale = true
    schedule()
  }

  const onFocusOut = () => {
    schedule()
    window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(resized, SETTLE_DELAY)
  }

  // 卸载时 window.visualViewport 理论上不会换实例，仍按安装时拿到的那个摘
  const vv = window.visualViewport
  vv?.addEventListener('resize', resized)
  vv?.addEventListener('scroll', resized)
  window.addEventListener('resize', resized)
  document.addEventListener('focusin', schedule)
  document.addEventListener('focusout', onFocusOut)
  measure()

  return () => {
    vv?.removeEventListener('resize', resized)
    vv?.removeEventListener('scroll', resized)
    window.removeEventListener('resize', resized)
    document.removeEventListener('focusin', schedule)
    document.removeEventListener('focusout', onFocusOut)
    if (frame) cancelAnimationFrame(frame)
    window.clearTimeout(settleTimer)
    // 清掉变量与属性：CSS 回到回退值，和从未安装时逐像素一致
    root.style.removeProperty('--rk-keyboard-inset')
    root.style.removeProperty('--rk-visual-top')
    root.style.removeProperty('--rk-visual-height')
    root.removeAttribute('data-rk-keyboard')
    setInset(0)
  }
}

/**
 * 安装可见区追踪。幂等、引用计数：每次调用返回各自的卸载函数（重复调用无副作用），
 * 最后一个卸载时才摘监听。没有 window（SSR）时什么都不做。
 */
export function installViewportTracking(): () => void {
  if (typeof window === 'undefined') return () => {}
  refCount += 1
  if (refCount === 1) teardown = start()
  let released = false
  return () => {
    if (released) return
    released = true
    refCount -= 1
    if (refCount === 0) {
      teardown?.()
      teardown = null
    }
  }
}

/**
 * 组件内部用：挂载期间保持追踪安装。用 layout effect：弹层首帧绘制前变量已写好，
 * 键盘已弹出时打开的对话框不会先画在回退位置、再带 top 过渡滑到可见区。
 */
export function useViewportTracking(): void {
  useLayoutEffect(() => installViewportTracking(), [])
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const uninstall = installViewportTracking()
  return () => {
    listeners.delete(listener)
    uninstall()
  }
}

const getSnapshot = () => keyboardInset
const getServerSnapshot = () => 0

/**
 * 键盘遮挡高度（px），与 --rk-keyboard-inset 同源；没有键盘时为 0。
 * 使用期间自动安装追踪。贴键盘的自定义栏可以 translateY(-inset)。
 */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** 弹出不含输入框的 Sheet / Dialog 前调用：收起键盘，和 iOS 行为一致。 */
export function dismissKeyboard(): void {
  if (typeof document === 'undefined') return
  if (isTextInputFocused()) (document.activeElement as HTMLElement).blur()
}
