import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./BackToTopButton.tsx', import.meta.url)), 'utf-8')

/**
 * 负向断言必须扫「代码」而不是「文件」：注释里正当地写着「不能用 window.scrollTo」，
 * 直接扫全文会被自己的注释判红（同 `.not.toContain` 扫到注释里类名的老坑）。
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('BackToTopButton', () => {
  /**
   * 这三条都是真机才会暴露的定位陷阱，本地看 DOM 看不出来，所以钉在源码层：
   * 工作台内容区自己滚，window 根本不滚。
   */
  test('滚动容器是工作台内容区，不是 window', () => {
    expect(source).toContain('[data-workbench-object-scroll-frame]')
    expect(code).not.toContain('window.scrollTo')
    expect(code).not.toContain("window.addEventListener('scroll'")
  })

  test('用 sticky 而不是 fixed——滚动容器没有定位上下文，fixed 会贴到整个窗口', () => {
    expect(source).toContain('sticky bottom-6')
    expect(code).not.toContain('fixed bottom-')
  })

  test('锚点不吃点击：容器 pointer-events-none，只有按钮本身可点', () => {
    expect(source).toContain('pointer-events-none sticky')
    expect(source).toContain('pointer-events-auto')
  })

  test('滚过一段距离才出现——短章节里它只是噪声', () => {
    expect(source).toContain('threshold = 400')
    expect(source).toContain('frame.scrollTop > threshold')
  })

  test('有可访问名称（纯 icon 按钮的硬要求）', () => {
    expect(source).toContain('aria-label="回到顶部"')
  })
})
