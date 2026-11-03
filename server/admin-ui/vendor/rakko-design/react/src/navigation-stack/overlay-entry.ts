// 页内浮层（看图、裁剪、全屏编辑这类自己画的覆盖层）的历史条目：打开时 pushState 一个与当前条目一模一样的条目
// （同 state、同地址），安卓返回键 / 浏览器后退先退掉它，popstate 里关浮层（照常播退场动画），不会离开当前页。
//
// 与 createBrowserNavigation 的关系：它的 popstate 监听在 NavigationStack 挂载时就装上，排在这里之前，照样会跑——
// 读到的 state 的 key 就是当前顶层，认出是同一页、原地不动（不做转场），导航栈不变。
// 这里处理过的 popstate（关浮层的那次、以及下面 release 自己 back() 引起的那次）会 stopImmediatePropagation，
// 之后挂上的监听看不到它们。浮层由别的途径（完成、Esc、下滑）关掉时，条目还在：release() 自己 history.back() 退掉它，
// 那一次 popstate 由 ignoreNext 吃掉。
//
// 不要在 effect 里调：StrictMode 下 effect 挂载 → 清理 → 挂载，清理里的 back() 是异步的，
// 它的 popstate 会在第二次 push 之后才到、把新开的浮层关掉。由打开 / 关闭浮层的调用方显式调用。
// Dialog / Sheet 这类 Base UI 浮层不经过这里（它们没有历史条目，返回键照常离开页面）。

let active: { onPop: () => void } | null = null
let ignoreNext = 0
let installed = false

function onPopState(event: PopStateEvent): void {
  if (ignoreNext > 0) {
    ignoreNext -= 1
    event.stopImmediatePropagation()
    return
  }
  const entry = active
  if (!entry) return
  active = null
  event.stopImmediatePropagation()
  entry.onPop()
}

/** 关掉浮层条目的函数：goBack 默认 true（退掉条目）；false 只放下条目、不后退。 */
export type OverlayEntryRelease = (goBack?: boolean) => void

/**
 * 为页内浮层压一条历史条目；浏览器后退 / 安卓返回键时调 onPop（在 popstate 里，关浮层就行，条目已经退掉了）。
 * 返回 release：浮层不是因为后退而关闭时调用，退掉这个条目。
 * release(false) 只放下这个条目、不后退：组件卸载时用（那时可能正在离开这一页，back() 会把导航撤回去）。
 * 同一时刻只有一个浮层条目：上一个没放下时再调用会直接顶替（不再多推一条）。
 */
export function pushOverlayEntry(onPop: () => void): OverlayEntryRelease {
  if (!installed) {
    window.addEventListener('popstate', onPopState)
    installed = true
  }
  if (!active) window.history.pushState(window.history.state, '')
  const entry = { onPop }
  active = entry
  return (goBack = true) => {
    if (active !== entry) return
    active = null
    if (!goBack) return
    ignoreNext += 1
    window.history.back()
  }
}
