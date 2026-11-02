/**
 * 长按 / 右键的浮起菜单（iOS 上下文菜单的 React 层），移植自 RakkoNotes 的 ContextMenu 与长按图片的 ImageMenu。
 * 叫 LiftMenu 是因为 ContextMenu 已是 Base UI ContextMenu 的包装（Root / Trigger 组合式，#25）；这里是受控的 anchor 式 API。
 *
 * 手势用 design-system 的 context-action 运行时（长按 500ms、移动超 10px 取消、右键、去重、触觉反馈、
 * iOS 抬手 click 抑制都在里面）：useContextAction(rootRef, onOpen) 在容器上装一次委托，
 * 可长按的表面带 data-context-action（SwipeRow 经 ...rest 透传到滑动层）。
 *
 * 呈现：两种视口都在按点 / 浮起的源旁开菜单（docs/2026-10-18-list-motion.md 修订了「紧凑视口升 Sheet」）。
 *   - anchor 不为 null 就是打开。anchor.source 是浮起源：传了就压暗背景、源的克隆从原位弹簧浮起，
 *     菜单贴着浮起的克隆（下方放不下翻到上方）；关闭时克隆飞回、落地后放回原物（lift-layer.tsx，
 *     docs/2026-10-24-lift-menu.md）。鼠标右键（anchor.pointer）源照样浮起，菜单留在鼠标处。
 *     不传 source 就是按点处的纯锚点菜单。
 *   - 定位用 Positioner 的虚拟锚点（浮起位置的矩形，或按点处零尺寸的矩形），碰撞时 Base UI 自动翻转、收边。
 *   - 关闭动画期间保留最后的 anchor 与 children：调用方此时往往已经把数据清空。
 *   - 打开时收起展开着的 SwipeRow。
 *
 * 菜单项的动作默认推迟到菜单收起后执行（iOS 先收菜单、再弹对话框的节奏）：「收起」= exit 淡出走完或整个关闭动画结束，
 * 先到先算（缩放弹簧的尾巴肉眼已看不见，动作不干等它）。afterLanding 的动作（会挪走 / 拿掉浮起源：删除、置顶换组）
 * 等克隆落回原位再执行，接上行的收拢 / 重排动画，不先闪回原样。immediate 的动作在点按里同步执行
 * （读写剪贴板、分享要在用户手势里发起）。
 *
 * 打开那一刻的手势还没结束（触摸长按时手指还按着）。抬手后 iOS Safari / 触屏模拟会把这次触摸补成
 * mousedown → mouseup → click：Menu 的「点外部关闭」在 mousedown 上就生效，刚弹出的菜单会被这次抬手关掉；
 * 抬手处恰好落在菜单项上时，补来的 click 还会激活它。所以打开后、下一次 pointerdown 之前：
 * 「点外部」的关闭请求不理，菜单项上 detail > 0 的 click 不执行（键盘与读屏的 click detail 为 0，照常执行）。
 * 只管本组件的菜单，不在全窗口吞事件（context-action.md：只拦触发表面）。
 */
import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode, RefObject } from 'react'
import { installContextAction } from '@rakko/design-system/context-action'
import type { ContextActionAnchor } from '@rakko/design-system/context-action'
import { cx } from '../cx'
import { MOTION } from '../motion'
import { rootTimeMs } from '../motion-dom'
import type { Box } from '../motion-dom'
import { Menu } from '../menu/menu'
import type { MenuItemProps, MenuPopupProps } from '../menu/menu'
import { closeSwipeRows } from '../swipe-row/swipe-row'
import { LiftLayer, findLayer, measureLift } from './lift-layer'
import type { Lift, LiftVariant } from './lift-layer'

export type { LiftVariant } from './lift-layer'

/** 长按 / 右键的落点（视口坐标），以及可选的浮起源。 */
export interface LiftMenuAnchor extends ContextActionAnchor {
  /**
   * 浮起源（通常就是 useContextAction 收到的表面）：传了就压暗背景、把它的克隆浮起来，菜单贴着克隆；
   * 不传就是按点处的锚点菜单。SwipeRow 的内容层会连整行一起克隆（两侧按钮除外）。
   */
  source?: HTMLElement | null
  /** 鼠标右键打开（useContextAction 会填）：源照样浮起，菜单留在鼠标处。 */
  pointer?: boolean
}

/**
 * 在 rootRef 内安装长按 / 右键委托（installContextAction 的 React 包装），卸载时自动拆掉。
 * onOpen 收到命中的表面元素（带 data-context-action 的那个）与落点；业务数据挂在表面的 data-* 上。
 * 落点带 pointer：最近一次按下是鼠标（右键）时为 true。要浮起就把表面作为 source 传给 LiftMenu：
 * `setMenu({ ...anchor, source: surface })`。
 */
