import type {
  AgentComposerAdjustSpec,
  AgentComposerHandoff,
  AgentComposerReferenceContext,
  AgentQuickAction,
  AgentRunTarget,
} from '@/types/agent'
import type { AgentRunRequest } from '@shared/types/ipc'

const QUICK_ACTION_CHIP_LABELS: Record<AgentQuickAction, string> = {
  setup: '设定',
  reference: '参考',
  world: '世界观',
  plan: '大纲',
  'write-next': '写作',
  'recover-write': '恢复',
  continue: '续写',
  rewrite: '重写',
  review: '审修',
  'adjust-style': '风格',
  'revise-character': '人设',
  'revise-premise': '立项',
  'sync-chapter-memory': '记忆',
}

const QUICK_ACTION_MENU_LABELS: Record<AgentQuickAction, string> = {
  setup: '设定',
  reference: '参考作品',
  world: '世界观与角色',
  plan: '生成大纲',
  'write-next': '写下一章',
  'recover-write': '继续完成本章',
  continue: '续写',
  rewrite: '重写',
  review: '审修章节',
  'adjust-style': '调风格',
  'revise-character': '改人设',
  'revise-premise': '改立项卡',
  'sync-chapter-memory': '同步记忆',
}

/** 指令菜单每一项的用途说明（人话，紧跟标题展示）。目前只覆盖五条产品化指令。 */
const QUICK_ACTION_MENU_DESCRIPTIONS: Partial<Record<AgentQuickAction, string>> = {
  reference: '添加或重新分析参考书，提炼写作指导',
  world: '创建或调整世界观、角色、场景等设定',
  plan: '规划全书结构，生成卷与章节大纲',
  'write-next': '按大纲续写下一章正文并自动审校',
  review: '深度审校指定章节，给出修改建议',
}

/**
 * 指令菜单右侧署名：负责执行这条指令的 Agent 人读名。
 * 事实来源=引擎 commands/*.md 里的 Task 派发（world→world-curator / plan→outline-architect /
 * write→chapter-writer / review→continuity-editor / rewrite→chapter-writer 起手；
 * setup、reference、revise-premise 是「本命令由主会话直接执行，不派发 agent」，署名产品名）。
 * 文案须与 tool-phrase.ts 的 NARRACAT_AGENT_LABELS 保持一致（agent-commands.test.ts 有交叉核对）。
 */
const QUICK_ACTION_AGENT_LABELS: Partial<Record<AgentQuickAction, string>> = {
  setup: 'NarraCat',
  reference: 'NarraCat',
  world: '世界观策划Agent',
  plan: '大纲架构师Agent',
  'write-next': '章节写手Agent',
  rewrite: '章节写手Agent',
  review: '连续性审修Agent',
  'revise-premise': 'NarraCat',
}

const QUICK_ACTION_PLACEHOLDERS: Partial<Record<AgentQuickAction, string>> = {
  reference: '描述你想从参考作品中提炼什么...',
  world: '描述你想创建或调整的世界观、人设、场景...',
  plan: '描述你想规划的故事结构、卷纲或章节方向...',
  'write-next': '输入章节序号，并描述这一章的关键事件和情绪...',
  review: '输入章节序号，并描述你希望重点检查或改进什么...',
}

const COMPOSER_MENU_ACTIONS: AgentQuickAction[] = ['reference', 'world', 'plan', 'write-next', 'review']
const SLASH_COMPAT_ACTIONS: AgentQuickAction[] = [...COMPOSER_MENU_ACTIONS, 'setup', 'rewrite', 'revise-premise']
const NARRACAT_COMMAND_BY_ACTION: Partial<Record<AgentQuickAction, string>> = {
  setup: 'setup',
  reference: 'reference',
  world: 'world',
  plan: 'plan',
  'write-next': 'write',
  'recover-write': 'write',
  review: 'review',
  rewrite: 'rewrite',
  'revise-premise': 'revise-premise',
  'sync-chapter-memory': 'sync-chapter-memory',
}
const ACTION_BY_NARRACAT_COMMAND: Record<string, AgentQuickAction> = {
  setup: 'setup',
  reference: 'reference',
  world: 'world',
  plan: 'plan',
  write: 'write-next',
  review: 'review',
  rewrite: 'rewrite',
  'revise-premise': 'revise-premise',
  'sync-chapter-memory': 'sync-chapter-memory',
}

