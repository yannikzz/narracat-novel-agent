import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POLISH_SLOT_IDS } from '@shared/types/prose-polish'
import {
  polishRecipeStorePath,
  readPolishRecipes,
  recordPolishRunSlots,
  savePolishRecipe,
} from './polish-recipe-store.ts'

let dir = ''
let storePath = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'polish-recipe-'))
  storePath = polishRecipeStorePath(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readPolishRecipes（读一律 fail-soft，且永远三槽）', () => {
  test('缺文件返回三个空槽', async () => {
    const file = await readPolishRecipes(storePath)
    expect(file.recipes.map((recipe) => recipe.slotId)).toEqual([...POLISH_SLOT_IDS])
    expect(file.recipes.every((recipe) => recipe.prompt === '' && recipe.modelKey === null)).toBe(true)
    expect(file.lastRunSlotIds).toEqual([])
  })

  test('JSON 损坏也降级成三个空槽，不抛', async () => {
    await writeFile(storePath, '{ 坏掉的', 'utf-8')
    const file = await readPolishRecipes(storePath)
    expect(file.recipes).toHaveLength(3)
  })

  test('文件里只存了一槽时，另外两槽补空——槽位数量是产品契约，不随文件浮动', async () => {
    await writeFile(
      storePath,
      JSON.stringify({ version: 1, recipes: [{ slotId: 'slot-2', prompt: '写得像人话', modelKey: null }] }),
      'utf-8',
    )
    const file = await readPolishRecipes(storePath)
    expect(file.recipes).toHaveLength(3)
    expect(file.recipes[1]).toMatchObject({ slotId: 'slot-2', prompt: '写得像人话' })
    expect(file.recipes[0].prompt).toBe('')
  })

  test('非法槽位与非法 lastRunSlotIds 被丢弃', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        recipes: [{ slotId: 'slot-9', prompt: 'x' }],
        lastRunSlotIds: ['slot-1', 'slot-9', 'slot-1'],
      }),
      'utf-8',
    )
    const file = await readPolishRecipes(storePath)
    expect(file.recipes.every((recipe) => recipe.prompt === '')).toBe(true)
    expect(file.lastRunSlotIds).toEqual(['slot-1'])
  })
})

describe('savePolishRecipe', () => {
  test('保存后可读回，其余槽不受影响', async () => {
    await savePolishRecipe({
      storePath,
      slotId: 'slot-1',
      prompt: '别用比喻',
      modelKey: 'deepseek/deepseek-v4-pro',
      thinking: true,
      now: '2026-09-02T00:00:00.000Z',
    })
    const file = await readPolishRecipes(storePath)
    expect(file.recipes[0]).toEqual({
      slotId: 'slot-1',
      prompt: '别用比喻',
      modelKey: 'deepseek/deepseek-v4-pro',
      thinking: true,
      updatedAt: '2026-09-02T00:00:00.000Z',
    })
    expect(file.recipes[2].prompt).toBe('')
  })

  test('清空槽位是合法操作（空槽不参与跑版）', async () => {
    await savePolishRecipe({ storePath, slotId: 'slot-1', prompt: 'x', modelKey: null, thinking: false, now: 'a' })
    await savePolishRecipe({ storePath, slotId: 'slot-1', prompt: '', modelKey: null, thinking: false, now: 'b' })
    expect((await readPolishRecipes(storePath)).recipes[0].prompt).toBe('')
  })

  test('存量文件缺 thinking 字段时按关处理（老配方不会突然开始烧思考预算）', async () => {
    await writeFile(
      storePath,
      JSON.stringify({ version: 1, recipes: [{ slotId: 'slot-1', prompt: '旧配方', modelKey: null }] }),
      'utf-8',
    )
    expect((await readPolishRecipes(storePath)).recipes[0].thinking).toBe(false)
  })

  test('并发保存两槽都不丢——读-改-写整段进同一条锁', async () => {
    await Promise.all([
      savePolishRecipe({ storePath, slotId: 'slot-1', prompt: '一', modelKey: null, thinking: false, now: 'a' }),
      savePolishRecipe({ storePath, slotId: 'slot-3', prompt: '三', modelKey: null, thinking: false, now: 'a' }),
    ])
    const file = await readPolishRecipes(storePath)
    expect(file.recipes[0].prompt).toBe('一')
    expect(file.recipes[2].prompt).toBe('三')
  })

  test('非法槽位拒绝写入', async () => {
    await expect(
      savePolishRecipe({
        storePath,
        slotId: 'slot-9' as never,
        prompt: 'x',
        modelKey: null,
        thinking: false,
        now: 'a',
      }),
    ).rejects.toThrow('润色槽位非法。')
  })
})

describe('recordPolishRunSlots', () => {
  test('记下这轮跑的组合，去重', async () => {
    const file = await recordPolishRunSlots({ storePath, slotIds: ['slot-2', 'slot-2', 'slot-3'] })
    expect(file.lastRunSlotIds).toEqual(['slot-2', 'slot-3'])
  })

  test('空组合不覆盖上次记录', async () => {
    await recordPolishRunSlots({ storePath, slotIds: ['slot-1'] })
    const file = await recordPolishRunSlots({ storePath, slotIds: [] })
    expect(file.lastRunSlotIds).toEqual(['slot-1'])
  })

  test('不动配方内容', async () => {
    await savePolishRecipe({ storePath, slotId: 'slot-1', prompt: '保留我', modelKey: null, thinking: false, now: 'a' })
    await recordPolishRunSlots({ storePath, slotIds: ['slot-1'] })
    expect((await readPolishRecipes(storePath)).recipes[0].prompt).toBe('保留我')
  })
})
