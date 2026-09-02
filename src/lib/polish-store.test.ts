import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { PolishDrift, PolishRunEvent } from '@shared/types/prose-polish'

// mock.module 是进程级的：展开真实模块、只覆写 store 用到的两个 IPC，别把其余导出剥掉
// （同进程其它测试文件也 import 了 ./ipc）。
const actualIpc = await import('./ipc')
const ipcCalls: string[] = []
const startPolishRunMock = mock(async (input: { slotIds: Array<'slot-1' | 'slot-2' | 'slot-3'> }) => {
  ipcCalls.push('start')
  return {
    runId: 'r2',
    versions: input.slotIds.map((slotId) => ({ slotId, status: 'pending' as const, text: '' })),
  }
})
const cancelPolishRunMock = mock(async (input: { runId: string; slotId?: string }) => {
  ipcCalls.push(`cancel:${input.runId}`)
  return { cancelled: true }
})
mock.module('./ipc', () => ({
  ...actualIpc,
  startPolishRun: startPolishRunMock,
  cancelPolishRun: cancelPolishRunMock,
}))

const { formatPolishElapsed, isAdoptable, isPolishVersionRunning, usePolishRun } = await import('./polish-store')

const CLEAN_DRIFT: PolishDrift = {
  drifted: false,
  signals: [],
  detail: {
    lostNames: [],
    addedNames: [],
    lostNumbers: [],
    addedNumbers: [],
    originalParagraphs: 3,
    polishedParagraphs: 3,
  },
}

function apply(...events: PolishRunEvent[]): void {
  for (const event of events) usePolishRun.getState().applyEvent(event)
}

beforeEach(() => {
  usePolishRun.getState().reset()
})

