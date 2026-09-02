// 正文编辑态分支交互测试（ADR-0031，A2-3）。
//
// ChapterManuscriptView.test.tsx 已注明：zustand v5 的 useSyncExternalStore 服务端快照固定读
// getInitialState()，renderToStaticMarkup 无法反映渲染前的 store mutation，因此 editing=true 整体
// 替换、save() 各分支、cancelEdit() 的 confirm 分支这类"非默认 store 态"行为在那份静态渲染测试里
// 只能整体跳过、留给真机走查（见 titlebar-rework-report.md concerns 段）。这份文件补上这个缺口：
// 用真实 DOM（happy-dom，经 @happy-dom/global-registrator 注册）+ @testing-library/react 驱动。
//
// 本仓库此前没有任何 @testing-library/react + 真实 DOM 的测试先例（PremiseCardsView.test.tsx /
// AgentPanel.test.tsx 等都只用 renderToStaticMarkup 断言 HTML 字符串，测不了状态转换），也没有
// happy-dom / @testing-library/react 依赖 —— 本文件新增时一并把这两个 devDependencies 装了上去
// （package.json / bun.lock），这是把 brief 骨架里明确指定的 @testing-library/react 用法落地的
// 必要前提，不是范围蔓延。
//
// happy-dom 的全局注册必须发生在 @testing-library/react（以及它间接依赖的 @testing-library/dom
// 的 `screen`）被 import 之前 —— 但 ES import 语句本身会被提升到模块顶部，写在 register() 调用
// 之后也没用。为了不引入项目级 bunfig.toml preload（会污染 electron/scripts/agent-core 等其余
// 目录的测试运行环境），这里改用「先同步 register()，再用顶层 await import() 动态加载」的写法，
// 把 happy-dom 的全局注册收敛在本文件内部，不影响同进程里其它测试文件。文件末尾 afterAll 里
// unregister()，尽量把全局状态在本文件测试跑完后清干净。
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const { afterAll, afterEach, beforeEach, describe, expect, mock, test } = await import('bun:test')
const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { useState } = await import('react')
const { cancelPendingManuscriptLeave, useManuscriptEditorGuard } = await import('@/lib/manuscript-editor-guard')
const { ChapterManuscriptView } = await import('./ChapterManuscriptView')
const { ManuscriptEditorView } = await import('./ManuscriptEditorView')
const { ManuscriptRevisionSheet } = await import('./ManuscriptRevisionSheet')
const { toast } = await import('sonner')

type ElectronApi = typeof window.electron

const artifact = {
  kind: 'manuscript' as const,
  title: '第 003 章',
  path: '/p/manuscript/vol-01/ch-003.md',
  exists: true,
  content: '林昭推开门。\n\n<!-- chapter_metadata: {"chapter_num":3} -->',
}

const saveChapterManuscriptMock = mock(async () => ({ ok: true, triage: { tier: 'silent', reasons: [] } }))
const getManuscriptDraftMock = mock(async () => ({ status: 'none' as const }))
const saveManuscriptDraftMock = mock(async () => ({ ok: true as const }))
const discardManuscriptDraftMock = mock(async () => ({ ok: true as const }))
const getPendingMemorySyncMock = mock(async () => ({}) as Record<string, { savedAt: string; reasons: string[] }>)
const listManuscriptRevisionsMock = mock(async () => ({
  revisions: [
    {
      id: 'rev-00000000-0000-4000-8000-000000000001',
      chapter: 3,
      source: 'author-save' as const,
      createdAt: '2026-07-26T00:00:00.000Z',
      summary: { addedChars: 4, removedChars: 2 },
    },
  ],
  storageBytes: 2048,
}))
const readManuscriptRevisionMock = mock(async () => ({
  revision: {
    id: 'rev-00000000-0000-4000-8000-000000000001',
    chapter: 3,
    source: 'author-save' as const,
    createdAt: '2026-07-26T00:00:00.000Z',
    summary: { addedChars: 4, removedChars: 2 },
  },
  visibleText: '林昭打开门。',
}))
const restoreManuscriptRevisionMock = mock(async () => ({
  ok: true as const,
  triage: { tier: 'impact' as const, reasons: ['从正文版本历史恢复'] },
}))
const toastErrorMock = mock(() => {})
const toastInfoMock = mock(() => {})
const toastSuccessMock = mock(() => {})

