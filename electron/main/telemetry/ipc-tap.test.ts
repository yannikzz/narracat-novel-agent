import { describe, expect, test } from 'bun:test'
import { createTappedHandle } from './ipc-tap.ts'

type Listener = (...args: never[]) => unknown

function harness(resolveModule: (channel: string) => string | null, record = () => {}) {
  const registered = new Map<string, Listener>()
  const handle = createTappedHandle<Listener>({
    handle: (channel, listener) => {
      registered.set(channel, listener)
      return undefined
    },
    resolveModule,
    record,
  })
  return { handle, registered }
}

describe('IPC 埋点壳', () => {
  test('无归属的通道原样注册——绝大多数通道的调用路径与没有埋点时逐字相同', () => {
    const listener = (() => 'ok') as Listener
    const { handle, registered } = harness(() => null)
    handle('config:get', listener)
    expect(registered.get('config:get')).toBe(listener)
  })

  test('有归属的通道：记一次账，参数与返回值原样透传', () => {
    const seen: string[] = []
    const { handle, registered } = harness(
      () => 'outline',
      (module) => seen.push(module),
    )
    handle('novel:submit-master-outline-edit', ((event: string, input: number) => `${event}:${input}`) as Listener)
    const wrapped = registered.get('novel:submit-master-outline-edit')!
    expect((wrapped as (a: string, b: number) => string)('evt', 7)).toBe('evt:7')
    expect(seen).toEqual(['outline'])
  })

  test('业务 handler 抛错时原样抛出（埋点壳不吞异常）', () => {
    const { handle, registered } = harness(() => 'premise')
    handle('novel:create-project', (() => {
      throw new Error('项目已存在')
    }) as Listener)
    expect(() => (registered.get('novel:create-project') as () => unknown)()).toThrow('项目已存在')
  })

  test('记账抛错不连累业务 handler', () => {
    const { handle, registered } = harness(
      () => 'premise',
      () => {
        throw new Error('埋点炸了')
      },
    )
    handle('novel:create-project', (() => 'created') as Listener)
    expect((registered.get('novel:create-project') as () => unknown)()).toBe('created')
  })

  test('异步 handler 的 Promise 原样返回，不被吞成 undefined', async () => {
    const { handle, registered } = harness(() => 'premise')
    handle('novel:create-project', (async () => 'done') as Listener)
    await expect((registered.get('novel:create-project') as () => Promise<string>)()).resolves.toBe('done')
  })

  test('每次调用都记一次——是否去重是 record 那边的事，壳不擅自省略', () => {
    const seen: string[] = []
    const { handle, registered } = harness(
      () => 'outline',
      (module) => seen.push(module),
    )
    handle('novel:submit-master-outline-edit', (() => undefined) as Listener)
    const wrapped = registered.get('novel:submit-master-outline-edit') as () => unknown
    wrapped()
    wrapped()
    expect(seen).toEqual(['outline', 'outline'])
  })
})
