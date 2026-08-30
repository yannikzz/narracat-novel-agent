/**
 * 埋点副作用层（ADR-0039）：读配置、生成并持久化匿名 ID、攒批、落盘补发、真发请求。
 * 纯判定与分桶在 telemetry.ts，与 release-guard.ts / release-guard-runtime.ts 同款分工。
 *
 * 三条硬性质，改这个文件前先确认没破坏：
 *   ①**告知前零发送**：isTelemetryAllowed 不放行时，事件连队列都不进（不是"先攒着以后补发"）；
 *   ②**只发得出白名单字段**：一切事件必经 sanitizeEvent，它按 TELEMETRY_ALLOWED_PROP_KEYS 裁剪；
 *   ③**发不出去不丢**：失败落盘，下次启动补发，上限 7 天 / 500 条，且队列是明文 JSON，
 *     用户能自己打开看到底传了什么——这是"透明"这句话的物证，不要改成二进制或加密。
 */
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  CURRENT_TELEMETRY_NOTICE_VERSION,
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryEvent,
  type TelemetryModule,
  type TelemetryQueuedEvent,
  type TelemetryState,
} from '@shared/types/telemetry'
import { resolvePrimaryModel } from '@shared/lib/model-slots'
import { getConfigPath, readAppConfig, writeAppConfig, type AppConfig } from '../config.ts'
import type { ChapterWriteTelemetryEvent } from '../agent/events/agent-main-side-effects.ts'
import {
  buildWirePayload,
  createFeatureUsedDeduper,
  durationBucket,
  isTelemetryAllowed,
  sanitizeEvent,
  sizeBucket,
  trimQueue,
  TELEMETRY_FLUSH_AT,
  TELEMETRY_FLUSH_INTERVAL_MS,
} from './telemetry.ts'

/** 已部署的反代 Worker（见 workers/narracat-telemetry/README.md）。 */
const TELEMETRY_URL = 'https://telemetry.narracat.com'
/** 仍是占位地址时不发（开发态不打无谓请求）。 */
const PLACEHOLDER_URL = 'https://telemetry.example.com'
const FETCH_TIMEOUT_MS = 5000
const QUEUE_FILE = 'telemetry-queue.json'

const deduper = createFeatureUsedDeduper()

/** 内存里待发的批次；flush 成功即清空，失败则并入落盘队列。 */
let pending: TelemetryQueuedEvent[] = []
let flushTimer: NodeJS.Timeout | null = null
/** 队列文件的写入串行化：并发写会互相截断。 */
let diskWriteChain: Promise<void> = Promise.resolve()
/** flush 的串行链：并发 flush 会互相覆盖队列文件。 */
let flushChain: Promise<void> = Promise.resolve()
let cachedState: TelemetryState | null = null

function endpoint(): string {
  return process.env.NARRACAT_TELEMETRY_URL?.trim() || TELEMETRY_URL
}

/**
 * 开发态默认不发：dev 里的点击会把"功能使用度"喂成开发者自己的操作习惯，
 * 而那正好是最不像真实用户的一份数据。需要联调时设 NARRACAT_TELEMETRY_URL 显式打开。
 */
function transportEnabled(): boolean {
  if (process.env.NARRACAT_TELEMETRY_URL?.trim()) return true
  if (!app.isPackaged) return false
  return endpoint() !== PLACEHOLDER_URL
}

export function telemetryQueuePath(): string {
  return join(app.getPath('userData'), QUEUE_FILE)
}

async function readQueue(): Promise<TelemetryQueuedEvent[]> {
  try {
    const raw = await readFile(telemetryQueuePath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is TelemetryQueuedEvent =>
        typeof entry === 'object' && entry !== null && typeof (entry as TelemetryQueuedEvent).event === 'string',
    )
  } catch {
    return []
  }
}

function writeQueue(events: readonly TelemetryQueuedEvent[]): Promise<void> {
  const path = telemetryQueuePath()
  const body = `${JSON.stringify(events, null, 2)}\n`
  diskWriteChain = diskWriteChain
    .then(async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body, 'utf8')
    })
    .catch(() => {})
  return diskWriteChain
}

/** 配置里的埋点三件套；缺省即"关且未告知"，任何读失败都退到不发。 */
function stateFromConfig(config: AppConfig): TelemetryState {
  return {
    enabled: config.telemetryEnabled,
    noticeAckedVersion: config.telemetryNoticeAckedVersion,
    anonymousId: config.telemetryAnonymousId,
  }
}

