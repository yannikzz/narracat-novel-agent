import {
  buildWorkbenchSectionHref as buildNavigationWorkbenchSectionHref,
  buildWorkbenchTabHref,
  getWorkbenchTabs,
  resolveWorkbenchSectionId,
} from './workbench-navigation'
import type { AgentRunTarget } from '@shared/types/agent'
import type { NovelProjectDetail } from '@shared/types/novel'
import type { WorkbenchChapterView } from '@shared/types/workbench'
import type { WorkbenchPrimarySectionId } from './workbench-navigation'

export function workbenchObjectIdForChapter(chapter: number): string {
  return `chapter-${chapter}`
}

/** workbenchObjectIdForChapter 的反解；不是章节对象或章号非法时返回 null。 */
export function chapterNumberFromObjectId(objectId: string): number | null {
  const chapter = Number(/^chapter-(\d+)$/.exec(objectId)?.[1])
  return Number.isInteger(chapter) && chapter > 0 ? chapter : null
}

export function readWorkbenchObjectId(params: URLSearchParams): string | null {
  const objectId = params.get('object')?.trim()
  if (objectId) return objectId

  const rawChapter = params.get('chapter')
  if (!rawChapter) return null

  const chapter = Number(rawChapter)
  return Number.isInteger(chapter) && chapter > 0 ? workbenchObjectIdForChapter(chapter) : null
}

export function buildWorkbenchObjectHref({
  objectId,
  projectPath,
}: {
  objectId: string
  projectPath: string
}): string {
  const params = new URLSearchParams({ project: projectPath, object: objectId })
  return `/workbench?${params.toString()}`
}

export function buildWorkbenchTargetHref({
  project,
  projectPath,
  target,
}: {
  project: NovelProjectDetail
  projectPath: string
  target: AgentRunTarget
}): string {
  const targetTab = getWorkbenchTabs(project, target.sectionId as WorkbenchPrimarySectionId).find(
    (tab) => tab.id === target.tabId || tab.objectId === target.objectId,
  )

  if (targetTab) {
    return buildWorkbenchTabHref({ projectPath, sectionId: target.sectionId as WorkbenchPrimarySectionId, tabId: targetTab.id })
  }

  return buildWorkbenchObjectHref({ projectPath, objectId: target.objectId })
}

export function readWorkbenchSectionId(params: URLSearchParams): WorkbenchPrimarySectionId {
  return resolveWorkbenchSectionId(params.get('section'))
}

export function readWorkbenchTabId(params: URLSearchParams): string | null {
  const tabId = params.get('tab')?.trim()
  return tabId || readWorkbenchObjectId(params)
}

export function readWorkbenchChapterView(params: URLSearchParams): WorkbenchChapterView | undefined {
  const value = params.get('view')?.trim()
  return value === 'text' || value === 'outline' || value === 'context' || value === 'review'
    ? value
    : undefined
}

export function buildWorkbenchSectionHref({
  projectPath,
  sectionId,
}: {
  projectPath: string
  sectionId: WorkbenchPrimarySectionId
}): string {
  return buildNavigationWorkbenchSectionHref({ projectPath, sectionId })
}
