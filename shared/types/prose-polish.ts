/**
 * 正文润色（ADR-0041）的跨进程契约。
 *
 * 润色 = 作者自带提示词 + 直连大模型对整章正文加工，**不经 Agent**。产品定位是自主权通道，
 * 不承诺效果：出厂零模板，风格由作者的提示词决定，产品只负责锁住事实（账房归我们、花归用户）。
 */

/** 固定三槽，不可增删——三是横向对比的上限，也是界面的天然形状。 */
export const POLISH_SLOT_IDS = ['slot-1', 'slot-2', 'slot-3'] as const
export type PolishSlotId = (typeof POLISH_SLOT_IDS)[number]

export function isPolishSlotId(value: unknown): value is PolishSlotId {
  return typeof value === 'string' && (POLISH_SLOT_IDS as readonly string[]).includes(value)
}

/**
 * 一条配方 = 提示词 + 模型。
 *
 * 模型跟着槽走（而非全局一个「润色模型」），是为了让作者能把同一套提示词配两个模型跑，
 * 分辨「我提示词写得烂」还是「这模型不行」——只能试前一个方向的作者，最终结论会是
 * 「这功能没用」，锅又回到产品身上（ADR-0041 §9）。
 */
export interface PolishRecipe {
  slotId: PolishSlotId
  /** 作者原文，不做任何加工。空串 = 空槽，空槽不参与跑版。 */
  prompt: string
  /** 模型池条目主键（`provider/modelId`）。null = 继承主力槽。 */
  modelKey: string | null
  /**
   * 推理模式（扩展思考）。默认关。
   *
   * 关掉是默认值而不是唯一选项：thinking token 与正文共用 `max_tokens`，开着默认预算会被烧光
   * （实测 thinking_delta × 15994 / text_delta × 0，ADR-0041）。但对「重写这一段的逻辑」这类
   * 要求，想一想确实可能更好——所以开关交给作者，我们负责在开启时把预算分好，不让它烧穿。
   */
  thinking: boolean
  updatedAt: string
}

export interface PolishRecipeFile {
  version: 1
  recipes: PolishRecipe[]
  /** 上次实际跑过的槽位组合，用作下次发起时的默认勾选（迭代提示词时常只想重跑一槽）。 */
  lastRunSlotIds: PolishSlotId[]
}

/**
 * 常驻润色在某一章的结果。
 *
 * `skipped` 必须留痕并显示出来：常驻模式没有观众，静默跳过会变成「怎么好几章没润色」的哑谜
 * （我们吃过这个亏——打包链断了两周没人知道）。作者看过点掉即清。
 */
export interface StandingPolishOutcome {
  status: 'applied' | 'skipped'
  at: string
  /** skipped 时的原因，作者词汇 */
  note?: string
}

/** 本书的润色设置，存项目内 `.narracat/polish.json`（配方存 userData，两者生命周期不同）。 */
export interface ProjectPolishSettings {
  version: 1
  /** 常驻槽位：写完新章后自动用它润色。null = 关闭。只作用于往后新写的章，不追溯。 */
  standingSlotId: PolishSlotId | null
  /** 章号 → 常驻润色结果；作者看过即清。 */
  standingOutcomes: Record<string, StandingPolishOutcome>
  /**
   * 作者已经回答过「要不要设为常驻」。
   *
   * 这个问题一本书只该问一次：答「设为常驻」之后不必再问，答「这次就好」更不该反复追问——
   * 每采用一版就弹一次，是在拿一个已经被回答的问题反复打断作者。
   * 想改主意随时能在润色弹窗里改。
   */
  standingPromptAnswered: boolean
  /**
   * 正文与记忆已分家的章号（旧章漂移版被采用后登记，ADR-0041 §7）。
   * 纯陈述标识，不配任何操作——sync 不收旧章、rewrite 会抹掉作者润出的版本，确实无出口可给。
   */
  divergedChapters: number[]
}

// --- 护栏：事实漂移判据 ------------------------------------------------------

export type PolishDriftSignal = 'names' | 'numbers' | 'paragraphs'

export interface PolishDriftDetail {
  /** 原稿出现、润色版消失的已知专名 */
  lostNames: string[]
  /** 原稿没有、润色版凭空出现的已知专名 */
  addedNames: string[]
  /** 归一化后消失的数字（如 `3天`） */
  lostNumbers: string[]
  /** 归一化后新增的数字 */
  addedNumbers: string[]
  originalParagraphs: number
  polishedParagraphs: number
}

export interface PolishDrift {
  drifted: boolean
  signals: PolishDriftSignal[]
  detail: PolishDriftDetail
}

// --- 运行态 ------------------------------------------------------------------

export type PolishVersionStatus = 'pending' | 'streaming' | 'done' | 'failed' | 'aborted'

export interface PolishUsage {
  inputTokens: number
  outputTokens: number
}

/** 一个槽位这一轮的产出。text 在 streaming 期间是已到达的增量拼接，done 之后才是完整正文。 */
export interface PolishVersionState {
  slotId: PolishSlotId
  status: PolishVersionStatus
  text: string
  /** failed 时的原因（作者词汇，可直接展示） */
  error?: string
  usage?: PolishUsage
  /** 仅在 status === 'done' 时有值：护栏必须等全文到齐才算得准，半截文本上必然误报。 */
  drift?: PolishDrift
}

export interface PolishRunRequest {
  projectPath: string
  chapter: number
  slotIds: PolishSlotId[]
}

export type PolishRunEvent =
  | { type: 'started'; runId: string; chapter: number; slotIds: PolishSlotId[] }
  | { type: 'delta'; runId: string; slotId: PolishSlotId; text: string }
  | { type: 'version-done'; runId: string; slotId: PolishSlotId; drift: PolishDrift; usage: PolishUsage }
  | { type: 'version-failed'; runId: string; slotId: PolishSlotId; message: string }
  | { type: 'version-aborted'; runId: string; slotId: PolishSlotId }
  | { type: 'finished'; runId: string }
  /** 常驻润色（后台、无 runId）跑完：渲染端据此刷新正文与横幅。 */
  | { type: 'standing-finished'; chapter: number; status: 'applied' | 'skipped' }

/** 采用某一版时的三分支路由（ADR-0041 §7），由主进程判定后回给渲染端。 */
export type PolishAdoptOutcome =
  | { kind: 'clean' }
  | { kind: 'pending-sync'; chapter: number }
  | { kind: 'diverged'; chapter: number }

export interface PolishAdoptRequest {
  projectPath: string
  chapter: number
  slotId: PolishSlotId
  polishedText: string
  /** 乐观锁：作者读到的原稿可见正文，不符即拒绝，不覆盖。 */
  expectedVisibleText: string
  /** 旧章漂移分支必须由渲染端先弹确认，再带 true 回来；缺它则主进程拒绝写入。 */
  divergenceAcknowledged?: boolean
}
