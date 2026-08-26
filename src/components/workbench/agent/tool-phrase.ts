import { TOOL_PATH_INPUT_KEYS } from '@shared/lib/agent-path-scrub'
import { NOVEL_MEMORY_MCP_SERVER_NAME } from '@shared/lib/novel-memory-tool-names'

/**
 * 工具名有两代：当前 pi runtime 用小写内置名（read/write/edit/bash/grep/find/ls，
 * 权威映射见 electron/main/agent/runtime/adapters/pi/pi-tool-guard.ts 的
 * SDK_TO_PI_TOOL_NAME——注意 Glob 已改名为 find），claude-sdk 时代的大写名仍保留，
 * 因为用户机器上的历史会话事件里存的是旧名，重看旧对话时要能正确渲染。
 */
export interface ToolPhrase {
  label: string
  loadingLabel: string
}

type ToolInput = Record<string, unknown> | undefined

/** 供 agent-commands.test.ts 交叉核对指令菜单署名文案是否与此处 SSOT 保持一致，不做运行时耦合。 */
export const NARRACAT_AGENT_LABELS: Record<string, string> = {
  'chapter-writer': '章节写手Agent',
  'continuity-editor': '连续性审修Agent',
  'memory-keeper': '记忆管家Agent',
  'outline-architect': '大纲架构师Agent',
  'world-curator': '世界观策划Agent',
}

/**
 * NovelMemory MCP 工具 → 面向用户的人读动作名（CONTEXT「User-facing Agent action label」）。
 * 工具名定义权威在 agent-core mcp-server/src/tools.ts；本表持人读中文名，落实 ADR-0016 通道二
 * ——对话流不裸露 mcp__narracat_memory__ / novel_* 技术标识。
 * 新增/删除工具时与 tool-phrase.test.ts 对照测试同步（工具有而 App 缺 → 失败）。
 */
export const NARRACAT_TOOL_LABELS: Record<string, string> = {
  // 查询 / 读取
  novel_query: '查询记忆',
  novel_chapter_summary: '查章节摘要',
  novel_character_state: '查角色状态',
  novel_character_statuses: '批量查角色状态',
  novel_relationship: '查角色关系',
  novel_foreshadowing_status: '查伏笔状态',
  novel_foreshadowing_density: '查伏笔密度',
  novel_get_arc: '查 arc 信息',
  novel_check_prose_hygiene: '扫正文机械腔',
  novel_get_review: '查审校结论',
  novel_failed_reviews: '查未过审章节',
  novel_get_structure_budget: '查结构预算',
  novel_get_grid_benchmark: '查网格对标',
  novel_get_arc_velocity_target: '查主线定速靶',
  novel_writing_context: '读写作上下文',
  novel_build_writing_context_pack: '准备写作上下文',
  novel_query_style_reference: '查风格范例',
  novel_list_candidate_characters: '查候选角色',
  novel_extraction_scaffold: '准备记忆抽取',
  novel_get_character_dialogue_samples: '查角色台词',
  novel_list_structure_cards: '查阅结构手法卡',
  // 提交 / 写入
  novel_submit_premise: '提交立项卡',
  novel_submit_outline: '提交全书大纲',
  novel_submit_chapter_outline: '提交章节大纲',
  novel_commit_chapter: '章节入库',
  novel_submit_extraction: '提交章节记忆',
  novel_stage_extraction: '暂存章节记忆',
  novel_commit_extraction_union: '合并入库章节记忆',
  novel_consolidate: '整合记忆',
  novel_detect_conflicts: '检测设定冲突',
  novel_submit_review: '提交审校报告',
  novel_update_outline_book_field: '更新大纲字段',
  novel_submit_state_vocabulary: '提交状态词表',
  novel_submit_character_entity: '提交角色实体',
  novel_submit_authored_state: '提交作者状态修订',
  novel_check_state_delivery: '比对计划状态兑现',
  novel_check_manuscript_contract: '核对正文交付合同',
  novel_resolve_planned_state: '处置计划状态变更',
  novel_update_chapter_state_changes: '更新章纲计划状态变更',
  novel_update_progress: '更新进度',
  novel_restore_progress: '恢复章节进度',
  novel_checkpoint: '写入检查点',
  novel_register_foreshadowing: '登记伏笔',
  novel_sync_structure: '同步全书结构',
  novel_rollback_chapter: '回滚章节',
  novel_mint_character_uid: '生成角色 UID',
  novel_register_candidate_character: '登记候选角色',
  novel_submit_dialogue_samples: '提交角色台词',
  // 造包中心专用（App 确定性直调，不进 agent 工具面，见 sdk-runner.ts 白名单排除注释）
  novel_pack_authoring_vocab: '读取造包词表',
  novel_pack_authoring_preview: '预演卡片出场',
  // 本书声音样章锚（P1B 刀2，App 确定性直调，不进 agent 工具面，见 sdk-runner.ts 白名单排除注释）
  novel_submit_style_anchor: '标记本书样章锚',
  novel_list_style_anchors: '查阅本书样章锚',
}

