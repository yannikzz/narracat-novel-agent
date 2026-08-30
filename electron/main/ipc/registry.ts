/**
 * IPC 路由总入口（Task 10，按域拆分原 ipc.ts 上帝文件）。
 *
 * 全部 116 个 handler 已按域分布在本目录下的 app/novel/agent/packs/skills/chat 六个域文件；
 * 原 electron/main/ipc.ts 已删除，本文件是唯一入口。
 *
 * reconcileAgentRuntimeStartup / settleAgentRuntimeBeforeQuit / hasActiveAgentRuntimeRuns 供
 * index.ts 消费，规范来源在 './agent.ts'。
 */
import { registerAppIpcHandlers } from './app.ts'
import { registerNovelIpcHandlers } from './novel.ts'
import {
  registerAgentIpcHandlers,
  reconcileAgentRuntimeStartup,
  settleAgentRuntimeBeforeQuit,
  hasActiveAgentRuntimeRuns,
} from './agent.ts'
import { registerPacksIpcHandlers } from './packs.ts'
import { registerSkillsIpcHandlers } from './skills.ts'
import { registerChatIpcHandlers } from './chat.ts'
import { withIpcModuleTap } from './telemetry-tap.ts'

export { reconcileAgentRuntimeStartup, settleAgentRuntimeBeforeQuit, hasActiveAgentRuntimeRuns }

export function registerAllIpcHandlers(): void {
  // 装配期挂埋点壳（ADR-0039）：所有 handler 在这一处统一获得模块归属记账，
  // 域文件本身不含任何埋点代码。壳只在注册窗口内生效，见 telemetry-tap.ts。
  withIpcModuleTap(() => {
    registerAppIpcHandlers()
    registerNovelIpcHandlers()
    registerAgentIpcHandlers()
    registerPacksIpcHandlers()
    registerSkillsIpcHandlers()
    registerChatIpcHandlers()
  })
}
