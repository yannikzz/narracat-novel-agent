import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { MANUSCRIPT_DIR, chapterFileNameCandidates } from './novel-layout.ts'

const CHAPTER_METADATA_COMMENT_RE = /<!--\s*chapter_metadata\s*:[\s\S]*?-->/gi

export function normalizeManuscriptText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trimEnd()
}

export function manuscriptTextHash(text: string): string {
  return createHash('sha256').update(normalizeManuscriptText(text), 'utf-8').digest('hex')
}

export function splitChapterMetadataComment(content: string): {
  visibleText: string
  metadataComments: string[]
} {
  const metadataComments = content.match(CHAPTER_METADATA_COMMENT_RE) ?? []
  return {
    visibleText: content.replace(CHAPTER_METADATA_COMMENT_RE, '').trimEnd(),
    metadataComments: [...metadataComments],
  }
}

export function joinChapterMetadataComment(visibleText: string, metadataComments: string[]): string {
  const body = normalizeManuscriptText(visibleText)
  if (metadataComments.length === 0) return `${body}\n`
  return `${body}\n\n${metadataComments.join('\n\n')}\n`
}

/** 在 manuscript/vol-XX/ 与 manuscript/ 根目录定位该章正文（兼容 legacy 命名）。 */
export async function locateManuscriptFile(projectPath: string, chapter: number): Promise<string | null> {
  const manuscriptDir = join(projectPath, MANUSCRIPT_DIR)
  let entries
  try {
    entries = await readdir(manuscriptDir, { withFileTypes: true })
  } catch {
    return null
  }
  const volDirs = entries
    .filter((entry) => entry.isDirectory() && /^vol-\d+$/.test(entry.name))
    .map((entry) => entry.name)
  const fileNames = chapterFileNameCandidates(chapter)
  const candidates = [
    ...volDirs.flatMap((vol) => fileNames.map((name) => join(manuscriptDir, vol, name))),
    ...fileNames.map((name) => join(manuscriptDir, name)),
  ]
  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf-8')
      return candidate
    } catch {
      // 不在此路径，继续找。
    }
  }
  return null
}

export async function readVisibleManuscriptText(projectPath: string, chapter: number): Promise<string | null> {
  const path = await locateManuscriptFile(projectPath, chapter)
  if (!path) return null
  return splitChapterMetadataComment(await readFile(path, 'utf-8')).visibleText
}
