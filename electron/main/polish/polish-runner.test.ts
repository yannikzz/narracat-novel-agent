import { describe, expect, test } from 'bun:test'
import { DEFAULT_PROVIDER_SETTINGS, type AppConfig } from '@shared/types/config'
import type { PolishRecipeFile, PolishRunEvent, PolishSlotId } from '@shared/types/prose-polish'
import {
  createPolishRunManager,
  normalizePolishRunRequest,
  resolvePolishModel,
  type PolishAnthropicLike,
  type PolishRunManagerDeps,
} from './polish-runner.ts'

const ORIGINAL = ['林跃把便条折了两折。', '「社团还招人吗。」他问。', '三天后他回来了。'].join('\n')

const KEY_AT = '2026-09-01T00:00:00.000Z'
/** 已通过连接测试的条目快照——未验证的配置现在会被拒绝真调（CONTEXT.md 模型服务验证）。 */
const VERIFICATION = (provider: 'deepseek' | 'glm') => ({
  verifiedAt: '2026-09-02T00:00:00.000Z',
  apiKeyUpdatedAt: KEY_AT,
  baseUrl: DEFAULT_PROVIDER_SETTINGS[provider].baseUrl,
  wire: 'anthropic' as const,
})

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    providers: DEFAULT_PROVIDER_SETTINGS,
    modelPool: [
      { provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: VERIFICATION('deepseek') },
      { provider: 'glm', modelId: 'glm-4.5-air', verification: VERIFICATION('glm') },
    ],
    primaryModelKey: 'deepseek/deepseek-v4-pro',
    lightModelKey: null,
    apiKeyMetadata: { deepseek: { updatedAt: KEY_AT }, glm: { updatedAt: KEY_AT } },
    ...overrides,
  } as AppConfig
}

function makeRecipeFile(overrides: Partial<Record<PolishSlotId, string>> = {}): PolishRecipeFile {
  return {
    version: 1,
    recipes: [
      { slotId: 'slot-1', prompt: overrides['slot-1'] ?? '写得像人话', modelKey: null, thinking: false, updatedAt: '' },
      { slotId: 'slot-2', prompt: overrides['slot-2'] ?? '', modelKey: null, thinking: false, updatedAt: '' },
      { slotId: 'slot-3', prompt: overrides['slot-3'] ?? '', modelKey: null, thinking: false, updatedAt: '' },
    ],
    lastRunSlotIds: [],
  }
}

interface FakeClientOptions {
  /** 每槽产出的正文；按调用顺序取，用完取最后一个 */
  outputs: string[]
  failOnCall?: number
  /** 收到 abort 信号时抛 AbortError（模拟中止） */
  hangUntilAbort?: boolean
  stopReason?: string
}

function makeFakeClient(options: FakeClientOptions): {
  client: PolishAnthropicLike
  systemPrompts: string[]
  bodies: Array<Record<string, unknown>>
} {
  const systemPrompts: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  let call = 0

  const client: PolishAnthropicLike = {
    messages: {
      stream(body, streamOptions) {
        const index = call
        call += 1
        systemPrompts.push(body.system)
        bodies.push(body as unknown as Record<string, unknown>)
        const output = options.outputs[index] ?? options.outputs[options.outputs.length - 1] ?? ''

        async function* iterate(): AsyncGenerator<unknown> {
          if (options.failOnCall === index) throw new Error('余额不足')
          if (options.hangUntilAbort) {
            await new Promise<void>((resolve, reject) => {
              const signal = streamOptions?.signal
              if (!signal) {
                resolve()
                return
              }
              signal.addEventListener('abort', () => {
                const error = new Error('aborted')
                error.name = 'AbortError'
                reject(error)
              })
            })
          }
          for (const chunk of output.split('\n')) {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: `${chunk}\n` } }
          }
        }

        const generator = iterate()
        return {
          [Symbol.asyncIterator]: () => generator,
          finalMessage: async () => ({
            stop_reason: options.stopReason ?? 'end_turn',
            usage: { input_tokens: 100, output_tokens: 200 },
          }),
        }
      },
    },
  }

  return { client, systemPrompts, bodies }
}

