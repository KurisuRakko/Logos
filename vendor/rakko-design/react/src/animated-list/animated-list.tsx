/**
 * 列表增删与重排动画容器（FLIP，WAAPI + springEasing(SPRINGS.smooth)），移植自 RakkoNotes 的 FlipList。
 *
 * 用法：容器里需要动的元素带 data-rk-flip-key（容器内唯一；List.Group / List.Row / SwipeRow 的 flipKey 写的就是它）。
 * 可以嵌套（分组带 key，组里的行也带 key），每个元素的位移相对它最近的带 key 祖先（或容器）计算，
 * 所以「整组下移 + 组内上移」能各自叠加。带 data-rk-flip-collapse 的元素（SwipeRow 根，display: grid）新出现时从 0fr 展开。
 *
 *   - 保留下来的元素：从提交前的视觉位置（含进行中的动画）平滑移到新位置，连续操作时从当前位置接着走，不跳。
 *   - 换了父组的元素（置顶 / 取消置顶）：新组原来就在时，从旧位置一路移到新组里的位置（移动期间浮在别的行上面）；
 *     新组是这次才出现的（第一次置顶），按新出现处理。
 *   - 新出现的元素：高度 0fr → 1fr、透明度 0 → 1、scale .98 → 1。量新位置时它们按折叠算，
 *     下方元素的位移与展开过程正好抵消，不会先跳后回。一次出现超过 MAX_EXPAND 个（换了一批搜索结果）只淡入。
 *     首批内容（之前什么都没有）不做动画。
 *   - 消失的元素：带 data-rk-flip-collapse 的行（数据里不见了，如被别处删掉）在原位放一份静态克隆，
 *     行高 1fr → 0fr 收拢 + 淡出，收完再摘掉。量新位置时克隆按展开算，下方元素的位移由收拢过程带出来，不空洞不叠印。
 *     已经由 SwipeRow removing 收拢过的行（data-removing）直接删；所在父组也一起不见了的、一次消失太多的也直接不见。
 *     其余元素 FLIP 补位。
 *   - resetKey 变化（换了视图，如进入 / 退出搜索）：不做逐行 FLIP。crossfade 时先让旧内容的快照淡出，
 *     再让新内容淡入，两段不重叠：任何一帧都只有一层文字。快照放在容器里绝对定位（容器 position: relative），
 *     跟着布局走：大标题、搜索框同时在收放，快照随容器一起移动，不会钉在原地和新内容错位。
 *   - 减弱动态效果：全部不动画。
 *
 * 用类组件是为了 getSnapshotBeforeUpdate：React 改 DOM 之前量旧位置（hook 做不到）。
 * 只量本容器自己的元素（最近的 [data-rk-flip-root] 是自己），嵌套的 AnimatedList 各管各的。
 *
 * 性能：父组件每次重渲染都会走一遍量位置，所以这里不调 getAnimations()（每次都强制刷样式），
 * 自己起的位移 / 淡入动画自己记账；父参照在一次量取里只查一次（closest 按元素缓存）。
 * 传了 layoutKey（行身份 + 顺序 + 分组 + 收拢状态的签名，见 flipLayoutKey）时，签名与 resetKey 都没变
 * （只是行内容更新，如打字时标题 / 摘要变了）就整次跳过：提交前后都不量、不起动画。代价是内容变化引起的
 * 行高变化不再补位——行是定高单行截断时没有这种情况；有的话，把影响行高的状态放进签名（flipLayoutKey 的 extra）。
 * 不传 layoutKey 时每次都量。
 */
import { Component, createRef } from 'react'
import type { ReactNode } from 'react'
import { cx } from '../cx'
import { MOTION } from '../motion'
import { reducedMotionQuery } from '../motion-dom'
import { SPRINGS, springEasing } from '../spring'
import {
  FLIP_APPEAR_ID,
  FLIP_COLLAPSE_ATTR,
  FLIP_FADE_ID,
  FLIP_KEY_ATTR,
  FLIP_MOVE_ID,
  FLIP_ROOT_ATTR,
  SWAP_GHOST_ATTR,
} from './flip-ids'

