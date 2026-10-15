import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

import { parseReleaseNotes, renderReleaseBody } from './release-notes.mjs'

const notesDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'docs', 'release-notes')

const good = `# 重写不再清后文

这一版修好了重写章节的几个老问题，并加上网络代理。

## 新增

- 设置里可以填网络代理

## 修复

- 重写中间某章，不再清掉后面各章的进度

## 备注

- 已受影响的书，这一版不会自动修复`

describe('parseReleaseNotes', () => {
  test('标准格式：标题、导语、分块逐一拆出，无问题', () => {
    const notes = parseReleaseNotes(good)
    expect(notes.problems).toEqual([])
    expect(notes.title).toBe('重写不再清后文')
    expect(notes.summary).toBe('这一版修好了重写章节的几个老问题，并加上网络代理。')
    expect(notes.sections.map((section) => section.name)).toEqual(['新增', '修复', '备注'])
  })

  test('缺标题、缺导语都算结构错误', () => {
    const problems = parseReleaseNotes('## 修复\n\n- 某个问题').problems
    expect(problems.some((problem) => problem.includes('主题标题'))).toBe(true)
    expect(problems.some((problem) => problem.includes('导语'))).toBe(true)
  })

  test('不认识的分块、顺序颠倒、重复分块都拦', () => {
    expect(parseReleaseNotes('# 标题\n\n导语。\n\n## 新东西\n\n- a').problems.join()).toContain('不认「新东西」')
    expect(parseReleaseNotes('# 标题\n\n导语。\n\n## 修复\n\n- a\n\n## 新增\n\n- b').problems.join()).toContain('放错了位置')
    expect(parseReleaseNotes('# 标题\n\n导语。\n\n## 修复\n\n- a\n\n## 修复\n\n- b').problems.join()).toContain('两次')
  })

  test('条目必须一行一条：跨行续写、分块里夹段落都拦', () => {
    const problems = parseReleaseNotes('# 标题\n\n导语。\n\n## 修复\n\n- 第一行\n  接着写第二行').problems
    expect(problems.join()).toContain('每条都写成一行')
  })

  test('只有备注不算一版内容', () => {
    expect(parseReleaseNotes('# 标题\n\n导语。\n\n## 备注\n\n- a').problems.join()).toContain('至少要有一块')
  })

  test('长条目与加粗只出提示，不算错误', () => {
    const notes = parseReleaseNotes(`# 标题\n\n导语。\n\n## 修复\n\n- **${'很长'.repeat(30)}**`)
    expect(notes.problems).toEqual([])
    expect(notes.hints.some((hint) => hint.includes('字'))).toBe(true)
    expect(notes.hints.some((hint) => hint.includes('加粗'))).toBe(true)
  })
})

describe('renderReleaseBody', () => {
  test('通用样板并进已有的备注末尾，不另起一块', () => {
    const body = renderReleaseBody(parseReleaseNotes(good), { hasWindows: true })
    expect(body.match(/## 备注/g)).toHaveLength(1)
    expect(body.indexOf('不会自动修复')).toBeLessThan(body.indexOf('自动更新'))
    expect(body).toContain('暂未代码签名')
    expect(body).not.toContain('# 重写不再清后文')
  })

  test('没写备注时补一个备注块；没有 Windows 产物时不提 Windows', () => {
    const body = renderReleaseBody(parseReleaseNotes(good.split('\n\n## 备注')[0]), { hasWindows: false })
    expect(body.endsWith('首次安装 macOS 下载 dmg')).toBe(true)
    expect(body).not.toContain('Windows')
  })

  test('不改动传入的解析结果（同一份 notes 会渲染多次：确认界面一次、发布一次）', () => {
    const notes = parseReleaseNotes(good)
    renderReleaseBody(notes, { hasWindows: true })
    expect(renderReleaseBody(notes, { hasWindows: true })).toBe(renderReleaseBody(notes, { hasWindows: true }))
  })
})

// 仓里每一份发布说明都要过同一套格式——历史版本也是官网更新日志的一部分。
describe('docs/release-notes 下的现有文件', () => {
  for (const file of readdirSync(notesDir).filter((name) => /^\d+\.\d+\.\d+\.md$/.test(name))) {
    test(`${file} 格式正确`, () => {
      expect(parseReleaseNotes(readFileSync(join(notesDir, file), 'utf8')).problems).toEqual([])
    })
  }
})
