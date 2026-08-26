import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NARRACAT_ENGINE_AGENT_IDS } from '../../engine/agent-core-contract'
import type { AgentRunRequest } from '../../agent-runner'

type NarraCatCommand = Extract<
  AgentRunRequest['command'],
  'setup' | 'reference' | 'world' | 'plan' | 'review' | 'rewrite' | 'revise-premise' | 'sync-chapter-memory'
>

export interface ResolvedNarraCatCommandRun {
  projectPath: string
  prompt: string
  maxTurns: number
  selectedChapter?: number
}

export interface InlineNarraCatCommandPromptInput {
  commandName: string
  pluginPath: string
  projectPath: string
  intent: string
  commandSource: string
  extraInstruction?: string
}

export type ReadNarraCatCommandFile = (pluginPath: string, commandName: string) => string

const COMMANDS = new Set<AgentRunRequest['command']>([
  'setup',
  'reference',
  'world',
  'plan',
  'review',
  'rewrite',
  'revise-premise',
  'sync-chapter-memory',
])
const INTERACTIVE_COMMAND_GUARD = [
  '桌面交互约束：NarraCat command 中每一次需要用户输入、确认、选择、追问或继续/调整决策时，必须调用 AskUserQuestion。',
  '必须使用 AskUserQuestion 承载用户输入轮次，确保 NarraCat App 能显示为交互式问题卡。',
  '不要用普通 assistant 文本向用户提问；普通文本只用于解释、复述、总结和写作产物输出。',
  'AskUserQuestion 必须提供 2-4 个可选方向；当用户需要自由发挥时，提供若干方向性选项，NarraCat App 会同时提供自定义回答入口。',
  '如果 command source 写了“追问”“收集回答”“用户认可后进入下一步”“确认”“需要调整”，都视为需要通过 AskUserQuestion 等待用户输入。',
].join('\n')
const MEMORY_MCP_GUARD = [
  'NovelMemory 边界约束：所有记忆查询、提交和回滚都必须通过 NarraCat Agent Core 暴露的 NovelMemory MCP 工具（mcp__narracat_memory__*）完成。',
  '结构化数据按提交工具入库：章节收尾由 Task(narracat:memory-keeper) 经 novel_commit_chapter / novel_submit_extraction / novel_consolidate 提交；审校报告由 narracat:continuity-editor 经 novel_submit_review 提交；大纲由 narracat:outline-architect 经 novel_submit_outline / novel_submit_chapter_outline 提交。',
  '不要直接编辑 state.yaml 的 progress 与 checkpoint：进度用 novel_update_progress、检查点用 novel_checkpoint 写入。',
  '禁止生成、写入或执行任何直接访问 .narracat/memory.db 的脚本；禁止 import better-sqlite3、sqlite、sqlite-vec 或手写 SQL 修改 memory.db。',
  '如果 NovelMemory MCP 工具不可用或连接失败，必须停止对应记忆步骤并报告 MCP/运行适配器不可用，不要 fallback 到本地 SQLite 脚本。',
].join('\n')
const CHAPTER_ARTIFACT_PATH_GUARD = [
  '章节正文路径兼容约束：NarraCat 历史输出可能位于 manuscript/vol-{VV}/ch-{NNN}.md，也可能位于 manuscript/ch-{NNN}.md 或非补零 ch-{N}.md。',
  '读取既有章节正文、审修正文或交给 memory-keeper 入库前，必须先用 Glob 检查 volume 路径、root-level 路径和非补零候选，使用实际存在的路径。',
  '禁止直接 Read 尚未确认存在的 manuscript/vol-* 路径；如果 canonical 路径不存在但 root-level 正文存在，应读取 root-level 正文继续流程。',
  '生成新章节正文时优先写入 canonical 路径 manuscript/vol-{VV}/ch-{NNN}.md 并创建目录；后续审修和记忆更新必须沿用本轮实际写入路径。',
].join('\n')
const FULL_CHAPTER_BYPASS_GUARD = [
  '整章写作边界约束：本续聊会话不得直接执行整章级写作——包括写新的一章、从头重写整章。',
  '用户提出这类请求时，简短说明需要走正式流程，并在回复里写出对应指令原文（写下一章用 /narracat:write，整章重写用 /narracat:rewrite），NarraCat App 会把它渲染成可点击按钮，请用户点击进入。',
  '用户明确指定的局部小修（调整某一段、某一句、某处措辞）可以直接执行，沿用本会话既有的写入路径与记忆规则。',
].join('\n')
export function namespaceNarraCatTaskAgentTypes(commandSource: string): string {
  const agentTypePattern = NARRACAT_ENGINE_AGENT_IDS.join('|')
  return commandSource.replace(new RegExp(`\\bTask\\((${agentTypePattern})\\)`, 'g'), 'Task(narracat:$1)')
}

export function normalizeNarraCatCommandSource(commandSource: string): string {
  return [CHAPTER_ARTIFACT_PATH_GUARD, '', namespaceNarraCatTaskAgentTypes(commandSource).trim()].join('\n')
}

/**
 * engineContext freeform（工作台评估流等，非 slash command）fresh 起 session 的首轮 prompt：
 * 与 command 续聊轮共用同一组守卫（AskUserQuestion 交互 / NovelMemory MCP 边界 / 章节路径兼容），
 * 但不内联 command source——任务内容完全由工作台构造的 userPrompt 承载。
 */
