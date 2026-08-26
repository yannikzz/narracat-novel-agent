import { describe, expect, test } from 'bun:test'
import { canRemoveFromLibrary } from './library-project'

describe('canRemoveFromLibrary', () => {
  test('an outside project can be removed because the shelf only remembers its path', () => {
    expect(canRemoveFromLibrary('/Users/a/Desktop/借来的书', '/Users/a/Novels')).toBe(true)
  })

  test('a project inside the novel root cannot be removed — the next scan brings it back', () => {
    // 书架 = novelRootDir 的子目录 + 最近路径。root 下的项目摘掉最近路径也没用，
    // 下次扫描照样出现。给一个点了不生效的按钮比不给更糟。
    expect(canRemoveFromLibrary('/Users/a/Novels/novel-x', '/Users/a/Novels')).toBe(false)
  })
})
