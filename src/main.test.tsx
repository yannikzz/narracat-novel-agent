import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

describe('main entry titlebar inset hardening', () => {
  test('measures the Windows caption width at runtime instead of trusting the 150px fallback', () => {
    // 125%/150% 缩放下原生 caption 按钮比 150px 宽，硬编码预留会让顶栏按钮被压住
    // （Windows 适配盲区，2026-08-16）。入口必须用 Window Controls Overlay 实测
    // caption 宽度写入内联 CSS 变量覆盖回退值，并跟随 geometrychange/resize 同步。
    const source = readFileSync(fileURLToPath(new URL('./main.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('function syncWin32TitlebarInset')
    expect(source).toContain('getTitlebarAreaRect()')
    expect(source).toContain("setProperty('--titlebar-inset-right'")
    expect(source).toContain("'geometrychange', syncWin32TitlebarInset")
    expect(source).toContain("'resize', syncWin32TitlebarInset")
  })

  test('non-Electron fallback treats non-Mac as linux (no phantom caption insets)', () => {
    // globals.css 语义：非 mac/win32 平台让位为 0。浏览器直开 dev server 时回退 'win32'
    // 会凭空多出 150px 右让位与 56px 顶 gutter（PR #26 review ③）。Electron 下 preload
    // 恒给出真实 platform，此回退只在纯浏览器场景生效。
    const source = readFileSync(fileURLToPath(new URL('./main.tsx', import.meta.url)), 'utf-8')
    // 剥掉块注释与行注释后断言：回退链只有 darwin/linux 两种赋值；'win32' 仅允许
    // 出现在 WCO 探针守卫的 !== 比较里（比较不产生让位），禁止作为回退值。
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(codeOnly).toMatch(/\?\s*'darwin'/)
    expect(codeOnly).toMatch(/:\s*'linux'/)
    // 禁止 win32 作为回退/赋值值（?= 回退、: 三元分支、= 赋值；lookbehind 排除 !== / !=
    // 比较形态——!== 的第二个 = 前面是第一个 = 而非 !，故须同时排除 = 与 !）。
    // WCO 探针守卫的 !== 'win32' 是比较、不产生让位，合法保留。
    expect(codeOnly).not.toMatch(/\?\s*'win32'/)
    expect(codeOnly).not.toMatch(/(?<![!=]):\s*'win32'/)
    expect(codeOnly).not.toMatch(/(?<![!=])=\s*'win32'/)
  })
})
