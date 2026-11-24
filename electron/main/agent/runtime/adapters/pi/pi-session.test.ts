/**
 * 会话事件桥测试（阶段 2 切片①）：runPiSession 经 DI 假会话验证——装配入参、事件按序透出、
 * abort 传播、未支持面 fail-loud。真 createAgentSession 需打网络，不进单测（spike 已实测）。
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import type { AppConfig } from '@shared/types/config'
import { POOL_DEFAULT_FIELDS } from '@shared/types/config'
import { createPiModel } from './pi-model.ts'
import {
  PI_MAX_TURNS_MESSAGE_TYPE,
  PI_REPEATED_TOOL_FAILURE_MESSAGE_TYPE,
  PI_RUN_END_MESSAGE_TYPE,
  PI_SESSION_MESSAGE_TYPE,
  PI_SUBAGENT_EVENT_MESSAGE_TYPE,
} from './pi-event-mapper.ts'
import { findPiSessionFile, runPiSession, sweepStalePiSessionFiles } from './pi-session.ts'
import type { CreatePiSession, PiRunOptions } from './pi-session.ts'
import { createSubagentEventChannel } from './pi-subagent.ts'
import type { PiSubagentEventMessage } from './pi-subagent.ts'

const config: AppConfig = {
  ...POOL_DEFAULT_FIELDS,
  apiKeyMetadata: {},
  novelRootDir: '/tmp/novels',
  recentNovelPaths: [],
  systemNotificationsEnabled: true,
  introVersion: 0,
}

function makeOptions(overrides: Partial<PiRunOptions> = {}): PiRunOptions {
  return {
    model: createPiModel(config),
    provider: 'deepseek',
    apiKey: 'test-key',
    cwd: tmpdir(),
    agentDir: join(tmpdir(), `narracat-pi-test-${process.pid}`, 'agent'),
    tools: ['read', 'bash'],
    maxTurns: 12,
    systemPrompt: '骨架系统提示词',
    abortController: new AbortController(),
    extensions: [],
    customTools: [],
    ...overrides,
  }
}

interface FakeSessionControls {
  createSession: CreatePiSession
  capturedArgs: () => Record<string, unknown>
  abortCalls: () => number
  resolvePrompt?: () => void
}

/** 假会话：prompt 时把 events 逐个发给 subscriber 后 resolve；hang=true 时挂起等 resolvePrompt。 */
function makeFakeSession(
  events: unknown[],
  { hang = false, promptError }: { hang?: boolean; promptError?: Error } = {},
): FakeSessionControls & { unsubscribeCalls: () => number } {
  let captured: Record<string, unknown> = {}
  let aborts = 0
  let unsubscribes = 0
  const listeners: Array<(e: unknown) => void> = []
  const controls: FakeSessionControls & { unsubscribeCalls: () => number } = {
    createSession: (async (args: Record<string, unknown>) => {
      captured = args
      return {
        session: {
          subscribe(listener: (e: unknown) => void) {
            listeners.push(listener)
            // 真实 SDK 返回 unsubscribe 函数（agent-session.d.ts:235）——假会话镜像这个形态，
            // 好让「消费者提前 break 必须 unsubscribe」这条断言有牙。
            return () => {
              unsubscribes += 1
            }
          },
          prompt() {
            for (const e of events) for (const l of listeners) l(e)
            if (promptError) return Promise.reject(promptError)
            if (hang) return new Promise<void>((resolve) => { controls.resolvePrompt = resolve })
            return Promise.resolve()
          },
          abort() {
            aborts += 1
            controls.resolvePrompt?.()
            return Promise.resolve()
          },
        },
      }
    }) as unknown as CreatePiSession,
    capturedArgs: () => captured,
    abortCalls: () => aborts,
    unsubscribeCalls: () => unsubscribes,
  }
  return controls
}

