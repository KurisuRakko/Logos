// 拼接 className：过滤掉 false/null/undefined，类顺序 = 内置类在前、调用方追加。
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
