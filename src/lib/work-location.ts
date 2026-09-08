import { isOpenableNovelProject } from '@shared/lib/library-project'
import type { NovelProjectDetail, NovelProjectSummary } from '@shared/types/novel'
import type { WorkbenchChapterView } from '@shared/types/workbench'
import type { WorkbenchPrimarySectionId } from './workbench-navigation'
import type { StoredWorkLocation } from '@shared/types/work-location'
export { parseStoredWorkLocation } from '@shared/lib/work-location-schema'

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

export function createWorkbenchLocation({
  chapterView,
  project,
  searchParams,
  sectionId,
}: {
  chapterView?: WorkbenchChapterView
  project: NovelProjectDetail
  searchParams: URLSearchParams
  sectionId: WorkbenchPrimarySectionId
}): StoredWorkLocation {
  const objectId = nonEmptyString(searchParams.get('object'))
  const tabId = nonEmptyString(searchParams.get('tab'))
  const chapterFromObject = objectId?.match(/^chapter-(\d+)$/)?.[1]
  const chapterFromParam = nonEmptyString(searchParams.get('chapter'))
  const chapter = positiveInteger(Number(chapterFromObject ?? chapterFromParam))

  return {
    version: 1,
    landing: 'workbench',
    novelId: project.id,
    projectPath: project.path,
    sectionId,
    ...(tabId ? { tabId } : {}),
    ...(objectId ? { objectId } : {}),
    ...(chapter ? { chapter } : {}),
    ...(chapterView ? { chapterView } : {}),
  }
}

export function buildStoredWorkbenchHref(
  location: Extract<StoredWorkLocation, { landing: 'workbench' }>,
  projectPath = location.projectPath,
): string {
  const params = new URLSearchParams({ project: projectPath })

  if (location.tabId) {
    params.set('section', location.sectionId)
    params.set('tab', location.tabId)
  }
  else if (location.objectId) params.set('object', location.objectId)
  else if (location.chapter) params.set('chapter', String(location.chapter))
  else params.set('section', location.sectionId)
  if (location.chapterView) params.set('view', location.chapterView)

  return `/workbench?${params.toString()}`
}

export function resolveStoredWorkProject(
  projects: NovelProjectSummary[],
  location: Extract<StoredWorkLocation, { landing: 'workbench' }>,
): NovelProjectSummary | null {
  const matches = projects.filter(
    (project) => project.id === location.novelId && isOpenableNovelProject(project.status),
  )

  return matches.find((project) => project.path === location.projectPath) ?? matches[0] ?? null
}

export function resolveSettingsReturnTarget(
  from: string | null | undefined,
  stored: StoredWorkLocation,
): string {
  if (from?.startsWith('/workbench?')) return from
  if (from === '/') return '/'
  if (from?.startsWith('/') && from !== '/workbench') return from

  return stored.landing === 'workbench' ? buildStoredWorkbenchHref(stored) : '/'
}

export type { StoredWorkLocation }