const QUICK_ACTION_DRAFTS: Record<AgentQuickAction, string> = {
  setup: '开始设定引导',
  reference: '分析参考作品',
  world: '创建或调整角色与世界观',
  plan: '规划全书大纲和章节大纲',
  'write-next': '写下一章',
  'recover-write': '继续完成本章',
  continue: '续写当前章节',
  rewrite: '重写当前章节',
  review: '审修当前章节',
  'adjust-style': '调整当前章节风格',
  'revise-character': '修改角色设定',
  'revise-premise': '修改立项卡内容',
  'sync-chapter-memory': '同步本章记忆',
}

const HANDOFF_BOUNDARY =
  '只围绕当前目标调整；不新建无关设定，不修改无关章节、大纲或设定文件；如果要求会导致大范围覆盖，先说明影响或请求确认。'

export function getAgentQuickActionChipLabel(action: AgentQuickAction): string {
  return QUICK_ACTION_CHIP_LABELS[action]
}

export function getAgentQuickActionMenuLabel(action: AgentQuickAction): string {
  return QUICK_ACTION_MENU_LABELS[action]
}

export function getAgentQuickActionMenuDescription(action: AgentQuickAction): string {
  return QUICK_ACTION_MENU_DESCRIPTIONS[action] ?? ''
}

/** 指令菜单右侧署名——负责执行这条指令的 Agent；无 subagent 派发的指令署名产品名。 */
export function getAgentQuickActionAgentLabel(action: AgentQuickAction): string {
  return QUICK_ACTION_AGENT_LABELS[action] ?? 'NarraCat'
}

export function getAgentQuickActionDraft(action: AgentQuickAction): string {
  return QUICK_ACTION_DRAFTS[action]
}

export function getAgentQuickActionPlaceholder(action?: AgentQuickAction | null): string {
  if (!action) return '向 Agent 描述任务...'
  return QUICK_ACTION_PLACEHOLDERS[action] ?? '补充你希望 Agent 完成的具体要求...'
}

export function getAgentQuickActionCommandLabel(action: AgentQuickAction): string {
  const command = NARRACAT_COMMAND_BY_ACTION[action]
  return command ? `/narracat:${command}` : 'App 内部动作'
}

export function getAgentComposerMenuActions(): AgentQuickAction[] {
  return COMPOSER_MENU_ACTIONS
}

/**
 * 引擎命令名 → 作者可读的任务名；无映射时原样返回。
 * checkpoint.lastCommand 的真实落盘格式是「命令 章号」（如 "write 5"、"rewrite 5 5"，
 * 见 mcp-server state-sync 的 novel_checkpoint），故按首个 token 查表，章号翻成人读后缀。
 */
export function getNarraCatCommandHumanLabel(command: string): string {
  const [head, ...rest] = command.trim().split(/\s+/)
  const action = ACTION_BY_NARRACAT_COMMAND[head.toLowerCase()]
  if (!action) return command
  const label = getAgentQuickActionMenuLabel(action)
  const chapter = rest.find((part) => /^\d+$/.test(part))
  return chapter ? `${label}（第 ${chapter} 章）` : label
}

/**
 * 写作期「+ 角色」入口：构建一条预填的 world 命令 handoff（ADR-0015 渐进生长）。
 * 走既有 /narracat:world 编排，不依赖重跑全量立项——world 命令支持就地建 stub
 * 并按完善度标 profile_stage（stub→sketch→full），新增角色不打断主创作流。
 */
export function createAddCharacterComposerHandoff(): Omit<AgentComposerHandoff, 'id'> {
  return {
    command: 'world',
    sourceActionId: 'workbench-add-character',
    prompt: '新增一个角色。先简述这个角色是谁、和谁有关系；信息不全也没关系，按渐进生长先建轻量档案（stub），后续再深化。',
    preserveDraft: true,
  }
}

