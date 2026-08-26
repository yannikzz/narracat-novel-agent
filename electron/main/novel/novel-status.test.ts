import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  aggregateNovelStatusSnapshot,
  readNovelStatusSnapshot,
  refreshNovelStatusSnapshot,
} from './novel-status'
import { narracatStatusSnapshotPath } from './novel-layout'
import { createNovelProjectFixture, writeNovelFixtureFile } from './test-novel-fixture'

const createdRoots: string[] = []

async function makeProject(name: string, state: 'empty' | 'setup' | 'outlined' | 'chaptered'): Promise<string> {
  const fixture = await createNovelProjectFixture({ name, state })
  createdRoots.push(fixture.root)
  return fixture.root
}

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('novel status aggregation', () => {
  test('aggregates progress, checkpoint and next action from state.yaml (chaptered)', async () => {
    const root = await makeProject('status-chaptered', 'chaptered')

    const snapshot = await aggregateNovelStatusSnapshot(root, { now: () => new Date('2026-06-15T08:00:00.000Z') })

    expect(snapshot.generatedAt).toBe('2026-06-15T08:00:00.000Z')
    expect(snapshot.book).toEqual({ title: '星辰大海', genre: '未分类' })
    expect(snapshot.progress).toEqual({
      completedChapters: 1,
      totalChaptersPlanned: 2,
      percentage: 50,
      inProgressChapter: null,
      wordCountTotal: 2100,
      avgWordsPerChapter: 2100,
    })
    expect(snapshot.checkpoint).toBeNull()
    // last_completed_chapter = 1 → 下一步 = 2
    expect(snapshot.nextAction).toEqual({ chapter: 2 })
  })

  test('next action prefers in_progress_chapter and surfaces checkpoint', async () => {
    const root = await makeProject('status-inprogress', 'outlined')
    await writeNovelFixtureFile(
      root,
      join('.narracat', 'state.yaml'),
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
        '  last_command: write',
        '  last_step: 3',
        '  timestamp: 2026-06-14T10:00:00.000Z',
        'structure:',
        '  total_volumes: 1',
        '  total_chapters_planned: 2',
        '  chapter_to_volume:',
        '    1: 1',
        '    2: 1',
        '',
      ].join('\n'),
    )

    const snapshot = await aggregateNovelStatusSnapshot(root)

    expect(snapshot.progress.inProgressChapter).toBe(1)
    expect(snapshot.nextAction).toEqual({ chapter: 1 })
    expect(snapshot.checkpoint).toEqual({
      lastCommand: 'write',
      lastStep: 3,
      timestamp: '2026-06-14T10:00:00.000Z',
    })
  })

  test('rejects non-NarraCat directories', async () => {
    await expect(aggregateNovelStatusSnapshot('/tmp/definitely-not-a-narracat-project-xyz')).rejects.toThrow()
  })

  test('read returns null when no snapshot has been persisted (empty state)', async () => {
    const root = await makeProject('status-empty', 'chaptered')
    expect(await readNovelStatusSnapshot(root)).toBeNull()
  })

  test('refresh persists snapshot and read returns it back across calls', async () => {
    const root = await makeProject('status-persist', 'chaptered')

    const refreshed = await refreshNovelStatusSnapshot(root, { now: () => new Date('2026-06-15T09:30:00.000Z') })
    expect(refreshed.generatedAt).toBe('2026-06-15T09:30:00.000Z')

    // 落盘到 .narracat/status-snapshot.json
    const onDisk = JSON.parse(await readFile(join(root, narracatStatusSnapshotPath()), 'utf-8'))
    expect(onDisk.generatedAt).toBe('2026-06-15T09:30:00.000Z')

    const reread = await readNovelStatusSnapshot(root)
    expect(reread).toEqual(refreshed)
  })

  test('empty-planned project reports zeroed progress without throwing', async () => {
    const root = await makeProject('status-zero', 'setup')

    const snapshot = await aggregateNovelStatusSnapshot(root)

    expect(snapshot.progress.totalChaptersPlanned).toBe(0)
    expect(snapshot.progress.percentage).toBe(0)
    expect(snapshot.nextAction.chapter).toBe(1)
  })

  test('passes the computed current chapter to the enrich hook and merges enrichment', async () => {
    const root = await makeProject('status-enrich', 'chaptered')
    const calls: Array<{ projectPath: string; currentChapter: number | null }> = []

    const snapshot = await aggregateNovelStatusSnapshot(root, {
      enrich: async (input) => {
        calls.push(input)
        return {
          currentArc: {
            arcId: 'arc-1',
            volumeNo: 1,
            title: '序章',
            chapterStart: 1,
            chapterEnd: 10,
            coreQuestion: '?',
            irreversibleChange: '!',
          },
          foreshadowing: [],
          reviewFailures: [{ chapter: 1 }],
          references: { sourceCount: 0, guidanceGenerated: false },
        }
      },
    })

    // chaptered fixture: completed_chapters=[1] → currentChapter = 1
    expect(calls).toEqual([{ projectPath: root, currentChapter: 1 }])
    expect(snapshot.currentArc?.arcId).toBe('arc-1')
    expect(snapshot.reviewFailures).toEqual([{ chapter: 1 }])
    expect(snapshot.references).toEqual({ sourceCount: 0, guidanceGenerated: false })
  })
})

describe('incomplete project diagnostics (#38)', () => {
  test('logs the project path and which files are missing before throwing', async () => {
    // 作者只会看到一句「缺少 …」，不带路径。本次线上排查就卡在这里：无法从现场倒推
    // 到底是哪个项目、哪条路径出的问题。面向作者的文案不变，路径只进主进程日志。
    const root = await makeProject('status-diagnostics', 'setup')
    await rm(join(root, '.narracat', 'state.yaml'), { force: true })

    const logs: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      logs.push(args.map((value) => String(value)).join(' '))
    }
    try {
      await expect(aggregateNovelStatusSnapshot(root)).rejects.toThrow()
    } finally {
      console.error = originalError
    }

    const text = logs.join('\n')
    expect(text).toContain(root)
    expect(text).toContain('state.yaml')
  })
})
