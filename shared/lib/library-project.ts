/**
 * 书架条目的可操作性判断（#38）。
 *
 * 书架列表 = `novelRootDir` 的直接子目录 + 配置里的最近路径，两者合并。
 * 因此「从书架移除」只对后者成立：root 下的项目摘掉最近路径也没用，下次扫描照样出现。
 * 给作者一个点了不生效的按钮，比不给这个按钮更糟。
 */

function segments(path: string): string[] {
  return path.trim().replace(/[/\\]+$/, '').split(/[/\\]+/)
}

export function canRemoveFromLibrary(projectPath: string, novelRootDir: string): boolean {
  const parent = segments(projectPath).slice(0, -1).join('/')
  return parent !== segments(novelRootDir).join('/')
}
