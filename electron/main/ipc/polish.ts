import { app, ipcMain } from 'electron'
import {
  isPolishSlotId,
  type PolishRecipeFile,
  type PolishSlotId,
  type ProjectPolishSettings,
} from '@shared/types/prose-polish'
import { polishRecipeStorePath, readPolishRecipes, savePolishRecipe } from '../engine/polish-recipe-store.ts'
import {
  clearStandingPolishOutcome,
  markStandingPromptAnswered,
  readPolishSettings,
  setStandingPolishSlot,
} from '../novel/polish-settings.ts'
import { openMemoryDbReadonly } from '../novel/memory-db.ts'
import { adoptPolishedChapter, parsePolishAdoptInput } from '../polish/polish-adopt.ts'
import { normalizePolishRunRequest, type PolishRunManager } from '../polish/polish-runner.ts'
import { createWindowPolishRunManager } from '../polish/polish-runtime.ts'
import { runProjectMutation } from './agent.ts'

/**
 * 润色域 IPC（ADR-0041）。
 *
 * 与角色聊天同构：每个渲染进程一个 run manager（事件只发回发起的那个窗口），
 * 用 WeakMap 挂在 sender 上，窗口关掉即随之释放。
 */

const polishRunManagers = new WeakMap<Electron.WebContents, PolishRunManager>()

function recipeStorePath(): string {
  return polishRecipeStorePath(app.getPath('userData'))
}

function polishRunManagerForSender(sender: Electron.WebContents): PolishRunManager {
  const existing = polishRunManagers.get(sender)
  if (existing) return existing

  const manager = createWindowPolishRunManager(sender)
  polishRunManagers.set(sender, manager)
  return manager
}

function readProjectPath(input: unknown): string {
  const raw = (input ?? {}) as Record<string, unknown>
  if (typeof raw.projectPath !== 'string' || !raw.projectPath.trim()) throw new Error('缺少项目路径。')
  return raw.projectPath
}

function readSaveRecipeInput(input: unknown): {
  slotId: PolishSlotId
  prompt: string
  modelKey: string | null
  thinking: boolean
} {
  const raw = (input ?? {}) as Record<string, unknown>
  if (!isPolishSlotId(raw.slotId)) throw new Error('润色槽位非法。')
  if (typeof raw.prompt !== 'string') throw new Error('润色要求参数非法。')
  const modelKey = raw.modelKey
  if (modelKey !== null && modelKey !== undefined && typeof modelKey !== 'string') {
    throw new Error('模型参数非法。')
  }
  return {
    slotId: raw.slotId,
    prompt: raw.prompt,
    modelKey: typeof modelKey === 'string' && modelKey.trim() ? modelKey : null,
    thinking: raw.thinking === true,
  }
}

function readCancelInput(input: unknown): { runId: string; slotId?: PolishSlotId } {
  const raw = (input ?? {}) as Record<string, unknown>
  if (typeof raw.runId !== 'string' || !raw.runId.trim()) throw new Error('缺少 runId。')
  return { runId: raw.runId, slotId: isPolishSlotId(raw.slotId) ? raw.slotId : undefined }
}

export function registerPolishIpcHandlers(): void {
  ipcMain.handle('polish:list-recipes', async (): Promise<PolishRecipeFile> => readPolishRecipes(recipeStorePath()))

  ipcMain.handle('polish:save-recipe', async (_event, input: unknown): Promise<PolishRecipeFile> => {
    const { slotId, prompt, modelKey, thinking } = readSaveRecipeInput(input)
    return savePolishRecipe({
      storePath: recipeStorePath(),
      slotId,
      prompt,
      modelKey,
      thinking,
      now: new Date().toISOString(),
    })
  })

  ipcMain.handle('polish:get-settings', async (_event, input: unknown): Promise<ProjectPolishSettings> => {
    return readPolishSettings(readProjectPath(input))
  })

  ipcMain.handle('polish:set-standing-slot', async (_event, input: unknown): Promise<ProjectPolishSettings> => {
    const projectPath = readProjectPath(input)
    const raw = (input ?? {}) as Record<string, unknown>
    const slotId = raw.slotId === null || raw.slotId === undefined ? null : raw.slotId
    if (slotId !== null && !isPolishSlotId(slotId)) throw new Error('润色槽位非法。')
    await setStandingPolishSlot(projectPath, slotId)
    return readPolishSettings(projectPath)
  })

  ipcMain.handle('polish:mark-standing-prompt-answered', async (_event, input: unknown) => {
    const projectPath = readProjectPath(input)
    await markStandingPromptAnswered(projectPath)
    return readPolishSettings(projectPath)
  })

  ipcMain.handle('polish:start', async (event, input: unknown) => {
    return polishRunManagerForSender(event.sender).start(normalizePolishRunRequest(input))
  })

  ipcMain.handle('polish:cancel', async (event, input: unknown) => {
    const { runId, slotId } = readCancelInput(input)
    const manager = polishRunManagerForSender(event.sender)
    return slotId ? manager.cancelVersion(runId, slotId) : manager.cancelRun(runId)
  })

  ipcMain.handle('polish:clear-standing-outcome', async (_event, input: unknown): Promise<ProjectPolishSettings> => {
    const projectPath = readProjectPath(input)
    const raw = (input ?? {}) as Record<string, unknown>
    if (typeof raw.chapter !== 'number' || !Number.isInteger(raw.chapter) || raw.chapter < 1) {
      throw new Error('章号参数非法。')
    }
    await clearStandingPolishOutcome(projectPath, raw.chapter)
    return readPolishSettings(projectPath)
  })

  ipcMain.handle('polish:adopt', async (_event, input: unknown) => {
    const request = parsePolishAdoptInput(input)
    // 与 novel:save-chapter-manuscript 同一道闸：采用会连写正文、版本记录与分家标识，
    // 备份插在中间会拿到内部不一致的归档。
    return runProjectMutation(request.projectPath, () =>
      adoptPolishedChapter(request, { openMemoryDb: openMemoryDbReadonly }),
    )
  })
}
