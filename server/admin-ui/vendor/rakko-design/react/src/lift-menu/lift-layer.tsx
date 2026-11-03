/**
 * LiftMenu 的浮起层：压暗的底 + 浮起源的克隆（portal 到 body）。移植自 RakkoNotes 的 ContextMenu（RowLift）
 * 与长按图片的 ImageMenu——Rakko 定的样板，参数逐值照搬：
 *
 *   打开：克隆从源此刻的位置（长按时缩到 .97 的样子，或上一次还没落地的克隆此刻的位置）FLIP 弹簧浮起
 *   （snappy，略放大到 1.03、阴影），压暗的底淡入；原物藏起（只是 visibility，位置照旧占着）。
 *   关闭：克隆从当前姿态（动画中途也一样，可打断）弹回原物的位置、阴影与底淡出，落地后放回原物。
 *   原物不在了 / 滚出视口：row 原地淡出，media 以中心缩到 .9 并淡出。
 *
 * 两套参数（variant）：
 *   - row（默认，列表行）：浮起位置下方放不下菜单而上方放得下时不动（定位器把菜单翻到上方），两边都放不下才把行往上挪；
 *     阴影与底走 enter / exit 时长 + 标准缓动。
 *   - media（图片这类整块媒体）：菜单总放在下方，太高的源缩小预览、保证「源 + 菜单」一起放得下；
 *     底 240ms ease-out 淡入、260ms 淡出，阴影跟着弹簧时长。
 *
 * 为什么 portal 到 body：列表所在的栏可能有 transform / will-change（合成层），那会成为 fixed 的包含块。
 * 全屏层不用 touch-action: none（WebKit 卸载后残留、锁死页面滚动），滚动 / 捏合由 blockTouchScroll 用 JS 拦。
 */
import { useLayoutEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { MOTION } from '../motion'
import {
  boxTransform,
  boxVisible,
  currentTransform,
  reducedMotionQuery,
  rootTimeMs,
  rootToken,
  viewportSize,
} from '../motion-dom'
import type { Box } from '../motion-dom'
import { SPRINGS, springEasing } from '../spring'
import { blockTouchScroll } from './touch-block'

export type LiftVariant = 'row' | 'media'

/** 屏幕边距；菜单与浮起物的间距（与 Menu 定位器的 sideOffset 一致）。 */
const MARGIN = 12
const GAP = 6
const LIFT_SCALE = 1.03
/** media：预览最少留这么高（px），再矮就让菜单盖一点。 */
const MEDIA_MIN_HEIGHT = 80
/** media 退场：飞不回去时以中心缩到这个比例。 */
const MEDIA_SHRINK = 0.9
/** media 退场的缓动与时长（RakkoNotes ImageMenu）。 */
const MEDIA_EASE = 'cubic-bezier(0.2, 0, 0, 1)'
const MEDIA_SCRIM_ENTER = { duration: 240, easing: 'ease-out' }
const MEDIA_SCRIM_EXIT_MS = 260
const MEDIA_FADE_OUT_MS = 200
const MEDIA_REDUCED_PREVIEW_MS = 150
const MEDIA_REDUCED_SCRIM_MS = 200

/** 浮起期间藏起原物（只是 visibility，位置照旧占着）。 */
export const LIFT_SOURCE_ATTR = 'data-rk-lift-source'
const LAYER_CLASS = 'rk-lift-menu__layer'

export interface Lift {
  id: number
  /** 浮起源（长按的表面）：浮起期间藏起，量它的位置当起点 / 归处。 */
  source: HTMLElement
  /** 被克隆的元素：源是 SwipeRow 内容层时克隆整行根（行的样式选择器照样命中），其余就是源本身。 */
  target: HTMLElement
  /** 起飞时的视觉位置。 */
  from: Box
  /** 源的布局尺寸：克隆按这个尺寸排版（不改宽度，文字换行与原物一致），浮起靠 scale。 */
  size: { width: number; height: number }
  /** 浮起后的位置（视觉矩形）。 */
  rest: Box
  /** 压暗从多少开始（上一次的底还没淡完时接着它）。 */
  scrimFrom: number
  variant: LiftVariant
  /** 源处的 --rk-list-bg：克隆离开了列表容器，底色跟着带过去。 */
  listBg: string
}

let liftSeq = 0

function reduced(): boolean {
  return reducedMotionQuery()?.matches ?? false
}

/** snappy 弹簧（读 :root token，读不到用同参的 springEasing）。 */
function snappy(): { duration: number; easing: string } {
  const fallback = springEasing(SPRINGS.snappy)
  return {
    duration: rootTimeMs('--motion-spring-snappy-duration', fallback.durationMs),
    easing: rootToken('--motion-spring-snappy') || fallback.easing,
  }
}

/** enter / exit 时长 + 标准缓动（透明度用）。 */
function fade(kind: 'enter' | 'exit'): { duration: number; easing: string } {
  const fallback = kind === 'enter' ? MOTION.durationEnterMs : MOTION.durationExitMs
  return {
    duration: rootTimeMs(`--motion-duration-${kind}`, fallback),
    easing: rootToken('--motion-ease-standard') || MOTION.easeStandard,
  }
}

/** 上一次还没落地的浮起层（关闭途中又打开同一个源时从它此刻的位置起飞）。 */
export function findLayer(lift: Lift | null): { preview: Element; scrim: Element } | null {
  if (!lift) return null
  const layer = document.querySelector(`.${LAYER_CLASS}[data-lift-id="${lift.id}"]`)
  const preview = layer?.querySelector('.rk-lift-menu__preview')
  const scrim = layer?.querySelector('.rk-lift-menu__scrim')
  return preview && scrim ? { preview, scrim } : null
}

/**
 * 量一次浮起：起点、布局尺寸、浮起位置。menuHeight 是菜单高度的估算，浮起位置据此给菜单留空间。
 * previous：上一次的浮起层还没落地（关闭途中又长按同一个源），从克隆此刻的位置起飞、压暗接着它的透明度。
 */
export function measureLift(
  source: HTMLElement,
  variant: LiftVariant,
  menuHeight: number,
  previous: { preview: Element; scrim: Element } | null,
): Lift {
  const target = source.classList.contains('rk-swipe-row__content')
    ? (source.closest<HTMLElement>('.rk-swipe-row') ?? source)
    : source
  const size = { width: source.offsetWidth || 1, height: source.offsetHeight || 1 }
  const from: Box = (previous ? previous.preview : source).getBoundingClientRect()
  const vp = viewportSize()
  const rest = variant === 'media' ? mediaRest(from, menuHeight, vp) : rowRest(from, size, menuHeight, vp)
  const scrimFrom = previous ? Number(getComputedStyle(previous.scrim).opacity) || 0 : 0
  const listBg = getComputedStyle(source).getPropertyValue('--rk-list-bg').trim()
  return { id: ++liftSeq, source, target, from, size, rest, scrimFrom, variant, listBg }
}

/**
 * row：略放大，水平不出屏；菜单（按估算高度）下方放得下就留在原处，下方放不下而上方放得下也不动
 * （定位器会把菜单翻到上方），两边都放不下才把行往上挪，给下方的菜单让位。
 */
function rowRest(
  from: Box,
  size: { width: number; height: number },
  menuHeight: number,
  vp: { width: number; height: number },
): Box {
  const scale = Math.min(LIFT_SCALE, (vp.width - MARGIN * 2) / size.width)
  const width = size.width * scale
  const height = size.height * scale
  const left = Math.min(Math.max(from.left + (from.width - width) / 2, MARGIN), vp.width - MARGIN - width)
  let top = from.top + (from.height - height) / 2
  const below = vp.height - MARGIN - (top + height + GAP)
  const above = top - GAP - MARGIN
  if (below < menuHeight && above < menuHeight) top = vp.height - MARGIN - menuHeight - GAP - height
  top = Math.max(MARGIN, Math.min(top, vp.height - MARGIN - height))
  return { left, top, width, height }
}

/** media：放大一点，必要时缩小 / 挪动，菜单总在下方，「源 + 菜单」一起放得下。 */
function mediaRest(from: Box, menuHeight: number, vp: { width: number; height: number }): Box {
  const room = vp.height - menuHeight - GAP - MARGIN * 2
  const scale = Math.min(
    LIFT_SCALE,
    (vp.width - MARGIN * 2) / from.width,
    Math.max(MEDIA_MIN_HEIGHT, room) / from.height,
  )
  const width = from.width * scale
  const height = from.height * scale
  const left = Math.min(Math.max(from.left + (from.width - width) / 2, MARGIN), vp.width - MARGIN - width)
  const maxTop = vp.height - MARGIN - menuHeight - GAP - height
  const top = Math.max(MARGIN, Math.min(from.top + (from.height - height) / 2, maxTop))
  return { left, top, width, height }
}

/**
 * 原物的归处。不在文档里 / 没有尺寸时为 null。
 *   - row：布局位置（去掉长按缩放：飞回的是它松开后的样子）；
 *   - media：落定后的位置——原物还在过渡（刚在菜单里改了大小）时，把源与父元素上的动画临时拨到终点量一下再拨回，
 *     克隆直接飞向终点，和原物同时落定。同步完成，中间不会画出来。
 */
function homeBox(lift: Lift): Box | null {
  const { source } = lift
  if (!source.isConnected || source.offsetWidth === 0) return null
  if (lift.variant === 'media') {
    const owners = [source, source.parentElement].filter((el): el is HTMLElement => el !== null)
    const anims = owners.flatMap((el) => (typeof el.getAnimations === 'function' ? el.getAnimations() : []))
    const saved = anims.map((anim) => anim.currentTime)
    for (const anim of anims) {
      const end = anim.effect?.getComputedTiming().endTime
      if (typeof end === 'number' && Number.isFinite(end)) anim.currentTime = end
    }
    const rect = source.getBoundingClientRect()
    anims.forEach((anim, i) => {
      anim.currentTime = saved[i] ?? null
    })
    return rect
  }
  const rect = source.getBoundingClientRect()
  const width = source.offsetWidth
  const height = source.offsetHeight
  return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height }
}

