/**
 * Pi 事件映射测试（阶段 2 切片②）：对照 claude-sdk event-mapper 的等价语义重写——
 * 同输入语义 → 同 AgentEvent 断言。fixture 按 pi 0.73.1 真实事件形态手工构造。
 */
import { describe, expect, test } from 'bun:test'
import {
  mapPiMessageToAgentEvents,
  PI_MAX_TURNS_MESSAGE_TYPE,
  PI_RUN_END_MESSAGE_TYPE,
  PI_SESSION_MESSAGE_TYPE,
  PI_SUBAGENT_EVENT_MESSAGE_TYPE,
} from './pi-event-mapper.ts'

const ctx = { runId: 'run-1', messageId: 'assistant-run-1', createdAt: '2026-07-31T00:00:00.000Z' }

describe('mapPiMessageToAgentEvents', () => {
  test('message_update text_delta → message.delta', () => {
    const events = mapPiMessageToAgentEvents(ctx, {
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '第一段', partial: {} },
    })
    expect(events).toEqual([
      { type: 'message.delta', runId: 'run-1', messageId: 'assistant-run-1', text: '第一段', createdAt: ctx.createdAt },
    ])
  })

  test('message_update thinking_delta → reasoning.delta', () => {
    const events = mapPiMessageToAgentEvents(ctx, {
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '思考中', partial: {} },
    })
    expect(events).toEqual([
      { type: 'reasoning.delta', runId: 'run-1', messageId: 'assistant-run-1', text: '思考中', createdAt: ctx.createdAt },
    ])
  })

  test('narracat_pi_session 合成消息零事件产出（切片⑦：只走 readSessionId 侧信道）', () => {
    expect(
      mapPiMessageToAgentEvents(ctx, { type: PI_SESSION_MESSAGE_TYPE, sessionId: 'session-1' }),
    ).toEqual([])
  })

  test('message_update 其它子事件（text_start/toolcall_delta/done）不产出', () => {
    for (const sub of [
      { type: 'text_start', contentIndex: 0, partial: {} },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"pa', partial: {} },
      { type: 'done', reason: 'stop', message: {} },
    ]) {
      expect(mapPiMessageToAgentEvents(ctx, { type: 'message_update', message: {}, assistantMessageEvent: sub })).toEqual([])
    }
  })

  test('tool_execution_start → tool.started（含 title 与 input）', () => {
    const events = mapPiMessageToAgentEvents(ctx, {
      type: 'tool_execution_start',
      toolCallId: 'tc-1',
      toolName: 'bash',
      args: { command: 'echo hi' },
    })
    expect(events).toEqual([
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'tc-1',
        toolName: 'bash',
        title: '调用 bash',
        input: { command: 'echo hi' },
        createdAt: ctx.createdAt,
      },
    ])
  })

  test('tool_execution_end 成功 → tool.completed（content 文本抽取）', () => {
    const events = mapPiMessageToAgentEvents(ctx, {
      type: 'tool_execution_end',
      toolCallId: 'tc-1',
      toolName: 'bash',
      isError: false,
      result: { content: [{ type: 'text', text: 'hi\n' }], details: {} },
    })
    expect(events).toEqual([
      { type: 'tool.completed', runId: 'run-1', toolCallId: 'tc-1', result: 'hi\n', createdAt: ctx.createdAt },
    ])
  })

  test('tool_execution_end isError → tool.failed（空文本回退固定文案）', () => {
    const events = mapPiMessageToAgentEvents(ctx, {
      type: 'tool_execution_end',
      toolCallId: 'tc-2',
      toolName: 'read',
      isError: true,
      result: { content: [] },
    })
    expect(events).toEqual([
      { type: 'tool.failed', runId: 'run-1', toolCallId: 'tc-2', error: '工具调用失败', createdAt: ctx.createdAt },
    ])
  })

  test('Task 结果 details 带异常终态标记 → tool.failed（子会话异常终止，任务卡不谎报成功）', () => {
    for (const [abnormalStop, error] of [
      ['length', '子 agent 单次回复达到输出上限被截断，本次派发未完成，请重试或把任务拆小。'],
      ['error', '子 agent 因模型或服务端错误异常终止，本次派发未完成。'],
    ] as const) {
      const events = mapPiMessageToAgentEvents(ctx, {
        type: 'tool_execution_end',
        toolCallId: 'task-1',
        toolName: 'Task',
        isError: false,
        result: {
          content: [{ type: 'text', text: '⚠️ 子 agent …' }],
          details: { narracatSubagentAbnormalStop: abnormalStop },
        },
      })
      expect(events).toEqual([{ type: 'tool.failed', runId: 'run-1', toolCallId: 'task-1', error, createdAt: ctx.createdAt }])
    }
  })

  test('message_end stopReason=error → run.failed（errorMessage 透传，含 provider 原始错误串）', () => {
    const events = mapPiMessageToAgentEvents(ctx, {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate_limit_error 余额不足', usage: {} },
    })
    expect(events).toEqual([
      { type: 'run.failed', runId: 'run-1', error: '429 rate_limit_error 余额不足', createdAt: ctx.createdAt },
    ])
  })

  test('message_end stopReason=error 无 errorMessage → 回退固定文案', () => {
    const events = mapPiMessageToAgentEvents(ctx, {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', usage: {} },
    })
    expect(events).toEqual([
      { type: 'run.failed', runId: 'run-1', error: 'Pi runtime 运行失败。', createdAt: ctx.createdAt },
    ])
  })

  test('message_end stopReason=aborted / stop / toolUse 不产出（取消由 run-manager 收口；正常回合无终态语义）', () => {
    for (const stopReason of ['aborted', 'stop', 'toolUse']) {
      expect(
        mapPiMessageToAgentEvents(ctx, { type: 'message_end', message: { role: 'assistant', stopReason, usage: {} } }),
      ).toEqual([])
    }
  })

  test('message_end stopReason=length → run.failed 截断人话（生产接线门前项①：截断稿不得静默完成）', () => {
    const events = mapPiMessageToAgentEvents(ctx, {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'length', usage: {} },
    })
    expect(events).toEqual([
      {
        type: 'run.failed',
        runId: 'run-1',
        error: '模型单次回复长度达到上限，本次运行已中止，请重试或把任务拆小。',
        createdAt: ctx.createdAt,
      },
    ])
  })

  test('合成 narracat_pi_run_end → run.completed（usage 透传；无 usage 则不带字段）', () => {
    const usage = { inputTokens: 120, outputTokens: 45, cacheReadTokens: 30 }
    expect(mapPiMessageToAgentEvents(ctx, { type: PI_RUN_END_MESSAGE_TYPE, usage })).toEqual([
      { type: 'run.completed', runId: 'run-1', usage, createdAt: ctx.createdAt },
    ])
    expect(mapPiMessageToAgentEvents(ctx, { type: PI_RUN_END_MESSAGE_TYPE })).toEqual([
      { type: 'run.completed', runId: 'run-1', createdAt: ctx.createdAt },
    ])
  })

  test('合成 narracat_pi_max_turns → run.failed（文案与 SDK 逐字一致，reason 机器可读）', () => {
    expect(mapPiMessageToAgentEvents(ctx, { type: PI_MAX_TURNS_MESSAGE_TYPE })).toEqual([
      {
        type: 'run.failed',
        runId: 'run-1',
        error: 'Agent 本次运行达到回合上限，请稍后重试或提高运行上限。',
        reason: 'max-turns',
        createdAt: ctx.createdAt,
      },
    ])
  })

  test('agent_start/turn_start/turn_end/message_start/tool_execution_update/非对象 不产出', () => {
    for (const message of [
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'turn_end', message: {}, toolResults: [] },
      { type: 'message_start', message: {} },
      { type: 'tool_execution_update', toolCallId: 'tc', toolName: 'bash', args: {}, partialResult: {} },
      { type: 'agent_end', messages: [] },
      'not-an-object',
      null,
    ]) {
      expect(mapPiMessageToAgentEvents(ctx, message)).toEqual([])
    }
  })
})

