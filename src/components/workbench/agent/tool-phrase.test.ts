import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NARRACAT_TOOL_LABELS, getToolPhrase } from './tool-phrase'

describe('getToolPhrase', () => {
  test('summarizes read tools with a filename', () => {
    expect(getToolPhrase('Read', { file_path: '/novels/chapter.md' })).toEqual({
      label: '读取 chapter.md',
      loadingLabel: '正在读取 chapter.md...',
    })
  })

  test('summarizes bash tools with the command', () => {
    expect(getToolPhrase('Bash', { command: 'bun --no-cache test' })).toEqual({
      label: '执行 bun --no-cache test',
      loadingLabel: '正在执行 bun --no-cache test...',
    })
  })

  test('keeps write and edit labels focused on changed filenames', () => {
    expect(getToolPhrase('Write', { file_path: '/novels/stars/manuscript/ch003.md', content: '第一行\n第二行' })).toEqual({
      label: '写入 ch003.md +2',
      loadingLabel: '正在写入 ch003.md +2...',
    })

    expect(getToolPhrase('Edit', { file_path: '/novels/stars/bible/world.md', old_string: '旧设定', new_string: '新设定\n补充' })).toEqual({
      label: '编辑 world.md +2 -1',
      loadingLabel: '正在编辑 world.md +2 -1...',
    })
  })

  test('removes long absolute paths from command summaries', () => {
    const phrase = getToolPhrase('Bash', {
      command: 'bun --no-cache test /Users/chensheng/novels/stars/bible/world.md',
    })

    expect(phrase.label).toBe('执行 bun --no-cache test world.md')
    expect(phrase.loadingLabel).toBe('正在执行 bun --no-cache test world.md...')
    expect(phrase.label).not.toContain('/Users/chensheng')
  })

  test('phrases generic and NarraCat subagents as Agent正在 instead of 正在Agent', () => {
    expect(getToolPhrase('Agent', { description: '整理上下文' })).toEqual({
      label: 'Agent 整理上下文',
      loadingLabel: 'Agent正在整理上下文...',
    })

    expect(getToolPhrase('Task', { subagent_type: 'narracat:chapter-writer' })).toEqual({
      label: '章节写手Agent',
      loadingLabel: '章节写手Agent正在处理...',
    })
  })

  test('phrases TaskCreate/TaskUpdate task-card tool calls', () => {
    expect(getToolPhrase('TaskCreate', { subject: '上下文聚合' })).toEqual({
      label: '添加步骤「上下文聚合」',
      loadingLabel: '正在添加步骤「上下文聚合」...',
    })
    expect(getToolPhrase('TaskCreate', {})).toEqual({
      label: '添加步骤',
      loadingLabel: '正在添加步骤...',
    })
    expect(getToolPhrase('TaskUpdate', { taskId: '1', status: 'in_progress' })).toEqual({
      label: '推进任务进度',
      loadingLabel: '正在推进任务进度...',
    })
    expect(getToolPhrase('TaskUpdate', { taskId: '1', status: 'completed' })).toEqual({
      label: '推进任务进度',
      loadingLabel: '正在推进任务进度...',
    })
    expect(getToolPhrase('TaskUpdate', { taskId: '1', status: 'deleted' })).toEqual({
      label: '更新任务',
      loadingLabel: '正在更新任务...',
    })
  })

  test('falls back safely when input is missing', () => {
    expect(getToolPhrase('NarraCat', undefined)).toEqual({
      label: '调用 NarraCat',
      loadingLabel: '正在调用 NarraCat...',
    })
  })
})

const NM = 'mcp__narracat_memory__'

