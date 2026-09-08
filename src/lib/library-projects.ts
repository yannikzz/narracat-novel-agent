import type { NovelProjectStatus, NovelProjectSummary } from '@shared/types/novel'

export type LibraryStatusFilter = 'all' | NovelProjectStatus
export type LibraryGenreFilter = 'all' | string

export interface LibraryProjectFilters {
  status: LibraryStatusFilter
  genre: LibraryGenreFilter
  /** 标题搜索词：对书名做包含匹配（忽略大小写），空串/纯空白视为不过滤。 */
  title?: string
}

export const UNCATEGORIZED_LIBRARY_GENRE = '未分类'

const statusPriority: Record<NovelProjectStatus, number> = {
  'in-progress': 1,
  ready: 2,
  'needs-outline': 3,
  'needs-setup': 4,
  invalid: 5,
  missing: 6,
}

function projectActionPriority(project: NovelProjectSummary): number {
  if (project.checkpoint) return 0

  return statusPriority[project.status]
}

function updatedAtTime(project: NovelProjectSummary): number {
  if (!project.updatedAt) return Number.NEGATIVE_INFINITY

  const timestamp = Date.parse(project.updatedAt)
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp
}

export function sortLibraryProjects(projects: NovelProjectSummary[]): NovelProjectSummary[] {
  return [...projects].sort((first, second) => {
    const priorityDiff = projectActionPriority(first) - projectActionPriority(second)
    if (priorityDiff !== 0) return priorityDiff

    const updatedDiff = updatedAtTime(second) - updatedAtTime(first)
    if (updatedDiff !== 0) return updatedDiff

    const titleDiff = first.title.localeCompare(second.title, 'zh-CN')
    if (titleDiff !== 0) return titleDiff

    return first.path.localeCompare(second.path)
  })
}

export function normalizeLibraryGenre(genre: string | null | undefined): string {
  const normalizedGenre = genre?.trim()
  return normalizedGenre ? normalizedGenre : UNCATEGORIZED_LIBRARY_GENRE
}

export function getLibraryGenreFilters(projects: NovelProjectSummary[]): string[] {
  const genres = new Set(projects.map((project) => normalizeLibraryGenre(project.genre)))

  return [...genres].sort((first, second) => {
    if (first === UNCATEGORIZED_LIBRARY_GENRE) return 1
    if (second === UNCATEGORIZED_LIBRARY_GENRE) return -1
    return first.localeCompare(second, 'zh-CN')
  })
}

export function filterLibraryProjects(
  projects: NovelProjectSummary[],
  filters: LibraryProjectFilters,
): NovelProjectSummary[] {
  const titleQuery = filters.title?.trim().toLowerCase() ?? ''

  return projects.filter((project) => {
    if (filters.status !== 'all' && project.status !== filters.status) return false
    if (filters.genre !== 'all' && normalizeLibraryGenre(project.genre) !== filters.genre) return false
    if (titleQuery && !project.title.toLowerCase().includes(titleQuery)) return false
    return true
  })
}
