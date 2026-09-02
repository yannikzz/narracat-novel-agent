import { app, BrowserWindow } from 'electron'
import { getConfigPath, readAppConfig } from '../config.ts'
import {
  polishRecipeStorePath,
  readPolishRecipes,
  recordPolishRunSlots,
} from '../engine/polish-recipe-store.ts'
import { collectManuscriptEntityNames } from '../novel/manuscript-entities.ts'
import { readVisibleManuscriptText } from '../novel/manuscript-file.ts'
import { openMemoryDbReadonly } from '../novel/memory-db.ts'
import { getApiKey } from '../secrets.ts'
import { createPolishRunManager, type PolishRunEventSink, type PolishRunManager } from './polish-runner.ts'
import type { PolishRunEvent, PolishSlotId } from '@shared/types/prose-polish'

/**
 * 润色域的运行时装配（ADR-0036 分层纪律）。
 *
 * 放在 `polish/` 而不是 `ipc/polish.ts`：常驻润色由 `ipc/agent.ts` 触发，若工厂留在 IPC 域
 * 文件里就会出现 `ipc/agent.ts` → `ipc/polish.ts` 的同层反向消费；IPC 是薄路由，不承担领域组合。
 * 依赖只向下取（config / secrets / novel / engine），不 import 任何 ipc 域文件。
 */

function recipeStorePath(): string {
  return polishRecipeStorePath(app.getPath('userData'))
}

function baseDeps(sendEvent: PolishRunEventSink, recordRuns: boolean) {
  return {
    readConfig: () => readAppConfig(getConfigPath(app.getPath('userData'))),
    getApiKey,
    sendEvent,
    readRecipes: () => readPolishRecipes(recipeStorePath()),
    recordRunSlots: recordRuns
      ? (slotIds: PolishSlotId[]) => recordPolishRunSlots({ storePath: recipeStorePath(), slotIds })
      : async () => undefined,
    readOriginalText: readVisibleManuscriptText,
    collectAnchorNames: (projectPath: string) =>
      collectManuscriptEntityNames({ projectPath, openMemoryDb: openMemoryDbReadonly }),
  }
}

/** 试验模式：事件只发回发起的那个窗口。 */
export function createWindowPolishRunManager(sender: Electron.WebContents): PolishRunManager {
  return createPolishRunManager(baseDeps((event) => sender.send('polish:event', event), true))
}

/**
 * 常驻模式：没有观众，事件无处可发。
 * `recordRunSlots` 也换成空实现——自动跑不该改掉作者下次发起时的默认勾选。
 */
export function createHeadlessPolishRunManager(): PolishRunManager {
  return createPolishRunManager(baseDeps(() => {}, false))
}

/**
 * 广播到所有窗口。
 *
 * 常驻润色跑在后台、不属于任何一次 IPC 调用，收尾时必须主动通知渲染端——否则正文页会一直
 * 显示原稿、也看不到「已润色 / 已跳过」横幅，直到作者因为别的原因刷新为止。
 */
export function broadcastPolishEvent(event: PolishRunEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('polish:event', event)
  }
}
