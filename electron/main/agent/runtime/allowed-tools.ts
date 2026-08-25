/**
 * NarraCat 命令工具面单一来源（拆旧刀4 从 claude-sdk/sdk-runner.ts 平移成 runtime 中立模块）：
 * 两个 adapter 与六条 run 路径共用，不再借住任何具体 runtime 目录。
 */

import {
  NOVEL_MEMORY_MCP_SERVER_NAME,
  qualifyNovelMemoryToolName,
} from '@shared/lib/novel-memory-tool-names'

/** 缺省工具面：pi adapter 与 claude-sdk adapter 共用，避免硬编码副本漂移（切片③终审修复）。 */
export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Skill']

// server 段与前缀是两进程共用契约（渲染端 tool-phrase.ts 按同一前缀反解人读动作名），
// 定义在 shared/lib/novel-memory-tool-names.ts；此处 re-export 保持既有 import 路径不变。
export const NARRACAT_NOVEL_MEMORY_MCP_SERVER_NAME = NOVEL_MEMORY_MCP_SERVER_NAME

export const NARRACAT_NOVEL_MEMORY_MCP_TOOL_NAMES = [
  'novel_query',
  'novel_chapter_summary',
  'novel_character_state',
  'novel_character_statuses',
  'novel_relationship',
  'novel_foreshadowing_status',
  'novel_writing_context',
  'novel_build_writing_context_pack',
  'novel_query_style_reference',
  'novel_get_arc',
  'novel_check_prose_hygiene',
  'novel_foreshadowing_density',
  'novel_get_structure_budget',
  'novel_get_grid_benchmark',
  'novel_get_arc_velocity_target',
  'novel_get_review',
  'novel_failed_reviews',
  'novel_commit_chapter',
  'novel_submit_extraction',
  'novel_stage_extraction',
  'novel_commit_extraction_union',
  'novel_consolidate',
  'novel_submit_review',
  'novel_submit_premise',
  'novel_submit_outline',
  'novel_submit_chapter_outline',
  'novel_update_progress',
  'novel_restore_progress',
  'novel_checkpoint',
  'novel_sync_structure',
  'novel_register_foreshadowing',
  'novel_rollback_chapter',
  'novel_mint_character_uid',
  'novel_list_candidate_characters',
  'novel_register_candidate_character',
  'novel_extraction_scaffold',
  'novel_detect_conflicts',
  'novel_update_outline_book_field',
  'novel_submit_state_vocabulary',
  'novel_submit_character_entity',
  'novel_check_state_delivery',
  'novel_check_manuscript_contract',
  'novel_list_structure_cards',
  // 有意排除 novel_submit_authored_state：作者状态修订是 App 确定性直调 CAS 工具（memory host
  // 直调通道，同 novel_update_outline_book_field），不进 agent 工具面——engine 侧
  // tools.ts 描述已写明「App 确定性直调，不进 agent 工具面」，App IPC 通道见片2b。
  // 有意排除 novel_resolve_planned_state：计划状态变更处置（兑现报告卡四动作）同为 App 确定性
  // 直调，不进 agent 工具面——处置权归作者，agent 不得自行销账。
  // 有意排除 novel_update_chapter_state_changes：章纲卡 state_changes 整段替换同为 App 确定性
  // 直调（json+md+计划表协调写入+CAS），不进 agent 工具面——写作侧提交仍走 novel_submit_chapter_outline。
  // 有意排除 novel_pack_authoring_vocab / novel_pack_authoring_preview：造包中心受控词表与卡片
  // 干跑预览，App 造包中心专用只读工具（经 memory host 直调，见 pack-preview.ts），
  // 不面向真实小说创作会话，agent 不得调用——engine 侧 tools.ts 描述已写明「App 造包中心专用」。
]

export const NARRACAT_NOVEL_MEMORY_MCP_TOOLS = NARRACAT_NOVEL_MEMORY_MCP_TOOL_NAMES.map(qualifyNovelMemoryToolName)

export const NARRACAT_COMMAND_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Agent',
  'TaskCreate',
  'TaskUpdate',
  'AskUserQuestion',
  'Skill',
  ...NARRACAT_NOVEL_MEMORY_MCP_TOOLS,
]
