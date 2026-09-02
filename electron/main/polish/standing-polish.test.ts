import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runStandingPolish, type StandingPolishDeps } from './standing-polish.ts'
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

function polishOnceReturning(text: string): StandingPolishDeps['polishOnce'] {
  return async () => ({
    text,
    drift: detectPolishDrift({ original: VISIBLE, polished: text, anchorNames: ['林跃'] }),
    usage: { inputTokens: 10, outputTokens: 20 },
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

  test('乐观锁失败（正文期间被改过）→ 跳过而不是覆盖', async () => {
    await setStandingPolishSlot(projectPath, 'slot-1')
    const result = await runStandingPolish(projectPath, {
      polishOnce: polishOnceReturning(CLEAN),
      // 模拟「读到的原稿」与磁盘不一致
      readOriginalText: async () => '另一份正文。',
    })

    expect(result.status).toBe('skipped')
    expect(await readChapter7()).toContain('林跃把便条折了两折')
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
