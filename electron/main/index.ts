import { app, BrowserWindow, dialog } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createMainWindow } from './window.ts'
import {
  hasActiveAgentRuntimeRuns,
  reconcileAgentRuntimeStartup,
  registerAllIpcHandlers,
  settleAgentRuntimeBeforeQuit,
} from './ipc/registry.ts'
import { disposeAllPendingCapabilityPackImportsSync } from './packs/pack-store.ts'
import { createAgentQuitController } from './agent/runs/agent-quit-controller.ts'
import { resolveNarraCatAgentCorePath } from './engine/engine.ts'
import { maybeRunMemorySmoke } from './memory/memory-smoke.ts'
import { startUpdater } from './updater/updater-runtime.ts'
import { settleTelemetryBeforeQuit, startTelemetry } from './telemetry/telemetry-runtime.ts'
import {
  attachAppProcessHealthWatcher,
  attachWindowProcessHealthWatchers,
  createProcessHealthStore,
  type ProcessHealthStore,
} from './process-health.ts'
import { setProcessHealthStore } from './ipc/app.ts'

/**
 * 进程健康取证（#39）的 store。窗口创建早于 app.whenReady 完成的场景不存在，
 * 但 restoreMainWindow / activate 在模块顶层定义，故用懒初始化而不是模块常量。
 */
let processHealthStore: ProcessHealthStore | null = null

function ensureProcessHealthStore(): ProcessHealthStore {
  processHealthStore ??= createProcessHealthStore({
    userDataPath: app.getPath('userData'),
    appVersion: app.getVersion(),
  })
  return processHealthStore
}

/**
 * 唯一的建窗口入口：createMainWindow 之外还要挂进程健康监听。
 * 三处建窗口的地方（首启 / activate / restoreMainWindow）都必须走这里，
 * 否则那个窗口的崩溃与挂死就是静默的——正是 #39 要消灭的状态。
 */
function spawnMainWindow(): BrowserWindow {
  const win = createMainWindow()
  attachWindowProcessHealthWatchers(win, {
    store: ensureProcessHealthStore(),
    promptReload: async (message, detail) => {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'NarraCat 界面需要重新加载',
        message,
        detail,
        buttons: ['重新加载', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      return response === 0
    },
  })
  return win
}

async function main() {
  await app.whenReady()

  const appRoot = app.getAppPath()
  const resourcesPath = process.resourcesPath
  const userDataPath = app.getPath('userData')
  const agentCorePath = resolveNarraCatAgentCorePath({ appRoot, resourcesPath })
  if (await maybeRunMemorySmoke({ appRoot, resourcesPath, userDataPath, agentCorePath })) return

  registerAllIpcHandlers()
  // 子进程崩溃是进程级事件（GPU / utility，NovelMemory 就跑在 utilityProcess 上），
  // 只挂一次；挂在窗口上会随窗口数量重复记录同一次崩溃。
  const healthStore = ensureProcessHealthStore()
  setProcessHealthStore(healthStore)
  attachAppProcessHealthWatcher({
    store: healthStore,
    onChildGone: (listener) => app.on('child-process-gone', listener),
  })
  app.on('activate', () => {
    // macOS：关闭所有窗口后点 dock 重新打开
    if (BrowserWindow.getAllWindows().length === 0) spawnMainWindow()
  })
  // 必须排在 createMainWindow() 之前：拦截页（版本过旧强更）在门控判定一回来就渲染，
  // 用户可能立刻点「立即更新并重启」；若 startUpdater() 排在 reconcileAgentRuntimeStartup()
  // 之后（该步骤耗时不定），installUpdateNow() 会因 started === false 直接 return、零反馈——
  // 用户点了按钮却什么都没发生。startUpdater() 本身只做同步的状态机初始化 + 30s 后才真正
  // 发起首次检查，提前调用没有副作用代价。
  startUpdater()
  // 匿名使用统计（ADR-0039）：补发上次没发出去的，并记一条启动。内部自带告知闸门——
  // 用户没确认过告知屏、或关了开关，这里什么都不会发生，也不会抛。
  void startTelemetry()
  await reconcileAgentRuntimeStartup()
  if (BrowserWindow.getAllWindows().length === 0) spawnMainWindow()
}

app.on('window-all-closed', () => {
  // macOS 习惯：所有窗口关闭不退出 app；其他平台退出
  if (process.platform !== 'darwin') app.quit()
})

function restoreMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0] ?? spawnMainWindow()
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

const agentQuitController = createAgentQuitController({
  hasActiveRuns: hasActiveAgentRuntimeRuns,
  confirmInterrupt: async () => {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Agent 任务仍在运行',
      message: '退出会中断正在运行的 Agent 任务。',
      detail: '你可以返回 App 等待，或请求停止任务并退出。已写入的小说产物会保留。',
      buttons: ['返回并等待', '退出并中断'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    return response === 1
  },
  restoreWindow: restoreMainWindow,
  interruptAll: settleAgentRuntimeBeforeQuit,
  quit: () => app.quit(),
})

app.on('before-quit', (event) => {
  agentQuitController.handleBeforeQuit(event)
})

app.on('will-quit', () => {
  disposeAllPendingCapabilityPackImportsSync()
  // 退出前把内存里没发出去的落盘/发出去。will-quit 不等异步，故这里只是尽力而为：
  // 真正的兜底是落盘队列，下次启动补发（ADR-0039 决定七）。
  void settleTelemetryBeforeQuit()
})

main().catch((err) => {
  // app.exit() 立即终止、不 flush stdio，console 输出会丢失，导致打包态启动失败"图标闪一下就没"、
  // 无任何可诊断信息。故先把错误持久化到 userData（可回传排查）并弹可见错误框，再退出。
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error('Main process startup failed:', detail)
  try {
    writeFileSync(join(app.getPath('userData'), 'startup-error.log'), `${detail}\n`)
  } catch {}
  try {
    dialog.showErrorBox('NarraCat 启动失败', detail)
  } catch {}
  app.exit(1)
})
