import { Button, IconButton, Progress, Skeleton, Switch, useSnackbar } from '@rakko/react'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

import { ApiError, AuthRequiredError, fetchUsers, patchUser } from './api'
import type { AdminUser, GlobalQuota, UserPatch } from './api'
import { EditUserDialog } from './EditUserDialog'
import { displayName, formatPercent, formatTime, formatYuan, remainingRatio } from './format'
import { ChevronIcon, RefreshIcon } from './icons'
import { UsageDetail } from './UsageDetail'

interface DashboardProps {
  onAuthLost: () => void
  onForbidden: () => void
  onReload: () => void
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; users: AdminUser[]; global: GlobalQuota | null }

/** 用量比例对应的提示档位：≥ 90% 危险、≥ 70% 警示 */
function usageLevel(used: number, limit: number): 'normal' | 'warning' | 'danger' {
  const ratio = limit > 0 ? used / limit : 1
  if (ratio >= 0.9) return 'danger'
  if (ratio >= 0.7) return 'warning'
  return 'normal'
}

/** 本月（北京时间自然月，与计费月份一致）的标题文字 */
function currentMonthLabel(): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
  }).format(new Date())
  return `${parts}（北京时间）`
}

export function Dashboard({ onAuthLost, onForbidden, onReload }: DashboardProps) {
  const { add } = useSnackbar()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())

  /** 统一处理鉴权类错误；返回 true 表示已经交给 App 处理 */
  const handleAuthError = useCallback(
    (err: unknown): boolean => {
      if (err instanceof AuthRequiredError) {
        onAuthLost()
        return true
      }
      if (err instanceof ApiError && err.status === 403) {
        onForbidden()
        return true
      }
      return false
    },
    [onAuthLost, onForbidden],
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const result = await fetchUsers()
      setLoad({ status: 'ok', users: result.users, global: result.global })
    } catch (err) {
      if (handleAuthError(err)) return
      const message = err instanceof ApiError ? err.message : '加载失败，请稍后重试。'
      setLoad((prev) => {
        if (prev.status === 'ok') {
          add({ title: message })
          return prev
        }
        return { status: 'error', message }
      })
    } finally {
      setRefreshing(false)
    }
  }, [add, handleAuthError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const applyPatch = useCallback(
    async (user: AdminUser, patch: UserPatch, success: string): Promise<boolean> => {
      setBusy((prev) => new Set(prev).add(user.sub))
      try {
        await patchUser(user.sub, patch)
        add({ title: success })
        await refresh()
        return true
      } catch (err) {
        if (!handleAuthError(err)) {
          add({ title: err instanceof ApiError ? err.message : '保存失败，请稍后重试。' })
        }
        return false
      } finally {
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(user.sub)
          return next
        })
      }
    },
    [add, handleAuthError, refresh],
  )

  const users = useMemo(
    () =>
      load.status === 'ok'
        ? [...load.users].sort((a, b) => b.used_micro - a.used_micro || a.sub.localeCompare(b.sub))
        : [],
    [load],
  )

  return (
    <div className="la-stack">
      <header className="la-page-head">
        <div>
          <h1 className="la-page-title">本月用量</h1>
          <p className="la-muted">{currentMonthLabel()}</p>
        </div>
        <IconButton aria-label="刷新数据" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshIcon />
        </IconButton>
      </header>

      {load.status === 'loading' ? <LoadingCards /> : null}

      {load.status === 'error' ? (
        <section className="la-card la-gate" role="alert">
          <p className="la-gate__body">{load.message}</p>
          <Button variant="secondary" onClick={onReload}>
            重新加载
          </Button>
        </section>
      ) : null}

      {load.status === 'ok' ? (
        <>
          <GlobalCard global={load.global} userCount={users.length} />
          <section className="la-card la-card--flush" aria-labelledby="users-title">
            <div className="la-card__head">
              <h2 id="users-title" className="la-section-title">
                用户
              </h2>
              <span className="la-muted">共 {users.length} 人</span>
            </div>
            {users.length === 0 ? (
              <p className="la-empty">本月尚无用户记录。</p>
            ) : (
              <div className="la-table-wrap">
                <table className="la-table">
                  <thead>
                    <tr>
                      <th scope="col" className="la-col-toggle">
                        <span className="la-visually-hidden">展开明细</span>
                      </th>
                      <th scope="col">用户</th>
                      <th scope="col" className="la-num">
                        本月已用 / 额度（元）
                      </th>
                      <th scope="col">剩余比例</th>
                      <th scope="col">最后使用</th>
                      <th scope="col">状态</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <UserRow
                        key={user.sub}
                        user={user}
                        expanded={expanded === user.sub}
                        busy={busy.has(user.sub)}
                        onToggle={() => setExpanded((cur) => (cur === user.sub ? null : user.sub))}
                        onEdit={() => setEditing(user)}
                        onSetEnabled={(enabled) =>
                          void applyPatch(
                            user,
                            { disabled: !enabled },
                            enabled ? `已启用 ${displayName(user)}。` : `已停用 ${displayName(user)}。`,
                          )
                        }
                        onAuthError={handleAuthError}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}

      <EditUserDialog
        user={editing}
        onClose={() => setEditing(null)}
        onSubmit={(user, patch, message) => applyPatch(user, patch, message)}
      />
    </div>
  )
}

function GlobalCard({ global, userCount }: { global: GlobalQuota | null; userCount: number }) {
  if (!global) {
    return (
      <section className="la-card" aria-label="全站合计">
        <p className="la-muted">服务器未返回全站合计数据。</p>
      </section>
    )
  }
  const percent = global.limit_micro > 0 ? Math.min(100, (global.used_micro / global.limit_micro) * 100) : 100
  return (
    <section className="la-card la-summary" aria-labelledby="global-title">
      <div className="la-summary__head">
        <h2 id="global-title" className="la-section-title">
          全站本月合计
        </h2>
        <span className="la-muted">涉及 {userCount} 名用户</span>
      </div>
      <p className="la-summary__figure">
        <span className="la-summary__used">{formatYuan(global.used_micro)}</span>
        <span className="la-summary__limit"> / {formatYuan(global.limit_micro)} 元</span>
      </p>
      <Progress.Root
        value={percent}
        aria-label="全站本月用量占保险丝上限的比例"
        className="la-meter"
        data-level={usageLevel(global.used_micro, global.limit_micro)}
      >
        <Progress.Label>保险丝上限占用</Progress.Label>
        <Progress.Value>{() => formatPercent(percent / 100)}</Progress.Value>
        <Progress.Track>
          <Progress.Indicator />
        </Progress.Track>
      </Progress.Root>
      <p className="la-note">全站合计达到上限后，所有用户的翻译请求将被拒绝，直至下月 1 日（北京时间）重置。</p>
    </section>
  )
}

function LoadingCards() {
  return (
    <div className="la-stack" aria-busy="true" aria-label="正在加载">
      <section className="la-card">
        <Skeleton lines={3} />
      </section>
      <section className="la-card">
        <Skeleton lines={6} />
      </section>
    </div>
  )
}

interface UserRowProps {
  user: AdminUser
  expanded: boolean
  busy: boolean
  onToggle: () => void
  onEdit: () => void
  onSetEnabled: (enabled: boolean) => void
  onAuthError: (err: unknown) => boolean
}

function UserRow({ user, expanded, busy, onToggle, onEdit, onSetEnabled, onAuthError }: UserRowProps) {
  const name = displayName(user)
  const ratio = remainingRatio(user.used_micro, user.limit_micro)
  const exhausted = !user.disabled && ratio <= 0
  const detailId = `usage-${user.sub}`
  const level = usageLevel(user.used_micro, user.limit_micro)

  return (
    <Fragment>
      <tr className="la-row" data-expanded={expanded || undefined} data-disabled={user.disabled || undefined}>
        <td className="la-col-toggle">
          <IconButton
            aria-label={expanded ? `收起 ${name} 的最近明细` : `展开 ${name} 的最近明细`}
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            onClick={onToggle}
            className="la-chevron"
          >
            <ChevronIcon />
          </IconButton>
        </td>
        <td>
          <div className="la-user">
            <span className="la-user__name">{name}</span>
            {user.display_name?.trim() ? <span className="la-user__sub">{user.sub}</span> : null}
          </div>
        </td>
        <td className="la-num">
          <span className="la-strong">{formatYuan(user.used_micro)}</span>
          <span className="la-muted"> / {formatYuan(user.limit_micro)}</span>
        </td>
        <td>
          <div className="la-ratio" data-level={level}>
            <span className="la-ratio__bar" aria-hidden="true">
              <span className="la-ratio__fill" style={{ width: `${ratio * 100}%` }} />
            </span>
            <span className="la-ratio__text">{formatPercent(ratio)}</span>
          </div>
        </td>
        <td className="la-nowrap">{formatTime(user.last_used_at)}</td>
        <td>
          <span
            className="la-tag"
            data-tone={user.disabled ? 'muted' : exhausted ? 'error' : 'success'}
          >
            {user.disabled ? '已停用' : exhausted ? '额度已用尽' : '正常'}
          </span>
        </td>
        <td>
          <div className="la-actions">
            <label className="la-switch-label">
              <Switch.Root
                checked={!user.disabled}
                disabled={busy}
                onCheckedChange={(checked) => onSetEnabled(checked)}
              >
                <Switch.Thumb />
              </Switch.Root>
              <span>启用</span>
            </label>
            <Button variant="ghost" onClick={onEdit} disabled={busy}>
              编辑
            </Button>
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr className="la-detail-row">
          <td colSpan={7} id={detailId}>
            <UsageDetail sub={user.sub} onAuthError={onAuthError} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  )
}
