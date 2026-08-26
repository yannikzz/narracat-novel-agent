import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * preload 登记守卫（#38）。
 *
 * 渲染端调用 `window.electron?.xxx?.()` 时，preload 漏登记不会报错——可选链让它
 * **什么都不发生且完全静默**，typecheck 也拦不住（类型声明在 ipc.d.ts 里是齐的）。
 * 新增 IPC 必须三处同时到位：main handler / preload / 类型声明。
 */
describe('preload IPC registration', () => {
  const preload = readFileSync(fileURLToPath(new URL('./index.cts', import.meta.url)), 'utf-8')
  const mainHandlers = readFileSync(
    fileURLToPath(new URL('../main/ipc/novel.ts', import.meta.url)),
    'utf-8',
  )

  test('exposes revealProjectFolder and backs it with a main-process handler', () => {
    expect(preload).toContain('revealProjectFolder')
    expect(preload).toContain("'novel:reveal-folder'")
    expect(mainHandlers).toContain("ipcMain.handle('novel:reveal-folder'")
  })
})