/** 假会话：createSession 本身要等 delayMs 才 resolve，用来复现"窗口期内 abort"竞态。 */
function makeDelayedFakeSession(delayMs: number) {
  let promptCalled = false
  let aborts = 0
  const createSession = (async (args: Record<string, unknown>) => {
    void args
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return {
      session: {
        subscribe() {
          return () => {}
        },
        prompt() {
          promptCalled = true
          return Promise.resolve()
        },
        abort() {
          aborts += 1
          return Promise.resolve()
        },
      },
    }
  }) as unknown as CreatePiSession
  return { createSession, promptCalled: () => promptCalled, abortCalls: () => aborts }
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const item of iterable) out.push(item)
  return out
}

describe('runPiSession', () => {
  test('事件按序透出，prompt 结束后生成器完结（流尾追加合成终态，见下方"预算护栏与合成终态"用例组）', async () => {
    const events = [{ type: 'agent_start' }, { type: 'turn_start' }, { type: 'agent_end' }]
    const fake = makeFakeSession(events)
    const got = await collect(runPiSession({ prompt: 'hi', options: makeOptions(), createSession: fake.createSession }))
    expect(got).toEqual([...events, { type: PI_RUN_END_MESSAGE_TYPE }])
  })

  test('隔离装配入参：model/cwd/agentDir/tools/resourceLoader 全落到 createSession，agentDir 已建目录', async () => {
    const fake = makeFakeSession([])
    const options = makeOptions()
    rmSync(options.agentDir, { recursive: true, force: true })
    await collect(runPiSession({ prompt: 'hi', options, createSession: fake.createSession }))
    const args = fake.capturedArgs()
    expect(args.model).toBe(options.model)
    expect(args.cwd).toBe(options.cwd)
    expect(args.agentDir).toBe(options.agentDir)
    expect(args.tools).toEqual(['read', 'bash'])
    expect(existsSync(options.agentDir)).toBe(true)
    const loader = args.resourceLoader as { getSystemPrompt: () => string; getSkills: () => { skills: unknown[] } }
    expect(loader.getSystemPrompt()).toBe('骨架系统提示词')
    expect(loader.getSkills().skills).toEqual([])
  })

  test('extensions/customTools 透传：guard 进 resourceLoader.getExtensions，customTools 进 createSession 入参', async () => {
    const fake = makeFakeSession([])
    const fakeExtension = { path: '<narracat:pi-tool-guard>' } as never
    const fakeTool = { name: 'AskUserQuestion' } as never
    await collect(
      runPiSession({
        prompt: 'hi',
        options: makeOptions({ extensions: [fakeExtension], customTools: [fakeTool] }),
        createSession: fake.createSession,
      }),
    )
    const args = fake.capturedArgs()
    expect(args.customTools).toEqual([fakeTool])
    const loader = args.resourceLoader as { getExtensions: () => { extensions: unknown[] } }
    expect(loader.getExtensions().extensions).toEqual([fakeExtension])
  })

  test('systemPromptAppendix 有值：resourceLoader.getAppendSystemPrompt() 返回 [appendix]（第二个受控口子）', async () => {
    const fake = makeFakeSession([])
    await collect(
      runPiSession({
        prompt: 'hi',
        options: makeOptions({ systemPromptAppendix: '本书 AGENTS.md 正文' }),
        createSession: fake.createSession,
      }),
    )
    const args = fake.capturedArgs()
    const loader = args.resourceLoader as { getAppendSystemPrompt: () => string[] }
    expect(loader.getAppendSystemPrompt()).toEqual(['本书 AGENTS.md 正文'])
  })

  test('systemPromptAppendix 缺省：resourceLoader.getAppendSystemPrompt() 返回 []', async () => {
    const fake = makeFakeSession([])
    await collect(runPiSession({ prompt: 'hi', options: makeOptions(), createSession: fake.createSession }))
    const args = fake.capturedArgs()
    const loader = args.resourceLoader as { getAppendSystemPrompt: () => string[] }
    expect(loader.getAppendSystemPrompt()).toEqual([])
  })

  test('abortController.abort() 传播到 session.abort()', async () => {
    const fake = makeFakeSession([{ type: 'agent_start' }], { hang: true })
    const options = makeOptions()
    const done = collect(runPiSession({ prompt: 'hi', options, createSession: fake.createSession }))
    await new Promise((r) => setTimeout(r, 10))
    options.abortController.abort()
    await done
    expect(fake.abortCalls()).toBe(1)
  })

  test('流式输入 prompt fail-loud（切片②再支持）', async () => {
    const fake = makeFakeSession([])
    const iterable = (async function* () { yield 'x' })()
    await expect(collect(runPiSession({ prompt: iterable, options: makeOptions(), createSession: fake.createSession }))).rejects.toThrow('切片②')
  })

  test('prompt 抛错：先透出已到事件，再向消费者抛出', async () => {
    const events = [{ type: 'agent_start' }]
    const fake = makeFakeSession(events, { promptError: new Error('端点炸了') })
    const got: unknown[] = []
    await expect(
      (async () => {
        for await (const e of runPiSession({ prompt: 'hi', options: makeOptions(), createSession: fake.createSession })) got.push(e)
      })(),
    ).rejects.toThrow('端点炸了')
    expect(got).toEqual(events)
  })

  test('消费者提前 break：触发 unsubscribe 且 abort 已跑的会话，不留后台白跑', async () => {
    const events = [{ type: 'agent_start' }, { type: 'turn_start' }]
    const fake = makeFakeSession(events, { hang: true })
    const options = makeOptions()
    const seen: unknown[] = []
    // for-await 的 break 会隐式调用生成器 .return()，且会 await 其返回值——
    // 循环结束时 finally（含内部的 await safeAbort）已经跑完。
    for await (const e of runPiSession({ prompt: 'hi', options, createSession: fake.createSession })) {
      seen.push(e)
      break
    }
    expect(seen).toEqual([events[0]])
    expect(fake.abortCalls()).toBe(1)
    expect(fake.unsubscribeCalls()).toBe(1)
  })

  test('调用前 signal 已 abort：不创建会话/不发起 prompt，立即完结', async () => {
    const fake = makeFakeSession([{ type: 'agent_start' }])
    const options = makeOptions()
    options.abortController.abort()
    const got = await collect(runPiSession({ prompt: 'hi', options, createSession: fake.createSession }))
    expect(got).toEqual([])
    expect(fake.capturedArgs()).toEqual({})
    expect(fake.abortCalls()).toBe(0)
  })

  test('createSession await 窗口期内 abort：会话已建但不发起 prompt，立即中止', async () => {
    const fake = makeDelayedFakeSession(20)
    const options = makeOptions()
    const done = collect(runPiSession({ prompt: 'hi', options, createSession: fake.createSession }))
    await new Promise((r) => setTimeout(r, 5))
    options.abortController.abort()
    const got = await done
    expect(got).toEqual([])
    expect(fake.promptCalled()).toBe(false)
    expect(fake.abortCalls()).toBe(1)
  })
})