describe('applyEvent', () => {
  test('started 建立本轮的槽位与顺序', () => {
    apply({ type: 'started', runId: 'r1', chapter: 7, slotIds: ['slot-1', 'slot-3'] })
    const state = usePolishRun.getState()
    expect(state.runId).toBe('r1')
    expect(state.chapter).toBe(7)
    expect(state.order).toEqual(['slot-1', 'slot-3'])
    expect(state.running).toBe(true)
    expect(state.versions['slot-1']?.status).toBe('pending')
  })

  test('delta 累加成流式文本', () => {
    apply(
      { type: 'started', runId: 'r1', chapter: 7, slotIds: ['slot-1'] },
      { type: 'delta', runId: 'r1', slotId: 'slot-1', text: '林跃' },
      { type: 'delta', runId: 'r1', slotId: 'slot-1', text: '推开门。' },
    )
    const version = usePolishRun.getState().versions['slot-1']
    expect(version?.status).toBe('streaming')
    expect(version?.text).toBe('林跃推开门。')
  })

  test('version-done 带回护栏与用量', () => {
    apply(
      { type: 'started', runId: 'r1', chapter: 7, slotIds: ['slot-1'] },
      { type: 'delta', runId: 'r1', slotId: 'slot-1', text: '正文。' },
      {
        type: 'version-done',
        runId: 'r1',
        slotId: 'slot-1',
        drift: CLEAN_DRIFT,
        usage: { inputTokens: 100, outputTokens: 200 },
      },
    )
    const version = usePolishRun.getState().versions['slot-1']
    expect(version?.status).toBe('done')
    expect(version?.drift?.drifted).toBe(false)
    expect(version?.usage).toEqual({ inputTokens: 100, outputTokens: 200 })
    // 文本不被完成事件清掉——它就是要采用的那一版
    expect(version?.text).toBe('正文。')
  })

  test('一版失败不影响其它版', () => {
    apply(
      { type: 'started', runId: 'r1', chapter: 7, slotIds: ['slot-1', 'slot-2'] },
      { type: 'version-failed', runId: 'r1', slotId: 'slot-1', message: '余额不足' },
      { type: 'delta', runId: 'r1', slotId: 'slot-2', text: '正文。' },
    )
    const state = usePolishRun.getState()
    expect(state.versions['slot-1']).toMatchObject({ status: 'failed', error: '余额不足' })
    expect(state.versions['slot-2']?.status).toBe('streaming')
  })

  test('中止标成 aborted 而不是 failed', () => {
    apply(
      { type: 'started', runId: 'r1', chapter: 7, slotIds: ['slot-1'] },
      { type: 'version-aborted', runId: 'r1', slotId: 'slot-1' },
    )
    expect(usePolishRun.getState().versions['slot-1']?.status).toBe('aborted')
  })

  test('finished 收掉运行态', () => {
    apply({ type: 'started', runId: 'r1', chapter: 7, slotIds: ['slot-1'] }, { type: 'finished', runId: 'r1' })
    expect(usePolishRun.getState().running).toBe(false)
  })

  test('旧 run 的迟到事件被丢弃，不污染新一轮', () => {
    apply(
      { type: 'started', runId: 'r2', chapter: 7, slotIds: ['slot-1'] },
      { type: 'delta', runId: 'r1', slotId: 'slot-1', text: '上一轮的残留' },
    )
    expect(usePolishRun.getState().versions['slot-1']?.text).toBe('')
  })

  test('新一轮刚发起、还没收到 started 的窗口里，旧 run 的增量一律丢', () => {
    apply(
      { type: 'started', runId: 'r1', chapter: 7, slotIds: ['slot-1'] },
      { type: 'delta', runId: 'r1', slotId: 'slot-1', text: '第一轮' },
    )
    // 模拟 start() 清空状态之后、主进程发出 started 之前——原来这个窗口 runId 为空，什么都放行。
    usePolishRun.setState({ runId: null, versions: {}, order: ['slot-1'] })
    apply({ type: 'delta', runId: 'r1', slotId: 'slot-1', text: '第一轮还在吐的字' })
    expect(usePolishRun.getState().versions['slot-1']).toBeUndefined()

    apply(
      { type: 'started', runId: 'r2', chapter: 7, slotIds: ['slot-1'] },
      { type: 'delta', runId: 'r2', slotId: 'slot-1', text: '第二轮' },
    )
    expect(usePolishRun.getState().versions['slot-1']?.text).toBe('第二轮')
  })

  test('丢弃之后迟到的 version-aborted 不会把槽写回', () => {
    apply({ type: 'started', runId: 'r1', chapter: 7, slotIds: ['slot-1'] })
    usePolishRun.getState().reset()
    apply({ type: 'version-aborted', runId: 'r1', slotId: 'slot-1' }, { type: 'finished', runId: 'r1' })
    expect(usePolishRun.getState().versions).toEqual({})
  })

  test('常驻收尾事件不受 runId 过滤，任何时候都能叫醒正文页', () => {
    const before = usePolishRun.getState().standingVersion
    apply({ type: 'standing-finished', chapter: 7, status: 'applied' })
    expect(usePolishRun.getState().standingVersion).toBe(before + 1)
    // store 是进程级单例、reset() 刻意不清这个计数：不复原的话，同进程后面挂载正文页的
    // 测试会在首帧就被「常驻收尾」叫醒一次，多触发一次 onChanged。
    usePolishRun.setState({ standingVersion: before })
  })
})

describe('start', () => {
  beforeEach(() => {
    ipcCalls.length = 0
  })

  test('先取消上一轮再发起——不取消的话旧版本会继续跑完、继续烧 token', async () => {
    apply({ type: 'started', runId: 'r1', chapter: 7, slotIds: ['slot-1'] })
    await usePolishRun.getState().start({ projectPath: '/p', chapter: 7, slotIds: ['slot-1'], baselineText: '正文' })
    expect(ipcCalls).toEqual(['cancel:r1', 'start'])
    expect(usePolishRun.getState().runId).toBe('r2')
  })

  test('没有上一轮时不发取消', async () => {
    await usePolishRun.getState().start({ projectPath: '/p', chapter: 7, slotIds: ['slot-1'], baselineText: '正文' })
    expect(ipcCalls).toEqual(['start'])
  })

  test('取消失败不阻断发起', async () => {
    apply({ type: 'started', runId: 'r1', chapter: 7, slotIds: ['slot-1'] })
    cancelPolishRunMock.mockImplementationOnce(async () => {
      throw new Error('主进程没响应')
    })
    await usePolishRun.getState().start({ projectPath: '/p', chapter: 7, slotIds: ['slot-1'], baselineText: '正文' })
    expect(usePolishRun.getState().runId).toBe('r2')
  })
})

