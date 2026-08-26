import { stripIpcErrorPrefix } from '@shared/lib/ipc-error'
import { create } from 'zustand'
import { readNovelStatus, refreshNovelStatus } from '@/lib/ipc'
import type { NovelStatusSnapshot } from '@shared/types/novel'

/**
 * 工作台状态面板的四态生命周期：
 * - empty：项目从未生成过快照（首版引导态）
 * - loaded：展示上次/最新成功快照（完成态）
 * - refreshing：聚合进行中（复用「生成中」视觉）
 * - failed：聚合失败（展示失败态 + 重试，且不抹掉上一次成功快照）
 * idle 仅在尚未读盘前的过渡态。
 */
export type WorkbenchStatusPhase = 'idle' | 'empty' | 'loaded' | 'refreshing' | 'failed'

interface WorkbenchStatusStore {
  projectPath: string | null
  phase: WorkbenchStatusPhase
  snapshot: NovelStatusSnapshot | null
  error: string | null
  /** 单调递增的请求序号：每次 hydrate/refresh 发起即自增，异步返回时只认最新序号、丢弃陈旧回写 */
  requestSeq: number
  setProjectPath: (projectPath: string | null) => void
  hydrate: (projectPath: string) => Promise<void>
  refresh: (projectPath: string) => Promise<void>
  enter: (projectPath: string) => Promise<void>
  reset: () => void
}

function errorMessage(error: unknown): string {
  // 剥掉 Electron IPC 外壳再交给 UI：作者看到的就是这个字符串（#38）。
  return stripIpcErrorPrefix(error instanceof Error ? error.message : String(error))
}

const initialState = {
  projectPath: null as string | null,
  phase: 'idle' as WorkbenchStatusPhase,
  snapshot: null as NovelStatusSnapshot | null,
  error: null as string | null,
}

export const useWorkbenchStatusStore = create<WorkbenchStatusStore>((set, get) => ({
  ...initialState,
  // requestSeq 不在 initialState：reset / 切项目不重置，保证全局单调，跨项目切换也能判定陈旧。
  requestSeq: 0,
  setProjectPath: (projectPath) => {
    if (get().projectPath === projectPath) return
    // 切项目：清掉旧快照，回到 idle 等待 hydrate。
    set({ ...initialState, projectPath })
  },
  hydrate: async (projectPath) => {
    const seq = get().requestSeq + 1
    set({ requestSeq: seq, projectPath, error: null })

    try {
      const snapshot = await readNovelStatus(projectPath)
      // 仅当本次仍是最新请求才回写；更新的 hydrate/refresh 已发起则丢弃陈旧结果（含同项目乱序与切项目）。
      if (get().requestSeq !== seq) return
      set(snapshot ? { phase: 'loaded', snapshot } : { phase: 'empty', snapshot: null })
    } catch (error) {
      if (get().requestSeq !== seq) return
      set({ phase: 'failed', error: errorMessage(error) })
    }
  },
  refresh: async (projectPath) => {
    // 进行中不可重复触发（去抖）。
    if (get().phase === 'refreshing') return
    const seq = get().requestSeq + 1
    set({ requestSeq: seq, projectPath, phase: 'refreshing', error: null })

    try {
      const snapshot = await refreshNovelStatus(projectPath)
      if (get().requestSeq !== seq) return
      set({ phase: 'loaded', snapshot, error: null })
    } catch (error) {
      if (get().requestSeq !== seq) return
      // 失败不抹掉上一次成功的快照展示。
      set({ phase: 'failed', error: errorMessage(error) })
    }
  },
  // 进入 status 面板的 SWR 入口（ADR-0022）：先秒显落盘快照，再后台无条件重算一次原地替换。
  // 每次进入面板都调一次（面板切走即卸载、切回即重新挂载触发），让用户每次看到的都是最新状态。
  enter: async (projectPath) => {
    // 首次进入或切换项目：先 hydrate 秒显落盘快照，避免空屏/闪烁；同项目复入则沿用已展示的快照。
    const sameProject = get().projectPath === projectPath && get().phase !== 'idle'
    if (!sameProject) {
      await get().hydrate(projectPath)
    }
    if (get().projectPath !== projectPath) return
    // 无条件后台重算：包括从未生成快照的新项目（首进即自动生成，无须手点）；
    // 无快照态由 View 在 refreshing 时仍显示空态引导（按钮禁用 + 转圈），不会空屏。
    await get().refresh(projectPath)
  },
  reset: () => set({ ...initialState }),
}))
