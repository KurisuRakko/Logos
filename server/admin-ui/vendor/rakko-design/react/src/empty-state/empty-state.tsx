/**
 * 列表的空状态 / 出错提示（移植自 RakkoNotes lists/EmptyState）：挂上时淡入；与列表互换时走 useSwapPresence——
 * 删掉最后一行后，列表剩下的内容淡出、空状态再淡入；有了第一条时空状态先淡出（略收）、列表再淡入。
 * 列表上方的说明文字（「最近删除」的保留期提示这类）也可以用它，出现 / 消失一样不硬切。
 */
import { useRef } from 'react'
import type { ComponentProps } from 'react'
import { cx } from '../cx'
import { useMergedRefs } from '../merge-refs'
import { useSwapPresence } from '../swap-text/swap-text'

export type EmptyStateProps = ComponentProps<'p'>

export function EmptyState({ className, ref, ...rest }: EmptyStateProps) {
  const own = useRef<HTMLParagraphElement>(null)
  useSwapPresence(own)
  return <p ref={useMergedRefs(own, ref)} className={cx('rk-empty-state', className)} {...rest} />
}
