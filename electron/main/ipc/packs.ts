import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { basename } from 'node:path'
import { getApiKey } from '../secrets.ts'
import { NARRACAT_AGENT_CORE_VERSION_LOCK } from '../engine/agent-core-contract.ts'
import {
  cancelCapabilityPackImport,
  confirmCapabilityPackImport,
  exportCapabilityPack,
  getCapabilityPackDetail,
  listCapabilityPacks,
  previewCapabilityPackImport,
  uninstallCapabilityPack,
} from '../packs/pack-store.ts'
import { exportCapabilityPackTemplate, TEMPLATE_PACK_VERSION } from '../packs/pack-template.ts'
import {
  createPackDraft,
  deletePackDraft,
  exportPackDraftProject,
  getPackDraft,
  importPackDraftProject,
  listPackDrafts,
  updatePackDraft,
} from '../packs/pack-drafts.ts'
import { createPackCompiler } from '../packs/pack-compile.ts'
import { callAuthoringTool, previewDraftCard, type PreviewCardResult } from '../packs/pack-preview.ts'
import { publishPackDraft } from '../packs/pack-publish.ts'
import { copyPackToDraft, readLocalPackContent } from '../packs/pack-local-content.ts'
import { createPackLearner } from '../packs/pack-learn.ts'
import { readLearnCommandSource, readLearnMethodologySource, runLearnSession } from '../packs/learn-session.ts'
import { rewriteCardBody } from '../packs/card-rewrite.ts'
import { createPackWizard } from '../packs/pack-wizard.ts'
import { createWizardProvider, createWizardTurnRunner } from '../packs/wizard-session.ts'
import { readUpdatePackDraftInput } from './pack-draft-input.ts'
import { loadNovelChapters, loadExternalBook, estimateLearnRun } from '../packs/pack-learn-workspace.ts'
import { readNarraCatCommandFile } from '../agent/runs/narracat-command.ts'
import type {
  CapabilityPackSummary,
  ExportPackDraftProjectResult,
  ExportPackResult,
  ImportPackDraftProjectResult,
  ImportPackResult,
  LocalPackContent,
  PackAuthoringVocab,
  PackDetailResult,
  PackDraftMeta,
  PackLearnEstimate,
  PackLearnResult,
  PackLearnSource,
  PackLearnTier,
  PackLicense,
  PackWizardAck,
  PackWizardSnapshot,
  PreviewImportPackResult,
} from '@shared/types/capability-pack'
import {
  isPackLicense,
  PACK_DRAFT_PROJECT_FILE_EXTENSION,
  PACK_FILE_EXTENSION,
  TEMPLATE_PACK_ID,
} from '@shared/types/capability-pack'
import { currentAgentCorePath } from './app.ts'
import { readCurrentConfig, readInputRecord, readOptionalString, readRequiredString, userDataPath } from './inputs.ts'

/** 造包中心引擎只读工具调用 paths：三处（词表缓存/编译/预览）共用同一形状，不重复拼装。 */
function authoringToolPaths(): { appRoot: string; resourcesPath?: string; userDataPath: string } {
  return { appRoot: app.getAppPath(), resourcesPath: process.resourcesPath, userDataPath: userDataPath() }
}

/**
 * 造包中心词表缓存（B2 刀3 Task 10）：同引擎版本词表内容不变，进程内存缓存一次即可，
 * 避免每次编译/预览都起一次 MCP 子进程握手。只供主进程内部 pack-compile 的 getVocab 依赖消费——
 * 曾经暴露过的 `packs:authoring-vocab` IPC 通道渲染端零消费，终审确认后已移除（Minor·死暴露）。
 */
let _packAuthoringVocabCache: PackAuthoringVocab | null = null
async function getPackAuthoringVocabCached(): Promise<PackAuthoringVocab> {
  if (!_packAuthoringVocabCache) {
    const raw = await callAuthoringTool('novel_pack_authoring_vocab', {}, authoringToolPaths())
    _packAuthoringVocabCache = raw as PackAuthoringVocab
  }
  return _packAuthoringVocabCache
}

/** 懒初始化：app.getPath 要等 Electron app 就绪后才可调用，推迟到首次使用（同 getCharacterChatProfiler 先例）。 */
let _packCompiler: ReturnType<typeof createPackCompiler> | null = null
function getPackCompiler(): ReturnType<typeof createPackCompiler> {
  if (!_packCompiler) {
    _packCompiler = createPackCompiler({
      readConfig: readCurrentConfig,
      getApiKey,
      getVocab: getPackAuthoringVocabCached,
      readDraft: getPackDraft,
      writeDraft: updatePackDraft,
      readEngineVersion: () => NARRACAT_AGENT_CORE_VERSION_LOCK.version,
    })
  }
  return _packCompiler
}

