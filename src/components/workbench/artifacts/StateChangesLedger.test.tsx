// 「本章状态变更」计划账本区测试（A4×D2 片3b，Task 6）。
//
// 分两段：
// ① SSR（renderToStaticMarkup）——StateChangesLedgerView 是纯展示组件（快照 + 受控 controller
//   两个 props，零 IPC/store 依赖），沿用 CharacterStatePanel.test.tsx 的套路：手工构造 controller
//   覆盖各态（editingRows/saveBlocked/canEdit），可以静态断言渲染结构，覆盖行为规格 1/2/3/4(结构)/5。
// ② 真实 DOM（happy-dom + @testing-library/react，沿用 ChapterManuscriptView.interactions.test.tsx
//   的先例）——挂载有状态的 StateChangesLedger，mock src/lib/ipc 的 readPlannedState/
//   updateChapterStateChanges 与 useAgentStore，驱动加载/编辑/保存/活动 run 互斥/toast，
//   覆盖行为规格 4(交互)/6/7。
import type { DraftRow, StateChangesLedgerController } from './StateChangesLedger'
import type { ChapterPlannedStateSnapshot, PlannedStateRowDto } from '@shared/types/planned-state'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const { afterAll, afterEach, beforeEach, describe, expect, mock, test } = await import('bun:test')

// 四个 IPC mock 必须在动态 import 组件之前就把 `@/lib/ipc` 模块整个换掉——
// mock.module 在 bun test 里是进程级的：同进程里任何先跑的文件（如 CharacterStatePanel.future-plans-effect
// .test.ts）对 `@/lib/ipc` 做过 mock.module，后续 import 拿到的就是它那份 mock，本文件只往 window.electron
// 里塞函数根本不会被调到。这条顺序依赖在 mac 本机跑不出（文件顺序不同），Linux CI 上一出现就是整组
// 「data-state-ledger 永远不出现」（PR #77 撞到）。照 use-planned-state-counts.test.ts 的套路：展开真实模块，
// 只覆写本文件关心的四个导出，其余保持真实，不炸同进程里别的文件。
const readPlannedStateMock = mock(async () => snapshot())
const updateChapterStateChangesMock = mock(async () => ({ ok: true }) as { ok: boolean; message?: string })
const submitAuthoredStateMock = mock(async () => ({ ok: true }) as { ok: boolean; message?: string })
const resolvePlannedStateMock = mock(async () => ({ ok: true }) as { ok: boolean; message?: string })
const actualIpc = await import('@/lib/ipc')
mock.module('@/lib/ipc', () => ({
  ...actualIpc,
  readPlannedState: readPlannedStateMock,
  updateChapterStateChanges: updateChapterStateChangesMock,
  submitAuthoredState: submitAuthoredStateMock,
  resolvePlannedState: resolvePlannedStateMock,
}))