describe('子会话 wrapped 消息映射（切片⑤）', () => {
  function wrap(inner: unknown, parentToolCallId = 'parent-tc') {
    return { type: PI_SUBAGENT_EVENT_MESSAGE_TYPE, parentToolCallId, agentId: 'chapter-writer', message: inner }
  }

  test('inner tool_execution_start → 带 parentToolCallId 归属的 tool.started', () => {
    expect(
      mapPiMessageToAgentEvents(ctx, wrap({ type: 'tool_execution_start', toolCallId: 'child-1', toolName: 'write', args: { path: 'a.md' } })),
    ).toEqual([
      {
        type: 'tool.started',
        runId: 'run-1',
        messageId: 'assistant-run-1',
        toolCallId: 'child-1',
        toolName: 'write',
        title: '调用 write',
        input: { path: 'a.md' },
        parentToolCallId: 'parent-tc',
        createdAt: ctx.createdAt,
      },
    ])
  })

  test('inner tool_execution_end → 带归属的 tool.completed / tool.failed', () => {
    expect(
      mapPiMessageToAgentEvents(ctx, wrap({ type: 'tool_execution_end', toolCallId: 'child-1', toolName: 'write', isError: false, result: { content: [{ type: 'text', text: '已写入' }] } })),
    ).toEqual([
      { type: 'tool.completed', runId: 'run-1', toolCallId: 'child-1', result: '已写入', parentToolCallId: 'parent-tc', createdAt: ctx.createdAt },
    ])
    expect(
      mapPiMessageToAgentEvents(ctx, wrap({ type: 'tool_execution_end', toolCallId: 'child-2', toolName: 'read', isError: true, result: { content: [] } })),
    ).toEqual([
      { type: 'tool.failed', runId: 'run-1', toolCallId: 'child-2', error: '工具调用失败', parentToolCallId: 'parent-tc', createdAt: ctx.createdAt },
    ])
  })

  test('inner 为 message_update（子会话正文）零事件——不污染主对话转录', () => {
    expect(
      mapPiMessageToAgentEvents(ctx, wrap({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '子正文', partial: {} } })),
    ).toEqual([])
  })

  test('inner 为 message_end error / 合成终态时零事件——子会话失败不误报父 run.failed', () => {
    expect(
      mapPiMessageToAgentEvents(ctx, wrap({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '子会话炸了', usage: {} } })),
    ).toEqual([])
    expect(mapPiMessageToAgentEvents(ctx, wrap({ type: PI_RUN_END_MESSAGE_TYPE, usage: { inputTokens: 5 } }))).toEqual([])
    expect(mapPiMessageToAgentEvents(ctx, wrap({ type: PI_MAX_TURNS_MESSAGE_TYPE }))).toEqual([])
  })

  test('parentToolCallId 缺失或 inner 非对象 → 零事件（脏消息不产半截事件）', () => {
    expect(mapPiMessageToAgentEvents(ctx, { type: PI_SUBAGENT_EVENT_MESSAGE_TYPE, agentId: 'x', message: { type: 'tool_execution_start', toolCallId: 'c', toolName: 'read' } })).toEqual([])
    expect(mapPiMessageToAgentEvents(ctx, wrap('not-an-object'))).toEqual([])
  })
})