describe('runPiSession 预算护栏与合成终态', () => {
  test('自然完结：流尾追加 narracat_pi_run_end，usage 为全程 message_end 聚合（pi 口径→App 口径换算）', async () => {
    const events = [
      { type: 'agent_start' },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 } } },
      { type: 'turn_end', message: {}, toolResults: [] },
      { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 200, output: 30, cacheRead: 0, cacheWrite: 0 } } },
      { type: 'turn_end', message: {}, toolResults: [] },
      { type: 'agent_end', messages: [] },
    ]
    const fake = makeFakeSession(events)
    const got = await collect(runPiSession({ prompt: 'hi', options: makeOptions(), createSession: fake.createSession }))
    expect(got.slice(0, events.length)).toEqual(events)
    expect(got[events.length]).toEqual({
      type: PI_RUN_END_MESSAGE_TYPE,
      usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5 },
    })
    expect(got.length).toBe(events.length + 1)
  })

  test('无 usage 数据时 narracat_pi_run_end 不带 usage 字段', async () => {
    const fake = makeFakeSession([{ type: 'agent_start' }, { type: 'agent_end', messages: [] }])
    const got = await collect(runPiSession({ prompt: 'hi', options: makeOptions(), createSession: fake.createSession }))
    expect(got[got.length - 1]).toEqual({ type: PI_RUN_END_MESSAGE_TYPE })
  })

  test('回合数触顶：第 maxTurns 个 turn_end 仍要继续（stopReason=toolUse）触发 session.abort，流尾 yield narracat_pi_max_turns 而非 run_end', async () => {
    const events = [
      { type: 'turn_end', message: { stopReason: 'toolUse' }, toolResults: [] },
      { type: 'turn_end', message: { stopReason: 'toolUse' }, toolResults: [] },
      { type: 'turn_end', message: { stopReason: 'toolUse' }, toolResults: [] },
    ]
    const fake = makeFakeSession(events)
    const got = await collect(
      runPiSession({ prompt: 'hi', options: makeOptions({ maxTurns: 2 }), createSession: fake.createSession }),
    )
    expect(fake.abortCalls()).toBe(1)
    expect(got[got.length - 1]).toEqual({ type: PI_MAX_TURNS_MESSAGE_TYPE })
    expect(got.filter((e) => (e as { type?: string }).type === PI_RUN_END_MESSAGE_TYPE)).toEqual([])
  })

  test('精确边界：第 maxTurns 个 turn_end 恰好收笔（stopReason=stop）算自然完结，不误报回合上限', async () => {
    const events = [
      { type: 'turn_end', message: { stopReason: 'toolUse' }, toolResults: [] },
      { type: 'turn_end', message: { stopReason: 'stop' }, toolResults: [] },
      { type: 'agent_end', messages: [] },
    ]
    const fake = makeFakeSession(events)
    const got = await collect(
      runPiSession({ prompt: 'hi', options: makeOptions({ maxTurns: 2 }), createSession: fake.createSession }),
    )
    expect(fake.abortCalls()).toBe(0)
    expect(got[got.length - 1]).toEqual({ type: PI_RUN_END_MESSAGE_TYPE })
    expect(got.filter((e) => (e as { type?: string }).type === PI_MAX_TURNS_MESSAGE_TYPE)).toEqual([])
  })

  test('同错连犯（issue #111 / #112）：同一工具连续 3 次报同样的错 → session.abort，流尾 yield 同错终态而非 run_end / max_turns', async () => {
    const badCall = {
      type: 'tool_execution_end',
      toolCallId: 'tc',
      toolName: 'mcp__narracat_memory__novel_submit_state_vocabulary',
      isError: true,
      result: { content: [{ type: 'text', text: 'Validation failed for tool "x":\n  - payload: must be object\n\nReceived arguments:\n{"payload":""}' }] },
    }
    const events = [
      badCall,
      { type: 'turn_end', message: { stopReason: 'toolUse' }, toolResults: [] },
      badCall,
      { type: 'turn_end', message: { stopReason: 'toolUse' }, toolResults: [] },
      badCall,
      { type: 'turn_end', message: { stopReason: 'toolUse' }, toolResults: [] },
    ]
    const fake = makeFakeSession(events)
    const got = await collect(
      runPiSession({ prompt: 'hi', options: makeOptions({ maxTurns: 3 }), createSession: fake.createSession }),
    )
    expect(fake.abortCalls()).toBe(1)
    expect(got[got.length - 1]).toEqual({
      type: PI_REPEATED_TOOL_FAILURE_MESSAGE_TYPE,
      toolName: 'mcp__narracat_memory__novel_submit_state_vocabulary',
    })
    const types = got.map((e) => (e as { type?: string }).type)
    expect(types).not.toContain(PI_RUN_END_MESSAGE_TYPE)
    expect(types).not.toContain(PI_MAX_TURNS_MESSAGE_TYPE)
  })

  test('用户 abort：不 yield 任何合成终态（取消收口交给 run-manager）', async () => {
    const fake = makeFakeSession([{ type: 'agent_start' }], { hang: true })
    const options = makeOptions()
    const done = collect(runPiSession({ prompt: 'hi', options, createSession: fake.createSession }))
    await new Promise((r) => setTimeout(r, 10))
    options.abortController.abort()
    const got = await done
    const types = got.map((e) => (e as { type?: string }).type)
    expect(types).not.toContain(PI_RUN_END_MESSAGE_TYPE)
    expect(types).not.toContain(PI_MAX_TURNS_MESSAGE_TYPE)
  })

  test('模型错误终态（message_end stopReason=error）后不再 yield run_end（避免自相矛盾终态）', async () => {
    const events = [
      { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '端点 500', usage: {} } },
      { type: 'agent_end', messages: [] },
    ]
    const fake = makeFakeSession(events)
    const got = await collect(runPiSession({ prompt: 'hi', options: makeOptions(), createSession: fake.createSession }))
    expect(got.map((e) => (e as { type?: string }).type)).not.toContain(PI_RUN_END_MESSAGE_TYPE)
  })

  test('toolCallId 空串兜底（门前项③）：start 补发进程内唯一合成号，end 按 FIFO 配对领号', async () => {
    const events = [
      { type: 'tool_execution_start', toolCallId: '', toolName: 'read', args: {} },
      { type: 'tool_execution_start', toolCallId: '', toolName: 'bash', args: {} },
      { type: 'tool_execution_end', toolCallId: '', toolName: 'read', result: {}, isError: false },
      { type: 'tool_execution_end', toolCallId: '', toolName: 'bash', result: {}, isError: false },
      { type: 'tool_execution_start', toolCallId: 'tc-real', toolName: 'ls', args: {} },
    ]
    const fake = makeFakeSession(events)
    const got = (await collect(
      runPiSession({ prompt: 'hi', options: makeOptions(), createSession: fake.createSession }),
    )) as Array<{ type?: string; toolCallId?: string; toolName?: string }>
    const starts = got.filter((e) => e.type === 'tool_execution_start')
    const ends = got.filter((e) => e.type === 'tool_execution_end')
    // 两个缺号 start 拿到互不相同的非空合成号；end 按 FIFO 与 start 同号配对
    expect(starts[0]!.toolCallId).toMatch(/^narracat-missing-tc-\d+$/)
    expect(starts[1]!.toolCallId).toMatch(/^narracat-missing-tc-\d+$/)
    expect(starts[0]!.toolCallId).not.toBe(starts[1]!.toolCallId)
    expect(ends[0]!.toolCallId).toBe(starts[0]!.toolCallId)
    expect(ends[1]!.toolCallId).toBe(starts[1]!.toolCallId)
    // 有真实 id 的事件原样透传
    expect(starts[2]!.toolCallId).toBe('tc-real')
  })

  test('length 截断终态（stopReason=length）与 error 同族：桥不再补发 run_end（映射器已发 run.failed）', async () => {
    const events = [
      { type: 'message_end', message: { role: 'assistant', stopReason: 'length', usage: {} } },
      { type: 'agent_end', messages: [] },
    ]
    const fake = makeFakeSession(events)
    const got = await collect(runPiSession({ prompt: 'hi', options: makeOptions(), createSession: fake.createSession }))
    expect(got.map((e) => (e as { type?: string }).type)).not.toContain(PI_RUN_END_MESSAGE_TYPE)
  })
})

