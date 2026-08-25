import { describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAgentRunManager, isProjectMarkdownWrite } from './run-manager'
import { UNSAFE_API_KEY_MESSAGE } from '../../config'
import { createNovelProjectFixture } from '../../novel/test-novel-fixture'
import type { AgentEvent } from '@shared/types/agent'
import type { AppConfig } from '@shared/types/config'
import { POOL_DEFAULT_FIELDS } from '@shared/types/config'
import {
  NARRACAT_NOVEL_MEMORY_MCP_SERVER_NAME,
  NARRACAT_NOVEL_MEMORY_MCP_TOOLS,
} from '../runtime/allowed-tools'
import type { SdkLikeStartRunArgs as RunClaudeAgentQueryArgs } from './test-sdk-like-adapter'
import {
  createSdkLikeTestAdapter,
  resolveDevelopmentHeadlessAgentRuntimeExecutablePath,
} from './test-sdk-like-adapter'
import type { AgentRuntimeAdapter } from '../runtime/types'

/**
 * deps.runtime 测试替身（Task 13，拆旧刀5 后基座换 fixture）：只换 startRun，其余方法
 * （createRunOptions/createSandboxedRunOptions/mapMessage/readSessionId）委给
 * createSdkLikeTestAdapter()——它逐字段复刻已删除的 claude-sdk adapter 中测试实际用到的行为
 * （见 test-sdk-like-adapter.ts 顶部说明）。run-manager 只经 runtime.startRun 拿假消息流，
 * 映射/会话 id 提取走 fixture 的复刻实现，与切换前注入真 createClaudeSdkAdapter() 的行为一致。
 */
function fakeRuntime(startRun: (args: RunClaudeAgentQueryArgs) => AsyncIterable<unknown>): AgentRuntimeAdapter {
  return { ...createSdkLikeTestAdapter(), startRun: startRun as AgentRuntimeAdapter['startRun'] }
}

const fixedNow = () => '2026-04-27T00:00:00.000Z'
const apiKeyUpdatedAt = '2026-04-26T23:50:00.000Z'

const deepseekConfig: AppConfig = {
  ...POOL_DEFAULT_FIELDS,
  // 按条目验证语义（切片①T2）：池条目须携带与 apiKeyMetadata/providers 一致的验证快照，
  // isModelServiceVerified 才判「已验证」。
  modelPool: [
    {
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
      verification: {
        verifiedAt: '2026-04-26T23:55:00.000Z',
        apiKeyUpdatedAt,
        baseUrl: 'https://api.deepseek.com/anthropic',
      },
    },
  ],
  apiKeyMetadata: {
    deepseek: { updatedAt: apiKeyUpdatedAt },
  },
  novelRootDir: '/tmp/novels',
  recentNovelPaths: [],
  systemNotificationsEnabled: true,
}

async function makeReadyProjectForRunManagerTest(): Promise<string> {
  return (await createNovelProjectFixture({ name: 'run-manager', state: 'outlined' })).root
}

async function markChapterOneWriteInterruptedForRunManagerTest(projectPath: string): Promise<void> {
  await writeFile(
    join(projectPath, '.narracat', 'state.yaml'),
    [
      'progress:',
      '  last_completed_chapter: 0',
      '  completed_chapters: []',
      '  in_progress_chapter: 1',
      '  total_chapters_planned: 12',
      'word_count:',
      '  total: 0',
      '  by_chapter: {}',
      'checkpoint:',
      '  last_command: write',
      '  last_step: 5',
      '  timestamp: 2026-05-18T12:00:00.000Z',
      'structure:',
      '  total_volumes: 1',
      '  total_chapters_planned: 12',
      '  chapter_to_volume:',
      '    1: 1',
      '',
    ].join('\n'),
    'utf-8',
  )
  await mkdir(join(projectPath, 'manuscript', 'vol-01'), { recursive: true })
  await writeFile(join(projectPath, 'manuscript', 'vol-01', 'ch-001.md'), '# 第1章\n\n中断前正文\n', 'utf-8')
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolveDeferred!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve
  })

  return { promise, resolve: resolveDeferred }
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 1000): Promise<T> {
  let timeoutId!: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  const result = await Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId))
  // SDK generator 的 finally 先 resolve 测试信号，run-manager 随后才完成 iterator.return
  // 并发布终态；让测试观察真实 settle 后的状态，而不是生成器内部的半完成瞬间。
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  return result
}

