/**
 * 小说信息更新 IPC 边界校验（独立模块，供测试直接导入，无重型依赖）。
 *
 * 与 pack-draft-input.ts 同一个理由拆出来：novel.ts 顶部 import 了 electron 与整条小说主进程链路，
 * 测试根本 import 不进去，白名单少放一个字段全仓没有一条断言拦得住——而这条通道决定的是渲染端能
 * 改 `.narracat/config.yaml` 里的哪几个 key，`automationLevel` 更是直接改变 Agent 之后怎么跑。
 *
 * 白名单只认 title / coverPreset / automationLevel 三个字段，其余 key 一律丢弃；三个全缺则拒绝，
 * 不让一次不带任何改动的空写把 config.yaml 重排一遍。字段的内容合法性（标题空白、封面预设是否存在）
 * 由 novel-project.ts 的落盘校验兜底，这里只管形状与放行范围。
 */
import type { NovelAutomationLevel, UpdateNovelProjectMetadataInput } from '@shared/types/novel'

function readInputRecord(input: unknown, message: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(message)
  return input as Record<string, unknown>
}

function readRequiredString(parent: Record<string, unknown>, key: string, message: string): string {
  const value = parent[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(message)
  return value
}

function readOptionalString(parent: Record<string, unknown>, key: string, message: string): string | undefined {
  const value = parent[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(message)
  return value
}

/** 自动化档只有两个合法取值；写歪一个字都会让引擎按另一档跑，所以这里认死值而不是认字符串。 */
export function readAutomationLevel(value: unknown): NovelAutomationLevel {
  if (value !== 'collaborative' && value !== 'auto') throw new Error('自动化级别非法。')
  return value
}

export function readUpdateNovelProjectMetadataInput(input: unknown): UpdateNovelProjectMetadataInput {
  const value = readInputRecord(input, '小说信息参数非法。')
  const title = readOptionalString(value, 'title', '小说标题参数非法。')
  const coverPreset = readOptionalString(value, 'coverPreset', '封面预设参数非法。')
  const automationLevel =
    value.automationLevel === undefined ? undefined : readAutomationLevel(value.automationLevel)

  if (title === undefined && coverPreset === undefined && automationLevel === undefined) {
    throw new Error('没有可更新的小说信息。')
  }

  return {
    projectPath: readRequiredString(value, 'projectPath', '缺少项目路径。'),
    ...(title !== undefined ? { title } : {}),
    ...(coverPreset !== undefined ? { coverPreset } : {}),
    ...(automationLevel !== undefined ? { automationLevel } : {}),
  }
}
