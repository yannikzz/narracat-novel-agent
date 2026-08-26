import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { initTheme } from './lib/theme.ts'
import './styles/globals.css'

initTheme()

// 平台感知布局：把主进程平台写到 <html data-platform>，顶栏据此适配
// mac 红绿灯（左侧预留）/ Windows caption 按钮（右侧预留）。
// window.electron.platform 为准（preload 暴露）；非 Electron 环境只识别 Mac——
// 其余一律回退 'linux'（globals.css 语义：无自绘按钮，让位为 0）。此前回退 'win32'
// 会让浏览器直开 dev server 时凭空多出 150px 右让位与 56px 顶 gutter（PR #26 review ③）。
if (typeof document !== 'undefined') {
  const platform =
    typeof window !== 'undefined' && window.electron?.platform
      ? window.electron.platform
      : typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)
        ? 'darwin'
        : 'linux'
  document.documentElement.dataset.platform = platform
}

// Windows DPI 加固：CSS 里的 --titlebar-inset-right: 150px 是按 100% 缩放目测的，
// 客户机常为 125%/150%，原生 caption 按钮实际宽度（DIP）可能超过 150px——硬编码
// 预留不够时顶栏按钮会被 min/max/close 压住（Windows 适配盲区，2026-08-16）。
// Window Controls Overlay API 给出拖拽区（不含 caption 按钮）的精确几何：
//   caption 宽 = innerWidth - (titlebarArea.x + titlebarArea.width)
// 实测值 + 8px 呼吸位写入内联 CSS 变量（内联优先级高于 globals.css 的 150px 回退）。
// 监听 geometrychange（最大化/还原/DPI 变化）与 resize（innerWidth 变化需重算）持续同步；
// API 不可用 / 返回异常值（挂载初期可能全零）时静默保留 150px 回退，不抛错。
interface WindowControlsOverlayLike extends EventTarget {
  visible: boolean
  getTitlebarAreaRect(): { x: number; width: number }
}

function syncWin32TitlebarInset() {
  if (document.documentElement.dataset.platform !== 'win32') return
  const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay
  if (!overlay?.visible) return
  const rect = overlay.getTitlebarAreaRect()
  const captionWidth = window.innerWidth - rect.x - rect.width
  if (!Number.isFinite(captionWidth) || captionWidth <= 0 || captionWidth >= 400) return
  document.documentElement.style.setProperty('--titlebar-inset-right', `${Math.ceil(captionWidth) + 8}px`)
}

if (typeof window !== 'undefined') {
  syncWin32TitlebarInset()
  window.addEventListener('load', syncWin32TitlebarInset)
  window.addEventListener('resize', syncWin32TitlebarInset)
  const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay
  overlay?.addEventListener?.('geometrychange', syncWin32TitlebarInset)
}

// 非 mac 平台加载渐变 fallback 背景（mac 用 vibrancy 透到桌面）
if (typeof navigator !== 'undefined' && !/Mac/.test(navigator.platform)) {
  await import('./styles/fallback-bg.css')
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