describe('createAgentRunManager', () => {
  test('blocks Agent runs before SDK startup when the model service is not verified', async () => {
    const events: AgentEvent[] = []
    let sdkCalled = false
    const manager = createAgentRunManager({
      readConfig: async () => ({
        ...deepseekConfig,
        modelPool: [{ provider: 'deepseek', modelId: 'deepseek-v4-pro', verification: null }],
      }),
      getApiKey: async () => 'sk-test-key',
      runtime: fakeRuntime(() => {
        sdkCalled = true
        return (async function* (): AsyncIterable<unknown> {})()
      }),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    const result = await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '检查运行环境' })

    expect(result).toEqual({ runId: 'run-1' })
    expect(sdkCalled).toBe(false)
    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.failed'])
    expect(events[1]).toMatchObject({
      type: 'run.failed',
      runId: 'run-1',
      reason: 'model-service-required',
      provider: 'deepseek',
      error: '模型服务尚未验证。请先在设置中完成“测试连接”。',
    })
  })

  test('blocks the run with a clear message when the stored API Key contains non-ASCII characters', async () => {
    const events: AgentEvent[] = []
    let sdkCalled = false
    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      // 模拟用户那把混入中文的 Key（sk美key）——旧版保存时未校验字符集。
      getApiKey: async () => 'sk美key',
      runtime: fakeRuntime(() => {
        sdkCalled = true
        return (async function* (): AsyncIterable<unknown> {})()
      }),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    const result = await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '我要改立项' })

    expect(result).toEqual({ runId: 'run-1' })
    // 绝不能放行到 SDK，否则会在请求头处崩成看不懂的 "API Error: ByteString"。
    expect(sdkCalled).toBe(false)
    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.failed'])
    expect(events[1]).toMatchObject({ type: 'run.failed', runId: 'run-1', error: UNSAFE_API_KEY_MESSAGE })
  })

  test('aborts a run with run.failed when the model stream stays idle past the watchdog threshold', async () => {
    const events: AgentEvent[] = []
    const failedSeen = createDeferred<AgentEvent>()
    // 迭代器进入后永不产出任何消息（模拟模型流 stall：连接半开 / 服务端不发数据也不发结束）。
    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      runtime: fakeRuntime((args) =>
        (async function* (): AsyncIterable<unknown> {
          await new Promise<void>((resolve) => {
            args.options.abortController.signal.addEventListener('abort', () => resolve(), { once: true })
          })
        })()),
      sendEvent: (event) => {
        events.push(event)
        if (event.type === 'run.failed') failedSeen.resolve(event)
      },
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
      idleTimeoutMs: 20,
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '会卡住的请求' })

    const failed = await withTimeout(failedSeen.promise, 'idle watchdog run.failed', 1000)
    expect(failed).toMatchObject({ type: 'run.failed', runId: 'run-1' })
    expect((failed as { error: string }).error).toContain('长时间无响应')
    expect(events.some((event) => event.type === 'run.completed')).toBe(false)
  })

  test('does not trip the watchdog while the stream keeps producing messages within the threshold', async () => {
    const events: AgentEvent[] = []
    const completed = createDeferred<AgentEvent>()
    // 每 10ms 产出一条（远小于 80ms 阈值），累计耗时 ~120ms 超过阈值；若看门狗不按消息重置，
    // 会在 ~90ms（首条 10ms + 阈值 80ms）误判卡死。持续重置则一路写到正常结束。
    async function* steadyQuery(): AsyncIterable<unknown> {
      for (let i = 0; i < 12; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        yield { type: 'system', message: `tick-${i}` }
      }
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
    }
    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      runtime: fakeRuntime(() => steadyQuery()),
      sendEvent: (event) => {
        events.push(event)
        if (event.type === 'run.completed') completed.resolve(event)
      },
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
      idleTimeoutMs: 80,
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '稳定流' })

    await withTimeout(completed.promise, 'steady stream completion', 2000)
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
  })

  test('frees the thread after an idle-timeout failure so a follow-up run is not blocked', async () => {
    const events: AgentEvent[] = []
    const firstFailed = createDeferred<void>()
    let call = 0
    let runCounter = 0
    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      runtime: fakeRuntime((args) => {
        call += 1
        const isFirst = call === 1
        return (async function* (): AsyncIterable<unknown> {
          if (isFirst) {
            await new Promise<void>((resolve) => {
              args.options.abortController.signal.addEventListener('abort', () => resolve(), { once: true })
            })
          }
          yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
        })()
      }),
      sendEvent: (event) => {
        events.push(event)
        if (event.type === 'run.failed' && event.runId === 'run-1') firstFailed.resolve(undefined)
      },
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => `run-${(runCounter += 1)}`,
      idleTimeoutMs: 20,
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '第一轮（会卡死）' })
    await withTimeout(firstFailed.promise, 'first run idle failure', 1000)

    // 卡死 run 已自动收尾、线程释放：第二轮不该被「已有任务运行中」挡住。
    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '第二轮' })

    expect(events.some((event) => event.type === 'run.started' && event.runId === 'run-2')).toBe(true)
    expect(
      events.some(
        (event) => event.type === 'run.failed' && (event as { error?: string }).error?.includes('已有任务运行中'),
      ),
    ).toBe(false)
  })

  test('emits run.failed and frees the thread when runSdkQuery throws synchronously', async () => {
    const events: AgentEvent[] = []
    const failedSeen = createDeferred<AgentEvent>()
    let runCounter = 0
    let throwOnce = true
    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      runtime: fakeRuntime(() => {
        if (throwOnce) {
          throwOnce = false
          throw new Error('sync construction boom')
        }
        return (async function* (): AsyncIterable<unknown> {
          yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
        })()
      }),
      sendEvent: (event) => {
        events.push(event)
        if (event.type === 'run.failed' && event.runId === 'run-1') failedSeen.resolve(event)
      },
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => `run-${(runCounter += 1)}`,
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '同步抛错' })

    // 同步构造失败必须被捕获并以 run.failed 收尾（否则 void streamSdkRun 吞掉异常、线程永久占住）。
    const failed = await withTimeout(failedSeen.promise, 'sync-throw run.failed', 1000)
    expect((failed as { error: string }).error).toContain('运行失败')

    // 线程已释放：第二轮不被「已有任务运行中」挡。
    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '第二轮' })
    expect(events.some((event) => event.type === 'run.started' && event.runId === 'run-2')).toBe(true)
  })

  test('does not trip the watchdog while waiting for a user answer (pending question is not a stall)', async () => {
    const events: AgentEvent[] = []
    const questionReady = createDeferred<void>()
    const completed = createDeferred<AgentEvent>()

    async function* questioningQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      const canUseTool = args.options.canUseTool
      if (!canUseTool) throw new Error('expected canUseTool bridge')
      const permission = canUseTool(
        'AskUserQuestion',
        {
          questions: [
            {
              header: '概念',
              question: '关于什么？',
              options: [
                { label: 'A', description: 'a' },
                { label: 'B', description: 'b' },
              ],
            },
          ],
        },
        { signal: new AbortController().signal, toolUseID: 'q-1', title: 'Answer?' },
      )
      questionReady.resolve(undefined)
      await permission // 等用户作答——期间 iterator 一直 pending
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      runtime: fakeRuntime(questioningQuery),
      sendEvent: (event) => {
        events.push(event)
        if (event.type === 'run.completed') completed.resolve(event)
      },
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
      idleTimeoutMs: 50,
    })

    await manager.startRun({ threadId: 'thread-1', command: 'setup', prompt: '开始设定引导', projectPath: '/novels/stars' })
    await withTimeout(questionReady.promise, 'question requested')

    // 远超空闲阈值（50ms）仍未作答——等用户输入不应被误判为模型流卡死。
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.some((event) => event.type === 'run.cancelled')).toBe(false)

    // 作答后 run 正常完成（pending question 未被误 reject）。
    expect(await manager.answerQuestion({ requestId: 'q-1', answers: { '关于什么？': 'A' } })).toEqual({
      accepted: true,
    })
    await withTimeout(completed.promise, 'completion after answer')
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
  })

  test('fails a run after start when the active provider has no API key', async () => {
    const events: AgentEvent[] = []
    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => null,
      sendEvent: (event) => events.push(event),
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    const result = await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '检查运行环境' })

    expect(result).toEqual({ runId: 'run-1' })
    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.failed'])
    expect(events[0]).toEqual({
      type: 'run.started',
      runId: 'run-1',
      threadId: 'thread-1',
      command: 'freeform',
      prompt: '检查运行环境',
      createdAt: fixedNow(),
    })
    expect(events[1]).toMatchObject({
      type: 'run.failed',
      runId: 'run-1',
    })
  })

  test('fails command runs before SDK startup when the NarraCat Agent Core adapter manifest is missing', async () => {
    const events: AgentEvent[] = []
    let sdkCalled = false
    let checkedAgentCorePath = ''

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: (agentCorePath) => {
        checkedAgentCorePath = agentCorePath
        return false
      },
      runtime: fakeRuntime((_args) => {
        sdkCalled = true
        return (async function* (): AsyncIterable<unknown> {})()
      }),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    const result = await manager.startRun({ threadId: 'thread-1', command: 'write-next', prompt: '继续写下一章' })
    await Promise.resolve()

    expect(result).toEqual({ runId: 'run-1' })
    expect(sdkCalled).toBe(false)
    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.failed'])
    const failedEvent = events[1]
    if (failedEvent?.type !== 'run.failed') throw new Error('expected failed event')
    expect(failedEvent.runId).toBe('run-1')
    expect(failedEvent.error).toContain('NarraCat Agent Core')
    expect(failedEvent.error).toContain(checkedAgentCorePath)
  })

  test('rejects concurrent runs on the same thread before starting a second SDK stream', async () => {
    const events: AgentEvent[] = []
    let runIdCounter = 0
    let sdkCallCount = 0
    const firstStreamStarted = createDeferred<void>()
    const releaseFirstStream = createDeferred<void>()
    const firstStreamCompleted = createDeferred<void>()

    async function* runSdkQuery(): AsyncIterable<unknown> {
      try {
        sdkCallCount += 1
        firstStreamStarted.resolve(undefined)
        await releaseFirstStream.promise
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
      } finally {
        firstStreamCompleted.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => `run-${++runIdCounter}`,
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '第一轮' })
    await withTimeout(firstStreamStarted.promise, 'first SDK stream start')

    await expect(
      manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '第二轮' }),
    ).rejects.toThrow('当前 Agent 线程已有任务运行中')
    expect(sdkCallCount).toBe(1)
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'run.started', runId: 'run-2' }))
    expect(events).not.toContainEqual(expect.objectContaining({ runId: 'run-2' }))

    releaseFirstStream.resolve(undefined)
    await withTimeout(firstStreamCompleted.promise, 'first SDK stream completion')
  })

  test('requires project context before starting write-next SDK runs', async () => {
    const events: AgentEvent[] = []
    let sdkCalled = false
    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(() => {
        sdkCalled = true
        return (async function* (): AsyncIterable<unknown> {})()
      }),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({ threadId: 'thread-1', command: 'write-next', prompt: '继续写下一章' })

    expect(sdkCalled).toBe(false)
    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.failed'])
    expect(events[1]).toMatchObject({
      type: 'run.failed',
      error: '写下一章需要先打开一个小说项目。',
    })
  })

  test('runs write-next in the active novel project cwd and emits project update after completion', async () => {
    const events: AgentEvent[] = []
    const projectPath = await makeReadyProjectForRunManagerTest()
    let capturedArgs: RunClaudeAgentQueryArgs | undefined
    const streamDone = createDeferred<void>()
    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      capturedArgs = args
      try {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'write-next',
      prompt: '继续写下一章',
      projectPath,
      target: {
        sectionId: 'blueprint',
        tabId: 'chapter-1',
        objectId: 'chapter-1',
      },
    })
    await withTimeout(streamDone.promise, 'write-next SDK stream completion')

    expect(capturedArgs?.prompt).toContain('你正在当前小说项目中执行 NarraCat command：/narracat:write')
    expect(capturedArgs?.prompt).toContain('$ARGUMENTS：1')
    expect(capturedArgs?.prompt).toContain('--- NarraCat command source begin ---')
    expect(capturedArgs?.prompt).toContain('执行 write command。参数：$ARGUMENTS。')
    expect(capturedArgs?.options.cwd).toBe(projectPath)
    expect(capturedArgs?.options.maxTurns).toBe(72)
    expect(capturedArgs?.options.plugins).toBeTruthy()
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'run.running',
      'novel.project.updated',
      'run.completed',
    ])
    expect(events[2]).toMatchObject({
      type: 'novel.project.updated',
      runId: 'run-1',
      projectPath,
      selectedChapter: 1,
      target: {
        sectionId: 'blueprint',
        tabId: 'chapter-1',
        objectId: 'chapter-1',
      },
    })
  })

  test('captures agent-write before SDK startup and completes revision before project refresh and terminal', async () => {
    const projectPath = await makeReadyProjectForRunManagerTest()
    const lifecycle: string[] = []
    const terminalSeen = createDeferred<void>()
    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: () => '执行 write command。参数：$ARGUMENTS。',
      manuscriptRevisionStore: {
        begin: async (input) => {
          lifecycle.push(`begin:${input.source}:${input.chapter}`)
          return { revisionId: 'rev-00000000-0000-4000-8000-000000000001' }
        },
        complete: async (input) => {
          lifecycle.push(`complete:${input.revisionId}`)
          return null
        },
      },
      runtime: fakeRuntime(() =>
        (async function* (): AsyncIterable<unknown> {
          lifecycle.push('sdk')
          yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
        })()),
      sendEvent: (event) => {
        if (event.type === 'novel.project.updated') lifecycle.push('project-updated')
        if (event.type === 'run.completed') {
          lifecycle.push('terminal')
          terminalSeen.resolve()
        }
      },
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-revision-write',
    })

    await manager.startRun({
      threadId: 'thread-revision-write',
      command: 'write-next',
      prompt: '写本章',
      projectPath,
    })
    await withTimeout(terminalSeen.promise, 'agent-write revision completion')

    expect(lifecycle).toEqual([
      'begin:agent-write:1',
      'sdk',
      'complete:rev-00000000-0000-4000-8000-000000000001',
      'project-updated',
      'terminal',
    ])
  })

  test('captures agent-rewrite and still completes revision when the SDK run fails', async () => {
    const projectPath = (await createNovelProjectFixture({ name: 'rewrite-revision', state: 'chaptered' })).root
    const lifecycle: string[] = []
    const terminalSeen = createDeferred<void>()
    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: () => '执行 rewrite command。参数：$ARGUMENTS。',
      manuscriptRevisionStore: {
        begin: async (input) => {
          lifecycle.push(`begin:${input.source}:${input.chapter}`)
          return { revisionId: 'rev-00000000-0000-4000-8000-000000000002' }
        },
        complete: async () => {
          lifecycle.push('complete')
          return null
        },
      },
      runtime: fakeRuntime(() =>
        (async function* (): AsyncIterable<unknown> {
          yield { type: 'result', subtype: 'error_during_execution', errors: ['rewrite failed'] }
        })()),
      sendEvent: (event) => {
        if (event.type === 'novel.project.updated') lifecycle.push('project-updated')
        if (event.type === 'run.failed') {
          lifecycle.push('terminal')
          terminalSeen.resolve()
        }
      },
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-revision-rewrite',
    })

    await manager.startRun({
      threadId: 'thread-revision-rewrite',
      command: 'rewrite',
      prompt: '1',
      projectPath,
      selectedChapter: 1,
    })
    await withTimeout(terminalSeen.promise, 'agent-rewrite revision failure completion')

    expect(lifecycle).toEqual(['begin:agent-rewrite:1', 'complete', 'project-updated', 'terminal'])
  })

  test('runs recover-write through the write command source and refreshes the recoverable chapter', async () => {
    const events: AgentEvent[] = []
    const projectPath = await makeReadyProjectForRunManagerTest()
    await markChapterOneWriteInterruptedForRunManagerTest(projectPath)
    let capturedArgs: RunClaudeAgentQueryArgs | undefined
    const streamDone = createDeferred<void>()
    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      capturedArgs = args
      try {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'recover-write',
      prompt: '继续完成本章',
      projectPath,
      target: {
        sectionId: 'blueprint',
        tabId: 'chapter-1',
        objectId: 'chapter-1',
      },
    })
    await withTimeout(streamDone.promise, 'recover-write SDK stream completion')

    expect(capturedArgs?.prompt).toContain('你正在当前小说项目中执行 NarraCat command：/narracat:write')
    expect(capturedArgs?.prompt).toContain('$ARGUMENTS：1')
    expect(capturedArgs?.prompt).toContain('恢复诊断')
    expect(capturedArgs?.options.cwd).toBe(projectPath)
    expect(capturedArgs?.options.maxTurns).toBe(72)
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'run.running',
      'novel.project.updated',
      'run.completed',
    ])
    expect(events[2]).toMatchObject({
      type: 'novel.project.updated',
      runId: 'run-1',
      projectPath,
      selectedChapter: 1,
      target: {
        sectionId: 'blueprint',
        tabId: 'chapter-1',
        objectId: 'chapter-1',
      },
    })
  })

  test('refreshes the active novel project when a write-next run fails after producing artifacts', async () => {
    const events: AgentEvent[] = []
    const projectPath = await makeReadyProjectForRunManagerTest()
    const streamDone = createDeferred<void>()

    async function* runSdkQuery(_args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      try {
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['NovelMemory MCP 工具在当前会话中不可用'],
        }
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'write-next',
      prompt: '写本章',
      projectPath,
    })
    await withTimeout(streamDone.promise, 'failed write-next SDK stream completion')

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'run.running',
      'novel.project.updated',
      'run.failed',
    ])
    expect(events[2]).toMatchObject({
      type: 'novel.project.updated',
      runId: 'run-1',
      projectPath,
      selectedChapter: 1,
    })
  })

  test('runs setup, world, plan, review, and rewrite through NarraCat command workflows in the active project cwd', async () => {
    const events: AgentEvent[] = []
    const capturedArgs: RunClaudeAgentQueryArgs[] = []
    const streamCompletions = [
      createDeferred<void>(),
      createDeferred<void>(),
      createDeferred<void>(),
      createDeferred<void>(),
      createDeferred<void>(),
    ]

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      const index = capturedArgs.length
      capturedArgs.push(args)
      try {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
      } finally {
        streamCompletions[index]?.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => `run-${capturedArgs.length + 1}`,
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'setup',
      prompt: '开始设定引导',
      projectPath: '/novels/stars',
      target: {
        sectionId: 'settings',
        tabId: 'foundation',
        objectId: 'foundation',
      },
    })
    await withTimeout(streamCompletions[0].promise, 'setup SDK stream completion')

    await manager.startRun({
      threadId: 'thread-1',
      command: 'world',
      prompt: '创建主角林舟',
      projectPath: '/novels/stars',
    })
    await withTimeout(streamCompletions[1].promise, 'world SDK stream completion')

    await manager.startRun({
      threadId: 'thread-1',
      command: 'plan',
      prompt: '规划第一卷',
      projectPath: '/novels/stars',
    })
    await withTimeout(streamCompletions[2].promise, 'plan SDK stream completion')

    await manager.startRun({
      threadId: 'thread-1',
      command: 'review',
      prompt: '1',
      projectPath: '/novels/stars',
      selectedChapter: 1,
    })
    await withTimeout(streamCompletions[3].promise, 'review SDK stream completion')

    await manager.startRun({
      threadId: 'thread-1',
      command: 'rewrite',
      prompt: '1',
      projectPath: '/novels/stars',
      selectedChapter: 1,
    })
    await withTimeout(streamCompletions[4].promise, 'rewrite SDK stream completion')

    expect(capturedArgs.map((args) => args.options.cwd)).toEqual([
      '/novels/stars',
      '/novels/stars',
      '/novels/stars',
      '/novels/stars',
      '/novels/stars',
    ])
    expect(capturedArgs[0]?.prompt).toContain('执行 NarraCat command：/narracat:setup')
    expect(capturedArgs[0]?.prompt).toContain('$ARGUMENTS：开始设定引导')
    expect(capturedArgs[0]?.prompt).toContain('执行 setup command')
    expect(capturedArgs[1]?.prompt).toContain('执行 NarraCat command：/narracat:world')
    expect(capturedArgs[1]?.prompt).toContain('$ARGUMENTS：创建主角林舟')
    expect(capturedArgs[2]?.prompt).toContain('执行 NarraCat command：/narracat:plan')
    expect(capturedArgs[2]?.prompt).toContain('$ARGUMENTS：规划第一卷')
    expect(capturedArgs[3]?.prompt).toContain('执行 NarraCat command：/narracat:review')
    expect(capturedArgs[3]?.prompt).toContain('$ARGUMENTS：1')
    expect(capturedArgs[3]?.prompt).not.toContain('NarraCat runtime status')
    expect(capturedArgs[4]?.prompt).toContain('执行 NarraCat command：/narracat:rewrite')
    expect(capturedArgs[4]?.prompt).toContain('$ARGUMENTS：1')
    expect(capturedArgs[4]?.prompt).not.toContain('NarraCat runtime status')
    const expectedDevRuntimePath = resolveDevelopmentHeadlessAgentRuntimeExecutablePath()
    for (const args of capturedArgs) {
      expect(args.options.plugins).toEqual([
        { type: 'local', path: '/workspace/narracat-decktop/agent-core/narracat' },
      ])
      expect(args.options.mcpServers).toMatchObject({
        [NARRACAT_NOVEL_MEMORY_MCP_SERVER_NAME]: {
          command: expectedDevRuntimePath,
          args: ['/workspace/narracat-decktop/agent-core/narracat/mcp-server/dist/index.js'],
          env: {
            NOVEL_CONFIG_PATH: '/novels/stars/.narracat/config.yaml',
          },
        },
      })
      expect(args.options.allowedTools).toContain('AskUserQuestion')
      expect(args.options.allowedTools).toContain('Write')
      expect(args.options.allowedTools).toContain('Agent')
      expect(args.options.additionalDirectories?.some((path) => path.endsWith('/agent-core/narracat'))).toBe(true)
    }
    const projectUpdateEvents = events.filter((event) => event.type === 'novel.project.updated')
    expect(projectUpdateEvents).toHaveLength(5)
    expect(projectUpdateEvents[0]).toMatchObject({
      type: 'novel.project.updated',
      target: {
        sectionId: 'settings',
        tabId: 'foundation',
        objectId: 'foundation',
      },
    })
  })

  test('denies direct NovelMemory SQLite access during NarraCat command runs', async () => {
    const events: AgentEvent[] = []
    const streamDone = createDeferred<void>()
    let permissionResult: unknown

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      if (!args.options.canUseTool) throw new Error('expected canUseTool')
      permissionResult = await args.options.canUseTool(
        'Write',
        {
          file_path: '/novels/stars/.narracat/init-memory.mjs',
          content: 'import Database from "better-sqlite3"; new Database(".narracat/memory.db")',
        },
        {
          signal: new AbortController().signal,
          toolUseID: 'tool-write-memory',
          title: 'Write memory script?',
        },
      )
      streamDone.resolve(undefined)
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'world',
      prompt: '创建世界观',
      projectPath: '/novels/stars',
    })
    await withTimeout(streamDone.promise, 'permission bridge result')

    expect(permissionResult).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('NovelMemory 必须通过 NarraCat MCP 工具和 memory-keeper 写入'),
      toolUseID: 'tool-write-memory',
    })
  })

  test('allows NovelMemory MCP tools during writing command runs', async () => {
    const permissionResolved = createDeferred<unknown>()
    const streamDone = createDeferred<void>()

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      expect(args.options.allowedTools).toContain(
        'mcp__narracat_memory__novel_build_writing_context_pack',
      )
      expect(args.options.allowedTools).toContain('mcp__narracat_memory__novel_commit_chapter')
      expect(args.options.allowedTools).toContain('mcp__narracat_memory__novel_update_progress')
      expect(args.options.allowedTools).toEqual(expect.arrayContaining(NARRACAT_NOVEL_MEMORY_MCP_TOOLS))
      expect(args.options.allowedTools).not.toContain('Bash')
      expect(args.options.allowedTools).not.toContain('WebFetch')
      expect(args.options.allowedTools).not.toContain('WebSearch')

      const canUseTool = args.options.canUseTool
      if (!canUseTool) throw new Error('expected canUseTool bridge')
      permissionResolved.resolve(
        await canUseTool(
          'mcp__narracat_memory__novel_build_writing_context_pack',
          { chapter: 2 },
          {
            signal: new AbortController().signal,
            toolUseID: 'tool-wcp-1',
            title: 'Build WCP?',
          },
        ),
      )
      try {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: () => {},
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'rewrite',
      prompt: '重写第 2 章',
      projectPath: '/novels/stars',
      selectedChapter: 2,
    })

    expect(await withTimeout(permissionResolved.promise, 'NovelMemory MCP permission resolution')).toEqual({
      behavior: 'allow',
      updatedInput: { chapter: 2 },
      toolUseID: 'tool-wcp-1',
    })
    await withTimeout(streamDone.promise, 'NovelMemory MCP SDK stream completion')
  })

  test('requires project context before starting setup command runs', async () => {
    const events: AgentEvent[] = []
    let sdkCalled = false
    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(() => {
        sdkCalled = true
        return (async function* (): AsyncIterable<unknown> {})()
      }),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({ threadId: 'thread-1', command: 'setup', prompt: '开始设定引导' })

    expect(sdkCalled).toBe(false)
    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.failed'])
    expect(events[1]).toMatchObject({
      type: 'run.failed',
      error: 'setup 需要先打开一个小说项目。',
    })
  })

  test('bridges AskUserQuestion permission prompts to renderer answers', async () => {
    const events: AgentEvent[] = []
    const questionReady = createDeferred<void>()
    const permissionResolved = createDeferred<unknown>()
    const streamDone = createDeferred<void>()

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      const canUseTool = args.options.canUseTool
      if (!canUseTool) throw new Error('expected canUseTool bridge')

      const permission = canUseTool(
        'AskUserQuestion',
        {
          questions: [
            {
              header: '概念',
              question: '这个故事关于什么？',
              options: [
                { label: '小人物', description: '从个体命运切入' },
                { label: '群像', description: '从群体关系切入' },
              ],
            },
          ],
        },
        {
          signal: new AbortController().signal,
          toolUseID: 'tool-question-1',
          title: 'Answer questions?',
        },
      )
      questionReady.resolve(undefined)
      permissionResolved.resolve(await permission)
      try {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'setup',
      prompt: '开始设定引导',
      projectPath: '/novels/stars',
    })
    await withTimeout(questionReady.promise, 'AskUserQuestion bridge request')

    expect(events).toContainEqual({
      type: 'question.requested',
      runId: 'run-1',
      messageId: 'assistant-run-1',
      questionRequestId: 'tool-question-1',
      toolCallId: 'tool-question-1',
      questions: [
        {
          header: '概念',
          question: '这个故事关于什么？',
          options: [
            { label: '小人物', description: '从个体命运切入' },
            { label: '群像', description: '从群体关系切入' },
          ],
        },
      ],
      createdAt: fixedNow(),
    })
    expect(
      await manager.answerQuestion({
        requestId: 'tool-question-1',
        answers: { '这个故事关于什么？': '小人物' },
      }),
    ).toEqual({ accepted: true })
    expect(await withTimeout(permissionResolved.promise, 'AskUserQuestion permission resolution')).toMatchObject({
      behavior: 'allow',
      updatedInput: {
        answers: { '这个故事关于什么？': '小人物' },
      },
    })
    await withTimeout(streamDone.promise, 'AskUserQuestion SDK stream completion')
    expect(events).toContainEqual({
      type: 'question.answered',
      runId: 'run-1',
      questionRequestId: 'tool-question-1',
      answers: { '这个故事关于什么？': '小人物' },
      createdAt: fixedNow(),
    })
  })

  test('returns SDK-compatible allow results for regular tool permission checks', async () => {
    const permissionResolved = createDeferred<unknown>()
    const streamDone = createDeferred<void>()

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      const canUseTool = args.options.canUseTool
      if (!canUseTool) throw new Error('expected canUseTool bridge')

      permissionResolved.resolve(
        await canUseTool(
          'Read',
          { file_path: 'bible/premise.md' },
          {
            signal: new AbortController().signal,
            toolUseID: 'tool-read-1',
            title: 'Read bible/premise.md?',
          },
        ),
      )
      try {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: () => {},
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'setup',
      prompt: '开始设定引导',
      projectPath: '/novels/stars',
    })

    expect(await withTimeout(permissionResolved.promise, 'regular tool permission resolution')).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: 'bible/premise.md' },
      toolUseID: 'tool-read-1',
    })
    await withTimeout(streamDone.promise, 'regular tool permission SDK stream completion')
  })

  test('routes freeform prompts as direct chat without requiring the NarraCat plugin', async () => {
    const events: AgentEvent[] = []
    let pluginManifestChecked = false
    let capturedArgs: RunClaudeAgentQueryArgs | undefined
    const streamDone = createDeferred<void>()

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      capturedArgs = args
      try {
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => {
        pluginManifestChecked = true
        return false
      },
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    const result = await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '你好' })
    await withTimeout(streamDone.promise, 'direct chat SDK stream completion')

    expect(result).toEqual({ runId: 'run-1' })
    expect(pluginManifestChecked).toBe(false)
    expect(capturedArgs?.prompt).toContain('User message:\n你好')
    expect(capturedArgs?.prompt).not.toContain('NarraCat runtime status')
    expect(capturedArgs?.options.plugins).toBeUndefined()
    expect(capturedArgs?.options.systemPrompt).toContain('NarraCat')
    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.running', 'run.completed'])
  })

  test('runs project-scoped freeform chat in the active novel project cwd', async () => {
    const events: AgentEvent[] = []
    let pluginManifestChecked = false
    let capturedArgs: RunClaudeAgentQueryArgs | undefined
    const streamDone = createDeferred<void>()
    const sdkSessionId = '33333333-3333-4333-8333-333333333333'

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      capturedArgs = args
      try {
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: sdkSessionId,
        }
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => {
        pluginManifestChecked = true
        return false
      },
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'freeform',
      prompt: '聊一下角色动机',
      projectPath: '/novels/stars',
      selectedChapter: 1,
    })
    await withTimeout(streamDone.promise, 'project freeform SDK stream completion')

    expect(pluginManifestChecked).toBe(false)
    expect(capturedArgs?.prompt).toContain('User message:\n聊一下角色动机')
    expect(capturedArgs?.prompt).toContain('Current novel project root: /novels/stars')
    expect(capturedArgs?.options.cwd).toBe('/novels/stars')
    expect(capturedArgs?.options.plugins).toBeUndefined()
    expect(capturedArgs?.options.resume).toBeUndefined()
    // 无 engineContext 的普通 freeform 不挂 NovelMemory MCP、保持 direct-chat 系统提示（引擎待遇仅显式声明才有）。
    expect(capturedArgs?.options.mcpServers).toBeUndefined()
    expect(capturedArgs?.options.systemPrompt).toContain('NarraCat')
    expect(events[0]).toMatchObject({
      type: 'run.started',
      projectPath: '/novels/stars',
      selectedChapter: 1,
    })
  })

  test('runs engine-context freeform with the NarraCat runtime instead of direct chat', async () => {
    const events: AgentEvent[] = []
    let pluginManifestChecked = false
    const capturedArgs: RunClaudeAgentQueryArgs[] = []
    const firstStreamDone = createDeferred<void>()
    const secondStreamDone = createDeferred<void>()
    const sdkSessionId = '55555555-5555-4555-8555-555555555555'

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      const index = capturedArgs.length
      capturedArgs.push(args)
      try {
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: sdkSessionId,
        }
      } finally {
        if (index === 0) firstStreamDone.resolve(undefined)
        if (index === 1) secondStreamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => {
        pluginManifestChecked = true
        return true
      },
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => `run-${capturedArgs.length + 1}`,
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'freeform',
      prompt: '评估赌注曲线改动的级联影响',
      engineContext: true,
      projectPath: '/novels/stars',
    })
    await withTimeout(firstStreamDone.promise, 'engine-context freeform SDK stream completion')

    expect(pluginManifestChecked).toBe(true)
    const engineArgs = capturedArgs[0]
    expect(engineArgs?.options.cwd).toBe('/novels/stars')
    // project-command 待遇：挂运行适配器 + NovelMemory MCP + 引擎工具白名单，不套 direct-chat 系统提示。
    expect(engineArgs?.options.plugins).toEqual([
      { type: 'local', path: '/workspace/narracat-decktop/agent-core/narracat' },
    ])
    expect(engineArgs?.options.mcpServers).toMatchObject({
      [NARRACAT_NOVEL_MEMORY_MCP_SERVER_NAME]: {
        env: { NOVEL_CONFIG_PATH: '/novels/stars/.narracat/config.yaml' },
      },
    })
    for (const toolName of NARRACAT_NOVEL_MEMORY_MCP_TOOLS) {
      expect(engineArgs?.options.allowedTools).toContain(toolName)
    }
    expect(engineArgs?.options.allowedTools).toContain('AskUserQuestion')
    expect(engineArgs?.options.systemPrompt).toBeUndefined()
    expect(engineArgs?.options.resume).toBeUndefined()
    expect(engineArgs?.prompt).toContain('当前小说项目根目录：/novels/stars')
    expect(engineArgs?.prompt).toContain('用户本轮输入：\n评估赌注曲线改动的级联影响')
    expect(engineArgs?.prompt).not.toContain('NarraCat direct conversation')
    expect(events.map((event) => event.type)).toContain('run.completed')

    // session 簿记与 project-command 一致：后续普通 freeform 续聊 resume 同一 session 并保留引擎工具。
    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '确认，落盘吧' })
    await withTimeout(secondStreamDone.promise, 'engine-context continuation SDK stream completion')

    const continuationArgs = capturedArgs[1]
    expect(continuationArgs?.options.resume).toBe(sdkSessionId)
    expect(continuationArgs?.options.cwd).toBe('/novels/stars')
    for (const toolName of NARRACAT_NOVEL_MEMORY_MCP_TOOLS) {
      expect(continuationArgs?.options.allowedTools).toContain(toolName)
    }
    expect(continuationArgs?.prompt).toContain('用户本轮输入：\n确认，落盘吧')
  })

  test('fails an engine-context freeform without an open project instead of degrading to direct chat', async () => {
    const events: AgentEvent[] = []
    let sdkCalled = false
    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(() => {
        sdkCalled = true
        return (async function* (): AsyncIterable<unknown> {})()
      }),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'freeform',
      prompt: '评估赌注曲线改动的级联影响',
      engineContext: true,
    })

    expect(sdkCalled).toBe(false)
    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.failed'])
    expect(events[1]).toMatchObject({
      type: 'run.failed',
      error: '本次任务需要 NarraCat 引擎上下文，请先打开一个小说项目。',
    })
  })

  test('does not resume a previous SDK session after switching to a different novel project', async () => {
    const capturedArgs: RunClaudeAgentQueryArgs[] = []
    const firstStreamDone = createDeferred<void>()
    const secondStreamDone = createDeferred<void>()
    const sdkSessionId = '44444444-4444-4444-8444-444444444444'
    let runIndex = 0

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      capturedArgs.push(args)
      const currentRun = ++runIndex
      try {
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: sdkSessionId,
        }
      } finally {
        if (currentRun === 1) firstStreamDone.resolve(undefined)
        if (currentRun === 2) secondStreamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: () => {},
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => `run-${runIndex + 1}`,
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'freeform',
      prompt: '聊第一本',
      projectPath: '/novels/stars',
    })
    await withTimeout(firstStreamDone.promise, 'first project freeform SDK stream completion')
    await manager.startRun({
      threadId: 'thread-1',
      command: 'freeform',
      prompt: '聊第二本',
      projectPath: '/novels/moon',
    })
    await withTimeout(secondStreamDone.promise, 'second project freeform SDK stream completion')

    expect(capturedArgs).toHaveLength(2)
    expect(capturedArgs[0]?.options.cwd).toBe('/novels/stars')
    expect(capturedArgs[1]?.options.cwd).toBe('/novels/moon')
    expect(capturedArgs[1]?.options.resume).toBeUndefined()
  })

  test('streams successful SDK messages in the background', async () => {
    const events: AgentEvent[] = []
    let resolveStreamDone!: () => void
    const streamDone = new Promise<void>((resolve) => {
      resolveStreamDone = resolve
    })

    async function* runSdkQuery(_args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      try {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '运行环境正常。' }] } }
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 2 } }
      } finally {
        resolveStreamDone()
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    const result = await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '检查运行环境' })
    await withTimeout(streamDone, 'successful SDK stream completion')

    expect(result).toEqual({ runId: 'run-1' })
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'run.running',
      'message.delta',
      'run.completed',
    ])
    expect(events[2]).toMatchObject({
      type: 'message.delta',
      runId: 'run-1',
      messageId: 'assistant-run-1',
      text: '运行环境正常。',
    })
    expect(events[3]).toMatchObject({
      type: 'run.completed',
      runId: 'run-1',
      usage: { inputTokens: 1, outputTokens: 2 },
    })
  })

  test('does not duplicate final assistant text after streaming deltas', async () => {
    const events: AgentEvent[] = []
    const streamDone = createDeferred<void>()

    async function* runSdkQuery(_args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      try {
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '你好' },
          },
        }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } }
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '你好' })
    await withTimeout(streamDone.promise, 'streamed direct chat completion')

    expect(events.filter((event) => event.type === 'message.delta')).toEqual([
      {
        type: 'message.delta',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        text: '你好',
        createdAt: fixedNow(),
      },
    ])
  })

  test('resumes the previous SDK session for later runs in the same thread', async () => {
    const events: AgentEvent[] = []
    const capturedArgs: RunClaudeAgentQueryArgs[] = []
    const firstStreamDone = createDeferred<void>()
    const secondStreamDone = createDeferred<void>()
    const sdkSessionId = '11111111-1111-4111-8111-111111111111'
    let runIndex = 0

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      capturedArgs.push(args)
      const currentRun = ++runIndex
      try {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: currentRun === 1 ? 'NarraCat 在 ../NarraCat' : '我继续看。' }] },
          session_id: sdkSessionId,
        }
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: sdkSessionId,
        }
      } finally {
        if (currentRun === 1) firstStreamDone.resolve(undefined)
        if (currentRun === 2) secondStreamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => `run-${runIndex + 1}`,
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: 'NarraCat 插件在哪里？' })
    await withTimeout(firstStreamDone.promise, 'first SDK stream completion')
    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '可以，查看一下' })
    await withTimeout(secondStreamDone.promise, 'resumed SDK stream completion')

    expect(capturedArgs).toHaveLength(2)
    expect(capturedArgs[0]?.options.resume).toBeUndefined()
    expect(capturedArgs[0]?.options.persistSession).toBe(true)
    expect(capturedArgs[1]?.options.resume).toBe(sdkSessionId)
    expect(capturedArgs[1]?.options.persistSession).toBe(true)
  })

  test('invalidates the live SDK session when its compatibility fingerprint changes', async () => {
    const capturedArgs: RunClaudeAgentQueryArgs[] = []
    const settled = [createDeferred<void>(), createDeferred<void>(), createDeferred<void>()]
    const invalidated: string[] = []
    let fingerprint = 'fingerprint-v1'
    let sdkCall = 0
    let runId = 0
    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      const index = sdkCall++
      capturedArgs.push(args)
      try {
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: `session-${index + 1}`,
        }
      } finally {
        settled[index]?.resolve(undefined)
      }
    }
    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: () => {},
      appRoot: '/app',
      createRunId: () => `run-${++runId}`,
      createSessionFingerprint: async () => fingerprint,
      onSessionInvalidated: async (_threadId, reason) => {
        invalidated.push(reason)
      },
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '第一轮' })
    await withTimeout(settled[0]!.promise, 'first fingerprint run')
    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '第二轮' })
    await withTimeout(settled[1]!.promise, 'second fingerprint run')
    fingerprint = 'fingerprint-v2'
    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '第三轮' })
    await withTimeout(settled[2]!.promise, 'third fingerprint run')

    expect(capturedArgs[0]?.options.resume).toBeUndefined()
    expect(capturedArgs[1]?.options.resume).toBe('session-1')
    expect(capturedArgs[2]?.options.resume).toBeUndefined()
    expect(invalidated).toEqual(['compatibility-changed'])
  })

  test('does not let an active run re-establish an old session after environment invalidation', async () => {
    const established = createDeferred<void>()
    const release = createDeferred<void>()
    const settled = createDeferred<void>()
    const establishedFingerprints: string[] = []
    const invalidated: string[] = []

    async function* runSdkQuery(): AsyncIterable<unknown> {
      try {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '处理中' }] },
          session_id: 'session-old-environment',
        }
        await release.promise
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: 'session-old-environment',
        }
      } finally {
        settled.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: () => {},
      appRoot: '/app',
      createRunId: () => 'run-1',
      createSessionFingerprint: async () => 'fingerprint-old-environment',
      onSessionContextEstablished: async (_threadId, _mode, fingerprint) => {
        establishedFingerprints.push(fingerprint)
        established.resolve(undefined)
      },
      onSessionInvalidated: async (_threadId, reason) => {
        invalidated.push(reason)
      },
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '第一轮' })
    await withTimeout(established.promise, 'old session establishment')
    await manager.invalidateAllThreadSessions('model-service-changed')
    release.resolve(undefined)
    await withTimeout(settled.promise, 'old environment stream settlement')

    expect(establishedFingerprints).toEqual(['fingerprint-old-environment'])
    expect(invalidated).toEqual(['model-service-changed'])
    expect(manager.hasThreadSession('thread-1')).toBe(false)
  })

  test('does not resume a previous SDK session for repeated project-command runs in the same thread', async () => {
    const capturedArgs: RunClaudeAgentQueryArgs[] = []
    const firstStreamDone = createDeferred<void>()
    const secondStreamDone = createDeferred<void>()
    const sdkSessionId = '33333333-3333-4333-8333-333333333333'
    let runIndex = 0

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      capturedArgs.push(args)
      const currentRun = ++runIndex
      try {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '引导中' }] },
          session_id: sdkSessionId,
        }
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: sdkSessionId,
        }
      } finally {
        if (currentRun === 1) firstStreamDone.resolve(undefined)
        if (currentRun === 2) secondStreamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: () => {},
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => `run-${runIndex + 1}`,
    })

    await manager.startRun({ threadId: 'thread-1', command: 'setup', prompt: '开始设定引导', projectPath: '/novels/stars' })
    await withTimeout(firstStreamDone.promise, 'first setup stream')
    await manager.startRun({ threadId: 'thread-1', command: 'setup', prompt: '再次设定引导', projectPath: '/novels/stars' })
    await withTimeout(secondStreamDone.promise, 'second setup stream')

    expect(capturedArgs).toHaveLength(2)
    expect(capturedArgs[0]?.options.resume).toBeUndefined()
    expect(capturedArgs[1]?.options.resume).toBeUndefined()
  })

  test('continues a NarraCat command session from a plain user reply in the original project cwd', async () => {
    const events: AgentEvent[] = []
    const capturedArgs: RunClaudeAgentQueryArgs[] = []
    const firstStreamDone = createDeferred<void>()
    const secondStreamDone = createDeferred<void>()
    const sdkSessionId = '22222222-2222-4222-8222-222222222222'
    let runIndex = 0

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      capturedArgs.push(args)
      const currentRun = ++runIndex
      try {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: currentRun === 1 ? '你的故事，一句话是什么？' : '收到，继续追问。' }] },
          session_id: sdkSessionId,
        }
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: sdkSessionId,
        }
      } finally {
        if (currentRun === 1) firstStreamDone.resolve(undefined)
        if (currentRun === 2) secondStreamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => `run-${runIndex + 1}`,
    })

    await manager.startRun({
      threadId: 'thread-1',
      command: 'setup',
      prompt: '开始设定引导',
      projectPath: '/novels/stars',
    })
    await withTimeout(firstStreamDone.promise, 'first setup SDK stream completion')
    await manager.startRun({
      threadId: 'thread-1',
      command: 'freeform',
      prompt: '我希望从小人物的小确幸描绘出堪比广袤宇宙的壮阔情感',
    })
    await withTimeout(secondStreamDone.promise, 'second setup SDK stream completion')

    expect(capturedArgs).toHaveLength(2)
    expect(capturedArgs[1]?.prompt).toContain('继续当前 NarraCat command 会话')
    expect(capturedArgs[1]?.prompt).toContain('必须使用 AskUserQuestion')
    expect(capturedArgs[1]?.prompt).toContain('我希望从小人物的小确幸描绘出堪比广袤宇宙的壮阔情感')
    expect(capturedArgs[1]?.options.resume).toBe(sdkSessionId)
    expect(capturedArgs[1]?.options.cwd).toBe('/novels/stars')
    expect(capturedArgs[1]?.options.plugins).toEqual([
      { type: 'local', path: '/workspace/narracat-decktop/agent-core/narracat' },
    ])
    expect(capturedArgs[1]?.options.allowedTools).toContain('Write')
    expect(capturedArgs[1]?.options.allowedTools).toContain('AskUserQuestion')
  })

  test('does not fail or start the SDK stream when cancelled during startup', async () => {
    const events: AgentEvent[] = []
    const configDeferred = createDeferred<AppConfig>()
    let resolveStarted!: () => void
    let sdkStarted = false
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })

    const manager = createAgentRunManager({
      readConfig: async () => configDeferred.promise,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime((_args) => {
        sdkStarted = true
        return (async function* (): AsyncIterable<unknown> {})()
      }),
      sendEvent: (event) => {
        events.push(event)
        if (event.type === 'run.started') resolveStarted()
      },
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    const startPromise = manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '检查运行环境' })
    await withTimeout(started, 'run.started event during startup cancellation')

    expect(await manager.cancelRun('run-1')).toEqual({ cancelled: true })
    configDeferred.resolve(deepseekConfig)
    await withTimeout(startPromise, 'startRun return after startup cancellation')
    await Promise.resolve()

    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.cancelling', 'run.cancelled'])
    expect(sdkStarted).toBe(false)
  })

  test('uses the unified history error when cancellation cannot be durably recorded', async () => {
    const configDeferred = createDeferred<AppConfig>()
    const started = createDeferred<void>()
    let sdkStarted = false
    const manager = createAgentRunManager({
      readConfig: async () => configDeferred.promise,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(() => {
        sdkStarted = true
        return (async function* (): AsyncIterable<unknown> {})()
      }),
      sendEvent: (event) => {
        if (event.type === 'run.started') {
          started.resolve(undefined)
          return
        }
        if (event.type === 'run.cancelling') throw new Error('disk unavailable')
      },
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    const startPromise = manager.startRun({
      threadId: 'thread-1',
      command: 'freeform',
      prompt: '检查运行环境',
    })
    await withTimeout(started.promise, 'run.started before cancellation durability failure')
    await expect(manager.cancelRun('run-1')).rejects.toThrow('历史无法安全保存')
    configDeferred.resolve(deepseekConfig)
    await withTimeout(startPromise, 'startRun return after cancellation durability failure')
    expect(sdkStarted).toBe(false)
  })

  test('startRun returns before the SDK stream completes', async () => {
    const events: AgentEvent[] = []
    const streamStarted = createDeferred<void>()
    const releaseStream = createDeferred<void>()
    const streamDone = createDeferred<void>()
    let startResult: { runId: string } | undefined

    async function* runSdkQuery(_args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      try {
        streamStarted.resolve(undefined)
        await releaseStream.promise
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 2 } }
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    const startPromise = manager
      .startRun({ threadId: 'thread-1', command: 'freeform', prompt: '检查运行环境' })
      .then((result) => {
        startResult = result
        return result
      })

    await withTimeout(streamStarted.promise, 'SDK stream start before completion release')
    await Promise.resolve()

    try {
      expect(startResult).toEqual({ runId: 'run-1' })
      expect(events.map((event) => event.type)).toEqual(['run.started'])
    } finally {
      releaseStream.resolve(undefined)
    }

    await withTimeout(streamDone.promise, 'SDK stream completion after release')
    await withTimeout(startPromise, 'startRun promise settlement before stream completion')

    expect(events.map((event) => event.type)).toEqual(['run.started', 'run.running', 'run.completed'])
  })

  test('emits a failed run when the SDK stream throws', async () => {
    const events: AgentEvent[] = []
    let resolveFailedEvent!: (event: AgentEvent) => void
    const failedEvent = new Promise<AgentEvent>((resolve) => {
      resolveFailedEvent = resolve
    })

    async function* runSdkQuery(_args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      throw new Error('sdk down')
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => {
        events.push(event)
        if (event.type === 'run.failed') resolveFailedEvent(event)
      },
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '检查运行环境' })
    const event = await withTimeout(failedEvent, 'SDK throw failed event')

    expect(events.at(-1)?.type).toBe('run.failed')
    expect(event).toMatchObject({
      type: 'run.failed',
      runId: 'run-1',
      error: expect.stringContaining('sdk down'),
    })
  })

  test('emits failed when the SDK stream ends without a terminal event', async () => {
    const events: AgentEvent[] = []
    const streamDone = createDeferred<void>()
    const failedSeen = createDeferred<AgentEvent>()

    async function* runSdkQuery(_args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      try {
        yield { type: 'system', message: 'ignored' }
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => {
        events.push(event)
        if (event.type === 'run.failed') failedSeen.resolve(event)
      },
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '检查运行环境' })
    await withTimeout(streamDone.promise, 'unterminated SDK stream completion')
    const failed = await withTimeout(failedSeen.promise, 'unterminated stream run.failed')

    expect(failed).toMatchObject({
      type: 'run.failed',
      runId: 'run-1',
      error: expect.stringContaining('没有返回完成状态'),
    })
    expect(events.at(-1)).toMatchObject({ type: 'run.failed', runId: 'run-1' })
  })

  test('redacts mapped SDK result failures before sending', async () => {
    const events: AgentEvent[] = []
    const failedEvent = createDeferred<AgentEvent>()

    async function* runSdkQuery(_args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      yield { type: 'result', subtype: 'error_during_execution', errors: ['Bearer secret-token'] }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => {
        events.push(event)
        if (event.type === 'run.failed') failedEvent.resolve(event)
      },
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '检查运行环境' })
    const event = await withTimeout(failedEvent.promise, 'redacted SDK failure event')

    expect(event.type).toBe('run.failed')
    expect(event.runId).toBe('run-1')
    if (event.type !== 'run.failed') throw new Error('expected failed event')
    expect(event.error).toContain('Bearer ***')
    expect(event.error.includes('secret-token')).toBe(false)
  })

  test('rejects before config or SDK startup when durable event publication fails', async () => {
    let readConfigCalled = false
    const manager = createAgentRunManager({
      readConfig: async () => {
        readConfigCalled = true
        return deepseekConfig
      },
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime((_args) => (async function* (): AsyncIterable<unknown> {})()),
      sendEvent: () => {
        throw new Error('renderer gone')
      },
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    const result = await manager
      .startRun({ threadId: 'thread-1', command: 'freeform', prompt: '检查运行环境' })
      .then((value) => ({ ok: true as const, value }))
      .catch((error) => ({ ok: false as const, error }))

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected startRun to reject')
    expect(result.error).toBeInstanceOf(Error)
    expect((result.error as Error).message).toContain('历史无法安全保存')
    expect(readConfigCalled).toBe(false)
    expect(await manager.cancelRun('run-1')).toEqual({ cancelled: false })
  })

  test('cancels an active SDK stream exactly once', async () => {
    const events: AgentEvent[] = []
    let capturedAbortController: AbortController | undefined
    let resolveStreamStarted!: () => void
    const streamStarted = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve
    })
    const streamDone = createDeferred<void>()

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      try {
        capturedAbortController = args.options.abortController
        resolveStreamStarted()
        await new Promise<void>((resolve) => {
          if (capturedAbortController?.signal.aborted) {
            resolve()
            return
          }
          capturedAbortController?.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    const { runId } = await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '检查运行环境' })
    await withTimeout(streamStarted, 'cancellable SDK stream start')

    expect(await manager.cancelRun(runId)).toEqual({ cancelled: true })
    expect(capturedAbortController?.signal.aborted).toBe(true)
    await withTimeout(streamDone.promise, 'cancellable SDK stream settlement')
    expect(events.map((event) => event.type)).toContain('run.cancelled')
    expect(await manager.cancelRun(runId)).toEqual({ cancelled: false })
  })

  test('records Cmd+Q settlement as interrupted instead of user-cancelled', async () => {
    const events: AgentEvent[] = []
    const streamStarted = createDeferred<void>()
    const streamDone = createDeferred<void>()

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      try {
        streamStarted.resolve(undefined)
        await new Promise<void>((resolve) => {
          if (args.options.abortController.signal.aborted) return resolve()
          args.options.abortController.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      } finally {
        streamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: (event) => events.push(event),
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => 'run-1',
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '检查运行环境' })
    await withTimeout(streamStarted.promise, 'interruptible SDK stream start')
    await manager.settleActiveRuns()
    await withTimeout(streamDone.promise, 'interrupted SDK stream settlement')

    expect(events.map((event) => event.type)).toContain('run.interrupted')
    expect(events.map((event) => event.type)).not.toContain('run.cancelled')
  })

  test('applies agent overrides when freeform continues a resumed project-command session', async () => {
    const firstStreamDone = createDeferred<void>()
    const secondStreamDone = createDeferred<void>()
    const capturedArgs: RunClaudeAgentQueryArgs[] = []
    const sdkSessionId = '55555555-5555-4555-8555-555555555555'
    let runIndex = 0

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      capturedArgs.push(args)
      const currentRun = ++runIndex
      try {
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: sdkSessionId,
        }
      } finally {
        if (currentRun === 1) firstStreamDone.resolve(undefined)
        if (currentRun === 2) secondStreamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      resolveAgentSkillOverrides: async () => ({
        agents: { 'chapter-writer': { description: 'd', prompt: 'p' } },
      }),
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: () => {},
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => `run-${runIndex + 1}`,
    })

    // 首轮 project-command（setup）建立 project-command 会话
    await manager.startRun({ threadId: 'thread-1', command: 'setup', prompt: '开始设定引导', projectPath: '/novels/stars' })
    await withTimeout(firstStreamDone.promise, 'resumed-session first run completion')
    // 续聊轮 freeform：resume 到已建立的 project-command 会话，走 buildResumedCommandRunPlan——
    // agents 是否进 options 由 resumed-command-path.ts 的
    // `agents: sdkSession.loadNarraCatRuntime ? agentSkillOverrides : undefined` 独立把关（本任务
    // 未改动这条门控），这里验证正向场景下该门控确实放行、agents 覆盖到达了 SDK query options。
    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '继续聊' })
    await withTimeout(secondStreamDone.promise, 'resumed-session freeform continuation completion')
    await Promise.resolve()

    expect(capturedArgs[1]?.options.agents).toBeTruthy()
  })

  test('forgetThreadSession drops the stored SDK session so the next run does not resume', async () => {
    const capturedArgs: RunClaudeAgentQueryArgs[] = []
    const firstStreamDone = createDeferred<void>()
    const secondStreamDone = createDeferred<void>()
    const sdkSessionId = '44444444-4444-4444-8444-444444444444'
    let runIndex = 0

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      capturedArgs.push(args)
      const currentRun = ++runIndex
      try {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '在' }] },
          session_id: sdkSessionId,
        }
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: sdkSessionId,
        }
      } finally {
        if (currentRun === 1) firstStreamDone.resolve(undefined)
        if (currentRun === 2) secondStreamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: () => {},
      appRoot: '/app',
      now: fixedNow,
      createRunId: () => `run-${runIndex + 1}`,
    })

    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '在吗' })
    await withTimeout(firstStreamDone.promise, 'first freeform stream')
    manager.forgetThreadSession('thread-1')
    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: '再聊' })
    await withTimeout(secondStreamDone.promise, 'second freeform stream')

    expect(capturedArgs).toHaveLength(2)
    expect(capturedArgs[0]?.options.resume).toBeUndefined()
    // 未 forget 时第二次 freeform 会 resume（见现有同线程 resume 测试）；forget 后应回到 undefined。
    expect(capturedArgs[1]?.options.resume).toBeUndefined()
  })

  test('a fresh command clears the thread session so a later freeform does not resume a stale one (command produced no session)', async () => {
    const capturedArgs: RunClaudeAgentQueryArgs[] = []
    const firstStreamDone = createDeferred<void>()
    const secondStreamDone = createDeferred<void>()
    const thirdStreamDone = createDeferred<void>()
    const sdkSessionId = '55555555-5555-4555-8555-555555555555'
    let runIndex = 0

    async function* runSdkQuery(args: RunClaudeAgentQueryArgs): AsyncIterable<unknown> {
      capturedArgs.push(args)
      const currentRun = ++runIndex
      try {
        if (currentRun === 2) {
          // 第二个命令在产出任何 session_id 前就结束（模拟首 session 前失败）：不登记新 session
          yield {
            type: 'result',
            subtype: 'success',
            usage: { input_tokens: 1, output_tokens: 1 },
          }
          return
        }
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'x' }] },
          session_id: sdkSessionId,
        }
        yield {
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          session_id: sdkSessionId,
        }
      } finally {
        if (currentRun === 1) firstStreamDone.resolve(undefined)
        if (currentRun === 2) secondStreamDone.resolve(undefined)
        if (currentRun === 3) thirdStreamDone.resolve(undefined)
      }
    }

    const manager = createAgentRunManager({
      readConfig: async () => deepseekConfig,
      getApiKey: async () => 'sk-test-key',
      agentCoreManifestExists: () => true,
      readNarraCatCommandFile: (_pluginPath, commandName) =>
        `---\ndescription: ${commandName}\n---\n执行 ${commandName} command。参数：$ARGUMENTS。`,
      runtime: fakeRuntime(runSdkQuery),
      sendEvent: () => {},
      appRoot: '/workspace/narracat-decktop',
      now: fixedNow,
      createRunId: () => `run-${runIndex + 1}`,
    })

    // 命令 A 成功，登记 session
    await manager.startRun({ threadId: 'thread-1', command: 'setup', prompt: 'A', projectPath: '/novels/stars' })
    await withTimeout(firstStreamDone.promise, 'first setup stream')
    // 命令 B 在首个 session_id 前结束，未登记新 session；但启动时已清掉旧 session
    await manager.startRun({ threadId: 'thread-1', command: 'setup', prompt: 'B', projectPath: '/novels/stars' })
    await withTimeout(secondStreamDone.promise, 'second setup stream')
    // freeform：旧 session 已被命令 B 启动时清掉，故不 resume 到命令 A 的脏会话
    await manager.startRun({ threadId: 'thread-1', command: 'freeform', prompt: 'C', projectPath: '/novels/stars' })
    await withTimeout(thirdStreamDone.promise, 'freeform stream')

    expect(capturedArgs).toHaveLength(3)
    expect(capturedArgs[2]?.options.resume).toBeUndefined()
  })
})

