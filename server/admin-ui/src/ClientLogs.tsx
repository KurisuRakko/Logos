import { IconButton, SegmentedChoice, Select, Skeleton } from '@rakko/react'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

import { ApiError, fetchLogs } from './api'
import type { AdminUser, ClientLog, LogLevel } from './api'
import { displayName, formatTime } from './format'
import { ChevronIcon, RefreshIcon } from './icons'

/** 每次加载的条数（服务端默认 100、上限 500） */
const LOGS_LIMIT = 100
const ALL = 'all'

const LEVEL_LABEL: Record<LogLevel, string> = { error: '错误', warn: '警告', info: '信息' }
const LEVEL_TONE: Record<LogLevel, string> = { error: 'error', warn: 'warning', info: 'muted' }

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; items: ClientLog[] }

interface ClientLogsProps {
  /** 用户筛选的候选项，取自用户列表 */
  users: AdminUser[]
  /** 鉴权类错误交给上层（回登录页 / 无权限页）；返回 true 表示已处理 */
  onAuthError: (err: unknown) => boolean
}

/** 客户端上传的运行日志（GET /admin/api/logs），可按用户与级别筛选，展开查看 context */
export function ClientLogs({ users, onAuthError }: ClientLogsProps) {
  const [sub, setSub] = useState<string>(ALL)
  const [level, setLevel] = useState<string>(ALL)
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)

  const userItems = useMemo(
    () => [
      { value: ALL, label: '全部用户' },
      ...users.map((u) => ({ value: u.sub, label: displayName(u) })),
    ],
    [users],
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const items = await fetchLogs({
        sub: sub === ALL ? undefined : sub,
        level: level === ALL ? undefined : (level as LogLevel),
        limit: LOGS_LIMIT,
      })
      setLoad({ status: 'ok', items })
    } catch (err) {
      if (onAuthError(err)) return
      setLoad({
        status: 'error',
        message: err instanceof ApiError ? err.message : '日志加载失败，请稍后重试。',
      })
    } finally {
      setRefreshing(false)
    }
  }, [sub, level, onAuthError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <section className="la-card la-card--flush" aria-labelledby="logs-title">
      <div className="la-card__head">
        <h2 id="logs-title" className="la-section-title">
          客户端日志
        </h2>
        <IconButton aria-label="刷新客户端日志" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshIcon />
        </IconButton>
      </div>

      <div className="la-filters">
        <Select.Root items={userItems} value={sub} onValueChange={(value) => setSub(value ?? ALL)}>
          <Select.Trigger aria-label="按用户筛选">
            <Select.Value />
            <Select.Icon className="la-select-icon">
              <ChevronIcon />
            </Select.Icon>
          </Select.Trigger>
          <Select.Popup>
            {userItems.map((item) => (
              <Select.Item key={item.value} value={item.value}>
                <Select.ItemText>{item.label}</Select.ItemText>
                <Select.ItemIndicator />
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
        <SegmentedChoice.Root aria-label="按级别筛选" value={level} onValueChange={(value) => setLevel(value)}>
          <SegmentedChoice.Item value={ALL}>全部级别</SegmentedChoice.Item>
          <SegmentedChoice.Item value="error">错误</SegmentedChoice.Item>
          <SegmentedChoice.Item value="warn">警告</SegmentedChoice.Item>
          <SegmentedChoice.Item value="info">信息</SegmentedChoice.Item>
        </SegmentedChoice.Root>
      </div>

      {load.status === 'loading' ? (
        <div className="la-logs-pad" aria-busy="true">
          <Skeleton lines={4} />
        </div>
      ) : null}
      {load.status === 'error' ? (
        <p className="la-empty la-gate__error" role="alert">
          {load.message}
        </p>
      ) : null}
      {load.status === 'ok' && load.items.length === 0 ? (
        <p className="la-empty">没有符合条件的日志。</p>
      ) : null}
      {load.status === 'ok' && load.items.length > 0 ? (
        <div className="la-table-wrap">
          <table className="la-table">
            <caption className="la-visually-hidden">最近 {load.items.length} 条客户端日志</caption>
            <thead>
              <tr>
                <th scope="col" className="la-col-toggle">
                  <span className="la-visually-hidden">展开详情</span>
                </th>
                <th scope="col">时间</th>
                <th scope="col">用户</th>
                <th scope="col">级别</th>
                <th scope="col">事件</th>
                <th scope="col">消息</th>
                <th scope="col">版本</th>
              </tr>
            </thead>
            <tbody>
              {load.items.map((log) => (
                <LogRow
                  key={log.id}
                  log={log}
                  expanded={expanded === log.id}
                  onToggle={() => setExpanded((cur) => (cur === log.id ? null : log.id))}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}

function LogRow({ log, expanded, onToggle }: { log: ClientLog; expanded: boolean; onToggle: () => void }) {
  const detailId = `log-${log.id}`
  const name = log.display_name?.trim() || log.sub
  return (
    <Fragment>
      <tr className="la-row" data-expanded={expanded || undefined}>
        <td className="la-col-toggle">
          <IconButton
            aria-label={expanded ? '收起日志详情' : '展开日志详情'}
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            onClick={onToggle}
            className="la-chevron"
          >
            <ChevronIcon />
          </IconButton>
        </td>
        <td className="la-nowrap">{formatTime(log.created_at)}</td>
        <td>
          <div className="la-user">
            <span className="la-user__name">{name}</span>
            {log.display_name?.trim() ? <span className="la-user__sub">{log.sub}</span> : null}
          </div>
        </td>
        <td>
          <span className="la-tag" data-tone={LEVEL_TONE[log.level]}>
            {LEVEL_LABEL[log.level] ?? log.level}
          </span>
        </td>
        <td className="la-code">{log.event}</td>
        <td className="la-log-message" title={log.message}>
          {log.message}
        </td>
        <td className="la-nowrap">{log.app_version ?? '—'}</td>
      </tr>
      {expanded ? (
        <tr className="la-detail-row">
          <td colSpan={7} id={detailId}>
            <dl className="la-log-meta">
              <dt>客户端时间</dt>
              <dd>{log.client_time ?? '—'}</dd>
              <dt>操作系统</dt>
              <dd>{log.os ?? '—'}</dd>
              <dt>完整消息</dt>
              <dd className="la-log-full">{log.message || '—'}</dd>
              <dt>上下文</dt>
              <dd>
                {log.context === null || log.context === undefined ? (
                  '—'
                ) : (
                  <pre className="la-context">{JSON.stringify(log.context, null, 2)}</pre>
                )}
              </dd>
            </dl>
          </td>
        </tr>
      ) : null}
    </Fragment>
  )
}
