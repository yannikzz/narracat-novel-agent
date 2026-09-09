import { describe, expect, test } from 'bun:test'
import { createDirectChatPrompt, DIRECT_CHAT_SYSTEM_PROMPT } from './runtime-status'

describe('runtime status prompt', () => {
  test('builds a direct chat prompt that does not inspect runtime by default', () => {
    const prompt = createDirectChatPrompt({ threadId: 'thread-1', command: 'freeform', prompt: '你好' })

    expect(prompt).toContain('NarraCat direct conversation')
    expect(prompt).toContain('Do not inspect the project setup or NarraCat Agent Core status')
    expect(prompt).toContain('User message:\n你好')
    expect(prompt).not.toContain('NarraCat runtime status')
  })

  test('direct-chat 系统提示含指令引导段：列出可推荐指令并要求输出可点击的指令原文', () => {
    // 六条指令词必须逐字出现（胶囊正则按 /narracat:xxx 原文匹配）
    for (const command of [
      '/narracat:setup',
      '/narracat:reference',
      '/narracat:world',
      '/narracat:plan',
      '/narracat:write',
      '/narracat:review',
    ]) {
      expect(DIRECT_CHAT_SYSTEM_PROMPT).toContain(command)
    }
    // 引导规则：识别到流程意图时输出指令原文而非自己执行
    expect(DIRECT_CHAT_SYSTEM_PROMPT).toContain('可点击按钮')
    expect(DIRECT_CHAT_SYSTEM_PROMPT).toContain('不要试图自己执行')
    // 既有禁写文件约束不得被删
    expect(DIRECT_CHAT_SYSTEM_PROMPT).toContain('Do not write, edit, delete, or persist files.')
  })
})
