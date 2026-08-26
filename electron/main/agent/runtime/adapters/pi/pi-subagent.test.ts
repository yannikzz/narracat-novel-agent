/**
 * 子 agent 派发工具与任务卡工具测试（阶段 2 切片⑤ Task 5）：全部走 runSession DI 假子会话生成器，
 * 不打网络。覆盖派发归一/未知名单/并发闸/abort 传播/结果回流/质量门缝/任务卡计数。
 */
import { describe, expect, test } from 'bun:test'
import type { EngineAgentDefinition } from '../../../../engine/engine-agent-registry.ts'
import { PI_MAX_TURNS_MESSAGE_TYPE, PI_SUBAGENT_EVENT_MESSAGE_TYPE } from './pi-event-mapper.ts'
import type { PiRunOptions, RunPiSessionArgs } from './pi-session.ts'
import {
  createSubagentEventChannel,
  createTaskCardTools,
  createTaskTool,
  TASK_CREATE_TOOL_NAME,
  TASK_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
} from './pi-subagent.ts'
import type { CreateTaskToolArgs, PiSubagentEventMessage } from './pi-subagent.ts'

const definitions: Record<string, EngineAgentDefinition> = {
  'chapter-writer': { description: '章节写手', prompt: '写手系统词', tools: ['Read', 'Write'] },
  'memory-keeper': { description: '记忆管家', prompt: '管家系统词' },
}

/** pi 0.73.1 的 assistant 收笔消息形态（本映射只取 content 里的 text 块）。 */
function assistantMessageEnd(text: string, stopReason = 'stop'): Record<string, unknown> {
  return { type: 'message_end', message: { role: 'assistant', stopReason, content: [{ type: 'text', text }] } }
}

type FakeRunSession = CreateTaskToolArgs['runSession']

/** 假子会话：把给定事件逐条 yield 出来，同时记录每次调用的入参（prompt / options）。 */
function makeScriptedSession(events: unknown[]) {
  const calls: RunPiSessionArgs[] = []
  const runSession = ((args: RunPiSessionArgs) => {
    calls.push(args)
    return (async function* () {
      for (const event of events) yield event
    })()
  }) as FakeRunSession
  return { runSession, calls: () => calls }
}

function makeChannelRecorder() {
  const channel = createSubagentEventChannel()
  const seen: PiSubagentEventMessage[] = []
  channel.subscribe((message) => seen.push(message))
  return { channel, seen: () => seen }
}

function makeTaskTool(overrides: Partial<CreateTaskToolArgs> = {}) {
  const { channel } = makeChannelRecorder()
  const childAborts: AbortController[] = []
  const args: CreateTaskToolArgs = {
    loadDefinitions: async () => definitions,
    buildChildRunOptions: (_definition, childAbort) => {
      childAborts.push(childAbort)
      return { abortController: childAbort } as unknown as PiRunOptions
    },
    channel,
    parentSignal: new AbortController().signal,
    cwd: '/tmp/novel-project',
    runSession: makeScriptedSession([]).runSession,
    ...overrides,
  }
  return { tool: createTaskTool(args), childAborts: () => childAborts }
}

function runTool(
  tool: ReturnType<typeof createTaskTool>,
  toolCallId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }> {
  return tool.execute(toolCallId, params as never, signal, undefined, {} as never) as Promise<{
    content: Array<{ type: string; text?: string }>
    details?: unknown
  }>
}

describe('createSubagentEventChannel', () => {
  test('push 同步广播给全部订阅者，退订后不再收到', () => {
    const channel = createSubagentEventChannel()
    const a: PiSubagentEventMessage[] = []
    const b: PiSubagentEventMessage[] = []
    const unsubscribeA = channel.subscribe((m) => a.push(m))
    channel.subscribe((m) => b.push(m))
    const message: PiSubagentEventMessage = {
      type: PI_SUBAGENT_EVENT_MESSAGE_TYPE,
      parentToolCallId: 'tc-1',
      agentId: 'chapter-writer',
      message: { type: 'agent_start' },
    }
    channel.push(message)
    unsubscribeA()
    channel.push({ ...message, parentToolCallId: 'tc-2' })
    expect(a).toEqual([message])
    expect(b).toHaveLength(2)
  })
})

