import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeAppConfig } from '../config.ts'
import { currentAgentCorePath } from './app.ts'
import {
  configPath,
  readCurrentConfig,
  readInputRecord,
  readRequiredString,
  userDataPath,
} from './inputs.ts'
import { readAutomationLevel, readUpdateNovelProjectMetadataInput } from './novel-metadata-input.ts'
import { getAgentRuntimeCoordinator, runProjectMutation } from './agent.ts'
import { pruneMissingRecentNovelPaths, scanNovelProjects } from '../novel/novel-index.ts'
import {
  parseRememberNovelProjectPathInput,
  rememberNovelProjectPath,
} from '../novel/remember-project-path.ts'
import { deleteNovelProject as deleteNovelProjectDirectory } from '../novel/novel-delete.ts'
import { loadNovelChapterArtifacts, loadNovelWorkbenchArtifacts } from '../novel/novel-artifacts.ts'
import { parsePremiseFieldEditInput, submitPremiseFieldEdit } from '../novel/premise-edit.ts'
import { parseChapterOutlineFieldEditInput, submitChapterOutlineFieldEdit } from '../novel/chapter-outline-edit.ts'
import { parseMasterOutlineFieldEditInput, submitMasterOutlineFieldEdit } from '../novel/master-outline-edit.ts'
import {
  parseAuthoredStateEditInput,
  parseCharacterIdentityEditInput,
  submitAuthoredStateEdit,
  submitCharacterIdentityEdit,
} from '../novel/character-state-edit.ts'
import { parseSubmitStyleAnchorInput, submitStyleAnchor, listStyleAnchors } from '../novel/style-anchor.ts'
import {
  parseManuscriptEditInput,
  restoreManuscriptRevision,
  submitManuscriptEdit,
} from '../novel/manuscript-edit.ts'
import {
  manuscriptRevisionStore,
  parseManuscriptRevisionInput,
  parseReadManuscriptRevisionInput,
  parseRestoreManuscriptRevisionInput,
} from '../novel/manuscript-revisions.ts'
import {
  discardManuscriptDraft,
  listManuscriptDrafts,
  parseManuscriptDraftInput,
  parseSaveManuscriptDraftInput,
  readManuscriptDraft,
  saveManuscriptDraft,
} from '../novel/manuscript-drafts.ts'
import {
  parseResolvePlannedStateInput,
  parseUpdateChapterStateChangesInput,
  submitResolvePlannedState,
  submitUpdateChapterStateChanges,
} from '../novel/planned-state-edit.ts'
import {
  clearPendingMemorySync,
  parseClearPendingMemorySyncInput,
  readPendingMemorySync,
} from '../novel/pending-memory-sync.ts'
import { loadNovelProjectDetail, loadNovelProjectSummary, updateNovelProjectMetadata } from '../novel/novel-project.ts'
import {
  createNovelProjectBackup,
  defaultRestoreDirectoryName,
  inspectNovelProjectBackup,
  restoreNovelProjectBackup,
  safeNovelProjectName,
  type ProjectBackupEnvironment,
} from '../novel/project-backup.ts'
import { readNovelStatusSnapshot, refreshNovelStatusSnapshot } from '../novel/novel-status.ts'
import { collectNovelStatusEnrichment } from '../novel/novel-status-memory.ts'
import { openMemoryDbReadonly } from '../novel/memory-db.ts'
import { readAppearedCharacterContacts } from '../novel/appeared-characters.ts'
import { readCharacterStateSnapshot } from '../novel/character-state.ts'
import {
  readChapterPlannedState,
  readCharacterFuturePlans,
  readPlannedStateCounts,
} from '../novel/planned-state-read.ts'
import { readMemoryGraph } from '../novel/memory-graph.ts'
import type { PlannedStateScope } from '@shared/types/planned-state'
import { readCharacterStatusesViaEngine } from '../engine/novel-memory-mcp-client.ts'
import { createNovelProject } from '../novel/novel-create.ts'
import {
  clearReferenceGuidance,
  getReferenceWorksSummary,
  importReferenceSourceFiles,
  pasteReferenceSource,
  removeReferenceSource,
  resetReferenceWorks,
} from '../novel/reference-works.ts'
import type {
  CreateNovelProjectInput,
  DeleteNovelProjectInput,
  PasteReferenceSourceInput,
  RemoveReferenceSourceInput,
} from '@shared/types/novel'
import type {
  CreateNovelProjectBackupDialogResult,
  RestoreNovelProjectBackupDialogResult,
} from '@shared/types/project-backup'
import { getPlanningCapabilityReceipts } from '../packs/pack-store.ts'
import { appendPackEvent } from '../packs/pack-provenance.ts'
import {
  diffNovelPacksEnabledEvents,
  isValidNovelPacksEntry,
  readChapterCapabilityReceipt,
  readNovelPacks,
  writeNovelPacks,
} from '../novel/novel-packs.ts'
import type { NovelPacksEntry, PlanningCapabilityReceiptData } from '@shared/types/capability-pack'
import { NARRACAT_AGENT_CORE_VERSION_LOCK } from '../engine/agent-core-contract.ts'