describe('runPiSession 子会话事件通道（切片⑤）', () => {
  function wrapped(message: unknown): PiSubagentEventMessage {
    return { type: PI_SUBAGENT_EVENT_MESSAGE_TYPE, parentToolCallId: 'tc-1', agentId: 'chapter-writer', message }
  }

  /** 子会话事件先经桥透出（哨兵翻译成真实 channel.push，生产路径由 Task 工具触发），再收集其余事件。 */
  async function collectWithChannel(
    channel: ReturnType<typeof createSubagentEventChannel>,
    options: PiRunOptions,
    createSession: CreatePiSession,
  ): Promise<unknown[]> {
    const got: unknown[] = []
    for await (const event of runPiSession({ prompt: 'hi', options, createSession })) {
      const sentinel = event as { type?: string; payload?: PiSubagentEventMessage }
      if (sentinel.type === 'channel:push' && sentinel.payload) {
        channel.push(sentinel.payload)
        continue
      }
      got.push(event)
    }
    return got
  }

  const parentMessageEnd = {
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'stop', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } },
  }

  function childMessageEnd(usage: Record<string, number>, stopReason = 'toolUse') {
    return wrapped({ type: 'message_end', message: { role: 'assistant', stopReason, usage } })
  }

  test('channel 推入的 wrapped 消息进入同一事件流，且子会话 message_end 的 usage 并进父 run 总账', async () => {
    const channel = createSubagentEventChannel()
    const childToolEvent = wrapped({ type: 'tool_execution_start', toolCallId: 'child-1', toolName: 'write', args: {} })
    const childUsage = childMessageEnd({ input: 7, output: 3, cacheRead: 1, cacheWrite: 2 })
    const fake = makeFakeSession([
      parentMessageEnd,
      { type: 'channel:push', payload: childToolEvent },
      { type: 'channel:push', payload: childUsage },
    ])
    const got = await collectWithChannel(channel, makeOptions({ subagentChannel: channel }), fake.createSession)

    expect(got).toContainEqual(childToolEvent)
    expect(got).toContainEqual(childUsage)
    expect(got[got.length - 1]).toEqual({
      type: PI_RUN_END_MESSAGE_TYPE,
      usage: { inputTokens: 107, outputTokens: 23, cacheReadTokens: 1, cacheCreationTokens: 2 },
    })
  })

  test('子会话失败路径（触 maxTurns / 报错 / 被中止，全都不发 run_end）token 仍并账——最贵的三条路径不漏计', async () => {
    for (const failure of [
      // 触回合上限：桥只补 narracat_pi_max_turns，无 run_end
      [childMessageEnd({ input: 40, output: 10, cacheRead: 0, cacheWrite: 0 }), wrapped({ type: PI_MAX_TURNS_MESSAGE_TYPE })],
      // 模型错误终态：message_end stopReason=error，无 run_end
      [childMessageEnd({ input: 40, output: 10, cacheRead: 0, cacheWrite: 0 }, 'error')],
      // 被中止：message_end stopReason=aborted，无 run_end
      [childMessageEnd({ input: 40, output: 10, cacheRead: 0, cacheWrite: 0 }, 'aborted')],
    ]) {
      const channel = createSubagentEventChannel()
      const fake = makeFakeSession([
        parentMessageEnd,
        ...failure.map((payload) => ({ type: 'channel:push', payload })),
      ])
      const got = await collectWithChannel(channel, makeOptions({ subagentChannel: channel }), fake.createSession)
      expect(got[got.length - 1]).toEqual({
        type: PI_RUN_END_MESSAGE_TYPE,
        usage: { inputTokens: 140, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 },
      })
    }
  })

  test('子会话 run_end 不再二次并账（其 usage 本就是自身 message_end 的累加，读上游即可）', async () => {
    const channel = createSubagentEventChannel()
    const fake = makeFakeSession([
      parentMessageEnd,
      { type: 'channel:push', payload: childMessageEnd({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }) },
      {
        type: 'channel:push',
        payload: wrapped({
          type: PI_RUN_END_MESSAGE_TYPE,
          usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
        }),
      },
    ])
    const got = await collectWithChannel(channel, makeOptions({ subagentChannel: channel }), fake.createSession)
    expect(got[got.length - 1]).toEqual({
      type: PI_RUN_END_MESSAGE_TYPE,
      usage: { inputTokens: 107, outputTokens: 23, cacheReadTokens: 0, cacheCreationTokens: 0 },
    })
  })

  test('未传 channel 时行为不变；流尽后退订，后续 push 不再进队', async () => {
    const channel = createSubagentEventChannel()
    const fake = makeFakeSession([{ type: 'agent_start' }])
    const got = await collect(
      runPiSession({ prompt: 'hi', options: makeOptions({ subagentChannel: channel }), createSession: fake.createSession }),
    )
    expect(got).toEqual([{ type: 'agent_start' }, { type: PI_RUN_END_MESSAGE_TYPE }])
    // 生成器已完结 → 退订生效，这条 push 不该抛错也不该被谁消费
    expect(() => channel.push(wrapped({ type: 'agent_start' }))).not.toThrow()
  })
})

