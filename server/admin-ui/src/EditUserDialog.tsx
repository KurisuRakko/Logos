import { Button, Dialog, Field } from '@rakko/react'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import type { AdminUser, UserPatch } from './api'
import { displayName, formatYuan, parseYuan, yuanInputValue } from './format'

interface EditUserDialogProps {
  /** 正在编辑的用户；null 时对话框关闭 */
  user: AdminUser | null
  onClose: () => void
  /** 提交 PATCH，成功返回 true（对话框随之关闭） */
  onSubmit: (user: AdminUser, patch: UserPatch, success: string) => Promise<boolean>
}

/** 修改显示名与月度额度（以元输入，提交时换算为微元；可恢复默认额度） */
export function EditUserDialog({ user, onClose, onSubmit }: EditUserDialogProps) {
  // 关闭动画期间仍要渲染上一位用户的内容，单独留一份
  const [shown, setShown] = useState<AdminUser | null>(user)
  const [name, setName] = useState('')
  const [limit, setLimit] = useState('')
  const [limitError, setLimitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!user) return
    setShown(user)
    setName(user.display_name ?? '')
    setLimit(yuanInputValue(user.limit_micro))
    setLimitError(null)
    setSaving(false)
  }, [user])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!user) return
    const micro = parseYuan(limit)
    if (micro === null) {
      setLimitError('请输入不小于 0 的金额，最多保留两位小数。')
      return
    }
    const patch: UserPatch = {}
    const trimmed = name.trim()
    if (trimmed !== (user.display_name ?? '').trim()) patch.display_name = trimmed
    if (micro !== user.limit_micro) patch.limit_micro = micro
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    setSaving(true)
    const ok = await onSubmit(user, patch, `已更新 ${trimmed || user.sub} 的设置。`)
    setSaving(false)
    if (ok) onClose()
  }

  const restoreDefault = async () => {
    if (!user) return
    setSaving(true)
    const ok = await onSubmit(user, { limit_micro: null }, `已将 ${displayName(user)} 的额度恢复为默认值。`)
    setSaving(false)
    if (ok) onClose()
  }

  return (
    <Dialog.Root
      open={user !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <Dialog.Popup className="la-dialog">
        <Dialog.Title>编辑用户</Dialog.Title>
        <Dialog.Description>
          {shown ? (
            <>
              账号标识 <code className="la-code">{shown.sub}</code>
              ，本月已用 {formatYuan(shown.used_micro)} 元。
            </>
          ) : null}
        </Dialog.Description>
        <form className="la-form" onSubmit={(e) => void submit(e)} noValidate>
          <Field.Root>
            <Field.Label>显示名</Field.Label>
            <Field.Control
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="留空则显示账号标识"
              maxLength={64}
              autoComplete="off"
            />
          </Field.Root>
          <Field.Root invalid={limitError !== null}>
            <Field.Label>本月额度（元）</Field.Label>
            <Field.Control
              value={limit}
              onChange={(e) => {
                setLimit(e.currentTarget.value)
                setLimitError(null)
              }}
              inputMode="decimal"
              autoComplete="off"
            />
            {limitError ? (
              <Field.Error match>{limitError}</Field.Error>
            ) : (
              <Field.Description>修改后立即生效，按北京时间自然月计算。</Field.Description>
            )}
          </Field.Root>
          <div className="la-dialog__actions">
            <Button variant="ghost" type="button" onClick={() => void restoreDefault()} disabled={saving}>
              恢复默认额度
            </Button>
            <span className="la-spacer" />
            <Button variant="secondary" type="button" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={saving}>
              {saving ? '正在保存…' : '保存'}
            </Button>
          </div>
        </form>
      </Dialog.Popup>
    </Dialog.Root>
  )
}
