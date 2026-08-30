/**
 * 埋点纯逻辑（ADR-0039）。刻意不依赖 electron / fetch / 文件系统——副作用全在
 * telemetry-runtime.ts，与 release-guard.ts / release-guard-runtime.ts 同款分工，
 * 单测可在任意顺序下直接 import。
 *
 * 这里承担三件事，且都是"机械执行红线"而不是靠人记得：
 *   ①分桶：真实数字进来、桶名出去，调用方拿不到原始值；
 *   ②清洗：不在 TELEMETRY_ALLOWED_PROP_KEYS 里的键一律丢弃；
 *   ③闸门：告知屏没确认过 / 用户关了 → 一个事件都不出去。
 */
import {
  TELEMETRY_ALLOWED_PROP_KEYS,
  TELEMETRY_EVENTS,
  type TelemetryDurationBucket,
  type TelemetryEvent,
  type TelemetryEventName,
  type TelemetryModule,
  type TelemetryQueuedEvent,
  type TelemetrySizeBucket,
} from '@shared/types/telemetry'

/** 落盘队列上限（ADR-0039 决定七）：超出即丢最旧的。 */
export const TELEMETRY_QUEUE_MAX_ITEMS = 500
/** 落盘队列保留天数：过期事件直接丢弃，不做无限期囤积。 */
export const TELEMETRY_QUEUE_MAX_AGE_DAYS = 7
/** 攒够这么多条就发一批。 */
export const TELEMETRY_FLUSH_AT = 20
/** 或者攒够这么久就发一批（毫秒）。 */
export const TELEMETRY_FLUSH_INTERVAL_MS = 30_000

const EVENT_NAMES: ReadonlySet<string> = new Set(TELEMETRY_EVENTS)

/**
 * 规模分桶：真实章数/字数 → 桶名。桶边界见 TELEMETRY_SIZE_BUCKETS 的注释，发布后不要改。
 * 非有限数 / 负数一律落 '0'（宁可少算，不要发出一个来路不明的值）。
 */
export function sizeBucket(count: number): TelemetrySizeBucket {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count <= 5) return '1-5'
  if (count <= 20) return '6-20'
  if (count <= 100) return '21-100'
  return '100+'
}

/** 时长分桶：毫秒 → 桶名。 */
export function durationBucket(durationMs: number): TelemetryDurationBucket {
  if (!Number.isFinite(durationMs) || durationMs < 60_000) return '<1m'
  if (durationMs < 5 * 60_000) return '1-5m'
  if (durationMs < 15 * 60_000) return '5-15m'
  if (durationMs < 30 * 60_000) return '15-30m'
  return '30m+'
}

/** 自然日键（本地时区）。feature_used 的每日去重与留存口径都按它算。 */
export function dayKey(at: Date): string {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 清洗：把一个事件压成"只剩白名单字段、值一律是字符串"的可发送形态。
 * 事件名不认识 → null（新事件必须先进 TELEMETRY_EVENTS，绕不过去）。
 * 值里出现换行/超长 → 判定为可疑，整条丢弃：正常枚举值不可能长这样，
 * 与其发出去一段可能夹带正文的字符串，不如少一条数据。
 */
export function sanitizeEvent(event: TelemetryEvent, at: Date): TelemetryQueuedEvent | null {
  if (!EVENT_NAMES.has(event.event)) return null
  const allowed = TELEMETRY_ALLOWED_PROP_KEYS[event.event]
  const props: Record<string, string> = {}
  for (const key of allowed) {
    const raw = (event.props as unknown as Record<string, unknown>)[key]
    if (raw === undefined || raw === null) continue
    const value = String(raw)
    if (value.length > 64 || /[\r\n]/.test(value)) return null
    props[key] = value
  }
  return { event: event.event, props, at: at.toISOString() }
}

/**
 * 队列裁剪：先按保留期丢旧的，再按条数上限丢最旧的。
 * 时间戳解析不出来的条目直接丢——它进不了任何有意义的分析，留着只会占额度。
 */
export function trimQueue(
  events: readonly TelemetryQueuedEvent[],
  options: { now: Date; maxItems?: number; maxAgeDays?: number },
): TelemetryQueuedEvent[] {
  const maxItems = options.maxItems ?? TELEMETRY_QUEUE_MAX_ITEMS
  const maxAgeDays = options.maxAgeDays ?? TELEMETRY_QUEUE_MAX_AGE_DAYS
  const cutoff = options.now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000
  const fresh = events.filter((entry) => {
    const ms = Date.parse(entry.at)
    return Number.isFinite(ms) && ms >= cutoff
  })
  return fresh.length > maxItems ? fresh.slice(fresh.length - maxItems) : fresh
}

export interface TelemetryGateInput {
  /** 用户开关（config.telemetryEnabled）。 */
  enabled: boolean
  /** 用户已确认的告知屏版本（config.telemetryNoticeAckedVersion）。 */
  noticeAckedVersion: number
  /** 当前告知屏版本（CURRENT_TELEMETRY_NOTICE_VERSION）。 */
  currentNoticeVersion: number
}

/**
 * 唯一的发送闸门。**告知前零发送**是 ADR-0039 决定八的硬承诺：老用户升级上来、
 * 还没看到告知屏之前，一个事件都不许出去——所以这里判的是"确认过的版本 >= 当前版本"，
 * 而不是"看过任意一版"。
 */
export function isTelemetryAllowed(input: TelemetryGateInput): boolean {
  if (!input.enabled) return false
  return input.noticeAckedVersion >= input.currentNoticeVersion
}

/**
 * feature_used 的每日去重：同一模块同一自然日只记一次。
 * 去重表只存在于本次进程（同一天重启 App 会多发一条）——这不影响结论，因为所有口径
 * 都按"当天用过该模块的**人数**"算，同一人多发几条不会改变去重后的人数。
 * 为此再加一条磁盘写入路径不划算。
 */
export function createFeatureUsedDeduper() {
  const lastDayByModule = new Map<TelemetryModule, string>()
  return {
    /** 今天该模块还没记过 → true（并记账）；已记过 → false。 */
    shouldRecord(module: TelemetryModule, at: Date): boolean {
      const today = dayKey(at)
      if (lastDayByModule.get(module) === today) return false
      lastDayByModule.set(module, today)
      return true
    },
    reset(): void {
      lastDayByModule.clear()
    },
  }
}

export type FeatureUsedDeduper = ReturnType<typeof createFeatureUsedDeduper>

/** PostHog batch 接口的单条形态。distinct_id 由调用方统一注入。 */
export interface TelemetryWirePayload {
  api_key?: string
  batch: Array<{
    event: TelemetryEventName
    distinct_id: string
    timestamp: string
    properties: Record<string, string | number>
  }>
}

/**
 * 组装上报载荷。**这个函数是"我们到底发了什么"的完整答案**：一个审代码的人只要读它，
 * 就能确认发出去的字段一个不多。故意不引 SDK——SDK 会自动附加 $ip / $lib / 自动采集属性，
 * 那样就没法用一个函数说清楚了（ADR-0039）。
 */
export function buildWirePayload(
  events: readonly TelemetryQueuedEvent[],
  context: { anonymousId: string; schemaVersion: number },
): TelemetryWirePayload {
  return {
    batch: events.map((entry) => ({
      event: entry.event,
      distinct_id: context.anonymousId,
      timestamp: entry.at,
      properties: { ...entry.props, schema_version: context.schemaVersion },
    })),
  }
}
