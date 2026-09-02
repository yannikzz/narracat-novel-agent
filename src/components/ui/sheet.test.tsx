import { describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { SheetContent, SheetOverlay } from './sheet'

function sheetContentParts() {
  const portal = SheetContent({ children: <div /> }) as ReactElement<{
    children: ReactElement | ReactElement[]
  }>
  const children = Array.isArray(portal.props.children) ? portal.props.children : [portal.props.children]
  const content = children[1] as ReactElement<{
    className?: string
    children: ReactElement | ReactElement[]
  }>
  const contentChildren = Array.isArray(content.props.children) ? content.props.children : [content.props.children]
  const close = contentChildren[1] as ReactElement<{ className?: string }>

  return { close, content }
}

describe('Sheet', () => {
  /**
   * 真机撞出来的死键：顶栏的 `-webkit-app-region: drag` 由系统在合成层做命中测试、**不看
   * z-index**，抽屉即使盖在顶栏之上，只要自己不声明 no-drag，落在那条带子里的关闭钮就点不动。
   * Dialog 早有同款断言，Sheet 一直漏着——所以这条测试和 dialog.test.tsx 是一对，别只补一边。
   */
  test('keeps drawer surfaces out of the frameless window drag region', () => {
    const overlay = SheetOverlay({}) as ReactElement<{ className?: string }>
    const { close, content } = sheetContentParts()

    expect(overlay.props.className).toContain('[-webkit-app-region:no-drag]')
    expect(content.props.className).toContain('[-webkit-app-region:no-drag]')
    expect(close.props.className).toContain('[-webkit-app-region:no-drag]')
  })

  test('关闭钮有真实命中区，不是一个 16px 的图标', () => {
    const { close } = sheetContentParts()
    expect(close.props.className).toContain('size-7')
  })
})
