import { Field as BaseField } from '@base-ui/react/field'
import type { ComponentProps } from 'react'
import { cx } from '../cx'

export interface FieldRootProps
  extends Omit<ComponentProps<typeof BaseField.Root>, 'className'> {
  className?: string
}

/** rk-field：纵向布局（grid gap 8），Label 与 Control 由 Base UI 自动关联。 */
function FieldRoot({ className, ...props }: FieldRootProps) {
  return <BaseField.Root {...props} className={cx('rk-field', className)} />
}

export interface FieldLabelProps
  extends Omit<ComponentProps<typeof BaseField.Label>, 'className'> {
  className?: string
}

function FieldLabel({ className, ...props }: FieldLabelProps) {
  return (
    <BaseField.Label {...props} className={cx('rk-field__label', className)} />
  )
}

export interface FieldControlProps
  extends Omit<ComponentProps<typeof BaseField.Control>, 'className'> {
  className?: string
  /** 额外类名落在包装盒 .rk-field__box 上（例如宽度/栅格布局）。 */
  boxClassName?: string
}

/**
 * 输入控件：视觉盒子 + Base UI Control。
 * textarea 用 Base UI 的 render prop：<Field.Control render={<textarea rows={4} />} />。
 */
function FieldControl({ className, boxClassName, ...props }: FieldControlProps) {
  return (
    <span className={cx('rk-field__box', boxClassName)}>
      <BaseField.Control
        {...props}
        className={cx('rk-field__input', className)}
      />
    </span>
  )
}

export interface FieldDescriptionProps
  extends Omit<ComponentProps<typeof BaseField.Description>, 'className'> {
  className?: string
}

function FieldDescription({ className, ...props }: FieldDescriptionProps) {
  return (
    <BaseField.Description
      {...props}
      className={cx('rk-field__description', className)}
    />
  )
}

export interface FieldErrorProps
  extends Omit<ComponentProps<typeof BaseField.Error>, 'className'> {
  className?: string
}

function FieldError({ className, ...props }: FieldErrorProps) {
  return (
    <BaseField.Error {...props} className={cx('rk-field__error', className)} />
  )
}

export const Field = {
  Root: FieldRoot,
  Label: FieldLabel,
  Control: FieldControl,
  Description: FieldDescription,
  Error: FieldError,
}
