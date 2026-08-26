import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentProcessStream, type AgentProcessPart } from './AgentProcessStream'

describe('AgentProcessStream', () => {
  test('compacts running process parts into one status row with latest action and completed count', () => {
    const parts: AgentProcessPart[] = [
      {
        id: 'reasoning-1',
        type: 'reasoning',
        text: '需要先读取项目上下文',
        status: 'complete',
      },
      {
        id: 'tool-1',
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'Read',
        title: '读取文件',
        status: 'complete',
        input: { file_path: '/Users/chensheng/novels/stars/bible/world.md' },
        summary: '读取 world.md',
        result: '完整世界观正文',
      },
      {
        id: 'data-1',
        type: 'data',
        name: 'context',
        title: '上下文包',
        status: 'complete',
        data: { chapter: 3 },
      },
      {
        id: 'tool-2',
        type: 'tool-call',
        toolCallId: 'tool-2',
        toolName: 'Bash',
        title: '执行命令',
        status: 'running',
        input: { command: 'bun --no-cache run test src/components/workbench/agent' },
      },
    ]

    const html = renderToStaticMarkup(<AgentProcessStream parts={parts} />)

    expect(html).toContain('data-agent-process-stream="true"')
    expect(html).toContain('执行过程：正在执行 bun --no-cache run test src/components/workbench/agent... · 已完成 3 项')
    expect(html).not.toContain('已完成思考')
    expect(html).not.toContain('读取 world.md')
    expect(html).not.toContain('上下文包')
    expect(html).not.toContain('完整世界观正文')
    expect(html).not.toContain('需要先读取项目上下文')
  })

  test('summarizes completed process parts without showing raw results', () => {
    const parts: AgentProcessPart[] = [
      {
        id: 'reasoning-1',
        type: 'reasoning',
        text: '完整思考原文',
        status: 'complete',
      },
      {
        id: 'tool-1',
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'Write',
        title: '写入章节',
        status: 'complete',
        input: { file_path: 'manuscript/ch003.md', content: '第一行\n第二行' },
        summary: '写入 manuscript/ch003.md',
        result: '很长的写入结果',
      },
      {
        id: 'data-1',
        type: 'data',
        name: 'usage',
        title: '用量统计',
        status: 'complete',
        data: { outputTokens: 900 },
      },
    ]

    const html = renderToStaticMarkup(<AgentProcessStream parts={parts} />)

    expect(html).toContain('执行过程已完成 · 3 项')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('完整思考原文')
    expect(html).not.toContain('很长的写入结果')
    expect(html).not.toContain('outputTokens')
  })

  test('renders tool errors as honest failures without escalating to a red run-level rollup', () => {
    const parts: AgentProcessPart[] = [
      {
        id: 'reasoning-1',
        type: 'reasoning',
        text: '这里是不能直接展示的 raw thinking',
        status: 'complete',
      },
      {
        id: 'tool-1',
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'Read',
        title: '读取配置',
        status: 'failed',
        input: { file_path: '/Users/chensheng/novels/stars/.narracat/config.yaml' },
        error: 'Permission denied: config.yaml',
      },
      {
        id: 'tool-2',
        type: 'tool-call',
        toolCallId: 'tool-2',
        toolName: 'Write',
        title: '写入草稿',
        status: 'complete',
        input: { file_path: 'manuscript/ch003.md', content: '正文' },
        result: '完成工具的长 result 不应出现',
      },
    ]

    const html = renderToStaticMarkup(<AgentProcessStream parts={parts} defaultOpen />)

    // 工具报错就说失败：状态机里没有「主动跳过」这一档，把 failed 说成「已跳过」是把
    // 失败美化成主动省略（#37 刀②）。但仍不升级成 run 级红色告警——红色留给终态失败。
    expect(html).toContain('执行过程已完成 · 2 项（1 次失败）')
    expect(html).not.toContain('执行过程失败')
    expect(html).not.toContain('已跳过')
    expect(html).not.toContain('自动调整')
    expect(html).toContain('>失败<')
    expect(html).not.toContain('text-destructive')
    // 错误详情仍可查看，只是不用警报色
    expect(html).toContain('已完成思考')
    expect(html).toContain('读取 config.yaml')
    expect(html).toContain('Permission denied: config.yaml')
    expect(html).toContain('写入 ch003.md +1')
    expect(html).not.toContain('这里是不能直接展示的 raw thinking')
    expect(html).not.toContain('完成工具的长 result 不应出现')
    expect(html).not.toContain('/Users/chensheng/novels/stars/.narracat/config.yaml')
  })

  test('keeps the collapsed summary on the latest running step after an earlier failure', () => {
    const parts: AgentProcessPart[] = [
      {
        id: 'tool-1',
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'Read',
        title: '读取配置',
        status: 'failed',
        input: { file_path: '/Users/chensheng/novels/stars/.narracat/config.yaml' },
        error: 'Permission denied: config.yaml',
      },
      {
        id: 'reasoning-1',
        type: 'reasoning',
        text: '这里是不能直接展示的 raw thinking',
        status: 'running',
      },
    ]

    const html = renderToStaticMarkup(<AgentProcessStream parts={parts} defaultOpen />)

    expect(html).toContain('执行过程：正在整理思路... · 已完成 0 项')
    expect(html).not.toContain('执行过程失败：Permission denied: config.yaml')
    expect(html).toContain('读取 config.yaml')
    expect(html).toContain('Permission denied: config.yaml')
    expect(html).toContain('思考中...')
    expect(html).not.toContain('这里是不能直接展示的 raw thinking')
  })
})
