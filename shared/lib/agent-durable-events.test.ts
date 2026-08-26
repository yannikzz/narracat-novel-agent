import { describe, expect, test } from 'bun:test'
import {
  createEmptyDurableAgentThread,
  reduceAgentDurableEvent,
} from './agent-durable-events'

describe('durable Agent conversation boundaries', () => {
  test('uses only the new segment divider for an explicit new conversation', () => {
    const thread = createEmptyDurableAgentThread('novel:stars')
    const invalidated = reduceAgentDurableEvent(thread, {
      type: 'session.invalidated',
      reason: 'new-conversation',
      createdAt: '2026-07-24T12:00:00.000Z',
    })
    const divided = reduceAgentDurableEvent(invalidated, {
      type: 'conversation.divider-added',
      dividerId: 'divider-seg-2',
      createdAt: '2026-07-24T12:00:00.000Z',
    })

    expect(invalidated.messages).toEqual([])
    expect(divided.messages.map((message) => message.role)).toEqual(['divider'])
  })
})

describe('durable tool events stay readable across versions', () => {
  test('reduces a stored tool event that predates the target field (#37)', () => {
    // target 是 #37 新增的可选字段。用户机器上已有大量不含该字段的落盘事件，
    // 读取端一旦按必填处理，历史会话就会整段读不出来。
    const accepted = reduceAgentDurableEvent(createEmptyDurableAgentThread('novel:legacy'), {
      type: 'run.accepted',
      runId: 'run-legacy',
      command: 'freeform',
      visiblePrompt: '写第 20 章',
      createdAt: '2026-07-24T12:00:00.000Z',
    })
    const reduced = reduceAgentDurableEvent(accepted, {
      type: 'run.tool-summarized',
      runId: 'run-legacy',
      messageId: 'assistant-run-legacy',
      toolCallId: 'tool-legacy',
      toolName: 'Read',
      title: '调用 Read',
      status: 'failed',
      error: 'EISDIR: illegal operation on a directory, read',
      createdAt: '2026-07-24T12:00:00.000Z',
    })

    const toolParts = reduced.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'tool-call')
    expect(toolParts).toEqual([
      expect.objectContaining({ type: 'tool-call', toolCallId: 'tool-legacy', status: 'failed' }),
    ])
  })
})
