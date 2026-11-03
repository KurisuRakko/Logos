/**
 * AnimatedList 的 layoutKey：把「哪些行、什么顺序、在哪个组、哪些在收拢」压成一个签名字符串。
 * 签名没变（只是行内容更新，如打字时标题 / 摘要变了）时 AnimatedList 跳过量位置与 FLIP。
 * 不碰 DOM，便于单测。移植自 RakkoNotes 的 lists/flipLayout.ts。
 *
 * 宁可多变不能少变：任何会让带 data-rk-flip-key 的元素换位、增删、换组的状态都要进签名；
 * 会改行高或组高的开关（多显示一行、折叠、选择模式）走 extra。
 */

export interface FlipLayoutGroup {
  /** 组的 flipKey（没有带 key 的组外壳时随便取个固定名）。 */
  key: string
  /** 组里各行的 flipKey，按显示顺序。 */
  rows: readonly string[]
}

/**
 * groups：按显示顺序的组；removing：正在收拢（SwipeRow removing）的行；extra：其余影响布局的状态。
 * JSON 编码，组名、id 里有什么字符都不会串。
 */
export function flipLayoutKey(
  groups: readonly FlipLayoutGroup[],
  removing: ReadonlySet<string> = new Set(),
  extra: readonly (string | number | boolean | null)[] = [],
): string {
  return JSON.stringify([extra, groups.map((group) => [group.key, group.rows]), [...removing].sort()])
}
