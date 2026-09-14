// 「粘贴参考作品」表单的真实提交测试（issue #109）。
//
// 为什么必须单独做成 DOM 测试：#109 的修复点是「按钮 disabled 挡不住回车」——两个输入框在提交中
// 并不 disabled，单行 input 里按回车照样触发 form submit。同名 SSR 文件只能断言按钮的 disabled
// 属性，**挡回车那条路径它一行都覆盖不到**（实测：删掉守卫，那边 13 条全绿）。
//
// 模块加载纪律照 `library/CreateNovelDialog.interactions.test.tsx` 的先例：手动挂 happy-dom
// （不用 GlobalRegistrator，本仓同进程共存上限已用满），查询一律走 `container.querySelector`
// ——`screen` 是进程级单例，会被同进程里先 import 的那个 DOM 测试焊死。全局必须在
// `@testing-library/react` 被 import 之前挂好，而 ES import 会提升，所以先同步挂全局、
// 再顶层 await 动态 import。
import { Window } from 'happy-dom'

const happyWindow = new Window()
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
Object.defineProperty(globalThis, 'window', { configurable: true, value: happyWindow })
Object.defineProperty(globalThis, 'document', { configurable: true, value: happyWindow.document })
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { afterAll, afterEach, describe, expect, test } = await import('bun:test')
const { cleanup, fireEvent, render } = await import('@testing-library/react')
const { Dialog } = await import('@/components/ui/dialog')
const { ReferenceWorksPasteDialogPanel } = await import('./ReferenceWorksView.tsx')

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

/** 挂载表单面板；返回提交次数与 form 元素。提交次数即「请求会不会真的发出去」。 */
function mountPanel(props: { busy: boolean; title: string; content: string }) {
  let submitCount = 0
  const { container } = render(
    <Dialog open>
      <ReferenceWorksPasteDialogPanel
        busy={props.busy}
        content={props.content}
        error={null}
        title={props.title}
        onContentChange={() => {}}
        onSubmit={(event) => {
          event.preventDefault()
          submitCount += 1
        }}
        onTitleChange={() => {}}
      />
    </Dialog>,
  )
  const form = container.querySelector('form[data-reference-works-paste-panel]')
  if (!form) throw new Error('未找到粘贴表单，选择器已失效')
  return { submitCount: () => submitCount, form }
}

describe('粘贴参考作品：回车提交路径（issue #109）', () => {
  test('填齐且不忙时，回车能正常提交', () => {
    const { submitCount, form } = mountPanel({ busy: false, title: '片段', content: '正文' })
    fireEvent.submit(form)
    expect(submitCount()).toBe(1)
  })

  test('标题为空时回车不提交——按钮 disabled 挡不住回车，靠的是表单这道闸', () => {
    const { submitCount, form } = mountPanel({ busy: false, title: '', content: '正文' })
    fireEvent.submit(form)
    expect(submitCount()).toBe(0)
  })

  test('正文为空时回车不提交', () => {
    const { submitCount, form } = mountPanel({ busy: false, title: '片段', content: '' })
    fireEvent.submit(form)
    expect(submitCount()).toBe(0)
  })

  test('纯空格与后端同口径判空，回车不提交', () => {
    const { submitCount, form } = mountPanel({ busy: false, title: '   ', content: '正文' })
    fireEvent.submit(form)
    expect(submitCount()).toBe(0)
  })

  test('提交进行中回车不再提交——否则后端把同标题当新来源追加，凭空多出一份重复参考作品', () => {
    const { submitCount, form } = mountPanel({ busy: true, title: '片段', content: '正文' })
    fireEvent.submit(form)
    expect(submitCount()).toBe(0)
  })
})
