import { describe, expect, test } from 'bun:test'
import {
  NOVEL_PROJECT_INCOMPLETE_MESSAGE,
  isProjectIncompleteError,
  stripIpcErrorPrefix,
} from './ipc-error'

describe('stripIpcErrorPrefix', () => {
  test('removes the Electron IPC wrapper so the author sees the real message', () => {
    expect(
      stripIpcErrorPrefix(
        "Error invoking remote method 'novel:refresh-status': Error: 缺少 .narracat/config.yaml 或 .narracat/state.yaml",
      ),
    ).toBe('缺少 .narracat/config.yaml 或 .narracat/state.yaml')
  })
})

describe('isProjectIncompleteError', () => {
  test('recognizes an incomplete project even through the IPC wrapper', () => {
    // 判据必须两侧共用同一份文案常量：各写各的字符串，改一处就会静默失配，
    // 损坏项目又会退回「红条 + 重试」的老样子，而且没有测试会红。
    expect(
      isProjectIncompleteError(
        `Error invoking remote method 'novel:refresh-status': Error: ${NOVEL_PROJECT_INCOMPLETE_MESSAGE}`,
      ),
    ).toBe(true)
  })

  test('does not mistake a transient failure for a broken project', () => {
    expect(isProjectIncompleteError('读取超时，请稍后重试')).toBe(false)
  })
})
