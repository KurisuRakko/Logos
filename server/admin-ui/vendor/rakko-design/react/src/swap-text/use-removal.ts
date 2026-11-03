/**
 * 删除项收拢的记账（移植自 RakkoNotes lists/hooks 的 useRemoving / useRemovingCount）：
 * remove(id, commit) 先把 id 标成「正在移除」（交给 SwipeRow 的 removing 收拢行高），收拢结束（finish(id)，接 onRemoved）
 * 或保底超时后再调 commit 真正删掉，只调一次。cancel(id) 放弃挂起的移除（撤销、操作失败）：不再 commit，行恢复原样。
 * 减弱动态效果时立即 commit。
 *
 * 外面有 RemovalCountContext 时把「正在移除」的行数报上去：底栏「N 项」这类计数可以按「不含正在移除的行」算，
 * 与行开始收拢同时变，不等收拢结束后真正删除。
 */
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react'
import { reducedMotionQuery, rootTimeMs } from '../motion-dom'
import { SPRINGS, springEasing } from '../spring'

/**
 * 保底超时的余量（ms，加在 --motion-spring-smooth-duration 上）：正常以行的 transitionend 为准，
 * 过渡没跑起来（不可见、浏览器不支持插值）时靠它收尾。含滑出的前导延迟。
 */
export const REMOVAL_FALLBACK_SLACK_MS = 400

export interface Removal {
  /** 正在收拢的 id。 */
  removing: ReadonlySet<string>
  /** 开始移除：收拢结束或超时后调一次 commit。同一 id 再调会换成新的 commit、重新计时。 */
  remove(id: string, commit: () => void): void
  /** 收拢结束（接 SwipeRow 的 onRemoved）：立即 commit。 */
  finish(id: string): void
  /** 放弃挂起的移除：不 commit，行退出「正在移除」。 */
  cancel(id: string): void
}

/** 列表页提供给其中各 useRemoval 的上报函数：(来源, 正在移除的行数)。 */
export const RemovalCountContext = createContext<((owner: object, count: number) => void) | null>(null)

export function useRemoval(): Removal {
  const [removing, setRemoving] = useState<ReadonlySet<string>>(() => new Set())
  const pending = useRef(new Map<string, { commit: () => void; timer: number }>())

  // 上报正在移除的行数；layout effect：commit 删掉行与这里的数目减一落在同一帧，计数不会闪一下
  const report = useContext(RemovalCountContext)
  const [owner] = useState(() => ({}))
  useLayoutEffect(() => {
    report?.(owner, removing.size)
  }, [report, owner, removing])
  useLayoutEffect(() => () => report?.(owner, 0), [report, owner])

  const drop = useCallback((id: string) => {
    setRemoving((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const finish = useCallback(
    (id: string) => {
      const entry = pending.current.get(id)
      if (!entry) return
      pending.current.delete(id)
      window.clearTimeout(entry.timer)
      entry.commit()
      drop(id)
    },
    [drop],
  )

  const cancel = useCallback(
    (id: string) => {
      const entry = pending.current.get(id)
      if (!entry) return
      pending.current.delete(id)
      window.clearTimeout(entry.timer)
      drop(id)
    },
    [drop],
  )

  const remove = useCallback(
    (id: string, commit: () => void) => {
      if (reducedMotionQuery()?.matches) {
        commit()
        return
      }
      const old = pending.current.get(id)
      if (old) window.clearTimeout(old.timer)
      const settle = rootTimeMs('--motion-spring-smooth-duration', springEasing(SPRINGS.smooth).durationMs)
      const timer = window.setTimeout(() => finish(id), settle + REMOVAL_FALLBACK_SLACK_MS)
      pending.current.set(id, { commit, timer })
      setRemoving((prev) => new Set(prev).add(id))
    },
    [finish],
  )

  return { removing, remove, finish, cancel }
}

/**
 * 子树里各 useRemoval「正在移除」的行数之和，与要放进 RemovalCountContext 的上报函数：
 * `const [removingCount, report] = useRemovalCount()` → `<RemovalCountContext value={report}>…`。
 */
export function useRemovalCount(): [number, (owner: object, count: number) => void] {
  const [counts] = useState(() => new Map<object, number>())
  const [total, setTotal] = useState(0)
  const report = useCallback(
    (owner: object, count: number) => {
      if (count > 0) counts.set(owner, count)
      else counts.delete(owner)
      let sum = 0
      for (const value of counts.values()) sum += value
      setTotal(sum)
    },
    [counts],
  )
  return [total, report]
}
