import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

// AppShell 只被图书馆路由消费；这里锁的是顶栏平台感知 padding 的源码约定
// （win32 caption 让位 + 呼吸位 / mac 红绿灯让位），渲染断言在 library.test.tsx。
describe('AppShell titlebar insets', () => {
  test('reserves the Windows caption zone plus breathing room on the right', () => {
    // 只隔让位线时 navEnd 图标与 min/max/close 读成一团（视觉混排），加 0.75rem 呼吸位；
    // mac 不受影响（--titlebar-inset-right 为 0，max 退回 1rem 原值）。
    const source = readFileSync(fileURLToPath(new URL('./AppShell.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('pr-[max(1rem,calc(var(--titlebar-inset-right)+0.75rem))]')
    expect(source).not.toContain('pr-[max(1rem,var(--titlebar-inset-right))]')
  })

  test('preserves the mac 128px left inset (header padding + traffic-light reservation both kept)', () => {
    // 原实现是两层叠加：header px-4（16px）+ 内层 pl-[112px] = 128px。收进变量时必须
    // 保留两层语义：pl = max(1rem, inset + 1rem)——mac 112+16=128 逐像素不变，
    // win32/linux inset=0 时退回 16px（与原 px-4 一致）。漏掉 +1rem 会把 mac 缩到 112px
    // （PR #26 review ① 抓到的回归），且与右侧的 +0.75rem 呼吸位写法不对称。
    const source = readFileSync(fileURLToPath(new URL('./AppShell.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('pl-[max(1rem,calc(var(--titlebar-inset-left)+1rem))]')
    // 漏算形态：只让位不加呼吸位（mac 会缩到 112px）。
    expect(source).not.toContain('pl-[max(1rem,var(--titlebar-inset-left))]')
  })
})
