import { resolve } from 'node:path'

import { isNarraCatProject } from './novel-project.ts'

export interface DeleteNovelProjectInput {
  projectPath: string
  recentNovelPaths: string[]
  trashItem: (path: string) => Promise<void>
  /**
   * `trash`（缺省）= 项目目录进系统废纸篓 + 摘书架条目；`forget` = 只摘书架条目，**无论磁盘上有什么都不碰**。
   * 书架对 Missing / Invalid 项目的「从书架移除」必须走 forget：点击那一刻目录可能刚好又回来了
   * （外置盘重新连上、yaml 只是坏了但文件都在），按 trash 判会把整本书扔进废纸篓（ADR-0046）。
   */
  mode?: 'trash' | 'forget'
}

export interface DeleteNovelProjectResult {
  projectPath: string
  recentNovelPaths: string[]
  trashed: boolean
}

function removeRecentPath(recentNovelPaths: string[], projectPath: string): string[] {
  const target = resolve(projectPath)
  return recentNovelPaths.filter((path) => resolve(path) !== target)
}

export async function deleteNovelProject({
  projectPath,
  recentNovelPaths,
  trashItem,
  mode = 'trash',
}: DeleteNovelProjectInput): Promise<DeleteNovelProjectResult> {
  const normalizedProjectPath = projectPath.trim()
  if (!normalizedProjectPath) throw new Error('缺少项目路径。')

  const shouldTrash = mode === 'trash' && (await isNarraCatProject(normalizedProjectPath))
  if (shouldTrash) {
    await trashItem(normalizedProjectPath)
  }

  return {
    projectPath: normalizedProjectPath,
    recentNovelPaths: removeRecentPath(recentNovelPaths, normalizedProjectPath),
    trashed: shouldTrash,
  }
}
