// 导航栈两层之间的转场（iOS UINavigationController 式），纯 DOM + WAAPI，不用 View Transitions
// （iOS 主屏模式下 View Transitions 的快照会错位约 1 秒）。
//
//   over  上面那层：前进时是新页（从右 100% 推入），返回时是旧页（向右滑出）；左缘一道淡阴影。
//   under 下面那层：前进时旧页移到 -30% 并盖上渐深的暗色（.rk-nav-scrim），返回时反过来。
//   栏：两层里带 data-rk-nav-bar 的真栏在转场期间隐藏，换成 .rk-nav-ghost 里的克隆。背景（材质 + 发丝线）只有一份、
//   原地不动（两边都有背景时恒定，一边没有时淡入 / 淡出），上面两份内容交叉淡化；data-rk-nav-part 为 leading / title
//   的部件像 iOS 那样新的从 40px 外滑入、旧的向另一侧滑出。克隆放在两层之上，所以页面滑动时栏不跟着动、也不被新页盖住。
//
// 调用方（engine.ts）先把两层置为 moving（固定在视口、scrollTop = 各自滚动位置），再建转场：
//   play()             程序化转场：从头播到尾，位移用 SPRINGS.page，透明度按 MOTION 的时长与 standard 曲线；
//   setProgress(t)     跟手：t = 从出发页到目标页的进度，0…1；
//   settle(t, v)       松手：从当前位置弹簧走到 0 或 1，曲线现算（springCurve，同一条 page 弹簧），
//                      初速度 = 松手速度（px/ms）÷ 剩余距离；
//   retarget(t)        转场中途改主意（推入时点了返回、返回时浏览器前进）：冻结各元素此刻的计算值，
//                      从那里弹簧走到 0 或 1，不先跳到终点；
//   cleanup()          撤掉克隆、暗层与内联样式（调用方先切好层状态再调，同一任务内完成，不出中间帧）。
// 减弱动态效果时程序化转场只做约 200ms 的交叉淡化（上层淡入 / 淡出），不建克隆；跟手手势照常位移。
//
// 动画的 finished 不一定兑现（转场中切后台 / 锁屏，回来后有的浏览器不再推进；动画被别处 cancel 时它会 reject），
// 停在半路的话两层会一直是 moving（固定、不可点、整页滑不动）。所以每段动画另有兜底：页面隐藏、从 bfcache 恢复时
// 直接到终点（看不见，不算硬切）；看门狗在预定时长 + NAV_WATCHDOG_MARGIN_MS 后强制到终点。
import { MOTION } from '../motion'
import { SPRINGS, prefersReducedMotion, springCurve, springEasing } from '../spring'
import type { SpringEasing } from '../spring'

export type NavigationDirection = 'forward' | 'back'

export interface NavTransition {
  play(): Promise<void>
  setProgress(t: number): void
  settle(target: 0 | 1, velocity?: number): Promise<void>
  /** 从此刻的姿态（动画进行中也行）弹簧走到 target；被打断后反向用。 */
  retarget(target: 0 | 1): Promise<void>
  /** 立刻停下所有动画（不清理）；被打断时用。 */
  stop(): void
  cleanup(): void
}

export interface NavTransitionOptions {
  over: HTMLElement
  under: HTMLElement
  /** forward：over 是目标页；back：under 是目标页。 */
  direction: NavigationDirection
  /** 跟手手势：即使减弱动态效果也走位移（直接操控不算动画）。 */
  interactive?: boolean
}

/** 被压在下面的页面最多左移的比例。 */
export const NAV_UNDER_SHIFT = 0.3
/** 栏里返回键 / 小标题的水平错位（px）。 */
export const NAV_BAR_SHIFT = 40
/** 减弱动态效果时的交叉淡化时长（ms）。 */
export const NAV_REDUCED_DURATION_MS = 200
/** 看门狗的余量（ms）：动画过了预定时长这么久 finished 还没兑现，就当它卡住了，强制到终点。 */
export const NAV_WATCHDOG_MARGIN_MS = 2000
/** 剩余距离小于它（px）时不算初速度：除以一个接近 0 的距离会得到离谱的进度速度。 */
const MIN_SETTLE_DISTANCE = 1

