/**
 * 埋点接入点（ADR-0039）：在 IPC 装配期给所有 handler 挂一层薄壳，
 * 按 IPC_CHANNEL_MODULES 记下"哪个模块今天被用过"。
 *
 * 为什么挂在装配期而不是在 130 个业务点各写一行：
 *   - 埋点与业务代码零耦合，改功能不必记得同步改埋点；
 *   - 归属表是唯一判断处，新通道漏判会被 ipc-modules.test.ts 挡下，不会静默漏采；
 *   - 反过来说，代价是这里短暂替换了 ipcMain.handle。替换只覆盖同步的注册窗口，
 *     finally 里原样还回去，注册之后的 ipcMain 与没打过补丁时完全一致。
 *
 * 包壳逻辑本身在 telemetry/ipc-tap.ts（纯函数、有单测）；这里只负责接线。
 */
import { ipcMain } from 'electron'
import { createTappedHandle } from '../telemetry/ipc-tap.ts'
import { resolveModuleForChannel } from '../telemetry/ipc-modules.ts'
import { recordFeatureUsed } from '../telemetry/telemetry-runtime.ts'
import type { TelemetryModule } from '@shared/types/telemetry'

type IpcHandle = typeof ipcMain.handle
type IpcHandleListener = Parameters<IpcHandle>[1]

/**
 * 在 register() 执行期间接管 ipcMain.handle。register 必须是同步注册
 * （本仓六个域文件都是），异步注册不在覆盖范围内。
 */
export function withIpcModuleTap<T>(register: () => T): T {
  const original = ipcMain.handle
  const tapped = createTappedHandle<IpcHandleListener>({
    handle: (channel, listener) => original.call(ipcMain, channel, listener),
    resolveModule: resolveModuleForChannel,
    record: (module) => recordFeatureUsed(module as TelemetryModule),
  })

  ipcMain.handle = ((channel: string, listener: IpcHandleListener) => {
    tapped(channel, listener)
  }) as IpcHandle
  try {
    return register()
  } finally {
    ipcMain.handle = original
  }
}