export interface AnimatedListProps {
  className?: string
  /** 视图标识；变化时不做逐行 FLIP（换了一批内容）。 */
  resetKey?: string
  /** resetKey 变化时旧内容淡出、新内容淡入。@default false */
  crossfade?: boolean
  /**
   * 布局签名（flipLayoutKey 生成）；与上次相同且 resetKey 没变时跳过量取与 FLIP。不传 = 每次都量。
   * 签名要覆盖所有会让带 key 的元素换位、增删、换组、改高的状态，宁可多变不能少变。
   */
  layoutKey?: string
  children?: ReactNode
}

interface Measured {
  /** 相对父参照（最近的带 key 祖先或容器）的 top，视觉位置。 */
  top: number
  /** 视口坐标的 top，视觉位置（换了父组的元素用它接上旧位置）。 */
  abs: number
  parent: string
}

/** 提交前元素在 DOM 里的位置：消失时把克隆插回原处用。 */
interface Placed {
  el: HTMLElement
  parent: HTMLElement
  /** 它后面的兄弟元素，按顺序；插回时找第一个还在的当锚点。 */
  following: Element[]
}

type Snapshot =
  | { kind: 'flip'; items: Map<string, Measured>; nodes: Map<string, Placed> }
  | { kind: 'reset'; ghost: HTMLElement | null; opacity: number }
  | null

/** 一次出现 / 消失超过这么多个就不逐个展开或收拢：出现的只淡入，消失的直接不见。 */
export const MAX_EXPAND = 8
/** 交叉淡化里旧快照淡出占 exit 时长的比例：比新内容淡入快，两段不重叠。 */
const GHOST_FADE_RATIO = 0.6
const GHOST_CLASS = 'rk-animated-list__ghost'
/** 克隆里要去掉的标记：免得被量到、被长按命中、id 重复。 */
const STRIP_ATTRS = [FLIP_KEY_ATTR, FLIP_ROOT_ATTR, 'data-context-id', 'data-context-action', 'id']
const STRIP_SELECTOR = `[${FLIP_KEY_ATTR}], [${FLIP_ROOT_ATTR}], [data-context-id], [data-context-action], [id]`

function flipKeyOf(el: Element): string {
  return el.getAttribute(FLIP_KEY_ATTR) ?? ''
}

/** 把克隆变成静态、不可交互的拷贝。 */
function neutralize(ghost: HTMLElement): void {
  for (const node of [ghost, ...ghost.querySelectorAll(STRIP_SELECTOR)]) {
    for (const name of STRIP_ATTRS) node.removeAttribute(name)
  }
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  ghost.style.pointerEvents = 'none'
}

export class AnimatedList extends Component<AnimatedListProps> {
  private root = createRef<HTMLDivElement>()
  private ghosts = new Set<HTMLElement>()
  /** 正在跨组移动、被抬到上层的元素 → 它的移动动画（清理时核对，免得旧动画的回调摘掉新动画的抬升）。 */
  private lifted = new WeakMap<HTMLElement, Animation>()
  /** 自己起的位移动画（元素 → 动画）：下次重排先停掉它们再量，代替 el.getAnimations()。 */
  private moves = new Map<HTMLElement, Animation>()
  /** 交叉淡化里新内容的淡入：再次换视图时先停掉。 */
  private fades = new Set<Animation>()
  /** 一次量取里元素 → 父参照（closest 只查一次）；量完清空。 */
  private parents = new Map<HTMLElement, HTMLElement>()