const { act, cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { useAgentStore } = await import('@/lib/agent-store')
const { usePlannedStateRefresh } = await import('@/lib/planned-state-refresh')
const { TooltipProvider } = await import('@/components/ui/tooltip')
const { toast } = await import('sonner')
const {
  StateChangesLedger,
  StateChangesLedgerView,
  characterOptions,
  deriveStatusBadge,
  dimensionOptions,
  operationOptions,
  toJsonEntries,
  valueOptions,
} = await import('./StateChangesLedger')

type ElectronApi = typeof window.electron

// ---------------------------------------------------------------------------
// 共享 fixture
// ---------------------------------------------------------------------------

const dimensions = [
  { key: 'cultivation_level', displayName: '境界', cardinality: 'one' as const, valueType: 'enum' as const, values: ['筑基', '金丹'] },
  { key: 'inventory', displayName: '持有物', cardinality: 'many' as const, valueType: 'free' as const },
]

const characters = [
  { uid: 'C-1', name: '苏明' },
  { uid: 'C-2', name: '林昭' },
]

function plannedRow(overrides: Partial<PlannedStateRowDto> = {}): PlannedStateRowDto {
  return {
    id: 'row-1',
    chapter: 12,
    status: 'planned',
    deferredToChapter: null,
    characterUid: 'C-1',
    characterName: '苏明',
    dimension: 'cultivation_level',
    operation: 'set',
    value: '金丹',
    reason: null,
    ...overrides,
  }
}

function snapshot(overrides: Partial<ChapterPlannedStateSnapshot> = {}): ChapterPlannedStateSnapshot {
  return {
    available: true,
    rows: [plannedRow()],
    dimensions,
    characters,
    jsonStateChanges: [],
    ...overrides,
  }
}

function noopController(overrides: Partial<StateChangesLedgerController> = {}): StateChangesLedgerController {
  return {
    editingRows: null,
    pending: false,
    saveBlocked: false,
    canEdit: false,
    startEdit: () => {},
    cancelEdit: () => {},
    addRow: () => {},
    removeRow: () => {},
    updateRow: () => {},
    save: () => {},
    deferTargets: [],
    rowActionPending: null,
    confirmDelivered: () => {},
    defer: () => {},
    cancelPlanned: () => {},
    acknowledgePlanned: () => {},
    ...overrides,
  }
}

function draftRow(overrides: Partial<DraftRow> = {}): DraftRow {
  return {
    tempId: 'draft-1',
    characterUid: 'C-1',
    characterName: '苏明',
    dimension: 'cultivation_level',
    operation: 'set',
    value: '金丹',
    reason: '',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// ① SSR：纯展示组件结构断言
// ---------------------------------------------------------------------------

describe('StateChangesLedgerView（SSR 结构断言）', () => {
  test('行为规格 1：available=false 整区不渲染', () => {
    const html = renderToStaticMarkup(
      <StateChangesLedgerView
        snapshot={snapshot({ available: false })}
        chapterWritten={false}
        controller={noopController()}
      />,
    )
    expect(html).toBe('')
  })

  test('行为规格 1：rows 空且 dimensions 空整区不渲染（词表缺失零打扰）', () => {
    const html = renderToStaticMarkup(
      <StateChangesLedgerView
        snapshot={snapshot({ rows: [], dimensions: [] })}
        chapterWritten={false}
        controller={noopController()}
      />,
    )
    expect(html).toBe('')
  })

  test('行为规格 2：rows 空但 dimensions 非空且未写章 → 空态一行 + 加行按钮', () => {
    const html = renderToStaticMarkup(
      <StateChangesLedgerView
        snapshot={snapshot({ rows: [] })}
        chapterWritten={false}
        controller={noopController({ canEdit: true })}
      />,
    )
    expect(html).toContain('data-state-ledger-empty="true"')
    expect(html).toContain('本章暂无计划的状态变更')
    expect(html).toContain('data-state-ledger-action="add-first"')
    expect(html).toContain('计划一条状态变更')
  })

  test('行为规格 3：五态徽标——未到章/未兑现(bg-warning)/已兑现/已顺延→第N章/已取消/已知悉', () => {
    expect(deriveStatusBadge(plannedRow({ status: 'planned' }), false)).toEqual({
      label: '未到章',
      className: expect.any(String),
    })
    const undelivered = deriveStatusBadge(plannedRow({ status: 'planned' }), true)
    expect(undelivered.label).toBe('未兑现')
    expect(undelivered.className).toContain('bg-warning')
    expect(deriveStatusBadge(plannedRow({ status: 'delivered' }), true).label).toBe('已兑现')
    expect(deriveStatusBadge(plannedRow({ status: 'deferred', deferredToChapter: 18 }), true).label).toBe(
      '已顺延 → 第 18 章',
    )
    expect(deriveStatusBadge(plannedRow({ status: 'cancelled' }), true).label).toBe('已取消')
    expect(deriveStatusBadge(plannedRow({ status: 'acknowledged' }), true).label).toBe('已知悉')

    const html = renderToStaticMarkup(
      <StateChangesLedgerView
        snapshot={snapshot({
          rows: [
            plannedRow({ id: 'r-planned-unwritten', status: 'planned' }),
            plannedRow({ id: 'r-deferred', status: 'deferred', deferredToChapter: 18 }),
          ],
        })}
        chapterWritten={false}
        controller={noopController()}
      />,
    )
    expect(html).toContain('未到章')
    expect(html).toContain('已顺延 → 第 18 章')
    expect(html).toContain('data-state-ledger-status="planned"')
    expect(html).toContain('data-state-ledger-status="deferred"')
  })

  test('行为规格 3（续）：已写章 planned 行显示「未兑现」且带 bg-warning 橙色调', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <StateChangesLedgerView
          snapshot={snapshot({ rows: [plannedRow({ status: 'planned' })] })}
          chapterWritten={true}
          controller={noopController()}
        />
      </TooltipProvider>,
    )
    expect(html).toContain('未兑现')
    expect(html).toContain('bg-warning')
  })

  test('词表缺失但有行：维度只读展示原 key，禁编辑/加行入口（结构预留但不开放）', () => {
    const html = renderToStaticMarkup(
      <StateChangesLedgerView
        snapshot={snapshot({ dimensions: [], rows: [plannedRow({ dimension: 'unknown_dim_key' })] })}
        chapterWritten={false}
        controller={noopController({ canEdit: false })}
      />,
    )
    expect(html).toContain('unknown_dim_key')
    expect(html).not.toContain('data-state-ledger-action="edit"')
    expect(html).not.toContain('data-state-ledger-action="add-first"')
  })

  test('行为规格 4：未写章可编辑——角色/维度下拉、one 维度固定「设为」、many 维度值 free 输入 maxLength 60、缘由 maxLength 100、删除行入口', () => {
    const html = renderToStaticMarkup(
      <StateChangesLedgerView
        snapshot={snapshot()}
        chapterWritten={false}
        controller={noopController({
          canEdit: true,
          editingRows: [
            draftRow({ tempId: 'one', dimension: 'cultivation_level', operation: 'set', value: '金丹' }),
            draftRow({ tempId: 'many', dimension: 'inventory', operation: 'add', value: '长枪', characterUid: 'C-2', characterName: '林昭' }),
          ],
        })}
      />,
    )
    expect(html).toContain('data-state-ledger-editor="true"')
    expect(html).toContain('data-state-ledger-edit-row="one"')
    expect(html).toContain('data-state-ledger-edit-row="many"')
    expect(html).toContain('aria-label="角色"')
    expect(html).toContain('aria-label="维度"')
    expect(html).toContain('设为')
    expect(html).toContain('maxLength="60"')
    expect(html).toContain('maxLength="100"')
    expect(html).toContain('aria-label="删除该行"')
    expect(html).toContain('data-state-ledger-action="add-row"')
  })

  test('行为规格 4：加行按钮在 planned 计 ≥8 时禁用', () => {
    const eightRows = Array.from({ length: 8 }, (_, i) => draftRow({ tempId: `r-${i}` }))
    const html = renderToStaticMarkup(
      <StateChangesLedgerView
        snapshot={snapshot()}
        chapterWritten={false}
        controller={noopController({ canEdit: true, editingRows: eightRows })}
      />,
    )
    const addRowButton = html.match(/<button[^>]*data-state-ledger-action="add-row"[^>]*>/)?.[0] ?? ''
    expect(addRowButton).toContain('disabled')
  })

  test('jsonStateChanges 缺失（canEdit=false 兜底）：无编辑/加行入口，但行仍照常展示', () => {
    const html = renderToStaticMarkup(
      <StateChangesLedgerView
        snapshot={snapshot({ jsonStateChanges: null })}
        chapterWritten={false}
        controller={noopController({ canEdit: false })}
      />,
    )
    expect(html).not.toContain('data-state-ledger-action="edit"')
    expect(html).toContain('苏明')
  })

  test('行为规格 5：已写章只读——不渲染编辑/加行按钮', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <StateChangesLedgerView
          snapshot={snapshot()}
          chapterWritten={true}
          controller={noopController({ canEdit: false })}
        />
      </TooltipProvider>,
    )
    expect(html).not.toContain('data-state-ledger-action="edit"')
    expect(html).not.toContain('data-state-ledger-action="add-row"')
    expect(html).not.toContain('data-state-ledger-editor')
    expect(html).toContain('苏明')
  })

  test('行为规格 6（结构半侧）：saveBlocked=true 时保存/加行/删行按钮全禁用（编辑态）', () => {
    const html = renderToStaticMarkup(
      <StateChangesLedgerView
        snapshot={snapshot()}
        chapterWritten={false}
        controller={noopController({ canEdit: true, editingRows: [draftRow()], saveBlocked: true })}
      />,
    )
    for (const action of ['save', 'add-row', 'remove-row']) {
      const button = html.match(new RegExp(`<button[^>]*data-state-ledger-action="${action}"[^>]*>`))?.[0] ?? ''
      expect(button).toContain('disabled')
    }
  })

  test('行为规格 6（结构半侧）：saveBlocked=true 时「编辑」入口与空态加行按钮禁用（只读态）', () => {
    const withRows = renderToStaticMarkup(
      <StateChangesLedgerView
        snapshot={snapshot()}
        chapterWritten={false}
        controller={noopController({ canEdit: true, saveBlocked: true })}
      />,
    )
    const editButton = withRows.match(/<button[^>]*data-state-ledger-action="edit"[^>]*>/)?.[0] ?? ''
    expect(editButton).toContain('disabled')

    const emptyState = renderToStaticMarkup(
      <StateChangesLedgerView
        snapshot={snapshot({ rows: [] })}
        chapterWritten={false}
        controller={noopController({ canEdit: true, saveBlocked: true })}
      />,
    )
    const addFirstButton = emptyState.match(/<button[^>]*data-state-ledger-action="add-first"[^>]*>/)?.[0] ?? ''
    expect(addFirstButton).toContain('disabled')
  })
})

