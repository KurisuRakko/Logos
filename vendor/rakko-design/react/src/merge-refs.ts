import { useCallback } from 'react'
import type { Ref, RefCallback } from 'react'

/**
 * 把组件自己要的 ref 与调用方传进来的 ref（React 19 里是普通 prop）合成一个回调 ref。
 * 依赖不变时返回同一个函数：每次渲染换新函数会让 React 先传 null 再传元素，
 * 回调里 setState 的组件会因此多渲染一轮。
 */
export function useMergedRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return useCallback(
    (value: T | null) => {
      for (const ref of refs) {
        if (typeof ref === 'function') ref(value)
        else if (ref) ref.current = value
      }
    },
    // 依赖就是 refs 本身
    refs,
  )
}
