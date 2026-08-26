import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

// 「一个值散落两个文件」的耦合守卫（PR #26 review ②）：globals.css 的
// --titlebar-gutter-top 取自 window.ts 的 TITLE_BAR_HEIGHT（titleBarOverlay.height）。
// 注释拦不住人——将来调 TITLE_BAR_HEIGHT 而 CSS 没跟，Windows 上卡片与 caption 带
// 错位且无任何测试会红。这条断言把两值锁在一起：读不出任一侧或不相等都视为失败
// （守卫必须「响」，不做静默通过）。
describe('titlebar gutter 跨文件一致性守卫', () => {
  test('globals.css 的 --titlebar-gutter-top 与 window.ts 的 TITLE_BAR_HEIGHT 相等', () => {
    const css = readFileSync(fileURLToPath(new URL('../styles/globals.css', import.meta.url)), 'utf-8')
    const ts = readFileSync(
      fileURLToPath(new URL('../../electron/main/window.ts', import.meta.url)),
      'utf-8',
    )

    // CSS 里同名变量有两处声明：:root 默认 0px + [data-platform="win32"] 覆盖 56px。
    // 守卫目标是后者（win32 生效值）；取全部匹配中的最大值即平台覆盖值。
    const cssValues = [...css.matchAll(/--titlebar-gutter-top:\s*(\d+)px/g)].map((m) => Number(m[1]))
    const tsMatch = ts.match(/const TITLE_BAR_HEIGHT = (\d+)/)

    expect(cssValues.length).toBeGreaterThan(0)
    expect(tsMatch).not.toBeNull()

    expect(Math.max(...cssValues)).toBe(Number(tsMatch?.[1]))
  })
})
