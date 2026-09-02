import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { adoptPolishedChapter, parsePolishAdoptInput } from './polish-adopt.ts'
import { createNovelProjectFixture, writeNovelFixtureFile } from '../novel/test-novel-fixture.ts'
import { manuscriptRevisionStore } from '../novel/manuscript-revisions.ts'
import { readPolishSettings } from '../novel/polish-settings.ts'
import { pendingMemorySyncPath } from '../novel/pending-memory-sync.ts'

const METADATA = '<!-- chapter_metadata: {"chapter_num":13,"summary":"旧摘要"} -->'
const VISIBLE = ['林跃把便条折了两折。', '三天后他回来了。'].join('\n')
const CLEAN_POLISH = ['林跃把那张便条对折，又对折。', '三天后他才回来。'].join('\n')
const DRIFTED_POLISH = ['林跃把那张便条对折。', '五天后他才回来。'].join('\n')

const STATE_YAML = [
  'progress:',
  '  last_completed_chapter: 13',
  '  completed_chapters: [5, 13]',
  '  in_progress_chapter: null',
  '  total_chapters_planned: 20',
  '  chapters_outlined: [5, 13]',
  'structure:',
  '  total_volumes: 1',
  '  total_chapters_planned: 20',
  '  chapter_to_volume:',
  '    5: 1',
  '    13: 1',
  '',
].join('\n')

let projectPath = ''

async function readChapter(chapter: number): Promise<string> {
  return readFile(join(projectPath, 'manuscript', 'vol-01', `ch-${String(chapter).padStart(3, '0')}.md`), 'utf-8')
}

async function pendingSyncRaw(): Promise<string> {
  return readFile(pendingMemorySyncPath(projectPath), 'utf-8').catch(() => '')
}

beforeEach(async () => {
  projectPath = (await createNovelProjectFixture({ name: 'polish-adopt' })).root
  await writeFile(join(projectPath, 'manuscript', 'vol-01', 'ch-013.md'), `${VISIBLE}\n\n${METADATA}\n`, 'utf-8')
  await writeFile(join(projectPath, 'manuscript', 'vol-01', 'ch-005.md'), `${VISIBLE}\n`, 'utf-8')
  await writeNovelFixtureFile(projectPath, join('.narracat', 'state.yaml'), STATE_YAML)
})

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true })
})

describe('parsePolishAdoptInput', () => {
  test('合法输入通过', () => {
    expect(
      parsePolishAdoptInput({
        projectPath: '/p',
        chapter: 13,
        slotId: 'slot-2',
        polishedText: '正文',
        expectedVisibleText: '旧正文',
      }),
    ).toEqual({
      projectPath: '/p',
      chapter: 13,
      slotId: 'slot-2',
      polishedText: '正文',
      expectedVisibleText: '旧正文',
      divergenceAcknowledged: false,
    })
  })

  test('槽位非法拒绝', () => {
    expect(() =>
      parsePolishAdoptInput({
        projectPath: '/p',
        chapter: 13,
        slotId: 'slot-9',
        polishedText: 'x',
        expectedVisibleText: '',
      }),
    ).toThrow('润色槽位非法。')
  })

  test('空正文拒绝', () => {
    expect(() =>
      parsePolishAdoptInput({
        projectPath: '/p',
        chapter: 13,
        slotId: 'slot-1',
        polishedText: '   ',
        expectedVisibleText: '',
      }),
    ).toThrow()
  })
})

describe('无漂移（绝大多数情况）', () => {
  test('直接采用：正文更新、元数据保留、不打红点', async () => {
    const result = await adoptPolishedChapter({
      projectPath,
      chapter: 13,
      slotId: 'slot-1',
      polishedText: CLEAN_POLISH,
      expectedVisibleText: VISIBLE,
    })

    expect(result).toEqual({ ok: true, outcome: { kind: 'clean' } })
    const disk = await readChapter(13)
    expect(disk).toContain('又对折')
    expect(disk).toContain(METADATA)
    expect(await pendingSyncRaw()).not.toContain('"13"')
  })

  test('留下一条 llm-polish 版本记录，可退回原稿', async () => {
    await adoptPolishedChapter({
      projectPath,
      chapter: 13,
      slotId: 'slot-1',
      polishedText: CLEAN_POLISH,
      expectedVisibleText: VISIBLE,
    })

    const list = await manuscriptRevisionStore.listChapter({ projectPath, chapter: 13 })
    expect(list.revisions[0]?.source).toBe('llm-polish')

    const content = await manuscriptRevisionStore.readRevision({
      projectPath,
      chapter: 13,
      revisionId: list.revisions[0].id,
    })
    expect(content.visibleText).toBe(VISIBLE)
  })
})

