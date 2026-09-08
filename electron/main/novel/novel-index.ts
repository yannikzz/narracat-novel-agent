import { lstat, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { createIdentitylessProjectSummary, isNarraCatProject, loadNovelProjectSummary } from './novel-project'
import { isOpenableNovelProject } from '@shared/lib/library-project'
import type { NovelProjectSummary } from '@shared/types/novel'

export interface ScanNovelProjectsInput {
  novelRootDir: string
  recentNovelPaths: string[]
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const path of paths) {
    if (!path) {
      continue
    }

    const key = resolve(path)

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(path)
  }

  return result
}

export function reconcileRecentNovelPaths(
  recentNovelPaths: string[],
  previousPath: string,
  currentPath: string,
): string[] {
  return uniquePaths([
    currentPath,
    ...recentNovelPaths.filter((path) => resolve(path) !== resolve(previousPath)),
  ])
}

export async function pruneMissingRecentNovelPaths(
  paths: string[],
  pathExists: (path: string) => Promise<boolean> = async (path) =>
    Boolean(await lstat(path).catch(() => null)),
): Promise<string[]> {
  const unique = uniquePaths(paths)
  const checks = await Promise.all(
    unique.map(async (path) => ({ path, exists: await pathExists(path) })),
  )
  return checks.filter((check) => check.exists).map((check) => check.path)
}

async function scanRootChildren(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name))
    const checks = await Promise.all(
      directories.map(async (path) => ({
        path,
        isProject: await isNarraCatProject(path),
      })),
    )

    return checks.filter((check) => check.isProject).map((check) => check.path)
  } catch {
    return []
  }
}

function compareProjectSummaries(left: NovelProjectSummary, right: NovelProjectSummary): number {
  // 没有身份的项目（invalid / missing）一律沉底。
  const leftOpenable = isOpenableNovelProject(left.status)
  const rightOpenable = isOpenableNovelProject(right.status)
  if (!leftOpenable && rightOpenable) {
    return 1
  }

  if (leftOpenable && !rightOpenable) {
    return -1
  }

  const updatedAtOrder = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')

  if (updatedAtOrder !== 0) {
    return updatedAtOrder
  }

  const titleOrder = left.title.localeCompare(right.title)

  if (titleOrder !== 0) {
    return titleOrder
  }

  return left.path.localeCompare(right.path)
}

async function loadSummarySafely(path: string): Promise<NovelProjectSummary> {
  try {
    return await loadNovelProjectSummary(path)
  } catch (error) {
    // 读得到目录但 yaml 坏掉等：结构不完整（invalid），与目录不存在（missing）分开表达。
    return { ...createIdentitylessProjectSummary(path, 'invalid', (error as Error).message), wordCountTotal: 0 }
  }
}

export async function scanNovelProjects(input: ScanNovelProjectsInput): Promise<NovelProjectSummary[]> {
  const rootChildren = await scanRootChildren(input.novelRootDir)
  const paths = uniquePaths([...input.recentNovelPaths, ...rootChildren])
  const summaries = await Promise.all(paths.map((path) => loadSummarySafely(path)))

  return summaries.sort(compareProjectSummaries)
}
