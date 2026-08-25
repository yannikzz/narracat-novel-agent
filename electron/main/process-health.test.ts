import { describe, expect, test } from 'bun:test'
import type { BrowserWindow } from 'electron'
import {
  attachAppProcessHealthWatcher,
  attachWindowProcessHealthWatchers,
  createProcessHealthStore,
  CRASH_PROMPT_COOLDOWN_MS,
  type ChildProcessGoneDetails,
} from './process-health.ts'

function createMemoryStore() {
  let content: string | null = null
  const store = createProcessHealthStore({
    userDataPath: '/tmp/narracat-test',
    appVersion: '0.2.65',
    now: () => new Date('2026-08-25T10:30:00.000Z'),
    readFileImpl: (async () => {
      if (content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return content
    }) as never,
    writeFileImpl: async (_path, next) => {
      content = next
    },
  })
  return store
}

/** 最小 BrowserWindow 替身：只实现被监听的三个事件与 reload / isDestroyed。 */
function createFakeWindow() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const add = (event: string, listener: (...args: unknown[]) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener])
  }
  const remove = (event: string, listener: (...args: unknown[]) => void) => {
    listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener))
  }

  let reloadCount = 0
  const win = {
    webContents: { on: add, off: remove },
    on: add,
    off: remove,
    isDestroyed: () => false,
    reload: () => {
      reloadCount += 1
    },
  }

  return {
    win: win as unknown as BrowserWindow,
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
    reloadCount: () => reloadCount,
  }
}

describe('createProcessHealthStore', () => {
  test('记录带上时间戳与客户端版本——作者未必说得清当时用的哪版', async () => {
    const store = createMemoryStore()
    await store.record({ kind: 'renderer-gone', reason: 'crashed', exitCode: 133 })

    const { events } = await store.read()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'renderer-gone',
      reason: 'crashed',
      exitCode: 133,
      at: '2026-08-25T10:30:00.000Z',
      appVersion: '0.2.65',
    })
  })

  test('记录文件不存在时读出空记录，不抛错', async () => {
    const store = createMemoryStore()
    expect(await store.read()).toMatchObject({ events: [] })
  })

  test('落盘失败不把 App 拖垮——取证跑在「已经出事了」的路径上', async () => {
    const store = createProcessHealthStore({
      userDataPath: '/tmp/narracat-test',
      appVersion: '0.2.65',
      readFileImpl: (async () => '[]') as never,
      writeFileImpl: async () => {
        throw new Error('磁盘满了')
      },
    })

    // 不 reject 即为通过
    await store.record({ kind: 'renderer-gone', reason: 'crashed', exitCode: 1 })
  })
})