/** 一个被驱动的元素：位移 / 透明度都是进度 t 的函数。 */
interface Channel {
  el: HTMLElement
  x?: (t: number) => number
  opacity?: (t: number) => number
  /** 程序化转场时透明度的节奏：spring 跟位移一起走；state / enter 用对应时长 + standard 曲线。 */
  fade?: 'spring' | 'state' | 'enter'
}

/** 现算带初速度的 page 弹簧（松手 / 反向用；clamp：临界阻尼本来不过冲，再防一手浮点越界露出左缘）。 */
function pageCurve(velocity = 0): SpringEasing {
  return springCurve({ ...SPRINGS.page, velocity, clamp: true })
}

/** 变换串里的水平位移：计算值是 matrix(…)，内联值是 translate3d(…)。 */
function translateX(transform: string): number {
  if (typeof DOMMatrixReadOnly === 'function') {
    try {
      return new DOMMatrixReadOnly(transform).m41
    } catch {
      // 落到下面的正则
    }
  }
  const matrix = /^matrix(3d)?\(([^)]*)\)$/.exec(transform)
  if (matrix) {
    const values = matrix[2]!.split(',').map((v) => Number.parseFloat(v))
    return values[matrix[1] ? 12 : 4] ?? 0
  }
  const translate = /^translate(?:3d|X)?\(\s*(-?[\d.e+-]+)px/.exec(transform)
  return translate ? Number.parseFloat(translate[1]!) : 0
}

const fadeDuration = (fade: 'state' | 'enter') => (fade === 'state' ? MOTION.durationStateMs : MOTION.durationEnterMs)

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function frameOf(channel: Channel, t: number): Keyframe {
  const frame: Keyframe = {}
  if (channel.x) frame.transform = `translate3d(${channel.x(t)}px, 0, 0)`
  if (channel.opacity) frame.opacity = String(channel.opacity(t))
  return frame
}

function applyFrame(channel: Channel, t: number): void {
  if (channel.x) channel.el.style.transform = `translate3d(${channel.x(t)}px, 0, 0)`
  if (channel.opacity) channel.el.style.opacity = String(channel.opacity(t))
}

/* ------------------------------------------------------------------ 栏的克隆 */

type BarEdge = 'top' | 'bottom'

/** 页面里的顶栏 / 底栏（每页至多各一条），按属性契约找，不认组件类名。 */
function findBar(layer: HTMLElement, edge: BarEdge): HTMLElement | null {
  return layer.querySelector<HTMLElement>(`[data-rk-nav-bar="${edge}"]`)
}

/** 顶栏此刻是否显示着材质（到顶透明时栏上有 data-at-top）。 */
function hasMaterial(bar: HTMLElement | null): boolean {
  return bar !== null && !bar.hasAttribute('data-at-top')
}

/** 底栏当前的透明度；没有底栏为 0（编辑态等应用自己把底栏淡出时按它当前的值算）。 */
function barOpacity(bar: HTMLElement | null): number {
  if (!bar) return 0
  const style = getComputedStyle(bar)
  if (style.visibility === 'hidden') return 0
  const value = Number.parseFloat(style.opacity)
  if (!Number.isFinite(value)) return 1
  return value > 0.01 ? value : 0
}

/** 深克隆（内容）时剥掉的属性：材质、滚动渐显、到顶透明、id（克隆不能和真栏重复 id）。 */
const STRIP = ['data-glass', 'data-reveal', 'data-at-top', 'id']

/** 克隆一条栏放进 ghost：绝对定位在原位置（顶栏贴顶、底栏贴底），不响应交互。deep = 内容（不带材质），否则只当背景。 */
function cloneBar(bar: HTMLElement, edge: BarEdge, deep: boolean): HTMLElement {
  const clone = bar.cloneNode(deep) as HTMLElement
  clone.style.position = 'absolute'
  clone.style.left = '0'
  clone.style.right = '0'
  clone.style.top = edge === 'top' ? '0' : 'auto'
  clone.style.bottom = edge === 'bottom' ? '0' : 'auto'
  clone.style.height = `${bar.offsetHeight}px`
  clone.style.margin = '0'
  clone.style.transform = 'none'
  clone.style.animation = 'none'
  clone.style.transition = 'none'
  clone.style.pointerEvents = 'none'
  if (deep) {
    for (const name of STRIP) clone.removeAttribute(name)
    clone.style.background = 'transparent'
    clone.style.boxShadow = 'none'
    for (const el of clone.querySelectorAll<HTMLElement>('[id]')) el.removeAttribute('id')
  } else {
    // 只当背景用：保留 data-glass，去掉滚动渐显与「到顶透明」
    clone.removeAttribute('data-reveal')
    clone.removeAttribute('data-at-top')
    clone.removeAttribute('id')
  }
  return clone
}

