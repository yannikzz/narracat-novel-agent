import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  clearChapterDiverged,
  markChapterDiverged,
  markStandingPromptAnswered,
  polishSettingsPath,
  readPolishSettings,
  setStandingPolishSlot,
} from './polish-settings.ts'

let projectPath = ''

beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), 'polish-settings-'))
})

afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true })
})

async function writeRaw(content: string): Promise<void> {
  const path = polishSettingsPath(projectPath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
}

describe('readPolishSettings', () => {
  test('缺文件返回空设置', async () => {
    expect(await readPolishSettings(projectPath)).toEqual({
      version: 1,
      standingSlotId: null,
      standingOutcomes: {},
      standingPromptAnswered: false,
      divergedChapters: [],
    })
  })

  test('文件损坏降级成空设置——润色设置坏了最坏只是常驻这次没生效，不该阻断章节页', async () => {
    await writeRaw('{ 坏掉的')
    expect((await readPolishSettings(projectPath)).standingSlotId).toBeNull()
  })

  test('字段结构损坏 → 按损坏处理，且拒绝写回（分家标识不能被静默抹掉）', async () => {
    await writeRaw(JSON.stringify({ version: 1, standingSlotId: 'slot-1', divergedChapters: '坏掉的' }))
    expect((await readPolishSettings(projectPath)).divergedChapters).toEqual([])

    // 只判「JSON 能不能解析」是不够的：字段坏掉会被静默归一化，下一次写入就把原文件覆盖了
    await expect(setStandingPolishSlot(projectPath, 'slot-2')).rejects.toThrow('已损坏')
    expect(await readFile(polishSettingsPath(projectPath), 'utf-8')).toContain('坏掉的')
  })

  test('outcome 缺字段同样算损坏', async () => {
    await writeRaw(JSON.stringify({ version: 1, standingOutcomes: { '7': { status: 'applied' } } }))
    await expect(markChapterDiverged(projectPath, 3)).rejects.toThrow('已损坏')
  })

  test('缺省字段不算损坏——老文件没有新字段是正常的', async () => {
    await writeRaw(JSON.stringify({ version: 1, standingSlotId: 'slot-1' }))
    await setStandingPolishSlot(projectPath, 'slot-2')
    expect((await readPolishSettings(projectPath)).standingSlotId).toBe('slot-2')
  })
})

describe('setStandingPolishSlot', () => {
  test('设置后可读回', async () => {
    await setStandingPolishSlot(projectPath, 'slot-2')
    expect((await readPolishSettings(projectPath)).standingSlotId).toBe('slot-2')
  })

  test('null 关闭常驻', async () => {
    await setStandingPolishSlot(projectPath, 'slot-2')
    await setStandingPolishSlot(projectPath, null)
    expect((await readPolishSettings(projectPath)).standingSlotId).toBeNull()
  })

  test('不影响已登记的分家章号', async () => {
    await markChapterDiverged(projectPath, 7)
    await setStandingPolishSlot(projectPath, 'slot-1')
    expect((await readPolishSettings(projectPath)).divergedChapters).toEqual([7])
  })
})

describe('常驻提议只问一次', () => {
  test('答过之后置位，且幂等', async () => {
    expect((await readPolishSettings(projectPath)).standingPromptAnswered).toBe(false)
    await markStandingPromptAnswered(projectPath)
    await markStandingPromptAnswered(projectPath)
    expect((await readPolishSettings(projectPath)).standingPromptAnswered).toBe(true)
  })

  test('不影响常驻槽位本身——「这次就好」不等于关掉常驻', async () => {
    await setStandingPolishSlot(projectPath, 'slot-2')
    await markStandingPromptAnswered(projectPath)
    const settings = await readPolishSettings(projectPath)
    expect(settings.standingSlotId).toBe('slot-2')
    expect(settings.standingPromptAnswered).toBe(true)
  })

  test('字段类型损坏也按损坏处理，不会被静默改成 false', async () => {
    await writeRaw(JSON.stringify({ version: 1, standingPromptAnswered: '是' }))
    await expect(setStandingPolishSlot(projectPath, 'slot-1')).rejects.toThrow('已损坏')
  })
})

describe('分家标识', () => {
  test('登记去重且有序', async () => {
    await markChapterDiverged(projectPath, 12)
    await markChapterDiverged(projectPath, 3)
    await markChapterDiverged(projectPath, 12)
    expect((await readPolishSettings(projectPath)).divergedChapters).toEqual([3, 12])
  })

  test('解除只影响指定章', async () => {
    await markChapterDiverged(projectPath, 3)
    await markChapterDiverged(projectPath, 12)
    await clearChapterDiverged(projectPath, 3)
    expect((await readPolishSettings(projectPath)).divergedChapters).toEqual([12])
  })

  test('解除不存在的章号是幂等的', async () => {
    await clearChapterDiverged(projectPath, 99)
    expect((await readPolishSettings(projectPath)).divergedChapters).toEqual([])
  })

  test('并发登记两章都不丢', async () => {
    await Promise.all([markChapterDiverged(projectPath, 1), markChapterDiverged(projectPath, 2)])
    expect((await readPolishSettings(projectPath)).divergedChapters).toEqual([1, 2])
  })
})
