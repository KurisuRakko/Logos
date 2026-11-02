// AnimatedList 与 SwipeRow 共用的 FLIP 契约：属性名与 WAAPI 动画 id。
// 放在独立模块里，SwipeRow 不必依赖 AnimatedList 组件本身（RakkoNotes 里是 SwipeRow → FlipList 的单向耦合）。

/** 要做 FLIP 的元素（容器内唯一）；嵌套时子元素的位移相对最近的带 key 祖先计算。 */
export const FLIP_KEY_ATTR = 'data-rk-flip-key'
/** 根是 grid 0fr / 1fr 收拢结构（SwipeRow 根）：出现时展开、消失时由原位克隆收拢。 */
export const FLIP_COLLAPSE_ATTR = 'data-rk-flip-collapse'
/** AnimatedList 容器自身；嵌套的 AnimatedList 各管各的。 */
export const FLIP_ROOT_ATTR = 'data-rk-flip-root'
/**
 * 应用自己留在容器里的淡出拷贝（如列表与空状态互换时的交叉淡化）：resetKey 交叉淡化不把它算进旧内容，
 * 并在换视图那一刻摘掉，免得叠两层。与 SwapText 的 useSwapPresence 共用同一个属性（RakkoNotes 原名 data-swap-ghost）。
 */
export const SWAP_GHOST_ATTR = 'data-rk-swap-ghost'

/** 重排位移。 */
export const FLIP_MOVE_ID = 'rk-flip-move'
/** resetKey 变化时新内容的淡入。 */
export const FLIP_FADE_ID = 'rk-flip-fade'
/** 新出现元素的淡入 / 放大 / 展开。 */
export const FLIP_APPEAR_ID = 'rk-flip-appear'

/**
 * 停掉元素上进行中的出现动画。SwipeRow 开始 removing 收拢时调用：
 * 出现动画的 grid-template-rows 会盖住收拢的 CSS 过渡，刚插入就删除的行会先展开完才收。
 */
export function cancelFlipAppear(el: Element | null): void {
  if (!el || typeof el.getAnimations !== 'function') return
  for (const anim of el.getAnimations()) if (anim.id === FLIP_APPEAR_ID) anim.cancel()
}
