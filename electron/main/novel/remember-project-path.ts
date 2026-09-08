import { reconcileRecentNovelPaths } from './novel-index.ts'
import { isOpenableNovelProject } from '@shared/lib/library-project'
import type { AppConfig } from '@shared/types/config'
import type {
  NovelProjectSummary,
  RememberNovelProjectPathInput,
} from '@shared/types/novel'

export function parseRememberNovelProjectPathInput(input: unknown): RememberNovelProjectPathInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('项目位置参数非法。')
  }

  const value = input as Record<string, unknown>
  const novelId = typeof value.novelId === 'string' ? value.novelId.trim() : ''
  const previousPath = typeof value.previousPath === 'string' ? value.previousPath.trim() : ''
  const currentPath = typeof value.currentPath === 'string' ? value.currentPath.trim() : ''

  if (!novelId || !previousPath || !currentPath) throw new Error('项目位置参数非法。')
  return { novelId, previousPath, currentPath }
}

export async function rememberNovelProjectPath(
  input: RememberNovelProjectPathInput,
  dependencies: {
    loadProjectSummary: (projectPath: string) => Promise<NovelProjectSummary>
    readConfig: () => Promise<AppConfig>
    writeConfig: (config: AppConfig) => Promise<unknown>
  },
): Promise<{ updated: boolean }> {
  if (input.previousPath === input.currentPath) return { updated: false }

  const project = await dependencies.loadProjectSummary(input.currentPath)
  if (!isOpenableNovelProject(project.status) || project.id !== input.novelId) {
    throw new Error('项目身份与新位置不匹配。')
  }

  const config = await dependencies.readConfig()
  await dependencies.writeConfig({
    ...config,
    recentNovelPaths: reconcileRecentNovelPaths(
      config.recentNovelPaths,
      input.previousPath,
      input.currentPath,
    ),
  })
  return { updated: true }
}
