import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { canSetPrimaryModel, modelEntryKey, resolvePrimaryModel } from '@shared/lib/model-slots'
import {
  clearProviderApiKeyMetadata,
  findUnsafeApiKeyCharacter,
  hasConfiguredApiKey,
  markProviderApiKeyUpdated,
  markProviderVerified,
  normalizeAppConfig,
  PROVIDER_IDS,
  type AppConfig,
  type ProviderId,
  UNSAFE_API_KEY_MESSAGE,
  writeAppConfig,
} from '../config.ts'
import { deleteApiKey, getApiKey, hasApiKey, setApiKey } from '../secrets.ts'
import { testProviderConnection, type ConnectionTestResult } from '../provider-test.ts'
import { fetchProviderModels } from '../provider-models.ts'
import type { ProviderModelListResult } from '@shared/types/ipc'
import type { ProcessHealthReport } from '@shared/types/process-health'
import type { ProcessHealthStore } from '../process-health.ts'
import {
  listResultNotifications,
  markAllResultNotificationsRead,
  markResultNotificationRead,
  normalizeResultNotification,
  upsertResultNotification,
} from '../notifications.ts'
import { writeFile } from 'node:fs/promises'
import type { TelemetryState } from '@shared/types/telemetry'
import {
  acknowledgeTelemetryNotice,
  getTelemetryState,
  resetTelemetryAnonymousId,
  setTelemetryEnabled,
  telemetryQueuePath,
} from '../telemetry/telemetry-runtime.ts'
import { evaluateReleaseGuard } from '../release-guard-runtime.ts'
import type { ReleaseGateVerdict } from '../release-guard.ts'
import {
  checkForUpdatesNow,
  getUpdaterState,
  installUpdateNow,
  subscribeUpdaterSender,
} from '../updater/updater-runtime.ts'
import type { UpdaterState } from '@shared/types/updater'
import { resolveNarraCatAgentCorePath } from '../engine/engine.ts'
import { readNarraCatAgentCoreDiagnostics } from '../engine/agent-core-contract.ts'
import { runEmbeddingHealthProbe } from '../engine/embedding-probe.ts'
import { runCorpusHealthProbe } from '../engine/corpus-probe.ts'
import {
  navigationStatePath,
  readStoredWorkLocation,
  writeStoredWorkLocation,
} from '../navigation-state.ts'
import { parseStoredWorkLocation } from '@shared/lib/work-location-schema'
import type { ResultNotificationList } from '@shared/types/notifications'
import type { StoredWorkLocation } from '@shared/lib/work-location-schema'
import { invalidateAgentSessions } from './agent.ts'
// 跨域共用基础设施叶子模块（评审修复：消除 app.ts ↔ agent.ts 模块级循环 import）。
import {
  broadcastResultNotifications,
  configPath,
  readCurrentConfig,
  resultNotificationsPath,
  showNativeResultNotificationIfNeeded,
} from './inputs.ts'

export interface AppConfigPayload {
  config: AppConfig
  hasApiKey: boolean
}

export function workLocationPath(): string {
  return navigationStatePath(app.getPath('userData'))
}