/**
 * 候选角色「用世界观 Agent 完善」入口：构建一条针对该候选名字的 world 命令 handoff（ADR-0015）。
 * 候选角色已在写作中出现、只在候选池登记；走 /narracat:world 就地建档转正（信息不全先建 stub）。
 * 不设 preserveDraft：候选名是这条 handoff 的核心载荷，必须注入编辑器，否则退化成通用「+角色」。
 */
export function createPromoteCandidateComposerHandoff(name: string): Omit<AgentComposerHandoff, 'id'> {
  return {
    command: 'world',
    sourceActionId: 'workbench-promote-candidate',
    prompt: `完善候选角色「${name}」的设定档案。这个角色已在写作中出现、目前只是候选；请按渐进生长建立角色档案，信息不全也没关系，先建轻量档案（stub），后续再深化。`,
  }
}

export function resolveAgentQuickActionFromCommandLabel(commandLabel: string): AgentQuickAction | null {
  const match = commandLabel.trim().match(/^\/?narracat:([a-z-]+)$/i)
  if (!match) return null

  return ACTION_BY_NARRACAT_COMMAND[match[1].toLowerCase()] ?? null
}

export function isAgentComposerSlashCommandMenuOpen({
  draft,
  selectedAction,
  isRunning,
}: {
  draft: string
  selectedAction?: AgentQuickAction | null
  isRunning: boolean
}): boolean {
  return !isRunning && !selectedAction && draft.trimStart().startsWith('/')
}

export function filterAgentSlashCommands(
  draft: string,
  actions: AgentQuickAction[] = COMPOSER_MENU_ACTIONS,
): AgentQuickAction[] {
  const query = getAgentSlashCommandQuery(draft)
  if (!query) return actions

  const actionPool = uniqueActions([...actions, ...SLASH_COMPAT_ACTIONS])
  return actionPool.filter((action) => getAgentSlashCommandSearchText(action).includes(query))
}

export function isAgentComposerSlashDraft(draft: string): boolean {
  return draft.trimStart().startsWith('/')
}

function getAgentSlashCommandQuery(draft: string): string {
  const trimmedDraft = draft.trimStart()
  if (!trimmedDraft.startsWith('/')) return ''

  return trimmedDraft
    .slice(1)
    .replace(/^narracat:?/i, '')
    .trim()
    .toLowerCase()
}

function getAgentSlashCommandSearchText(action: AgentQuickAction): string {
  return [
    action,
    getAgentQuickActionMenuLabel(action),
    getAgentQuickActionChipLabel(action),
    getAgentQuickActionCommandLabel(action),
  ]
    .join(' ')
    .toLowerCase()
}

function uniqueActions(actions: AgentQuickAction[]): AgentQuickAction[] {
  return actions.filter((action, index) => actions.indexOf(action) === index)
}

export function getAgentComposerAdjustPlaceholder(spec: AgentComposerAdjustSpec): string {
  return `说说你想怎么${spec.verb}${spec.targetLabel}…`
}

/** 发送时把用户要求包进与旧预填模板同构的完整 prompt（引擎侧提示词形状不变）。 */
export function createAgentComposerAdjustPrompt(spec: AgentComposerAdjustSpec, requirement: string): string {
  return [`需要${spec.verb}${spec.targetLabel}，要求：${requirement.trim()}`, `边界：${HANDOFF_BOUNDARY}`].join('\n')
}

export function createAgentComposerReferencePrompt({
  prompt,
  referenceContext,
}: {
  prompt: string
  referenceContext?: AgentComposerReferenceContext
}): string {
  if (!referenceContext) return prompt

  const userRequirement = prompt.trim()

  return [
    '引用上下文：',
    `来源：${referenceContext.sourceTitle}`,
    '',
    '选中文本：',
    '```text',
    referenceContext.text.trim(),
    '```',
    '',
    '用户要求：',
    userRequirement || '请根据引用上下文提出需要确认的问题，确认后再修改项目文件。',
  ].join('\n')
}

