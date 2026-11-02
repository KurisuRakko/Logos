/**
 * 用非被动 touchmove + preventDefault 拦住页面滚动 / 缩放，代替大面积层上的 CSS `touch-action: none`。
 * 移植自 RakkoNotes 的 touchBlock.ts（b1ac47c），给 LiftMenu 的全屏浮起层用。
 *
 * 为什么：WebKit（iOS Safari）的 touch-action 区域是异步更新的。全屏层带着 touch-action: none 卸载之后，
 * 旧的 none 区域会残留，之后在那里起手的触摸整页都滚不动（RakkoNotes 实机诊断：长按图片的浮起层关掉后，
 * 正文竖直拖 284px 页面不动、没有 pointercancel）。换成 JS 监听，残留的只是「这里有监听」的区域，
 * 浏览器顶多等一下 JS——监听已经不在，等于不拦，不会锁死滚动。
 *
 * 规则：一次触摸（第一根手指落下到全部抬起）在第一次 touchmove 时定下拦不拦，整次手势不变（浏览器一旦开始滚就拦不住了）：
 *   - 起点不在 only 认可的范围内：不拦（only 缺省时整层都算）；
 *   - 起点在层内某个能沿手势方向滚动的子区域里：放行，让它自己滚；
 *   - 其余（含多指）：每个 touchmove 都 preventDefault——页面不滚、不捏合缩放，层自己的 pointer 手势也不会被 pointercancel 打断。
 * 双击缩放没有 touchmove 可拦，交给 CSS `touch-action: manipulation`（残留的 manipulation 区域不挡平移和捏合，无害）。
 *
 * 返回解绑函数：可以直接当 React 19 的回调 ref（`ref={blockTouchScroll}`），也可以当 effect 的清理。
 */
export function blockTouchScroll(
  el: HTMLElement | null,
  only?: (target: Element) => boolean,
): (() => void) | undefined {
  if (!el) return undefined
  let origin: Element | null = null
  let start = { x: 0, y: 0 }
  /** 这次触摸拦不拦；null = 还没动过，等第一次 touchmove 定。 */
  let block: boolean | null = null

  const onStart = (event: TouchEvent) => {
    // 第二根手指落下：沿用第一根定下的（还没定的话，第一次 touchmove 时是多指，会拦）
    if (event.touches.length > 1) return
    const touch = event.touches[0]
    origin = event.target instanceof Element ? event.target : null
    start = { x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 }
    block = null
  }
  const onMove = (event: TouchEvent) => {
    if (block === null) {
      const touch = event.touches[0]
      const dx = (touch?.clientX ?? start.x) - start.x
      const dy = (touch?.clientY ?? start.y) - start.y
      block =
        origin !== null &&
        (only === undefined || only(origin)) &&
        (event.touches.length > 1 || !canScrollWithin(origin, el, dx, dy))
    }
    if (block && event.cancelable) event.preventDefault()
  }

  el.addEventListener('touchstart', onStart, { passive: true })
  el.addEventListener('touchmove', onMove, { passive: false })
  return () => {
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
  }
}

/** 从 target 往上到 root（含）有没有能顺着手指位移 (dx, dy) 滚动的元素。 */
function canScrollWithin(target: Element, root: HTMLElement, dx: number, dy: number): boolean {
  const vertical = Math.abs(dy) >= Math.abs(dx)
  for (let node: Element | null = target; node; node = node.parentElement) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node)
      const overflow = vertical ? style.overflowY : style.overflowX
      if (overflow === 'auto' || overflow === 'scroll') {
        // 手指往上（dy < 0）是要看下面的内容：还没滚到底才算能滚
        if (vertical) {
          const max = node.scrollHeight - node.clientHeight
          if (dy < 0 ? node.scrollTop < max - 1 : node.scrollTop > 0) return true
        } else {
          const max = node.scrollWidth - node.clientWidth
          if (dx < 0 ? node.scrollLeft < max - 1 : node.scrollLeft > 0) return true
        }
      }
    }
    if (node === root) break
  }
  return false
}
