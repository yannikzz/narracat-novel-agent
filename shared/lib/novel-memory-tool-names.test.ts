import { describe, expect, test } from 'bun:test'
import {
  MAX_QUALIFIED_TOOL_NAME_LENGTH,
  NOVEL_MEMORY_MCP_SERVER_NAME,
  NOVEL_MEMORY_TOOL_PREFIX,
  qualifyNovelMemoryToolName,
  unqualifyNovelMemoryToolName,
} from './novel-memory-tool-names'

describe('NovelMemory 工具名常量', () => {
  test('前缀由 server 段拼成 mcp__<server>__', () => {
    expect(NOVEL_MEMORY_TOOL_PREFIX).toBe(`mcp__${NOVEL_MEMORY_MCP_SERVER_NAME}__`)
  })

  test('长度上限取各家 wire 里最严的 64（OpenAI Chat Completions）', () => {
    expect(MAX_QUALIFIED_TOOL_NAME_LENGTH).toBe(64)
  })

  test('qualify 与 unqualify 往返还原', () => {
    const engineName = 'novel_list_candidate_characters'
    const qualified = qualifyNovelMemoryToolName(engineName)

    expect(qualified).toBe(`${NOVEL_MEMORY_TOOL_PREFIX}${engineName}`)
    expect(unqualifyNovelMemoryToolName(qualified)).toBe(engineName)
  })

  test('unqualify 对不带本前缀的名字原样返回', () => {
    // 工具面上还有 Read / Grep 这类非 MCP 工具，以及其他 server 的 mcp__ 工具；
    // 剥前缀时不能把它们误伤成空串或截断。
    expect(unqualifyNovelMemoryToolName('Read')).toBe('Read')
    expect(unqualifyNovelMemoryToolName('mcp__other_server__do_thing')).toBe(
      'mcp__other_server__do_thing',
    )
  })
})