export function useContextAction(
  rootRef: RefObject<HTMLElement | null>,
  onOpen: (surface: HTMLElement, anchor: LiftMenuAnchor) => void,
): void {
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    // 运行时不告诉我们是长按还是右键：自己记下最近一次按下的指针类型
    let lastPointerType = ''
    const onPointerDown = (event: PointerEvent) => {
      lastPointerType = event.pointerType
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    const uninstall = installContextAction({
      root,
      onOpen: (surface, anchor) => onOpenRef.current(surface, { ...anchor, pointer: lastPointerType === 'mouse' }),
    })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      uninstall()
    }
  }, [rootRef])
}

/** 菜单高度的估算（浮起位置据此给菜单留空间）：每项（含分隔线）41px + 上下内边距 8px。 */
const ITEM_HEIGHT = 41
const MENU_PADDING = 8

/** 菜单项个数（Fragment 展开），估算菜单高度用。 */
function countItems(children: ReactNode): number {
  let count = 0
  Children.forEach(children, (child) => {
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) count += countItems(child.props.children)
    else if (child) count += 1
  })
  return count
}

/** 按矩形（浮起位置，或按点处零尺寸）给 Positioner 的虚拟锚点。 */
function boxAnchor({ left, top, width, height }: Box) {
  const right = left + width
  const bottom = top + height
  return {
    getBoundingClientRect: () =>
      ({ x: left, y: top, top, left, right, bottom, width, height, toJSON: () => ({ left, top }) }) as DOMRect,
  }
}

/**
 * 推迟执行：菜单开始收起（closing）后 exit 时长到点、或关闭动画结束（closed），先到先算。
 */
function useAfterMenuClose() {
  const pending = useRef<(() => void) | null>(null)
  const timer = useRef(0)
  return useMemo(() => {
    const flush = () => {
      window.clearTimeout(timer.current)
      const action = pending.current
      pending.current = null
      action?.()
    }
    return {
      defer: (action: () => void) => {
        pending.current = action
      },
      closing: () => {
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(flush, rootTimeMs('--motion-duration-exit', MOTION.durationExitMs))
      },
      closed: flush,
    }
  }, [])
}

interface ItemContext {
  /** 打开菜单的手势还没结束（打开后还没见到新的 pointerdown）。 */
  releasePending: RefObject<boolean>
  /** 推迟执行；afterLanding：等浮起的克隆落回原位。 */
  defer: (action: () => void, afterLanding: boolean) => void
}

const LiftMenuContext = createContext<ItemContext | null>(null)

export interface LiftMenuProps extends Omit<MenuPopupProps, 'anchor' | 'children'> {
  /** 落点（与可选的浮起源）；null = 关闭。 */
  anchor: LiftMenuAnchor | null
  /** 用户要求关闭（点外部、Esc、选了菜单项）。调用方把 anchor 设回 null。 */
  onClose: () => void
  /**
   * 浮起的参数组：row（列表行，菜单可翻到上方）或 media（图片这类整块媒体：菜单总在下方，太高的源缩小预览；
   * 菜单从 .85 而不是 .6 长出来，压暗的进退时长不同）。只在传了 anchor.source 时生效。@default 'row'
   */
  liftVariant?: LiftVariant
  /** 菜单的无障碍名称（「备忘录操作」）。 */
  'aria-label': string
  children: ReactNode
}

