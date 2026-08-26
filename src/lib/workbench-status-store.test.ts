import { afterEach, describe, expect, test } from 'bun:test'
import { useWorkbenchStatusStore } from './workbench-status-store'
import type { NovelStatusSnapshot } from '@shared/types/novel'

const originalWindow = globalThis.window

function snapshotFixture(overrides: Partial<NovelStatusSnapshot> = {}): NovelStatusSnapshot {
  return {
    generatedAt: '2026-06-15T08:00:00.000Z',
    book: { title: '星辰大海', genre: '科幻' },
    progress: {
      completedChapters: 1,
      totalChaptersPlanned: 2,
      percentage: 50,
      inProgressChapter: null,
      wordCountTotal: 2100,
      avgWordsPerChapter: 2100,
    },
    checkpoint: null,
    nextAction: { chapter: 2 },
    ...overrides,
  }
}

function mockElectron(electron: Record<string, unknown>): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electron },
  })
}

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  useWorkbenchStatusStore.getState().reset()
})

describe('useWorkbenchStatusStore', () => {
  test('hydrate enters empty phase when no snapshot has been persisted', async () => {
    mockElectron({ readNovelStatus: () => Promise.resolve(null) })

    await useWorkbenchStatusStore.getState().hydrate('/novels/stars')

    expect(useWorkbenchStatusStore.getState().phase).toBe('empty')
    expect(useWorkbenchStatusStore.getState().snapshot).toBeNull()
  })

  test('hydrate enters loaded phase with the persisted snapshot', async () => {
    const snapshot = snapshotFixture()
    mockElectron({ readNovelStatus: () => Promise.resolve(snapshot) })

    await useWorkbenchStatusStore.getState().hydrate('/novels/stars')

    expect(useWorkbenchStatusStore.getState().phase).toBe('loaded')
    expect(useWorkbenchStatusStore.getState().snapshot).toEqual(snapshot)
  })

  test('refresh aggregates a fresh snapshot and lands on loaded', async () => {
    const fresh = snapshotFixture({ generatedAt: '2026-06-16T00:00:00.000Z' })
    mockElectron({ refreshNovelStatus: () => Promise.resolve(fresh) })

    await useWorkbenchStatusStore.getState().refresh('/novels/stars')

    expect(useWorkbenchStatusStore.getState().phase).toBe('loaded')
    expect(useWorkbenchStatusStore.getState().snapshot).toEqual(fresh)
  })

  test('switching project paths clears the previous snapshot', () => {
    useWorkbenchStatusStore.setState({ projectPath: '/a', phase: 'loaded', snapshot: snapshotFixture() })

    useWorkbenchStatusStore.getState().setProjectPath('/b')

    expect(useWorkbenchStatusStore.getState().projectPath).toBe('/b')
    expect(useWorkbenchStatusStore.getState().phase).toBe('idle')
    expect(useWorkbenchStatusStore.getState().snapshot).toBeNull()
  })

  test('refresh enters refreshing phase before resolving to loaded', async () => {
    let resolveRefresh: (value: NovelStatusSnapshot) => void = () => {}
    const pending = new Promise<NovelStatusSnapshot>((resolve) => {
      resolveRefresh = resolve
    })
    mockElectron({ refreshNovelStatus: () => pending })

    const refreshPromise = useWorkbenchStatusStore.getState().refresh('/novels/stars')
    // 触发后立即进入「更新中」态。
    expect(useWorkbenchStatusStore.getState().phase).toBe('refreshing')

    const fresh = snapshotFixture({ generatedAt: '2026-06-16T01:00:00.000Z' })
    resolveRefresh(fresh)
    await refreshPromise

    expect(useWorkbenchStatusStore.getState().phase).toBe('loaded')
    expect(useWorkbenchStatusStore.getState().snapshot).toEqual(fresh)
  })

  test('refresh in flight cannot be triggered again (debounce)', async () => {
    let calls = 0
    let resolveRefresh: (value: NovelStatusSnapshot) => void = () => {}
    const pending = new Promise<NovelStatusSnapshot>((resolve) => {
      resolveRefresh = resolve
    })
    mockElectron({
      refreshNovelStatus: () => {
        calls += 1
        return pending
      },
    })

    const first = useWorkbenchStatusStore.getState().refresh('/novels/stars')
    // 第二次触发应被去抖丢弃。
    await useWorkbenchStatusStore.getState().refresh('/novels/stars')
    expect(calls).toBe(1)

    resolveRefresh(snapshotFixture())
    await first
    expect(calls).toBe(1)
  })

  test('refresh failure lands on failed phase without erasing the last successful snapshot', async () => {
    const previous = snapshotFixture()
    useWorkbenchStatusStore.setState({ projectPath: '/novels/stars', phase: 'loaded', snapshot: previous })
    mockElectron({ refreshNovelStatus: () => Promise.reject(new Error('聚合失败')) })

    await useWorkbenchStatusStore.getState().refresh('/novels/stars')

    expect(useWorkbenchStatusStore.getState().phase).toBe('failed')
    expect(useWorkbenchStatusStore.getState().error).toBe('聚合失败')
    // 不抹掉上一次成功的快照。
    expect(useWorkbenchStatusStore.getState().snapshot).toEqual(previous)
  })


  test('strips the Electron IPC wrapper from the stored error message (#38)', async () => {
    // 作者看到的是 store 里这个字符串。带着 `Error invoking remote method 'novel:refresh-status'`
    // 直接渲染，等于把实现细节糊在脸上，还把唯一有用的信息挤到后面。
    useWorkbenchStatusStore.setState({ projectPath: '/novels/stars', phase: 'loaded' })
    mockElectron({
      refreshNovelStatus: () =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'novel:refresh-status': Error: 缺少 .narracat/config.yaml 或 .narracat/state.yaml",
          ),
        ),
    })

    await useWorkbenchStatusStore.getState().refresh('/novels/stars')

    expect(useWorkbenchStatusStore.getState().error).toBe(
      '缺少 .narracat/config.yaml 或 .narracat/state.yaml',
    )
  })

  test('enter hydrates the persisted snapshot then background-refreshes when one exists', async () => {
    const persisted = snapshotFixture()
    const fresh = snapshotFixture({ generatedAt: '2026-06-17T00:00:00.000Z' })
    let refreshed = 0
    mockElectron({
      readNovelStatus: () => Promise.resolve(persisted),
      refreshNovelStatus: () => {
        refreshed += 1
        return Promise.resolve(fresh)
      },
    })

    await useWorkbenchStatusStore.getState().enter('/novels/stars')

    // 进入即秒显落盘快照 + 后台重算一次，落到最新快照。
    expect(refreshed).toBe(1)
    expect(useWorkbenchStatusStore.getState().phase).toBe('loaded')
    expect(useWorkbenchStatusStore.getState().snapshot).toEqual(fresh)
  })

  test('enter auto-refreshes even when no snapshot is persisted yet (first-time generation)', async () => {
    const generated = snapshotFixture({ generatedAt: '2026-06-17T03:00:00.000Z' })
    let refreshed = 0
    mockElectron({
      readNovelStatus: () => Promise.resolve(null),
      refreshNovelStatus: () => {
        refreshed += 1
        return Promise.resolve(generated)
      },
    })

    await useWorkbenchStatusStore.getState().enter('/novels/stars')

    // 从未生成快照的新项目也无条件后台 refresh：首进即自动生成，不用手点（核心 AC：每次进入都刷新）。
    expect(refreshed).toBe(1)
    expect(useWorkbenchStatusStore.getState().phase).toBe('loaded')
    expect(useWorkbenchStatusStore.getState().snapshot).toEqual(generated)
  })

  test('enter re-entry reuses the shown snapshot without re-hydrating, then background-refreshes', async () => {
    const shown = snapshotFixture()
    const fresh = snapshotFixture({ generatedAt: '2026-06-17T02:00:00.000Z' })
    useWorkbenchStatusStore.setState({ projectPath: '/novels/stars', phase: 'loaded', snapshot: shown })
    let hydrated = 0
    let refreshed = 0
    mockElectron({
      readNovelStatus: () => {
        hydrated += 1
        return Promise.resolve(shown)
      },
      refreshNovelStatus: () => {
        refreshed += 1
        return Promise.resolve(fresh)
      },
    })

    await useWorkbenchStatusStore.getState().enter('/novels/stars')

    // 同项目复入（从别 section 切回）：不重新读盘，直接后台 refresh 原地替换。
    expect(hydrated).toBe(0)
    expect(refreshed).toBe(1)
    expect(useWorkbenchStatusStore.getState().snapshot).toEqual(fresh)
  })

  test('out-of-order same project: a stale hydrate cannot overwrite a newer refresh', async () => {
    const staleOnDisk = snapshotFixture({ generatedAt: '2026-06-17T04:00:00.000Z' })
    const freshRefresh = snapshotFixture({ generatedAt: '2026-06-17T05:00:00.000Z' })
    let resolveHydrate: (value: NovelStatusSnapshot) => void = () => {}
    const hydratePending = new Promise<NovelStatusSnapshot>((resolve) => {
      resolveHydrate = resolve
    })
    mockElectron({
      readNovelStatus: () => hydratePending, // 慢 hydrate（读旧盘）
      refreshNovelStatus: () => Promise.resolve(freshRefresh), // 快 refresh（重算新值）
    })

    // 先发起 hydrate（seq=1，挂起未返回），再发起并完成 refresh（seq=2，落 fresh）。
    const hydrating = useWorkbenchStatusStore.getState().hydrate('/novels/stars')
    await useWorkbenchStatusStore.getState().refresh('/novels/stars')
    expect(useWorkbenchStatusStore.getState().snapshot).toEqual(freshRefresh)

    // 慢 hydrate 现在才返回旧盘数据：序号已过期，必须被丢弃、不能把 fresh 覆盖回旧快照。
    resolveHydrate(staleOnDisk)
    await hydrating
    expect(useWorkbenchStatusStore.getState().snapshot).toEqual(freshRefresh)
  })
})
