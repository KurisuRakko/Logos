/**
 * 左右滑动操作行（iOS 列表的 swipe actions），移植自 RakkoNotes。
 *
 * 手势（pointer 事件，触摸和鼠标同一套）：
 *   - 按下后先判方向：水平位移超过 SLOP 且明显大于竖直位移才接管；竖直先过阈值就放手，
 *     交给页面滚动（内容层 touch-action: pan-y，浏览器开始滚动会派 pointercancel）。
 *   - 接管后跟手；超过按钮总宽的部分走橡皮筋；没有按钮的那一侧拖不动。
 *     开了 full swipe 的一侧（leadingFullSwipe / trailingFullSwipe）一直跟手到行宽，超过行宽才走橡皮筋。
 *   - 松手：按「当前位置 + 速度投射」（spring.ts 的 projectMomentum）决定展开还是收起——快甩按方向，
 *     中速看投射落点，停顿后松手看当前位置；再从当前视觉位置带着松手速度用 snappy 弹簧收尾
 *     （springEasing 现算 linear() 曲线写到 --rk-swipe-ease / --rk-swipe-duration）：
 *     甩得快的起步陡、收尾短，慢慢拖的从静止起步；收起时初速度限幅，不越过 0（不露另一侧的按钮）。
 *   - full swipe（iOS 的 performsFirstActionWithFullSwipe）：拖过行宽 60% 且比按钮总宽多 40px 进入「待触发」
 *     （根上 data-armed）——最外侧按钮（trailing 最右、leading 最左）铺满整片按钮区（--rk-swipe-arm 0 → 1），
 *     支持振动的设备轻振一下；往回退 12px 解除。待触发时松手执行最外侧动作，和点按钮走同一条路径：
 *     trailing 侧整行先滑出再调 onAction（行应随之被 removing 移除），leading 侧收起后调 onAction。
 *   - 同一时间只展开一行；点行外任意处、页面开始滚动都会收起；展开时点行本体只收起、不触发 onPress。
 *
 * 位移放在根元素的 CSS 变量 --rk-swipe-x 上（@property 注册为 <length>，可以过渡）：
 * 内容层 translateX、两侧按钮区宽度都由它推出，拖动期间不触发 React 重渲染。
 *
 * 长按 / 右键菜单不在这里实现：调用方给内容层挂 data-context-action（经 ...rest 透传），
 * 由 design-system 的 context-action 运行时统一处理；这里只在有该属性时给长按的缩放反馈。
 *
 * 原生拖放（如宽屏分栏里把行拖进文件夹，鼠标设备）：传 draggable（经 ...rest 落在内容层），dataTransfer 在
 * onDragStart 里写、onDragEnd 收尾。浏览器开始拖动时先作废本行的滑动跟手与按压反馈（已经拉开一点的行收回去），
 * 不留半拉开的行。不传 draggable 时照旧禁止拖动内容层。
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  ComponentProps,
  DragEvent,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  Ref,
  TransitionEvent,
} from 'react'
import { cx } from '../cx'
import { cancelFlipAppear } from '../animated-list/flip-ids'
import { ListGroupContext, SwipeRowContext } from '../list/list-context'
import { SPRINGS, prefersReducedMotion, projectMomentum, rubberBand, springEasing } from '../spring'

export type SwipeActionTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

export interface SwipeAction {
  key: string
  /** 按钮文字，也是可访问名称。 */
  label: string
  icon?: ReactNode
  /** @default 'neutral' */
  tone?: SwipeActionTone
  onAction: () => void
}