export function currentAgentCorePath(): string {
  return resolveNarraCatAgentCorePath({
    appRoot: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

export function configPayload(config: AppConfig): AppConfigPayload {
  const primary = resolvePrimaryModel(config)
  return {
    config,
    // 「已配置 Key」据 config 元数据判断，绝不在此读钥匙串——config:get 在启动（useIntroGate）
    // 与进设置页时都会被调用，读钥匙串会触发 macOS 授权弹窗。真正读 Key 只在「测试连接」/ 跑创作时。
    hasApiKey: primary ? hasConfiguredApiKey(config, primary.provider) : false,
  }
}

/**
 * 会话作废基准：providers 端点 + 双槽位 + Key 代际。池增删与验证状态变化本身不落进这份基准；
 * 例外：轻量槽条目验证状态翻转会经另一套会话兼容性指纹（agent/runs/session-fingerprint.ts）
 * 触发断线——resolveLightModel 是 fail-soft 解析（未验证回落主力、验证后启用轻量槽），指纹里
 * 的 lightModel 字段跟着这次解析结果变化而变，由 divider 兜底，非 bug。
 */
function sessionConfigBasis(config: AppConfig): string {
  return JSON.stringify({
    providers: config.providers,
    primaryModelKey: config.primaryModelKey,
    lightModelKey: config.lightModelKey,
    apiKeyMetadata: config.apiKeyMetadata,
  })
}

/**
 * 进程健康取证 store（#39）。由 index.ts 在 app ready 后注入——handler 注册早于 store 创建，
 * 未注入时诊断页拿到空记录而不是报错（取证缺失不该让设置页打不开）。
 */
let processHealthStore: ProcessHealthStore | null = null

export function setProcessHealthStore(store: ProcessHealthStore): void {
  processHealthStore = store
}

export function registerAppIpcHandlers(): void {
  // 测试端点：渲染端调用 window.electron.ping() 应该拿到 'pong-{timestamp}'
  ipcMain.handle('ping', () => {
    return `pong-${Date.now()}`
  })

  // Windows 标题栏 overlay 符号颜色跟随主题（浅色 UI 用深符号，深色 UI 用白符号）。
  // 仅 win32 有效：mac 红绿灯由系统绘制、Linux 无 overlay，调用会抛错故先判平台。
  ipcMain.handle('window:set-titlebar-overlay-symbol-color', (_event, symbolColor: unknown) => {
    if (process.platform !== 'win32' || typeof symbolColor !== 'string') return
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.setTitleBarOverlay({ symbolColor })
      } catch {
        // 窗口销毁竞态等边缘情况静默忽略，不影响主流程。
      }
    }
  })

  // 进程健康记录（#39）：设置-关于的诊断折叠读它，作者截图即可求助。
  ipcMain.handle('app:get-process-health', async (): Promise<ProcessHealthReport> => {
    if (!processHealthStore) return { events: [], logPath: '' }
    return processHealthStore.read()
  })

  // 内测软过期 + 远程急刹车（#354）：渲染端启动时查一次，命中则显示拦截页。
  ipcMain.handle('release-guard:check', async (): Promise<ReleaseGateVerdict> => {
    return evaluateReleaseGuard()
  })

  // ── 匿名使用统计（ADR-0039）────────────────────────────────────────
  ipcMain.handle('telemetry:get-state', (): Promise<TelemetryState> => getTelemetryState())

  ipcMain.handle('telemetry:set-enabled', (_event, enabled: unknown): Promise<TelemetryState> => {
    return setTelemetryEnabled(enabled === true)
  })

  ipcMain.handle('telemetry:ack-notice', (): Promise<TelemetryState> => acknowledgeTelemetryNotice())

  ipcMain.handle('telemetry:reset-id', (): Promise<TelemetryState> => resetTelemetryAnonymousId())

  // 「已发送内容明文可查」的兑现处：把待发队列文件在文件管理器里点出来。
  // 队列为空时文件可能还不存在，先建一个空的，避免点了没反应。
  ipcMain.handle('telemetry:reveal-queue', async (): Promise<void> => {
    const path = telemetryQueuePath()
    await writeFile(path, '[]\n', { flag: 'wx' }).catch(() => {})
    shell.showItemInFolder(path)
  })

  ipcMain.handle('updater:get-state', (event): UpdaterState => {
    // 拿状态的同时订阅：渲染端一挂载就能收到后续推送，不必另开一个订阅频道。
    subscribeUpdaterSender(event.sender)
    return getUpdaterState()
  })

  ipcMain.handle('updater:check', async (event): Promise<void> => {
    subscribeUpdaterSender(event.sender)
    await checkForUpdatesNow(true)
  })

  ipcMain.handle('updater:install', async (event): Promise<void> => {
    subscribeUpdaterSender(event.sender)
    await installUpdateNow()
  })

  ipcMain.handle('config:get', async (): Promise<AppConfigPayload> => {
    return configPayload(await readCurrentConfig())
  })

  ipcMain.handle('config:save', async (_event, input: unknown): Promise<AppConfigPayload> => {
    const previous = await readCurrentConfig()
    const saved = await writeAppConfig(configPath(), normalizeAppConfig(input))
    if (sessionConfigBasis(previous) !== sessionConfigBasis(saved)) {
      await invalidateAgentSessions('model-service-changed')
    }
    return configPayload(saved)
  })

  ipcMain.handle('config:set-primary-model', async (_event, input: unknown): Promise<AppConfigPayload> => {
    const key = typeof input === 'string' ? input.trim() : ''
    const previous = await readCurrentConfig()
    if (!key || !canSetPrimaryModel(previous, key)) {
      throw new Error('该模型不可用或未验证，请先到设置页测试连接。')
    }
    const saved = await writeAppConfig(configPath(), { ...previous, primaryModelKey: key })
    if (sessionConfigBasis(previous) !== sessionConfigBasis(saved)) {
      await invalidateAgentSessions('model-service-changed')
    }
    return configPayload(saved)
  })

  ipcMain.handle('secret:set-api-key', async (_event, input: unknown): Promise<{ hasApiKey: boolean }> => {
    if (!input || typeof input !== 'object') throw new Error('API Key 参数非法。')
    const { provider, apiKey } = input as Record<string, unknown>
    if (!isProviderId(provider) || typeof apiKey !== 'string') throw new Error('API Key 参数非法。')
    await setApiKey(provider, apiKey)
    const config = await readCurrentConfig()
    await writeAppConfig(configPath(), markProviderApiKeyUpdated(config, provider, new Date().toISOString()))
    await invalidateAgentSessions('api-key-changed')
    // 刚写入成功，结果确定为 true——无需再读钥匙串（避免在写后又触发一次系统授权）。
    return { hasApiKey: true }
  })

  ipcMain.handle('secret:delete-api-key', async (_event, provider: unknown): Promise<{ hasApiKey: boolean }> => {
    if (!isProviderId(provider)) throw new Error('Provider 参数非法。')
    await deleteApiKey(provider)
    const config = await readCurrentConfig()
    await writeAppConfig(configPath(), clearProviderApiKeyMetadata(config, provider))
    await invalidateAgentSessions('api-key-changed')
    // 刚删除成功，结果确定为 false——无需再读钥匙串。
    return { hasApiKey: false }
  })

  ipcMain.handle('secret:has-api-key', async (_event, provider: unknown): Promise<{ hasApiKey: boolean }> => {
    if (!isProviderId(provider)) throw new Error('Provider 参数非法。')
    return { hasApiKey: await hasApiKey(provider) }
  })

  ipcMain.handle('provider:test-connection', async (_event, input: unknown): Promise<ConnectionTestResult> => {
    if (!isProviderId(input)) return { ok: false, message: 'Provider 参数非法。' }
    let config = await readCurrentConfig()
    const entries = config.modelPool.filter((entry) => entry.provider === input)
    if (entries.length === 0) return { ok: false, message: '请先启用至少一个模型再测试。' }
    const apiKey = await getApiKey(input)
    if (!apiKey) return { ok: false, message: '请先保存该服务商的 API Key。' }
    if (findUnsafeApiKeyCharacter(apiKey)) return { ok: false, message: UNSAFE_API_KEY_MESSAGE }
    if (!config.apiKeyMetadata[input]?.updatedAt) {
      config = await writeAppConfig(configPath(), markProviderApiKeyUpdated(config, input, new Date().toISOString()))
      await invalidateAgentSessions('api-key-changed')
    }

    const result = await testProviderConnection(config, apiKey, modelEntryKey(entries[0]!), {
      appRoot: app.getAppPath(),
      cwd: app.getPath('userData'),
      resourcesPath: process.resourcesPath,
    })
    if (!result.ok) return result

    const verifiedAt = new Date().toISOString()
    await writeAppConfig(configPath(), markProviderVerified(config, input, verifiedAt))
    return { ...result, verifiedAt }
  })

  ipcMain.handle('provider:list-models', async (_event, input: unknown): Promise<ProviderModelListResult> => {
    if (!isProviderId(input)) return { ok: false, message: 'Provider 参数非法。' }
    const config = await readCurrentConfig()
    const apiKey = await getApiKey(input)
    if (!apiKey) return { ok: false, message: '请先保存该服务商的 API Key。' }
    if (findUnsafeApiKeyCharacter(apiKey)) return { ok: false, message: UNSAFE_API_KEY_MESSAGE }
    return fetchProviderModels({ baseUrl: config.providers[input].baseUrl, wire: config.providers[input].wire, apiKey })
  })

  ipcMain.handle('narracat:diagnostics', async () => {
    return readNarraCatAgentCoreDiagnostics(currentAgentCorePath())
  })

  ipcMain.handle('embedding:health-probe', async () => {
    return runEmbeddingHealthProbe({
      appRoot: app.getAppPath(),
      userDataPath: app.getPath('userData'),
      resourcesPath: process.resourcesPath,
    })
  })

  ipcMain.handle('corpus:health-probe', async () => runCorpusHealthProbe())

  ipcMain.handle('notifications:list', async (): Promise<ResultNotificationList> => {
    return listResultNotifications(resultNotificationsPath())
  })

  ipcMain.handle('notifications:upsert-result', async (_event, input: unknown): Promise<ResultNotificationList> => {
    const notification = normalizeResultNotification(input)
    if (!notification) throw new Error('通知参数非法。')

    const payload = await upsertResultNotification(resultNotificationsPath(), notification)
    broadcastResultNotifications(payload)
    void showNativeResultNotificationIfNeeded(notification)
    return payload
  })

  ipcMain.handle('notifications:mark-read', async (_event, id: unknown): Promise<ResultNotificationList> => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('通知 ID 参数非法。')
    const payload = await markResultNotificationRead(resultNotificationsPath(), id)
    broadcastResultNotifications(payload)
    return payload
  })

  ipcMain.handle('notifications:mark-all-read', async (): Promise<ResultNotificationList> => {
    const payload = await markAllResultNotificationsRead(resultNotificationsPath())
    broadcastResultNotifications(payload)
    return payload
  })

  ipcMain.handle('navigation:read-work-location', async (): Promise<StoredWorkLocation> => {
    return readStoredWorkLocation(workLocationPath())
  })

  ipcMain.handle('navigation:write-work-location', async (_event, input: unknown): Promise<void> => {
    const location = parseStoredWorkLocation(JSON.stringify(input) ?? null)
    await writeStoredWorkLocation(workLocationPath(), location)
  })

  ipcMain.handle('dialog:select-directory', async (event): Promise<string | null> => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择小说根目录',
      buttonLabel: '选择',
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)

    if (result.canceled) return null
    return result.filePaths[0] ?? null
  })
}
