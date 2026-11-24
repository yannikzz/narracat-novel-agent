import { stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { AgentRunRequest } from '../../agent-runner'
import { chapterManuscriptCandidates, chapterOutlineCandidates } from '../../novel/novel-layout'
import { loadNovelProjectDetail } from '../../novel/novel-project'
import {
  createInlineNarraCatCommandPrompt,
  readNarraCatCommandFile,
  type ReadNarraCatCommandFile,
} from './narracat-command'
import { resolveRecoverWriteRun } from './recover-write'

export interface ResolveWriteNextRunInput {
  projectPath: string
  selectedChapter?: number
  userPrompt: string
}

export interface ResolveWriteNextRunDeps {
  pluginPath: string
  readCommandFile?: ReadNarraCatCommandFile
}

export interface ResolvedWriteNextRun {
  projectPath: string
  chapterNumber: number
  volumeNumber: number
  prompt: string
  maxTurns: number
}

const WRITE_NEXT_MAX_TURNS = 72

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export function isWriteNextRequest(request: AgentRunRequest): boolean {
  return request.command === 'write-next'
}

export async function resolveWriteNextRun(
  input: ResolveWriteNextRunInput,
  {
    pluginPath,
    readCommandFile = readNarraCatCommandFile,
  }: ResolveWriteNextRunDeps,
): Promise<ResolvedWriteNextRun> {
  const detail = await loadNovelProjectDetail(input.projectPath, input.selectedChapter)

  if (detail.status === 'invalid') throw new Error(detail.problem ?? '不是有效 NarraCat 项目。')
  if (detail.status === 'needs-setup') throw new Error('请先完成小说设定。')
  if (detail.status === 'needs-outline') throw new Error('请先完成大纲规划。')

  const chapters = detail.tocItems
    .filter((item) => item.kind === 'chapter' && item.chapterNumber && item.volumeNumber)
    .sort((left, right) => (left.chapterNumber ?? 0) - (right.chapterNumber ?? 0))
  const selected = input.selectedChapter
    ? chapters.find((item) => item.chapterNumber === input.selectedChapter)
    : undefined
  const recoverableChapter =
    selected?.status === 'recoverable' ? selected : chapters.find((item) => item.status === 'recoverable')

  // 中断章优先：写下一章前若有未完成的中断章，直接转恢复流继续写完它，不把
  // 「请先恢复」的操作成本抛回给作者（Bug1a：此前这里抛错，作者点「写第X章」只得到报错）。
  if (recoverableChapter?.chapterNumber) {
    return resolveRecoverWriteRun(
      {
        projectPath: input.projectPath,
        selectedChapter: recoverableChapter.chapterNumber,
        userPrompt: input.userPrompt,
      },
      { pluginPath, readCommandFile },
    )
  }

  const target =
    selected?.status === 'planned' || selected?.status === 'in-progress'
      ? selected
      : chapters.find((item) => item.status === 'planned' || item.status === 'in-progress')

  if (!target?.chapterNumber || !target.volumeNumber) {
    throw new Error('没有可写的已规划章节。')
  }

  const chapterNumber = target.chapterNumber
  const volumeNumber = target.volumeNumber
  const userPrompt = input.userPrompt.trim()
  const outlinePaths = chapterOutlineCandidates(volumeNumber, chapterNumber).map((relativePath) =>
    join(input.projectPath, relativePath),
  )
  if (!(await hasAnyFile(outlinePaths))) {
    throw new Error(`第 ${chapterNumber} 章大纲文件缺失。`)
  }
  // 待写章却已有正式正文（作者自己的稿，或进度丢了）：写章不覆盖它。引擎出包时同样会拦，
  // 这里在起模型之前就拦下，不让作者白等一轮。
  const manuscriptPaths = chapterManuscriptCandidates(volumeNumber, chapterNumber).map((relativePath) =>
    join(input.projectPath, relativePath),
  )
  if (await hasAnyFile(manuscriptPaths)) {
    // 不指向「重写」：重写只收已完成章，这种章同样会被拒；开源版这版不补「有正文没记忆」的路。
    throw new Error(
      `第 ${chapterNumber} 章已经有正文了，但还没记进完成进度，写章不会覆盖它。开源版暂时接不上这种书，导入 NarraCat 专业版可以接着写（专业版按正文算进度）。`,
    )
  }

  return {
    projectPath: input.projectPath,
    chapterNumber,
    volumeNumber,
    maxTurns: WRITE_NEXT_MAX_TURNS,
    prompt: createInlineNarraCatCommandPrompt({
      commandName: 'write',
      pluginPath,
      projectPath: input.projectPath,
      intent: String(chapterNumber),
      commandSource: readCommandFile(pluginPath, 'write'),
      extraInstruction: userPrompt
        ? `桌面侧用户补充意图（仅作为本章写作偏好，不作为章节参数）：${userPrompt}`
        : undefined,
    }),
  }
}

async function hasAnyFile(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    if (await isFile(path)) return true
  }

  return false
}