/** 工具全名 `mcp__<server>__<tool>` 里 NovelMemory 的 server 段——与主进程同源，见 shared 常量。 */
const NARRACAT_NOVELMEMORY_SERVER = NOVEL_MEMORY_MCP_SERVER_NAME
/** 未登记的 NovelMemory 工具的友好降级名——不裸露技术标识。 */
const NARRACAT_MEMORY_FALLBACK_LABEL = '记忆引擎操作'

function filename(path: string): string {
  return path.split('/').pop() ?? path
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function compactAbsolutePaths(text: string): string {
  return text.replace(/(^|[\s("'`=])\/[^\s"'`<>]+/g, (match, prefix: string) => {
    const rawPath = match.slice(prefix.length)
    const trailing = rawPath.match(/[),.;:]+$/)?.[0] ?? ''
    const path = trailing ? rawPath.slice(0, -trailing.length) : rawPath
    const name = filename(path)
    return name ? `${prefix}${name}${trailing}` : match
  })
}

function compactInlineText(text: string, max: number): string {
  return truncate(compactAbsolutePaths(text), max)
}

function asRecord(input: ToolInput): Record<string, unknown> {
  return input ?? {}
}

function phrase(label: string, loadingLabel = `正在${label}...`): ToolPhrase {
  return {
    label,
    loadingLabel,
  }
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function firstMeaningfulValue(input: Record<string, unknown>): string | undefined {
  const priority = firstString(input, ['description', 'prompt', 'query', 'command', 'name', 'subject', 'path', 'file_path', 'filePath', 'url'])
  if (priority) return priority

  for (const [key, value] of Object.entries(input)) {
    if (!key.startsWith('_') && typeof value === 'string' && value.trim() && value.length < 200) {
      return value
    }
  }

  return undefined
}

function diffStats(input: Record<string, unknown>): { additions: number; deletions: number } | undefined {
  const oldString = typeof input.old_string === 'string' ? input.old_string : undefined
  const newString = typeof input.new_string === 'string' ? input.new_string : undefined
  if (!oldString && !newString) return undefined

  return {
    additions: newString ? newString.split('\n').length : 0,
    deletions: oldString ? oldString.split('\n').length : 0,
  }
}

/** 剥离 `narracat:` 前缀与路径分隔，供分组卡渲染折叠态 agent 名标签复用（见 AgentSubagentGroupRow）。 */
export function normalizeAgentType(value: string): string {
  return value.replace(/^narracat:/, '').split('/').pop() ?? value
}

function agentLabel(input: Record<string, unknown>): string | undefined {
  const type = firstString(input, ['subagent_type', 'agent_type', 'agent'])
  if (!type) return undefined

  return NARRACAT_AGENT_LABELS[normalizeAgentType(type)]
}

function agentPhrase(toolName: string, input: Record<string, unknown>): ToolPhrase {
  const agent = agentLabel(input) ?? (toolName === 'Task' ? 'Agent' : toolName)
  const description = firstString(input, ['description'])
  const compactDescription = description ? compactInlineText(description, 80) : undefined

  if (compactDescription) {
    return phrase(`${agent} ${compactDescription}`, `${agent}正在${compactDescription}...`)
  }

  return phrase(agent, `${agent}正在处理...`)
}

export function getToolPhrase(toolName: string, rawInput?: ToolInput): ToolPhrase {
  const input = asRecord(rawInput)

  switch (toolName) {
    case 'Read':
    case 'read': {
      const path = firstString(input, [...TOOL_PATH_INPUT_KEYS])
      if (!path) return phrase('读取文件')

      const offset = typeof input.offset === 'number' ? input.offset : undefined
      const limit = typeof input.limit === 'number' ? input.limit : undefined
      if (offset !== undefined && limit !== undefined) {
        return phrase(`读取 ${filename(path)} 第 ${offset}-${offset + limit} 行`)
      }
      if (offset !== undefined) return phrase(`读取 ${filename(path)} 从第 ${offset} 行`)
      return phrase(`读取 ${filename(path)}`)
    }

    case 'Edit':
    case 'edit': {
      const path = firstString(input, [...TOOL_PATH_INPUT_KEYS])
      const name = path ? filename(path) : '文件'
      const diff = diffStats(input)
      if (!diff) return phrase(`编辑 ${name}`)

      const parts = [name]
      if (diff.additions > 0) parts.push(`+${diff.additions}`)
      if (diff.deletions > 0) parts.push(`-${diff.deletions}`)
      return phrase(`编辑 ${parts.join(' ')}`)
    }

    case 'Write':
    case 'write': {
      const path = firstString(input, [...TOOL_PATH_INPUT_KEYS])
      const name = path ? filename(path) : '文件'
      const content = input.content
      if (typeof content === 'string' && content.length > 0) {
        return phrase(`写入 ${name} +${content.split('\n').length}`)
      }
      return phrase(`写入 ${name}`)
    }

    case 'Bash':
    case 'bash': {
      const command = firstString(input, ['command'])
      return phrase(command ? `执行 ${compactInlineText(command, 80)}` : '执行命令')
    }

    case 'Grep':
    case 'grep': {
      const pattern = firstString(input, ['pattern'])
      if (!pattern) return phrase('搜索内容')
      const scope = firstString(input, ['glob', 'path'])
      return phrase(scope ? `搜索内容 /${pattern}/ in ${scope}` : `搜索内容 /${pattern}/`)
    }

    case 'Glob':
    case 'find': {
      const pattern = firstString(input, ['pattern'])
      if (!pattern) return phrase('搜索文件')
      const path = firstString(input, ['path'])
      return phrase(path ? `搜索文件 ${pattern} in ${path}` : `搜索文件 ${pattern}`)
    }

    case 'ls': {
      const path = firstString(input, ['path'])
      return phrase(path ? `查看目录 ${filename(path)}` : '查看目录')
    }

    case 'AskUserQuestion': {
      return phrase('向你提问')
    }

    case 'WebFetch': {
      const url = firstString(input, ['url'])
      return phrase(url ? `抓取 ${truncate(url, 60)}` : '抓取网页')
    }

    case 'WebSearch': {
      const query = firstString(input, ['query'])
      return phrase(query ? `搜索 "${compactInlineText(query, 60)}"` : '搜索网页')
    }

    case 'TodoWrite': {
      const todos = input.todos
      return phrase(Array.isArray(todos) ? `更新待办 ${todos.length} 项` : '更新待办')
    }

    case 'TaskCreate': {
      const subject = firstString(input, ['subject'])
      return phrase(subject ? `添加步骤「${subject}」` : '添加步骤')
    }

    case 'TaskUpdate': {
      const status = input.status
      if (status === 'in_progress' || status === 'completed') return phrase('推进任务进度')
      return phrase('更新任务')
    }

    case 'Task':
    case 'Agent': {
      return agentPhrase(toolName, input)
    }

    default: {
      const mcpParts = toolName.split('__')
      if (mcpParts[0] === 'mcp' && mcpParts.length >= 3 && mcpParts[1]) {
        const server = mcpParts[1]
        const tool = mcpParts.slice(2).join('_')

        // NarraCat NovelMemory MCP：映射为人读动作名，绝不裸露 narracat_memory / novel_* 技术标识
        if (server === NARRACAT_NOVELMEMORY_SERVER) {
          return phrase(NARRACAT_TOOL_LABELS[tool] ?? NARRACAT_MEMORY_FALLBACK_LABEL)
        }

        // 其它 MCP server 保持通用展示
        const summary = firstMeaningfulValue(input)
        const generic = `${server.toUpperCase()} / ${tool}`
        return phrase(summary ? `${generic} ${compactInlineText(summary, 60)}` : generic)
      }

      const summary = firstMeaningfulValue(input)
      return phrase(summary ? `${toolName} ${compactInlineText(summary, 60)}` : `调用 ${toolName}`)
    }
  }
}
