import { useSyncExternalStore } from 'react'

export type Theme = 'system' | 'light' | 'dark'
export type EffectiveTheme = 'light' | 'dark'

const STORAGE_KEY = 'narracat-theme'

/**
 * 深色模式门控：深色 UI 尚未走查适配，暂时强制全员浅色。
 *
 * 门控关闭（false）时：
 * - 无视已存的 theme 值（dark / system）一律渲染浅色，但**不覆写** localStorage，
 *   保留用户原选择——将来翻回 true 时旧偏好自动恢复；
 * - 设置页据此隐藏「跟随系统」、锁定「深色」、强制选中「浅色」。
 *
 * 重新放开深色：把它改成 true 即可，无需改其它代码。
 */
export const DARK_MODE_ENABLED = false

function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system'
  const v = window.localStorage.getItem(STORAGE_KEY)
  if (v === 'light' || v === 'dark' || v === 'system') return v
  return 'system'
}

function getSystemTheme(): EffectiveTheme {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(effective: EffectiveTheme): void {
  document.documentElement.dataset.theme = effective
  // Windows 标题栏 overlay 符号颜色跟主题（浅色 UI 深符号 / 深色 UI 白符号）。
  // 非 Electron 环境（单测/纯 web）无 window.electron，可选链静默跳过；主进程侧仅 win32 生效。
  // catch：invoke 返回 Promise，handler 缺失/窗口竞态时避免 unhandled rejection（PR #26 review ⑤）。
  window.electron?.setTitleBarOverlaySymbolColor?.(effective === 'dark' ? '#ffffff' : '#3f3f46').catch(() => {})
}

/**
 * 把存储的 Theme 解析成实际生效的明/暗。
 * 门控关闭时无条件返回 light（无视 dark / system），是「强制浅色」的唯一收口点。
 */
export function resolveEffectiveTheme(stored: Theme): EffectiveTheme {
  if (!DARK_MODE_ENABLED) return 'light'
  return stored === 'system' ? getSystemTheme() : stored
}

// ---- 模块级单一数据源 ----
// 所有 useTheme() 实例订阅同一份主题状态，setTheme 广播到全部订阅者（含常驻
// Toaster），避免多个 hook 实例各持本地 state、setTheme 后彼此不同步。
type ThemeSnapshot = { theme: Theme; effectiveTheme: EffectiveTheme }

let currentTheme: Theme = getStoredTheme()
let snapshot: ThemeSnapshot = { theme: currentTheme, effectiveTheme: resolveEffectiveTheme(currentTheme) }
const listeners = new Set<() => void>()
let mediaQuery: MediaQueryList | null = null

// 仅当 theme 或 effectiveTheme 真变化时才换引用，让 useSyncExternalStore 的浅比较稳定。
function rebuildSnapshot(): void {
  const effectiveTheme = resolveEffectiveTheme(currentTheme)
  if (snapshot.theme !== currentTheme || snapshot.effectiveTheme !== effectiveTheme) {
    snapshot = { theme: currentTheme, effectiveTheme }
  }
}

function emit(): void {
  rebuildSnapshot()
  applyTheme(snapshot.effectiveTheme)
  listeners.forEach((listener) => listener())
}

function handleSystemChange(): void {
  emit()
}

function subscribe(listener: () => void): () => void {
  // 门控开 + system 模式才需要跟随 OS；首个订阅者挂监听、末个退订时移除。
  if (listeners.size === 0 && DARK_MODE_ENABLED && typeof window !== 'undefined') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    mediaQuery.addEventListener('change', handleSystemChange)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && mediaQuery) {
      mediaQuery.removeEventListener('change', handleSystemChange)
      mediaQuery = null
    }
  }
}

function getSnapshot(): ThemeSnapshot {
  return snapshot
}

/** 读取当前主题快照（供非组件代码使用，与 setTheme 对称）。 */
export function getThemeSnapshot(): ThemeSnapshot {
  return snapshot
}

/** 切换主题：持久化用户选择，并广播到所有 useTheme() 订阅者。 */
export function setTheme(theme: Theme): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, theme)
  currentTheme = theme
  emit()
}

/**
 * 在 React 挂载之前同步 data-theme，避免 FOUC。main.tsx 启动时调用一次。
 */
export function initTheme(): void {
  currentTheme = getStoredTheme()
  rebuildSnapshot()
  applyTheme(snapshot.effectiveTheme)
}

export function useTheme(): {
  theme: Theme
  effectiveTheme: EffectiveTheme
  setTheme: (t: Theme) => void
} {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return { theme: snap.theme, effectiveTheme: snap.effectiveTheme, setTheme }
}