/** 克隆根上要去掉的状态：FLIP、按压 / 长按 / 展开 / 拖动 / 收拢标记。 */
const ROOT_ATTRS = [
  'data-rk-flip-key',
  'data-rk-flip-collapse',
  'data-holding',
  'data-pressed',
  'data-open',
  'data-dragging',
  'data-armed',
  'data-settling',
  'data-removing',
  'data-swiped-out',
]
/** 克隆里所有节点上要去掉的：长按标记、可聚焦、可拖、id。 */
const NODE_ATTRS = ['data-context-id', 'data-context-action', 'tabindex', 'draggable', 'id', LIFT_SOURCE_ATTR]
const NODE_SELECTOR = NODE_ATTRS.map((name) => `[${name}]`).join(', ')

/** 浮起源的静态拷贝：去掉 FLIP / 长按 / 按压标记、SwipeRow 两侧按钮、可聚焦与 id，不可交互。 */
function cloneTarget(lift: Lift): HTMLElement {
  const clone = lift.target.cloneNode(true) as HTMLElement
  for (const name of ROOT_ATTRS) clone.removeAttribute(name)
  if (lift.target !== lift.source) {
    clone.style.setProperty('--rk-swipe-x', '0px')
    for (const el of clone.querySelectorAll('.rk-swipe-row__actions')) el.remove()
  }
  for (const el of [clone, ...clone.querySelectorAll(NODE_SELECTOR)]) {
    for (const name of NODE_ATTRS) el.removeAttribute(name)
  }
  // 铺满预览框（预览框就是源的布局尺寸）：离开原来的布局上下文，外边距与尺寸规则不再适用
  Object.assign(clone.style, { width: '100%', height: '100%', margin: '0', boxSizing: 'border-box' })
  return clone
}