describe('下拉选项构造纯函数（Radix SelectContent 关闭态 SSR 渲染为 null，选项集合在此锁定）', () => {
  test('characterOptions：uid→value、name→label，顺序保持', () => {
    expect(characterOptions(characters)).toEqual([
      { value: 'C-1', label: '苏明' },
      { value: 'C-2', label: '林昭' },
    ])
    expect(characterOptions([])).toEqual([])
  })

  test('dimensionOptions：key→value、displayName→label', () => {
    expect(dimensionOptions(dimensions)).toEqual([
      { value: 'cultivation_level', label: '境界' },
      { value: 'inventory', label: '持有物' },
    ])
  })

  test('valueOptions：enum 维度返回值域梯子；free 维度与未知维度返回 null（走文本输入分支）', () => {
    expect(valueOptions(dimensions[0])).toEqual([
      { value: '筑基', label: '筑基' },
      { value: '金丹', label: '金丹' },
    ])
    expect(valueOptions(dimensions[1])).toBeNull()
    expect(valueOptions(undefined)).toBeNull()
  })

  test('operationOptions：many 维度返回「获得/失去」对；one 维度与未知维度返回 null（固定「设为」）', () => {
    expect(operationOptions(dimensions[1])).toEqual([
      { value: 'add', label: '获得' },
      { value: 'remove', label: '失去' },
    ])
    expect(operationOptions(dimensions[0])).toBeNull()
    expect(operationOptions(undefined)).toBeNull()
  })
})