// window.electron 在真机由 preload 经 contextBridge 注入；测试环境（happy-dom）没有 Electron
// 进程，只挂被 ChapterManuscriptView 实际调用到的那几个 IPC 出口（经 @/lib/ipc 转发），
// 其余 ElectronApi 字段本组件用不到，不补全 mock。
;(window as unknown as { electron: Partial<ElectronApi> }).electron = {
  // 润色（ADR-0041）：版本活在正文页，故正文视图挂载即订阅一次润色事件；
  // 同时读一次本书润色设置，用来决定要不要显示常驻结果横幅。
  onPolishEvent: (() => () => {}) as unknown as ElectronApi['onPolishEvent'],
  // 润色（ADR-0041）：阅读态挂载即读一次本书润色设置，用来决定要不要显示常驻结果横幅。
  getPolishSettings: (async () => ({
    version: 1,
    standingSlotId: null,
    standingOutcomes: {},
    divergedChapters: [],
  })) as unknown as ElectronApi['getPolishSettings'],
  saveChapterManuscript: saveChapterManuscriptMock as unknown as ElectronApi['saveChapterManuscript'],
  getManuscriptDraft: getManuscriptDraftMock as unknown as ElectronApi['getManuscriptDraft'],
  saveManuscriptDraft: saveManuscriptDraftMock as unknown as ElectronApi['saveManuscriptDraft'],
  discardManuscriptDraft: discardManuscriptDraftMock as unknown as ElectronApi['discardManuscriptDraft'],
  getPendingMemorySync: getPendingMemorySyncMock as unknown as ElectronApi['getPendingMemorySync'],
  listManuscriptRevisions:
    listManuscriptRevisionsMock as unknown as ElectronApi['listManuscriptRevisions'],
  readManuscriptRevision:
    readManuscriptRevisionMock as unknown as ElectronApi['readManuscriptRevision'],
  restoreManuscriptRevision:
    restoreManuscriptRevisionMock as unknown as ElectronApi['restoreManuscriptRevision'],
}

// sonner 的 toast 是模块级单例：覆写会泄漏给同进程后续加载的其它测试文件
// （GlobalRegistrator.unregister() 只拆 window/document，管不到模块导出），
// 保存原引用，在 afterAll 里恢复。
const originalToastError = toast.error
const originalToastInfo = toast.info
const originalToastSuccess = toast.success
toast.error = toastErrorMock as unknown as typeof toast.error
toast.info = toastInfoMock as unknown as typeof toast.info
toast.success = toastSuccessMock as unknown as typeof toast.success

function resetGuardStore() {
  cancelPendingManuscriptLeave()
  useManuscriptEditorGuard.setState({
    editing: false,
    saving: false,
    dirty: false,
    handlers: null,
    saveVersion: 0,
    draftVersion: 0,
    leaveDialogOpen: false,
    leaveResolving: false,
  })
}

function getHandlers() {
  const handlers = useManuscriptEditorGuard.getState().handlers
  if (!handlers) throw new Error('handlers 未注册：ChapterManuscriptView 是否已挂载？')
  return handlers
}

async function renderEditingView() {
  render(<ChapterManuscriptView artifact={artifact} projectPath="/p" chapter={3} agentBusy={false} />)
  await act(async () => {
    getHandlers().startEdit?.()
  })
}

// MarkdownSelectionSurface 的浮层只在真实的 window.getSelection() 命中划选区间后才渲染
// （见 ArtifactDocumentShell.tsx updateSelection），renderToStaticMarkup 测不出——用真实 DOM
// 建一个 Range 覆盖目标节点全部文本、挂进 window.getSelection()，再触发浮层监听的 mouseUp。
function selectAllTextIn(node: Element) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()
  if (!selection) throw new Error('window.getSelection 不可用')
  selection.removeAllRanges()
  selection.addRange(range)
}

function ControlledEditor({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue)
  return (
    <div data-workbench-object-scroll-frame="standard">
      <ManuscriptEditorView value={value} onChange={setValue} />
    </div>
  )
}

