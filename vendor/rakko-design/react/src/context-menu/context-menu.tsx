import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import type { ComponentProps } from 'react'
import { cx } from '../cx.js'
import { Menu } from '../menu/menu.js'

export interface ContextMenuPopupProps
  extends Omit<ComponentProps<typeof BaseContextMenu.Popup>, 'className'> {
  className?: string
}

/**
 * 右键 / 长按菜单的面板：组合 Portal > Positioner > Popup，视觉与 Menu 完全一致
 * （rk-menu + data-glass="panel"，层级写在 rk-menu__positioner 上）。
 * Positioner 由 Base UI ContextMenu 锚定在指针位置，不设 sideOffset。
 */
function ContextMenuPopup({ className, children, ...props }: ContextMenuPopupProps) {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner className="rk-menu__positioner">
        <BaseContextMenu.Popup
          {...props}
          className={cx('rk-menu', className)}
          data-glass="panel"
        >
          {children}
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  )
}

/**
 * 右键菜单：Root / Trigger 来自 Base UI ContextMenu（右键与触屏长按打开，键盘导航、
 * Escape 关闭、焦点归还都由它负责）；Item / Separator / Group / GroupLabel 直接复用
 * Menu 的同名部件（Base UI 的 ContextMenu 本来就重导出 Menu 的这些部件），
 * 因此 Item 同样支持 variant="danger" 与 disabled；子菜单（SubmenuRoot / SubmenuTrigger /
 * SubmenuPopup）同理复用 Menu 的部件。
 */
export const ContextMenu = {
  Root: BaseContextMenu.Root,
  Trigger: BaseContextMenu.Trigger,
  Popup: ContextMenuPopup,
  Item: Menu.Item,
  Separator: Menu.Separator,
  Group: Menu.Group,
  GroupLabel: Menu.GroupLabel,
  SubmenuRoot: Menu.SubmenuRoot,
  SubmenuTrigger: Menu.SubmenuTrigger,
  SubmenuPopup: Menu.SubmenuPopup,
}