function projectBackupEnvironment(): ProjectBackupEnvironment {
  return {
    appVersion: app.getVersion(),
    agentCoreVersion: NARRACAT_AGENT_CORE_VERSION_LOCK.version,
    agentCorePath: currentAgentCorePath(),
    userDataPath: userDataPath(),
  }
}

function readProjectPathInput(input: unknown): { projectPath: string; selectedChapter?: number } {
  if (!input || typeof input !== 'object') throw new Error('项目参数非法。')
  const { projectPath, selectedChapter } = input as Record<string, unknown>

  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('缺少项目路径。')
  if (
    selectedChapter !== undefined &&
    (typeof selectedChapter !== 'number' || !Number.isInteger(selectedChapter) || selectedChapter < 1)
  ) {
    throw new Error('章节号参数非法。')
  }

  return { projectPath, selectedChapter }
}

function readProjectPathValue(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('缺少项目路径。')
  return input
}

function readEnrichCharacterStatusesInput(input: unknown): {
  projectPath: string
  characterUids: string[]
  knowledgeBoundaryChapter: number | null
} {
  if (!input || typeof input !== 'object') throw new Error('角色状态富化参数非法。')
  const { projectPath, characterUids, knowledgeBoundaryChapter } = input as Record<string, unknown>

  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('缺少项目路径。')
  if (!Array.isArray(characterUids) || characterUids.some((uid) => typeof uid !== 'string')) {
    throw new Error('角色 UID 列表参数非法。')
  }
  const boundary =
    typeof knowledgeBoundaryChapter === 'number' && Number.isInteger(knowledgeBoundaryChapter)
      ? knowledgeBoundaryChapter
      : null

  return { projectPath, characterUids: characterUids as string[], knowledgeBoundaryChapter: boundary }
}

function readCharacterStateInput(input: unknown): {
  projectPath: string
  characterUid: string
  characterName: string
} {
  if (!input || typeof input !== 'object') throw new Error('character state input must be an object')
  const { projectPath, characterUid, characterName } = input as Record<string, unknown>
  if (typeof projectPath !== 'string' || projectPath.length === 0) throw new Error('projectPath is required')
  if (typeof characterUid !== 'string' || characterUid.length === 0) throw new Error('characterUid is required')
  if (typeof characterName !== 'string' || characterName.length === 0) throw new Error('characterName is required')
  return { projectPath, characterUid, characterName }
}

function readPlannedStateInput(input: unknown): { projectPath: string; scope: PlannedStateScope } {
  if (!input || typeof input !== 'object') throw new Error('计划状态参数非法。')
  const { projectPath, scope } = input as Record<string, unknown>
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('缺少项目路径。')
  if (!scope || typeof scope !== 'object') throw new Error('计划状态查询范围非法。')
  const { kind } = scope as Record<string, unknown>

  if (kind === 'chapter') {
    const { chapter } = scope as Record<string, unknown>
    if (typeof chapter !== 'number' || !Number.isInteger(chapter) || chapter < 1) {
      throw new Error('章号参数非法。')
    }
    return { projectPath, scope: { kind: 'chapter', chapter } }
  }
  if (kind === 'character') {
    const { characterUid } = scope as Record<string, unknown>
    if (typeof characterUid !== 'string' || !characterUid.trim()) throw new Error('角色 UID 参数非法。')
    return { projectPath, scope: { kind: 'character', characterUid } }
  }
  throw new Error('计划状态查询范围非法。')
}