interface LiftLayerProps {
  lift: Lift
  open: boolean
  onLanded: (lift: Lift) => void
}

export function LiftLayer({ lift, open, onLanded }: LiftLayerProps) {
  const previewRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const shadowRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const enterAnims = useRef<Animation[]>([])
  const onLandedRef = useRef(onLanded)
  onLandedRef.current = onLanded

  const rest = boxTransform(lift.rest, lift.rest, lift.size)

  // 打开：放克隆、藏原物，克隆从起点弹簧浮起，阴影与底淡入
  useLayoutEffect(() => {
    bodyRef.current?.replaceChildren(cloneTarget(lift))
    lift.source.setAttribute(LIFT_SOURCE_ATTR, '')
    const preview = previewRef.current
    const scrim = scrimRef.current
    const shadow = shadowRef.current
    if (preview && scrim && shadow && typeof preview.animate === 'function' && !reduced()) {
      const spring = snappy()
      const flight = preview.animate(
        [{ transform: boxTransform(lift.from, lift.rest, lift.size) }, { transform: rest }],
        spring,
      )
      if (lift.variant === 'media') {
        enterAnims.current = [
          flight,
          shadow.animate([{ opacity: 0 }, { opacity: 1 }], spring.duration),
          scrim.animate([{ opacity: lift.scrimFrom }, { opacity: 1 }], MEDIA_SCRIM_ENTER),
        ]
      } else {
        const enter = fade('enter')
        enterAnims.current = [
          flight,
          shadow.animate([{ opacity: 0 }, { opacity: 1 }], enter),
          scrim.animate([{ opacity: lift.scrimFrom }, { opacity: 1 }], enter),
        ]
      }
    }
    return () => {
      for (const anim of enterAnims.current) anim.cancel()
      enterAnims.current = []
      lift.source.removeAttribute(LIFT_SOURCE_ATTR)
    }
    // rest 由 lift 算出
  }, [lift])

  // 关闭：从此刻的姿态飞回（或原地淡出），全部播完再放回原物、通知卸载
  useLayoutEffect(() => {
    if (open) return
    const preview = previewRef.current
    const scrim = scrimRef.current
    const shadow = shadowRef.current
    const land = () => {
      lift.source.removeAttribute(LIFT_SOURCE_ATTR)
      onLandedRef.current(lift)
    }
    if (!preview || !scrim || !shadow || typeof preview.animate !== 'function') {
      land()
      return
    }
    // 从此刻的姿态接着走：先读下进场动画当前的值，再停掉它
    const from = currentTransform(preview)
    const scrimOpacity = getComputedStyle(scrim).opacity || '1'
    const shadowOpacity = getComputedStyle(shadow).opacity || '1'
    for (const anim of enterAnims.current) anim.cancel()
    enterAnims.current = []

    const anims =
      lift.variant === 'media'
        ? mediaExit(lift, preview, scrim, shadow, from, scrimOpacity, shadowOpacity)
        : rowExit(lift, preview, scrim, shadow, from, scrimOpacity, shadowOpacity)
    let done = false
    Promise.all(anims.map((anim) => anim.finished)).then(
      () => {
        done = true
        land()
      },
      () => {},
    )
    return () => {
      if (!done) for (const anim of anims) anim.cancel()
    }
  }, [open, lift])

  const style = {
    left: lift.rest.left,
    top: lift.rest.top,
    width: lift.size.width,
    height: lift.size.height,
    transform: rest,
    ...(lift.listBg ? { '--rk-list-bg': lift.listBg } : null),
  } as CSSProperties

  return createPortal(
    <div
      ref={blockTouchScroll}
      className={LAYER_CLASS}
      aria-hidden="true"
      data-variant={lift.variant}
      data-closing={open ? undefined : ''}
      data-lift-id={lift.id}
    >
      <div ref={scrimRef} className="rk-lift-menu__scrim" />
      <div ref={previewRef} className="rk-lift-menu__preview" style={style}>
        <div ref={shadowRef} className="rk-lift-menu__shadow" />
        <div ref={bodyRef} className="rk-lift-menu__clone" inert />
      </div>
    </div>,
    document.body,
  )
}

