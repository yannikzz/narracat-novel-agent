import { describe, expect, test } from 'bun:test'
import {
  createAddCharacterComposerHandoff,
  createPromoteCandidateComposerHandoff,
  createAgentComposerAdjustPrompt,
  createAgentComposerReferencePrompt,
  createAgentRunRequest,
  filterAgentSlashCommands,
  getAgentComposerAdjustPlaceholder,
  getAgentComposerMenuActions,
  getAgentQuickActionAgentLabel,
  getAgentQuickActionChipLabel,
  getAgentQuickActionCommandLabel,
  getAgentQuickActionDraft,
  getAgentQuickActionMenuDescription,
  getAgentQuickActionMenuLabel,
  getAgentQuickActionPlaceholder,
  getNarraCatCommandHumanLabel,
  isAgentComposerChipDeleteKey,
  isAgentComposerSendKey,
  isAgentComposerSlashCommandMenuOpen,
  resolveAgentQuickActionFromCommandLabel,
  resolveAgentComposerRunAction,
} from './agent-commands'
import { NARRACAT_AGENT_LABELS } from '@/components/workbench/agent/tool-phrase'

describe('agent command helpers', () => {
  test('「+ 角色」入口构建 world 命令 handoff，预填 stub 渐进生长意图', () => {
    const handoff = createAddCharacterComposerHandoff()
    expect(handoff.command).toBe('world')
    expect(handoff.sourceActionId).toBe('workbench-add-character')
    expect(handoff.prompt).toContain('新增一个角色')
    expect(handoff.prompt).toContain('stub')
    expect(handoff.preserveDraft).toBe(true)
  })

  test('候选角色「完善设定」入口把候选名注入 prompt，且不保留草稿（否则名字会丢）', () => {
    const handoff = createPromoteCandidateComposerHandoff('沈昭')
    expect(handoff.command).toBe('world')
    expect(handoff.sourceActionId).toBe('workbench-promote-candidate')
    expect(handoff.prompt).toContain('沈昭')
    // 关键：候选名是核心载荷，必须随 prompt 注入编辑器；preserveDraft 会让 prompt 被丢弃
    expect(handoff.preserveDraft).toBeUndefined()
  })

  test('maps quick actions to command chip labels', () => {
    expect(getAgentQuickActionChipLabel('setup')).toBe('设定')
    expect(getAgentQuickActionChipLabel('reference')).toBe('参考')
    expect(getAgentQuickActionChipLabel('world')).toBe('世界观')
    expect(getAgentQuickActionChipLabel('plan')).toBe('大纲')
    expect(getAgentQuickActionChipLabel('write-next')).toBe('写作')
    expect(getAgentQuickActionChipLabel('recover-write')).toBe('恢复')
    expect(getAgentQuickActionChipLabel('continue')).toBe('续写')
    expect(getAgentQuickActionChipLabel('review')).toBe('审修')
  })

  test('maps quick actions to default draft text', () => {
    expect(getAgentQuickActionDraft('setup')).toBe('开始设定引导')
    expect(getAgentQuickActionDraft('reference')).toBe('分析参考作品')
    expect(getAgentQuickActionDraft('world')).toBe('创建或调整角色与世界观')
    expect(getAgentQuickActionDraft('plan')).toBe('规划全书大纲和章节大纲')
    expect(getAgentQuickActionDraft('write-next')).toBe('写下一章')
    expect(getAgentQuickActionDraft('recover-write')).toBe('继续完成本章')
    expect(getAgentQuickActionDraft('adjust-style')).toBe('调整当前章节风格')
    expect(getAgentQuickActionDraft('revise-character')).toBe('修改角色设定')
  })

  test('maps quick actions to command menu labels and raw command hints', () => {
    expect(getAgentQuickActionMenuLabel('setup')).toBe('设定')
    expect(getAgentQuickActionMenuLabel('reference')).toBe('参考作品')
    expect(getAgentQuickActionMenuLabel('world')).toBe('世界观与角色')
    expect(getAgentQuickActionMenuLabel('plan')).toBe('生成大纲')
    expect(getAgentQuickActionMenuLabel('write-next')).toBe('写下一章')
    expect(getAgentQuickActionMenuLabel('review')).toBe('审修章节')
    expect(getAgentQuickActionCommandLabel('setup')).toBe('/narracat:setup')
    expect(getAgentQuickActionCommandLabel('reference')).toBe('/narracat:reference')
    expect(getAgentQuickActionCommandLabel('write-next')).toBe('/narracat:write')
    expect(getAgentQuickActionCommandLabel('recover-write')).toBe('/narracat:write')
  })

  test('translates raw engine command names into author-readable labels', () => {
    expect(getNarraCatCommandHumanLabel('write')).toBe('写下一章')
    expect(getNarraCatCommandHumanLabel('plan')).toBe('生成大纲')
    expect(getNarraCatCommandHumanLabel('WRITE')).toBe('写下一章')
    // checkpoint.lastCommand 真实落盘格式带章号（"命令 章号"），按首 token 查表并翻章号
    expect(getNarraCatCommandHumanLabel('write 5')).toBe('写下一章（第 5 章）')
    expect(getNarraCatCommandHumanLabel('rewrite 3 3')).toBe('重写（第 3 章）')
    // 未登记的命令名原样返回，不抛错
    expect(getNarraCatCommandHumanLabel('unknown-cmd')).toBe('unknown-cmd')
  })

  test('gives every menu item a plain-language description of what it does', () => {
    expect(getAgentQuickActionMenuDescription('reference')).toBe('添加或重新分析参考书，提炼写作指导')
    expect(getAgentQuickActionMenuDescription('world')).toBe('创建或调整世界观、角色、场景等设定')
    expect(getAgentQuickActionMenuDescription('plan')).toBe('规划全书结构，生成卷与章节大纲')
    expect(getAgentQuickActionMenuDescription('write-next')).toBe('按大纲续写下一章正文并自动审校')
    expect(getAgentQuickActionMenuDescription('review')).toBe('深度审校指定章节，给出修改建议')
    // 未登记说明的动作（非五条产品化指令）安全兜底为空字符串，不抛错
    expect(getAgentQuickActionMenuDescription('setup')).toBe('')
  })

  test('signs each menu item with the Agent responsible for executing it, not the raw command', () => {
    expect(getAgentQuickActionAgentLabel('world')).toBe('世界观策划Agent')
    expect(getAgentQuickActionAgentLabel('plan')).toBe('大纲架构师Agent')
    expect(getAgentQuickActionAgentLabel('write-next')).toBe('章节写手Agent')
    expect(getAgentQuickActionAgentLabel('review')).toBe('连续性审修Agent')
    // reference 由主会话直接执行，无 subagent 派发，署名产品名
    expect(getAgentQuickActionAgentLabel('reference')).toBe('NarraCat')

    // 文案须与 tool-phrase.ts 的 NARRACAT_AGENT_LABELS（对话流里 Agent 人读名的 SSOT）保持一致，防止两处漂移
    expect(getAgentQuickActionAgentLabel('world')).toBe(NARRACAT_AGENT_LABELS['world-curator'])
    expect(getAgentQuickActionAgentLabel('plan')).toBe(NARRACAT_AGENT_LABELS['outline-architect'])
    expect(getAgentQuickActionAgentLabel('write-next')).toBe(NARRACAT_AGENT_LABELS['chapter-writer'])
    expect(getAgentQuickActionAgentLabel('review')).toBe(NARRACAT_AGENT_LABELS['continuity-editor'])
  })

  test('exposes the first composer command menu as five productized actions', () => {
    expect(getAgentComposerMenuActions()).toEqual(['reference', 'world', 'plan', 'write-next', 'review'])
    expect(getAgentComposerMenuActions()).not.toContain('setup')
    expect(getAgentComposerMenuActions()).not.toContain('rewrite')
  })

  test('maps command-specific composer placeholders', () => {
    expect(getAgentQuickActionPlaceholder(null)).toBe('向 Agent 描述任务...')
    expect(getAgentQuickActionPlaceholder('reference')).toBe('描述你想从参考作品中提炼什么...')
    expect(getAgentQuickActionPlaceholder('world')).toBe('描述你想创建或调整的世界观、人设、场景...')
    expect(getAgentQuickActionPlaceholder('plan')).toBe('描述你想规划的故事结构、卷纲或章节方向...')
    expect(getAgentQuickActionPlaceholder('write-next')).toBe('输入章节序号，并描述这一章的关键事件和情绪...')
    expect(getAgentQuickActionPlaceholder('review')).toBe('输入章节序号，并描述你希望重点检查或改进什么...')
  })

  test('opens and filters the slash command menu from a leading slash', () => {
    expect(
      isAgentComposerSlashCommandMenuOpen({
        draft: '/',
        selectedAction: null,
        isRunning: false,
      }),
    ).toBe(true)
    expect(
      isAgentComposerSlashCommandMenuOpen({
        draft: '/',
        selectedAction: 'setup',
        isRunning: false,
      }),
    ).toBe(false)
    expect(filterAgentSlashCommands('/narracat:set')).toEqual(['setup'])
    expect(filterAgentSlashCommands('/narracat:rewrite')).toEqual(['rewrite'])
    expect(filterAgentSlashCommands('/参考')).toEqual(['reference'])
    expect(filterAgentSlashCommands('/审')).toEqual(['review'])
  })

  test('offers five main commands by default while keeping hidden command compatibility by query', () => {
    expect(filterAgentSlashCommands('/')).toEqual(['reference', 'world', 'plan', 'write-next', 'review'])
    expect(filterAgentSlashCommands('/continue')).toEqual([])
    expect(filterAgentSlashCommands('/adjust-style')).toEqual([])
    expect(filterAgentSlashCommands('/revise-character')).toEqual([])
  })

  test('resolves NarraCat command labels to composer actions', () => {
    expect(resolveAgentQuickActionFromCommandLabel('/narracat:setup')).toBe('setup')
    expect(resolveAgentQuickActionFromCommandLabel('/narracat:reference')).toBe('reference')
    expect(resolveAgentQuickActionFromCommandLabel('/narracat:write')).toBe('write-next')
    expect(resolveAgentQuickActionFromCommandLabel('/narracat:review')).toBe('review')
    expect(resolveAgentQuickActionFromCommandLabel('/narracat:rewrite')).toBe('rewrite')
    expect(resolveAgentQuickActionFromCommandLabel('/narracat:missing')).toBeNull()
  })

  test('uses freeform command when no quick action is selected', () => {
    expect(createAgentRunRequest({ threadId: 'thread-1', prompt: '调整第 42 章节奏' })).toEqual({
      threadId: 'thread-1',
      command: 'freeform',
      prompt: '调整第 42 章节奏',
    })
  })

  // 回归钉：写章节的 prompt 唯一去处是「桌面侧用户补充意图」——引擎会把它当作者对本章提的要求。
  // 一旦把产品默认文案当成作者的话发下去，引擎会回报一条作者从没提过的要求，
  // 而「连续几章没提要求」永远不成立，那道确认门就再也关不掉。
  test('never sends the placeholder draft as if the author had asked for something', () => {
    const fromEmptyComposer = createAgentRunRequest({ threadId: 'thread-1', action: 'write-next', prompt: '' })
    const fromDefaultDraft = createAgentRunRequest({
      threadId: 'thread-1',
      action: 'write-next',
      prompt: getAgentQuickActionDraft('write-next'),
    })
    const fromWorkbenchButton = createAgentRunRequest({
      threadId: 'thread-1',
      action: 'write-next',
      prompt: '写本章',
      origin: 'action',
    })

    expect(fromEmptyComposer.prompt).toBe('')
    expect(fromDefaultDraft.prompt).toBe('')
    expect(fromWorkbenchButton.prompt).toBe('')
  })

  test('keeps what the author actually typed for the chapter', () => {
    expect(
      createAgentRunRequest({ threadId: 'thread-1', action: 'write-next', prompt: '这一章节奏快一点，少写心理' }).prompt,
    ).toBe('这一章节奏快一点，少写心理')
  })

  test('still fills in the default draft for commands whose prompt is the argument', () => {
    expect(createAgentRunRequest({ threadId: 'thread-1', action: 'world', prompt: '' }).prompt).toBe(
      getAgentQuickActionDraft('world'),
    )
  })

  test('carries engineContext on freeform requests that need the NarraCat engine', () => {
    expect(
      createAgentRunRequest({
        threadId: 'thread-1',
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
  })

  test('falls back to quick action prompt for empty draft text', () => {
    expect(createAgentRunRequest({ threadId: 'thread-1', action: 'rewrite', prompt: '   ' })).toEqual({
      threadId: 'thread-1',
      command: 'rewrite',
      prompt: '重写当前章节',
    })
  })

  test('normalizes generic review drafts to the selected chapter argument', () => {
    expect(
      createAgentRunRequest({
        threadId: 'thread-1',
        action: 'review',
        prompt: '审修当前章节',
        projectPath: '/novels/stars',
        selectedChapter: 3,
      }),
    ).toEqual({
      threadId: 'thread-1',
      command: 'review',
      prompt: '3',
      projectPath: '/novels/stars',
      selectedChapter: 3,
    })
  })

  test('normalizes generic rewrite drafts to the selected chapter argument', () => {
    expect(
      createAgentRunRequest({
        threadId: 'thread-1',
        action: 'rewrite',
        prompt: '重写当前章节',
        projectPath: '/novels/stars',
        selectedChapter: 3,
      }),
    ).toEqual({
      threadId: 'thread-1',
      command: 'rewrite',
      prompt: '3',
      projectPath: '/novels/stars',
      selectedChapter: 3,
    })
  })

  test('preserves custom review and rewrite arguments', () => {
    expect(
      createAgentRunRequest({
        threadId: 'thread-1',
        action: 'review',
        prompt: '2-4',
        projectPath: '/novels/stars',
        selectedChapter: 3,
      }).prompt,
    ).toBe('2-4')
    expect(
      createAgentRunRequest({
        threadId: 'thread-1',
        action: 'rewrite',
        prompt: 'vol-02',
        projectPath: '/novels/stars',
        selectedChapter: 3,
      }).prompt,
    ).toBe('vol-02')
  })

  test('includes project context for side-effecting quick actions', () => {
    expect(
      createAgentRunRequest({
        threadId: 'thread-1',
        action: 'write-next',
        prompt: '继续',
        projectPath: '/novels/stars',
        selectedChapter: 1,
      }),
    ).toEqual({
      threadId: 'thread-1',
      command: 'write-next',
      prompt: '继续',
      projectPath: '/novels/stars',
      selectedChapter: 1,
    })
  })

  test('includes the workbench generation target when provided', () => {
    expect(
      createAgentRunRequest({
        threadId: 'thread-1',
        action: 'plan',
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

  test('adjust handoff 占位提示带动词与目标名', () => {
    expect(getAgentComposerAdjustPlaceholder({ targetLabel: '第 12 章正文', verb: '调整' })).toBe(
      '说说你想怎么调整第 12 章正文…',
    )
  })

  test('adjust 提交时把用户要求包进带边界约束的完整 prompt，且形状与旧模板同构', () => {
    const prompt = createAgentComposerAdjustPrompt({ targetLabel: '第 12 章正文', verb: '调整' }, ' 主角别这么快原谅反派 ')
    expect(prompt.startsWith('需要调整第 12 章正文，要求：主角别这么快原谅反派')).toBe(true)
    expect(prompt).toContain('边界：只围绕当前目标调整')
  })

  test('combines composer reference context with the user requirement for Agent runs', () => {
    const prompt = createAgentComposerReferencePrompt({
      prompt: '强化这里的压迫感。',
      referenceContext: {
        sourceTitle: '第 001 章 · 正文',
        text: '林舟醒来，舰队等待他的命令。',
      },
    })

    expect(prompt).toContain('引用上下文：')
    expect(prompt).toContain('来源：第 001 章 · 正文')
    expect(prompt).toContain('```text\n林舟醒来，舰队等待他的命令。\n```')
    expect(prompt).toContain('用户要求：\n强化这里的压迫感。')
  })

  test('includes project context for project-scoped freeform chat', () => {
    expect(
      createAgentRunRequest({
        threadId: 'thread-1',
        action: null,
        prompt: '聊一下角色动机',
        projectPath: '/novels/stars',
        selectedChapter: 1,
      }),
    ).toEqual({
      threadId: 'thread-1',
      command: 'freeform',
      prompt: '聊一下角色动机',
      projectPath: '/novels/stars',
      selectedChapter: 1,
    })
  })

  test('uses the detected side-effect action when the user sends a suggested command', () => {
    expect(
      resolveAgentComposerRunAction({
        selectedAction: null,
        suggestedAction: 'setup',
      }),
    ).toBe('setup')
  })

  test('keeps explicit freeform sends from using suggested commands', () => {
    expect(
      resolveAgentComposerRunAction({
        selectedAction: null,
        suggestedAction: 'world',
        forceFreeform: true,
      }),
    ).toBeNull()
  })

  test('prefers an explicit selected command over a suggested command', () => {
    expect(
      resolveAgentComposerRunAction({
        selectedAction: 'plan',
        suggestedAction: 'world',
      }),
    ).toBe('plan')
  })

  test('sends on Enter but keeps Shift Enter for newlines', () => {
    expect(isAgentComposerSendKey({ key: 'Enter', shiftKey: false })).toBe(true)
    expect(isAgentComposerSendKey({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(isAgentComposerSendKey({ key: 'a', shiftKey: false })).toBe(false)
  })

  test('does not send while an IME composition is active', () => {
    expect(isAgentComposerSendKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false)
  })

  test('removes a leading chip from the editor with delete keys only at the text start', () => {
    expect(isAgentComposerChipDeleteKey({ key: 'Backspace', hasChip: true, caretAtStart: true })).toBe(true)
    expect(isAgentComposerChipDeleteKey({ key: 'Delete', hasChip: true, caretAtStart: true })).toBe(true)
    expect(isAgentComposerChipDeleteKey({ key: 'Backspace', hasChip: false, caretAtStart: true })).toBe(false)
    expect(isAgentComposerChipDeleteKey({ key: 'Backspace', hasChip: true, caretAtStart: false })).toBe(false)
    expect(isAgentComposerChipDeleteKey({ key: 'Backspace', hasChip: true, caretAtStart: true, isComposing: true })).toBe(false)
  })
})