describe('isPolishVersionRunning', () => {
  test('等首字与流式中算在跑，其余都不算', () => {
    expect(isPolishVersionRunning({ slotId: 'slot-1', status: 'pending', text: '' })).toBe(true)
    expect(isPolishVersionRunning({ slotId: 'slot-1', status: 'streaming', text: '半' })).toBe(true)
    expect(isPolishVersionRunning({ slotId: 'slot-1', status: 'done', text: '全' })).toBe(false)
    expect(isPolishVersionRunning({ slotId: 'slot-1', status: 'aborted', text: '' })).toBe(false)
    expect(isPolishVersionRunning(undefined)).toBe(false)
  })
})

describe('isAdoptable', () => {
  test('流式中的版本不给采用——想早退只能中止，不能早选', () => {
    expect(isAdoptable({ slotId: 'slot-1', status: 'streaming', text: '写了一半' })).toBe(false)
  })

  test('完成且有正文才可采用', () => {
    expect(isAdoptable({ slotId: 'slot-1', status: 'done', text: '正文。' })).toBe(true)
  })

  test('完成但正文为空不可采用', () => {
    expect(isAdoptable({ slotId: 'slot-1', status: 'done', text: '   ' })).toBe(false)
  })

  test('失败与中止不可采用', () => {
    expect(isAdoptable({ slotId: 'slot-1', status: 'failed', text: '' })).toBe(false)
    expect(isAdoptable({ slotId: 'slot-1', status: 'aborted', text: '半截' })).toBe(false)
  })
})

describe('reset', () => {
  test('只有作者点「丢弃」或采用某版才清空——离开页面不该丢', () => {
    apply(
      { type: 'started', runId: 'r1', chapter: 7, slotIds: ['slot-1'] },
      { type: 'delta', runId: 'r1', slotId: 'slot-1', text: '正文。' },
    )
    usePolishRun.getState().reset()
    const state = usePolishRun.getState()
    expect(state.order).toEqual([])
    expect(state.versions).toEqual({})
    expect(state.runId).toBeNull()
    expect(state.baselineText).toBeNull()
  })
})

describe('formatPolishElapsed', () => {
  test('未开跑时不显示', () => {
    expect(formatPolishElapsed(null, 1_000)).toBe('')
  })

  test('一分钟内按秒', () => {
    expect(formatPolishElapsed(1_000, 33_000)).toBe('已等 32 秒')
  })

  test('超过一分钟按分秒，秒补零', () => {
    expect(formatPolishElapsed(0, 65_000)).toBe('已等 1 分 05 秒')
    expect(formatPolishElapsed(0, 130_000)).toBe('已等 2 分 10 秒')
  })

  test('时钟回拨不显示负数', () => {
    expect(formatPolishElapsed(10_000, 5_000)).toBe('已等 0 秒')
  })
})

describe('事件早于 invoke 返回（真机常态：主进程先发 started 再返回）', () => {
  test('start 的返回值不覆盖已收到的增量', () => {
    apply(
      { type: 'started', runId: 'r1', chapter: 7, slotIds: ['slot-1'] },
      { type: 'delta', runId: 'r1', slotId: 'slot-1', text: '已经到货的字' },
    )
    // 模拟 startPolishRun 的返回值随后落地（版本一律是 pending 空壳）
    usePolishRun.setState((state) => ({
      versions: Object.fromEntries(
        [{ slotId: 'slot-1' as const, status: 'pending' as const, text: '' }].map((version) => [
          version.slotId,
          state.versions[version.slotId] ?? version,
        ]),
      ),
    }))
    expect(usePolishRun.getState().versions['slot-1']?.text).toBe('已经到货的字')
  })
})