export function createEngineContextFreeformPrompt(userPrompt: string, projectPath: string): string {
  return [
    '你正在当前小说项目中执行一次 NarraCat 工作台任务（非 slash command，没有 command source）。',
    `当前小说项目根目录：${projectPath}`,
    '',
    INTERACTIVE_COMMAND_GUARD,
    '',
    MEMORY_MCP_GUARD,
    '',
    CHAPTER_ARTIFACT_PATH_GUARD,
    '',
    '用户本轮输入：',
    userPrompt,
  ].join('\n')
}

export function createNarraCatCommandContinuationPrompt(userPrompt: string): string {
  return [
    '继续当前 NarraCat command 会话。',
    '',
    INTERACTIVE_COMMAND_GUARD,
    '',
    MEMORY_MCP_GUARD,
    '',
    CHAPTER_ARTIFACT_PATH_GUARD,
    '',
    FULL_CHAPTER_BYPASS_GUARD,
    '',
    '用户本轮输入：',
    userPrompt,
  ].join('\n')
}

const COMMAND_DEFAULTS: Record<
  NarraCatCommand,
  {
    commandName: string
    defaultIntent: string
    maxTurns: number
    extraInstruction?: string
  }
> = {
  setup: {
    commandName: 'setup',
    defaultIntent: '开始设定引导',
    maxTurns: 48,
  },
  reference: {
    commandName: 'reference',
    defaultIntent: '分析参考作品',
    maxTurns: 60,
  },
  world: {
    commandName: 'world',
    defaultIntent: '创建或调整角色与世界观',
    maxTurns: 48,
  },
  plan: {
    commandName: 'plan',
    defaultIntent: '规划全书大纲和章节大纲',
    maxTurns: 72,
  },
  review: {
    commandName: 'review',
    defaultIntent: '审修当前章节',
    maxTurns: 36,
  },
  rewrite: {
    commandName: 'rewrite',
    defaultIntent: '重写当前章节',
    maxTurns: 72,
  },
  'revise-premise': {
    commandName: 'revise-premise',
    defaultIntent: '修改立项卡内容',
    maxTurns: 48,
  },
  'sync-chapter-memory': {
    commandName: 'sync-chapter-memory',
    defaultIntent: '同步本章记忆',
    maxTurns: 48,
  },
}

export function readNarraCatCommandFile(pluginPath: string, commandName: string): string {
  return readFileSync(join(pluginPath, 'commands', `${commandName}.md`), 'utf-8')
}

export function createInlineNarraCatCommandPrompt({
  commandName,
  pluginPath,
  projectPath,
  intent,
  commandSource,
  extraInstruction,
}: InlineNarraCatCommandPromptInput): string {
  const normalizedExtraInstruction = extraInstruction?.trim()
  const normalizedCommandSource = normalizeNarraCatCommandSource(commandSource)

  return [
    `你正在当前小说项目中执行 NarraCat command：/narracat:${commandName}`,
    '',
    'NarraCat App 已将同一份 command 文件内容内联给你；Agent Core 运行适配器用于加载 subagent、skills 和 NovelMemory MCP。',
    '必须严格按照下方 command source 的流程、文件边界、进度跟踪和错误处理执行。',
    '不要回答“unknown command”，不要尝试再次调用 /narracat:* slash command；直接执行内联 command source。',
    'SDK 中 NarraCat subagent 名称必须使用 narracat:* 前缀；调用 Agent tool 时 subagent_type 必须完整匹配，例如 narracat:continuity-editor。',
    '',
    INTERACTIVE_COMMAND_GUARD,
    '',
    MEMORY_MCP_GUARD,
    '',
    CHAPTER_ARTIFACT_PATH_GUARD,
    '',
    `当前小说项目根目录：${projectPath}`,
    `CLAUDE_PLUGIN_ROOT：${pluginPath}`,
    `$ARGUMENTS：${intent}`,
    ...(normalizedExtraInstruction ? ['', normalizedExtraInstruction] : []),
    '',
    '--- NarraCat command source begin ---',
    normalizedCommandSource.trim(),
    '--- NarraCat command source end ---',
  ].join('\n')
}

export function isNarraCatCommandRequest(request: AgentRunRequest): boolean {
  return COMMANDS.has(request.command)
}

export function resolveNarraCatCommandRun(
  request: AgentRunRequest,
  {
    pluginPath,
    readCommandFile = readNarraCatCommandFile,
  }: {
    pluginPath: string
    readCommandFile?: ReadNarraCatCommandFile
  },
): ResolvedNarraCatCommandRun {
  if (!isNarraCatCommandRequest(request)) {
    throw new Error(`不支持的 NarraCat command：${request.command}`)
  }

  if (!request.projectPath) {
    throw new Error(`${request.command} 需要先打开一个小说项目。`)
  }

  const command = request.command as NarraCatCommand
  const config = COMMAND_DEFAULTS[command]
  const intent = request.prompt.trim() || config.defaultIntent
  const commandSource = readCommandFile(pluginPath, config.commandName)
  const leadingChapter = /^\s*(\d+)(?:\s|$)/.exec(intent)?.[1]
  const selectedChapter =
    request.selectedChapter ??
    ((command === 'rewrite' || command === 'review' || command === 'sync-chapter-memory') && leadingChapter
      ? Number(leadingChapter)
      : undefined)

  return {
    projectPath: request.projectPath,
    maxTurns: config.maxTurns,
    ...(selectedChapter && Number.isInteger(selectedChapter) && selectedChapter > 0 ? { selectedChapter } : {}),
    prompt: createInlineNarraCatCommandPrompt({
      commandName: config.commandName,
      pluginPath,
      projectPath: request.projectPath,
      intent,
      commandSource,
      extraInstruction: config.extraInstruction,
    }),
  }
}