describe('toJsonEntries', () => {
  test('只映射 planned 行，终态行不混入；set 不带 reason 字段则省略', () => {
    const entries = toJsonEntries([
      plannedRow({ status: 'planned', reason: '突破契机' }),
      plannedRow({ id: 'row-2', status: 'delivered' }),
      plannedRow({ id: 'row-3', status: 'deferred', deferredToChapter: 20 }),
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      character: { character_uid: 'C-1', name: '苏明' },
      dimension: 'cultivation_level',
      operation: 'set',
      value: '金丹',
      reason: '突破契机',
    })
  })
})

// ---------------------------------------------------------------------------
// ② 真实 DOM：有状态组件（加载/编辑/保存/活动 run 互斥/toast）
// ---------------------------------------------------------------------------

const toastErrorMock = mock(() => {})
const toastSuccessMock = mock(() => {})

;(window as unknown as { electron: Partial<ElectronApi> }).electron = {
  readPlannedState: readPlannedStateMock as unknown as ElectronApi['readPlannedState'],
  updateChapterStateChanges: updateChapterStateChangesMock as unknown as ElectronApi['updateChapterStateChanges'],
  submitAuthoredState: submitAuthoredStateMock as unknown as ElectronApi['submitAuthoredState'],
  resolvePlannedState: resolvePlannedStateMock as unknown as ElectronApi['resolvePlannedState'],
}

const originalToastError = toast.error
const originalToastSuccess = toast.success
toast.error = toastErrorMock as unknown as typeof toast.error
toast.success = toastSuccessMock as unknown as typeof toast.success