describe('isProjectMarkdownWrite', () => {
  const projectPath = '/novels/stars'

  function writeEvent(toolName: string, filePath: string): AgentEvent {
    return {
      type: 'tool.started',
      runId: 'run-1',
      messageId: 'assistant-run-1',
      toolCallId: 'tool-1',
      toolName,
      title: `调用 ${toolName}`,
      input: { file_path: filePath },
      createdAt: '2026-06-05T00:00:00.000Z',
    }
  }

  test('detects Write / Edit / MultiEdit to a project markdown file', () => {
    expect(isProjectMarkdownWrite(writeEvent('Write', '/novels/stars/chapters/ch-001.md'), projectPath)).toBe(true)
    expect(isProjectMarkdownWrite(writeEvent('Edit', '/novels/stars/bible/world/a.md'), projectPath)).toBe(true)
    expect(
      isProjectMarkdownWrite(writeEvent('MultiEdit', '/novels/stars/outline/master-outline.md'), projectPath),
    ).toBe(true)
  })

  test('ignores non-markdown files', () => {
    expect(isProjectMarkdownWrite(writeEvent('Write', '/novels/stars/.narracat/state.yaml'), projectPath)).toBe(false)
  })

  test('ignores writes outside the project', () => {
    expect(isProjectMarkdownWrite(writeEvent('Write', '/novels/other/note.md'), projectPath)).toBe(false)
  })

  test('ignores non-write tools and non tool.started events', () => {
    expect(isProjectMarkdownWrite(writeEvent('Bash', '/novels/stars/x.md'), projectPath)).toBe(false)
    expect(
      isProjectMarkdownWrite(
        { type: 'run.completed', runId: 'run-1', createdAt: '2026-06-05T00:00:00.000Z' },
        projectPath,
      ),
    ).toBe(false)
  })
})