describe('attachWindowProcessHealthWatchers', () => {
  test('clean-exit 不记录也不提示——正常关窗口就会触发它', async () => {
    const store = createMemoryStore()
    const fake = createFakeWindow()
    let prompts = 0

    attachWindowProcessHealthWatchers(fake.win, {
      store,
      promptReload: async () => {
        prompts += 1
        return false
      },
    })
    fake.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    await Promise.resolve()

    expect(prompts).toBe(0)
    expect((await store.read()).events).toHaveLength(0)
  })

  test('崩溃时留痕并询问作者，选「重新加载」才 reload', async () => {
    const store = createMemoryStore()
    const fake = createFakeWindow()

    attachWindowProcessHealthWatchers(fake.win, { store, promptReload: async () => true })
    fake.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((await store.read()).events[0]).toMatchObject({ kind: 'renderer-gone', reason: 'crashed' })
    expect(fake.reloadCount()).toBe(1)
  })

  test('作者选「稍后」时不 reload', async () => {
    const store = createMemoryStore()
    const fake = createFakeWindow()

    attachWindowProcessHealthWatchers(fake.win, { store, promptReload: async () => false })
    fake.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fake.reloadCount()).toBe(0)
  })

  test('崩溃循环时冷却期内只提示一次，但每次都留痕', async () => {
    const store = createMemoryStore()
    const fake = createFakeWindow()
    let prompts = 0
    let clock = 0

    attachWindowProcessHealthWatchers(fake.win, {
      store,
      now: () => clock,
      promptReload: async () => {
        prompts += 1
        return false
      },
    })

    fake.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    clock = CRASH_PROMPT_COOLDOWN_MS - 1
    fake.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(prompts).toBe(1)
    // 提示被抑制不代表事件被丢弃——取证要完整，否则崩溃循环反而看不出来
    expect((await store.read()).events).toHaveLength(2)

    clock = CRASH_PROMPT_COOLDOWN_MS + 1
    fake.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(prompts).toBe(2)
  })

  test('unresponsive 只在配对到 responsive 后落一条带时长的记录，且不弹框', async () => {
    const store = createMemoryStore()
    const fake = createFakeWindow()
    let prompts = 0
    let clock = 1_000

    attachWindowProcessHealthWatchers(fake.win, {
      store,
      now: () => clock,
      promptReload: async () => {
        prompts += 1
        return false
      },
    })

    fake.emit('unresponsive')
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 还没恢复：不该有记录，更不该打断作者
    expect((await store.read()).events).toHaveLength(0)
    expect(prompts).toBe(0)

    clock = 9_400
    fake.emit('responsive')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((await store.read()).events[0]).toMatchObject({
      kind: 'main-thread-blocked',
      blockedMs: 8_400,
    })
    expect(prompts).toBe(0)
  })

  test('没有配对的 responsive 不产生记录', async () => {
    const store = createMemoryStore()
    const fake = createFakeWindow()

    attachWindowProcessHealthWatchers(fake.win, { store, promptReload: async () => false })
    fake.emit('responsive')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((await store.read()).events).toHaveLength(0)
  })

  test('返回的解绑函数摘干净三个监听', () => {
    const store = createMemoryStore()
    const fake = createFakeWindow()

    const detach = attachWindowProcessHealthWatchers(fake.win, { store, promptReload: async () => false })
    expect(fake.listenerCount('render-process-gone')).toBe(1)
    expect(fake.listenerCount('unresponsive')).toBe(1)
    expect(fake.listenerCount('responsive')).toBe(1)

    detach()
    expect(fake.listenerCount('render-process-gone')).toBe(0)
    expect(fake.listenerCount('unresponsive')).toBe(0)
    expect(fake.listenerCount('responsive')).toBe(0)
  })
})

describe('attachAppProcessHealthWatcher', () => {
  test('记录 utility 进程崩溃——NovelMemory 就跑在 utilityProcess 上', async () => {
    const store = createMemoryStore()
    let listener: ((event: unknown, details: ChildProcessGoneDetails) => void) | null = null

    attachAppProcessHealthWatcher({
      store,
      onChildGone: (fn) => {
        listener = fn
      },
    })
    listener?.({}, {
      type: 'Utility',
      reason: 'crashed',
      exitCode: 11,
      name: 'Node Utility Process',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((await store.read()).events[0]).toMatchObject({
      kind: 'child-gone',
      processType: 'Utility',
      processName: 'Node Utility Process',
      reason: 'crashed',
      exitCode: 11,
    })
  })

  test('子进程 clean-exit 同样不记录', async () => {
    const store = createMemoryStore()
    let listener: ((event: unknown, details: ChildProcessGoneDetails) => void) | null = null

    attachAppProcessHealthWatcher({ store, onChildGone: (fn) => { listener = fn } })
    listener?.({}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((await store.read()).events).toHaveLength(0)
  })

  test('没有 name 时退化到 serviceName', async () => {
    const store = createMemoryStore()
    let listener: ((event: unknown, details: ChildProcessGoneDetails) => void) | null = null

    attachAppProcessHealthWatcher({ store, onChildGone: (fn) => { listener = fn } })
    listener?.({}, { type: 'Utility', reason: 'oom', exitCode: 9, serviceName: 'network.mojom.NetworkService' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((await store.read()).events[0]).toMatchObject({
      processName: 'network.mojom.NetworkService',
    })
  })
})