async function loadState(): Promise<TelemetryState> {
  if (cachedState) return cachedState
  try {
    const config = await readAppConfig(getConfigPath(app.getPath('userData')))
    cachedState = stateFromConfig(config)
  } catch {
    cachedState = { enabled: false, noticeAckedVersion: 0, anonymousId: '' }
  }
  return cachedState
}

async function mutateConfig(mutate: (config: AppConfig) => AppConfig): Promise<TelemetryState> {
  const path = getConfigPath(app.getPath('userData'))
  const current = await readAppConfig(path)
  const next = await writeAppConfig(path, mutate(current))
  cachedState = stateFromConfig(next)
  return cachedState
}

/** 匿名 ID：本机随机 UUID，与机器指纹无关；没有就现生成一个并落配置。 */
async function ensureAnonymousId(): Promise<string> {
  const state = await loadState()
  if (state.anonymousId) return state.anonymousId
  const next = await mutateConfig((config) => ({ ...config, telemetryAnonymousId: randomUUID() }))
  return next.anonymousId
}

function allowed(state: TelemetryState): boolean {
  return isTelemetryAllowed({
    enabled: state.enabled,
    noticeAckedVersion: state.noticeAckedVersion,
    currentNoticeVersion: CURRENT_TELEMETRY_NOTICE_VERSION,
  })
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushTelemetry()
  }, TELEMETRY_FLUSH_INTERVAL_MS)
  flushTimer.unref?.()
}

/**
 * 记一条事件。**唯一入口**——所有埋点都从这里走，闸门与清洗都在这一处，
 * 不要在别处直接往 pending 里塞。
 */
export async function recordTelemetry(event: TelemetryEvent, at = new Date()): Promise<void> {
  try {
    const state = await loadState()
    if (!allowed(state)) return
    const sanitized = sanitizeEvent(event, at)
    if (!sanitized) return
    pending.push(sanitized)
    if (pending.length >= TELEMETRY_FLUSH_AT) void flushTelemetry()
    else scheduleFlush()
  } catch {
    // 埋点永远不该影响 App 本身，任何异常都咽掉。
  }
}

/**
 * 模块被用了；同一模块同一自然日只记一次。
 *
 * 去重**必须排在闸门之后**：闸门关着时先去重，会把当天的名额白白吃掉——用户中途打开开关后，
 * 今天用过的模块就再也记不上了，而这恰恰是本功能唯一要产出的那个数。
 */
export function recordFeatureUsed(module: TelemetryModule, at = new Date()): void {
  void (async () => {
    try {
      const state = await loadState()
      if (!allowed(state)) return
      if (!deduper.shouldRecord(module, at)) return
      await recordTelemetry({ event: 'feature_used', props: { module } }, at)
    } catch {
      // 埋点不许影响 IPC 调用本身。
    }
  })()
}

/**
 * 本次写章节用的是哪个模型。取的是**当前主力槽**而非 run 里冻结的模型——两者只在
 * "写作途中改了主力模型"时才会不一致，那种情况罕见到不值得为它把模型标识透传穿整条 run 链路。
 * 读不到就记 'unknown'，不猜。
 */
async function primaryModelLabel(): Promise<{ provider: string; model_id: string }> {
  try {
    const config = await readAppConfig(getConfigPath(app.getPath('userData')))
    const primary = resolvePrimaryModel(config)
    if (!primary) return { provider: 'unknown', model_id: 'unknown' }
    return { provider: primary.provider, model_id: primary.modelId }
  } catch {
    return { provider: 'unknown', model_id: 'unknown' }
  }
}

/**
 * 写章节的起止。起点同时补记一条 feature_used(write-chapter)，让 16 个模块的
 * "有机会用 → 用过 → 第二次"口径保持一致（写章节不挂在任何 IPC 通道上，见 ipc-modules.ts）。
 */
