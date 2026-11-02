import { createContext } from 'react'

/** 处在 List.Group 的卡片里为 true：SwipeRow 据此给根节点 role="listitem"。 */
export const ListGroupContext = createContext(false)

/** 处在 SwipeRow 的内容层里为 true：List.Row 据此不再自带 role="listitem"（由 SwipeRow 根节点承担）。 */
export const SwipeRowContext = createContext(false)