export interface SwipeRowProps extends Omit<ComponentProps<'div'>, 'children' | 'onClick'> {
  /** 向右滑露出的按钮（排在行左侧），从左到右。 */
  leading?: SwipeAction[]
  /** 向左滑露出的按钮（排在行右侧），从左到右；最外侧（最右）放最重要的操作。 */
  trailing?: SwipeAction[]
  /** 点按 / Enter / Space 触发；给了就把内容层标成 role="button"。 */
  onPress?: () => void
  /** 为 true 时行高收起 + 淡出。 */
  removing?: boolean
  /** removing 的收起动画结束后调用一次（父组件据此真正删掉这一行）。 */
  onRemoved?: () => void
  /**
   * 放在 AnimatedList 里时的 FLIP 标识（容器内唯一）。写在根元素 .rk-swipe-row 上（其余属性透传给内层滑动层，
   * 这个不走 ...rest）：FLIP 量的是根元素，根元素同时带 data-rk-flip-collapse，出现时从 0fr 展开。
   */
  flipKey?: string
  /** 右滑到底（过行宽 60%）松手执行 leading 最外侧（最左，leading[0]）的动作。@default false */
  leadingFullSwipe?: boolean
  /**
   * 左滑到底（过行宽 60%）松手执行 trailing 最外侧（最右）的动作：整行先滑出再调 onAction，
   * 点这个按钮也一样。适合删除这类之后会把行拿掉（removing）的操作。@default false
   */
  trailingFullSwipe?: boolean
  children: ReactNode
}

/** 每个动作按钮展开后的宽度（px）。 */
export const SWIPE_ACTION_WIDTH = 74

/** 判定方向前允许的位移（px）。 */
const SLOP = 10
/** 长按缩放反馈在按下多久后开始（ms）；菜单本身由 context-action 在 500ms 打开。 */
const HOLD_FEEDBACK_DELAY = 150
const HOLD_FEEDBACK_END = 500
/** 触摸按下多久没动才显示按压高亮（ms），避免一滑就闪。 */
const PRESS_DELAY = 70
/** 轻点后按压高亮保留多久（ms），免得快速点按看不到反馈。 */
const PRESS_FLASH = 120
/** 速度阈值（px/ms）：超过就按甩动方向吸附。 */
const FLING_VELOCITY = 0.35
/** 速度投射的减速率（UIScrollView.DecelerationRate.fast）：松手后按这个减速还能滑多远，加到当前位置上判定。 */
const DECELERATION_RATE = 0.99
/** full swipe 的触发阈值：行宽的比例；至少比按钮总宽多出这么多（px），窄行上不会一展开就触发。 */
const FULL_SWIPE_RATIO = 0.6
const FULL_SWIPE_MIN_EXTRA = 40
/** 往回拖时多退这么多（px）才解除待触发，免得在阈值上抖动。 */
const FULL_SWIPE_HYSTERESIS = 12
/** 进入 / 解除待触发时的振动（ms）。 */
const ARM_VIBRATE_MS = 8
/** 滑出的行等内容层滑到大半再收拢（ms），与 swipe-row.css 的 transition-delay 一致。 */
const SWIPED_OUT_COLLAPSE_DELAY = 140
/** 滑出后这么久（ms，约等于一次 snappy 收尾）调用方仍没设 removing，就把行滑回来，不让它停在屏外。 */
const SLIDE_BACK_AFTER_MS = 500
/** 吸附弹簧：与 --motion-spring-snappy 同参（临界阻尼）。 */
const SETTLE_SPRING = SPRINGS.snappy
const SETTLE_OMEGA = (2 * Math.PI) / SETTLE_SPRING.response
/** 收起动画的兜底余量（ms）：transitionend 没来也会在「动画时长 + 余量」后调 onRemoved。 */
const REMOVE_GRACE = 120
/**
 * 读不到 token 时的收起时长（ms），与 --motion-spring-smooth-duration 一致：
 * 收拢走 smooth，与 AnimatedList 原位克隆的收拢节奏相同。
 */
const REMOVE_FALLBACK_MS = 675

/* ------------------------------------------------------------------ 同一时间只展开一行 */

interface OpenRow {
  root: HTMLElement
  close(): void
}

let openRow: OpenRow | null = null
/** 收起别的行那一下点击落在某行上：吞掉随之而来的 click，不触发 onPress。 */
let swallowClickUntil = 0

function closeOpenRow(except?: HTMLElement): void {
  if (openRow && openRow.root !== except) {
    const row = openRow
    openRow = null
    row.close()
  }
}

/** 收起当前展开的行（上下文菜单、Sheet 打开前调用）。 */
export function closeSwipeRows(): void {
  closeOpenRow()
}

