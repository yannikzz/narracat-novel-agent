import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'bun:test'

import { createNarraCatPluginFixture } from '../../engine/test-plugin-fixture'
import { createNovelProjectFixture, type NovelProjectFixtureState } from '../../novel/test-novel-fixture'
import { resolveWriteNextRun } from './write-next'

let pluginPath = ''

function resolveDeps(): { pluginPath: string } {
  return { pluginPath }
}

// Project status drivers: 'empty' → needs-setup, 'setup' → needs-outline,
// 'outlined' → ready (chapter 1 planned). Replaces the removed saveNovelSetup /
// saveChapterOutline writers that used to build these on-disk states.
async function makeProject(state: NovelProjectFixtureState): Promise<string> {
  return (await createNovelProjectFixture({ name: 'write-next', state })).root
}

describe('resolveWriteNextRun', () => {
  beforeAll(async () => {
    pluginPath = await createNarraCatPluginFixture('narracat-write-next-plugin-')
  })

  test('resolves the first planned chapter for a ready project', async () => {
    const projectPath = await makeProject('outlined')

    const resolved = await resolveWriteNextRun({ projectPath, userPrompt: '继续写下一章' }, resolveDeps())

    expect(resolved).toMatchObject({
      projectPath,
      chapterNumber: 1,
      volumeNumber: 1,
      maxTurns: 72,
    })
    expect(resolved.prompt).toContain('你正在当前小说项目中执行 NarraCat command：/narracat:write')
    expect(resolved.prompt).toContain('$ARGUMENTS：1')
    expect(resolved.prompt).not.toContain('$ARGUMENTS：继续写下一章')
    expect(resolved.prompt).toContain('--- NarraCat command source begin ---')
    expect(resolved.prompt).toContain('执行 write command。参数：$ARGUMENTS。')
    expect(resolved.prompt).toContain('继续写下一章')
  })

  test('待写章已有正式正文（进度里没算完成）：拒绝写章，正文原样不动', async () => {
    const projectPath = await makeProject('outlined')
    const manuscriptPath = join(projectPath, 'manuscript', 'vol-01', 'ch-001.md')
    await writeFile(manuscriptPath, '# 第1章\n\n作者自己写的第一章。\n', 'utf-8')

    await expect(resolveWriteNextRun({ projectPath, userPrompt: '写下一章' }, resolveDeps())).rejects.toThrow(
      '第 1 章已经有正文了，但还没记进完成进度，写章不会覆盖它。开源版暂时接不上这种书，导入 NarraCat 专业版可以接着写（专业版按正文算进度）。',
    )
    expect(await readFile(manuscriptPath, 'utf-8')).toBe('# 第1章\n\n作者自己写的第一章。\n')
  })

  test('blocks projects that still need setup', async () => {
    const projectPath = await makeProject('empty')

    await expect(resolveWriteNextRun({ projectPath, userPrompt: '写下一章' }, resolveDeps())).rejects.toThrow(
      '请先完成小说设定。',
    )
  })

  test('blocks projects that still need an outline', async () => {
    const projectPath = await makeProject('setup')

    await expect(resolveWriteNextRun({ projectPath, userPrompt: '写下一章' }, resolveDeps())).rejects.toThrow(
      '请先完成大纲规划。',
    )
  })

  test('auto-recovers the interrupted chapter instead of blocking write-next', async () => {
    const projectPath = await makeProject('outlined')
    await writeFile(
      join(projectPath, '.narracat', 'state.yaml'),
      [
        'progress:',
        '  last_completed_chapter: 0',
        '  completed_chapters: []',
        '  in_progress_chapter: 1',
        '  total_chapters_planned: 12',
        'word_count:',
        '  total: 0',
        '  by_chapter: {}',
        'checkpoint:',
        '  last_command: write',
        '  last_step: 3',
        '  timestamp: 2026-05-18T12:00:00.000Z',
        'structure:',
        '  total_volumes: 1',
        '  total_chapters_planned: 12',
        '  chapter_to_volume:',
        '    1: 1',
        '',
      ].join('\n'),
      'utf-8',
    )

    const resolved = await resolveWriteNextRun({ projectPath, userPrompt: '写本章' }, resolveDeps())

    expect(resolved).toMatchObject({
      projectPath,
      chapterNumber: 1,
      volumeNumber: 1,
      maxTurns: 72,
    })
    expect(resolved.prompt).toContain('恢复诊断：')
    expect(resolved.prompt).toContain('recovery_mode: write')
    expect(resolved.prompt).toContain('checkpoint_last_step: 3')
    expect(resolved.prompt).toContain('desktop_user_intent: 写本章')
  })

  test('auto-recovery targets the interrupted chapter even when another chapter is selected', async () => {
    const projectPath = await makeProject('outlined')
    await writeFile(
      join(projectPath, '.narracat', 'state.yaml'),
      [
        'progress:',
        '  last_completed_chapter: 0',
        '  completed_chapters: []',
        '  in_progress_chapter: 1',
        '  total_chapters_planned: 12',
        'word_count:',
        '  total: 0',
        '  by_chapter: {}',
        'checkpoint:',
        '  last_command: write',
        '  last_step: 3',
        '  timestamp: 2026-05-18T12:00:00.000Z',
        'structure:',
        '  total_volumes: 1',
        '  total_chapters_planned: 12',
        '  chapter_to_volume:',
        '    1: 1',
        '    2: 1',
        '',
      ].join('\n'),
      'utf-8',
    )

    const resolved = await resolveWriteNextRun(
      { projectPath, selectedChapter: 2, userPrompt: '写第2章' },
      resolveDeps(),
    )

    expect(resolved.chapterNumber).toBe(1)
    expect(resolved.prompt).toContain('恢复诊断：')
  })
})