/** row 退场：飞回布局位置，阴影与底按 exit 时长淡出；没处可回（或减弱动效）就原地淡出。 */
function rowExit(
  lift: Lift,
  preview: HTMLElement,
  scrim: HTMLElement,
  shadow: HTMLElement,
  from: string,
  scrimOpacity: string,
  shadowOpacity: string,
): Animation[] {
  const out = { ...fade('exit'), fill: 'forwards' as const }
  const anims = [scrim.animate([{ opacity: scrimOpacity }, { opacity: 0 }], out)]
  const back = homeBox(lift)
  if (reduced() || !back || !boxVisible(back)) {
    anims.push(preview.animate([{ transform: from, opacity: 1 }, { transform: from, opacity: 0 }], out))
  } else {
    anims.push(
      preview.animate([{ transform: from }, { transform: boxTransform(back, lift.rest, lift.size) }], {
        ...snappy(),
        fill: 'forwards',
      }),
      shadow.animate([{ opacity: shadowOpacity }, { opacity: 0 }], out),
    )
  }
  return anims
}

/**
 * media 退场：飞回用和浮起同一条 snappy 弹簧（临界阻尼、不过冲），进退手感一致；
 * 没处可回（原物滚出视口 / 已经不在）以中心缩到 .9 并淡出。减弱动效时只淡出。
 */
function mediaExit(
  lift: Lift,
  preview: HTMLElement,
  scrim: HTMLElement,
  shadow: HTMLElement,
  from: string,
  scrimOpacity: string,
  shadowOpacity: string,
): Animation[] {
  if (reduced()) {
    return [
      preview.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MEDIA_REDUCED_PREVIEW_MS, fill: 'forwards' }),
      scrim.animate([{ opacity: scrimOpacity }, { opacity: 0 }], { duration: MEDIA_REDUCED_SCRIM_MS, fill: 'forwards' }),
    ]
  }
  const spring = snappy()
  const anims: Animation[] = []
  const back = homeBox(lift)
  if (back && boxVisible(back)) {
    anims.push(
      preview.animate([{ transform: from }, { transform: boxTransform(back, lift.rest, lift.size) }], {
        ...spring,
        fill: 'forwards',
      }),
      shadow.animate([{ opacity: shadowOpacity }, { opacity: 0 }], { duration: spring.duration, fill: 'forwards' }),
    )
  } else {
    const { left, top, width, height } = lift.rest
    const inset = (1 - MEDIA_SHRINK) / 2
    const shrunk: Box = {
      left: left + width * inset,
      top: top + height * inset,
      width: width * MEDIA_SHRINK,
      height: height * MEDIA_SHRINK,
    }
    anims.push(
      preview.animate([{ transform: from }, { transform: boxTransform(shrunk, lift.rest, lift.size) }], {
        ...spring,
        fill: 'forwards',
      }),
      preview.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: MEDIA_FADE_OUT_MS,
        easing: MEDIA_EASE,
        fill: 'forwards',
      }),
    )
  }
  anims.push(
    scrim.animate([{ opacity: scrimOpacity }, { opacity: 0 }], {
      duration: MEDIA_SCRIM_EXIT_MS,
      easing: MEDIA_EASE,
      fill: 'forwards',
    }),
  )
  return anims
}