function readPlannedStateCountsInput(input: unknown): { projectPath: string } {
  if (!input || typeof input !== 'object') throw new Error('缺少项目路径。')
  const { projectPath } = input as Record<string, unknown>
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('缺少项目路径。')
  return { projectPath }
}

function readArtifactInput(input: unknown): { projectPath: string; chapterNumber: number; volumeNumber?: number } {
  if (!input || typeof input !== 'object') throw new Error('章节产物参数非法。')
  const { projectPath, chapterNumber, volumeNumber } = input as Record<string, unknown>

  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('缺少项目路径。')
  if (typeof chapterNumber !== 'number' || !Number.isInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error('章节号参数非法。')
  }
  if (
    volumeNumber !== undefined &&
    (typeof volumeNumber !== 'number' || !Number.isInteger(volumeNumber) || volumeNumber < 1)
  ) {
    throw new Error('卷号参数非法。')
  }

  return { projectPath, chapterNumber, volumeNumber }
}

function readWorkbenchArtifactInput(input: unknown): {
  projectPath: string
  objectId: string
  volumeNumber?: number
} {
  if (!input || typeof input !== 'object') throw new Error('对象产物参数非法。')
  const { projectPath, objectId, volumeNumber } = input as Record<string, unknown>

  if (typeof projectPath !== 'string' || !projectPath.trim()) throw new Error('缺少项目路径。')
  if (typeof objectId !== 'string' || !objectId.trim()) throw new Error('缺少对象 ID。')
  if (
    volumeNumber !== undefined &&
    (typeof volumeNumber !== 'number' || !Number.isInteger(volumeNumber) || volumeNumber < 1)
  ) {
    throw new Error('卷号参数非法。')
  }

  return { projectPath, objectId, volumeNumber }
}

function readCreateNovelInput(input: unknown): CreateNovelProjectInput {
  const value = readInputRecord(input, '新建小说参数非法。')
  const title = readRequiredString(value, 'title', '缺少小说标题。')
  const genre = readRequiredString(value, 'genre', '缺少小说类型。')

  return {
    title,
    genre,
    automationLevel: readAutomationLevel(value.automationLevel),
  }
}

function readDeleteNovelProjectInput(input: unknown): DeleteNovelProjectInput {
  const value = readInputRecord(input, '删除小说参数非法。')
  const title = readRequiredString(value, 'title', '缺少小说标题。')
  const confirmationTitle = readRequiredString(value, 'confirmationTitle', '缺少确认标题。')

  if (title.trim() !== confirmationTitle.trim()) throw new Error('请输入小说标题以确认删除。')

  return {
    projectPath: readRequiredString(value, 'projectPath', '缺少项目路径。'),
    title,
    confirmationTitle,
  }
}

function readPasteReferenceSourceInput(input: unknown): PasteReferenceSourceInput {
  const value = readInputRecord(input, '参考作品参数非法。')

  return {
    projectPath: readRequiredString(value, 'projectPath', '缺少项目路径。'),
    title: readRequiredString(value, 'title', '缺少参考作品标题。'),
    content: readRequiredString(value, 'content', '缺少参考作品正文。'),
  }
}

function readRemoveReferenceSourceInput(input: unknown): RemoveReferenceSourceInput {
  const value = readInputRecord(input, '参考作品参数非法。')

  return {
    projectPath: readRequiredString(value, 'projectPath', '缺少项目路径。'),
    fileName: readRequiredString(value, 'fileName', '缺少参考作品文件名。'),
  }
}

function readNovelPacksGetInput(input: unknown): { projectPath: string } {
  const value = readInputRecord(input, '能力包启用清单参数非法。')
  return { projectPath: readRequiredString(value, 'projectPath', '缺少项目路径。') }
}

function readNovelPacksSetInput(input: unknown): { projectPath: string; enabled: NovelPacksEntry[] } {
  const value = readInputRecord(input, '能力包启用清单参数非法。')
  const projectPath = readRequiredString(value, 'projectPath', '缺少项目路径。')
  const { enabled } = value
  if (!Array.isArray(enabled) || !enabled.every(isValidNovelPacksEntry)) {
    throw new Error('能力包启用清单条目非法。')
  }
  return { projectPath, enabled }
}

