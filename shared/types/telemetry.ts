/**
 * 匿名使用统计（埋点）的**唯一事实源**（ADR-0039）。
 *
 * 这个文件是"我们到底往外发什么"的完整答案：事件名、模块名、报错码、每类事件的字段，
 * 全在这里枚举。四个下游全部从它派生，任何一处漏改都会被类型或守卫测试挡下：
 *   ①主进程发送端（electron/main/telemetry/）  ②首启告知屏与设置页的文案清单
 *   ③反代 Worker 的服务端白名单校验          ④守卫测试（IPC 通道必须有模块归属）
 *
 * 红线（ADR-0039，不可协商）：这里出现的每个字段都必须是**枚举值或分桶后的数字**。
 * 小说正文 / 章节标题 / 大纲 / 立项卡 / 角色设定 / 任何用户输入文本 / API Key /
 * 本机文件路径 / 小说名——一个字都不进这个文件，也就一个字都发不出去。
 * 新增字段前先问：它有没有可能承载用户写的字？只要答案不是"绝无可能"，就不要加。
 */

/** 埋点契约版本。字段语义变更时 +1，服务端据此分辨新旧客户端。 */
export const TELEMETRY_SCHEMA_VERSION = 1

/**
 * 首启/升级告知屏的版本号。**改告知文案必须 +1**，否则已确认过的用户永远看不到新版本文案
 * （与 CURRENT_INTRO_VERSION 同款门控，同款脚枪）。
 * config.telemetryNoticeAckedVersion < 此值 → 弹告知屏，且在确认前一个事件都不发。
 *
 * 版本沿革：
 *   1 → 2（ADR-0040）：立项卡对话与规划大纲这两个动作此前一条事件都没发过，本次开始计入
 *     「用过哪些功能」；新建项目也从 premise 拆成独立标签。没有新增字段、也没有新增数据种类
 *     （仍只是功能名称），但**采集的行为集合确实变大了**，按本文件与 TelemetryNotice.tsx
 *     的红线必须重新告知。
 */
export const CURRENT_TELEMETRY_NOTICE_VERSION = 3

/**
 * 功能模块枚举。埋点只到模块级——不是 130 个 IPC 动作各埋各的，而是每个模块一天最多记一次
 * （ADR-0039「模块级三个数」）。新增模块时加在这里，并在 electron/main/telemetry/ipc-modules.ts
 * 给对应 IPC 通道挂上归属，否则守卫测试会红。
 */
export const TELEMETRY_MODULES = [
  'project-create', // 新建小说项目（只是开坑，与立项卡是两件事）
  'premise', // 立项卡（setup 对话 / 编辑）
  'outline', // 大纲（总纲 / 章纲）
  'write-chapter', // 写章节
  'manuscript-edit', // 正文编辑（草稿、修订、回滚）
  'character-state', // 角色状态与身份
  'character-chat', // 唠个嗑
  'memory-graph', // 记忆星图
  'packs-use', // 能力包：启用 / 导入 / 卸载
  'packs-author', // 造包中心：创作台、编译、发布
  'packs-learn', // 从书学写法
  'packs-wizard', // 作家向导
  'reference-works', // 参考书与风格锚
  'prose-blocks', // 写作指令编辑
  'prose-polish', // 正文润色（作者自持通道，ADR-0041）
  'project-backup', // 项目备份与恢复
  'model-config', // 模型服务配置
  'updater', // 软件更新
] as const
export type TelemetryModule = (typeof TELEMETRY_MODULES)[number]

/**
 * 报错码枚举。**只发这里的码，永不发原始报错文本或堆栈**——模型返回的报错里常夹带正文片段，
 * 堆栈里常夹带本机路径（ADR-0039 决定九：不开自动捕获）。
 */
export const TELEMETRY_ERROR_CODES = [
  'run-timeout', // Agent run 空转超时
  'run-failed', // Agent run 以失败终态收场
  'provider-auth', // 渠道鉴权失败（Key 无效 / 过期）
  'provider-rate-limit', // 渠道限流
  'provider-unreachable', // 渠道连不上
  'memory-unavailable', // NovelMemory 起不来或挂了
  'engine-missing', // Agent Core 解析失败
  'update-failed', // 自动更新失败
] as const
export type TelemetryErrorCode = (typeof TELEMETRY_ERROR_CODES)[number]

