import { useSyncExternalStore } from 'react'

/**
 * 明暗主题：给 <html> 写 data-theme="light" | "dark"，design-system 的深色覆盖
 * （scaffold 的 [data-theme='dark']、tokens.css 的 dark variant）都挂在这个属性上。
 *
 * 偏好存在 localStorage.rakkoTheme：light / dark 是手动覆盖；没有值（或值无效）就是
 * system，跟随 prefers-color-scheme。首帧由 themeBootScript 在 CSS 之前定好，
 * 之后的系统变化、跨标签页修改由 installTheme 接管；useTheme 读写同一份状态。
 */

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeState {
  /** 用户偏好：system 表示跟随系统。 */
  theme: ThemePreference
  /** 实际生效、写在 <html data-theme> 上的主题。 */
  resolved: ResolvedTheme
}

export interface UseThemeResult extends ThemeState {
  /** 切换偏好：light / dark 写入 localStorage，system 清掉存储值、回到跟随系统。 */
  setTheme: (theme: ThemePreference) => void
}

export const THEME_STORAGE_KEY = 'rakkoTheme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * 首帧脚本：内联进 <head>、放在样式表之前，页面第一次绘制前就定好 data-theme，避免闪白 / 闪黑。
 * 与 installTheme 同一套约定；站点 CSP 不允许内联脚本时，把这段写成同源文件再用 <script src> 引入。
 */
export const themeBootScript = `(function(){var s=null;try{s=localStorage.getItem('${THEME_STORAGE_KEY}')}catch(e){}var d=s==='light'||s==='dark'?s==='dark':!!(window.matchMedia&&window.matchMedia('${DARK_QUERY}').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light')})()`

const SERVER_STATE: ThemeState = { theme: 'system', resolved: 'light' }

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
}

function resolve(theme: ThemePreference): ResolvedTheme {
  if (theme !== 'system') return theme
  return systemPrefersDark() ? 'dark' : 'light'
}

let state: ThemeState | null = null
const listeners = new Set<() => void>()

function currentState(): ThemeState {
  if (state === null) {
    const theme = readPreference()
    state = { theme, resolved: resolve(theme) }
  }
  return state
}

/** 按当前偏好重新求值并写到 <html>；值没变时保留原对象，useSyncExternalStore 不会多渲染。 */
function sync(): void {
  const theme = readPreference()
  const resolved = resolve(theme)
  document.documentElement.setAttribute('data-theme', resolved)
  if (state?.theme === theme && state.resolved === resolved) return
  state = { theme, resolved }
  for (const listener of listeners) listener()
}

/** 切换主题偏好；不依赖 installTheme，组件外也可以直接调。 */
export function setTheme(theme: ThemePreference): void {
  try {
    if (theme === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY)
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // 存储不可用（隐私模式、被禁用）时只在本页生效。
    const resolved = resolve(theme)
    document.documentElement.setAttribute('data-theme', resolved)
    state = { theme, resolved }
    for (const listener of listeners) listener()
    return
  }
  sync()
}

let installCount = 0
let uninstall: (() => void) | null = null

/**
 * 应用启动时调一次：立刻把 data-theme 对齐到当前偏好，并监听系统明暗变化与
 * 其他标签页对 localStorage.rakkoTheme 的修改。返回解除函数；重复安装按引用计数共享一套监听。
 */
export function installTheme(): () => void {
  sync()
  installCount += 1
  if (installCount === 1) {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null
    const onSystemChange = () => sync()
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === THEME_STORAGE_KEY) sync()
    }
    mq?.addEventListener?.('change', onSystemChange)
    window.addEventListener('storage', onStorage)
    uninstall = () => {
      mq?.removeEventListener?.('change', onSystemChange)
      window.removeEventListener('storage', onStorage)
    }
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    installCount -= 1
    if (installCount === 0) {
      uninstall?.()
      uninstall = null
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 读写主题偏好。系统明暗变化要靠 installTheme 的监听才会反映到 resolved，
 * 所以应用根部仍需装一次 installTheme。
 */
export function useTheme(): UseThemeResult {
  const { theme, resolved } = useSyncExternalStore(subscribe, currentState, () => SERVER_STATE)
  return { theme, resolved, setTheme }
}
