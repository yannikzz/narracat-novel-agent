import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hasAgentWriteWithinRun, runStandingPolish, type StandingPolishDeps } from './standing-polish.ts'
import type { ManuscriptRevisionEntry } from '@shared/types/manuscript-revision'
import { createNovelProjectFixture, writeNovelFixtureFile } from '../novel/test-novel-fixture.ts'
import { readPolishSettings, setStandingPolishSlot } from '../novel/polish-settings.ts'
import { detectPolishDrift } from '@shared/lib/prose-polish-drift'

const VISIBLE = ['林跃把便条折了两折。', '三天后他回来了。'].join('\n')
const CLEAN = ['林跃把那张便条对折，又对折。', '三天后他才回来。'].join('\n')
const DRIFTED = ['林跃把那张便条对折。', '五天后他才回来。'].join('\n')

const STATE_YAML = [
  'progress:',
  '  last_completed_chapter: 7',
  '  completed_chapters: [7]',
  '  in_progress_chapter: null',
  '  total_chapters_planned: 20',
  '  chapters_outlined: [7]',
  'structure:',
  '  total_volumes: 1',
  '  total_chapters_planned: 20',
  '  chapter_to_volume:',
  '    7: 1',
  '',
].join('\n')

let projectPath = ''

function polishOnceReturning(text: string, originalText = VISIBLE): StandingPolishDeps['polishOnce'] {
  return async () => ({
    text,
    drift: detectPolishDrift({ original: originalText, polished: text, anchorNames: ['林跃'] }),
    usage: { inputTokens: 10, outputTokens: 20 },
    originalText,
  })
}

async function readChapter7(): Promise<string> {
  return readFile(join(projectPath, 'manuscript', 'vol-01', 'ch-007.md'), 'utf-8')
}

beforeEach(async () => {
  projectPath = (await createNovelProjectFixture({ name: 'standing-polish' })).root
  await writeFile(join(projectPath, 'manuscript', 'vol-01', 'ch-007.md'), `${VISIBLE}\n`, 'utf-8')
  await writeNovelFixtureFile(projectPath, join('.narracat', 'state.yaml'), STATE_YAML)
})

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true })
})