/** 从 CSS 时长串（"675ms" / "0.5s"）读毫秒数，读不到返回 fallback。 */
function parseDuration(text: string, fallback: number): number {
  const value = Number.parseFloat(text)
  if (!Number.isFinite(value)) return fallback
  return text.trim().endsWith('ms') ? value : value * 1000
}

/**
 * 松手速度（px/ms）换成弹簧的归一化初速度（「进度 / 秒」，即 px/s ÷ 本次总位移）并限幅：
 * 剩余距离很短时折出来的进度速度会大得离谱。展开最多允许 1.3ω（snappy 的一点点过冲）；
 * 收起（toZero）限到 ω——临界阻尼弹簧初速度不超过 ω 就不会越过终点，不露另一侧的按钮。
 */
export function settleVelocity(velocity: number, distance: number, toZero: boolean): number {
  if (distance === 0) return 0
  const limit = SETTLE_OMEGA * (toZero ? 1 : 1.3)
  return Math.max(-limit, Math.min(limit, (velocity * 1000) / distance))
}

/** 内容层当前的视觉位移：吸附动画进行中取动画当下的值，否则就是设定值。 */
function visualOffset(root: HTMLElement, content: HTMLElement | null, fallback: number): number {
  if (root.dataset.settling === undefined || !content) return fallback
  return new DOMMatrixReadOnly(getComputedStyle(content).transform).m41
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref) ref.current = value
}

interface Gesture {
  pointerId: number
  startX: number
  startY: number
  startOffset: number
  phase: 'pending' | 'dragging' | 'scrolling'
  lastX: number
  lastT: number
  /** 位移速度（px/ms，按 --rk-swipe-x 的变化算，橡皮筋区里自然变慢）。 */
  velocity: number
  lastOffset: number
  pressTimer?: number
  holdTimer?: number
  holdEndTimer?: number
  /** 摘掉按下时挂在 window 上的监听器。 */
  detach(): void
}

type Side = 'none' | 'leading' | 'trailing'