/** 克隆里与真栏对应的部件，带上真部件当前的透明度（搜索中隐藏的小标题等）。 */
function part(clone: HTMLElement, real: HTMLElement, name: string): { el: HTMLElement; base: number } | null {
  const selector = `[data-rk-nav-part="${name}"]`
  const el = clone.querySelector<HTMLElement>(selector)
  const source = real.querySelector<HTMLElement>(selector)
  if (!el || !source) return null
  el.style.transition = 'none'
  const base = Number.parseFloat(getComputedStyle(source).opacity)
  return { el, base: Number.isFinite(base) ? base : 1 }
}

function buildGhost(
  from: HTMLElement,
  to: HTMLElement,
  direction: NavigationDirection,
): { root: HTMLElement; channels: Channel[] } {
  const root = document.createElement('div')
  root.className = 'rk-nav-ghost'
  root.setAttribute('aria-hidden', 'true')
  const channels: Channel[] = []
  const dir = direction === 'forward' ? 1 : -1

  // 顶栏：材质一份，内容两份
  const fromNav = findBar(from, 'top')
  const toNav = findBar(to, 'top')
  const fromNavBg = hasMaterial(fromNav)
  const toNavBg = hasMaterial(toNav)
  if (fromNavBg || toNavBg) {
    const bg = cloneBar((toNavBg ? toNav : fromNav)!, 'top', false)
    root.append(bg)
    const a = fromNavBg ? 1 : 0
    const b = toNavBg ? 1 : 0
    channels.push({ el: bg, opacity: (t) => lerp(a, b, t), fade: 'enter' })
  }
  if (fromNav) {
    const clone = cloneBar(fromNav, 'top', true)
    root.append(clone)
    for (const name of ['leading', 'title']) {
      const p = part(clone, fromNav, name)
      if (p) channels.push({ el: p.el, x: (t) => -dir * NAV_BAR_SHIFT * t, opacity: (t) => p.base * (1 - t), fade: 'state' })
    }
    const actions = part(clone, fromNav, 'actions')
    if (actions) channels.push({ el: actions.el, opacity: (t) => actions.base * (1 - t), fade: 'enter' })
  }
  if (toNav) {
    const clone = cloneBar(toNav, 'top', true)
    root.append(clone)
    for (const name of ['leading', 'title']) {
      const p = part(clone, toNav, name)
      if (p) channels.push({ el: p.el, x: (t) => dir * NAV_BAR_SHIFT * (1 - t), opacity: (t) => p.base * t, fade: 'enter' })
    }
    const actions = part(clone, toNav, 'actions')
    if (actions) channels.push({ el: actions.el, opacity: (t) => actions.base * t, fade: 'enter' })
  }

  // 底栏：同上，内容只交叉淡化
  const fromBar = findBar(from, 'bottom')
  const toBar = findBar(to, 'bottom')
  const a = barOpacity(fromBar)
  const b = barOpacity(toBar)
  if (a > 0 || b > 0) {
    const bg = cloneBar((b > 0 ? toBar : fromBar)!, 'bottom', false)
    root.append(bg)
    channels.push({ el: bg, opacity: (t) => lerp(a, b, t), fade: 'enter' })
  }
  if (fromBar && a > 0) {
    const clone = cloneBar(fromBar, 'bottom', true)
    root.append(clone)
    channels.push({ el: clone, opacity: (t) => a * (1 - t), fade: 'enter' })
  }
  if (toBar && b > 0) {
    const clone = cloneBar(toBar, 'bottom', true)
    root.append(clone)
    channels.push({ el: clone, opacity: (t) => b * t, fade: 'enter' })
  }
  return { root, channels }
}