/** 写章节的收场方式。与 AgentRunTerminalStatus 对齐，但刻意不复用——埋点契约要能独立演化。 */
export const TELEMETRY_WRITE_OUTCOMES = ['success', 'failed', 'cancelled', 'interrupted'] as const
export type TelemetryWriteOutcome = (typeof TELEMETRY_WRITE_OUTCOMES)[number]

/**
 * 规模分桶。**只发桶名不发真实数字**——真实章数/字数配合时间线可能反推到具体作品，桶不会。
 * 桶边界一旦发布就不要改：改了会让跨版本的数据不可比。
 */
export const TELEMETRY_SIZE_BUCKETS = ['0', '1-5', '6-20', '21-100', '100+'] as const
export type TelemetrySizeBucket = (typeof TELEMETRY_SIZE_BUCKETS)[number]

/** 时长分桶（秒）。同样只发桶名。 */
export const TELEMETRY_DURATION_BUCKETS = ['<1m', '1-5m', '5-15m', '15-30m', '30m+'] as const
export type TelemetryDurationBucket = (typeof TELEMETRY_DURATION_BUCKETS)[number]

/** 事件名枚举。全库只有这六个，多一个都要过 ADR-0039 的红线复核。 */
export const TELEMETRY_EVENTS = [
  'app_started',
  'feature_used',
  'chapter_write_started',
  'chapter_write_finished',
  'error_occurred',
  'telemetry_opt_out',
] as const
export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number]

/** 每次启动一条。是所有比率的分母："有多少人有机会用到某功能"。 */
export interface TelemetryAppStartedProps {
  app_version: string
  os: 'darwin' | 'win32' | 'linux'
  arch: string
}

/** 某模块今天被用过。同一模块同一自然日只发一条（去重在客户端做，见 telemetry.ts）。 */
export interface TelemetryFeatureUsedProps {
  module: TelemetryModule
}

export interface TelemetryChapterWriteStartedProps {
  provider: string
  model_id: string
  chapter_bucket: TelemetrySizeBucket
}

export interface TelemetryChapterWriteFinishedProps {
  provider: string
  model_id: string
  outcome: TelemetryWriteOutcome
  duration_bucket: TelemetryDurationBucket
}

export interface TelemetryErrorOccurredProps {
  code: TelemetryErrorCode
  module: TelemetryModule | 'unknown'
}

/** 用户关掉埋点时发的最后一条，用来量"关闭率"——不知道关闭率就不知道样本偏成什么样。 */
export interface TelemetryOptOutProps {
  app_version: string
}

export type TelemetryEvent =
  | { event: 'app_started'; props: TelemetryAppStartedProps }
  | { event: 'feature_used'; props: TelemetryFeatureUsedProps }
  | { event: 'chapter_write_started'; props: TelemetryChapterWriteStartedProps }
  | { event: 'chapter_write_finished'; props: TelemetryChapterWriteFinishedProps }
  | { event: 'error_occurred'; props: TelemetryErrorOccurredProps }
  | { event: 'telemetry_opt_out'; props: TelemetryOptOutProps }

/** 落盘队列里的一条：事件 + 发生时刻。distinct_id 在发送时统一附加，不逐条存。 */
export interface TelemetryQueuedEvent {
  event: TelemetryEventName
  props: Record<string, string>
  at: string
}

/**
 * 允许出现在 props 里的字段名总表。发送前逐条核对（客户端一次、Worker 再一次），
 * 不在表里的键直接丢弃——这是红线的机械执行者，而不是靠"记得别写"。
 */
export const TELEMETRY_ALLOWED_PROP_KEYS: Readonly<Record<TelemetryEventName, readonly string[]>> =
  Object.freeze({
    app_started: Object.freeze(['app_version', 'os', 'arch']),
    feature_used: Object.freeze(['module']),
    chapter_write_started: Object.freeze(['provider', 'model_id', 'chapter_bucket']),
    chapter_write_finished: Object.freeze(['provider', 'model_id', 'outcome', 'duration_bucket']),
    error_occurred: Object.freeze(['code', 'module']),
    telemetry_opt_out: Object.freeze(['app_version']),
  })

/** 渲染端读取的埋点状态。 */
export interface TelemetryState {
  enabled: boolean
  /** 已确认过的告知屏版本；0 = 从未告知过 → 必须先弹告知屏，且此前不发任何事件。 */
  noticeAckedVersion: number
  /** 本机匿名 ID（随机 UUID，与机器指纹无关）。空串 = 尚未生成。 */
  anonymousId: string
}
