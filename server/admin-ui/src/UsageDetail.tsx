import { Skeleton } from '@rakko/react'
import { useEffect, useState } from 'react'

import { ApiError, fetchUsage } from './api'
import type { UsageEntry } from './api'
import { failureReason, formatTime, formatTokens, formatYuan } from './format'

/** 最近明细条数 */
const USAGE_LIMIT = 20

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; items: UsageEntry[] }

interface UsageDetailProps {
  sub: string
  /** 鉴权类错误交给上层（回登录页 / 无权限页）；返回 true 表示已处理 */
  onAuthError: (err: unknown) => boolean
}

/** 展开行：某个用户最近若干次翻译的 token 与费用（GET /admin/api/usage） */
export function UsageDetail({ sub, onAuthError }: UsageDetailProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })

  useEffect(() => {
    let alive = true
    fetchUsage(sub, USAGE_LIMIT).then(
      (items) => {
        if (alive) setLoad({ status: 'ok', items })
      },
      (err: unknown) => {
        if (!alive || onAuthError(err)) return
        setLoad({
          status: 'error',
          message: err instanceof ApiError ? err.message : '明细加载失败，请稍后重试。',
        })
      },
    )
    return () => {
      alive = false
    }
  }, [sub, onAuthError])

  if (load.status === 'loading') {
    return (
      <div className="la-detail" aria-busy="true">
        <Skeleton lines={3} />
      </div>
    )
  }
  if (load.status === 'error') {
    return (
      <p className="la-detail la-gate__error" role="alert">
        {load.message}
      </p>
    )
  }
  if (load.items.length === 0) {
    return <p className="la-detail la-muted">该用户暂无使用记录。</p>
  }

  return (
    <div className="la-detail">
      <table className="la-table la-table--compact">
        <caption className="la-detail__caption">最近 {load.items.length} 条记录</caption>
        <thead>
          <tr>
            <th scope="col">时间</th>
            <th scope="col" className="la-num">
              输入（缓存命中）
            </th>
            <th scope="col" className="la-num">
              输入（未命中）
            </th>
            <th scope="col" className="la-num">
              输出
            </th>
            <th scope="col" className="la-num">
              费用（元）
            </th>
            <th scope="col">结果</th>
          </tr>
        </thead>
        <tbody>
          {load.items.map((item) => {
            const reason = item.ok ? null : failureReason(item.error)
            return (
              <tr key={item.id}>
                <td className="la-nowrap">{formatTime(item.created_at)}</td>
                <td className="la-num">{formatTokens(item.cache_hit_tokens)}</td>
                <td className="la-num">{formatTokens(item.cache_miss_tokens)}</td>
                <td className="la-num">{formatTokens(item.output_tokens)}</td>
                <td className="la-num">{formatYuan(item.cost_micro)}</td>
                <td>
                  <span
                    className="la-tag"
                    data-tone={item.ok ? 'success' : 'error'}
                    title={reason ? `${reason}（${item.error}）` : undefined}
                  >
                    {item.ok ? '成功' : '失败'}
                  </span>
                  {reason ? <span className="la-reason">{reason}</span> : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