export async function recordChapterWrite(event: ChapterWriteTelemetryEvent): Promise<void> {
  try {
    const state = await loadState()
    if (!allowed(state)) return
    const model = await primaryModelLabel()
    if (event.phase === 'started') {
      recordFeatureUsed('write-chapter')
      await recordTelemetry({
        event: 'chapter_write_started',
        props: { ...model, chapter_bucket: sizeBucket(event.chapter ?? 0) },
      })
      return
    }
    await recordTelemetry({
      event: 'chapter_write_finished',
      props: { ...model, outcome: event.outcome, duration_bucket: durationBucket(event.durationMs) },
    })
    if (event.outcome === 'failed') {
      await recordTelemetry({ event: 'error_occurred', props: { code: 'run-failed', module: 'write-chapter' } })
    }
  } catch {
    // 埋点不许影响写作链路。
  }
}

/**
 * 发一批。失败不抛：并回落盘队列，下次启动或下个周期再试。
 * 队列裁剪在写盘前做，保证磁盘上永远不超过 7 天 / 500 条。
 *
 * **串行执行**：攒够条数触发的 flush 与定时器触发的 flush 会撞在一起，两者都是
 * 「读队列 → 合并 → 写队列」，并发跑必然互相覆盖、丢事件。
 */
export function flushTelemetry(): Promise<void> {
  flushChain = flushChain.then(runFlush, runFlush)
  return flushChain
}

async function runFlush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const batch = pending
  pending = []
  const queued = await readQueue()
  const all = trimQueue([...queued, ...batch], { now: new Date() })
  if (all.length === 0) {
    // 盘上本来就是空的就别写了——否则空闲时每 30 秒白写一次盘。
    if (queued.length > 0) await writeQueue([])
    return
  }
  if (!transportEnabled()) {
    await writeQueue(all)
    return
  }

  const anonymousId = await ensureAnonymousId().catch(() => '')
  if (!anonymousId) {
    await writeQueue(all)
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(endpoint(), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildWirePayload(all, { anonymousId, schemaVersion: TELEMETRY_SCHEMA_VERSION })),
    })
    // 4xx 说明这批载荷服务端不认（字典对不上），重试多少次都一样 —— 丢掉，别让它堵死队列。
    if (response.ok || (response.status >= 400 && response.status < 500)) {
      await writeQueue([])
      return
    }
    await writeQueue(all)
  } catch {
    await writeQueue(all)
  } finally {
    clearTimeout(timer)
  }
}

/** 启动时调一次：补发上次没发出去的，并记一条 app_started。 */
export async function startTelemetry(): Promise<void> {
  try {
    const state = await loadState()
    if (!allowed(state)) return
    await recordTelemetry({
      event: 'app_started',
      props: {
        app_version: app.getVersion(),
        os: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',
        arch: process.arch,
      },
    })
    await flushTelemetry()
  } catch {
    // 同 recordTelemetry：埋点不许影响启动。
  }
}

/** 退出前把内存里没发出去的落盘（同步路径不可用，故 before-quit 里 await 这个）。 */
export async function settleTelemetryBeforeQuit(): Promise<void> {
  try {
    await flushTelemetry()
  } catch {}
}

export async function getTelemetryState(): Promise<TelemetryState> {
  return loadState()
}

/**
 * 用户拨开关。关闭时**先发一条 telemetry_opt_out 再关**——关闭率是判断样本偏差的唯一依据，
 * 关了却不知道有多少人关了，剩下的数据就没法解释（ADR-0039 未知项一）。
 */
export async function setTelemetryEnabled(enabled: boolean): Promise<TelemetryState> {
  const previous = await loadState()
  if (!enabled && allowed(previous)) {
    await recordTelemetry({ event: 'telemetry_opt_out', props: { app_version: app.getVersion() } })
    await flushTelemetry()
  }
  const next = await mutateConfig((config) => ({ ...config, telemetryEnabled: enabled }))
  if (!enabled) {
    pending = []
    deduper.reset()
    await writeQueue([])
  }
  return next
}

/** 用户看完告知屏点了确认；在此之前一个事件都没发过。 */
export async function acknowledgeTelemetryNotice(): Promise<TelemetryState> {
  const next = await mutateConfig((config) => ({
    ...config,
    telemetryNoticeAckedVersion: CURRENT_TELEMETRY_NOTICE_VERSION,
  }))
  await startTelemetry()
  return next
}

/** 重置匿名 ID：旧 ID 的历史数据从此与本机断开关联，等同换了一台新机器。 */
export async function resetTelemetryAnonymousId(): Promise<TelemetryState> {
  pending = []
  deduper.reset()
  await writeQueue([])
  return mutateConfig((config) => ({ ...config, telemetryAnonymousId: randomUUID() }))
}
