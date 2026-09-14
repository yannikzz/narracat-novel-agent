import type { AgentRun } from '@shared/types/agent'
import type { TelemetryModule } from '@shared/types/telemetry'

/**
 * Agent run 的 command → 埋点模块。失败上报要落到哪个模块，全看这张表。
 *
 * 在此之前 `error_occurred` **全库只在写章节失败时上报一处**，于是「立项卡跑失败了」
 * 「大纲跑失败了」这类事一条记录都没有——而 premise 是仅次于模型配置的第二大模块
 * （2026-09-11 实测 128 台设备用过，写章节只有 64 台）。盲区正好压在最常走的那条路上。
 *
 * `world` 与 `freeform` 归 'unknown' 是刻意的：TELEMETRY_MODULES 里没有对应项，而**新增模块
 * 取值属于扩大采集范围**，要走 ADR-0039 的告知流程并 bump 告知版本（见
 * telemetry.ts 顶部与 memory 里那条判据）。宁可先让它们落进 'unknown'——失败本身看得见，
 * 只是不知道具体是哪一类；等真有人问「世界观那边到底怎么样」再单独走那道流程。
 */
const MODULE_BY_COMMAND: Readonly<Record<AgentRun['command'], TelemetryModule | 'unknown'>> = Object.freeze({
  setup: 'premise',
  'revise-premise': 'premise',
  plan: 'outline',
  'write-next': 'write-chapter',
  'recover-write': 'write-chapter',
  rewrite: 'write-chapter',
  review: 'write-chapter',
  reference: 'reference-works',
  'sync-chapter-memory': 'memory-graph',
  world: 'unknown',
  freeform: 'unknown',
})

export function resolveRunModule(command: AgentRun['command']): TelemetryModule | 'unknown' {
  return MODULE_BY_COMMAND[command] ?? 'unknown'
}

/**
 * 写章节专属的两个事件（chapter_write_started / chapter_write_finished）只认这些 command。
 *
 * **不能按 resolveRunModule() === 'write-chapter' 来判**：`rewrite` 与 `review` 也算写章节模块，
 * 但它们不是"写新的一章"，混进去会把写章节的完成率、耗时分布全部稀释掉——那两个数是
 * 跨版本比较用的，口径一旦变了就不可比（与分桶边界不许改是同一个道理）。
 */
const CHAPTER_WRITE_COMMANDS: ReadonlySet<AgentRun['command']> = new Set(['write-next'])

export function isChapterWriteCommand(command: AgentRun['command']): boolean {
  return CHAPTER_WRITE_COMMANDS.has(command)
}
