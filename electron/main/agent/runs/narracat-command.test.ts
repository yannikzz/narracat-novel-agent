import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  createNarraCatCommandContinuationPrompt,
  namespaceNarraCatTaskAgentTypes,
  resolveNarraCatCommandRun,
} from './narracat-command'

describe('NarraCat command run resolver', () => {
  const readCommandFile = (_pluginPath: string, commandName: string) =>
    `---\ndescription: ${commandName}\n---\n执行 ${commandName} 流程，读取 $ARGUMENTS 和 \${CLAUDE_PLUGIN_ROOT}/templates。`

  test('resolves setup as an Agent-guided NarraCat command', () => {
    const resolved = resolveNarraCatCommandRun(
      {
        threadId: 'thread-1',
        command: 'setup',
        prompt: '我想写仙侠复仇爽文',
        projectPath: '/novels/stars',
      },
      { pluginPath: '/agent-core/narracat', readCommandFile },
    )

    expect(resolved.projectPath).toBe('/novels/stars')
    expect(resolved.prompt).toContain('执行 NarraCat command：/narracat:setup')
    expect(resolved.prompt).toContain('直接执行内联 command source')
    expect(resolved.prompt).toContain('Agent Core 运行适配器用于加载 subagent、skills 和 NovelMemory MCP')
    expect(resolved.prompt).toContain('subagent_type 必须完整匹配，例如 narracat:continuity-editor')
    expect(resolved.prompt).toContain('必须使用 AskUserQuestion')
    expect(resolved.prompt).toContain('不要用普通 assistant 文本向用户提问')
    expect(resolved.prompt).toContain('所有记忆查询、提交和回滚都必须通过 NarraCat Agent Core 暴露的 NovelMemory MCP 工具')
    expect(resolved.prompt).toContain('Task(narracat:memory-keeper)')
    expect(resolved.prompt).toContain('禁止生成、写入或执行任何直接访问 .narracat/memory.db 的脚本')
    expect(resolved.prompt).toContain('章节正文路径兼容约束')
    expect(resolved.prompt).toContain('manuscript/vol-{VV}/ch-{NNN}.md')
    expect(resolved.prompt).toContain('manuscript/ch-{NNN}.md')
    expect(resolved.prompt).toContain('必须先用 Glob 检查')
    expect(resolved.prompt).toContain('当前小说项目根目录：/novels/stars')
    expect(resolved.prompt).toContain('CLAUDE_PLUGIN_ROOT：/agent-core/narracat')
    expect(resolved.prompt).toContain('$ARGUMENTS：我想写仙侠复仇爽文')
    expect(resolved.prompt).toContain('执行 setup 流程')
    expect(resolved.prompt.startsWith('/')).toBe(false)
    expect(resolved.maxTurns).toBeGreaterThan(12)
  })

  test('resolves reference works analysis as the formal reference command', () => {
    const resolved = resolveNarraCatCommandRun(
      {
        threadId: 'thread-1',
        command: 'reference',
        prompt: '分析参考作品',
        projectPath: '/novels/stars',
        target: {
          sectionId: 'reference-works',
          tabId: 'references',
          objectId: 'references',
        },
      },
      { pluginPath: '/agent-core/narracat', readCommandFile },
    )

    expect(resolved.projectPath).toBe('/novels/stars')
    expect(resolved.prompt).toContain('执行 NarraCat command：/narracat:reference')
    expect(resolved.prompt).not.toContain('执行 NarraCat command：/narracat:setup')
    expect(resolved.prompt).not.toContain('/narracat:analyze-reference-works')
    expect(resolved.prompt).toContain('$ARGUMENTS：分析参考作品')
    expect(resolved.prompt).toContain('执行 reference 流程')
    expect(resolved.prompt).not.toContain('产品化动作：分析参考作品')
    expect(resolved.prompt).not.toContain('生成或更新 `bible/style-analysis-report.md`')
    expect(resolved.prompt).not.toContain('读取现有 `bible/style-guide.md`')
    expect(resolved.prompt).toContain('必须使用 AskUserQuestion')
    expect(resolved.maxTurns).toBeGreaterThanOrEqual(60)
  })

  test('requires command guidance questions to use the desktop question bridge', () => {
    const resolved = resolveNarraCatCommandRun(
      {
        threadId: 'thread-1',
        command: 'review',
        prompt: '1',
        projectPath: '/novels/stars',
      },
      { pluginPath: '/agent-core/narracat', readCommandFile },
    )

    expect(resolved.prompt).toContain('NarraCat command 中每一次需要用户输入、确认、选择、追问或继续/调整决策时')
    expect(resolved.prompt).toContain('必须调用 AskUserQuestion')
    expect(resolved.prompt).toContain('提供 2-4 个可选方向')
  })

  test('normalizes all bundled command Task agent names to SDK plugin-prefixed names', () => {
    const resolved = resolveNarraCatCommandRun(
      {
        threadId: 'thread-1',
        command: 'review',
        prompt: '2',
        projectPath: '/novels/stars',
      },
      {
        pluginPath: '/agent-core/narracat',
        readCommandFile: () =>
          [
            'Task(outline-architect): "大纲规划"',
            'Task(world-curator): "设定操作"',
            'Task(continuity-editor): "写前预检"',
            'Task(chapter-writer): "正文生成"',
            'Task(memory-keeper): "记忆更新"',
          ].join('\n'),
      },
    )

    expect(resolved.prompt).toContain('Task(narracat:outline-architect): "大纲规划"')
    expect(resolved.prompt).toContain('Task(narracat:world-curator): "设定操作"')
    expect(resolved.prompt).toContain('Task(narracat:continuity-editor): "写前预检"')
    expect(resolved.prompt).toContain('Task(narracat:chapter-writer): "正文生成"')
    expect(resolved.prompt).toContain('Task(narracat:memory-keeper): "记忆更新"')
    expect(resolved.prompt).not.toContain('Task(outline-architect)')
    expect(resolved.prompt).not.toContain('Task(world-curator)')
    expect(resolved.prompt).not.toContain('Task(continuity-editor)')
    expect(resolved.prompt).not.toContain('Task(chapter-writer)')
    expect(resolved.prompt).not.toContain('Task(memory-keeper)')
  })

  test('passes world, plan, review, and rewrite intent through NarraCat commands', () => {
    expect(
      resolveNarraCatCommandRun(
        {
          threadId: 'thread-1',
          command: 'world',
          prompt: '创建主角林舟和反派许镜',
          projectPath: '/novels/stars',
        },
        { pluginPath: '/agent-core/narracat', readCommandFile },
      ).prompt,
    ).toContain('执行 NarraCat command：/narracat:world')

    expect(
      resolveNarraCatCommandRun(
        {
          threadId: 'thread-1',
          command: 'plan',
          prompt: '规划第一卷 30 章',
          projectPath: '/novels/stars',
        },
        { pluginPath: '/agent-core/narracat', readCommandFile },
      ).prompt,
    ).toContain('$ARGUMENTS：规划第一卷 30 章')

    const review = resolveNarraCatCommandRun(
      {
        threadId: 'thread-1',
        command: 'review',
        prompt: '1',
        projectPath: '/novels/stars',
      },
      { pluginPath: '/agent-core/narracat', readCommandFile },
    )
    expect(review.prompt).toContain('执行 NarraCat command：/narracat:review')
    expect(review.prompt).toContain('$ARGUMENTS：1')
    expect(review.prompt).toContain('执行 review 流程')
    expect(review.maxTurns).toBeGreaterThanOrEqual(36)

    const rewrite = resolveNarraCatCommandRun(
      {
        threadId: 'thread-1',
        command: 'rewrite',
        prompt: '1',
        projectPath: '/novels/stars',
      },
      { pluginPath: '/agent-core/narracat', readCommandFile },
    )
    expect(rewrite.prompt).toContain('执行 NarraCat command：/narracat:rewrite')
    expect(rewrite.prompt).toContain('$ARGUMENTS：1')
    expect(rewrite.prompt).toContain('执行 rewrite 流程')
    expect(rewrite.maxTurns).toBeGreaterThanOrEqual(72)
  })

  test('requires an active project path', () => {
    expect(() =>
      resolveNarraCatCommandRun(
        {
          threadId: 'thread-1',
          command: 'setup',
          prompt: '开始设定',
        },
        { pluginPath: '/agent-core/narracat', readCommandFile },
      ),
    ).toThrow('需要先打开一个小说项目')
  })

  test('requires bundled setup to consume project genre from config', async () => {
    const commandRoot = join(process.cwd(), 'agent-core', 'narracat', 'commands')
    const setupSource = await readFile(join(commandRoot, 'setup.md'), 'utf-8')

    expect(setupSource).toContain('.narracat/config.yaml')
    expect(setupSource).toContain('genre')
    expect(setupSource).toContain('estimated_total_chapters')
    expect(setupSource).toContain('words_per_chapter')
    expect(setupSource).toContain('style_profile')
  })

  test('passes WritingContextPack to write and rewrite subagents by path', async () => {
    const commandRoot = join(process.cwd(), 'agent-core', 'narracat', 'commands')
    const writeSource = await readFile(join(commandRoot, 'write.md'), 'utf-8')
    const rewriteSource = await readFile(join(commandRoot, 'rewrite.md'), 'utf-8')

    for (const source of [writeSource, rewriteSource]) {
      expect(source).toContain('novel_build_writing_context_pack')
      expect(source).toContain('pack_path')
      expect(source).toContain('WritingContextPack 路径: {pack_path}')
      // 主会话不转写整包 JSON，只透传工具返回的落盘路径
      expect(source).not.toContain('writing_context_pack 对象')
      expect(source).not.toContain('上下文包: {WritingContextPack JSON}')
    }
  })

  test('requires continuity-editor to load WritingContextPack from the handoff path', async () => {
    const agentsRoot = join(process.cwd(), 'agent-core', 'narracat', 'agents')
    const continuityEditorSource = await readFile(join(agentsRoot, 'continuity-editor.md'), 'utf-8')

    expect(continuityEditorSource).toContain('WritingContextPack')
    // 上下文不可用即停，不凭记忆补（措辞可带 markdown 强调，故分别断言「停止」「报告」而非连写）
    expect(continuityEditorSource).toContain('停止')
    expect(continuityEditorSource).toContain('报告')
  })

  test('requires chapter-writer to load the natural-language chapter brief, not WritingContextPack', async () => {
    const agentsRoot = join(process.cwd(), 'agent-core', 'narracat', 'agents')
    const chapterWriterSource = await readFile(join(agentsRoot, 'chapter-writer.md'), 'utf-8')

    // 一热一冷重构：写手只读任务书，不再读 WritingContextPack
    expect(chapterWriterSource).not.toContain('WritingContextPack')
    expect(chapterWriterSource).toContain('任务书')
    // 上下文不可用即停，不凭记忆补（措辞可带 markdown 强调，故分别断言「停止」「报告」而非连写）
    expect(chapterWriterSource).toContain('停止')
    expect(chapterWriterSource).toContain('报告')
    // 唯一上下文来源（措辞含 markdown 强调，分别断言关键词而非连写）
    expect(chapterWriterSource).toContain('唯一')
    expect(chapterWriterSource).toContain('来源')
  })

  test('enforces the per-agent write permission model in writing agents', async () => {
    const agentsRoot = join(process.cwd(), 'agent-core', 'narracat', 'agents')
    const chapterWriterSource = await readFile(join(agentsRoot, 'chapter-writer.md'), 'utf-8')
    const continuityEditorSource = await readFile(join(agentsRoot, 'continuity-editor.md'), 'utf-8')
    const memoryKeeperSource = await readFile(join(agentsRoot, 'memory-keeper.md'), 'utf-8')

    // 写手只持有文件写入，零 MCP 写工具
    expect(chapterWriterSource).toContain('tools: Read, Write')
    expect(chapterWriterSource).not.toContain('mcp__narracat_memory__')
    // 审校与记忆管理员只持有自己产物的提交工具
    expect(continuityEditorSource).toContain('mcp__narracat_memory__novel_submit_review')
    expect(memoryKeeperSource).toContain('mcp__narracat_memory__novel_commit_chapter')
    expect(memoryKeeperSource).toContain('mcp__narracat_memory__novel_submit_extraction')
    expect(memoryKeeperSource).toContain('mcp__narracat_memory__novel_consolidate')
  })
})

