// 自动化分档按钮的真实点击测试：证明每一块回传的正是它自己那一档。
//
// 为什么单独一个文件、且不并进 CreateNovelDialog.test.tsx：那份走 renderToStaticMarkup，只能证明
// 选中态挂对了块，证不了 onClick 的实参；而全局挂载必须发生在 @testing-library/react 被 import
// 之前，ES import 又会提升到模块顶部——只能靠「先同步挂全局，再顶层 await 动态 import」，这条纪律
// 会污染同文件里的普通用例。
//
// 手动挂 happy-dom（而非 GlobalRegistrator）、查询一律走 container.querySelector（screen 是进程级
// 单例，会被同进程里先 import 的那个 DOM 测试焊死）的完整理由见 ui/disclosure.interactions.test.tsx
// 与 settings/UpdateRow.test.tsx 顶部注释。
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
const {
  CREATE_NOVEL_AUTOMATION_AUTO_LABEL,
  CREATE_NOVEL_AUTOMATION_COLLABORATIVE_LABEL,
  CreateNovelDialogPanel,
} = await import('./CreateNovelDialog.tsx')

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

describe('新建小说的自动化分档', () => {
  test('点哪一块就回传哪一档（接反了作者会以为选了协作却建出全自动项目）', () => {
    const picked: string[] = []
    const { container } = render(
      <Dialog open>
        <CreateNovelDialogPanel
          automationLevel="auto"
          creating={false}
          formError={null}
          genre="赛博朋克悬疑"
          title="星辰大海"
          onAutomationLevelChange={(value) => picked.push(value)}
          onGenreChange={() => {}}
          onSubmit={() => {}}
          onTitleChange={() => {}}
        />
      </Dialog>,
    )
    const options = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-create-novel-automation="segmented"] button'),
    ]

    // 先锁死「第几块是哪个标签」，下面按同一顺序点击，标签与实参才对得上号。
    expect(options.map((option) => option.querySelector('span')?.textContent)).toEqual([
      CREATE_NOVEL_AUTOMATION_AUTO_LABEL,
      CREATE_NOVEL_AUTOMATION_COLLABORATIVE_LABEL,
    ])

    for (const option of options) fireEvent.click(option)

    expect(picked).toEqual(['auto', 'collaborative'])
  })
})