describe('getToolPhrase · NovelMemory MCP 人读动作名', () => {
  test('已知工具映射为人读动作名', () => {
    expect(getToolPhrase(`${NM}novel_submit_chapter_outline`).label).toBe('提交章节大纲')
    expect(getToolPhrase(`${NM}novel_commit_chapter`).label).toBe('章节入库')
    expect(getToolPhrase(`${NM}novel_submit_review`).label).toBe('提交审校报告')
    expect(getToolPhrase(`${NM}novel_character_state`).label).toBe('查角色状态')
  })

  test('已知工具的 loading 文案也人读化', () => {
    expect(getToolPhrase(`${NM}novel_submit_outline`).loadingLabel).toBe('正在提交全书大纲...')
  })

  test('所有映射工具都不裸露 novel_ / plugin_narracat 技术标识', () => {
    for (const tool of Object.keys(NARRACAT_TOOL_LABELS)) {
      const { label, loadingLabel } = getToolPhrase(`${NM}${tool}`, { chapter: 3 })
      expect(label).not.toMatch(/novel_|plugin_narracat/i)
      expect(loadingLabel).not.toMatch(/novel_|plugin_narracat/i)
    }
  })

  test('未登记的 NovelMemory 工具友好降级，不裸露技术名或报错', () => {
    const { label } = getToolPhrase(`${NM}novel_brand_new_tool`, { chapter: 3 })
    expect(label).toBe('记忆引擎操作')
    expect(label).not.toMatch(/novel_|plugin_narracat/i)
  })

  test('其它 MCP server 保持通用展示（不误伤）', () => {
    expect(getToolPhrase('mcp__other_server__do_thing').label).toBe('OTHER_SERVER / do_thing')
  })

  // 对照测试：agent-core 工具全集 ↔ App 映射 key 一一对应（防新增/删工具漂移）
  test('NARRACAT_TOOL_LABELS 覆盖 mcp-server/tools.ts 全部 novel_* 工具', () => {
    const toolsSource = readFileSync(
      join(import.meta.dir, '../../../../agent-core/narracat/mcp-server/src/tools.ts'),
      'utf-8',
    )
    const declared = [...new Set([...toolsSource.matchAll(/name: "(novel_[a-z_]+)"/g)].map((match) => match[1]))].sort()
    const mapped = Object.keys(NARRACAT_TOOL_LABELS).sort()
    expect(mapped).toEqual(declared)
  })
})

describe('pi runtime tool names (#37 dogfood)', () => {
  // 真机会话取证：pi 用小写内置名（Read→read、Write→write、Grep→grep），且 Glob 已改名为
  // find。换 pi 时 tool-phrase 的 case 没跟着改，这些分支成了死代码，工具卡文案静默退化成
  // 「调用 read」这类兜底黑话——违反「产品面不出现开发黑话」的既有约定。
  const REAL_TOOL_CALLS: Array<[string, Record<string, unknown>]> = [
    ['read', { path: '/novels/x/.narracat/config.yaml' }],
    ['write', { path: '/novels/x/chapters/ch-021.md', content: 'a\nb' }],
    ['find', { pattern: '*.md', path: '/novels/x/bible' }],
    ['grep', { pattern: '林小满', path: '/novels/x' }],
    ['edit', { path: '/novels/x/chapters/ch-021.md' }],
    ['bash', { command: 'ls -la' }],
    ['AskUserQuestion', { question: '要用哪个方向？' }],
  ]

  test('never leaks the raw english tool name to the author', () => {
    // 退化形态不止「调用 read」：default 分支拿到 path 时会吐「read config.yaml」，
    // 同样是把工具标识糊到作者脸上。断言按「label 不以工具名开头」来写，两种都能抓。
    for (const [name, input] of REAL_TOOL_CALLS) {
      const { label } = getToolPhrase(name, input)
      expect(label.startsWith(name)).toBe(false)
      expect(label.startsWith(`调用 ${name}`)).toBe(false)
    }
  })

  test('reads the pi path argument for file tools', () => {
    expect(getToolPhrase('read', { path: '/novels/x/.narracat/config.yaml' }).label).toBe(
      '读取 config.yaml',
    )
    expect(getToolPhrase('write', { path: '/novels/x/chapters/ch-021.md', content: 'a\nb' }).label).toContain(
      'ch-021.md',
    )
    expect(getToolPhrase('find', { pattern: '*.md' }).label).toBe('搜索文件 *.md')
  })
})
