// 作者的三套润色配方（提示词 + 模型）。存 userData/polish-recipes.json。
//
// 存 userData 而不是项目内，是因为配方是作者的**手艺**、跨书复用；「这本书常驻哪一槽」才是
// 书的属性，存项目内（ADR-0041 §9）。两者生命周期不同，焊在任一层都会在另一头出问题。
//
// 降级纪律对齐 author-request-store.ts：读 fail-soft（读不出来最多是这次没配方可跑，
// 界面显示空槽即可），写 fail-loud（作者按了保存却静默失败是最坏的失败模式）。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isPolishSlotId,
  POLISH_SLOT_IDS,
  type PolishRecipe,
  type PolishRecipeFile,
  type PolishSlotId,
} from '@shared/types/prose-polish'
import { withJsonFileLock } from './write-json-atomic'

/** polish-recipes.json 路径（与 author-requests.json 同级，userData 根） */
export function polishRecipeStorePath(userDataPath: string): string {
  return join(userDataPath, 'polish-recipes.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyRecipe(slotId: PolishSlotId): PolishRecipe {
  return { slotId, prompt: '', modelKey: null, thinking: false, updatedAt: '' }
}

function normalizeRecipe(value: unknown): PolishRecipe | null {
  if (!isRecord(value)) return null
  const { slotId, prompt, modelKey, thinking, updatedAt } = value
  if (!isPolishSlotId(slotId)) return null
  return {
    slotId,
    prompt: typeof prompt === 'string' ? prompt : '',
    modelKey: typeof modelKey === 'string' && modelKey.trim() ? modelKey : null,
    thinking: thinking === true,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
  }
}

/**
 * 读存量，**永远返回完整三槽**（缺的补空槽）。
 *
 * 槽位数量是产品契约的一部分（固定三个、不可增删），让它随文件内容浮动会把「界面画几个框」
 * 这种事变成运行时的不确定量。任何失败一律降级成三个空槽，绝不抛。
 */
export async function readPolishRecipes(storePath: string): Promise<PolishRecipeFile> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(storePath, 'utf-8'))
  } catch {
    parsed = null
  }

  const stored = new Map<PolishSlotId, PolishRecipe>()
  if (isRecord(parsed) && Array.isArray(parsed.recipes)) {
    for (const item of parsed.recipes) {
      const recipe = normalizeRecipe(item)
      if (recipe) stored.set(recipe.slotId, recipe)
    }
  }

  const lastRunSlotIds =
    isRecord(parsed) && Array.isArray(parsed.lastRunSlotIds)
      ? parsed.lastRunSlotIds.filter(isPolishSlotId)
      : []

  return {
    version: 1,
    recipes: POLISH_SLOT_IDS.map((slotId) => stored.get(slotId) ?? emptyRecipe(slotId)),
    lastRunSlotIds: [...new Set(lastRunSlotIds)],
  }
}

/** 保存一槽。prompt 允许存空串——清空槽位是合法操作（空槽不参与跑版）。 */
export async function savePolishRecipe(input: {
  storePath: string
  slotId: PolishSlotId
  prompt: string
  modelKey: string | null
  thinking: boolean
  now: string
}): Promise<PolishRecipeFile> {
  const { storePath, slotId, prompt, modelKey, thinking, now } = input
  if (!isPolishSlotId(slotId)) throw new Error('润色槽位非法。')

  return withJsonFileLock(storePath, async (write) => {
    const current = await readPolishRecipes(storePath)
    const next: PolishRecipeFile = {
      ...current,
      recipes: current.recipes.map((recipe) =>
        recipe.slotId === slotId ? { slotId, prompt, modelKey, thinking, updatedAt: now } : recipe,
      ),
    }
    await write(next)
    return next
  })
}

/**
 * 记下这一轮实际跑了哪些槽，作为下次发起时的默认勾选。
 * 调提示词是反复迭代的过程，作者往往改完槽 2 只想重跑槽 2，每次重新勾很烦。
 */
export async function recordPolishRunSlots(input: {
  storePath: string
  slotIds: PolishSlotId[]
}): Promise<PolishRecipeFile> {
  const { storePath } = input
  const slotIds = [...new Set(input.slotIds.filter(isPolishSlotId))]
  if (slotIds.length === 0) return readPolishRecipes(storePath)

  return withJsonFileLock(storePath, async (write) => {
    const current = await readPolishRecipes(storePath)
    const next: PolishRecipeFile = { ...current, lastRunSlotIds: slotIds }
    await write(next)
    return next
  })
}