beforeEach(() => {
  resetGuardStore()
  saveChapterManuscriptMock.mockClear()
  getManuscriptDraftMock.mockClear()
  saveManuscriptDraftMock.mockClear()
  discardManuscriptDraftMock.mockClear()
  getPendingMemorySyncMock.mockClear()
  listManuscriptRevisionsMock.mockClear()
  readManuscriptRevisionMock.mockClear()
  restoreManuscriptRevisionMock.mockClear()
  toastErrorMock.mockClear()
  toastInfoMock.mockClear()
  toastSuccessMock.mockClear()
  saveChapterManuscriptMock.mockImplementation(async () => ({ ok: true, triage: { tier: 'silent', reasons: [] } }))
  getManuscriptDraftMock.mockImplementation(async () => ({ status: 'none' }))
  saveManuscriptDraftMock.mockImplementation(async () => ({ ok: true }))
  discardManuscriptDraftMock.mockImplementation(async () => ({ ok: true }))
  getPendingMemorySyncMock.mockImplementation(async () => ({}))
  listManuscriptRevisionsMock.mockImplementation(async () => ({
    revisions: [
      {
        id: 'rev-00000000-0000-4000-8000-000000000001',
        chapter: 3,
        source: 'author-save',
        createdAt: '2026-07-26T00:00:00.000Z',
        summary: { addedChars: 4, removedChars: 2 },
      },
    ],
    storageBytes: 2048,
  }))
  readManuscriptRevisionMock.mockImplementation(async () => ({
    revision: {
      id: 'rev-00000000-0000-4000-8000-000000000001',
      chapter: 3,
      source: 'author-save',
      createdAt: '2026-07-26T00:00:00.000Z',
      summary: { addedChars: 4, removedChars: 2 },
    },
    visibleText: '林昭打开门。',
  }))
  restoreManuscriptRevisionMock.mockImplementation(async () => ({
    ok: true,
    triage: { tier: 'impact', reasons: ['从正文版本历史恢复'] },
  }))
})

afterEach(() => {
  cleanup()
  resetGuardStore()
})

afterAll(async () => {
  toast.error = originalToastError
  toast.info = originalToastInfo
  toast.success = originalToastSuccess
  // 拆全局前让 React scheduler 的低优先级续跑（若有）先落地：不 flush 直接 unregister，
  // 该续跑可能在下一个文件已 register 新 window 之后才触发，读到跨文件的 window.event
  // 抛错（bun test 判「unhandled error between tests」，非 pass/fail 但仍拖垮进程退出码）。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await GlobalRegistrator.unregister()
})