function readChapterCapabilityReceiptInput(input: unknown): { projectPath: string; chapter: number } {
  const value = readInputRecord(input, '章节能力回执参数非法。')
  const projectPath = readRequiredString(value, 'projectPath', '缺少项目路径。')
  const { chapter } = value
  if (typeof chapter !== 'number' || !Number.isInteger(chapter) || chapter < 1) {
    throw new Error('章节号参数非法。')
  }
  return { projectPath, chapter }
}

export function registerNovelIpcHandlers(): void {
  // 规划期能力包装载回执（.narracat/capability-receipts/planning-<stage>.json 三份只读，spec §6）。
  ipcMain.handle('novel-packs:get-planning-receipts', async (_event, input: unknown): Promise<PlanningCapabilityReceiptData[]> => {
    const { projectPath } = readNovelPacksGetInput(input)
    return getPlanningCapabilityReceipts({ projectPath })
  })

  // 小说级能力包启用清单：get/set 读写 `.narracat/packs.json`；get-receipt 读章级能力回执
  // （Task 9b 消费，本片只做只读通道），缺失/损坏一律降级 null，不阻断章节浏览。
  ipcMain.handle('novel-packs:get', async (_event, input: unknown) => {
    const { projectPath } = readNovelPacksGetInput(input)
    return readNovelPacks(projectPath)
  })

  ipcMain.handle('novel-packs:set', async (_event, input: unknown) => {
    const { projectPath, enabled } = readNovelPacksSetInput(input)
    return runProjectMutation(projectPath, async () => {
      const previous = await readNovelPacks(projectPath)
      const result = await writeNovelPacks(projectPath, enabled)
      // 事件埋点（B2 刀3 Task 10）：enable/disable/upgrade 三态 diff，逐条 appendPackEvent 落审计日志。
      // 写失败不阻断本次 set 主流程——启用清单已成功落盘，事件日志只是审计尾巴，吞错误 + console.error。
      for (const event of diffNovelPacksEnabledEvents(previous.enabled, result.enabled)) {
        try {
          await appendPackEvent(userDataPath(), {
            action: event.action,
            packId: event.packId,
            ...(event.version ? { version: event.version } : {}),
            projectPath,
          })
        } catch (error) {
          console.error('能力包启用事件日志写入失败', error)
        }
      }
      return result
    })
  })

  ipcMain.handle('novel-packs:get-receipt', async (_event, input: unknown) => {
    const { projectPath, chapter } = readChapterCapabilityReceiptInput(input)
    return readChapterCapabilityReceipt(projectPath, chapter)
  })

  ipcMain.handle('novel:list-projects', async () => {
    const config = await readCurrentConfig()
    return scanNovelProjects({
      novelRootDir: config.novelRootDir,
      recentNovelPaths: config.recentNovelPaths,
    })
  })

  ipcMain.handle(
    'novel:create-project-backup',
    async (event, input: unknown): Promise<CreateNovelProjectBackupDialogResult> => {
      const projectPath = readProjectPathValue(input)
      const project = await loadNovelProjectSummary(projectPath)
      if (project.status === 'invalid') throw new Error('项目结构不完整，无法备份。')
      const parent = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.SaveDialogOptions = {
        title: '备份小说项目',
        buttonLabel: '创建备份',
        defaultPath: join(
          dirname(projectPath),
          `${safeNovelProjectName(project.title, project.id)}.narracatbackup`,
        ),
        filters: [{ name: 'NarraCat 小说备份', extensions: ['narracatbackup'] }],
      }
      const selected = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)
      if (selected.canceled || !selected.filePath) return { status: 'canceled' }

      const result = await getAgentRuntimeCoordinator().runProjectBackup(projectPath, () =>
        createNovelProjectBackup(
          { projectPath, targetPath: selected.filePath! },
          projectBackupEnvironment(),
        ),
      )
      return { status: 'ok', ...result }
    },
  )

  ipcMain.handle(
    'novel:restore-project-backup',
    async (event): Promise<RestoreNovelProjectBackupDialogResult> => {
      const parent = BrowserWindow.fromWebContents(event.sender)
      const openOptions: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        title: '选择小说项目备份',
        buttonLabel: '选择备份',
        filters: [{ name: 'NarraCat 小说备份', extensions: ['narracatbackup'] }],
      }
      const selectedBackup = parent
        ? await dialog.showOpenDialog(parent, openOptions)
        : await dialog.showOpenDialog(openOptions)
      const sourcePath = selectedBackup.filePaths[0]
      if (selectedBackup.canceled || !sourcePath) return { status: 'canceled' }

      const manifest = await inspectNovelProjectBackup(sourcePath)
      const config = await readCurrentConfig()
      const defaultPath = await availableRestorePath(
        join(config.novelRootDir, defaultRestoreDirectoryName(manifest)),
      )
      const destinationOptions: Electron.SaveDialogOptions = {
        title: '选择新的恢复目录',
        message: '恢复不会覆盖现有目录；请为小说选择一个新目录。',
        buttonLabel: '恢复到这里',
        defaultPath,
      }
      const selectedDestination = parent
        ? await dialog.showSaveDialog(parent, destinationOptions)
        : await dialog.showSaveDialog(destinationOptions)
      if (selectedDestination.canceled || !selectedDestination.filePath) return { status: 'canceled' }

      const existingProjects = await scanNovelProjects({
        novelRootDir: config.novelRootDir,
        recentNovelPaths: config.recentNovelPaths,
      })
      const restored = await restoreNovelProjectBackup(
        { sourcePath, destinationPath: selectedDestination.filePath },
        { ...projectBackupEnvironment(), existingProjects },
      )
      await writeAppConfig(configPath(), {
        ...config,
        recentNovelPaths: await pruneMissingRecentNovelPaths([
          restored.project.path,
          ...config.recentNovelPaths.filter((path) => path !== restored.project.path),
        ]),
      })
      return restored
    },
  )

  ipcMain.handle('novel:remember-project-path', async (_event, input: unknown) => {
    return rememberNovelProjectPath(parseRememberNovelProjectPathInput(input), {
      loadProjectSummary: loadNovelProjectSummary,
      readConfig: readCurrentConfig,
      writeConfig: (config) => writeAppConfig(configPath(), config),
    })
  })

  ipcMain.handle('novel:create-project', async (_event, input: unknown) => {
    const createInput = readCreateNovelInput(input)
    const config = await readCurrentConfig()
    const created = await createNovelProject({
      novelRootDir: config.novelRootDir,
      pluginPath: currentAgentCorePath(),
      input: createInput,
    })

    await writeAppConfig(configPath(), {
      ...config,
      recentNovelPaths: [
        created.projectPath,
        ...config.recentNovelPaths.filter((path) => path !== created.projectPath),
      ],
    })

    return created
  })

  ipcMain.handle('novel:update-project-metadata', async (_event, input: unknown) => {
    const request = readUpdateNovelProjectMetadataInput(input)
    return runProjectMutation(request.projectPath, () => updateNovelProjectMetadata(request))
  })

  // 损坏项目的自救入口（#38）：invalid 多半是文件被移动/重命名或磁盘没连接，
  // 让作者自己打开文件夹看一眼，比引导他删东西安全得多。
  ipcMain.handle('novel:reveal-folder', async (_event, input: unknown) => {
    const projectPath = typeof input === 'string' ? input.trim() : ''
    if (!projectPath) throw new Error('缺少项目路径。')
    shell.showItemInFolder(projectPath)
  })

  ipcMain.handle('novel:delete-project', async (_event, input: unknown) => {
    const deleteInput = readDeleteNovelProjectInput(input)
    return runProjectMutation(deleteInput.projectPath, async () => {
      const config = await readCurrentConfig()
      const result = await deleteNovelProjectDirectory({
        projectPath: deleteInput.projectPath,
        recentNovelPaths: config.recentNovelPaths,
        trashItem: (projectPath) => shell.trashItem(projectPath),
      })

      await writeAppConfig(configPath(), {
        ...config,
        recentNovelPaths: result.recentNovelPaths,
      })

      return {
        projectPath: result.projectPath,
        trashed: result.trashed,
      }
    })
  })

  ipcMain.handle('novel:get-project', async (_event, input: unknown) => {
    const { projectPath, selectedChapter } = readProjectPathInput(input)
    return loadNovelProjectDetail(projectPath, selectedChapter)
  })

  ipcMain.handle('novel:read-status', async (_event, input: unknown) => {
    return readNovelStatusSnapshot(readProjectPathValue(input))
  })

  ipcMain.handle('novel:refresh-status', async (_event, input: unknown) => {
    return refreshNovelStatusSnapshot(readProjectPathValue(input), {
      enrich: ({ projectPath, currentChapter }) =>
        collectNovelStatusEnrichment({ projectPath, currentChapter, openMemoryDb: openMemoryDbReadonly }),
    })
  })

  ipcMain.handle('novel:list-appeared-characters', async (_event, input: unknown) => {
    const projectPath = readProjectPathValue(input)
    // 只返回联系人骨架（currentStatus 留 null）→ 列表秒开。富化要 spawn 引擎进程（~2s），
    // 拆到 enrich-character-statuses 异步回填，不阻塞列表渲染（runner 路径不走此分支、零引擎开销）。
    return readAppearedCharacterContacts({ projectPath, openMemoryDb: openMemoryDbReadonly })
  })

  ipcMain.handle('novel:read-character-state', async (_event, input: unknown) => {
    // 只读直读 memory.db（物化 card_json + facts 时序投影），失败由 reader 自身降级为 available=false
    return readCharacterStateSnapshot({ ...readCharacterStateInput(input), openMemoryDb: openMemoryDbReadonly })
  })

  ipcMain.handle('novel:read-planned-state', async (_event, input: unknown) => {
    // 计划状态变更（planned_state_changes）只读通道：chapter scope 供章纲卡账本区，
    // character scope 供角色页轻提示②；失败由读函数自身降级为 available=false
    const { projectPath, scope } = readPlannedStateInput(input)
    if (scope.kind === 'chapter') {
      return readChapterPlannedState({ projectPath, chapter: scope.chapter, openMemoryDb: openMemoryDbReadonly })
    }
    return readCharacterFuturePlans({ projectPath, characterUid: scope.characterUid, openMemoryDb: openMemoryDbReadonly })
  })

  ipcMain.handle('novel:read-planned-state-counts', async (_event, input: unknown) => {
    // 目录徽标消费：按章的 status='planned' 行计数
    const { projectPath } = readPlannedStateCountsInput(input)
    return readPlannedStateCounts({ projectPath, openMemoryDb: openMemoryDbReadonly })
  })

  ipcMain.handle('novel:read-memory-graph', async (_event, input: unknown) => {
    // 记忆星图只读通道：直读 memory.db 聚合角色/事实点线，失败由读函数自身降级为空快照
    const record = readInputRecord(input, '缺少记忆星图读取参数。')
    const projectPath = readRequiredString(record, 'projectPath', '缺少项目路径。')
    return readMemoryGraph({ projectPath, openMemoryDb: openMemoryDbReadonly })
  })

  ipcMain.handle('novel:enrich-character-statuses', async (_event, input: unknown) => {
    const { projectPath, characterUids, knowledgeBoundaryChapter } = readEnrichCharacterStatusesInput(input)
    if (characterUids.length === 0) return {}

    // currentStatus 真相归引擎（NovelMemory MCP `novel_character_statuses`）。任何失败由
    // readCharacterStatusesViaEngine 自身降级为空 Map → 这里返回空对象，列表保持无 status、不阻断。
    const statusByUid = await readCharacterStatusesViaEngine(
      projectPath,
      characterUids,
      knowledgeBoundaryChapter,
      { appRoot: app.getAppPath(), resourcesPath: process.resourcesPath, userDataPath: userDataPath() },
    )
    return Object.fromEntries(statusByUid)
  })

  ipcMain.handle('novel:get-chapter-artifacts', async (_event, input: unknown) => {
    const { projectPath, chapterNumber, volumeNumber } = readArtifactInput(input)
    return loadNovelChapterArtifacts({ projectPath, chapterNumber, volumeNumber })
  })

  ipcMain.handle('novel:get-workbench-artifacts', async (_event, input: unknown) => {
    return loadNovelWorkbenchArtifacts(readWorkbenchArtifactInput(input), { openMemoryDb: openMemoryDbReadonly })
  })

  ipcMain.handle('novel:submit-premise-edit', async (_event, input: unknown) => {
    const { projectPath, edit } = parsePremiseFieldEditInput(input)
    return runProjectMutation(projectPath, () =>
      submitPremiseFieldEdit({
        appRoot: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        userDataPath: userDataPath(),
        projectPath,
        edit,
      }),
    )
  })

  ipcMain.handle('novel:submit-chapter-outline-edit', async (_event, input: unknown) => {
    const request = parseChapterOutlineFieldEditInput(input)
    return runProjectMutation(request.projectPath, () => submitChapterOutlineFieldEdit(request))
  })

  ipcMain.handle('novel:submit-master-outline-edit', async (_event, input: unknown) => {
    const request = parseMasterOutlineFieldEditInput(input)
    return runProjectMutation(request.projectPath, () =>
      submitMasterOutlineFieldEdit(request, { appRoot: app.getAppPath(), resourcesPath: process.resourcesPath, userDataPath: userDataPath() }),
    )
  })

  ipcMain.handle('novel:submit-authored-state', async (_event, input: unknown) => {
    // 角色状态第一档直存（A4×D2 片2b）：钦定/补录/纠错/作废/确认背书，写权限归引擎工具
    const request = parseAuthoredStateEditInput(input)
    return runProjectMutation(request.projectPath, () =>
      submitAuthoredStateEdit(request, { appRoot: app.getAppPath(), resourcesPath: process.resourcesPath, userDataPath: userDataPath() }),
    )
  })

  ipcMain.handle('novel:submit-style-anchor', async (_event, input: unknown) => {
    // 本书声音样章锚（P1B 刀2）：作者划选标记的定稿段落，写权限归引擎工具
    const request = parseSubmitStyleAnchorInput(input)
    return runProjectMutation(request.projectPath, () =>
      submitStyleAnchor(request, { appRoot: app.getAppPath(), resourcesPath: process.resourcesPath, userDataPath: userDataPath() }),
    )
  })

  ipcMain.handle('novel:list-style-anchors', async (_event, input: unknown) => {
    const projectPath = typeof (input as { projectPath?: unknown })?.projectPath === 'string'
      ? ((input as { projectPath: string }).projectPath).trim()
      : ''
    if (!projectPath) throw new Error('缺少项目路径')
    return listStyleAnchors({ projectPath }, { appRoot: app.getAppPath(), resourcesPath: process.resourcesPath, userDataPath: userDataPath() })
  })

  ipcMain.handle('novel:submit-character-identity', async (_event, input: unknown) => {
    // 出生证编辑（性别/年龄/别名）：读现档全量合并后经引擎覆盖式重提交，md 身份行由引擎机械同步
    const request = parseCharacterIdentityEditInput(input)
    return runProjectMutation(request.projectPath, () =>
      submitCharacterIdentityEdit(request, { appRoot: app.getAppPath(), resourcesPath: process.resourcesPath, userDataPath: userDataPath() }),
    )
  })

  ipcMain.handle('novel:resolve-planned-state', async (_event, input: unknown) => {
    // 计划状态变更处置（兑现报告卡四动作）：写权限归引擎工具，处置权归作者，不进 agent 工具面
    const request = parseResolvePlannedStateInput(input)
    return runProjectMutation(request.projectPath, () =>
      submitResolvePlannedState(request, { appRoot: app.getAppPath(), resourcesPath: process.resourcesPath, userDataPath: userDataPath() }),
    )
  })

  ipcMain.handle('novel:update-chapter-state-changes', async (_event, input: unknown) => {
    // 章纲卡 state_changes 整段替换：json+md+计划表协调写入+CAS 防并发归引擎工具
    const request = parseUpdateChapterStateChangesInput(input)
    return runProjectMutation(request.projectPath, () =>
      submitUpdateChapterStateChanges(request, {
        appRoot: app.getAppPath(),
        resourcesPath: process.resourcesPath,
      }),
    )
  })

  ipcMain.handle('novel:save-chapter-manuscript', async (_event, input: unknown) => {
    const request = parseManuscriptEditInput(input)
    return runProjectMutation(request.projectPath, async () => {
      const result = await submitManuscriptEdit(request, { openMemoryDb: openMemoryDbReadonly })
      if (result.ok) {
        try {
          await discardManuscriptDraft({ projectPath: request.projectPath, chapter: request.chapter })
        } catch (error) {
          // 正文已成功落盘；草稿清理失败不能把一次成功保存伪装成失败。下次 hydration 会按 stale 自动清理。
          console.error('[manuscript-drafts] 正文保存后清理草稿失败', error)
        }
      }
      return result
    })
  })

  ipcMain.handle('novel:list-manuscript-revisions', async (_event, input: unknown) => {
    return manuscriptRevisionStore.listChapter(parseManuscriptRevisionInput(input))
  })

  ipcMain.handle('novel:read-manuscript-revision', async (_event, input: unknown) => {
    return manuscriptRevisionStore.readRevision(parseReadManuscriptRevisionInput(input))
  })

  ipcMain.handle('novel:restore-manuscript-revision', async (_event, input: unknown) => {
    const request = parseRestoreManuscriptRevisionInput(input)
    return runProjectMutation(request.projectPath, async () => {
      const activity = await getAgentRuntimeCoordinator().getProjectActivity(request.projectPath)
      if (activity.active) {
        return { ok: false, message: 'Agent 正在修改这个小说项目，请等待任务结束后再恢复正文版本。' }
      }
      const draft = await readManuscriptDraft({ projectPath: request.projectPath, chapter: request.chapter })
      if (draft.status !== 'none') {
        return { ok: false, message: '本章还有未保存或待处理的恢复草稿，请先保存或放弃草稿。' }
      }
      return restoreManuscriptRevision(request, { openMemoryDb: openMemoryDbReadonly })
    })
  })

  ipcMain.handle('novel:get-manuscript-draft', async (_event, input: unknown) => {
    return readManuscriptDraft(parseManuscriptDraftInput(input))
  })

  ipcMain.handle('novel:save-manuscript-draft', async (_event, input: unknown) => {
    const request = parseSaveManuscriptDraftInput(input)
    return runProjectMutation(request.projectPath, () => saveManuscriptDraft(request))
  })

  ipcMain.handle('novel:discard-manuscript-draft', async (_event, input: unknown) => {
    const request = parseManuscriptDraftInput(input)
    return runProjectMutation(request.projectPath, () => discardManuscriptDraft(request))
  })

  ipcMain.handle('novel:list-manuscript-drafts', async (_event, input: unknown) => {
    return listManuscriptDrafts(readProjectPathValue(input))
  })

  ipcMain.handle('novel:get-pending-memory-sync', async (_event, input: unknown) => {
    return readPendingMemorySync(readProjectPathValue(input))
  })

  ipcMain.handle('novel:clear-pending-memory-sync', async (_event, input: unknown) => {
    const { projectPath, chapter } = parseClearPendingMemorySyncInput(input)
    return runProjectMutation(projectPath, async () => {
      await clearPendingMemorySync(projectPath, chapter)
      return { ok: true }
    })
  })

  ipcMain.handle('novel:paste-reference-source', async (_event, input: unknown) => {
    const request = readPasteReferenceSourceInput(input)
    return runProjectMutation(request.projectPath, () => pasteReferenceSource(request))
  })

  ipcMain.handle('novel:remove-reference-source', async (_event, input: unknown) => {
    const request = readRemoveReferenceSourceInput(input)
    return runProjectMutation(request.projectPath, () => removeReferenceSource(request))
  })

  ipcMain.handle('novel:clear-reference-guidance', async (_event, input: unknown) => {
    const projectPath = readProjectPathValue(input)
    return runProjectMutation(projectPath, () => clearReferenceGuidance(projectPath))
  })

  ipcMain.handle('novel:reset-reference-works', async (_event, input: unknown) => {
    const projectPath = readProjectPathValue(input)
    return runProjectMutation(projectPath, () => resetReferenceWorks(projectPath))
  })

  ipcMain.handle('dialog:import-reference-sources', async (event, input: unknown) => {
    const projectPath = readProjectPathValue(input)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      title: '导入参考作品',
      buttonLabel: '导入',
      filters: [{ name: 'Markdown 或文本', extensions: ['md', 'txt'] }],
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) return getReferenceWorksSummary(projectPath)
    return runProjectMutation(projectPath, () =>
      importReferenceSourceFiles({ projectPath, sourcePaths: result.filePaths }),
    )
  })
}

async function availableRestorePath(basePath: string): Promise<string> {
  if (!(await lstat(basePath).catch(() => null))) return basePath
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${basePath}-${suffix}`
    if (!(await lstat(candidate).catch(() => null))) return candidate
  }
  throw new Error('无法为恢复项目生成可用的新目录名。')
}