function LiftMenuRoot({ anchor, onClose, liftVariant = 'row', className, children, ...props }: LiftMenuProps) {
  const open = anchor !== null
  // 关闭动画期间锚点和菜单内容都还要保持原样（调用方此时往往已经把数据清空）
  const last = useRef<{ anchor: LiftMenuAnchor; children: ReactNode }>({ anchor: { x: 0, y: 0 }, children: null })
  if (anchor) last.current = { anchor, children }
  const shown = last.current.anchor

  // 每次打开（anchor 换了）量一次浮起位置；上一次的克隆还没落地（关闭途中又长按同一个源）就从克隆此刻的位置起飞
  const liftFor = useRef<{ anchor: LiftMenuAnchor | null; lift: Lift | null }>({ anchor: null, lift: null })
  if (anchor && liftFor.current.anchor !== anchor) {
    const prevLift = liftFor.current.lift
    const previous = prevLift && prevLift.source === anchor.source ? findLayer(prevLift) : null
    const source = anchor.source
    liftFor.current = {
      anchor,
      lift: source?.isConnected
        ? measureLift(source, liftVariant, MENU_PADDING + countItems(children) * ITEM_HEIGHT, previous)
        : null,
    }
  }
  const lift = liftFor.current.lift

  // 克隆落地后才卸掉浮起层；afterLanding 的动作等落地再执行
  const [landed, setLanded] = useState<Lift | null>(null)
  const settled = useRef(true)
  const late = useRef<(() => void) | null>(null)
  settled.current = !lift || landed === lift

  // 换了一次新的浮起（上一次没落地就又打开）：上一次挂着的动作立即执行，不丢
  useLayoutEffect(() => {
    const action = late.current
    late.current = null
    action?.()
  }, [lift])

  const runAfterLanding = useCallback((action: () => void) => {
    if (settled.current) action()
    else late.current = action
  }, [])

  const onLanded = useCallback((which: Lift) => {
    settled.current = true
    setLanded(which)
    const action = late.current
    late.current = null
    action?.()
  }, [])

  const after = useAfterMenuClose()
  const releasePending = useRef(false)
  const context = useMemo<ItemContext>(
    () => ({
      releasePending,
      defer: (action, afterLanding) => after.defer(afterLanding ? () => runAfterLanding(action) : action),
    }),
    [after, runAfterLanding],
  )

  // 每次打开（含打开状态下换了落点）：收起 SwipeRow，并等打开它的那次手势结束
  useLayoutEffect(() => {
    if (!anchor) return
    closeSwipeRows()
    releasePending.current = true
    const onPointerDown = () => {
      releasePending.current = false
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [anchor])

  // 右键：菜单在鼠标处；长按：贴着浮起的源；没有源：按点
  const box: Box = lift && !shown.pointer ? lift.rest : { left: shown.x, top: shown.y, width: 0, height: 0 }
  const { left, top, width, height } = box
  const virtual = useMemo(() => boxAnchor({ left, top, width, height }), [left, top, width, height])
  const variant = lift?.variant

  return (
    <LiftMenuContext.Provider value={context}>
      <Menu.Root
        open={open}
        onOpenChange={(next, details) => {
          if (next) return
          if (details.reason === 'outside-press' && releasePending.current) {
            details.cancel()
            return
          }
          after.closing()
          onClose()
        }}
        onOpenChangeComplete={(next) => {
          if (!next) after.closed()
        }}
      >
        {lift && landed !== lift ? <LiftLayer key={lift.id} lift={lift} open={open} onLanded={onLanded} /> : null}
        <Menu.Popup
          {...props}
          anchor={virtual}
          className={cx('rk-lift-menu', className)}
          data-lift-variant={variant}
        >
          {anchor ? children : last.current.children}
        </Menu.Popup>
      </Menu.Root>
    </LiftMenuContext.Provider>
  )
}

export interface LiftMenuItemProps extends MenuItemProps {
  /** 行尾图标（iOS 上下文菜单的排布：文字在左、图标在右）。 */
  icon?: ReactNode
  /** 勾选状态（文字样式、排序方式这类）：true 时在文字前画勾；传了就是 menuitemcheckbox。 */
  checked?: boolean
  /**
   * 在点按里同步执行，不等菜单收起：读写剪贴板、分享要在用户手势里发起（Safari 要求）。
   * 也可以在 onClick 里调 event.preventBaseUIHandler() 让菜单不关。@default false
   */
  immediate?: boolean
  /**
   * 动作会挪走 / 拿掉浮起源（删除、恢复、置顶换组）：等克隆落回原位再执行，接上行的收拢 / 重排动画。
   * 没有浮起时与默认相同。@default false
   */
  afterLanding?: boolean
  // 危险项沿用 Menu.Item 的 variant="danger"（rk-menu__item--danger：错误色文字与高亮层），不另设一套
}

const CHECK_ICON = (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

function LiftMenuItem({
  icon,
  checked,
  immediate = false,
  afterLanding = false,
  className,
  children,
  onClick,
  ...props
}: LiftMenuItemProps) {
  const context = useContext(LiftMenuContext)
  const checkable = checked !== undefined
  return (
    <Menu.Item
      {...(checkable ? { role: 'menuitemcheckbox', 'aria-checked': checked } : null)}
      {...props}
      className={cx('rk-lift-menu__item', className)}
      data-checked={checked ? '' : undefined}
      onClick={(event) => {
        // 打开菜单那次触摸抬手补来的 click（抬手处正好在菜单项上）：不算选择
        if (context?.releasePending.current && event.detail > 0) {
          event.preventBaseUIHandler()
          return
        }
        if (!onClick) return
        if (immediate || !context) onClick(event)
        else context.defer(() => onClick(event), afterLanding)
      }}
    >
      {checked ? <span className="rk-lift-menu__check">{CHECK_ICON}</span> : null}
      <span className="rk-lift-menu__label">{children}</span>
      {icon != null ? (
        <span className="rk-lift-menu__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
    </Menu.Item>
  )
}

export const LiftMenu = Object.assign(LiftMenuRoot, {
  Item: LiftMenuItem,
  Separator: Menu.Separator,
})