describe('正文编辑态分支交互（真实 DOM）', () => {
  test('正文输入触发自动撑高时保持外层滚动位置和当前选区', async () => {
    const value = '第一段。\n\n他总结出一条非科学法则：小事随便玩，大事碰不得。\n\n最后一段。'
    render(<ControlledEditor initialValue={value} />)
    const scrollFrame = document.querySelector<HTMLElement>('[data-workbench-object-scroll-frame]')
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-manuscript-editor]')
    if (!scrollFrame || !textarea) throw new Error('测试夹具未渲染正文编辑器')

    scrollFrame.scrollTop = 480
    const selectionStart = value.indexOf('小事随便玩')
    textarea.focus()
    textarea.setSelectionRange(selectionStart, selectionStart + 2, 'forward')

    let renderedHeight = textarea.style.height
    Object.defineProperty(textarea.style, 'height', {
      configurable: true,
      get: () => renderedHeight,
      set: (next: string) => {
        renderedHeight = next
        if (next === 'auto') {
          // Chromium 在聚焦的长 textarea 瞬间收缩时会滚动外层容器，
          // 使光标行贴到视口底部；这里把该原生行为确定性注入回归测试。
          scrollFrame.scrollTop = 1_600
        }
      },
    })
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => 2_400,
    })

    const nextValue = `${value.slice(0, selectionStart)}新${value.slice(selectionStart + 2)}`
    await act(async () => {
      fireEvent.change(textarea, {
        target: {
          value: nextValue,
          selectionStart: selectionStart + 1,
          selectionEnd: selectionStart + 1,
        },
      })
    })

    expect(scrollFrame.scrollTop).toBe(480)
    expect(textarea.selectionStart).toBe(selectionStart + 1)
    expect(textarea.selectionEnd).toBe(selectionStart + 1)
  })

  test('同基线恢复草稿自动进入编辑态并给出克制提示', async () => {
    getManuscriptDraftMock.mockImplementation(async () => ({
      status: 'recoverable',
      chapter: 3,
      diskText: '林昭推开门。',
      draftText: '崩溃前最后一版正文。',
      updatedAt: '2026-07-23T00:00:00.000Z',
    }))

    render(<ChapterManuscriptView artifact={artifact} projectPath="/p" chapter={3} agentBusy={false} />)
    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull()
    })

    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('崩溃前最后一版正文。')
    expect(toastInfoMock).toHaveBeenCalledWith('已恢复未保存的正文草稿')
  })

  test('同一章节父组件重渲染不会重复 hydration 覆盖作者刚输入的内容', async () => {
    getManuscriptDraftMock.mockImplementation(async () => ({
      status: 'recoverable',
      chapter: 3,
      diskText: '林昭推开门。',
      draftText: '已落盘的恢复草稿。',
      updatedAt: '2026-07-23T00:00:00.000Z',
    }))

    const view = render(<ChapterManuscriptView artifact={artifact} projectPath="/p" chapter={3} agentBusy={false} />)
    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull()
    })
    await act(async () => {
      fireEvent.change(document.querySelector('textarea') as HTMLTextAreaElement, {
        target: { value: '恢复后继续输入的新内容。' },
      })
    })

    view.rerender(
      <ChapterManuscriptView artifact={{ ...artifact }} projectPath="/p" chapter={3} agentBusy={true} />,
    )
    await act(async () => {})

    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('恢复后继续输入的新内容。')
    expect(getManuscriptDraftMock).toHaveBeenCalledTimes(1)
  })

  test('基线冲突时同时展示两版，不自动合并；选择草稿只进入编辑态', async () => {
    getManuscriptDraftMock.mockImplementation(async () => ({
      status: 'conflict',
      chapter: 3,
      diskText: 'Agent 刚写入的当前正文。',
      draftText: '作者尚未保存的恢复草稿。',
      updatedAt: '2026-07-23T00:00:00.000Z',
    }))

    render(<ChapterManuscriptView artifact={artifact} projectPath="/p" chapter={3} agentBusy={false} />)
    await waitFor(() => {
      expect(document.querySelector('[data-manuscript-draft-conflict="true"]')).not.toBeNull()
    })
    expect(document.body.textContent).toContain('Agent 刚写入的当前正文。')
    expect(document.body.textContent).toContain('作者尚未保存的恢复草稿。')
    expect(saveChapterManuscriptMock).not.toHaveBeenCalled()

    const useDraftButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === '以草稿继续编辑',
    )
    await act(async () => {
      fireEvent.click(useDraftButton as HTMLButtonElement)
    })
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('作者尚未保存的恢复草稿。')
    expect(saveChapterManuscriptMock).not.toHaveBeenCalled()
  })

  test('isDraft 章 startEdit 短路，不进入编辑态（写作中断草稿只读，对齐 hasReadyManuscript 口径）', async () => {
    render(
      <ChapterManuscriptView artifact={{ ...artifact, isDraft: true }} projectPath="/p" chapter={3} agentBusy={false} />,
    )
    await act(async () => {
      getHandlers().startEdit?.()
    })

    expect(document.querySelector('textarea')).toBeNull()
    expect(document.querySelector('[data-manuscript-editing="true"]')).toBeNull()
  })

  test('isDraft 章基线冲突时不提供「以草稿继续编辑」入口，只能放弃草稿（不可进入编辑态）', async () => {
    getManuscriptDraftMock.mockImplementation(async () => ({
      status: 'conflict',
      chapter: 3,
      diskText: '中断前热写的草稿。',
      draftText: '作者尚未保存的恢复草稿。',
      updatedAt: '2026-07-23T00:00:00.000Z',
    }))

    render(
      <ChapterManuscriptView artifact={{ ...artifact, isDraft: true }} projectPath="/p" chapter={3} agentBusy={false} />,
    )
    await waitFor(() => {
      expect(document.querySelector('[data-manuscript-draft-conflict="true"]')).not.toBeNull()
    })

    const useDraftButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === '以草稿继续编辑',
    )
    expect(useDraftButton).toBeUndefined()
    expect(document.querySelector('textarea')).toBeNull()

    const discardButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === '放弃草稿，使用当前正文',
    )
    expect(discardButton).not.toBeUndefined()
  })

  test('① editing=true 时整体替换为 ManuscriptEditorView，阅读态内容不再渲染', async () => {
    await renderEditingView()

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.getAttribute('data-manuscript-editor')).toBe('true')
    expect(textarea.value).toContain('林昭推开门。')
    // 阅读态容器（含「记忆待同步」横条/ImpactEvaluationDock 挂载点）整体不渲染。
    expect(document.querySelector('[data-chapter-manuscript-view]')).toBeNull()
    expect(document.querySelector('[data-manuscript-editing="true"]')).not.toBeNull()
  })

  test('② save：空草稿报错不提交，编辑态不退出', async () => {
    await renderEditingView()
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: '   ' } })
    await act(async () => {
      await getHandlers().save?.()
    })

    expect(saveChapterManuscriptMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe('正文不能为空')
    // 仍在编辑态：textarea 还在。
    expect(document.querySelector('textarea')).toBeTruthy()
  })

  test('③ save：乐观锁冲突展示 message，编辑态不退出', async () => {
    saveChapterManuscriptMock.mockImplementation(async () => ({
      ok: false,
      conflict: true,
      message: '正文已更新，请刷新后重试',
    }))

    await renderEditingView()
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '林昭推开门，愣住了。' } })

    await act(async () => {
      await getHandlers().save?.()
    })

    expect(saveChapterManuscriptMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock.mock.calls[0]?.[0]).toBe('正文已更新，请刷新后重试')
    expect(toastSuccessMock).not.toHaveBeenCalled()
    // 冲突不落地，仍在编辑态。
    expect(document.querySelector('textarea')).toBeTruthy()
  })

  test('④ save：成功且分诊为 impact → 退出编辑态并浮出 ImpactEvaluationDock', async () => {
    saveChapterManuscriptMock.mockImplementation(async () => ({
      ok: true,
      triage: { tier: 'impact', reasons: ['新增角色关系：林昭与他的师父'] },
    }))

    await renderEditingView()
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '林昭推开门，愣住了。' } })

    await act(async () => {
      await getHandlers().save?.()
    })

    expect(saveChapterManuscriptMock).toHaveBeenCalledTimes(1)
    expect(toastSuccessMock).toHaveBeenCalledTimes(1)
    // 保存成功回到阅读态：编辑器整体替换消失。
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.querySelector('[data-manuscript-editing="true"]')).toBeNull()
    // dock 浮出：标题文案命中 ChapterManuscriptView 里写死的「记忆待同步」。
    const dockTitle = Array.from(document.querySelectorAll('*')).find(
      (el) => el.children.length === 0 && el.textContent === '记忆待同步',
    )
    expect(dockTitle).toBeTruthy()
    expect(document.querySelector('[data-impact-evaluation-dock="true"]')).not.toBeNull()
  })

  test('⑤ 离开守卫注册保留草稿 handler，并 flush 到最后一个字', async () => {
    await renderEditingView()
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '最后一个字也必须被保留。' } })
    })
    expect(useManuscriptEditorGuard.getState().dirty).toBe(true)

    const persisted = await getHandlers().keepDraftBeforeLeave?.()

    expect(persisted).toBe(true)
    expect(saveManuscriptDraftMock).toHaveBeenCalledWith({
      projectPath: '/p',
      chapter: 3,
      baseVisibleText: '林昭推开门。',
      draftText: '最后一个字也必须被保留。',
    })
  })

  test('⑥ 离开守卫注册明确放弃 handler，只删除恢复草稿', async () => {
    await renderEditingView()
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '待放弃的内容。' } })
    })

    const discarded = await getHandlers().discardDraftBeforeLeave?.()

    expect(discarded).toBe(true)
    expect(discardManuscriptDraftMock).toHaveBeenCalledWith({ projectPath: '/p', chapter: 3 })
    expect(saveChapterManuscriptMock).not.toHaveBeenCalled()
  })

  test('⑦ 版本历史按需读取 diff，确认恢复时只发送 revision id 与当前正文基线', async () => {
    const onChanged = mock(() => {})
    render(
      <ChapterManuscriptView
        artifact={artifact}
        projectPath="/p"
        chapter={3}
        agentBusy={false}
        onChanged={onChanged}
      />,
    )

    await act(async () => {
      getHandlers().openHistory?.()
    })
    await waitFor(() => {
      expect(listManuscriptRevisionsMock).toHaveBeenCalledWith({ projectPath: '/p', chapter: 3 })
    })

    // Sheet 从关闭态切到打开态依赖 Radix 在模块加载时探测 DOM；Bun 多文件测试可能先由
    // SSR 测试缓存其非浏览器分支。这里把 titlebar → handler → 按需读取和 Sheet 本身的
    // diff/恢复交互分别验证，直接以 open=true 挂载后者，避免测试文件加载顺序制造假失败。
    cleanup()
    resetGuardStore()
    render(
      <ManuscriptRevisionSheet
        open
        onOpenChange={() => {}}
        projectPath="/p"
        chapter={3}
        currentVisibleText="林昭推开门。"
        agentBusy={false}
        draftBlocked={false}
        onRestored={onChanged}
      />,
    )
    await waitFor(() => {
      expect(document.querySelector('[data-manuscript-revision-sheet="true"]')).not.toBeNull()
      expect(document.querySelector('[data-diff-line="removed"]')).not.toBeNull()
      expect(document.querySelector('[data-diff-line="added"]')).not.toBeNull()
    })
    expect(document.body.textContent).toContain('项目版本历史占用 2.0 KB')

    const restoreButton = document.querySelector<HTMLButtonElement>('[data-manuscript-revision-restore="true"]')
    fireEvent.click(restoreButton as HTMLButtonElement)
    await waitFor(() => {
      expect(document.querySelector('[data-manuscript-revision-restore-confirm="true"]')).not.toBeNull()
    })
    const confirmButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-manuscript-revision-restore-confirm="true"] button'),
    ).find((button) => button.textContent === '确认恢复')
    await act(async () => {
      fireEvent.click(confirmButton as HTMLButtonElement)
    })

    expect(restoreManuscriptRevisionMock).toHaveBeenCalledWith({
      projectPath: '/p',
      chapter: 3,
      revisionId: 'rev-00000000-0000-4000-8000-000000000001',
      expectedVisibleText: '林昭推开门。',
    })
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(toastSuccessMock).toHaveBeenCalledWith('正文版本已恢复')
  })
})

