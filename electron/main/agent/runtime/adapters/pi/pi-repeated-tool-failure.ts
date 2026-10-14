/**
 * 同错连犯即停（issue #111 / #112）：同一个工具连续 N 次报**完全相同**的错误，说明模型没有在纠正，
 * 再给机会只是继续计费——会话桥据此中止会话，以 run.failed(reason=repeated-tool-failure) 收口。
 *
 * 真机报告：子 agent 把 `payload` 传成空字符串，pi 的参数校验每次回同一条「must be object」，
 * 模型原样重试到回合上限，一次提交烧掉十多块钱。参数校验失败走 agent-loop 的 immediate 分支，
 * 不经过 afterToolCall，唯一必经的信号是 `tool_execution_end(isError)`，所以判定挂在事件桥上，
 * 主会话与子会话共用同一个桥、各算各的。
 *
 * 判定口径：
 * - 签名 = 工具名 + 错误文本（剥掉 pi 校验错误尾部的「Received arguments」回显——同一个错因下模型
 *   换着花样传坏参数也算没进展）；错误文本变了说明模型在按反馈改，重新计数。
 * - 同名工具成功一次就清零；其它工具（读文件、查记忆）成功不清零——模型常在两次重试之间读一眼资料，
 *   那不算纠正。
 */

export const REPEATED_TOOL_FAILURE_THRESHOLD = 3

const RECEIVED_ARGUMENTS_MARKER = '\n\nReceived arguments:'

export interface RepeatedToolFailure {
  toolName: string
  count: number
}

export interface RepeatedToolFailureTracker {
  /** 喂入 pi 会话事件；第一次达到阈值时返回命中信息，其余情况返回 undefined。 */
  observe(event: Record<string, unknown>): RepeatedToolFailure | undefined
}

function readResultText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return ''
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => (typeof item === 'object' && item !== null && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : ''))
    .join('')
}

function failureSignature(toolName: string, result: unknown): string {
  const text = readResultText(result)
  const markerIndex = text.indexOf(RECEIVED_ARGUMENTS_MARKER)
  return `${toolName}\u0000${(markerIndex >= 0 ? text.slice(0, markerIndex) : text).trim()}`
}

export function createRepeatedToolFailureTracker(threshold = REPEATED_TOOL_FAILURE_THRESHOLD): RepeatedToolFailureTracker {
  let lastToolName: string | undefined
  let lastSignature: string | undefined
  let streak = 0
  let tripped = false

  return {
    observe(event) {
      if (tripped || event.type !== 'tool_execution_end') return undefined
      const toolName = typeof event.toolName === 'string' ? event.toolName : undefined
      if (!toolName) return undefined

      if (event.isError !== true) {
        if (toolName === lastToolName) {
          lastToolName = undefined
          lastSignature = undefined
          streak = 0
        }
        return undefined
      }

      const signature = failureSignature(toolName, event.result)
      if (signature === lastSignature) {
        streak += 1
      } else {
        lastToolName = toolName
        lastSignature = signature
        streak = 1
      }
      if (streak < threshold) return undefined
      tripped = true
      return { toolName, count: streak }
    },
  }
}
