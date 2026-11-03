import { Select as BaseSelect } from '@base-ui/react/select'
import type { ComponentProps } from 'react'
import { cx } from '../cx'

export interface SelectPopupProps
  extends Omit<ComponentProps<typeof BaseSelect.Popup>, 'className'> {
  className?: string
}

/**
 * 组合 Portal > Positioner(sideOffset 6, alignItemWithTrigger=false) > Popup。
 * 不渲染 Select.List 时 Base UI 让 Popup 自身承担 role="listbox"。
 */
function SelectPopup({ className, children, ...props }: SelectPopupProps) {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        sideOffset={6}
        alignItemWithTrigger={false}
        className="rk-select__positioner"
      >
        <BaseSelect.Popup
          {...props}
          className={cx('rk-select__popup', className)}
          data-glass="panel"
        >
          {children}
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  )
}

export interface SelectTriggerProps
  extends Omit<ComponentProps<typeof BaseSelect.Trigger>, 'className'> {
  className?: string
}

function SelectTrigger({ className, ...props }: SelectTriggerProps) {
  return (
    <BaseSelect.Trigger
      {...props}
      data-ripple
      className={cx('rk-select__trigger', className)}
    />
  )
}

export interface SelectItemProps
  extends Omit<ComponentProps<typeof BaseSelect.Item>, 'className'> {
  className?: string
}

function SelectItem({ className, children, ...props }: SelectItemProps) {
  return (
    <BaseSelect.Item
      {...props}
      data-ripple
      className={cx('rk-select__item', className)}
    >
      {children}
    </BaseSelect.Item>
  )
}

export interface SelectItemIndicatorProps
  extends Omit<ComponentProps<typeof BaseSelect.ItemIndicator>, 'className'> {
  className?: string
}

/** 选中指示：默认内联勾 SVG（12px，视口 16），选中项才会渲染。 */
function SelectItemIndicator({
  className,
  children,
  ...props
}: SelectItemIndicatorProps) {
  return (
    <BaseSelect.ItemIndicator
      {...props}
      className={cx('rk-select__item-indicator', className)}
    >
      {children ?? (
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </BaseSelect.ItemIndicator>
  )
}

export interface SelectValueProps
  extends Omit<ComponentProps<typeof BaseSelect.Value>, 'className'> {
  className?: string
}

function SelectValue({ className, ...props }: SelectValueProps) {
  return <BaseSelect.Value {...props} className={className} />
}

export interface SelectIconProps
  extends Omit<ComponentProps<typeof BaseSelect.Icon>, 'className'> {
  className?: string
}

function SelectIcon({ className, ...props }: SelectIconProps) {
  return <BaseSelect.Icon {...props} className={className} />
}

export interface SelectItemTextProps
  extends Omit<ComponentProps<typeof BaseSelect.ItemText>, 'className'> {
  className?: string
}

function SelectItemText({ className, ...props }: SelectItemTextProps) {
  return <BaseSelect.ItemText {...props} className={className} />
}

export interface SelectGroupLabelProps
  extends Omit<ComponentProps<typeof BaseSelect.GroupLabel>, 'className'> {
  className?: string
}

function SelectGroupLabel({ className, ...props }: SelectGroupLabelProps) {
  return (
    <BaseSelect.GroupLabel
      {...props}
      className={cx('rk-select__group-label', className)}
    />
  )
}

export interface SelectSeparatorProps
  extends Omit<ComponentProps<typeof BaseSelect.Separator>, 'className'> {
  className?: string
}

function SelectSeparator({ className, ...props }: SelectSeparatorProps) {
  return (
    <BaseSelect.Separator
      {...props}
      className={cx('rk-select__separator', className)}
    />
  )
}

export const Select = {
  Root: BaseSelect.Root,
  Trigger: SelectTrigger,
  Value: SelectValue,
  Icon: SelectIcon,
  Popup: SelectPopup,
  Item: SelectItem,
  ItemText: SelectItemText,
  ItemIndicator: SelectItemIndicator,
  Group: BaseSelect.Group,
  GroupLabel: SelectGroupLabel,
  Separator: SelectSeparator,
}