export function SwipeRow({
  leading = [],
  trailing = [],
  onPress,
  removing = false,
  onRemoved,
  flipKey,
  leadingFullSwipe = false,
  trailingFullSwipe = false,
  className,
  children,
  ref,
  onPointerDown: userPointerDown,
  onKeyDown: userKeyDown,
  onDragStart: userDragStart,
  draggable,
  ...rest
}: SwipeRowProps) {
  const inListGroup = useContext(ListGroupContext)
  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const actionsRef = useRef<Record<'leading' | 'trailing', HTMLDivElement | null>>({
    leading: null,
    trailing: null,
  })
  const offsetRef = useRef(0)
  const gestureRef = useRef<Gesture | null>(null)
  const suppressClickUntil = useRef(0)
  /** 键盘展开后要把焦点移到的那一侧（等 inert 摘掉、重渲染后再移）。 */
  const focusSideRef = useRef<Side>('none')
  const [side, setSide] = useState<Side>('none')
  const [dragging, setDragging] = useState(false)

  const leadingWidth = leading.length * SWIPE_ACTION_WIDTH
  const trailingWidth = trailing.length * SWIPE_ACTION_WIDTH
  // 长按缩放只给挂了 context-action 表面的行
  const hasContextAction = (rest as Record<string, unknown>)['data-context-action'] !== undefined

  const setContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node
      assignRef(ref, node)
    },
    [ref],
  )

  /**
   * 设位移。animate 时从当前视觉位置（吸附动画进行中就取动画当下的值）带初速度 velocity（px/ms）弹到 x：
   * 按这一段的位移把速度换成归一化初速度，现算 snappy 弹簧曲线写到根上。
   */
  const setOffset = useCallback((x: number, animate: boolean, velocity = 0) => {
    const root = rootRef.current
    const from = root ? visualOffset(root, contentRef.current, offsetRef.current) : offsetRef.current
    offsetRef.current = x
    if (!root) return
    const distance = x - from
    if (animate && !prefersReducedMotion() && Math.abs(distance) >= 0.5) {
      const curve = springEasing(SETTLE_SPRING, settleVelocity(velocity, distance, x === 0))
      root.style.setProperty('--rk-swipe-ease', curve.easing)
      root.style.setProperty('--rk-swipe-duration', `${curve.durationMs}ms`)
      root.dataset.settling = ''
    } else {
      delete root.dataset.settling
    }
    root.style.setProperty('--rk-swipe-x', `${x}px`)
  }, [])

  /** full swipe 待触发状态（根上 data-armed）；变化时支持振动的设备轻振一下。 */
  const setArmed = useCallback((which: 'leading' | 'trailing' | null) => {
    const root = rootRef.current
    if (!root || (root.dataset.armed ?? null) === which) return
    if (which) root.dataset.armed = which
    else delete root.dataset.armed
    navigator.vibrate?.(ARM_VIBRATE_MS)
  }, [])

  const close = useCallback(
    (velocity = 0) => {
      const root = rootRef.current
      // 已经滑出、等着被移除的行不再弹回来
      if (root?.dataset.swipedOut !== undefined) return
      if (root) delete root.dataset.armed
      setOffset(0, true, velocity)
      setSide('none')
      focusSideRef.current = 'none'
      if (openRow?.root === root) openRow = null
    },
    [setOffset],
  )

  const openTo = useCallback(
    (target: 'leading' | 'trailing', velocity = 0) => {
      const root = rootRef.current
      if (!root) return
      delete root.dataset.armed
      setOffset(target === 'leading' ? leadingWidth : -trailingWidth, true, velocity)
      setSide(target)
      closeOpenRow(root)
      openRow = { root, close: () => close() }
    },
    [close, leadingWidth, trailingWidth, setOffset],
  )

  /**
   * 执行一个滑动动作：点按钮（含键盘）和 full swipe 松手都走这里，回调完全相同。
   * trailingFullSwipe 的最外侧动作：内容层带着松手速度继续向左滑出整行宽，行由调用方 removing 收拢；
   * 其余（以及 reduced-motion 下）先收起再执行。
   */
  const removingRef = useRef(removing)
  removingRef.current = removing
  const slideBackTimer = useRef(0)
  const runAction = (action: SwipeAction, which: 'leading' | 'trailing', velocity = 0) => {
    const root = rootRef.current
    // 已经滑出、动作已经执行过：滑出途中再点（铺满的最外侧按钮仍在屏上）不再重复执行
    if (root?.dataset.swipedOut !== undefined) return
    const outer = which === 'trailing' && trailingFullSwipe && action === trailing[trailing.length - 1]
    if (outer && root && !prefersReducedMotion()) {
      // 滑出期间最外侧按钮铺满整片按钮区
      root.dataset.armed = 'trailing'
      root.dataset.swipedOut = ''
      setOffset(-root.offsetWidth, true, velocity)
      if (openRow?.root === root) openRow = null
      // 动作没有把行拿掉（例如先弹确认框、或这一侧的最外侧动作本就不是删除）：滑回原位
      window.clearTimeout(slideBackTimer.current)
      slideBackTimer.current = window.setTimeout(() => {
        const r = rootRef.current
        if (!r || removingRef.current || r.dataset.swipedOut === undefined) return
        delete r.dataset.swipedOut
        delete r.dataset.armed
        setOffset(0, true)
        setSide('none')
      }, SLIDE_BACK_AFTER_MS)
    } else {
      close(velocity)
    }
    action.onAction()
  }

  // 展开时：点行外 / 任意滚动就收起（scroll 不冒泡，捕获阶段才收得到内部滚动容器的）
  useEffect(() => {
    if (side === 'none') return
    const root = rootRef.current
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!root || !target || root.contains(target)) return
      close()
      // 这一下落在另一行的内容上：只收起，不触发
      if (target.closest('.rk-swipe-row__content')) swallowClickUntil = Date.now() + 700
    }
    const onScroll = () => close()
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [side, close])

  // 键盘展开：按钮区摘掉 inert 之后再把焦点移到第一个按钮
  useEffect(() => {
    if (side === 'none' || focusSideRef.current !== side) return
    focusSideRef.current = 'none'
    actionsRef.current[side]?.querySelector('button')?.focus()
  }, [side])

  // 开始收拢时停掉 AnimatedList 的出现动画（它的 grid-template-rows 会盖住收拢的 CSS 过渡）；
  // 滑出后收拢被取消（removing 由 true 变回 false：撤销 / 操作失败）：内容层滑回来
  const wasRemoving = useRef(false)
  useEffect(() => {
    const root = rootRef.current
    if (removing) {
      wasRemoving.current = true
      cancelFlipAppear(root)
      return
    }
    if (!wasRemoving.current || !root) return
    wasRemoving.current = false
    if (root.dataset.swipedOut !== undefined) {
      delete root.dataset.swipedOut
      delete root.dataset.armed
      setOffset(0, true)
      setSide('none')
    }
  }, [removing, setOffset])

  // 收起动画：transitionend 正常会先到；兜底定时器防它不来；reduced-motion 下下一帧直接结束
  const onRemovedRef = useRef(onRemoved)
  onRemovedRef.current = onRemoved
  const removedRef = useRef(false)
  const finishRemove = useCallback(() => {
    if (removedRef.current) return
    removedRef.current = true
    onRemovedRef.current?.()
  }, [])

  useEffect(() => {
    if (!removing) {
      removedRef.current = false
      return
    }
    if (prefersReducedMotion()) {
      const frame = requestAnimationFrame(finishRemove)
      return () => cancelAnimationFrame(frame)
    }
    const root = rootRef.current
    const duration = root
      ? parseDuration(
          getComputedStyle(root).getPropertyValue('--motion-spring-smooth-duration'),
          REMOVE_FALLBACK_MS,
        )
      : REMOVE_FALLBACK_MS
    // 滑出的行收拢晚开始 SWIPED_OUT_COLLAPSE_DELAY
    const delay = root?.dataset.swipedOut !== undefined ? SWIPED_OUT_COLLAPSE_DELAY : 0
    const timer = window.setTimeout(finishRemove, duration + delay + REMOVE_GRACE)
    return () => window.clearTimeout(timer)
  }, [removing, finishRemove])

  // 卸载时别留下悬空的 openRow
  useEffect(
    () => () => {
      if (openRow?.root === rootRef.current) openRow = null
      window.clearTimeout(slideBackTimer.current)
      const g = gestureRef.current
      if (g) {
        window.clearTimeout(g.pressTimer)
        window.clearTimeout(g.holdTimer)
        window.clearTimeout(g.holdEndTimer)
        g.detach()
      }
    },
    [],
  )

  const clearGestureTimers = (g: Gesture) => {
    window.clearTimeout(g.pressTimer)
    window.clearTimeout(g.holdTimer)
    window.clearTimeout(g.holdEndTimer)
  }

  const clearFeedback = () => {
    const root = rootRef.current
    if (!root) return
    delete root.dataset.pressed
    delete root.dataset.holding
  }

  const endGesture = (event: PointerEvent | null) => {
    const g = gestureRef.current
    if (!g) return
    gestureRef.current = null
    clearGestureTimers(g)
    g.detach()

    if (g.phase !== 'dragging') {
      // 轻点：按压高亮留一下再淡出，免得快速点按看不到反馈
      if (event?.type === 'pointerup' && g.phase === 'pending' && g.startOffset === 0) {
        const root = rootRef.current
        if (root) {
          root.dataset.pressed = ''
          delete root.dataset.holding
          window.setTimeout(() => {
            if (root.dataset.pressed !== undefined && !gestureRef.current) delete root.dataset.pressed
          }, PRESS_FLASH)
        }
      } else {
        clearFeedback()
      }
      return
    }

    clearFeedback()
    setDragging(false)
    // 拖过之后浏览器还会补一个 click，不能当成点按
    suppressClickUntil.current = Date.now() + 400

    const x = offsetRef.current
    const v = event?.type === 'pointerup' ? g.velocity : 0
    const armed = rootRef.current?.dataset.armed
    // full swipe 待触发时松手（取消不算）：执行最外侧动作
    if (event?.type === 'pointerup' && (armed === 'trailing' || armed === 'leading')) {
      const action = armed === 'trailing' ? trailing[trailing.length - 1] : leading[0]
      if (action) {
        runAction(action, armed, v)
        return
      }
    }
    setArmed(null)
    // 位置 + 速度投射：快甩按方向，中速按投射落点，慢放按当前位置；阈值展开时低、收起时高
    const projected = x + projectMomentum(v * 1000, DECELERATION_RATE)
    const wasOpen = g.startOffset !== 0
    if (x < 0 && trailingWidth > 0) {
      const threshold = trailingWidth * (wasOpen ? 0.6 : 0.35)
      const open = v < -FLING_VELOCITY || (v <= FLING_VELOCITY && -projected > threshold)
      if (open) openTo('trailing', v)
      else close(v)
    } else if (x > 0 && leadingWidth > 0) {
      const threshold = leadingWidth * (wasOpen ? 0.6 : 0.35)
      const open = v > FLING_VELOCITY || (v >= -FLING_VELOCITY && projected > threshold)
      if (open) openTo('leading', v)
      else close(v)
    } else {
      close(v)
    }
  }

  // 这三个监听器在按下时挂到 window 上（鼠标拖出行外也能跟），抬手 / 取消时摘掉。
  function onWindowMove(event: PointerEvent) {
    const g = gestureRef.current
    const root = rootRef.current
    if (!g || !root || event.pointerId !== g.pointerId) return
    const dx = event.clientX - g.startX
    const dy = event.clientY - g.startY

    if (g.phase === 'pending') {
      const adx = Math.abs(dx)
      const ady = Math.abs(dy)
      if (adx > SLOP && adx > ady * 1.2 && (leadingWidth > 0 || trailingWidth > 0 || g.startOffset !== 0)) {
        g.phase = 'dragging'
        clearGestureTimers(g)
        clearFeedback()
        closeOpenRow(root)
        setDragging(true)
        // 从当前位置继续跟手，不跳
        g.startX = event.clientX
        g.lastX = event.clientX
        g.lastT = event.timeStamp
        g.lastOffset = offsetRef.current
      } else if (ady > SLOP || adx > SLOP) {
        // 竖向滚动（或无按钮行上的横移）：放手，交给页面
        g.phase = 'scrolling'
        clearGestureTimers(g)
        clearFeedback()
        if (offsetRef.current !== 0) close()
        return
      } else {
        return
      }
    }
    if (g.phase !== 'dragging') return

    const raw = g.startOffset + (event.clientX - g.startX)
    const rowWidth = root.offsetWidth
    const dim = rowWidth * 0.5
    // 跟手的上限：按钮总宽；开了 full swipe 的一侧放宽到行宽。超过上限的部分走橡皮筋
    const trailingLimit = trailingFullSwipe ? Math.max(rowWidth, trailingWidth) : trailingWidth
    const leadingLimit = leadingFullSwipe ? Math.max(rowWidth, leadingWidth) : leadingWidth
    let x: number
    if (raw < 0) x = trailingWidth > 0 ? (-raw <= trailingLimit ? raw : -trailingLimit + rubberBand(raw + trailingLimit, dim)) : 0
    else x = leadingWidth > 0 ? (raw <= leadingLimit ? raw : leadingLimit + rubberBand(raw - leadingLimit, dim)) : 0
    setOffset(x, false)

    // full swipe：过阈值进入待触发，往回退过（阈值 - 回差）解除
    const armed = root.dataset.armed
    const armAt = (width: number) => Math.max(rowWidth * FULL_SWIPE_RATIO, width + FULL_SWIPE_MIN_EXTRA)
    if (trailingFullSwipe && x < 0) {
      const at = armAt(trailingWidth)
      if (-x > at) setArmed('trailing')
      else if (armed === 'trailing' && -x < at - FULL_SWIPE_HYSTERESIS) setArmed(null)
    } else if (leadingFullSwipe && x > 0) {
      const at = armAt(leadingWidth)
      if (x > at) setArmed('leading')
      else if (armed === 'leading' && x < at - FULL_SWIPE_HYSTERESIS) setArmed(null)
    } else if (armed) {
      setArmed(null)
    }

    const dt = event.timeStamp - g.lastT
    if (dt > 0) {
      const instant = (x - g.lastOffset) / dt
      // 指数平滑，抵消触摸采样抖动
      g.velocity = g.velocity * 0.4 + instant * 0.6
    }
    g.lastX = event.clientX
    g.lastT = event.timeStamp
    g.lastOffset = x
  }

  function onWindowUp(event: PointerEvent) {
    const g = gestureRef.current
    if (!g || event.pointerId !== g.pointerId) return
    // 停顿后才松手：速度作废
    if (event.timeStamp - g.lastT > 80) g.velocity = 0
    endGesture(event)
  }

  function onWindowCancel(event: PointerEvent) {
    const g = gestureRef.current
    if (!g || event.pointerId !== g.pointerId) return
    endGesture(event)
  }

  // 窗口监听器在按下时挂上、抬手时摘掉；拖动途中父组件重渲染（换了 actions、宽度或 full swipe 开关）时，
  // 经由这个 ref 调到最新一次渲染的处理函数，不沿用按下那一刻的旧闭包。
  const windowHandlers = useRef({ move: onWindowMove, up: onWindowUp, cancel: onWindowCancel })
  windowHandlers.current = { move: onWindowMove, up: onWindowUp, cancel: onWindowCancel }

  const onContentPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    userPointerDown?.(event)
    if (event.defaultPrevented || event.button !== 0 || !event.isPrimary) return
    // 滑出途中（等调用方 removing 或滑回）不接新手势
    if (rootRef.current?.dataset.swipedOut !== undefined) return
    if (gestureRef.current) endGesture(null)
    const root = rootRef.current
    const content = contentRef.current
    if (!root || !content) return
    // 正在吸附的动画中途被按住：就地停下，从当前视觉位置接着拖
    if (root.dataset.settling !== undefined) setOffset(visualOffset(root, content, offsetRef.current), false)
    const move = (e: PointerEvent) => windowHandlers.current.move(e)
    const up = (e: PointerEvent) => windowHandlers.current.up(e)
    const cancel = (e: PointerEvent) => windowHandlers.current.cancel(e)
    const g: Gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: offsetRef.current,
      phase: 'pending',
      lastX: event.clientX,
      lastT: event.timeStamp,
      velocity: 0,
      lastOffset: offsetRef.current,
      detach: () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
      },
    }
    gestureRef.current = g
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)

    if (offsetRef.current !== 0) return // 展开状态：只等收起，不给按压反馈
    if (event.pointerType === 'mouse') {
      root.dataset.pressed = ''
    } else {
      g.pressTimer = window.setTimeout(() => {
        if (gestureRef.current === g && g.phase === 'pending') root.dataset.pressed = ''
      }, PRESS_DELAY)
      if (hasContextAction) {
        g.holdTimer = window.setTimeout(() => {
          if (gestureRef.current === g && g.phase === 'pending') root.dataset.holding = ''
        }, HOLD_FEEDBACK_DELAY)
        // 菜单在 500ms 打开：缩放随之回弹
        g.holdEndTimer = window.setTimeout(() => {
          if (gestureRef.current === g) clearFeedback()
        }, HOLD_FEEDBACK_END)
      }
    }
  }

  /** 浏览器接管成原生拖动：本行的手势作废（不再跟手、不算点按），已拉开的部分收回去。 */
  const onContentDragStart = (event: DragEvent<HTMLDivElement>) => {
    userDragStart?.(event)
    // 没开原生拖放：内容层不许拖（浏览器的拖动会打断滑动手势）
    if (draggable !== true && draggable !== 'true') {
      event.preventDefault()
      return
    }
    if (event.defaultPrevented) return
    const g = gestureRef.current
    if (g) {
      gestureRef.current = null
      clearGestureTimers(g)
      g.detach()
    }
    clearFeedback()
    setDragging(false)
    const root = rootRef.current
    if (root) delete root.dataset.armed
    if (offsetRef.current !== 0) close()
    // 拖完松手后浏览器可能补一个 click
    suppressClickUntil.current = Date.now() + 400
  }

  // 捕获阶段判定：内容层里的链接 / 按钮先于冒泡收到 click，抑制得在它们之前
  const onContentClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const now = Date.now()
    const swallowed = now < suppressClickUntil.current || now < swallowClickUntil
    if (!swallowed && offsetRef.current === 0) return
    event.preventDefault()
    event.stopPropagation()
    if (swallowed) {
      swallowClickUntil = 0
      return
    }
    // 展开状态：点内容只收起
    close()
  }

  const onContentClick = () => {
    onPress?.()
  }

  const openByKeyboard = (target: 'leading' | 'trailing') => {
    if ((target === 'leading' ? leading : trailing).length === 0) return false
    // 已经开在这一侧：side 不变，effect 不会跑，直接聚焦
    if (side === target) {
      actionsRef.current[target]?.querySelector('button')?.focus()
      return true
    }
    focusSideRef.current = target
    openTo(target)
    return true
  }

  const onContentKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    userKeyDown?.(event)
    if (event.defaultPrevented || event.target !== event.currentTarget) return
    if ((event.key === 'Enter' || event.key === ' ') && onPress) {
      event.preventDefault()
      onPress()
    } else if (event.key === 'ArrowLeft') {
      if (openByKeyboard('trailing')) event.preventDefault()
    } else if (event.key === 'ArrowRight') {
      if (openByKeyboard('leading')) event.preventDefault()
    }
  }

  // Escape 在内容层或按钮上都生效：收起并把焦点还给内容层
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || offsetRef.current === 0) return
    event.preventDefault()
    contentRef.current?.focus()
    close()
  }

  // 焦点移到行外就收起。relatedTarget 为 null 时不收：Safari 点 <button> 不给它焦点，
  // 内容层失焦时 relatedTarget 就是 null，这里收起会让操作区变 inert、吃掉这次点击；
  // 点到行外的情况交给上面的外部 pointerdown 收起。
  const onRootBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    if (!next || rootRef.current?.contains(next)) return
    if (offsetRef.current !== 0) close()
  }

  const onRootTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (removing && event.target === event.currentTarget && event.propertyName === 'grid-template-rows') {
      finishRemove()
    }
  }

  const renderActions = (actions: SwipeAction[], which: 'leading' | 'trailing') => {
    if (actions.length === 0) return null
    const shown = side === which
    const fullSwipe = which === 'leading' ? leadingFullSwipe : trailingFullSwipe
    // 最外侧：trailing 最右、leading 最左
    const outer = which === 'leading' ? actions[0] : actions[actions.length - 1]
    return (
      <div
        ref={(node) => {
          actionsRef.current[which] = node
        }}
        className={`rk-swipe-row__actions rk-swipe-row__actions--${which}`}
        inert={!shown}
        aria-hidden={shown ? undefined : true}
        data-full-swipe={fullSwipe ? '' : undefined}
        style={fullSwipe ? ({ '--rk-swipe-n': actions.length } as CSSProperties) : undefined}
      >
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className="rk-swipe-row__action"
            data-tone={action.tone ?? 'neutral'}
            data-outer={fullSwipe && action === outer ? '' : undefined}
            onClick={() => {
              // 键盘点的：按钮马上要变 inert，焦点先还给内容层
              if (actionsRef.current[which]?.contains(document.activeElement)) {
                contentRef.current?.focus({ preventScroll: true })
              }
              runAction(action, which)
            }}
          >
            <span className="rk-swipe-row__action-inner" data-press>
              {action.icon}
              <span className="rk-swipe-row__action-label">{action.label}</span>
            </span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={cx('rk-swipe-row', className)}
      role={inListGroup ? 'listitem' : undefined}
      data-removing={removing ? '' : undefined}
      data-rk-flip-key={flipKey}
      data-rk-flip-collapse=""
      data-dragging={dragging ? '' : undefined}
      data-open={side === 'none' ? undefined : side}
      onKeyDown={onRootKeyDown}
      onBlur={onRootBlur}
      onTransitionEnd={onRootTransitionEnd}
    >
      <div className="rk-swipe-row__clip">
        {renderActions(leading, 'leading')}
        {renderActions(trailing, 'trailing')}
        <div
          {...rest}
          ref={setContentRef}
          className="rk-swipe-row__content"
          tabIndex={0}
          role={onPress ? 'button' : undefined}
          onPointerDown={onContentPointerDown}
          onClickCapture={onContentClickCapture}
          onClick={onContentClick}
          onKeyDown={onContentKeyDown}
          draggable={draggable}
          onDragStart={onContentDragStart}
        >
          <SwipeRowContext.Provider value={true}>{children}</SwipeRowContext.Provider>
        </div>
      </div>
    </div>
  )
}
