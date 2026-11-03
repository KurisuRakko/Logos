import { useEffect } from 'react'
import { installPressFeedback } from './press'

/** 在指定根（默认 document）安装一次按压反馈委托；与 useRippleFeedback 同一用法。 */
export function usePressFeedback(root?: Document | HTMLElement): void {
  useEffect(() => installPressFeedback(root ?? document), [root])
}