describe('createTaskTool 派发', () => {
  test('Task(narracat:chapter-writer) 归一前缀查注册表，子事件全部包成 PiSubagentEventMessage 推入 channel', async () => {
    const { channel, seen } = makeChannelRecorder()
    const events = [{ type: 'agent_start' }, assistantMessageEnd('第一章正文已写完')]
    const scripted = makeScriptedSession(events)
    const { tool } = makeTaskTool({ channel, runSession: scripted.runSession })

    expect(tool.name).toBe(TASK_TOOL_NAME)
    const result = await runTool(tool, 'tc-1', { subagent_type: 'narracat:chapter-writer', prompt: '写第一章' })

    expect(scripted.calls()).toHaveLength(1)
    expect(scripted.calls()[0].prompt).toBe('写第一章')
    expect(seen().map((m) => m.message)).toEqual(events)
    expect(seen().every((m) => m.type === PI_SUBAGENT_EVENT_MESSAGE_TYPE)).toBe(true)
    expect(seen().every((m) => m.parentToolCallId === 'tc-1')).toBe(true)
    expect(seen().every((m) => m.agentId === 'chapter-writer')).toBe(true)
    expect(result.content[0].text).toBe('第一章正文已写完')
  })

  test('无前缀写法同样命中；子会话装配拿到的是注册表定义本体', async () => {
    const captured: EngineAgentDefinition[] = []
    const { tool } = makeTaskTool({
      buildChildRunOptions: (definition, childAbort) => {
        captured.push(definition)
        return { abortController: childAbort } as unknown as PiRunOptions
      },
      runSession: makeScriptedSession([assistantMessageEnd('ok')]).runSession,
    })
    await runTool(tool, 'tc-1', { subagent_type: 'memory-keeper', prompt: '归档' })
    expect(captured).toEqual([definitions['memory-keeper']])
  })

  test("thinking 档位透传：派发带 thinking:'off' → 子会话按关思考装配", async () => {
    const modes: string[] = []
    const { tool } = makeTaskTool({
      buildChildRunOptions: (_definition, childAbort, thinking) => {
        modes.push(thinking)
        return { abortController: childAbort } as unknown as PiRunOptions
      },
      runSession: makeScriptedSession([assistantMessageEnd('ok')]).runSession,
    })
    await runTool(tool, 'tc-1', { subagent_type: 'memory-keeper', prompt: '归档', thinking: 'off' })
    expect(modes).toEqual(['off'])
  })

  test('thinking 档位失败方向朝「维持现状」：省略或写错一律回落 provider 默认', async () => {
    const modes: string[] = []
    const { tool } = makeTaskTool({
      buildChildRunOptions: (_definition, childAbort, thinking) => {
        modes.push(thinking)
        return { abortController: childAbort } as unknown as PiRunOptions
      },
      runSession: makeScriptedSession([assistantMessageEnd('ok')]).runSession,
    })
    await runTool(tool, 'tc-1', { subagent_type: 'memory-keeper', prompt: '归档' })
    await runTool(tool, 'tc-2', { subagent_type: 'memory-keeper', prompt: '归档', thinking: 'on' })
    await runTool(tool, 'tc-3', { subagent_type: 'memory-keeper', prompt: '归档', thinking: 'OFF' })
    // 漏传/拼错最多是没省下 token，绝不能反过来把某个环节的思考悄悄关掉。
    expect(modes).toEqual(['provider-default', 'provider-default', 'provider-default'])
  })

  test('注册表解析失败 fail-loud：错误原样冒泡成工具 isError 结果，不吞成空名单', async () => {
    const { tool } = makeTaskTool({
      loadDefinitions: async () => {
        throw new Error('agents/chapter-writer.md 读取失败')
      },
    })
    await expect(runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' })).rejects.toThrow(
      'agents/chapter-writer.md 读取失败',
    )
  })

  test('注册表解析懒执行且只跑一次：无派发不解析，多次派发共用同一份', async () => {
    let loads = 0
    const { tool } = makeTaskTool({
      loadDefinitions: async () => {
        loads += 1
        return definitions
      },
      runSession: makeScriptedSession([assistantMessageEnd('ok')]).runSession,
    })
    expect(loads).toBe(0)
    await runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' })
    await runTool(tool, 'tc-2', { subagent_type: 'memory-keeper', prompt: '归档' })
    expect(loads).toBe(1)
  })

  test('未知 subagent_type：execute 抛错且错误文案含可用名单', async () => {
    const { tool } = makeTaskTool()
    await expect(runTool(tool, 'tc-1', { subagent_type: 'ghost-writer', prompt: 'x' })).rejects.toThrow(
      /未知子 agent「ghost-writer」.*chapter-writer.*memory-keeper/,
    )
  })

  test('并发上限：同时 6 个 execute 只有 4 个在跑（挂起的假生成器观测）', async () => {
    let started = 0
    const releases: Array<() => void> = []
    const runSession = (() =>
      (async function* () {
        started += 1
        await new Promise<void>((resolve) => releases.push(resolve))
        yield assistantMessageEnd('done')
      })()) as FakeRunSession
    const { tool } = makeTaskTool({ runSession })

    const pending = Array.from({ length: 6 }, (_, i) =>
      runTool(tool, `tc-${i}`, { subagent_type: 'chapter-writer', prompt: `任务 ${i}` }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(started).toBe(4)

    for (let i = 0; i < 10; i += 1) {
      while (releases.length > 0) releases.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await Promise.all(pending)
    expect(started).toBe(6)
  })

  test('abort 传播：parentSignal abort 后 childAbort.signal.aborted 为 true，结果以中止报错', async () => {
    const parent = new AbortController()
    const runSession = ((args: RunPiSessionArgs) =>
      (async function* () {
        yield { type: 'agent_start' }
        const options = args.options as PiRunOptions
        await new Promise<void>((resolve) => {
          options.abortController.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      })()) as FakeRunSession
    const { tool, childAborts } = makeTaskTool({ parentSignal: parent.signal, runSession })

    const pending = runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    parent.abort()
    await expect(pending).rejects.toThrow('子 agent 任务已随主任务中止')
    expect(childAborts()).toHaveLength(1)
    expect(childAborts()[0].signal.aborted).toBe(true)
  })

  test('工具级 signal abort 同样桥接到子会话', async () => {
    const toolAbort = new AbortController()
    const runSession = ((args: RunPiSessionArgs) =>
      (async function* () {
        yield { type: 'agent_start' }
        const options = args.options as PiRunOptions
        await new Promise<void>((resolve) => {
          options.abortController.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      })()) as FakeRunSession
    const { tool, childAborts } = makeTaskTool({ runSession })

    const pending = runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' }, toolAbort.signal)
    await new Promise((resolve) => setTimeout(resolve, 10))
    toolAbort.abort()
    await expect(pending).rejects.toThrow('子 agent 任务已随主任务中止')
    expect(childAborts()[0].signal.aborted).toBe(true)
  })

  test('子会话触回合上限：结果文本带「回合上限」提示且保留已完成部分', async () => {
    const { tool } = makeTaskTool({
      runSession: makeScriptedSession([assistantMessageEnd('写到一半'), { type: PI_MAX_TURNS_MESSAGE_TYPE }]).runSession,
    })
    const result = await runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' })
    expect(result.content[0].text).toContain('回合上限')
    expect(result.content[0].text).toContain('写到一半')
  })

  test('子会话零文本：结果回退固定占位文案', async () => {
    const { tool } = makeTaskTool({ runSession: makeScriptedSession([{ type: 'agent_start' }]).runSession })
    const result = await runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' })
    expect(result.content[0].text).toBe('（子 agent 未产出文本）')
  })

  test('子会话 stopReason=length：结果带截断说明并保留已产出部分，details 打异常终态标记', async () => {
    const { tool } = makeTaskTool({
      runSession: makeScriptedSession([assistantMessageEnd('写到一半就被截断了', 'length')]).runSession,
    })
    const result = await runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' })
    expect(result.content[0].text).toContain('输出上限')
    expect(result.content[0].text).toContain('写到一半就被截断了')
    expect(result.details).toEqual({ narracatSubagentAbnormalStop: 'length' })
  })

  test('子会话 stopReason=error 且零文本：结果明确区别于「正常但没说话」', async () => {
    const { tool } = makeTaskTool({
      runSession: makeScriptedSession([
        { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '502', content: [] } },
      ]).runSession,
    })
    const result = await runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' })
    expect(result.content[0].text).not.toBe('（子 agent 未产出文本）')
    expect(result.content[0].text).toContain('异常终止')
    expect(result.content[0].text).toContain('（子 agent 未产出文本）')
    expect(result.details).toEqual({ narracatSubagentAbnormalStop: 'error' })
  })

  test('异常终态粘住：后续正常收笔不把它洗回成功（这一遍交付已不可信）', async () => {
    const { tool } = makeTaskTool({
      runSession: makeScriptedSession([assistantMessageEnd('半章', 'length'), assistantMessageEnd('补了一句', 'stop')])
        .runSession,
    })
    const result = await runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' })
    expect(result.content[0].text).toContain('输出上限')
    expect(result.details).toEqual({ narracatSubagentAbnormalStop: 'length' })
  })

  test('正常收笔零文本不误报异常终止：文案与 details 均与既有行为一致', async () => {
    const { tool } = makeTaskTool({ runSession: makeScriptedSession([assistantMessageEnd('')]).runSession })
    const result = await runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' })
    expect(result.content[0].text).toBe('（子 agent 未产出文本）')
    expect(result.details).toBeUndefined()
  })

  test('结果回流：gate 反馈追加在文本尾部（Task 6 质量门缝，本 Task 以注入假 gate 覆盖）', async () => {
    const gateCalls: Array<[string, string]> = []
    const { tool } = makeTaskTool({
      runSession: makeScriptedSession([assistantMessageEnd('正文已交付')]).runSession,
      gate: async (agentId, cwd) => {
        gateCalls.push([agentId, cwd])
        return ['⚠️ 正文字数偏低', '⚠️ 对白占比不足']
      },
    })
    const result = await runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' })
    expect(gateCalls).toEqual([['chapter-writer', '/tmp/novel-project']])
    expect(result.content[0].text).toBe('正文已交付\n\n⚠️ 正文字数偏低\n⚠️ 对白占比不足')
  })

  test('gate 抛错不阻断：结果仍返回，无 gate 文本', async () => {
    const { tool } = makeTaskTool({
      runSession: makeScriptedSession([assistantMessageEnd('正文已交付')]).runSession,
      gate: async () => {
        throw new Error('state.yaml 损坏')
      },
    })
    const result = await runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' })
    expect(result.content[0].text).toBe('正文已交付')
  })

  test('gate 返回空数组：不追加空行', async () => {
    const { tool } = makeTaskTool({
      runSession: makeScriptedSession([assistantMessageEnd('正文已交付')]).runSession,
      gate: async () => [],
    })
    const result = await runTool(tool, 'tc-1', { subagent_type: 'chapter-writer', prompt: '写' })
    expect(result.content[0].text).toBe('正文已交付')
  })
})

describe('createTaskCardTools', () => {
  test('TaskCreate/TaskUpdate 名称与 schema 字段名对齐 sink 聚合契约（subject/description/taskId/status）', () => {
    const [create, update] = createTaskCardTools()
    expect(create.name).toBe(TASK_CREATE_TOOL_NAME)
    expect(update.name).toBe(TASK_UPDATE_TOOL_NAME)
    expect(Object.keys((create.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
      'subject',
      'description',
      'activeForm',
    ])
    expect(Object.keys((update.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
      'taskId',
      'status',
      'subject',
    ])
  })

  test('execute 返回「任务 #N」文本：TaskCreate 闭包递增计数，TaskUpdate 回读入参 taskId', async () => {
    const [create, update] = createTaskCardTools()
    const first = (await create.execute('tc-1', { subject: '上下文聚合' } as never, undefined, undefined, {} as never)) as {
      content: Array<{ text: string }>
    }
    const second = (await create.execute('tc-2', { subject: '正文生成' } as never, undefined, undefined, {} as never)) as {
      content: Array<{ text: string }>
    }
    const updated = (await update.execute(
      'tc-3',
      { taskId: 2, status: 'in_progress' } as never,
      undefined,
      undefined,
      {} as never,
    )) as { content: Array<{ text: string }> }
    expect(first.content[0].text).toBe('任务 #1 已创建')
    expect(second.content[0].text).toBe('任务 #2 已创建')
    expect(updated.content[0].text).toBe('任务 #2 已更新')
  })

  test('空白 subject 直接 throw 且不消耗号（拒绝条件与 sink 对齐，否则发号永久错位）', async () => {
    const [create] = createTaskCardTools()
    for (const subject of ['', '   ']) {
      await expect(
        create.execute('tc-1', { subject } as never, undefined, undefined, {} as never),
      ).rejects.toThrow('subject')
    }
    // 前两次被拒不该占号：下一条有效任务仍是 #1，与 sink 的 max(id)+1 发号保持同步
    const next = (await create.execute('tc-2', { subject: '上下文聚合' } as never, undefined, undefined, {} as never)) as {
      content: Array<{ text: string }>
    }
    expect(next.content[0].text).toBe('任务 #1 已创建')
  })

  test('每次 createTaskCardTools 计数独立（run 级闭包，不跨 run 串号）', async () => {
    const [createA] = createTaskCardTools()
    await createA.execute('tc-1', { subject: 'A' } as never, undefined, undefined, {} as never)
    const [createB] = createTaskCardTools()
    const result = (await createB.execute('tc-1', { subject: 'B' } as never, undefined, undefined, {} as never)) as {
      content: Array<{ text: string }>
    }
    expect(result.content[0].text).toBe('任务 #1 已创建')
  })
})
