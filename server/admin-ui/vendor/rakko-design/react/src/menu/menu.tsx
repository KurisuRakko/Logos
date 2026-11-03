import { Menu as BaseMenu } from '@base-ui/react/menu'
import type { ComponentProps } from 'react'
import { cx } from '../cx.js'

export interface MenuPopupProps
  extends Omit<ComponentProps<typeof BaseMenu.Popup>, 'className'> {
  className?: string
  /**
   * 定位锚点，转给 Positioner；不传就锚在 Trigger 上。
   * 可以是虚拟元素（只需 getBoundingClientRect），LiftMenu 用它锚在长按 / 右键的落点。
   */
  anchor?: ComponentProps<typeof BaseMenu.Positioner>['anchor']
}

/**
 * 组合 Portal > Positioner(sideOffset 6) > Popup：视觉类 rk-menu 落在 Popup 上。
 */
function MenuPopup({ className, anchor, children, ...props }: MenuPopupProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner sideOffset={6} anchor={anchor} className="rk-menu__positioner">
        <BaseMenu.Popup
          {...props}
          className={cx('rk-menu', className)}
          data-glass="panel"
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  )
}

export interface MenuItemProps
  extends Omit<ComponentProps<typeof BaseMenu.Item>, 'className'> {
  className?: string
  /**
   * 视觉变体：danger 用于删除这类破坏性动作（error 色文字 + error 色高亮层），
   * 禁用时仍沿用 data-disabled 的降透明度。
   * @default 'default'
   */
  variant?: 'default' | 'danger'
}

function MenuItem({ className, variant = 'default', ...props }: MenuItemProps) {
  return (
    <BaseMenu.Item
      {...props}
      data-ripple
      className={cx(
        'rk-menu__item',
        variant === 'danger' && 'rk-menu__item--danger',
        className,
      )}
    />
  )
}

export interface MenuSeparatorProps
  extends Omit<ComponentProps<typeof BaseMenu.Separator>, 'className'> {
  className?: string
}

function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
  return (
    <BaseMenu.Separator
      {...props}
      className={cx('rk-menu__separator', className)}
    />
  )
}

export interface MenuGroupProps
  extends Omit<ComponentProps<typeof BaseMenu.Group>, 'className'> {
  className?: string
}

function MenuGroup({ className, ...props }: MenuGroupProps) {
  return <BaseMenu.Group {...props} className={className} />
}

export interface MenuGroupLabelProps
  extends Omit<ComponentProps<typeof BaseMenu.GroupLabel>, 'className'> {
  className?: string
}

function MenuGroupLabel({ className, ...props }: MenuGroupLabelProps) {
  return (
    <BaseMenu.GroupLabel
      {...props}
      className={cx('rk-menu__group-label', className)}
    />
  )
}

export interface MenuSubmenuTriggerProps
  extends Omit<ComponentProps<typeof BaseMenu.SubmenuTrigger>, 'className'> {
  className?: string
}

/**
 * 子菜单的入口项：外观与 Item 相同（rk-menu__item），行尾带 ›；
 * 子菜单打开期间 Base UI 给它挂 data-popup-open，高亮层保持不灭。
 * 悬停打开（openOnHover 默认 true）、ArrowRight / Enter 打开、ArrowLeft 收回都由 Base UI 负责。
 */
function MenuSubmenuTrigger({
  className,
  children,
  ...props
}: MenuSubmenuTriggerProps) {
  return (
    <BaseMenu.SubmenuTrigger
      {...props}
      data-ripple
      className={cx('rk-menu__item', 'rk-menu__submenu-trigger', className)}
    >
      <span className="rk-menu__submenu-label">{children}</span>
      <ChevronGlyph />
    </BaseMenu.SubmenuTrigger>
  )
}

/** 行尾 ›（chevron.right）；RTL 下由 CSS 镜像。 */
function ChevronGlyph() {
  return (
    <svg
      className="rk-menu__submenu-chevron"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

export interface MenuSubmenuPopupProps
  extends Omit<ComponentProps<typeof BaseMenu.Popup>, 'className'> {
  className?: string
}

/**
 * 子菜单面板：Portal > Positioner > Popup，视觉同 rk-menu，另加 rk-menu--submenu（只淡入、不位移）。
 * Positioner 用 Base UI 嵌套菜单的默认：side inline-end、align start，放不下时翻到另一侧；
 * alignOffset -4 抵掉面板 4px 内边距，让子菜单首项与 trigger 同一水平线。
 */
function MenuSubmenuPopup({
  className,
  children,
  ...props
}: MenuSubmenuPopupProps) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        sideOffset={2}
        alignOffset={-4}
        className="rk-menu__positioner"
      >
        <BaseMenu.Popup
          {...props}
          className={cx('rk-menu', 'rk-menu--submenu', className)}
          data-glass="panel"
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  )
}

export const Menu = {
  Root: BaseMenu.Root,
  Trigger: BaseMenu.Trigger,
  Popup: MenuPopup,
  Item: MenuItem,
  Separator: MenuSeparator,
  Group: MenuGroup,
  GroupLabel: MenuGroupLabel,
  SubmenuRoot: BaseMenu.SubmenuRoot,
  SubmenuTrigger: MenuSubmenuTrigger,
  SubmenuPopup: MenuSubmenuPopup,
}
