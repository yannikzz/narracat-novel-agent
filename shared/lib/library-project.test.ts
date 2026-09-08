import { describe, expect, test } from 'bun:test'
import { canRemoveFromLibrary, isOpenableNovelProject } from './library-project'

describe('canRemoveFromLibrary', () => {
  test('an outside project can be removed because the shelf only remembers its path', () => {
    expect(canRemoveFromLibrary({ path: '/Users/a/Desktop/借来的书', status: 'invalid' }, '/Users/a/Novels')).toBe(true)
  })

  test('a project inside the novel root cannot be removed — the next scan brings it back', () => {
    // 书架 = novelRootDir 的子目录 + 最近路径。root 下的项目摘掉最近路径也没用，
    // 下次扫描照样出现。给一个点了不生效的按钮比不给更糟。
    expect(canRemoveFromLibrary({ path: '/Users/a/Novels/novel-x', status: 'invalid' }, '/Users/a/Novels')).toBe(false)
  })

  test('a missing project inside the root can be removed — the directory is gone, a rescan will not bring it back (ADR-0046)', () => {
    expect(canRemoveFromLibrary({ path: '/Users/a/Novels/novel-x', status: 'missing' }, '/Users/a/Novels')).toBe(true)
    expect(canRemoveFromLibrary({ path: 'D:\\NarraCat\\novel-x', status: 'missing' }, 'D:\\NarraCat')).toBe(true)
  })
})

describe('isOpenableNovelProject', () => {
  test('missing and invalid projects have no identity and cannot be opened', () => {
    expect(isOpenableNovelProject('missing')).toBe(false)
    expect(isOpenableNovelProject('invalid')).toBe(false)
    for (const status of ['ready', 'needs-setup', 'needs-outline', 'in-progress'] as const) {
      expect(isOpenableNovelProject(status)).toBe(true)
    }
  })
})