/**
 * 惰性单例（照 getPackCompiler 先例）：学习编排全局只允许一本书在学（busy 守卫见 pack-learn.ts
 * createPackLearner 内部），所以只需要一个 learner 实例，不是 agentRunManagerForSender 那种
 * WeakMap-per-sender（那是给「同窗口可并发多个 run」设计的）。emit 推送目标绑定「最近一次发起
 * 学习/取消的窗口」——每次 packs:learn-start 调用前更新 _packLearnEmitSender。
 */
let _packLearner: ReturnType<typeof createPackLearner> | null = null
let _packLearnEmitSender: Electron.WebContents | null = null
function getPackLearner(): ReturnType<typeof createPackLearner> {
  if (!_packLearner) {
    _packLearner = createPackLearner({
      userDataPath,
      runLearnSession,
      rewriteCardBody,
      compileCard: (compileInput) => getPackCompiler().compileCard(compileInput),
      readCommandSource: readLearnCommandSource,
      readMethodologySource: readLearnMethodologySource,
      emit: (event) => {
        if (_packLearnEmitSender && !_packLearnEmitSender.isDestroyed()) {
          _packLearnEmitSender.send('packs:learn-event', event)
        }
      },
    })
  }
  return _packLearner
}

/**
 * 向导会话执行（刀5 T4）：沙盒六要素与每轮完整重建见 wizard-session.ts 文件头；环境依赖在这里
 * 注入（app.getPath 系推迟到每轮调用时才取，与其它惰性单例同理）。
 */
const runWizardTurn = createWizardTurnRunner({
  readConfig: readCurrentConfig,
  getApiKey,
  appRoot: () => app.getAppPath(),
  resourcesPath: () => process.resourcesPath,
  userDataPath,
})

/**
 * 作家向导单例装配（照 getPackLearner 先例惰性构建）：一个实例 = 一次访谈会话（pack-wizard.ts
 * 生命周期约定），终态实例由 packs:wizard-start 经 obtainForStart 重建（「再来一次」）。emit 推送
 * 目标绑定「最近一次成功发起向导的窗口」——sender 赋值在 busy 判定之后（刀4 T11 评审 F3 同款）。
 */
let _packWizardEmitSender: Electron.WebContents | null = null
const packWizardProvider = createWizardProvider(() =>
  createPackWizard({
    userDataPath,
    runTurn: runWizardTurn,
    compileCard: (compileInput) => getPackCompiler().compileCard(compileInput),
    // 代表性预览（刀5 修复波）：与 packs:draft-card-preview 同一可编程面，paths 同源拼装
    previewCard: (previewInput) => previewDraftCard({ ...previewInput, paths: authoringToolPaths() }),
    // App 直读引擎命令资产（learn-craft 同款消费方式）：dev/packaged 双路径由 currentAgentCorePath 解析
    readWizardPrompt: async () => readNarraCatCommandFile(currentAgentCorePath(), 'writer-wizard'),
    emit: (event) => {
      if (_packWizardEmitSender && !_packWizardEmitSender.isDestroyed()) {
        _packWizardEmitSender.send('packs:wizard-event', event)
      }
    },
  }),
)

function readPackIdVersionInput(input: unknown, message: string): { id: string; version: string } {
  const value = readInputRecord(input, message)
  return {
    id: readRequiredString(value, 'id', message),
    version: readRequiredString(value, 'version', message),
  }
}

// 导出参数：license/rightsConfirmed 必填（渲染端须先让用户选授权类型 + 勾选确认），readme 可选覆盖。
// 渲染端 UI 在 Task 13 接线；本任务先把主进程签名/IPC 打通。
function readExportCapabilityPackInput(
  input: unknown,
): { id: string; version: string; license: PackLicense; rightsConfirmed: boolean; readme?: string } {
  const value = readInputRecord(input, '导出能力包参数非法。')
  const id = readRequiredString(value, 'id', '导出能力包参数非法：缺少 id。')
  const version = readRequiredString(value, 'version', '导出能力包参数非法：缺少 version。')
  if (!isPackLicense(value.license)) throw new Error('导出能力包参数非法：license 缺失或不是已知授权类型。')
  const readme = readOptionalString(value, 'readme', '导出能力包参数非法：readme 非法。')
  return {
    id, version, license: value.license, rightsConfirmed: value.rightsConfirmed === true,
    ...(readme !== undefined ? { readme } : {}),
  }
}