/* ------------------------------------------------------------------ 转场 */

export function createNavTransition({ over, under, direction, interactive = false }: NavTransitionOptions): NavTransition {
  const reduced = !interactive && prefersReducedMotion()
  const page = springEasing(SPRINGS.page)
  const width = over.offsetWidth || window.innerWidth
  const forward = direction === 'forward'
  const from = forward ? under : over
  const to = forward ? over : under
  const channels: Channel[] = []
  const extras: HTMLElement[] = []
  let animations: Animation[] = []
  let current = 0

  // 先量（克隆栏要读尺寸、计算样式），量完再统一写层的属性：读写交错的话，每次读都要为刚写的属性强制重算一次样式。
  // 也因此克隆出错抛异常时 DOM 还没动过，调用方把层状态复原就行
  const ghost = reduced ? null : buildGhost(from, to, direction)
  over.dataset.navRole = 'over'
  under.dataset.navRole = 'under'

  if (!ghost) {
    // 只淡化上层：前进时新页淡入，返回时旧页淡出
    channels.push({ el: over, opacity: (t) => (forward ? t : 1 - t), fade: 'spring' })
  } else {
    over.dataset.navFx = 'slide'
    const scrim = document.createElement('div')
    scrim.className = 'rk-nav-scrim'
    // 真栏在转场期间隐藏（克隆已经量好尺寸、取好状态）
    over.dataset.navGhosted = ''
    under.dataset.navGhosted = ''
    document.body.append(scrim, ghost.root)
    extras.push(scrim, ghost.root)
    if (forward) {
      channels.push({ el: over, x: (t) => (1 - t) * width })
      channels.push({ el: under, x: (t) => -NAV_UNDER_SHIFT * width * t })
      channels.push({ el: scrim, opacity: (t) => t, fade: 'spring' })
    } else {
      channels.push({ el: over, x: (t) => t * width })
      channels.push({ el: under, x: (t) => -NAV_UNDER_SHIFT * width * (1 - t) })
      channels.push({ el: scrim, opacity: (t) => 1 - t, fade: 'spring' })
    }
    channels.push(...ghost.channels)
  }

  const setProgress = (t: number) => {
    current = Math.min(1, Math.max(0, t))
    for (const channel of channels) applyFrame(channel, current)
  }

  const stop = () => {
    for (const animation of animations) animation.cancel()
    animations = []
  }

  /**
   * 跑一组动画，结束后把终点写成内联样式再撤掉动画（不留 fill）。
   * finished 之外另有兜底（见文件头）：页面隐藏、从 bfcache 恢复、看门狗到点，都直接到终点。
   */
  const run = async (list: Animation[], target: number) => {
    animations = list
    const end = Math.max(0, ...list.map((a) => Number(a.effect?.getComputedTiming().endTime) || 0))
    let disarm = () => {}
    const fallback = new Promise<void>((resolve) => {
      const onVisibility = () => {
        if (document.hidden) resolve()
      }
      const onPageShow = () => resolve()
      const timer = window.setTimeout(resolve, end + NAV_WATCHDOG_MARGIN_MS)
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('pageshow', onPageShow)
      disarm = () => {
        window.clearTimeout(timer)
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('pageshow', onPageShow)
      }
    })
    try {
      await Promise.race([Promise.all(list.map((a) => a.finished)), fallback])
    } catch {
      // 被 stop() 打断（animations 已换掉）就到此为止；被别处 cancel 的照常收到终点
    } finally {
      disarm()
    }
    if (animations !== list) return
    setProgress(target)
    stop()
  }

  const play = () => {
    setProgress(0)
    const list: Animation[] = []
    for (const channel of channels) {
      if (reduced) {
        list.push(
          channel.el.animate([frameOf(channel, 0), frameOf(channel, 1)], {
            duration: NAV_REDUCED_DURATION_MS,
            easing: MOTION.easeStandard,
            fill: 'both',
          }),
        )
        continue
      }
      if (channel.x) {
        const x = (t: number) => ({ transform: `translate3d(${channel.x!(t)}px, 0, 0)` })
        list.push(channel.el.animate([x(0), x(1)], { duration: page.durationMs, easing: page.easing, fill: 'both' }))
      }
      if (channel.opacity) {
        const o = (t: number) => ({ opacity: String(channel.opacity!(t)) })
        const timing =
          channel.fade === 'state' || channel.fade === 'enter'
            ? { duration: fadeDuration(channel.fade), easing: MOTION.easeStandard }
            : { duration: page.durationMs, easing: page.easing }
        list.push(channel.el.animate([o(0), o(1)], { ...timing, fill: 'both' }))
      }
    }
    return run(list, 1)
  }

  /**
   * 冻结：先读齐每个通道此刻的计算值（动画进行中就是动画当前帧），再停掉动画、写成内联样式，画面不动。
   * 返回各通道此刻的关键帧，并按上层的位移（减弱动态效果时按透明度）反推此刻的进度。
   */
  const freeze = (): Keyframe[] => {
    // 没在播（刚建好、跟手中）：画面就是 current 对应的那一帧
    if (animations.length === 0) return channels.map((channel) => frameOf(channel, current))
    const frames = channels.map((channel) => {
      const style = getComputedStyle(channel.el)
      const frame: Keyframe = {}
      if (channel.x) {
        frame.transform = !style.transform || style.transform === 'none' ? 'translate3d(0px, 0, 0)' : style.transform
      }
      if (channel.opacity) frame.opacity = style.opacity
      return frame
    })
    stop()
    channels.forEach((channel, i) => {
      const frame = frames[i]!
      if (frame.transform !== undefined) channel.el.style.transform = String(frame.transform)
      if (frame.opacity !== undefined) channel.el.style.opacity = String(frame.opacity)
    })
    const lead = channels[0]!
    if (lead.x) {
      const x = translateX(String(frames[0]!.transform))
      current = forward ? 1 - x / width : x / width
    } else {
      const opacity = Number.parseFloat(String(frames[0]!.opacity))
      current = forward ? opacity : 1 - opacity
    }
    current = Math.min(1, Math.max(0, Number.isFinite(current) ? current : 0))
    return frames
  }

  /** 从冻结的姿态走到 target（同一条曲线驱动所有通道，各通道都是进度的线性函数，任何一帧都对得上）。 */
  const animateTo = (frames: Keyframe[], target: 0 | 1, timing: { easing: string; duration: number }) => {
    // 已经在终点（刚建好就反向）：不空等一整条弹簧
    if (Math.abs(target - current) * width < MIN_SETTLE_DISTANCE) timing = { ...timing, duration: 0 }
    const list = channels.map((channel, i) =>
      channel.el.animate([frames[i]!, frameOf(channel, target)], { ...timing, fill: 'both' }),
    )
    current = target
    return run(list, target)
  }

  const settle = (target: 0 | 1, velocity = 0) => {
    const frames = freeze()
    const distance = Math.abs(target - current) * width
    // 朝目标方向的速度（返回时 t 增大 = 手指向右），换成弹簧的进度速度：每秒走过剩余距离的几倍
    const toward = (target > current ? 1 : -1) * (forward ? -velocity : velocity)
    const progressVelocity = distance >= MIN_SETTLE_DISTANCE ? (toward * 1000) / distance : 0
    const curve = pageCurve(progressVelocity)
    return animateTo(frames, target, { easing: curve.easing, duration: curve.durationMs })
  }

  const retarget = (target: 0 | 1) => {
    const frames = freeze()
    let timing: { easing: string; duration: number }
    if (reduced) {
      timing = {
        easing: MOTION.easeStandard,
        duration: NAV_REDUCED_DURATION_MS * Math.max(0.3, Math.abs(target - current)),
      }
    } else {
      const curve = pageCurve()
      timing = { easing: curve.easing, duration: curve.durationMs }
    }
    return animateTo(frames, target, timing)
  }

  const cleanup = () => {
    stop()
    for (const el of extras) el.remove()
    for (const layer of [over, under]) {
      layer.style.removeProperty('transform')
      layer.style.removeProperty('opacity')
      delete layer.dataset.navRole
      delete layer.dataset.navFx
      delete layer.dataset.navGhosted
    }
  }

  return { play, setProgress, settle, retarget, stop, cleanup }
}