beforeEach(() => {
  readPlannedStateMock.mockClear()
  updateChapterStateChangesMock.mockClear()
  submitAuthoredStateMock.mockClear()
  resolvePlannedStateMock.mockClear()
  toastErrorMock.mockClear()
  toastSuccessMock.mockClear()
  readPlannedStateMock.mockImplementation(async () => snapshot())
  updateChapterStateChangesMock.mockImplementation(async () => ({ ok: true }))
  submitAuthoredStateMock.mockImplementation(async () => ({ ok: true }))
  resolvePlannedStateMock.mockImplementation(async () => ({ ok: true }))
  useAgentStore.getState().resetAgentState()
  usePlannedStateRefresh.setState({ version: 0 })
})

afterEach(() => {
  cleanup()
})

afterAll(async () => {
  toast.error = originalToastError
  toast.success = originalToastSuccess
  // 拆全局前让 React scheduler 的低优先级续跑（若有）先落地：不 flush 直接 unregister，
  // 该续跑可能在下一个文件已 register 新 window 之后才触发，读到跨文件的 window.event
  // 抛错（bun test 判「unhandled error between tests」，非 pass/fail 但仍拖垮进程退出码）。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await GlobalRegistrator.unregister()
})

async function renderLedger(
  onChanged?: () => void,
  options: { chapterWritten?: boolean; deferTargets?: number[] } = {},
) {
  render(
    <TooltipProvider>
      <StateChangesLedger
        projectPath="/p"
        chapter={12}
        chapterWritten={options.chapterWritten ?? false}
        deferTargets={options.deferTargets}
        onChanged={onChanged}
      />
    </TooltipProvider>,
  )
  await waitFor(() => {
    expect(document.querySelector('[data-state-ledger="true"]')).toBeTruthy()
  })
}

/** 找到 row-1 行内某个处置动作按钮（scoped 到该行容器，避免多行时误命中） */
function findRowAction(action: string): HTMLButtonElement {
  return document.querySelector(
    `[data-state-ledger-row="row-1"] [data-state-ledger-row-action="${action}"]`,
  ) as HTMLButtonElement
}

