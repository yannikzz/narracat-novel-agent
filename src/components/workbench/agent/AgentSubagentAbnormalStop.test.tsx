import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { mapPiMessageToAgentEvents } from '../../../../electron/main/agent/runtime/adapters/pi/pi-event-mapper'
import type { PiSubagentAbnormalStopDetails } from '../../../../electron/main/agent/runtime/adapters/pi/pi-event-mapper'
import { createEmptyAgentThread, reduceAgentEvent } from '@/lib/agent-events'
import { AgentMessageItem } from './AgentMessageItem'
import { AgentProcessStream, isAgentProcessPart } from './AgentProcessStream'
import type { AgentEvent, AgentMessage } from '@shared/types/agent'

/**
 * 子会话异常终止（#29）的**渲染端**兜底：pi Task 工具结果 → 事件映射器 → 渲染端 reducer → 组件，
 * 整条链路一次跑通。跨层 import 主进程映射器是有意为之——刀 2 的唯一用户可见收益就落在这条链上，
 * 只测映射器（主进程侧）或只测组件（喂手写 part）都会漏掉中间任何一环断掉的情况：details 侧信道
 * 一旦读不出来，工具就是「正常返回」，卡片会退回「完成」且失败原因彻底不显示。
 */
describe('子会话异常终止的任务卡渲染（#29 刀 2）', () => {
  const RUN_ID = 'run-1'
  const CREATED_AT = '2026-08-19T09:00:00.000Z'
  const ctx = { runId: RUN_ID, messageId: `assistant-${RUN_ID}`, createdAt: CREATED_AT }
  /** 与 pi-subagent 产出的 details 同型：键名若改，这里先编译不过（生产者/消费者的类型级绑定）。 */
  const ABNORMAL_STOP_DETAILS: PiSubagentAbnormalStopDetails = { narracatSubagentAbnormalStop: 'length' }
  const RESULT_TEXT = '⚠️ 子 agent 单次回复达到输出上限被截断，本次派发未完成，交付不可信：请核实产物，按需重新派发或把任务拆小。\n\n（子 agent 未产出文本）'
  const ABNORMAL_STOP_REASON = '子 agent 单次回复达到输出上限被截断，本次派发未完成，请重试或把任务拆小。'

  /** 跑一次真实链路：run.started 建消息 → Task 派发开始 → Task 结果落地，返回助手消息。 */
  function reduceTaskDispatch(result: unknown): AgentMessage {
    const runStarted: AgentEvent = {
      type: 'run.started',
      runId: RUN_ID,
      threadId: 'thread-1',
      command: 'write-next',
      prompt: '写第 3 章',
      createdAt: CREATED_AT,
    }
    const events: AgentEvent[] = [
      runStarted,
      ...mapPiMessageToAgentEvents(ctx, {
        type: 'tool_execution_start',
        toolCallId: 'task-1',
        toolName: 'Task',
        args: { subagent_type: 'narracat:chapter-writer', description: '写第 3 章' },
      }),
      ...mapPiMessageToAgentEvents(ctx, {
        type: 'tool_execution_end',
        toolCallId: 'task-1',
        toolName: 'Task',
        // pi 的工具结果没有 isError 字段：异常终止在这一层看起来与成功完全一样。
        isError: false,
        result,
      }),
    ]

    const thread = events.reduce(reduceAgentEvent, createEmptyAgentThread('thread-1'))
    const assistant = thread.messages.find((message) => message.role === 'assistant')
    if (!assistant) throw new Error('助手消息未生成')
    return assistant
  }

  function renderProcessStream(message: AgentMessage): string {
    return renderToStaticMarkup(<AgentProcessStream parts={message.parts.filter(isAgentProcessPart)} defaultOpen />)
  }

  test('异常终止的派发不显示成「完成」，展开后能看到失败原因', () => {
    const html = renderProcessStream(
      reduceTaskDispatch({ content: [{ type: 'text', text: RESULT_TEXT }], details: ABNORMAL_STOP_DETAILS }),
    )

    // 逐项徽章：失败（中性呈现，不用警报色），绝不能是「完成」，也不能说成「已跳过」
    expect(html).toContain('>失败<')
    expect(html).not.toContain('>已跳过<')
    expect(html).not.toContain('>完成<')
    expect(html).toContain('章节写手Agent 写第 3 章')
    // 失败原因对用户可见，且能看出是 length（截断）而非 error
    expect(html).toContain(ABNORMAL_STOP_REASON)
  })

  test('正常收笔的派发照旧显示「完成」（异常终止的呈现只对带标记的结果生效）', () => {
    const html = renderProcessStream(
      reduceTaskDispatch({ content: [{ type: 'text', text: '第 3 章已交付' }], details: undefined }),
    )

    expect(html).toContain('>完成<')
    expect(html).not.toContain('>失败<')
    expect(html).not.toContain(ABNORMAL_STOP_REASON)
  })

  test('折叠态汇总行如实计次「1 次失败」，具体原因仍要展开才看得到', () => {
    // 汇总行沿用「工具级失败不升级成 run 级红色告警」的既有口径，但计次措辞已由「自动调整 N 次」
    // 改为「N 次失败」（#37 刀②）——异常终止算进这一格是对的，它本就是失败，不是自动调整。
    // 仍未做的是把失败原因提到折叠态：那要动汇总行信息密度，超出本刀范围。
    const message = reduceTaskDispatch({
      content: [{ type: 'text', text: RESULT_TEXT }],
      details: ABNORMAL_STOP_DETAILS,
    })
    const html = renderToStaticMarkup(<AgentMessageItem message={message} />)

    expect(html).toContain('执行过程已完成 · 0 项（1 次失败）')
    expect(html).not.toContain(ABNORMAL_STOP_REASON)
  })
})