describe('runPiSession 会话持久化与 resume（切片⑦）', () => {
  function makeSessionDir(): string {
    return mkdtempSync(join(tmpdir(), 'narracat-pi-sessions-'))
  }

  test('缺省 sessionStore：in-memory 会话，不发 narracat_pi_session（发了 run-manager 会记下无法 resume 的死 id）', async () => {
    const fake = makeFakeSession([{ type: 'agent_start' }])
    const got = await collect(runPiSession({ prompt: 'hi', options: makeOptions(), createSession: fake.createSession }))
    expect(got).toEqual([{ type: 'agent_start' }, { type: PI_RUN_END_MESSAGE_TYPE }])
    const manager = fake.capturedArgs().sessionManager as SessionManager
    expect(manager.isPersisted()).toBe(false)
  })

  test('有 sessionStore.dir：持久化会话，首条消息即 narracat_pi_session 且早于一切 pi 事件', async () => {
    const dir = makeSessionDir()
    const fake = makeFakeSession([{ type: 'agent_start' }])
    const got = await collect(
      runPiSession({ prompt: 'hi', options: makeOptions({ sessionStore: { dir } }), createSession: fake.createSession }),
    )
    const manager = fake.capturedArgs().sessionManager as SessionManager
    expect(manager.isPersisted()).toBe(true)
    expect(manager.getSessionDir()).toBe(dir)
    expect(got[0]).toEqual({ type: PI_SESSION_MESSAGE_TYPE, sessionId: manager.getSessionId() })
    expect(got.slice(1)).toEqual([{ type: 'agent_start' }, { type: PI_RUN_END_MESSAGE_TYPE }])
  })

  test('resume：按 _${id}.jsonl 定位既有会话文件并 open，合成消息携带同一 id', async () => {
    const dir = makeSessionDir()
    const first = SessionManager.create(tmpdir(), dir)
    first.appendMessage({ role: 'user', content: '这本书的 magic 串是 zq-77。', timestamp: Date.now() } as never)
    // pi 只在会话出现 assistant 消息后才把 JSONL 落盘（session-manager.js _persist）——真 run 必有
    // assistant 回复；这里补一条触发 flush，复刻真实会话文件形态。
    first.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '记住了。' }],
      timestamp: Date.now(),
    } as never)
    const sessionId = first.getSessionId()

    const fake = makeFakeSession([])
    const got = await collect(
      runPiSession({
        prompt: 'hi again',
        options: makeOptions({ sessionStore: { dir, resumeSessionId: sessionId } }),
        createSession: fake.createSession,
      }),
    )
    const manager = fake.capturedArgs().sessionManager as SessionManager
    expect(manager.getSessionId()).toBe(sessionId)
    // 续接的会话上下文真实带着上轮消息（createAgentSession 会用它 restore）
    expect(manager.buildSessionContext().messages.length).toBe(2)
    expect(got[0]).toEqual({ type: PI_SESSION_MESSAGE_TYPE, sessionId })
  })

  test('resume 找不到会话文件：建会话前 fail-loud，不发起任何网络调用', async () => {
    const dir = makeSessionDir()
    const fake = makeFakeSession([])
    await expect(
      collect(
        runPiSession({
          prompt: 'hi',
          options: makeOptions({ sessionStore: { dir, resumeSessionId: 'deadbeef-0000-4000-8000-000000000000' } }),
          createSession: fake.createSession,
        }),
      ),
    ).rejects.toThrow('找不到要续接的会话记录')
    expect(fake.capturedArgs()).toEqual({})
  })

  test('findPiSessionFile：拒绝非法 id 形状（不进文件名匹配），多命中取时间戳最新', () => {
    const dir = makeSessionDir()
    expect(findPiSessionFile(dir, '../escape')).toBeUndefined()
    expect(findPiSessionFile(dir, 'a/b')).toBeUndefined()
    writeFileSync(join(dir, '2026-01-01T00-00-00_abcd1234-x.jsonl'), '{}\n')
    writeFileSync(join(dir, '2026-02-01T00-00-00_abcd1234-x.jsonl'), '{}\n')
    expect(findPiSessionFile(dir, 'abcd1234-x')).toBe(join(dir, '2026-02-01T00-00-00_abcd1234-x.jsonl'))
    expect(findPiSessionFile(dir, 'missing-id')).toBeUndefined()
  })

  test('sweepStalePiSessionFiles：删超期 jsonl，留新鲜文件与非 jsonl', () => {
    const dir = makeSessionDir()
    const stale = join(dir, '2026-01-01T00-00-00_old-session.jsonl')
    const fresh = join(dir, '2026-07-31T00-00-00_new-session.jsonl')
    const other = join(dir, 'README.txt')
    writeFileSync(stale, '{}\n')
    writeFileSync(fresh, '{}\n')
    writeFileSync(other, 'not a session\n')
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(stale, eightDaysAgo, eightDaysAgo)
    sweepStalePiSessionFiles(dir)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })
})

