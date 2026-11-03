// Logos 语言 key → 中文语言名（与 src/i18n/locales/zh_CN.json 的 languages 一致）。
export const LANGUAGE_NAMES: Record<string, string> = {
  zh_cn: '简体中文',
  zh_tw: '繁体中文',
  mn_mo: '蒙古语（传统蒙古文）',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  fr: '法语',
  es: '西班牙语',
  ru: '俄语',
  de: '德语',
  it: '意大利语',
  tr: '土耳其语',
  pt_pt: '葡萄牙语',
  pt_br: '葡萄牙语（巴西）',
  vi: '越南语',
  id: '印尼语',
  th: '泰语',
  ms: '马来语',
  ar: '阿拉伯语',
  hi: '印地语',
  km: '高棉语',
  mn_cy: '蒙古语（西里尔字母）',
  nb_no: '书面挪威语',
  nn_no: '新挪威语',
  fa: '波斯语',
  sv: '瑞典语',
  pl: '波兰语',
  nl: '荷兰语',
  uk: '乌克兰语',
  he: '希伯来语'
}

export function isKnownLanguage(key: string): boolean {
  return Object.hasOwn(LANGUAGE_NAMES, key)
}

export function systemPrompt(from: string, to: string): string {
  const target = LANGUAGE_NAMES[to]
  const source = from === 'auto' ? '自动识别的源语言' : LANGUAGE_NAMES[from]
  return `将用户提供的文本从${source}翻译为${target}，只输出译文，不解释、不加引号，保留原有换行与格式。`
}
