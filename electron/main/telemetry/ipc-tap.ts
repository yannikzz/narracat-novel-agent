/**
 * IPC 埋点壳的纯逻辑（ADR-0039）。不 import electron——副作用（真正替换 ipcMain.handle）
 * 在 ipc/telemetry-tap.ts，本文件可直接单测。
 *
 * 这一层包住了**每一个** IPC handler，出错就是整个 App 不可用，所以它的行为必须被钉住：
 * 参数原样透传、返回值原样透传、抛错原样抛、记账失败不影响业务。
 */

/** 与 Electron 的 handle 同形，但不依赖它的类型。 */
export type HandleFn<L> = (channel: string, listener: L) => unknown

export interface IpcTapDeps<L extends (...args: never[]) => unknown> {
  /** 原始的注册函数。 */
  handle: HandleFn<L>
  /** 通道 → 模块；返回 null 表示不计入，此时不包壳、原样注册。 */
  resolveModule: (channel: string) => string | null
  /** 记一次模块使用。抛错会被吞掉——埋点不许影响业务。 */
  record: (module: string) => void
}

/**
 * 造一个"注册时顺手包壳"的 handle。有模块归属的通道才包，其余原样透传，
 * 让绝大多数通道的调用路径与没有埋点时逐字相同。
 */
export function createTappedHandle<L extends (...args: never[]) => unknown>(
  deps: IpcTapDeps<L>,
): HandleFn<L> {
  return (channel, listener) => {
    const module = deps.resolveModule(channel)
    if (module === null) return deps.handle(channel, listener)
    const wrapped = ((...args: Parameters<L>) => {
      try {
        deps.record(module)
      } catch {
        // 记账失败绝不能连累业务 handler。
      }
      return listener(...args)
    }) as L
    return deps.handle(channel, wrapped)
  }
}