describe('runStandingPolish', () => {
  test('没开常驻时什么都不做', async () => {
    let called = false
    const result = await runStandingPolish(projectPath, {
      polishOnce: async () => {
        called = true
        throw new Error('不该被调用')
      },
    })
    expect(result).toEqual({ status: 'off' })
    expect(called).toBe(false)
  })

  test('润好了就覆盖正文并留痕', async () => {
    await setStandingPolishSlot(projectPath, 'slot-1')
    const result = await runStandingPolish(projectPath, {
      polishOnce: polishOnceReturning(CLEAN),
      now: () => '2026-09-02T00:00:00.000Z',
    })

    expect(result).toEqual({ status: 'applied', chapter: 7 })
    expect(await readChapter7()).toContain('又对折')
    const settings = await readPolishSettings(projectPath)
    expect(settings.standingOutcomes['7']).toEqual({ status: 'applied', at: '2026-09-02T00:00:00.000Z' })
  })

  test('改动了情节 → 跳过、保留原稿、留下可见的原因', async () => {
    await setStandingPolishSlot(projectPath, 'slot-1')
    const result = await runStandingPolish(projectPath, { polishOnce: polishOnceReturning(DRIFTED) })

    expect(result.status).toBe('skipped')
    expect(await readChapter7()).toContain('三天后')
    const outcome = (await readPolishSettings(projectPath)).standingOutcomes['7']
    expect(outcome?.status).toBe('skipped')
    expect(outcome?.note).toContain('改动了情节')
  })

  test('润色报错 → 同样跳过并留下原因，不抛给调用方', async () => {
    await setStandingPolishSlot(projectPath, 'slot-1')
    const result = await runStandingPolish(projectPath, {
      polishOnce: async () => {
        throw new Error('余额不足')
      },
    })

    expect(result).toEqual({ status: 'skipped', chapter: 7, note: '余额不足' })
    expect(await readChapter7()).toContain('三天后')
  })

  test('生成期间作者手改了正文 → 乐观锁拦住，不覆盖作者的改动', async () => {
    await setStandingPolishSlot(projectPath, 'slot-1')
    // 送去润色的是 A；模型返回期间磁盘已经被作者改成 B。基线必须是 A，才拦得住。
    const result = await runStandingPolish(projectPath, {
      polishOnce: polishOnceReturning(CLEAN, '这是送去润色时的那一份正文。'),
    })

    expect(result.status).toBe('skipped')
    expect(await readChapter7()).toContain('林跃把便条折了两折')
  })

  test('本次 run 没有写出新正文（作者选了「先不写」）→ 什么都不做', async () => {
    await setStandingPolishSlot(projectPath, 'slot-1')
    let polished = false
    const result = await runStandingPolish(projectPath, {
      polishOnce: async () => {
        polished = true
        throw new Error('不该被调用')
      },
      hasFreshManuscript: async () => false,
    })

    expect(result).toEqual({ status: 'off' })
    expect(polished).toBe(false)
    expect(await readChapter7()).toContain('三天后')
  })

  test('采用那一步走项目写入闸', async () => {
    await setStandingPolishSlot(projectPath, 'slot-1')
    const locked: string[] = []
    await runStandingPolish(projectPath, {
      polishOnce: polishOnceReturning(CLEAN),
      withProjectLock: async (path, operation) => {
        locked.push(path)
        return operation()
      },
    })

    expect(locked).toEqual([projectPath])
  })

  test('没有已完成章节时安静收手', async () => {
    await setStandingPolishSlot(projectPath, 'slot-1')
    const result = await runStandingPolish(projectPath, {
      polishOnce: polishOnceReturning(CLEAN),
      resolveChapter: async () => null,
    })
    expect(result).toEqual({ status: 'off' })
  })

  test('只有两种结局：覆盖，或原稿原封不动——不存在半成品', async () => {
    await setStandingPolishSlot(projectPath, 'slot-1')
    for (const text of [DRIFTED, CLEAN]) {
      await writeFile(join(projectPath, 'manuscript', 'vol-01', 'ch-007.md'), `${VISIBLE}\n`, 'utf-8')
      const result = await runStandingPolish(projectPath, { polishOnce: polishOnceReturning(text) })
      const disk = await readChapter7()
      if (result.status === 'applied') expect(disk).toContain('又对折')
      else expect(disk.trim()).toBe(VISIBLE)
    }
  })
})

describe('hasAgentWriteWithinRun', () => {
  const run = { startedAt: '2026-09-02T10:00:00.000Z', finishedAt: '2026-09-02T10:12:00.000Z' }
  function revision(source: ManuscriptRevisionEntry['source'], createdAt: string): ManuscriptRevisionEntry {
    return { id: createdAt, chapter: 7, source, createdAt, summary: { addedChars: 0, removedChars: 0 } }
  }

  test('本次 run 期间登记的 agent-write 才算新鲜', () => {
    expect(hasAgentWriteWithinRun([revision('agent-write', '2026-09-02T10:05:00.000Z')], run)).toBe(true)
  })

  test('「先不写」期间的手改保存不算——来源必须是 agent-write', () => {
    expect(hasAgentWriteWithinRun([revision('author-save', '2026-09-02T10:05:00.000Z')], run)).toBe(false)
  })

  test('上一轮写出来的正文不算——不早于本次 run 起点', () => {
    expect(hasAgentWriteWithinRun([revision('agent-write', '2026-09-02T09:50:00.000Z')], run)).toBe(false)
  })

  test('下一轮写出来的正文不算——这条检查是异步旁路，不能被后来的写入错认', () => {
    expect(hasAgentWriteWithinRun([revision('agent-write', '2026-09-02T10:12:00.001Z')], run)).toBe(false)
  })

  test('时间解析不出来按不新鲜处理（不确定就当没写）', () => {
    expect(hasAgentWriteWithinRun([revision('agent-write', 'garbage')], run)).toBe(false)
    expect(hasAgentWriteWithinRun([revision('agent-write', '2026-09-02T10:05:00.000Z')], { ...run, finishedAt: '' })).toBe(false)
  })
})
