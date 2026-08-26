import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import {
  isNarraCatProject,
  loadNovelProjectDetail,
  loadNovelProjectSummary,
  mapWithConcurrency,
  updateNovelProjectMetadata,
} from './novel-project'
import { createNovelProjectFixture, writeNovelFixtureFile, writeZeroPlannedState } from './test-novel-fixture'

async function makeNovelProject(name: string): Promise<string> {
  return (await createNovelProjectFixture({ name, state: 'chaptered' })).root
}

describe('novel project loading', () => {
  test('maps project detail work with bounded concurrency while preserving order', async () => {
    const active: number[] = []
    let maxActive = 0

    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active.push(value)
      maxActive = Math.max(maxActive, active.length)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active.splice(active.indexOf(value), 1)
      return value * 10
    })

    expect(result).toEqual([10, 20, 30, 40, 50])
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  test('detects NarraCat projects by required config and state files', async () => {
    const root = await makeNovelProject('detect')
    expect(await isNarraCatProject(root)).toBe(true)
    expect(await isNarraCatProject(join(root, 'outline'))).toBe(false)
  })

  test('does not silently add a Project Agent guide when loading existing projects', async () => {
    const root = await makeNovelProject('legacy-guide')
    const guidePath = join(root, 'AGENTS.md')

    await expect(stat(guidePath)).rejects.toThrow()

    await loadNovelProjectSummary(root)
    await loadNovelProjectDetail(root)

    await expect(stat(guidePath)).rejects.toThrow()
  })

  test('loads a project summary from config and state', async () => {
    const root = await makeNovelProject('summary')

    const summary = await loadNovelProjectSummary(root)

    expect(summary).toMatchObject({
      id: 'novel-1',
      title: '星辰大海',
      path: root,
      status: 'ready',
      chapterProgress: '1 / 2 章',
      wordCountLabel: '2100 字',
    })
  })

  test('loads genre and selected cover preset from project config', async () => {
    const root = await makeNovelProject('metadata')
    await writeNovelFixtureFile(
      root,
      join('.narracat', 'config.yaml'),
      [
        'novel_id: novel-42',
        'title: 星辰大海',
        'genre: 仙侠',
        'cover_preset: cover-07',
        'language: zh-CN',
        'automation_level: auto',
        'estimated_total_chapters: null',
        'words_per_chapter: null',
        'style_profile: null',
        '',
      ].join('\n'),
    )

    const summary = await loadNovelProjectSummary(root)

    expect(summary).toMatchObject({
      id: 'novel-42',
      genre: '仙侠',
      coverPreset: 'cover-07',
    })
  })

  test('keeps legacy projects visible with fallback genre and stable cover preset', async () => {
    const root = await makeNovelProject('legacy-metadata')

    const firstSummary = await loadNovelProjectSummary(root)
    const secondSummary = await loadNovelProjectSummary(root)

    expect(firstSummary.genre).toBe('未分类')
    expect(firstSummary.coverPreset).toMatch(/^cover-\d{2}$/)
    expect(secondSummary.coverPreset).toBe(firstSummary.coverPreset)
  })

  test('updates display metadata without renaming the directory or changing novel identity', async () => {
    const root = await makeNovelProject('update-metadata')

    const updated = await updateNovelProjectMetadata({
      projectPath: root,
      title: '新的书名',
      coverPreset: 'cover-08',
    })
    const config = await readFile(join(root, '.narracat', 'config.yaml'), 'utf-8')

    expect(updated).toMatchObject({
      id: 'novel-1',
      title: '新的书名',
      coverPreset: 'cover-08',
      path: root,
    })
    expect(config).toContain('novel_id: novel-1')
    expect(config).toContain('title: 新的书名')
    expect(config).toContain('cover_preset: cover-08')
  })

  test('reports the current automation level and treats a missing one as collaborative', async () => {
    const root = await makeNovelProject('automation-level')

    expect((await loadNovelProjectSummary(root)).automationLevel).toBe('auto')

    await writeNovelFixtureFile(
      root,
      join('.narracat', 'config.yaml'),
      ['novel_id: novel-1', 'title: 星辰大海', 'language: zh-CN', ''].join('\n'),
    )

    expect((await loadNovelProjectSummary(root)).automationLevel).toBe('collaborative')
  })

  test('switches the automation level and keeps the rest of config.yaml untouched', async () => {
    const root = await makeNovelProject('switch-automation')

    const updated = await updateNovelProjectMetadata({ projectPath: root, automationLevel: 'collaborative' })
    const config = await readFile(join(root, '.narracat', 'config.yaml'), 'utf-8')

    expect(updated.automationLevel).toBe('collaborative')
    expect(config).toContain('automation_level: collaborative')
    expect(config).toContain('novel_id: novel-1')
    expect(config).toContain('title: 星辰大海')
    expect(config).toContain('language: zh-CN')
    expect(config).toContain('estimated_total_chapters: null')
    expect(config).toContain('words_per_chapter: null')
    expect(config).toContain('style_profile: null')
  })

  test('rejects blank titles and unknown cover presets when updating metadata', async () => {
    const root = await makeNovelProject('reject-metadata')

    await expect(updateNovelProjectMetadata({ projectPath: root, title: '   ' })).rejects.toThrow('标题不能为空')
    await expect(updateNovelProjectMetadata({ projectPath: root, coverPreset: 'cover-99' })).rejects.toThrow(
      '封面预设不存在',
    )
  })

  test('loads checkpoint metadata into project summaries and details', async () => {
    const root = await makeNovelProject('checkpoint')
    await writeFile(
      join(root, '.narracat', 'state.yaml'),
      [
        'progress:',
        '  last_completed_chapter: 0',
        '  completed_chapters: []',
        '  in_progress_chapter: 1',
        '  total_chapters_planned: 2',
        'word_count:',
        '  total: 0',
        '  by_chapter: {}',
        'checkpoint:',
        '  last_command: /narracat:write 1',
        '  last_step: 3',
        '  timestamp: 2026-05-03T10:00:00.000Z',
        'structure:',
        '  total_volumes: 1',
        '  total_chapters_planned: 2',
        '  chapter_to_volume:',
        '    1: 1',
        '    2: 1',
        '',
      ].join('\n'),
      'utf-8',
    )

    const summary = await loadNovelProjectSummary(root)
    const detail = await loadNovelProjectDetail(root, 1)

    expect(summary.checkpoint).toEqual({
      lastCommand: '/narracat:write 1',
      lastStep: 3,
      timestamp: '2026-05-03T10:00:00.000Z',
    })
    expect(detail.checkpoint).toEqual(summary.checkpoint)
  })

  test('reports needs-setup for a newly initialized project with template bible files', async () => {
    const root = (await createNovelProjectFixture({ name: 'needs-setup', state: 'empty' })).root
    await mkdir(join(root, 'bible', 'characters'), { recursive: true })
    await mkdir(join(root, 'bible', 'world'), { recursive: true })
    await mkdir(join(root, 'bible', 'reference-guidance'), { recursive: true })
    await writeFile(join(root, 'bible', 'premise.md'), '# 核心前提\n\n（用一句话概括整个故事）\n', 'utf-8')
    await writeFile(
      join(root, 'bible', 'reference-guidance', 'premise.md'),
      '# 前提参考指导\n\n参考作品建议聚焦复仇承诺。\n',
      'utf-8',
    )
    await writeFile(
      join(root, 'bible', 'characters', '角色名.md'),
      '# 角色名\n\n## 基本信息\n- 全名:\n',
      'utf-8',
    )
    await writeFile(
      join(root, 'bible', 'world', '设定名称.md'),
      '# 设定名称\n\n## 概述\n（一段话概括）\n',
      'utf-8',
    )
    await writeFile(
      join(root, 'bible', 'relationships.md'),
      [
        '# 角色关系图谱',
        '',
        '## 核心关系',
        '',
        '| 角色 A | 关系 | 角色 B | 备注 |',
        '|---|---|---|---|',
        '',
        '## 阵营/势力',
        '',
        '（如有阵营划分在此描述）',
        '',
      ].join('\n'),
      'utf-8',
    )
    await writeZeroPlannedState(root)

    const summary = await loadNovelProjectSummary(root)
    const detail = await loadNovelProjectDetail(root)
    const treeItemsById = new Map(detail.treeItems.map((item) => [item.id, item]))

    expect(summary.status).toBe('needs-setup')
    expect(treeItemsById.get('bible-premise')?.exists).toBe(false)
    expect(treeItemsById.get('bible-relationships')?.exists).toBe(false)
    expect(treeItemsById.get('characters')?.exists).toBe(false)
    expect(treeItemsById.get('world')?.exists).toBe(false)
  })

  test('reports needs-outline after the setup premise is filled but no chapter plan exists', async () => {
    const root = await makeNovelProject('needs-outline')
    await writeFile(
      join(root, 'bible', 'premise.md'),
      '# 核心前提\n\n## 一句话概要\n真实前提\n',
      'utf-8',
    )
    await writeZeroPlannedState(root)

    const summary = await loadNovelProjectSummary(root)

    expect(summary.status).toBe('needs-outline')
  })

  test('reports needs-outline when premise reference guidance was used but only premise is filled', async () => {
    const root = await makeNovelProject('needs-outline-with-guidance')
    await mkdir(join(root, 'bible', 'reference-guidance'), { recursive: true })
    await writeFile(
      join(root, 'bible', 'reference-guidance', 'premise.md'),
      '# 前提参考指导\n\n参考作品建议保留师徒反目张力。\n',
      'utf-8',
    )
    await writeFile(
      join(root, 'bible', 'premise.md'),
      '# 核心前提\n\n## 一句话概要\n真实前提\n',
      'utf-8',
    )
    await writeZeroPlannedState(root)

    const summary = await loadNovelProjectSummary(root)

    expect(summary.status).toBe('needs-outline')
  })

  test('loads TOC with completed and planned chapter status', async () => {
    const root = await makeNovelProject('detail')

    const detail = await loadNovelProjectDetail(root, 2)

    expect(detail.selectedChapter).toBe(2)
    expect(detail.tocItems).toContainEqual({
      id: 'volume-1',
      kind: 'volume',
      title: '第 1 卷',
      volumeNumber: 1,
    })
    expect(detail.tocItems).toContainEqual({
      id: 'chapter-1',
      kind: 'chapter',
      title: '第 001 章 · 初醒',
      chapterNumber: 1,
      volumeNumber: 1,
      status: 'completed',
      active: false,
    })
    expect(detail.tocItems).toContainEqual({
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章 · 远行',
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'planned',
      active: true,
    })
  })

  test('projects an interrupted write checkpoint as a recoverable chapter', async () => {
    const root = await makeNovelProject('recoverable-write')
    await writeNovelFixtureFile(
      root,
      join('.narracat', 'state.yaml'),
      [
        'progress:',
        '  last_completed_chapter: 1',
        '  completed_chapters: [1]',
        '  in_progress_chapter: 2',
        '  total_chapters_planned: 2',
        'word_count:',
        '  total: 2100',
        '  by_chapter:',
        '    1: 2100',
        'checkpoint:',
        '  last_command: write',
        '  last_step: 5',
        '  timestamp: 2026-05-18T10:00:00.000Z',
        'structure:',
        '  total_volumes: 1',
        '  total_chapters_planned: 2',
        '  chapter_to_volume:',
        '    1: 1',
        '    2: 1',
        '',
      ].join('\n'),
    )
    await writeNovelFixtureFile(root, join('manuscript', 'vol-01', 'ch-002.md'), '# 第2章\n\n已生成但未入库正文\n')
    await writeNovelFixtureFile(root, join('reviews', 'ch-002-review.md'), '**审修结果**: PASS\n')

    const summary = await loadNovelProjectSummary(root)
    const detail = await loadNovelProjectDetail(root)
    const treeItemsById = new Map(detail.treeItems.map((item) => [item.id, item]))

    expect(summary.status).toBe('in-progress')
    expect(detail.selectedChapter).toBe(2)
    expect(detail.tocItems).toContainEqual(
      expect.objectContaining({
        id: 'chapter-2',
        status: 'recoverable',
        active: true,
      }),
    )
    expect(treeItemsById.get('chapter-2')).toMatchObject({
      kind: 'chapter',
      status: 'recoverable',
    })
  })

  test('uses the checkpoint command chapter when in_progress_chapter was not persisted yet', async () => {
    const root = await makeNovelProject('checkpoint-command-recoverable-write')
    await writeNovelFixtureFile(
      root,
      join('.narracat', 'state.yaml'),
      [
        'progress:',
        '  last_completed_chapter: 1',
        '  completed_chapters: [1]',
        '  in_progress_chapter: null',
        '  total_chapters_planned: 2',
        'word_count:',
        '  total: 2100',
        '  by_chapter:',
        '    1: 2100',
        'checkpoint:',
        '  last_command: write 2',
        '  last_step: 1',
        '  timestamp: 2026-05-18T10:00:00.000Z',
        'structure:',
        '  total_volumes: 1',
        '  total_chapters_planned: 2',
        '  chapter_to_volume:',
        '    1: 1',
        '    2: 1',
        '',
      ].join('\n'),
    )

    const detail = await loadNovelProjectDetail(root)

    expect(detail.selectedChapter).toBe(2)
    expect(detail.tocItems).toContainEqual(
      expect.objectContaining({
        id: 'chapter-2',
        status: 'recoverable',
        active: true,
      }),
    )
  })

  test('uses legacy top-level in_progress_chapter as a recoverable write hint', async () => {
    const root = await makeNovelProject('legacy-recoverable-write')
    await writeNovelFixtureFile(
      root,
      join('.narracat', 'state.yaml'),
      [
        'progress:',
        '  last_completed_chapter: 1',
        '  completed_chapters: [1]',
        '  in_progress_chapter: null',
        '  total_chapters_planned: 2',
        'in_progress_chapter: 2',
        'word_count:',
        '  total: 2100',
        '  by_chapter:',
        '    1: 2100',
        'checkpoint:',
        '  last_command: /narracat:write',
        '  last_step: 4',
        '  timestamp: 2026-05-18T11:00:00.000Z',
        'structure:',
        '  total_volumes: 1',
        '  total_chapters_planned: 2',
        '  chapter_to_volume:',
        '    1: 1',
        '    2: 1',
        '',
      ].join('\n'),
    )

    const summary = await loadNovelProjectSummary(root)
    const detail = await loadNovelProjectDetail(root)

    expect(summary.status).toBe('in-progress')
    expect(detail.selectedChapter).toBe(2)
    expect(detail.tocItems).toContainEqual(
      expect.objectContaining({
        id: 'chapter-2',
        status: 'recoverable',
        active: true,
      }),
    )
  })

  test('marks chapters completed when NarraCat writes unpadded manuscript filenames', async () => {
    const root = await makeNovelProject('unpadded-manuscript-status')
    await rm(join(root, 'manuscript', 'vol-01', 'ch-001.md'))
    await writeFile(join(root, 'manuscript', 'vol-01', 'ch-1.md'), '# 第1章\n\n正文\n', 'utf-8')

    const detail = await loadNovelProjectDetail(root, 1)

    expect(detail.tocItems).toContainEqual(
      expect.objectContaining({
        id: 'chapter-1',
        status: 'completed',
      }),
    )
  })

  test('marks chapters completed when NarraCat writes root-level manuscript files', async () => {
    const root = await makeNovelProject('root-manuscript-status')
    await rm(join(root, 'manuscript', 'vol-01', 'ch-001.md'))
    await writeFile(join(root, 'manuscript', 'ch-001.md'), '# 第1章\n\n正文\n', 'utf-8')

    const detail = await loadNovelProjectDetail(root, 1)

    expect(detail.tocItems).toContainEqual(
      expect.objectContaining({
        id: 'chapter-1',
        status: 'completed',
      }),
    )
  })

  test('projects an interrupted write with a staging draft as interrupted-draft', async () => {
    const root = await makeNovelProject('interrupted-draft')
    await writeNovelFixtureFile(root, join('.narracat', 'staging', 'ch-002.md'), '# 第2章\n\n中断前热写的草稿\n')

    const detail = await loadNovelProjectDetail(root, 2)

    expect(detail.tocItems).toContainEqual(
      expect.objectContaining({
        id: 'chapter-2',
        status: 'interrupted-draft',
      }),
    )
  })

  test('keeps a chapter recoverable even when it also has a staging draft', async () => {
    const root = await makeNovelProject('recoverable-with-staging')
    await writeNovelFixtureFile(
      root,
      join('.narracat', 'state.yaml'),
      [
        'progress:',
        '  last_completed_chapter: 1',
        '  completed_chapters: [1]',
        '  in_progress_chapter: 2',
        '  total_chapters_planned: 2',
        'word_count:',
        '  total: 2100',
        '  by_chapter:',
        '    1: 2100',
        'checkpoint:',
        '  last_command: write',
        '  last_step: 5',
        '  timestamp: 2026-05-18T10:00:00.000Z',
        'structure:',
        '  total_volumes: 1',
        '  total_chapters_planned: 2',
        '  chapter_to_volume:',
        '    1: 1',
        '    2: 1',
        '',
      ].join('\n'),
    )
    await writeNovelFixtureFile(root, join('.narracat', 'staging', 'ch-002.md'), '# 第2章\n\n中断前热写的草稿\n')

    const detail = await loadNovelProjectDetail(root)

    expect(detail.tocItems).toContainEqual(
      expect.objectContaining({
        id: 'chapter-2',
        status: 'recoverable',
      }),
    )
  })

  test('does not let a leftover staging draft affect an already completed chapter', async () => {
    const root = await makeNovelProject('completed-with-stale-staging')
    await writeNovelFixtureFile(root, join('.narracat', 'staging', 'ch-001.md'), '# 第1章\n\n本该被清理的残留草稿\n')

    const detail = await loadNovelProjectDetail(root, 1)

    expect(detail.tocItems).toContainEqual(
      expect.objectContaining({
        id: 'chapter-1',
        status: 'completed',
      }),
    )
  })

  test('loads a NarraCat object tree with master outline, bible nodes, volume outline, and chapters', async () => {
    const root = await makeNovelProject('tree')
    await mkdir(join(root, 'bible', 'characters'), { recursive: true })
    await mkdir(join(root, 'bible', 'world'), { recursive: true })
    await mkdir(join(root, 'bible', 'references'), { recursive: true })
    await writeFile(join(root, 'outline', 'master-outline.md'), '# 全书大纲\n', 'utf-8')
    await writeFile(join(root, 'bible', 'premise.md'), '# 核心前提\n\n真实前提\n', 'utf-8')
    await writeFile(join(root, 'bible', 'style-guide.md'), '# 风格指南\n\n第三人称\n', 'utf-8')
    await writeFile(join(root, 'bible', 'relationships.md'), '# 关系设定\n\n林舟与边境城相关。\n', 'utf-8')
    await writeFile(join(root, 'bible', 'characters', '林舟.md'), '# 林舟\n', 'utf-8')
    await writeFile(join(root, 'bible', 'world', '边境城.md'), '# 边境城\n', 'utf-8')
    // 英文 slug 文件名 + 中文标题：目录条目应展示文档标题，id 仍绑定文件名。
    await writeFile(join(root, 'bible', 'world', 'jianghu-rules.md'), '# 江湖规则体系\n', 'utf-8')
    await writeFile(join(root, 'bible', 'references', '参考章.md'), '# 参考章\n', 'utf-8')
    await writeFile(join(root, 'bible', 'references', '参考章.txt'), '参考章\n', 'utf-8')

    const detail = await loadNovelProjectDetail(root, 2)

    expect(detail.treeItems).toContainEqual(
      expect.objectContaining({
        id: 'master-outline',
        kind: 'master-outline',
        title: '全书大纲',
        level: 0,
        path: join('outline', 'master-outline.md'),
        exists: true,
      }),
    )
    expect(detail.treeItems).toContainEqual(
      expect.objectContaining({
        id: 'foundation',
        kind: 'foundation',
        title: '创作根基',
        level: 0,
      }),
    )
    expect(detail.treeItems).toContainEqual(
      expect.objectContaining({
        id: 'bible-premise',
        kind: 'bible-document',
        title: '核心前提',
        level: 1,
        parentId: 'foundation',
        path: join('bible', 'premise.md'),
        exists: true,
      }),
    )
    expect(detail.treeItems.some((item) => item.id === 'bible-style-guide')).toBe(false)
    expect(
      detail.treeItems
        .filter((item) => item.parentId === 'foundation' && item.level === 1)
        .map((item) => item.id),
    ).toEqual(['bible-premise', 'world', 'characters', 'bible-relationships'])
    expect(detail.treeItems.find((item) => item.id === 'characters')).toMatchObject({
      kind: 'character-list',
      title: '小说角色',
    })
    expect(detail.treeItems).toContainEqual(
      expect.objectContaining({
        id: 'character-林舟',
        kind: 'character',
        title: '林舟',
        level: 2,
        parentId: 'characters',
        path: join('bible', 'characters', '林舟.md'),
        exists: true,
      }),
    )
    expect(detail.treeItems).toContainEqual(
      expect.objectContaining({
        id: 'world-边境城',
        kind: 'world',
        title: '边境城',
        level: 2,
        parentId: 'world',
        path: join('bible', 'world', '边境城.md'),
        exists: true,
      }),
    )
    expect(detail.treeItems).toContainEqual(
      expect.objectContaining({
        id: 'world-jianghu-rules',
        kind: 'world',
        title: '江湖规则体系',
        level: 2,
        parentId: 'world',
        path: join('bible', 'world', 'jianghu-rules.md'),
        exists: true,
      }),
    )
    expect(detail.treeItems).toContainEqual(
      expect.objectContaining({
        id: 'references',
        kind: 'reference-list',
        title: '参考作品',
        level: 0,
      }),
    )
    expect(detail.treeItems.some((item) => item.id.startsWith('reference-'))).toBe(false)
    expect(detail.treeItems).toContainEqual(
      expect.objectContaining({
        id: 'volume-outline-1',
        kind: 'volume-outline',
        title: '卷大纲',
        level: 1,
        volumeNumber: 1,
        parentId: 'volume-1',
        path: join('outline', 'vol-01', 'vol-outline.md'),
        exists: true,
      }),
    )
    expect(detail.treeItems).toContainEqual(
      expect.objectContaining({
        id: 'chapter-2',
        kind: 'chapter',
        title: '第 002 章 · 远行',
        level: 1,
        chapterNumber: 2,
        volumeNumber: 1,
        status: 'planned',
        parentId: 'volume-1',
      }),
    )
  })

  test('projects narrator voice into settings only after plan writes it into the master outline', async () => {
    const root = await makeNovelProject('narrator-voice-tree')
    await writeFile(
      join(root, 'outline', 'master-outline.md'),
      [
        '# 全书大纲',
        '',
        '## 叙述者腔调（required，双路产出）',
        '- **archetype**: 猛文热血',
        '- **dimensions**:',
        '  - pacing: 急',
        '',
        '## 主要叙事弧线',
        '',
      ].join('\n'),
      'utf-8',
    )

    const detail = await loadNovelProjectDetail(root)

    expect(
      detail.treeItems
        .filter((item) => item.parentId === 'foundation' && item.level === 1)
        .map((item) => item.id),
    ).toEqual(['bible-premise', 'world', 'characters', 'bible-relationships', 'narrator-voice'])
    expect(detail.treeItems.find((item) => item.id === 'narrator-voice')).toMatchObject({
      kind: 'narrator-voice',
      title: '叙事声音',
      path: join('outline', 'master-outline.md'),
      exists: true,
    })
  })

  test('loads dynamic bible directories as foundation setting groups', async () => {
    const root = await makeNovelProject('dynamic-bible')
    await mkdir(join(root, 'bible', 'scenes'), { recursive: true })
    await writeFile(join(root, 'bible', 'scenes', 'spaceport.md'), '# Spaceport\n', 'utf-8')

    const detail = await loadNovelProjectDetail(root, 2)

    expect(detail.treeItems).toContainEqual(
      expect.objectContaining({
        id: 'bible-scenes',
        kind: 'bible-group',
        title: '场景设定',
        level: 1,
        parentId: 'foundation',
        path: join('bible', 'scenes'),
        exists: true,
      }),
    )
  })

  test('loads world settings as a flat direct-file group', async () => {
    const root = await makeNovelProject('flat-world-settings')
    await rm(join(root, 'bible', 'world'), { recursive: true, force: true })
    await mkdir(join(root, 'bible', 'world', 'nested'), { recursive: true })
    await writeFile(join(root, 'bible', 'world', '学院.md'), '# 学院\n\n学院制度。\n', 'utf-8')
    await writeFile(join(root, 'bible', 'world', '边境城.md'), '# 边境城\n\n边境贸易。\n', 'utf-8')
    await writeFile(join(root, 'bible', 'world', 'nested', '隐藏势力.md'), '# 隐藏势力\n', 'utf-8')

    const detail = await loadNovelProjectDetail(root, 2)
    const worldGroup = detail.treeItems.find((item) => item.id === 'world')
    const worldEntries = detail.treeItems.filter((item) => item.parentId === 'world')

    expect(worldGroup).toMatchObject({
      id: 'world',
      kind: 'world-list',
      exists: true,
    })
    expect(worldEntries).toHaveLength(2)
    expect(worldEntries.map((item) => item.id)).toEqual(expect.arrayContaining(['world-学院', 'world-边境城']))
    expect(worldEntries.map((item) => item.id)).not.toContain('world-隐藏势力')
  })

  test('marks dynamic bible text directories as existing setting groups', async () => {
    const root = await makeNovelProject('dynamic-bible-text')
    await mkdir(join(root, 'bible', 'scenes'), { recursive: true })
    await writeFile(join(root, 'bible', 'scenes', 'notes.txt'), '场景资料\n', 'utf-8')

    const detail = await loadNovelProjectDetail(root, 2)

    expect(detail.treeItems).toContainEqual(
      expect.objectContaining({
        id: 'bible-scenes',
        kind: 'bible-group',
        title: '场景设定',
        path: join('bible', 'scenes'),
        exists: true,
      }),
    )
  })

  test('does not treat nested-only bible directories as generated settings groups', async () => {
    const root = await makeNovelProject('nested-only-bible-groups')
    await rm(join(root, 'bible', 'world'), { recursive: true, force: true })
    await mkdir(join(root, 'bible', 'world', 'nested'), { recursive: true })
    await mkdir(join(root, 'bible', 'scenes', 'nested'), { recursive: true })
    await writeFile(join(root, 'bible', 'world', 'nested', '边境城.md'), '# 边境城\n', 'utf-8')
    await writeFile(join(root, 'bible', 'scenes', 'nested', 'spaceport.md'), '# Spaceport\n', 'utf-8')

    const detail = await loadNovelProjectDetail(root, 2)

    expect(detail.treeItems.find((item) => item.id === 'world')).toMatchObject({ exists: false })
    expect(detail.treeItems.find((item) => item.id === 'bible-scenes')).toMatchObject({ exists: false })
    expect(detail.treeItems.some((item) => item.id === 'world-边境城')).toBe(false)
  })

  test('does not duplicate reserved bible document ids as dynamic groups', async () => {
    const root = await makeNovelProject('reserved-bible-groups')
    await mkdir(join(root, 'bible', 'premise'), { recursive: true })
    await mkdir(join(root, 'bible', 'style-guide'), { recursive: true })
    await mkdir(join(root, 'bible', 'relationships'), { recursive: true })
    await writeFile(join(root, 'bible', 'premise', 'extra.md'), '# Extra premise\n', 'utf-8')
    await writeFile(join(root, 'bible', 'style-guide', 'voice.md'), '# Voice\n', 'utf-8')
    await writeFile(join(root, 'bible', 'relationships', 'links.md'), '# Links\n', 'utf-8')

    const detail = await loadNovelProjectDetail(root, 2)

    expect(detail.treeItems.filter((item) => item.id === 'bible-premise')).toHaveLength(1)
    expect(detail.treeItems.filter((item) => item.id === 'bible-relationships')).toHaveLength(1)
    expect(
      detail.treeItems.some(
        (item) =>
          item.kind === 'bible-group' &&
          ['bible-premise', 'bible-style-guide', 'bible-relationships'].includes(item.id),
      ),
    ).toBe(false)
  })

  test('surfaces a structure problem when chapter_to_volume is corrupted compact flow yaml', async () => {
    const root = await makeNovelProject('corrupted-structure')
    await writeNovelFixtureFile(
      root,
      join('.narracat', 'state.yaml'),
      [
        'progress:',
        '  last_completed_chapter: 0',
        '  completed_chapters: []',
        '  in_progress_chapter: null',
        '  total_chapters_planned: 0',
        '  chapters_outlined: [1, 2]',
        'word_count:',
        '  total: 0',
        '  by_chapter: {}',
        'checkpoint:',
        '  last_command: null',
        '  last_step: null',
        '  timestamp: null',
        'structure:',
        '  total_volumes: 2',
        '  total_chapters_planned: 3',
        '  chapter_to_volume: {1:1,2:1,3:2}',
        '',
      ].join('\n'),
    )

    const summary = await loadNovelProjectSummary(root)
    const detail = await loadNovelProjectDetail(root)

    expect(summary.problem).toContain('结构数据损坏')
    expect(detail.problem).toContain('结构数据损坏')
    expect(detail.tocItems).toHaveLength(0)
  })

  test('surfaces a structure problem when the chapter map misses planned chapters', async () => {
    const root = await makeNovelProject('incomplete-structure')
    await writeNovelFixtureFile(
      root,
      join('.narracat', 'state.yaml'),
      [
        'progress:',
        '  last_completed_chapter: 0',
        '  completed_chapters: []',
        '  in_progress_chapter: null',
        '  total_chapters_planned: 3',
        'word_count:',
        '  total: 0',
        '  by_chapter: {}',
        'checkpoint:',
        '  last_command: null',
        '  last_step: null',
        '  timestamp: null',
        'structure:',
        '  total_volumes: 1',
        '  total_chapters_planned: 3',
        '  chapter_to_volume:',
        '    1: 1',
        '    2: 1',
        '',
      ].join('\n'),
    )

    const summary = await loadNovelProjectSummary(root)

    expect(summary.problem).toContain('结构数据损坏')
  })

  test('does not flag healthy projects or zero-planned scaffolds with a structure problem', async () => {
    const healthyRoot = await makeNovelProject('healthy-structure')
    const scaffoldRoot = await makeNovelProject('scaffold-structure')
    await writeZeroPlannedState(scaffoldRoot)

    const healthySummary = await loadNovelProjectSummary(healthyRoot)
    const scaffoldSummary = await loadNovelProjectSummary(scaffoldRoot)

    expect(healthySummary.problem).toBeUndefined()
    expect(scaffoldSummary.problem).toBeUndefined()
  })

  test('does not duplicate chapter labels when outline heading has no subtitle', async () => {
    const root = await makeNovelProject('bare-heading')
    await writeFile(
      join(root, '.narracat', 'state.yaml'),
      [
        'progress:',
        '  last_completed_chapter: 1',
        '  completed_chapters: [1]',
        '  in_progress_chapter: null',
        '  total_chapters_planned: 3',
        'word_count:',
        '  total: 2100',
        'checkpoint:',
        '  last_command: null',
        '  last_step: null',
        '  timestamp: null',
        'structure:',
        '  total_volumes: 1',
        '  total_chapters_planned: 3',
        '  chapter_to_volume:',
        '    1: 1',
        '    2: 1',
        '    3: 1',
        '',
      ].join('\n'),
      'utf-8',
    )
    await writeFile(join(root, 'outline', 'vol-01', 'ch-003.md'), '# 第003章\n', 'utf-8')

    const detail = await loadNovelProjectDetail(root, 3)

    expect(detail.tocItems).toContainEqual({
      id: 'chapter-3',
      kind: 'chapter',
      title: '第 003 章',
      chapterNumber: 3,
      volumeNumber: 1,
      status: 'planned',
      active: true,
    })
  })

  test('strips outline document-type words from chapter headings without eating real titles', async () => {
    const root = await makeNovelProject('outline-prefix-heading')
    // 真实章名以「大纲」开头：冒号在前，章名应原样保留。
    await writeFile(join(root, 'outline', 'vol-01', 'ch-001.md'), '# 第1章: 大纲之外\n', 'utf-8')
    // 产出漂移形态：章号后直接跟「大纲：」（文档类型字样，应剥除）。
    await writeFile(join(root, 'outline', 'vol-01', 'ch-002.md'), '# 第2章大纲：只有计划表\n', 'utf-8')

    const detail = await loadNovelProjectDetail(root, 2)
    const titlesById = new Map(detail.tocItems.map((item) => [item.id, item.title]))

    expect(titlesById.get('chapter-1')).toBe('第 001 章 · 大纲之外')
    expect(titlesById.get('chapter-2')).toBe('第 002 章 · 只有计划表')
  })
})
