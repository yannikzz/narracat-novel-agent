import { describe, expect, test } from 'bun:test'
import { createRepeatedToolFailureTracker, REPEATED_TOOL_FAILURE_THRESHOLD } from './pi-repeated-tool-failure.ts'

const OUTLINE_TOOL = 'mcp__narracat_memory__novel_submit_outline'

function failure(toolName: string, text: string) {
  return { type: 'tool_execution_end', toolCallId: 'tc', toolName, isError: true, result: { content: [{ type: 'text', text }], details: {} } }
}

function success(toolName: string) {
  return { type: 'tool_execution_end', toolCallId: 'tc', toolName, isError: false, result: { content: [{ type: 'text', text: 'ok' }] } }
}

/** issue #112 原样：pi 校验错误尾部带「Received arguments」回显。 */
function validationFailure(received: string) {
  return failure(
    OUTLINE_TOOL,
    `Validation failed for tool "${OUTLINE_TOOL}":\n  - payload: must be object\n\nReceived arguments:\n${received}`,
  )
}

describe('createRepeatedToolFailureTracker', () => {
  test('同一工具连续报同样的错，第 3 次命中且只命中一次', () => {
    const tracker = createRepeatedToolFailureTracker()
    const event = validationFailure('{\n  "payload": ""\n}')
    expect(tracker.observe(event)).toBeUndefined()
    expect(tracker.observe(event)).toBeUndefined()
    expect(tracker.observe(event)).toEqual({ toolName: OUTLINE_TOOL, count: REPEATED_TOOL_FAILURE_THRESHOLD })
    expect(tracker.observe(event)).toBeUndefined()
  })

  test('错因相同、回显的坏参数不同：仍算没进展', () => {
    const tracker = createRepeatedToolFailureTracker()
    tracker.observe(validationFailure('{ "payload": "" }'))
    tracker.observe(validationFailure('{ "payload": "{}" }'))
    expect(tracker.observe(validationFailure('{ "payload": "null" }'))?.toolName).toBe(OUTLINE_TOOL)
  })

  test('错误文本变了说明模型在按反馈改：重新计数', () => {
    const tracker = createRepeatedToolFailureTracker()
    tracker.observe(failure(OUTLINE_TOOL, '缺少 storylines'))
    tracker.observe(failure(OUTLINE_TOOL, '缺少 storylines'))
    expect(tracker.observe(failure(OUTLINE_TOOL, '伏笔注册表为空'))).toBeUndefined()
    expect(tracker.observe(failure(OUTLINE_TOOL, '伏笔注册表为空'))).toBeUndefined()
    expect(tracker.observe(failure(OUTLINE_TOOL, '伏笔注册表为空'))).toBeDefined()
  })

  test('同名工具成功一次就清零', () => {
    const tracker = createRepeatedToolFailureTracker()
    tracker.observe(failure(OUTLINE_TOOL, '坏了'))
    tracker.observe(failure(OUTLINE_TOOL, '坏了'))
    tracker.observe(success(OUTLINE_TOOL))
    expect(tracker.observe(failure(OUTLINE_TOOL, '坏了'))).toBeUndefined()
    expect(tracker.observe(failure(OUTLINE_TOOL, '坏了'))).toBeUndefined()
  })

  test('两次重试之间读资料（其它工具成功）不算纠正', () => {
    const tracker = createRepeatedToolFailureTracker()
    tracker.observe(failure(OUTLINE_TOOL, '坏了'))
    tracker.observe(success('read'))
    tracker.observe(failure(OUTLINE_TOOL, '坏了'))
    tracker.observe(success('read'))
    expect(tracker.observe(failure(OUTLINE_TOOL, '坏了'))).toBeDefined()
  })

  test('不同工具报同样的错不合并计数；非 tool_execution_end 事件忽略', () => {
    const tracker = createRepeatedToolFailureTracker()
    tracker.observe(failure('read', 'ENOENT'))
    tracker.observe(failure('grep', 'ENOENT'))
    tracker.observe({ type: 'turn_end' })
    expect(tracker.observe(failure('read', 'ENOENT'))).toBeUndefined()
  })
})
