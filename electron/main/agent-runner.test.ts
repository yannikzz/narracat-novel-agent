import { describe, expect, test } from 'bun:test'
import { normalizeAgentRunRequest } from './agent-runner'

describe('normalizeAgentRunRequest', () => {
  test('accepts existing agent commands for runtime status routing', () => {
    expect(
      normalizeAgentRunRequest({ threadId: 'thread-1', command: 'write-next', prompt: '继续写15章' })
    ).toEqual({ threadId: 'thread-1', command: 'write-next', prompt: '继续写15章' })
    expect(
      normalizeAgentRunRequest({ threadId: 'thread-1', command: 'recover-write', prompt: '继续完成本章' })
    ).toEqual({ threadId: 'thread-1', command: 'recover-write', prompt: '继续完成本章' })
  })

  // 回归钉：作者没补充要求时渲染端传空 prompt（产品默认文案不当作者的话往下发）。
  // 这道校验曾经一律要求非空，真机上表现为「任务启动失败，请重试」——而渲染端单测全绿，
  // 因为缺陷正好落在两个进程的接缝上。
  test('accepts an empty prompt for chapter writing, where prompt is the author note not the task', () => {
    expect(normalizeAgentRunRequest({ threadId: 'thread-1', command: 'write-next', prompt: '' })).toEqual({
      threadId: 'thread-1',
      command: 'write-next',
      prompt: '',
    })
    expect(normalizeAgentRunRequest({ threadId: 'thread-1', command: 'recover-write', prompt: '' })).toEqual({
      threadId: 'thread-1',
      command: 'recover-write',
      prompt: '',
    })
  })

  test('still rejects an empty prompt where the prompt IS the task', () => {
    expect(() => normalizeAgentRunRequest({ threadId: 'thread-1', command: 'freeform', prompt: '   ' })).toThrow(
      'Agent 任务缺少 prompt。',
    )
    expect(() => normalizeAgentRunRequest({ threadId: 'thread-1', command: 'world', prompt: '' })).toThrow(
      'Agent 任务缺少 prompt。',
    )
  })

  test('accepts NarraCat command workflow requests', () => {
    expect(
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'setup',
        prompt: '开始设定引导',
        projectPath: '/novels/stars',
      }),
    ).toEqual({
      threadId: 'thread-1',
      command: 'setup',
      prompt: '开始设定引导',
      projectPath: '/novels/stars',
    })

    expect(
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'world',
        prompt: '创建主角和核心门派',
        projectPath: '/novels/stars',
      }),
    ).toMatchObject({ command: 'world' })

    expect(
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'plan',
        prompt: '先规划第一卷',
        projectPath: '/novels/stars',
      }),
    ).toMatchObject({ command: 'plan' })

    expect(
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'reference',
        prompt: '分析参考作品',
        projectPath: '/novels/stars',
      }),
    ).toMatchObject({ command: 'reference', prompt: '分析参考作品' })

    expect(() =>
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'analyze-reference-works',
        prompt: '分析参考作品',
        projectPath: '/novels/stars',
      }),
    ).toThrow('Agent 任务 command 非法。')
  })

  test('normalizes optional novel project context', () => {
    expect(
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '继续写下一章',
        projectPath: '/novels/stars',
        selectedChapter: 1,
      }),
    ).toEqual({
      threadId: 'thread-1',
      command: 'write-next',
      prompt: '继续写下一章',
      projectPath: '/novels/stars',
      selectedChapter: 1,
    })
  })

  test('normalizes optional workbench generation target', () => {
    expect(
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'plan',
        prompt: '请生成全局大纲。',
        projectPath: '/novels/stars',
        target: {
          sectionId: 'blueprint',
          tabId: 'master-outline',
          objectId: 'master-outline',
        },
      }),
    ).toEqual({
      threadId: 'thread-1',
      command: 'plan',
      prompt: '请生成全局大纲。',
      projectPath: '/novels/stars',
      target: {
        sectionId: 'blueprint',
        tabId: 'master-outline',
        objectId: 'master-outline',
      },
    })
  })

  test('normalizes optional origin for action-triggered runs', () => {
    expect(
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '继续写下一章',
        origin: 'action',
      }),
    ).toEqual({
      threadId: 'thread-1',
      command: 'write-next',
      prompt: '继续写下一章',
      origin: 'action',
    })
  })

  test('normalizes optional engineContext for engine-scoped freeform runs', () => {
    expect(
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'freeform',
        prompt: '评估赌注曲线改动',
        engineContext: true,
        projectPath: '/novels/stars',
      }),
    ).toEqual({
      threadId: 'thread-1',
      command: 'freeform',
      prompt: '评估赌注曲线改动',
      engineContext: true,
      projectPath: '/novels/stars',
    })

    expect(
      normalizeAgentRunRequest({ threadId: 'thread-1', command: 'freeform', prompt: '你好' }),
    ).toEqual({ threadId: 'thread-1', command: 'freeform', prompt: '你好' })
  })

  test('rejects non-boolean engineContext', () => {
    expect(() =>
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'freeform',
        prompt: '评估赌注曲线改动',
        engineContext: 'yes',
      }),
    ).toThrow('Agent 任务 engineContext 非法。')
  })

  test('rejects invalid origin', () => {
    expect(() =>
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '继续写下一章',
        origin: 'bogus',
      }),
    ).toThrow('Agent 任务 origin 非法。')

    expect(() =>
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '继续写下一章',
        origin: 1,
      }),
    ).toThrow('Agent 任务 origin 非法。')
  })

  test('accepts reference-works workbench targets for reference analysis runs', () => {
    expect(
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'reference',
        prompt: '分析参考作品',
        projectPath: '/novels/stars',
        target: {
          sectionId: 'reference-works',
          tabId: 'references',
          objectId: 'references',
        },
      }),
    ).toEqual({
      threadId: 'thread-1',
      command: 'reference',
      prompt: '分析参考作品',
      projectPath: '/novels/stars',
      target: {
        sectionId: 'reference-works',
        tabId: 'references',
        objectId: 'references',
      },
    })
  })

  test('rejects invalid selectedChapter context', () => {
    expect(() =>
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'write-next',
        prompt: '继续写下一章',
        selectedChapter: 0,
      }),
    ).toThrow('Agent 任务 selectedChapter 非法。')
  })

  test('rejects invalid workbench generation targets', () => {
    expect(() =>
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'plan',
        prompt: '请生成全局大纲。',
        target: {
          sectionId: 'blueprint',
          tabId: '',
          objectId: 'master-outline',
        },
      }),
    ).toThrow('Agent 任务 target 非法。')

    expect(() =>
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'plan',
        prompt: '请生成全局大纲。',
        target: {
          sectionId: 'chapters',
          tabId: 'master-outline',
          objectId: 'master-outline',
        },
      }),
    ).toThrow('Agent 任务 target 非法。')

    expect(() =>
      normalizeAgentRunRequest({
        threadId: 'thread-1',
        command: 'plan',
        prompt: '请生成全局大纲。',
        target: [],
      }),
    ).toThrow('Agent 任务 target 非法。')
  })
})