  /** 本容器管的元素（不含嵌套 AnimatedList 里的、交叉淡化的快照里的）。 */
  private owned(): HTMLElement[] {
    const root = this.root.current
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>(`[${FLIP_KEY_ATTR}]`)).filter(
      (el) => el.closest(`[${FLIP_ROOT_ATTR}]`) === root,
    )
  }

  /** 父参照：最近的带 key 祖先（在本容器内），没有就是容器本身。 */
  private parentOf(el: HTMLElement): HTMLElement {
    const cached = this.parents.get(el)
    if (cached) return cached
    const root = this.root.current!
    const found = el.parentElement?.closest<HTMLElement>(`[${FLIP_KEY_ATTR}], [${FLIP_ROOT_ATTR}]`)
    const parent = found && root.contains(found) ? found : root
    this.parents.set(el, parent)
    return parent
  }

  private parentKey(el: HTMLElement): string {
    const parent = this.parentOf(el)
    return parent === this.root.current ? '' : flipKeyOf(parent)
  }

  /** 每个元素相对父参照的 top 与视口 top（getBoundingClientRect 含 transform，即视觉位置）。 */
  private measure(elements: HTMLElement[]): Map<string, Measured> {
    const tops = new Map<Element, number>()
    const topOf = (el: Element) => {
      let top = tops.get(el)
      if (top === undefined) {
        top = el.getBoundingClientRect().top
        tops.set(el, top)
      }
      return top
    }
    const result = new Map<string, Measured>()
    for (const el of elements) {
      const abs = topOf(el)
      result.set(flipKeyOf(el), { top: abs - topOf(this.parentOf(el)), abs, parent: this.parentKey(el) })
    }
    return result
  }

  getSnapshotBeforeUpdate(prev: Readonly<AnimatedListProps>): Snapshot {
    const root = this.root.current
    // 没有 WAAPI 的环境（旧浏览器、未打桩的测试环境）与减弱动态效果：一律不动画
    if (!root || typeof root.animate !== 'function' || reducedMotionQuery()?.matches) return null
    if (prev.resetKey !== this.props.resetKey) {
      // 列表与空状态互换时应用自己留下的淡出拷贝（SwapText 的 useSwapPresence 留下的 data-rk-swap-ghost）不算旧内容
      const content = Array.from(root.children).filter(
        (el) => !this.ghosts.has(el as HTMLElement) && !el.hasAttribute(SWAP_GHOST_ATTR),
      )
      if (!this.props.crossfade || content.length === 0) return { kind: 'reset', ghost: null, opacity: 1 }
      const ghost = root.cloneNode(false) as HTMLElement
      for (const el of content) ghost.appendChild(el.cloneNode(true))
      // 上一次交叉淡化的淡入还没走完：快照从当前透明度开始淡出，不闪
      const opacity = content.reduce((min, el) => {
        const value = Number.parseFloat(getComputedStyle(el).opacity)
        return Math.min(min, Number.isFinite(value) ? value : 1)
      }, 1)
      return { kind: 'reset', ghost, opacity }
    }
    // 行的集合、顺序、分组都没变：位置不会动，不量（量一次就是每行一次强制布局）
    if (this.props.layoutKey !== undefined && prev.layoutKey === this.props.layoutKey) return null
    const owned = this.owned()
    const nodes = new Map<string, Placed>()
    for (const el of owned) {
      if (!el.hasAttribute(FLIP_COLLAPSE_ATTR) || el.hasAttribute('data-removing') || !el.parentElement) continue
      const following: Element[] = []
      for (let next = el.nextElementSibling; next; next = next.nextElementSibling) following.push(next)
      nodes.set(flipKeyOf(el), { el, parent: el.parentElement, following })
    }
    const items = this.measure(owned)
    // React 马上要改 DOM：父参照缓存只在这一次量取里有效
    this.parents.clear()
    return { kind: 'flip', items, nodes }
  }

  componentDidUpdate(_prev: Readonly<AnimatedListProps>, _state: unknown, snapshot: Snapshot): void {
    if (!snapshot) return
    if (snapshot.kind === 'reset') this.crossfade(snapshot.ghost, snapshot.opacity)
    else this.flip(snapshot.items, snapshot.nodes)
  }

  componentWillUnmount(): void {
    this.clearGhosts()
  }

  private clearGhosts(): void {
    for (const ghost of this.ghosts) ghost.remove()
    this.ghosts.clear()
  }

  private crossfade(ghost: HTMLElement | null, opacity: number): void {
    const root = this.root.current
    if (!root) return
    this.clearGhosts()
    // 换视图时旧内容由这里的快照淡出：同一次提交里应用留下的淡出拷贝摘掉，不叠两层
    for (const el of root.querySelectorAll(`:scope > [${SWAP_GHOST_ATTR}]`)) el.remove()
    const content = Array.from(root.children) as HTMLElement[]
    for (const anim of this.fades) anim.cancel()
    this.fades.clear()
    const easing = MOTION.easeStandard
    // 旧内容先淡出（快），新内容等它淡完再淡入：两段不重叠
    let delay = 0
    if (ghost && opacity > 0.01) {
      neutralize(ghost)
      ghost.classList.add(GHOST_CLASS)
      // 盖在容器内容区原位（容器 position: relative）：跟着容器走，不占布局
      Object.assign(ghost.style, { position: 'absolute', top: '0', left: '0', right: '0', margin: '0' })
      root.prepend(ghost)
      this.ghosts.add(ghost)
      delay = Math.round(MOTION.durationExitMs * GHOST_FADE_RATIO)
      const fade = ghost.animate({ opacity: [opacity, 0] }, { duration: delay, easing, fill: 'forwards' })
      const done = () => {
        ghost.remove()
        this.ghosts.delete(ghost)
      }
      fade.finished.then(done, done)
    }
    for (const el of content) {
      const anim = el.animate(
        { opacity: [0, 1] },
        { duration: MOTION.durationEnterMs, delay, easing, fill: 'backwards', id: FLIP_FADE_ID },
      )
      this.fades.add(anim)
      const settle = () => this.fades.delete(anim)
      anim.finished.then(settle, settle)
    }
  }

  /**
   * 数据里消失的行：在原位插一份静态克隆（展开状态），返回这些克隆，等量完新位置再收拢。
   * 插在 React 管的父元素里，但不带 key、不可交互，收拢完自己摘掉，React 不会碰到它。
   */
  private placeLeaving(nodes: Map<string, Placed>): HTMLElement[] {
    const root = this.root.current!
    const gone = Array.from(nodes.values()).filter(
      ({ el, parent }) => !el.isConnected && parent.isConnected && root.contains(parent),
    )
    if (gone.length === 0 || gone.length > MAX_EXPAND) return []
    const placed: HTMLElement[] = []
    for (const { el, parent, following } of gone) {
      const ghost = el.cloneNode(true) as HTMLElement
      neutralize(ghost)
      ghost.removeAttribute(FLIP_COLLAPSE_ATTR)
      const anchor = following.find((next) => next.parentElement === parent) ?? null
      parent.insertBefore(ghost, anchor)
      this.ghosts.add(ghost)
      placed.push(ghost)
    }
    return placed
  }

  private flip(before: Map<string, Measured>, nodes: Map<string, Placed>): void {
    try {
      this.flipInner(before, nodes)
    } finally {
      this.parents.clear()
    }
  }

  private flipInner(before: Map<string, Measured>, nodes: Map<string, Placed>): void {
    const root = this.root.current
    if (!root) return
    // 0. 消失的行先在原位放回克隆：下面量新位置时它还占着原高度，其余行不会先跳上去
    const leaving = this.placeLeaving(nodes)
    const elements = this.owned()
    if (elements.length === 0 && leaving.length === 0) return

    // 1. 停掉进行中的位移动画，量纯布局位置（旧的视觉位置已在 snapshot 里）。
    //    动画是自己记的账：不用逐个 getAnimations()，摘掉的元素上的也一并停掉
    for (const anim of this.moves.values()) anim.cancel()
    this.moves.clear()

    // 2. 分类。首批内容（之前什么都没有）不做动画。
    //    换了父组：新父组原来就在 → 跨组移动；新父组也是新出现的 → 当成新出现（跟着新组一起展开）。
    const isNew = (el: HTMLElement): boolean => {
      const prev = before.get(flipKeyOf(el))
      if (!prev) return true
      if (prev.parent === this.parentKey(el)) return false
      const parent = this.parentOf(el)
      return parent !== root && isNew(parent)
    }
    const appearing = before.size === 0 ? [] : elements.filter(isNew)
    const collapse = appearing.length <= MAX_EXPAND
    // 样式可能已经算过（上面停动画、别处读过布局）：不关过渡的话改成 0fr 会变成一个过渡，量到的还是展开高度
    const collapsed = collapse ? appearing.filter((el) => el.hasAttribute(FLIP_COLLAPSE_ATTR)) : []
    for (const el of collapsed) {
      el.style.transition = 'none'
      el.style.gridTemplateRows = '0fr'
    }

    const after = this.measure(elements)
    const rootTop = root.getBoundingClientRect().top
    for (const el of collapsed) {
      el.style.removeProperty('grid-template-rows')
      el.style.removeProperty('transition')
    }

    const { easing, durationMs: duration } = springEasing(SPRINGS.smooth)
    const appearingSet = new Set(appearing)

    // 3. 每个元素动画第一帧的视觉 top（视口坐标），自上而下递推：父参照在第一帧在哪，子元素跟着它
    const startTops = new Map<HTMLElement, number>()
    const startTop = (el: HTMLElement): number => {
      if (el === root) return rootTop
      const cached = startTops.get(el)
      if (cached !== undefined) return cached
      const key = flipKeyOf(el)
      const prev = before.get(key)
      const next = after.get(key)
      let top: number
      if (!next) top = el.getBoundingClientRect().top
      else if (!prev || appearingSet.has(el)) top = startTop(this.parentOf(el)) + next.top
      else if (prev.parent === next.parent) top = startTop(this.parentOf(el)) + prev.top
      else top = prev.abs
      startTops.set(el, top)
      return top
    }

    // 4. 保留的元素：从旧位置平滑移到新位置
    for (const el of elements) {
      if (appearingSet.has(el)) continue
      const key = flipKeyOf(el)
      const prev = before.get(key)
      const next = after.get(key)
      if (!prev || !next) continue
      const crossing = prev.parent !== next.parent
      const dy = crossing ? startTop(el) - (startTop(this.parentOf(el)) + next.top) : prev.top - next.top
      if (Math.abs(dy) < 0.5) continue
      const anim = el.animate({ transform: [`translateY(${dy}px)`, 'none'] }, { duration, easing, id: FLIP_MOVE_ID })
      this.moves.set(el, anim)
      const settle = () => {
        if (this.moves.get(el) === anim) this.moves.delete(el)
      }
      anim.finished.then(settle, settle)
      if (crossing) this.lift(el, anim)
    }

    // 5. 消失的行：克隆原位收拢，下方元素跟着布局上移
    for (const ghost of leaving) this.collapseLeaving(ghost, duration, easing)

    // 6. 新出现的元素：展开 + 淡入 + 轻微放大
    const opacityTiming = { duration: MOTION.durationEnterMs, easing: MOTION.easeStandard, id: FLIP_APPEAR_ID }
    for (const el of appearing) {
      el.animate({ opacity: [0, 1] }, opacityTiming)
      if (!collapse) continue
      el.animate({ scale: ['0.98', '1'] }, { duration, easing, id: FLIP_APPEAR_ID })
      if (el.hasAttribute(FLIP_COLLAPSE_ATTR)) {
        el.animate({ gridTemplateRows: ['0fr', '1fr'] }, { duration, easing, id: FLIP_APPEAR_ID })
      }
    }
  }

  /** 消失行的克隆：行高收拢 + 淡出（对齐 .rk-swipe-row[data-removing]），收完摘掉。 */
  private collapseLeaving(ghost: HTMLElement, duration: number, easing: string): void {
    ghost.animate(
      { opacity: [1, 0] },
      { duration: MOTION.durationExitMs, easing: MOTION.easeStandard, fill: 'forwards' },
    )
    const shrink = ghost.animate({ gridTemplateRows: ['1fr', '0fr'] }, { duration, easing, fill: 'forwards' })
    const done = () => {
      ghost.remove()
      this.ghosts.delete(ghost)
    }
    shrink.finished.then(done, done)
  }

  /** 跨组移动的元素浮在别的行上面（不然会从后面分组的卡片底下穿过去），动画结束放下。 */
  private lift(el: HTMLElement, anim: Animation): void {
    this.lifted.set(el, anim)
    el.style.position = 'relative'
    el.style.zIndex = '1'
    const drop = () => {
      if (this.lifted.get(el) !== anim) return
      this.lifted.delete(el)
      el.style.removeProperty('position')
      el.style.removeProperty('z-index')
    }
    anim.finished.then(drop, drop)
  }

  render() {
    return (
      <div ref={this.root} className={cx('rk-animated-list', this.props.className)} data-rk-flip-root="">
        {this.props.children}
      </div>
    )
  }
}
