/**
 * 书架条目的可操作性判断（#38 / ADR-0046）。
 *
 * 书架列表 = `novelRootDir` 的直接子目录 + 配置里的最近路径，两者合并。
 * 因此「从书架移除」只对后者成立：root 下的项目摘掉最近路径也没用，下次扫描照样出现。
 * 给作者一个点了不生效的按钮，比不给这个按钮更糟。
 *
 * 例外是 Missing（目录已不存在）：目录都没了，重扫不会再把它加回来，「在根目录内不可移除」
 * 的理由随之消失——无条件允许移除，否则作者会永远看着一张幽灵卡。
 */
import type { NovelProjectStatus } from '@shared/types/novel'

/** Missing / Invalid 的项目没有身份：不进 Workbench、没有 Agent 线程、不发任何内容/状态请求。 */
export function isOpenableNovelProject(status: NovelProjectStatus): boolean {
  return status !== 'invalid' && status !== 'missing'
}

function segments(path: string): string[] {
  return path.trim().replace(/[/\\]+$/, '').split(/[/\\]+/)
}

export function canRemoveFromLibrary(
  project: { path: string; status: NovelProjectStatus },
  novelRootDir: string,
): boolean {
  if (project.status === 'missing') return true
  const parent = segments(project.path).slice(0, -1).join('/')
  return parent !== segments(novelRootDir).join('/')
}
