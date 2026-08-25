import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  MAX_QUALIFIED_TOOL_NAME_LENGTH,
  NOVEL_MEMORY_TOOL_PREFIX,
  qualifyNovelMemoryToolName,
} from '@shared/lib/novel-memory-tool-names'
import { NARRACAT_NOVEL_MEMORY_MCP_TOOLS } from './allowed-tools'

/**
 * 工具全限定名长度守卫（社区 issue #12）。
 *
 * 越界不会在开发机上暴露：日常用的 deepseek 端点不校验工具名长度，Anthropic 官方给到
 * 128。真正会拒的是 OpenAI Chat Completions wire（上限 64，custom 渠道自 #5 刀 1 起可选），
 * 以及部分把名字截断改写成 hash 的兼容网关——后者更坏，模型收到的是 `Tool not found`，
 * 现象完全不指向长度。所以这条必须是自动守卫，不能靠人记住。
 */
describe('NovelMemory 工具全限定名长度', () => {
  test(`工具面上注册的每个全限定名都不超过 ${MAX_QUALIFIED_TOOL_NAME_LENGTH} 字符`, () => {
    const offenders = NARRACAT_NOVEL_MEMORY_MCP_TOOLS.filter(
      (name) => name.length > MAX_QUALIFIED_TOOL_NAME_LENGTH,
    ).map((name) => `${name}（${name.length}，超 ${name.length - MAX_QUALIFIED_TOOL_NAME_LENGTH}）`)

    // 报出具体是谁、超了多少——守卫红的时候要能直接改，不要只说「有一个太长」。
    expect(offenders).toEqual([])
  })

  test(`引擎 SSOT 里的每个工具都能安全进工具面（不超过 ${MAX_QUALIFIED_TOOL_NAME_LENGTH} 字符）`, () => {
    // 覆盖面比上一条宽：白名单之外的工具（App 确定性直调那批）当下不进工具面、不受限制，
    // 但它们随时可能被加进白名单。在引擎侧就守住，比等加白名单那天才发现要早一步。
    const toolsSource = readFileSync(
      join(import.meta.dir, '../../../../agent-core/narracat/mcp-server/src/tools.ts'),
      'utf-8',
    )
    const engineToolNames = [
      ...new Set([...toolsSource.matchAll(/name:\s*"(novel_[a-z_]+)"/g)].map((match) => match[1])),
    ]

    // 读不到工具定义就是守卫失效（路径变了/正则失配），必须响而不是静默通过。
    expect(engineToolNames.length).toBeGreaterThan(40)

    const offenders = engineToolNames
      .map((name) => qualifyNovelMemoryToolName(name))
      .filter((name) => name.length > MAX_QUALIFIED_TOOL_NAME_LENGTH)
      .map((name) => `${name}（${name.length}）`)

    expect(offenders).toEqual([])
  })

  test('前缀本身留有余量，不至于一加工具就越界', () => {
    // 前缀吃掉的每个字符都从工具名的可用长度里扣。曾用的
    // `mcp__plugin_narracat_novelmemory__` 是 34 字符，只给工具名留 30——而引擎里最长的
    // 工具名有 36 字符，于是 7 个工具直接越界。这条把前缀本身钉在合理范围内。
    expect(NOVEL_MEMORY_TOOL_PREFIX.length).toBeLessThanOrEqual(24)
  })
})
