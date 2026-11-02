// 浏览器标签页里系统自己的边缘手势（Safari 左缘右滑后退 / 右缘左滑前进）：它先播自己的翻页动画、再发 popstate，
// 这时导航栈再做一遍转场就是两遍动画，所以 browser.ts 遇到「刚有触摸从屏幕边缘起手」的 popstate 直接切换（画面已经被系统换过了）。
// 判断靠触摸：起点在左 / 右缘 NAV_SYSTEM_EDGE 内的触摸还按着，或抬起 / 被系统取消不到 NAV_SYSTEM_GRACE_MS。
// 主屏模式（standalone）没有系统手势，恒为 false。
// iOS / iPadOS 的 Safari 标签页：系统手势的触摸根本不发给页面，靠触摸判断不出来（实机会播两遍），
// 所以一律当系统手势——页面外触发的后退 / 前进都直接切换（Rakko 2026-10-22 定）。

/** 系统边缘手势的起手区（px）。 */
export const NAV_SYSTEM_EDGE = 24
/** 边缘触摸结束后多久内的 popstate 仍算系统手势触发的（ms）。 */
export const NAV_SYSTEM_GRACE_MS = 800

let edgeTouches = 0
let lastEdgeEnd = Number.NEGATIVE_INFINITY

export function isStandalone(): boolean {
  return (
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** iPhone / iPad（iPadOS 默认报 Macintosh，靠多点触控区分）。 */
function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

/** 刚才的 popstate 多半是系统边缘手势触发的。 */
export function systemSwipeLikely(): boolean {
  if (isStandalone()) return false
  if (isIOS()) return true
  return edgeTouches > 0 || performance.now() - lastEdgeEnd < NAV_SYSTEM_GRACE_MS
}

/** 装一次（createBrowserNavigation 随 NavigationStack 挂载时）；返回卸载函数。 */
export function installSystemSwipeWatch(): () => void {
  const onStart = (event: TouchEvent) => {
    for (const touch of Array.from(event.changedTouches)) {
      if (touch.clientX <= NAV_SYSTEM_EDGE || touch.clientX >= window.innerWidth - NAV_SYSTEM_EDGE) edgeTouches += 1
    }
  }
  const onEnd = () => {
    if (edgeTouches === 0) return
    edgeTouches = 0
    lastEdgeEnd = performance.now()
  }
  const opts: AddEventListenerOptions = { capture: true, passive: true }
  window.addEventListener('touchstart', onStart, opts)
  window.addEventListener('touchend', onEnd, opts)
  window.addEventListener('touchcancel', onEnd, opts)
  return () => {
    window.removeEventListener('touchstart', onStart, opts)
    window.removeEventListener('touchend', onEnd, opts)
    window.removeEventListener('touchcancel', onEnd, opts)
    edgeTouches = 0
    lastEdgeEnd = Number.NEGATIVE_INFINITY
  }
}
