import { create } from 'zustand'

/**
 * 正文编辑器整体替换的动作出口：titlebar 上「保存/取消/同步本章记忆」点击后，
 * 实际执行体在 ChapterManuscriptView 内部（拥有 draft/baseText 等本地状态），
 * 经这里把回调注册给外层 WorkbenchStage 分派（避免逐层 prop-drilling）。
 */
export interface ManuscriptEditorHandlers {
  startEdit?: () => void
  save?: () => void
  cancel?: () => void
  syncMemory?: () => void
  openHistory?: () => void
  openPolish?: () => void
  keepDraftBeforeLeave?: () => Promise<boolean>
  discardDraftBeforeLeave?: () => Promise<boolean>
}

export type ManuscriptLeaveChoice = 'keep-draft' | 'continue-editing' | 'discard-draft'

/**
 * 正文编辑器脏草稿守卫 + 编辑态桥：编辑态有未保存改动时，切章节 / 切视图前弹确认；
 * editing/saving 供 titlebar 整体替换成保存/取消读取（ADR-0031 编辑态整体替换）。
 * 单飞标志（同一时刻只有一个正文编辑器打开），不进 novel-store。
 */
interface ManuscriptEditorGuardState {
  dirty: boolean
  setDirty: (dirty: boolean) => void
  /** 保存 / 记忆同步完成计数，供侧栏等跨组件消费方作 refreshKey 重拉「待同步」状态。 */
  saveVersion: number
  bumpSaveVersion: () => void
  draftVersion: number
  bumpDraftVersion: () => void
  editing: boolean
  setEditing: (editing: boolean) => void
  saving: boolean
  setSaving: (saving: boolean) => void
  handlers: ManuscriptEditorHandlers | null
  registerHandlers: (handlers: ManuscriptEditorHandlers) => void
  clearHandlers: () => void
  leaveDialogOpen: boolean
  leaveResolving: boolean
}

export const useManuscriptEditorGuard = create<ManuscriptEditorGuardState>((set) => ({
  dirty: false,
  setDirty: (dirty) => set({ dirty }),
  saveVersion: 0,
  bumpSaveVersion: () => set((state) => ({ saveVersion: state.saveVersion + 1 })),
  draftVersion: 0,
  bumpDraftVersion: () => set((state) => ({ draftVersion: state.draftVersion + 1 })),
  editing: false,
  setEditing: (editing) => set({ editing }),
  saving: false,
  setSaving: (saving) => set({ saving }),
  handlers: null,
  registerHandlers: (handlers) => set({ handlers }),
  clearHandlers: () => set({ handlers: null }),
  leaveDialogOpen: false,
  leaveResolving: false,
}))

let pendingLeavePromise: Promise<boolean> | null = null
let resolvePendingLeave: ((leave: boolean) => void) | null = null

export function confirmLeaveManuscriptEditor(): Promise<boolean> {
  const { dirty } = useManuscriptEditorGuard.getState()
  if (!dirty) return Promise.resolve(true)
  // 同一离开意图只允许一个导航调用者等待，避免双击两个链接后同时继续两次导航。
  if (pendingLeavePromise) return Promise.resolve(false)

  useManuscriptEditorGuard.setState({ leaveDialogOpen: true })
  pendingLeavePromise = new Promise<boolean>((resolve) => {
    resolvePendingLeave = resolve
  })
  return pendingLeavePromise
}

function finishPendingLeave(leave: boolean) {
  const resolve = resolvePendingLeave
  pendingLeavePromise = null
  resolvePendingLeave = null
  useManuscriptEditorGuard.setState({ leaveDialogOpen: false, leaveResolving: false })
  resolve?.(leave)
}

export async function resolveManuscriptLeave(choice: ManuscriptLeaveChoice): Promise<void> {
  if (!pendingLeavePromise) return
  if (choice === 'continue-editing') {
    finishPendingLeave(false)
    return
  }

  const state = useManuscriptEditorGuard.getState()
  const prepare =
    choice === 'keep-draft' ? state.handlers?.keepDraftBeforeLeave : state.handlers?.discardDraftBeforeLeave
  if (!prepare) {
    finishPendingLeave(false)
    return
  }

  useManuscriptEditorGuard.setState({ leaveResolving: true })
  const prepared = await prepare().catch(() => false)
  if (!prepared) {
    useManuscriptEditorGuard.setState({ leaveResolving: false })
    return
  }

  state.setDirty(false)
  finishPendingLeave(true)
}

export function cancelPendingManuscriptLeave(): void {
  finishPendingLeave(false)
}