describe('正文划选浮层「设为本书样章」（真实 DOM）', () => {
  test('传入 extraActions 时，划选后浮层带「设为本书样章」按钮', async () => {
    const onAction = mock(() => {})
    render(
      <ChapterManuscriptView
        artifact={artifact}
        projectPath="/p"
        chapter={3}
        agentBusy={false}
        selectionHandoff={{
          enabled: true,
          label: '交给 Agent',
          onHandoff: () => {},
          extraActions: [{ label: '设为本书样章', onAction }],
        }}
      />,
    )

    const surface = document.querySelector('[data-markdown-selection-surface="true"]')
    const paragraph = surface?.querySelector('p')
    if (!surface || !paragraph) throw new Error('正文划选浮层容器未渲染')
    selectAllTextIn(paragraph)
    fireEvent.mouseUp(surface)

    await waitFor(() => {
      expect(document.querySelector('[data-markdown-selection-toolbar="true"]')).not.toBeNull()
    })
    expect(document.body.textContent).toContain('交给 Agent')
    expect(document.body.textContent).toContain('设为本书样章')
  })

  test('不传 extraActions 时浮层与从前一致（只有主按钮）', async () => {
    render(
      <ChapterManuscriptView
        artifact={artifact}
        projectPath="/p"
        chapter={3}
        agentBusy={false}
        selectionHandoff={{ enabled: true, label: '交给 Agent', onHandoff: () => {} }}
      />,
    )

    const surface = document.querySelector('[data-markdown-selection-surface="true"]')
    const paragraph = surface?.querySelector('p')
    if (!surface || !paragraph) throw new Error('正文划选浮层容器未渲染')
    selectAllTextIn(paragraph)
    fireEvent.mouseUp(surface)

    await waitFor(() => {
      expect(document.querySelector('[data-markdown-selection-toolbar="true"]')).not.toBeNull()
    })
    expect(document.body.textContent).toContain('交给 Agent')
    expect(document.body.textContent).not.toContain('设为本书样章')
  })
})
