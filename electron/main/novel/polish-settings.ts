import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isPolishSlotId,
  type PolishSlotId,
  type ProjectPolishSettings,
  type StandingPolishOutcome,
} from '@shared/types/prose-polish'
import { atomicWriteFile } from '../atomic-write.ts'
import { NARRACAT_DIR } from './novel-layout.ts'

/**
 * 本书的润色设置（ADR-0041）：常驻槽位 + 正文与记忆已分家的章号。
 * 存 `.narracat/polish.json`——App 层自有文件（主进程独占读写），引擎不读不写，
 * 与 pending-memory-sync.json 同级同纪律。
 *
 * 配方本身（提示词 + 模型）不在这里：它是作者跨书复用的手艺，存 userData。
 */

const polishSettingsQueues = new Map<string, Promise<void>>()

export function polishSettingsPath(projectPath: string): string {
  return join(projectPath, NARRACAT_DIR, 'polish.json')
}

function emptySettings(): ProjectPolishSettings {
  return { version: 1, standingSlotId: null, standingOutcomes: {}, divergedChapters: [] }
}

function normalizeOutcomes(value: unknown): Record<string, StandingPolishOutcome> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, StandingPolishOutcome> = {}
  for (const [chapter, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { status?: unknown; at?: unknown; note?: unknown }
    if (entry.status !== 'applied' && entry.status !== 'skipped') continue
    if (typeof entry.at !== 'string') continue
    result[chapter] = {
      status: entry.status,
      at: entry.at,
      ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
    }
  }
  return result
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/**
 * 读设置。缺文件 → 空设置；文件坏 → 也降级成空设置。
 *
 * 这里刻意比 pending-memory-sync 更软：那份标记坏了代表「作者可能有未同步的改动」，必须让人
 * 知道；而润色设置坏了最坏的后果只是「常驻这次没生效」，为它阻断章节页得不偿失。
 */
interface ReadResult {
  settings: ProjectPolishSettings
  /**
   * 文件存在但读不懂。
   *
   * 必须与「缺文件」分开：两者都降级成空设置给界面看，但**坏文件绝不能被写回**——
   * 一次 setStandingPolishSlot 就会把空设置落盘，连旧章的「正文与记忆分家」标识一起永久抹掉，
   * 而那份标识没有任何别的来源可以重建。
   */
  corrupted: boolean
}

async function readPolishSettingsFile(projectPath: string): Promise<ReadResult> {
  const path = polishSettingsPath(projectPath)

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf-8'))
  } catch (error) {
    if (isMissingFileError(error)) return { settings: emptySettings(), corrupted: false }
    console.warn('[polish] 润色设置读取失败，按未设置处理（且不会覆盖该文件）：', error)
    return { settings: emptySettings(), corrupted: true }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { settings: emptySettings(), corrupted: true }
  }
  const raw = parsed as Record<string, unknown>
  const divergedChapters = Array.isArray(raw.divergedChapters)
    ? raw.divergedChapters.filter(
        (chapter): chapter is number => typeof chapter === 'number' && Number.isInteger(chapter) && chapter >= 1,
      )
    : []

  return {
    settings: {
      version: 1,
      standingSlotId: isPolishSlotId(raw.standingSlotId) ? raw.standingSlotId : null,
      standingOutcomes: normalizeOutcomes(raw.standingOutcomes),
      divergedChapters: [...new Set(divergedChapters)].sort((a, b) => a - b),
    },
    corrupted: false,
  }
}

/**
 * 队列感知的公开读：先等本路径上排队中的写入落定，再读。
 *
 * 队列内部一律用 `readPolishSettingsFile`——在 mutate 里调本函数会等到自己那条队列项，直接死锁
 * （已实测：全部写操作 5s 超时）。
 */
export async function readPolishSettings(projectPath: string): Promise<ProjectPolishSettings> {
  const path = polishSettingsPath(projectPath)
  await (polishSettingsQueues.get(path) ?? Promise.resolve()).catch(() => undefined)
  return (await readPolishSettingsFile(projectPath)).settings
}

function mutatePolishSettings(
  projectPath: string,
  mutation: (settings: ProjectPolishSettings) => boolean,
): Promise<void> {
  const path = polishSettingsPath(projectPath)
  const previous = polishSettingsQueues.get(path) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(async () => {
    const { settings, corrupted } = await readPolishSettingsFile(projectPath)
    // 读不懂就绝不落盘：宁可这次设置没生效，也不能拿一份空设置覆盖掉作者的分家标识。
    if (corrupted) throw new Error('润色设置文件已损坏，为避免覆盖原有记录，这次没有写入。')
    if (!mutation(settings)) return
    await mkdir(dirname(path), { recursive: true })
    await atomicWriteFile(path, `${JSON.stringify(settings, null, 2)}\n`)
  })
  polishSettingsQueues.set(path, current)
  return current.finally(() => {
    if (polishSettingsQueues.get(path) === current) polishSettingsQueues.delete(path)
  })
}

/** 设置或关闭常驻槽位（null = 关闭）。只影响往后新写的章，不追溯已有章节。 */
export async function setStandingPolishSlot(projectPath: string, slotId: PolishSlotId | null): Promise<void> {
  await mutatePolishSettings(projectPath, (settings) => {
    if (settings.standingSlotId === slotId) return false
    settings.standingSlotId = slotId
    return true
  })
}

/**
 * 登记「这一章的正文与记忆已分家」。
 *
 * 只在旧章的漂移版被采用时调用（ADR-0041 §7）：`/sync-chapter-memory` 不收旧章，
 * `/rewrite` 会重新生成正文、抹掉作者刚润出的版本——确实没有出口，所以这是个纯陈述标识，
 * 不配任何操作按钮。给一个按不下去的按钮比不给更伤。
 */
export async function markChapterDiverged(projectPath: string, chapter: number): Promise<void> {
  await mutatePolishSettings(projectPath, (settings) => {
    if (settings.divergedChapters.includes(chapter)) return false
    settings.divergedChapters = [...settings.divergedChapters, chapter].sort((a, b) => a - b)
    return true
  })
}

/** 该章记忆被重新入库后（重写 / 同步）解除分家标识。 */
export async function clearChapterDiverged(projectPath: string, chapter: number): Promise<void> {
  await mutatePolishSettings(projectPath, (settings) => {
    if (!settings.divergedChapters.includes(chapter)) return false
    settings.divergedChapters = settings.divergedChapters.filter((item) => item !== chapter)
    return true
  })
}

/** 记下常驻润色在某一章的结果（applied / skipped）。跳过尤其要记——静默跳过等于没人知道。 */
export async function recordStandingPolishOutcome(
  projectPath: string,
  chapter: number,
  outcome: StandingPolishOutcome,
): Promise<void> {
  await mutatePolishSettings(projectPath, (settings) => {
    settings.standingOutcomes = { ...settings.standingOutcomes, [String(chapter)]: outcome }
    return true
  })
}

/** 作者读过横幅后清掉（幂等）。 */
export async function clearStandingPolishOutcome(projectPath: string, chapter: number): Promise<void> {
  await mutatePolishSettings(projectPath, (settings) => {
    if (!(String(chapter) in settings.standingOutcomes)) return false
    const next = { ...settings.standingOutcomes }
    delete next[String(chapter)]
    settings.standingOutcomes = next
    return true
  })
}