// 造包中心「创作工程」草稿 IPC 入参校验（B2 刀3 Task 10）。draftId 无需 UUID 格式校验——
// pack-drafts.ts 的 assertSafeDraftId 已在 store 层做纵深守卫，IPC 层只查非空字符串。
function readDraftIdInput(input: unknown): { draftId: string } {
  const value = readInputRecord(input, '造包草稿参数非法：缺少 draftId。')
  return { draftId: readRequiredString(value, 'draftId', '造包草稿参数非法：缺少 draftId。') }
}

function readDraftCardInput(input: unknown): { draftId: string; cardId: string } {
  const value = readInputRecord(input, '造包草稿卡参数非法。')
  return {
    draftId: readRequiredString(value, 'draftId', '造包草稿卡参数非法：缺少 draftId。'),
    cardId: readRequiredString(value, 'cardId', '造包草稿卡参数非法：缺少 cardId。'),
  }
}

function readCreatePackDraftInput(input: unknown): { name: string } {
  const value = readInputRecord(input, '新建造包草稿参数非法。')
  return { name: readRequiredString(value, 'name', '新建造包草稿参数非法：缺少 name。') }
}

function readPublishPackDraftInput(
  input: unknown,
): { draftId: string; version: string; acknowledgeWarnings?: boolean } {
  const value = readInputRecord(input, '发布能力包草稿参数非法。')
  return {
    draftId: readRequiredString(value, 'draftId', '发布能力包草稿参数非法：缺少 draftId。'),
    version: readRequiredString(value, 'version', '发布能力包草稿参数非法：缺少 version。'),
    ...(value.acknowledgeWarnings === true ? { acknowledgeWarnings: true as const } : {}),
  }
}

// 学习流程入参校验（刀4 Task 11）：校验 source.kind/tier 枚举、路径为非空字符串，照 :569 区既有 reader 风格。
function readLearnStartInput(input: unknown): { source: PackLearnSource; tier: PackLearnTier } {
  const value = readInputRecord(input, '学习参数非法。')
  const { tier } = value
  if (tier !== 'skim' && tier !== 'deep') throw new Error('学习参数非法：档位不合法。')
  const sourceValue = readInputRecord(value.source, '学习参数非法：缺少来源。')
  const title = readRequiredString(sourceValue, 'title', '学习参数非法：缺少书名。')
  if (sourceValue.kind === 'novel') {
    const projectPath = readRequiredString(sourceValue, 'projectPath', '学习参数非法：缺少项目路径。')
    return { source: { kind: 'novel', projectPath, title }, tier }
  }
  if (sourceValue.kind === 'txt' || sourceValue.kind === 'file') {
    const filePath = readRequiredString(sourceValue, 'filePath', '学习参数非法：缺少文件路径。')
    return { source: { kind: sourceValue.kind, filePath, title }, tier }
  }
  throw new Error('学习参数非法：来源类型不合法。')
}

// 向导发送入参校验（刀5 Task 4）：只有一个 text 字段。只校类型不校空——空文本要走 pack-wizard.send
// 的友好回执（「先输入内容再发送。」），不该在这里变成 invoke reject。
function readWizardSendInput(input: unknown): string {
  const value = readInputRecord(input, '向导发送参数非法。')
  if (typeof value.text !== 'string') throw new Error('向导发送参数非法：缺少内容。')
  return value.text
}