function makeDeps(
  overrides: Partial<PolishRunManagerDeps> = {},
  clientOptions: FakeClientOptions = { outputs: [ORIGINAL] },
): {
  deps: PolishRunManagerDeps
  events: PolishRunEvent[]
  systemPrompts: string[]
  bodies: Array<Record<string, unknown>>
} {
  const events: PolishRunEvent[] = []
  const { client, systemPrompts, bodies } = makeFakeClient(clientOptions)

  const deps: PolishRunManagerDeps = {
    readConfig: async () => makeConfig(),
    getApiKey: async () => 'sk-test',
    sendEvent: (event) => events.push(event),
    readRecipes: async () => makeRecipeFile(),
    recordRunSlots: async () => undefined,
    readOriginalText: async () => ORIGINAL,
    collectAnchorNames: async () => ['林跃', '苏晚'],
    createAnthropicClient: () => client,
    createRunId: () => 'run-1',
    ...overrides,
  }

  return { deps, events, systemPrompts, bodies }
}

async function waitForFinished(events: PolishRunEvent[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (events.some((event) => event.type === 'finished')) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('润色没有收尾')
}

describe('normalizePolishRunRequest', () => {
  test('去重非法槽位', () => {
    const request = normalizePolishRunRequest({
      projectPath: '/p',
      chapter: 3,
      slotIds: ['slot-1', 'slot-1', 'slot-9'],
    })
    expect(request.slotIds).toEqual(['slot-1'])
  })

  test('一个合法槽都没有时报错', () => {
    expect(() => normalizePolishRunRequest({ projectPath: '/p', chapter: 3, slotIds: ['slot-9'] })).toThrow(
      '至少要选一套润色方案。',
    )
  })

  test('章号非法报错', () => {
    expect(() => normalizePolishRunRequest({ projectPath: '/p', chapter: 0, slotIds: ['slot-1'] })).toThrow(
      '章号参数非法。',
    )
  })
})

describe('resolvePolishModel', () => {
  const recipe = { slotId: 'slot-1' as const, prompt: 'x', modelKey: null, thinking: false, updatedAt: '' }

  test('槽位未指定模型时用主力槽', () => {
    expect(resolvePolishModel(makeConfig(), recipe).modelId).toBe('deepseek-v4-pro')
  })

  test('槽位指定的模型优先', () => {
    expect(resolvePolishModel(makeConfig(), { ...recipe, modelKey: 'glm/glm-4.5-air' }).modelId).toBe('glm-4.5-air')
  })

  test('指定的条目已被移出池 → 回落主力，不让一次配置漂移把润色堵死', () => {
    expect(resolvePolishModel(makeConfig(), { ...recipe, modelKey: 'glm/已删除' }).modelId).toBe('deepseek-v4-pro')
  })

  test('openai wire 明确拒绝，不静默换渠道', () => {
    const config = makeConfig({
      providers: {
        ...DEFAULT_PROVIDER_SETTINGS,
        custom: { baseUrl: 'https://example.com/v1', wire: 'openai' },
      },
      modelPool: [
        {
          provider: 'custom',
          modelId: 'gpt-x',
          verification: {
            verifiedAt: '2026-09-02T00:00:00.000Z',
            apiKeyUpdatedAt: KEY_AT,
            baseUrl: 'https://example.com/v1',
            wire: 'openai',
          },
        },
      ],
      apiKeyMetadata: { custom: { updatedAt: KEY_AT } },
      primaryModelKey: 'custom/gpt-x',
    })
    expect(() => resolvePolishModel(config, recipe)).toThrow('OpenAI 兼容协议')
  })

  test('未通过连接测试的模型拒绝真调——槽位绕过了快捷切换器的验证门', () => {
    const config = makeConfig({
      modelPool: [{ provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null }],
      apiKeyMetadata: {},
    })
    expect(() => resolvePolishModel(config, recipe)).toThrow('还没通过连接测试')
  })

  test('模型池为空时报错', () => {
    const config = makeConfig({ modelPool: [], primaryModelKey: null })
    expect(() => resolvePolishModel(config, recipe)).toThrow('还没有可用的模型')
  })
})

describe('start（试验模式）', () => {
  test('流式增量与完成事件按槽发出，附带用量', async () => {
    const { deps, events } = makeDeps()
    const manager = createPolishRunManager(deps)

    const { runId, versions } = await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })
    expect(runId).toBe('run-1')
    expect(versions).toEqual([{ slotId: 'slot-1', status: 'pending', text: '' }])

    await waitForFinished(events)
    expect(events[0]).toMatchObject({ type: 'started', chapter: 3, slotIds: ['slot-1'] })
    expect(events.filter((event) => event.type === 'delta').length).toBeGreaterThan(0)

    const done = events.find((event) => event.type === 'version-done')
    expect(done).toMatchObject({ slotId: 'slot-1', usage: { inputTokens: 100, outputTokens: 200 } })
  })

  test('空槽被跳过——只跑写了内容的方案', async () => {
    const { deps, events } = makeDeps()
    const manager = createPolishRunManager(deps)

    const { versions } = await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1', 'slot-2'] })
    expect(versions.map((version) => version.slotId)).toEqual(['slot-1'])
    await waitForFinished(events)
  })

  test('选中的槽全为空时直接报错', async () => {
    const { deps } = makeDeps({ readRecipes: async () => makeRecipeFile({ 'slot-1': '' }) })
    const manager = createPolishRunManager(deps)
    await expect(manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })).rejects.toThrow(
      '还没有写内容',
    )
  })

  test('章节没有正文时直接报错，不发任何事件', async () => {
    const { deps, events } = makeDeps({ readOriginalText: async () => null })
    const manager = createPolishRunManager(deps)
    await expect(manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })).rejects.toThrow(
      '还没有正文',
    )
    expect(events).toEqual([])
  })

  test('喂给模型的锚只含本章出现过的专名', async () => {
    const { deps, events, systemPrompts } = makeDeps()
    const manager = createPolishRunManager(deps)
    await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })
    await waitForFinished(events)

    expect(systemPrompts[0]).toContain('林跃')
    expect(systemPrompts[0]).not.toContain('苏晚')
    expect(systemPrompts[0]).toContain('三天')
  })

  test('必须显式关掉扩展思考——thinking 与正文共用 max_tokens，开着会把整章预算烧光', async () => {
    const { deps, events, bodies } = makeDeps()
    const manager = createPolishRunManager(deps)
    await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })
    await waitForFinished(events)

    expect(bodies[0]?.thinking).toEqual({ type: 'disabled' })
  })

  test('推理模式：思考预算从 max_tokens 里切，故总额同步抬高，正文额度不变', async () => {
    const { deps, events, bodies } = makeDeps({
      readRecipes: async () => {
        const file = makeRecipeFile()
        file.recipes[0] = { ...file.recipes[0], thinking: true }
        return file
      },
    })
    const manager = createPolishRunManager(deps)
    await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })
    await waitForFinished(events)

    expect(bodies[0]?.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 })
    expect(bodies[0]?.max_tokens).toBe(24000)
  })

  test('推理模式撞上限时说清是思考烧光了，不误报成「章太长」', async () => {
    const { deps, events } = makeDeps(
      {
        readRecipes: async () => {
          const file = makeRecipeFile()
          file.recipes[0] = { ...file.recipes[0], thinking: true }
          return file
        },
      },
      { outputs: [ORIGINAL], stopReason: 'max_tokens' },
    )
    const manager = createPolishRunManager(deps)
    await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })
    await waitForFinished(events)

    const failed = events.find((event) => event.type === 'version-failed')
    expect(failed && 'message' in failed ? failed.message : '').toContain('推理模式')
  })

  test('产出被 max_tokens 截断时报错，不把半章交给作者采用', async () => {
    const { deps, events } = makeDeps({}, { outputs: [ORIGINAL], stopReason: 'max_tokens' })
    const manager = createPolishRunManager(deps)
    await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })
    await waitForFinished(events)

    const failed = events.find((event) => event.type === 'version-failed')
    expect(failed && 'message' in failed ? failed.message : '').toContain('没写完')
    expect(events.some((event) => event.type === 'version-done')).toBe(false)
  })

  test('一版挂掉不牵连其余版本', async () => {
    const { deps, events } = makeDeps(
      { readRecipes: async () => makeRecipeFile({ 'slot-2': '另一套' }) },
      { outputs: [ORIGINAL], failOnCall: 0 },
    )
    const manager = createPolishRunManager(deps)
    await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1', 'slot-2'] })
    await waitForFinished(events)

    expect(events.find((event) => event.type === 'version-failed')).toMatchObject({
      slotId: 'slot-1',
      message: '余额不足',
    })
    expect(events.find((event) => event.type === 'version-done')).toMatchObject({ slotId: 'slot-2' })
  })

  test('护栏结果随完成事件返回：改了数字判漂移', async () => {
    const drifted = ORIGINAL.replace('三天后', '五天后')
    const { deps, events } = makeDeps({}, { outputs: [drifted] })
    const manager = createPolishRunManager(deps)
    await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })
    await waitForFinished(events)

    const done = events.find((event) => event.type === 'version-done')
    expect(done && 'drift' in done ? done.drift.drifted : false).toBe(true)
    expect(done && 'drift' in done ? done.drift.signals : []).toEqual(['numbers'])
  })

  test('纯文字改写不判漂移', async () => {
    const clean = ['林跃把便条对折了一下。', '「社团……还招人吗？」他问。', '三天后他回来了。'].join('\n')
    const { deps, events } = makeDeps({}, { outputs: [clean] })
    const manager = createPolishRunManager(deps)
    await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })
    await waitForFinished(events)

    const done = events.find((event) => event.type === 'version-done')
    expect(done && 'drift' in done ? done.drift.drifted : true).toBe(false)
  })

  test('中止发 aborted 而不是 failed——作者主动早退不是错误', async () => {
    const { deps, events } = makeDeps({}, { outputs: [ORIGINAL], hangUntilAbort: true })
    const manager = createPolishRunManager(deps)
    const { runId } = await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })

    expect(manager.cancelVersion(runId, 'slot-1')).toEqual({ cancelled: true })
    await waitForFinished(events)

    expect(events.some((event) => event.type === 'version-aborted')).toBe(true)
    expect(events.some((event) => event.type === 'version-failed')).toBe(false)
  })

  test('超时报「没跑成」并说清原因，不栽给作者「已中止」', async () => {
    const { deps, events } = makeDeps(
      { timeoutMs: 20 },
      { outputs: [ORIGINAL], hangUntilAbort: true },
    )
    const manager = createPolishRunManager(deps)
    await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })
    await waitForFinished(events)

    const failed = events.find((event) => event.type === 'version-failed')
    expect(failed).toMatchObject({ slotId: 'slot-1' })
    expect(failed && 'message' in failed ? failed.message : '').toContain('6 分钟')
    // 作者没按中止，就不能显示成他中止的
    expect(events.some((event) => event.type === 'version-aborted')).toBe(false)
  })

  test('作者手动中止仍报 aborted，不与超时混淆', async () => {
    const { deps, events } = makeDeps({}, { outputs: [ORIGINAL], hangUntilAbort: true })
    const manager = createPolishRunManager(deps)
    const { runId } = await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })
    manager.cancelVersion(runId, 'slot-1')
    await waitForFinished(events)

    expect(events.some((event) => event.type === 'version-aborted')).toBe(true)
    expect(events.some((event) => event.type === 'version-failed')).toBe(false)
  })

  test('重复中止同一版返回 false', async () => {
    const { deps, events } = makeDeps({}, { outputs: [ORIGINAL], hangUntilAbort: true })
    const manager = createPolishRunManager(deps)
    const { runId } = await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1'] })

    manager.cancelVersion(runId, 'slot-1')
    expect(manager.cancelVersion(runId, 'slot-1')).toEqual({ cancelled: false })
    await waitForFinished(events)
  })

  test('记下这轮跑的组合供下次默认勾选', async () => {
    const recorded: PolishSlotId[][] = []
    const { deps, events } = makeDeps({
      readRecipes: async () => makeRecipeFile({ 'slot-3': '第三套' }),
      recordRunSlots: async (slotIds) => {
        recorded.push(slotIds)
      },
    })
    const manager = createPolishRunManager(deps)
    await manager.start({ projectPath: '/p', chapter: 3, slotIds: ['slot-1', 'slot-3'] })
    await waitForFinished(events)

    expect(recorded).toEqual([['slot-1', 'slot-3']])
  })
})

describe('polishChapterOnce（常驻模式）', () => {
  test('返回正文与护栏结果，且一个事件都不发——没有观众', async () => {
    const { deps, events } = makeDeps()
    const manager = createPolishRunManager(deps)

    const result = await manager.polishChapterOnce({ projectPath: '/p', chapter: 3, slotId: 'slot-1' })
    expect(result.text).toBe(ORIGINAL)
    // 把「送去润色的那一份原稿」带出去：常驻的乐观锁必须拿它当基线
    expect(result.originalText).toBe(ORIGINAL)
    expect(result.drift.drifted).toBe(false)
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 200 })
    expect(events).toEqual([])
  })

  test('常驻槽为空时报错，由调用方按「跳过并告知」处理', async () => {
    const { deps } = makeDeps({ readRecipes: async () => makeRecipeFile({ 'slot-1': '' }) })
    const manager = createPolishRunManager(deps)
    await expect(manager.polishChapterOnce({ projectPath: '/p', chapter: 3, slotId: 'slot-1' })).rejects.toThrow()
  })
})
