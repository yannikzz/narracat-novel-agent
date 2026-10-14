// NetworkProxyPanel 真实 DOM 挂载测试。全局挂载方式与查询纪律照 UpdateRow.test.tsx 先例：
// 手动挂 happy-dom（不走 GlobalRegistrator），查询走 container.querySelector，不碰 screen。
import { Window } from 'happy-dom'

const happyWindow = new Window()
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
Object.defineProperty(globalThis, 'window', { configurable: true, value: happyWindow })
Object.defineProperty(globalThis, 'document', { configurable: true, value: happyWindow.document })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { afterAll, afterEach, describe, expect, test } = await import('bun:test')
const { cleanup, fireEvent, render } = await import('@testing-library/react')
const { NetworkProxyPanel } = await import('./NetworkProxyPanel.tsx')

afterEach(() => {
  cleanup()
})

afterAll(async () => {
  if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  else Reflect.deleteProperty(globalThis, 'window')
  if (originalDocumentDescriptor) Object.defineProperty(globalThis, 'document', originalDocumentDescriptor)
  else Reflect.deleteProperty(globalThis, 'document')
  await happyWindow.happyDOM.close()
})

function mount(savedUrl: string, onSave: (url: string) => void = () => {}) {
  const { container } = render(<NetworkProxyPanel savedUrl={savedUrl} busy={false} saving={false} onSave={onSave} />)
  const input = container.querySelector('input[aria-label="代理地址"]') as HTMLInputElement
  const button = container.querySelector('button') as HTMLButtonElement
  const status = () => container.querySelector('[data-network-proxy-status]')
  return { input, button, status }
}

describe('NetworkProxyPanel', () => {
  test('未设置：显示未使用代理，没改动时不能保存', () => {
    const { button, status } = mount('')
    expect(status()?.textContent).toBe('未使用代理')
    expect(button.disabled).toBe(true)
  })

  test('填「主机:端口」：可保存，保存的是补全后的地址', () => {
    const saved: string[] = []
    const { input, button } = mount('', (url) => saved.push(url))
    fireEvent.change(input, { target: { value: '127.0.0.1:7890' } })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(saved).toEqual(['http://127.0.0.1:7890'])
  })

  test('填 SOCKS：就地提示且不能保存', () => {
    const { input, button, status } = mount('')
    fireEvent.change(input, { target: { value: 'socks5://127.0.0.1:7891' } })
    expect(status()?.getAttribute('data-network-proxy-status')).toBe('invalid')
    expect(status()?.textContent).toContain('只支持 HTTP 代理')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(button.disabled).toBe(true)
  })

  test('已设置后清空：可保存为关闭代理', () => {
    const saved: string[] = []
    const { input, button, status } = mount('http://127.0.0.1:7890', (url) => saved.push(url))
    expect(status()?.textContent).toContain('http://127.0.0.1:7890')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(button)
    expect(saved).toEqual([''])
  })
})