export function registerPacksIpcHandlers(): void {
  // 能力包库（B2 刀1，ADR-0034 v1.1）：list 汇总内置 + 用户包；import/export 在 handler 内起对话框，
  // 用户取消一律返回 { status: 'canceled' }（不 throw，不算失败）。
  ipcMain.handle('packs:list', async (): Promise<CapabilityPackSummary[]> => {
    return listCapabilityPacks({ agentCorePath: currentAgentCorePath(), userDataPath: userDataPath() })
  })

  ipcMain.handle('packs:import-preview', async (event): Promise<PreviewImportPackResult | { status: 'canceled' }> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile', 'openDirectory'],
      title: '导入能力包',
      buttonLabel: '选择',
      filters: [{ name: '能力包', extensions: [PACK_FILE_EXTENSION.replace(/^\./, '')] }],
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const sourcePath = result.filePaths[0]
    if (result.canceled || !sourcePath) return { status: 'canceled' }
    return previewCapabilityPackImport({ sourcePath, agentCorePath: currentAgentCorePath(), userDataPath: userDataPath() })
  })

  ipcMain.handle('packs:import-confirm', async (_event, input: unknown): Promise<ImportPackResult> => {
    const value = readInputRecord(input, '确认导入参数非法。')
    const token = readRequiredString(value, 'token', '缺少导入会话 token。')
    return confirmCapabilityPackImport({ token, agentCorePath: currentAgentCorePath(), userDataPath: userDataPath() })
  })

  ipcMain.handle('packs:import-cancel', async (_event, input: unknown): Promise<void> => {
    const value = readInputRecord(input, '取消导入参数非法。')
    const token = readRequiredString(value, 'token', '缺少导入会话 token。')
    await cancelCapabilityPackImport({ token })
  })

  ipcMain.handle('packs:detail', async (_event, input: unknown): Promise<PackDetailResult> => {
    const value = readInputRecord(input, '读取能力包详情参数非法。')
    const id = readRequiredString(value, 'id', '缺少能力包 id。')
    const version = typeof value.version === 'string' && value.version ? value.version : undefined
    return getCapabilityPackDetail({ id, ...(version ? { version } : {}), agentCorePath: currentAgentCorePath(), userDataPath: userDataPath() })
  })

  ipcMain.handle('packs:export-template', async (event): Promise<ExportPackResult | { status: 'canceled' }> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = {
      title: '导出模板包',
      buttonLabel: '导出',
      defaultPath: `${TEMPLATE_PACK_ID}-${TEMPLATE_PACK_VERSION}${PACK_FILE_EXTENSION}`,
      filters: [{ name: '能力包', extensions: [PACK_FILE_EXTENSION.replace(/^\./, '')] }],
    }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { status: 'canceled' }
    return exportCapabilityPackTemplate({ targetPath: result.filePath })
  })

  ipcMain.handle('packs:uninstall', async (_event, input: unknown): Promise<CapabilityPackSummary[]> => {
    const { id, version } = readPackIdVersionInput(input, '卸载能力包参数非法。')
    return uninstallCapabilityPack({ id, version, userDataPath: userDataPath() })
  })

  ipcMain.handle('packs:export', async (event, input: unknown): Promise<ExportPackResult | { status: 'canceled' }> => {
    const { id, version, license, rightsConfirmed, readme } = readExportCapabilityPackInput(input)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = {
      title: '导出能力包',
      buttonLabel: '导出',
      defaultPath: `${id}-${version}${PACK_FILE_EXTENSION}`,
      filters: [{ name: '能力包', extensions: [PACK_FILE_EXTENSION.replace(/^\./, '')] }],
    }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { status: 'canceled' }

    return exportCapabilityPack({
      id, version, userDataPath: userDataPath(), targetPath: result.filePath,
      license, rightsConfirmed, ...(readme !== undefined ? { readme } : {}),
    })
  })

  // 造包中心「创作工程」草稿存储（B2 刀3 Task 10）：list/get/create/update/delete 直调 pack-drafts.ts；
  // export/import 起对话框（.narracatproj），取消一律返回 { status: 'canceled' }（不 throw，同 packs:import-* 先例）；
  // 草稿内的 zip/结构损坏抛的错误在此层捕获归一为 { status: 'invalid', message }，不让技术错误冒泡到 UI。
  ipcMain.handle('packs:drafts-list', async (): Promise<PackDraftMeta[]> => {
    return listPackDrafts({ userDataPath: userDataPath() })
  })

  ipcMain.handle('packs:draft-get', async (_event, input: unknown) => {
    const { draftId } = readDraftIdInput(input)
    return getPackDraft({ userDataPath: userDataPath(), draftId })
  })

  ipcMain.handle('packs:draft-create', async (_event, input: unknown): Promise<PackDraftMeta> => {
    const { name } = readCreatePackDraftInput(input)
    return createPackDraft({ userDataPath: userDataPath(), name })
  })

  ipcMain.handle('packs:draft-update', async (_event, input: unknown): Promise<void> => {
    const { draftId, patch } = readUpdatePackDraftInput(input)
    await updatePackDraft({ userDataPath: userDataPath(), draftId, patch })
  })

  ipcMain.handle('packs:draft-delete', async (_event, input: unknown): Promise<void> => {
    const { draftId } = readDraftIdInput(input)
    await deletePackDraft({ userDataPath: userDataPath(), draftId })
  })

  ipcMain.handle('packs:draft-export-project', async (event, input: unknown): Promise<ExportPackDraftProjectResult> => {
    const { draftId } = readDraftIdInput(input)
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = {
      title: '导出创作工程',
      buttonLabel: '导出',
      defaultPath: `${draftId}${PACK_DRAFT_PROJECT_FILE_EXTENSION}`,
      filters: [{ name: '造包中心工程', extensions: [PACK_DRAFT_PROJECT_FILE_EXTENSION.replace(/^\./, '')] }],
    }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { status: 'canceled' }
    try {
      await exportPackDraftProject({ userDataPath: userDataPath(), draftId, targetPath: result.filePath })
      return { status: 'ok', filePath: result.filePath }
    } catch (error) {
      return { status: 'invalid', message: error instanceof Error ? error.message : '导出创作工程失败，请稍后重试。' }
    }
  })

  ipcMain.handle('packs:draft-import-project', async (event): Promise<ImportPackDraftProjectResult> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      title: '导入创作工程',
      buttonLabel: '导入',
      filters: [{ name: '造包中心工程', extensions: [PACK_DRAFT_PROJECT_FILE_EXTENSION.replace(/^\./, '')] }],
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const sourcePath = result.filePaths[0]
    if (result.canceled || !sourcePath) return { status: 'canceled' }
    try {
      const meta = await importPackDraftProject({ userDataPath: userDataPath(), sourcePath })
      return { status: 'ok', meta }
    } catch (error) {
      return { status: 'invalid', message: error instanceof Error ? error.message : '导入创作工程失败，请稍后重试。' }
    }
  })

  // 造包中心「意图理解编排」（Task 6）：草稿卡意图 → 结构化字段，生产依赖组装照 character-chat-profiler
  // 惰性单例先例（见 getPackCompiler）。
  ipcMain.handle('packs:draft-compile', async (_event, input: unknown) => {
    const { draftId, cardId } = readDraftCardInput(input)
    return getPackCompiler().compileCard({ userDataPath: userDataPath(), draftId, cardId })
  })

  // 造包中心「预览编排」（Task 8）：卡片干跑预演，structure 卡零出网、craft/persona 卡交引擎候选池竞争。
  ipcMain.handle('packs:draft-preview', async (_event, input: unknown): Promise<PreviewCardResult> => {
    const { draftId, cardId } = readDraftCardInput(input)
    return previewDraftCard({ userDataPath: userDataPath(), draftId, cardId, paths: authoringToolPaths() })
  })

  // 造包中心「发布铸版」（Task 7）：草稿 → 不可变发布工件，落盘 + provenance + 事件日志全在 publishPackDraft 内完成。
  ipcMain.handle('packs:draft-publish', async (_event, input: unknown) => {
    const { draftId, version, acknowledgeWarnings } = readPublishPackDraftInput(input)
    return publishPackDraft({
      userDataPath: userDataPath(), agentCorePath: currentAgentCorePath(), draftId, version,
      ...(acknowledgeWarnings !== undefined ? { acknowledgeWarnings } : {}),
    })
  })

  // 造包中心「复制为草稿」（Task 8）：从已装本机包（created/learned-own）反填一份新草稿；
  // learned-external / 无 provenance（imported）一律 null，权限门理由见 pack-local-content.ts 文件头。
  ipcMain.handle('packs:copy-to-draft', async (_event, input: unknown): Promise<PackDraftMeta | null> => {
    const { id, version } = readPackIdVersionInput(input, '复制为草稿参数非法。')
    return copyPackToDraft({ userDataPath: userDataPath(), id, version })
  })

  // 本机产物卡正文（Task 8）：只有本机来源标记在案的包（非纯导入）才允许读出正文展示，审计红线见 pack-local-content.ts 文件头。
  ipcMain.handle('packs:local-content', async (_event, input: unknown): Promise<LocalPackContent | null> => {
    const { id, version } = readPackIdVersionInput(input, '读取本机包正文参数非法。')
    return readLocalPackContent({ userDataPath: userDataPath(), id, version })
  })

  // 造包中心「从书学写法」（刀4）：本地书选择 / 预估 / 学习编排三个请求通道 + 一个事件推送通道。
  // 生产依赖组装见 getPackLearner（惰性单例照 getPackCompiler 先例）。
  ipcMain.handle('packs:learn-pick-book', async (event): Promise<{ filePath: string; title: string } | null> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      title: '选择要学习的书',
      buttonLabel: '选择',
      filters: [{ name: '电子书', extensions: ['txt', 'epub', 'pdf'] }],
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const filePath = result.filePaths[0]
    if (result.canceled || !filePath) return null
    return { filePath, title: basename(filePath).replace(/\.(txt|epub|pdf)$/i, '') }
  })

  ipcMain.handle('packs:learn-estimate', async (_event, input: unknown): Promise<PackLearnEstimate> => {
    const { source, tier } = readLearnStartInput(input)
    try {
      const chapters =
        source.kind === 'novel'
          ? await loadNovelChapters(source.projectPath, source.title)
          : await loadExternalBook(source.filePath)
      const estimate = estimateLearnRun(chapters, tier)
      return { status: 'ok', ...estimate }
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : '读不出这本书的正文。' }
    }
  })

  ipcMain.handle('packs:learn-start', async (event, input: unknown): Promise<PackLearnResult> => {
    const { source, tier } = readLearnStartInput(input)
    const learner = getPackLearner()
    // T11 评审 F3：sender 绑定放在真正开跑的路径上，不在 busy 拒绝路径上抢注——已有一本书在学时，
    // 这次调用不该把 emit 目标从「正在跑的那个窗口」改成「这次被拒绝的窗口」，否则真正在跑的会话
    // 事件会推错窗口。窄竞态可接受：isBusy() 到 startLearning() 之间理论上有极小窗口可能被并发
    // 调用抢跑，但学习编排本就是单窗口场景的现实使用形态，不值得为此再加一层锁。
    if (learner.isBusy()) return { status: 'error', message: '已有一本书在学，请先等它完成。' }
    _packLearnEmitSender = event.sender
    return learner.startLearning({ source, tier })
  })

  ipcMain.handle('packs:learn-cancel', async (): Promise<{ ok: true }> => {
    getPackLearner().cancel()
    return { ok: true }
  })

  // 造包中心「作家向导」（刀5）：start/send/cancel 三个请求通道 + 一个事件推送通道（packs:wizard-event）。
  // 会话执行与单例装配见 runWizardTurn / packWizardProvider（wizard-session.ts）。
  ipcMain.handle('packs:wizard-start', async (event): Promise<PackWizardAck> => {
    // 终态实例在这里重建（「再来一次」语义）；进行中实例原样返回、被下方 busy 拒绝
    const wizard = packWizardProvider.obtainForStart()
    // 刀4 T11 评审 F3 同款：sender 绑定放在 busy 判定之后，拒绝路径不抢改在跑会话的事件推送目标。
    // busy 拒绝在渲染端不是死路：store 收到 ok:false 会转身取快照恢复现场（提示不如恢复）。
    if (wizard.isBusy()) return { ok: false, message: '上一场访谈还没结束。' }
    _packWizardEmitSender = event.sender
    return wizard.start()
  })

  ipcMain.handle('packs:wizard-send', async (_event, input: unknown): Promise<PackWizardAck> => {
    return packWizardProvider.get().send(readWizardSendInput(input))
  })

  ipcMain.handle('packs:wizard-cancel', async (): Promise<{ ok: true }> => {
    await packWizardProvider.get().cancel()
    return { ok: true }
  })

  // 会话可恢复两通道：snapshot 供进向导时水合现场（无会话 null，只读无副作用）；dismiss 是
  // 「再来一次」的清场（仅终态受理，防重载后旧终态复活）。事件推送目标跟随快照消费方：能取到
  // 非空快照的窗口就是接下来要续看事件流的窗口（重载后 sender 已换新 webContents，不重绑会把
  // 恢复出的会话推给死掉的旧 sender）。
  // ⚠️ 单窗口假设：任何取到非空快照的调用方都会抢走活会话的事件流——今天结构性安全（全 App 仅
  // 一个 BrowserWindow；渲染端只有 WizardView 挂载水合与 busy 兜底两处调 snapshot，且 store 已
  // 持会话时挂载水合早退不发 invoke）。未来开多窗口时，窗口 B 打开造包中心即抢走窗口 A 的推流，
  // 届时须改按 wizard 实例归属绑定推送目标，不能再用「谁取快照给谁」。
  ipcMain.handle('packs:wizard-snapshot', async (event): Promise<PackWizardSnapshot | null> => {
    const snapshot = packWizardProvider.getSnapshot()
    if (snapshot) _packWizardEmitSender = event.sender
    return snapshot
  })

  ipcMain.handle('packs:wizard-dismiss', async (): Promise<PackWizardAck> => {
    return packWizardProvider.dismiss()
  })
}
