// ProEditionPanel 真实 DOM 挂载测试。挂载方式照 UpdateRow.test.tsx：手动挂 happy-dom 的
// Window/Document（不经 GlobalRegistrator），查询走 container，不碰 testing-library 的 screen 单例。
import { Window } from 'happy-dom'

const happyWindow = new Window()
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
Object.defineProperty(globalThis, 'window', { configurable: true, value: happyWindow })
Object.defineProperty(globalThis, 'document', { configurable: true, value: happyWindow.document })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { afterAll, afterEach, describe, expect, test } = await import('bun:test')
const { act, cleanup, render } = await import('@testing-library/react')
const { ProEditionPanel } = await import('./ProEdition.tsx')
const { PRO_EDITION_ADVANTAGES, PRO_EDITION_MIGRATION, PRO_EDITION_NOT_CARRIED } = await import(
  '@/lib/pro-edition'
)

afterEach(() => {
  cleanup()
  delete happyWindow.document.documentElement.dataset.platform
})

afterAll(() => {
  if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  else Reflect.deleteProperty(globalThis, 'window')
  if (originalDocumentDescriptor) Object.defineProperty(globalThis, 'document', originalDocumentDescriptor)
  else Reflect.deleteProperty(globalThis, 'document')
})

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === text)
  if (!button) throw new Error(`找不到按钮：${text}`)
  return button
}

describe('ProEditionPanel', () => {
  test('同时讲清好在哪、搬过去会怎样、什么没带过去', () => {
    const { container } = render(<ProEditionPanel source="oss-notice" dismissLabel="暂不" onDismiss={() => {}} />)
    const text = container.textContent ?? ''
    for (const point of [...PRO_EDITION_ADVANTAGES, ...PRO_EDITION_MIGRATION]) expect(text).toContain(point.title)
    expect(text).toContain(PRO_EDITION_NOT_CARRIED)
  })

  test('点下载：按平台打开安装包直链，换成下一步说明，并通知调用方记为看过', () => {
    happyWindow.document.documentElement.dataset.platform = 'win32'
    const opened: string[] = []
    const originalOpen = happyWindow.open
    happyWindow.open = ((url: string) => {
      opened.push(url)
      return null
    }) as typeof happyWindow.open
    let downloads = 0
    try {
      const { container } = render(
        <ProEditionPanel
          source="oss-notice"
          dismissLabel="暂不"
          onDismiss={() => {}}
          onDownload={() => {
            downloads += 1
          }}
        />,
      )
      act(() => buttonByText(container, '下载专业版').click())
      expect(opened).toEqual(['https://pro-update.narracat.com/win-x64/latest.exe?src=oss-notice'])
      expect(downloads).toBe(1)
      expect(container.querySelector('[data-pro-edition-next-steps="true"]')).not.toBeNull()
    } finally {
      happyWindow.open = originalOpen
    }
  })

  test('点「暂不」只关掉，不打开任何链接', () => {
    let dismissed = 0
    const { container } = render(
      <ProEditionPanel source="oss-settings" dismissLabel="暂不" onDismiss={() => (dismissed += 1)} />,
    )
    act(() => buttonByText(container, '暂不').click())
    expect(dismissed).toBe(1)
  })
})
