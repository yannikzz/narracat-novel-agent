import { create } from 'zustand'
import type {
  PolishRunEvent,
  PolishSlotId,
  PolishVersionState,
} from '@shared/types/prose-polish'
import { cancelPolishRun, onPolishEvent, startPolishRun } from './ipc'

/**
 * 试验模式的运行态（ADR-0041 §10）。
 *
 * 只活在本次会话里：**离开页面、切章、切书都不清空**（切页就丢会把刚花十几秒跑出来的版本
 * 白白扔掉），但版本归属由 `projectPath + chapter` 一起判——只判章号会让另一本书的同章号
 * 显示上一本的版本，采用时又拿当前书的正文当乐观锁基线，等于把别的书的文字写进这本书。
 *
 * 清空只由三件事触发：作者点「丢弃」、采用了某一版、发起新一轮。
 */

export interface PolishRunState {
  runId: string | null
  /** 版本归属的另一半。缺了它就会跨小说串数据（见文件头注释）。 */
  projectPath: string | null
  chapter: number | null
  /** 本轮参与的槽，按发起顺序 */
  order: PolishSlotId[]
  /** 本轮发起时刻（ms）。界面靠它显示「已等多久」。 */
  startedAt: number | null
  /**
   * 送去润色的那一份正文。
   * 版本不再随离开页面消失，就得有办法判断它们是不是已经对不上当前正文了。
   */
  baselineText: string | null
  versions: Partial<Record<PolishSlotId, PolishVersionState>>
  /** 还有版本在跑 */
  running: boolean
  /**
   * 常驻润色（后台跑、没有 runId）的收尾计数。
   * 正文页把它挂进依赖里重读设置与正文——否则自动润完那一章会一直停在原稿上。
   */
  standingVersion: number
  start: (input: {
    projectPath: string
    chapter: number
    slotIds: PolishSlotId[]
    baselineText: string
  }) => Promise<void>
  cancelOne: (slotId: PolishSlotId) => Promise<void>
  cancelAll: () => Promise<void>
  reset: () => void
  applyEvent: (event: PolishRunEvent) => void
}

function emptyVersion(slotId: PolishSlotId): PolishVersionState {
  return { slotId, status: 'pending', text: '' }
}

export const usePolishRun = create<PolishRunState>((set, get) => ({
  runId: null,
  projectPath: null,
  chapter: null,
  order: [],
  startedAt: null,
  baselineText: null,
  versions: {},
  running: false,
  standingVersion: 0,

  start: async ({ projectPath, chapter, slotIds, baselineText }) => {
    // 先停上一轮再开新一轮：跑版期间「润色正文」按钮并不禁用，作者可以直接再发一轮。
    // 不停的话上一轮会继续跑完、继续烧 token；而且它的增量会在下面 runId 清空的窗口里
    // 落进新一轮（applyEvent 只认当前 runId，空窗口靠「只放行 started」兜底，见那里的注释）。
    // 取消失败不阻断发起——最坏只是多烧一版的钱。
    await get().cancelAll().catch(() => undefined)
    set({
      runId: null,
      projectPath,
      chapter,
      order: slotIds,
      startedAt: Date.now(),
      baselineText,
      versions: {},
      running: true,
    })
    try {
      const { runId, versions } = await startPolishRun({ projectPath, chapter, slotIds })
      // 只补还不存在的槽：事件可能先于 invoke 的返回到达，直接整片覆盖会把已收到的增量抹掉。
      set((state) => ({
        runId,
        order: versions.map((version) => version.slotId),
        versions: Object.fromEntries(
          versions.map((version) => [version.slotId, state.versions[version.slotId] ?? version]),
        ),
      }))
    } catch (error) {
      set({ running: false })
      throw error
    }
  },

  cancelOne: async (slotId) => {
    const { runId } = get()
    if (!runId) return
    await cancelPolishRun({ runId, slotId })
  },

  cancelAll: async () => {
    const { runId } = get()
    if (!runId) return
    await cancelPolishRun({ runId })
  },

  reset: () =>
    set({
      runId: null,
      projectPath: null,
      chapter: null,
      order: [],
      startedAt: null,
      baselineText: null,
      versions: {},
      running: false,
    }),

  applyEvent: (event) => {
    const state = get()

    // 常驻收尾不属于任何一次试验运行，只负责把渲染端叫醒。
    if (event.type === 'standing-finished') {
      set((current) => ({ standingVersion: current.standingVersion + 1 }))
      return
    }

    // 只认当前 run 的事件；`started` 例外，它就是用来建立当前 run 的。
    // runId 为空（刚发起还没收到 started、或刚丢弃 / 采用完）的窗口里一律丢：
    // 这个窗口原来是漏的——旧 run 的增量会拼进新一轮的版本、被中止的槽会在 reset 之后写回。
    if (event.type !== 'started' && event.runId !== state.runId) return

    if (event.type === 'started') {
      set((state) => ({
        runId: event.runId,
        chapter: event.chapter,
        projectPath: state.projectPath,
        order: event.slotIds,
        startedAt: state.startedAt ?? Date.now(),
        versions: Object.fromEntries(
          event.slotIds.map((slotId) => [slotId, state.versions[slotId] ?? emptyVersion(slotId)]),
        ),
        running: true,
      }))
      return
    }

    if (event.type === 'finished') {
      set({ running: false })
      return
    }

    const current = state.versions[event.slotId] ?? emptyVersion(event.slotId)
    const next: PolishVersionState =
      event.type === 'delta'
        ? { ...current, status: 'streaming', text: current.text + event.text }
        : event.type === 'version-done'
          ? { ...current, status: 'done', drift: event.drift, usage: event.usage }
          : event.type === 'version-failed'
            ? { ...current, status: 'failed', error: event.message }
            : { ...current, status: 'aborted' }

    set({ versions: { ...state.versions, [event.slotId]: next } })
  },
}))

/** 订阅主进程事件；调用方在组件挂载时接上，卸载时断开。 */
export function subscribePolishEvents(): () => void {
  return onPolishEvent((event) => usePolishRun.getState().applyEvent(event))
}

/**
 * 版本是否已经可以被采用——流到一半不给采用按钮，想早退只能中止（ADR-0041 §10）。
 *
 * 界面侧走 `derivePolishVersionView`（那里还要叠加「基线已过期」这一条）；本函数留给
 * 不关心界面的调用方与测试，是同一条规则的最小形态。
 */
export function isAdoptable(version: PolishVersionState | undefined): boolean {
  return version?.status === 'done' && version.text.trim().length > 0
}

/** 这一版还在跑（等首字或正在流）。tab 的忙碌点与操作条的「中止」都只认这一条。 */
export function isPolishVersionRunning(version: PolishVersionState | undefined): boolean {
  return version?.status === 'pending' || version?.status === 'streaming'
}

/**
 * 「已等多久」的人话。
 *
 * 「还没收到第一个字」不等于「排队中」——请求早发出去了，界面得显示一个还在走的计时，否则那段
 * 时间里它看起来就是死的。开着推理模式时模型可能长时间只吐思考不吐正文，这个计时尤其必要。
 *
 * （早期这里写过「该端点基本不做增量流式、首字要等 89 秒」，那是 thinking 烧预算造成的误判，
 * 已由 ADR-0041 更正：关掉思考后首字 1.4 秒。）
 */
export function formatPolishElapsed(startedAt: number | null, now: number): string {
  if (startedAt === null) return ''
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) return `已等 ${seconds} 秒`
  return `已等 ${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}