describe('漂移 + 最新完成章', () => {
  test('采用并打「记忆待同步」红点', async () => {
    const result = await adoptPolishedChapter({
      projectPath,
      chapter: 13,
      slotId: 'slot-1',
      polishedText: DRIFTED_POLISH,
      expectedVisibleText: VISIBLE,
    })

    expect(result).toEqual({ ok: true, outcome: { kind: 'pending-sync', chapter: 13 } })
    const raw = await pendingSyncRaw()
    expect(raw).toContain('"13"')
    expect(raw).toContain('润色改动了事实')
    expect((await readPolishSettings(projectPath)).divergedChapters).toEqual([])
  })

  test('读不到进度时按最新章处理——宁可把作者送到同步命令面前，也不误报永久分家', async () => {
    await writeNovelFixtureFile(projectPath, join('.narracat', 'state.yaml'), 'progress: 坏掉的\n')
    const result = await adoptPolishedChapter({
      projectPath,
      chapter: 5,
      slotId: 'slot-1',
      polishedText: DRIFTED_POLISH,
      expectedVisibleText: VISIBLE,
    })
    expect(result).toEqual({ ok: true, outcome: { kind: 'pending-sync', chapter: 5 } })
  })
})

describe('漂移 + 旧章', () => {
  test('未确认时拒绝写入，正文一个字没动', async () => {
    const result = await adoptPolishedChapter({
      projectPath,
      chapter: 5,
      slotId: 'slot-1',
      polishedText: DRIFTED_POLISH,
      expectedVisibleText: VISIBLE,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.needsDivergenceAck).toBe(true)
      expect(result.message).toContain('旧章节的改动不会进入记忆')
    }
    expect(await readChapter(5)).toContain('三天后')
  })

  test('确认后采用并登记分家标识，且不打会点不动的红点', async () => {
    const result = await adoptPolishedChapter({
      projectPath,
      chapter: 5,
      slotId: 'slot-1',
      polishedText: DRIFTED_POLISH,
      expectedVisibleText: VISIBLE,
      divergenceAcknowledged: true,
    })

    expect(result).toEqual({ ok: true, outcome: { kind: 'diverged', chapter: 5 } })
    expect(await readChapter(5)).toContain('五天后')
    expect((await readPolishSettings(projectPath)).divergedChapters).toEqual([5])
    expect(await pendingSyncRaw()).not.toContain('"5"')
  })

  test('旧章的纯文字润色照常直接采用，不需要任何确认', async () => {
    const result = await adoptPolishedChapter({
      projectPath,
      chapter: 5,
      slotId: 'slot-1',
      polishedText: CLEAN_POLISH,
      expectedVisibleText: VISIBLE,
    })

    expect(result).toEqual({ ok: true, outcome: { kind: 'clean' } })
    expect((await readPolishSettings(projectPath)).divergedChapters).toEqual([])
  })
})

describe('乐观锁', () => {
  test('正文已被改过 → 冲突拒绝，不覆盖', async () => {
    const result = await adoptPolishedChapter({
      projectPath,
      chapter: 13,
      slotId: 'slot-1',
      polishedText: CLEAN_POLISH,
      expectedVisibleText: '作者读到的是另一份正文。',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflict).toBe(true)
    expect(await readChapter(13)).toContain('林跃把便条折了两折')
  })

  test('章节文件不存在时如实报错', async () => {
    const result = await adoptPolishedChapter({
      projectPath,
      chapter: 9,
      slotId: 'slot-1',
      polishedText: CLEAN_POLISH,
      expectedVisibleText: VISIBLE,
    })
    expect(result).toMatchObject({ ok: false })
  })
})
