import { describe, expect, test } from 'bun:test'
import { extractToolTargetPath, relativizeKnownRoots } from './agent-path-scrub'

describe('relativizeKnownRoots', () => {
  test('rewrites a path under the project root as <项目>/…', () => {
    const result = relativizeKnownRoots(
      "ENOENT: no such file or directory, access '/Users/a/Novels/novel-x/bible/characters/林小满.md'",
      [{ label: '项目', path: '/Users/a/Novels/novel-x' }],
    )

    expect(result).toContain('<项目>/bible/characters/林小满.md')
    expect(result).not.toContain('/Users/a')
  })

  test('does not treat a sibling directory sharing the root name as inside the root', () => {
    // /novel-x 与 /novel-x-backup 是两本不同的书。按字符串前缀切会把后者改写成
    // `<项目>-backup`，读起来像项目内路径，实际是另一个目录——取证会指向错的地方。
    const result = relativizeKnownRoots('/Users/a/Novels/novel-x-backup/bible/世界观.md', [
      { label: '项目', path: '/Users/a/Novels/novel-x' },
    ])

    expect(result).toBe('/Users/a/Novels/novel-x-backup/bible/世界观.md')
  })

  test('matches a Windows root regardless of which separator each side uses', () => {
    // Windows 上两侧分隔符常不一致：projectPath 可能来自配置（正斜杠），而 Node 的错误
    // 信息给的是反斜杠。按字面匹配会整条漏掉，取证在 Windows 上等于没做。
    const result = relativizeKnownRoots(
      "EISDIR: illegal operation on a directory, read 'C:\\Users\\a\\Novels\\novel-x\\bible\\characters'",
      [{ label: '项目', path: 'C:/Users/a/Novels/novel-x' }],
    )

    expect(result).toContain('<项目>')
    expect(result).not.toContain('C:\\Users\\a')
  })
})

describe('extractToolTargetPath', () => {
  test('reads the file path from a Read call', () => {
    expect(extractToolTargetPath({ file_path: '/a/b/chapters/001.md' })).toBe(
      '/a/b/chapters/001.md',
    )
  })


  test('reads the pi runtime path argument (#37 dogfood: real tools use `path`)', () => {
    // 真机取证：pi 的 read/write/find/grep 一律用 `path`。
    // 最初照搬了 tool-phrase.ts 的 ['file_path','filePath']——那是 claude-sdk 时代的
    // 契约（工具名还是大写 Read），换 pi 后早已不成立，导致 target 在真实 run 里恒为空。
    expect(extractToolTargetPath({ path: '/a/b/.narracat/staging/ch-021.md' })).toBe(
      '/a/b/.narracat/staging/ch-021.md',
    )
  })

  test('returns undefined for a tool call that carries no path', () => {
    // 无路径的工具（MCP 查询等）不该凭空造出一个 target 字段。
    expect(extractToolTargetPath({ query: '林小满是谁' })).toBeUndefined()
  })
})