describe('runPiSession 工具名同步归一装配（issue #136）', () => {
  test('真会话形状（带 agent.streamFn）被包装：交给 agent-loop 的事件与 result() 里工具名已是 pi 真名', async () => {
    const toolCall = { type: 'toolCall', id: 'call_1', name: 'Read', arguments: { path: 'a.txt' } }
    const message = { role: 'assistant', content: [toolCall], stopReason: 'toolUse' }
    const rawStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'toolcall_end', contentIndex: 0, toolCall, partial: message }
        yield { type: 'done', reason: 'toolUse', message }
      },
      result: async () => message,
    }
    const seenNames: string[] = []
    const agent: { streamFn: (...args: unknown[]) => unknown } = { streamFn: () => rawStream }
    const createSession = (async () => ({
      session: {
        agent,
        subscribe: () => () => {},
        // 模拟 agent-loop：经 agent.streamFn 取流、逐事件消费，再读 result()。
        async prompt() {
          const stream = (await agent.streamFn()) as typeof rawStream
          for await (const event of stream) {
            if (event.type === 'toolcall_end') seenNames.push(event.toolCall.name)
          }
          const final = (await stream.result()) as typeof message
          seenNames.push(final.content[0].name)
        },
        abort: () => Promise.resolve(),
      },
    })) as unknown as CreatePiSession

    await collect(runPiSession({ prompt: 'hi', options: makeOptions({ tools: ['read'] }), createSession }))
    expect(seenNames).toEqual(['read', 'read'])
  })
})