export function resolveAgentComposerRunAction({
  selectedAction,
  suggestedAction,
  forceFreeform = false,
}: {
  selectedAction?: AgentQuickAction | null
  suggestedAction?: AgentQuickAction | null
  forceFreeform?: boolean
}): AgentQuickAction | null {
  if (forceFreeform) return null
  return selectedAction ?? suggestedAction ?? null
}

export function isAgentComposerSendKey({
  key,
  shiftKey,
  isComposing = false,
}: {
  key: string
  shiftKey: boolean
  isComposing?: boolean
}): boolean {
  return key === 'Enter' && !shiftKey && !isComposing
}

export function isAgentComposerChipDeleteKey({
  key,
  hasChip,
  caretAtStart,
  isComposing = false,
}: {
  key: string
  hasChip: boolean
  caretAtStart: boolean
  isComposing?: boolean
}): boolean {
  return (key === 'Backspace' || key === 'Delete') && hasChip && caretAtStart && !isComposing
}

/**
 * 章节写作类动作：prompt **不作为命令参数**（write-next 的 $ARGUMENTS 是章号，由主进程从进度算出），
 * 它唯一的去处是「桌面侧用户补充意图」——也就是作者对这一章说的话。
 * 因此这两个动作的空输入**不补默认草稿**：补了，产品文案（「写下一章」/「写本章」）就会被引擎
 * 当成作者提的要求——回报一条不存在的要求，还会让「连续几章没提要求」永远不成立。
 * 气泡文案由 getVisibleRunPrompt 兜底，作者看到的仍是人话。
 */
const AUTHOR_INTENT_ONLY_ACTIONS = new Set<AgentQuickAction>(['write-next', 'recover-write'])

export function resolveAgentRunPrompt({
  action,
  origin,
  prompt,
  selectedChapter,
}: {
  action?: AgentQuickAction | null
  /** 'action' = 工作台按钮发起：prompt 是按钮自带文案，不是作者打的字。 */
  origin?: 'action'
  prompt: string
  selectedChapter?: number
}): string {
  const trimmedPrompt = prompt.trim()
  if (!action) return trimmedPrompt

  const defaultDraft = getAgentQuickActionDraft(action)
  if ((action === 'review' || action === 'rewrite') && selectedChapter && selectedChapter > 0) {
    if (!trimmedPrompt || trimmedPrompt === defaultDraft) return String(selectedChapter)
  }

  if (AUTHOR_INTENT_ONLY_ACTIONS.has(action)) {
    if (origin === 'action' || !trimmedPrompt || trimmedPrompt === defaultDraft) return ''
    return trimmedPrompt
  }

  return trimmedPrompt || defaultDraft
}

export function createAgentRunRequest({
  threadId,
  action,
  prompt,
  displayPrompt,
  origin,
  engineContext,
  projectPath,
  selectedChapter,
  target,
}: {
  threadId: string
  action?: AgentQuickAction | null
  prompt: string
  displayPrompt?: string
  origin?: 'action'
  // 仅对无 action（freeform）的 run 有意义：声明本次 run 需要 NarraCat 引擎上下文与工具（需配合 projectPath）。
  engineContext?: boolean
  projectPath?: string
  selectedChapter?: number
  target?: AgentRunTarget
}): AgentRunRequest {
  const resolvedPrompt = resolveAgentRunPrompt({ action, origin, prompt, selectedChapter })
  const request: AgentRunRequest = action
    ? {
        threadId,
        command: action,
        prompt: resolvedPrompt,
      }
    : {
        threadId,
        command: 'freeform',
        prompt: resolvedPrompt,
      }

  // displayPrompt 只在与实际 prompt 不同（即 prompt 含定位元信息）时携带，避免冗余。
  const trimmedDisplayPrompt = displayPrompt?.trim()
  if (trimmedDisplayPrompt && trimmedDisplayPrompt !== resolvedPrompt) request.displayPrompt = trimmedDisplayPrompt
  if (origin) request.origin = origin
  if (engineContext) request.engineContext = true
  if (projectPath?.trim()) request.projectPath = projectPath
  if (selectedChapter && selectedChapter > 0) request.selectedChapter = selectedChapter
  if (target) request.target = target

  return request
}