describe('namespaceNarraCatTaskAgentTypes', () => {
  test('prefixes all five engine agent names with narracat: when used in Task() syntax', () => {
    const result = namespaceNarraCatTaskAgentTypes('Task(chapter-writer) Task(world-curator)')
    expect(result).toContain('Task(narracat:chapter-writer)')
    expect(result).toContain('Task(narracat:world-curator)')
    expect(result).not.toContain('Task(chapter-writer)')
    expect(result).not.toContain('Task(world-curator)')
  })

  test('applies namespacing to all five narracat engine agents individually', () => {
    const input = [
      'Task(outline-architect)',
      'Task(chapter-writer)',
      'Task(continuity-editor)',
      'Task(world-curator)',
      'Task(memory-keeper)',
    ].join(' ')

    const result = namespaceNarraCatTaskAgentTypes(input)

    expect(result).toContain('Task(narracat:outline-architect)')
    expect(result).toContain('Task(narracat:chapter-writer)')
    expect(result).toContain('Task(narracat:continuity-editor)')
    expect(result).toContain('Task(narracat:world-curator)')
    expect(result).toContain('Task(narracat:memory-keeper)')
  })

  test('does not namespace unknown agent names', () => {
    const result = namespaceNarraCatTaskAgentTypes('Task(unknown-agent) Task(chapter-writer)')
    expect(result).toContain('Task(unknown-agent)')
    expect(result).toContain('Task(narracat:chapter-writer)')
    expect(result).not.toContain('Task(narracat:unknown-agent)')
  })
})

describe('createNarraCatCommandContinuationPrompt', () => {
  test('续聊 prompt 含整章旁路 guard：整章级操作引导走指令，局部小修放行', () => {
    const prompt = createNarraCatCommandContinuationPrompt('帮我重写这一章')
    expect(prompt).toContain('整章写作边界约束')
    expect(prompt).toContain('/narracat:write')
    expect(prompt).toContain('/narracat:rewrite')
    expect(prompt).toContain('局部小修')
    // 用户输入仍在末尾原样携带
    expect(prompt).toContain('帮我重写这一章')
  })
})