describe('StateChangesLedger（真实 DOM 交互）', () => {
  test('加载后只读展示计划表行', async () => {
    await renderLedger()
    expect(readPlannedStateMock).toHaveBeenCalledWith({
      projectPath: '/p',
      scope: { kind: 'chapter', chapter: 12 },
    })
    expect(document.querySelector('[data-state-ledger-row="row-1"]')?.textContent).toContain('苏明')
  })

  test('行为规格 4：点击「编辑」进入编辑态，「加一行」增加草稿行，删除行减少草稿行', async () => {
    await renderLedger()

    const editButton = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('data-state-ledger-action') === 'edit',
    ) as HTMLButtonElement
    await act(async () => {
      fireEvent.click(editButton)
    })
    expect(document.querySelectorAll('[data-state-ledger-edit-row]')).toHaveLength(1)

    const addRowButton = document.querySelector('[data-state-ledger-action="add-row"]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(addRowButton)
    })
    expect(document.querySelectorAll('[data-state-ledger-edit-row]')).toHaveLength(2)

    const removeButtons = document.querySelectorAll('[data-state-ledger-action="remove-row"]')
    await act(async () => {
      fireEvent.click(removeButtons[0])
    })
    expect(document.querySelectorAll('[data-state-ledger-edit-row]')).toHaveLength(1)
  })

  test('行为规格 7：保存成功 → toast「已保存」+ 退出编辑态 + onChanged 回调', async () => {
    const onChanged = mock(() => {})
    await renderLedger(onChanged)

    const editButton = document.querySelector('[data-state-ledger-action="edit"]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(editButton)
    })

    const saveButton = document.querySelector('[data-state-ledger-action="save"]') as HTMLButtonElement
    expect(saveButton.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(saveButton)
    })

    expect(updateChapterStateChangesMock).toHaveBeenCalledTimes(1)
    const call = updateChapterStateChangesMock.mock.calls[0]?.[0]
    expect(call?.payload).toEqual({
      chapter: 12,
      state_changes: [
        {
          character: { character_uid: 'C-1', name: '苏明' },
          dimension: 'cultivation_level',
          operation: 'set',
          value: '金丹',
        },
      ],
      expected_state_changes: [],
    })
    expect(toastSuccessMock).toHaveBeenCalledWith('已保存')
    expect(onChanged).toHaveBeenCalledTimes(1)
    // 终审 Fix 1：保存成功后 bump 跨组件刷新信号，侧栏橙点才会重拉计数
    expect(usePlannedStateRefresh.getState().version).toBe(1)
    await waitFor(() => {
      expect(document.querySelector('[data-state-ledger-editor]')).toBeNull()
    })
  })

  test('行为规格 7：保存失败 → toast 引擎 hint，仍留在编辑态', async () => {
    updateChapterStateChangesMock.mockImplementation(async () => ({ ok: false, message: '与最新计划不一致，请刷新后重试' }))
    await renderLedger()

    const editButton = document.querySelector('[data-state-ledger-action="edit"]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(editButton)
    })
    const saveButton = document.querySelector('[data-state-ledger-action="save"]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(saveButton)
    })

    expect(toastErrorMock).toHaveBeenCalledWith('与最新计划不一致，请刷新后重试')
    expect(toastSuccessMock).not.toHaveBeenCalled()
    expect(document.querySelector('[data-state-ledger-editor]')).toBeTruthy()
    // 未成功，不 bump 跨组件刷新信号
    expect(usePlannedStateRefresh.getState().version).toBe(0)
  })

  test('终审 Fix 2：保存因 CAS 冲突失败 → 自愈重拉快照（陈旧 expected 不再卡死重试），编辑态草稿仍在', async () => {
    updateChapterStateChangesMock.mockImplementation(async () => ({ ok: false, message: '章纲已被更新，请刷新后重试' }))
    await renderLedger()
    expect(readPlannedStateMock).toHaveBeenCalledTimes(1) // 挂载时一次

    const editButton = document.querySelector('[data-state-ledger-action="edit"]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(editButton)
    })
    const saveButton = document.querySelector('[data-state-ledger-action="save"]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(saveButton)
    })

    expect(toastErrorMock).toHaveBeenCalledWith('章纲已被更新，请刷新后重试')
    // save 失败分支 await load()：拿到最新 snapshot.jsonStateChanges 作为下次重试的新 CAS 基线
    expect(readPlannedStateMock).toHaveBeenCalledTimes(2)
    // editingRows 是独立 state，不受 reload 影响，草稿仍留在编辑态供用户重试保存
    expect(document.querySelector('[data-state-ledger-editor]')).toBeTruthy()
    expect(document.querySelectorAll('[data-state-ledger-edit-row]')).toHaveLength(1)
  })

  test('行为规格 6：活动 agent run 存在时保存/加行/删行按钮全禁用（接入 useAgentStore 真实互斥口径）', async () => {
    await renderLedger()
    const editButton = document.querySelector('[data-state-ledger-action="edit"]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(editButton)
    })

    let saveButton = document.querySelector('[data-state-ledger-action="save"]') as HTMLButtonElement
    expect(saveButton.disabled).toBe(false)

    await act(async () => {
      useAgentStore.getState().applyAgentEvent({
        type: 'run.started',
        runId: 'run-1',
        threadId: useAgentStore.getState().activeThreadId,
        command: 'freeform',
        prompt: '写作中',
        createdAt: new Date().toISOString(),
      })
    })

    saveButton = document.querySelector('[data-state-ledger-action="save"]') as HTMLButtonElement
    expect(saveButton.disabled).toBe(true)
    const addRowButton = document.querySelector('[data-state-ledger-action="add-row"]') as HTMLButtonElement
    expect(addRowButton.disabled).toBe(true)
    const removeButton = document.querySelector('[data-state-ledger-action="remove-row"]') as HTMLButtonElement
    expect(removeButton.disabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ③ Task 7：未兑现行四动作（IPC 调用序列断言）
// ---------------------------------------------------------------------------

describe('StateChangesLedger（未兑现行四动作，Task 7）', () => {
  test('未兑现行（planned && chapterWritten）才显示四动作；未到章/已写章其它终态不显示', async () => {
    readPlannedStateMock.mockImplementation(async () =>
      snapshot({
        rows: [
          plannedRow({ id: 'row-1', status: 'planned' }),
          plannedRow({ id: 'row-2', status: 'delivered' }),
        ],
      }),
    )
    await renderLedger(undefined, { chapterWritten: true })
    expect(document.querySelector('[data-state-ledger-row="row-1"] [data-state-ledger-row-action="cancel"]')).toBeTruthy()
    expect(document.querySelector('[data-state-ledger-row="row-2"] [data-state-ledger-row-action="cancel"]')).toBeNull()
  })

  test('未写章（未到章）：即便词表缺失也不影响——四动作不出现（未兑现判定=planned && chapterWritten）', async () => {
    await renderLedger(undefined, { chapterWritten: false })
    expect(findRowAction('cancel')).toBeFalsy()
  })

  test('正文已写到：remove 操作走 set_current+remove，两步都成功后 toast 成功 + reload + onChanged', async () => {
    readPlannedStateMock.mockImplementation(async () => snapshot({ rows: [plannedRow({ operation: 'remove', value: '长枪' })] }))
    const onChanged = mock(() => {})
    await renderLedger(onChanged, { chapterWritten: true })

    await act(async () => {
      fireEvent.click(findRowAction('mark-delivered'))
    })
    const confirmButton = findRowAction('confirm-delivered')
    expect(confirmButton.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(confirmButton)
    })

    expect(submitAuthoredStateMock).toHaveBeenCalledTimes(1)
    expect(submitAuthoredStateMock.mock.calls[0]?.[0]).toEqual({
      projectPath: '/p',
      payload: {
        character_uid: 'C-1',
        action: 'set_current',
        dimension: 'cultivation_level',
        operation: 'remove',
        value: '长枪',
        effective_chapter: 12,
      },
    })
    expect(resolvePlannedStateMock).toHaveBeenCalledWith({
      projectPath: '/p',
      payload: { id: 'row-1', action: 'mark_delivered' },
    })
    expect(toastSuccessMock).toHaveBeenCalledWith('已兑现并修正记忆')
    expect(onChanged).toHaveBeenCalledTimes(1)
    // reload：第一次挂载 + 兑现成功后各一次
    expect(readPlannedStateMock).toHaveBeenCalledTimes(2)
    // 终审 Fix 1：「正文已写到」两步表单两步都成功后 bump 跨组件刷新信号
    expect(usePlannedStateRefresh.getState().version).toBe(1)
  })

  test('正文已写到：set/add 操作走 backfill（不带 operation 字段），发生章默认=本章', async () => {
    await renderLedger(undefined, { chapterWritten: true })

    await act(async () => {
      fireEvent.click(findRowAction('mark-delivered'))
    })
    await act(async () => {
      fireEvent.click(findRowAction('confirm-delivered'))
    })

    expect(submitAuthoredStateMock.mock.calls[0]?.[0]).toEqual({
      projectPath: '/p',
      payload: {
        character_uid: 'C-1',
        action: 'backfill',
        dimension: 'cultivation_level',
        value: '金丹',
        effective_chapter: 12,
      },
    })
    expect(resolvePlannedStateMock).toHaveBeenCalledTimes(1)
  })

  test('正文已写到：第二步（mark_delivered）失败 → toast 引擎 hint + reload（自愈口径与 defer/cancel 一致），不发 onChanged', async () => {
    resolvePlannedStateMock.mockImplementation(async () => ({ ok: false, message: '计划行不存在或已随大纲重提交被替换，请刷新后重试' }))
    const onChanged = mock(() => {})
    await renderLedger(onChanged, { chapterWritten: true })

    await act(async () => {
      fireEvent.click(findRowAction('mark-delivered'))
    })
    await act(async () => {
      fireEvent.click(findRowAction('confirm-delivered'))
    })

    expect(submitAuthoredStateMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('计划行不存在或已随大纲重提交被替换，请刷新后重试')
    expect(toastSuccessMock).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    // reload：挂载 1 次 + 第二步失败后自愈刷新 1 次
    expect(readPlannedStateMock).toHaveBeenCalledTimes(2)
  })

  test('正文已写到：第一步（记忆写入）失败时，第二步 mark_delivered 绝不发，toast 引擎 hint', async () => {
    submitAuthoredStateMock.mockImplementation(async () => ({ ok: false, message: '当前状态不含该值，建议改用「取消」' }))
    await renderLedger(undefined, { chapterWritten: true })

    await act(async () => {
      fireEvent.click(findRowAction('mark-delivered'))
    })
    await act(async () => {
      fireEvent.click(findRowAction('confirm-delivered'))
    })

    expect(submitAuthoredStateMock).toHaveBeenCalledTimes(1)
    expect(resolvePlannedStateMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledWith('当前状态不含该值，建议改用「取消」')
    expect(toastSuccessMock).not.toHaveBeenCalled()
  })

  test('移到后续章：无候选章（deferTargets 为空）时动作按钮置灰', async () => {
    await renderLedger(undefined, { chapterWritten: true, deferTargets: [] })
    expect(findRowAction('defer').disabled).toBe(true)
  })

  test('移到后续章：有候选章时提交 resolvePlannedState action=defer 带 to_chapter，成功后 reload+onChanged', async () => {
    const onChanged = mock(() => {})
    await renderLedger(onChanged, { chapterWritten: true, deferTargets: [15, 18] })

    const deferButton = findRowAction('defer')
    expect(deferButton.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(deferButton)
    })
    await act(async () => {
      fireEvent.click(findRowAction('confirm-defer'))
    })

    expect(resolvePlannedStateMock).toHaveBeenCalledWith({
      projectPath: '/p',
      payload: { id: 'row-1', action: 'defer', to_chapter: 15 },
    })
    expect(toastSuccessMock).toHaveBeenCalledWith('已顺延')
    expect(onChanged).toHaveBeenCalledTimes(1)
    // 终审 Fix 1：defer/cancel/acknowledge 三态迁移共用路由成功后同样 bump
    expect(usePlannedStateRefresh.getState().version).toBe(1)
  })

  test('取消这项计划：直调 resolvePlannedState action=cancel，无需中间表单', async () => {
    await renderLedger(undefined, { chapterWritten: true })
    await act(async () => {
      fireEvent.click(findRowAction('cancel'))
    })
    expect(resolvePlannedStateMock).toHaveBeenCalledWith({
      projectPath: '/p',
      payload: { id: 'row-1', action: 'cancel' },
    })
    expect(toastSuccessMock).toHaveBeenCalledWith('已取消该计划')
  })

  test('暂时保留提醒：直调 resolvePlannedState action=acknowledge，无需中间表单', async () => {
    await renderLedger(undefined, { chapterWritten: true })
    await act(async () => {
      fireEvent.click(findRowAction('acknowledge'))
    })
    expect(resolvePlannedStateMock).toHaveBeenCalledWith({
      projectPath: '/p',
      payload: { id: 'row-1', action: 'acknowledge' },
    })
    expect(toastSuccessMock).toHaveBeenCalledWith('已知悉，不再提醒')
  })

  test('引擎「计划行不存在/已处置」类错误：toast + reload（自动刷掉 stale 行）', async () => {
    resolvePlannedStateMock.mockImplementation(async () => ({ ok: false, message: '该计划已处置过，请刷新后重试' }))
    await renderLedger(undefined, { chapterWritten: true })

    await act(async () => {
      fireEvent.click(findRowAction('cancel'))
    })

    expect(toastErrorMock).toHaveBeenCalledWith('该计划已处置过，请刷新后重试')
    // reload：挂载 1 次 + 失败后自愈刷新 1 次
    expect(readPlannedStateMock).toHaveBeenCalledTimes(2)
  })

  test('行为规格 4：saveBlocked（活动 agent run）期间四动作按钮全禁用', async () => {
    await renderLedger(undefined, { chapterWritten: true, deferTargets: [15] })

    expect(findRowAction('mark-delivered').disabled).toBe(false)
    await act(async () => {
      useAgentStore.getState().applyAgentEvent({
        type: 'run.started',
        runId: 'run-1',
        threadId: useAgentStore.getState().activeThreadId,
        command: 'freeform',
        prompt: '写作中',
        createdAt: new Date().toISOString(),
      })
    })

    expect(findRowAction('mark-delivered').disabled).toBe(true)
    expect(findRowAction('defer').disabled).toBe(true)
    expect(findRowAction('cancel').disabled).toBe(true)
    expect(findRowAction('acknowledge').disabled).toBe(true)
  })
})
