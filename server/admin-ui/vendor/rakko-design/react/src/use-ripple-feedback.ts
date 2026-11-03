import { useEffect } from 'react'
import { installRippleFeedback } from '@rakko/design-system/ripple'

/**
 * 在指定根（默认 document）安装一次 ripple 事件委托。
 * effect 返回安装函数提供的 disposer；调用方无需手动清理。
 * 注：@rakko/design-system/ripple 的入参类型为 Document | HTMLElement，
 * 但实现只依赖 addEventListener/contains，故这里对任意 ParentNode 做窄化转换。
 */
export function useRippleFeedback(root?: ParentNode): void {
  useEffect(() => {
    return installRippleFeedback((root ?? document) as Document | HTMLElement)
  }, [root])
}
