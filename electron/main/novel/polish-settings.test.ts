import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  clearChapterDiverged,
  markChapterDiverged,
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
      divergedChapters: [],
    })
  })

  test('文件损坏降级成空设置——润色设置坏了最坏只是常驻这次没生效，不该阻断章节页', async () => {
    await writeRaw('{ 坏掉的')
    expect((await readPolishSettings(projectPath)).standingSlotId).toBeNull()
  })

  test('非法槽位与非法章号被丢弃', async () => {
    await writeRaw(JSON.stringify({ version: 1, standingSlotId: 'slot-9', divergedChapters: [3, 0, -1, '5'] }))
    const settings = await readPolishSettings(projectPath)
    expect(settings.standingSlotId).toBeNull()
    expect(settings.divergedChapters).toEqual([3])
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
