// 匿名使用统计的反代 Worker（ADR-0039）。
// App 只知道 telemetry.narracat.com，PostHog 的域名与写入 Key 都只存在于这里。
//
// 它做三件事，缺一不可：
//   ①**中国可达性**：客户端走已实测跑通的自有域名，不赌 eu.i.posthog.com 在国内能不能连上；
//   ②**Key 不进客户端**：写入 Key 是 Worker secret，仓库和安装包里都没有它，
//     换供应商 / 轮换 Key 都不需要发新版；
//   ③**服务端再执行一次红线**：按事件字典白名单逐字段裁剪，字典外的键一律丢弃。
//     客户端已经裁过一次，这里是第二道——万一有人改了客户端，正文也进不了 PostHog。
//
// 部署：
//   wrangler secret put POSTHOG_API_KEY     # PostHog 项目的 Project API Key（只写不读）
//   wrangler deploy
// 然后在 Cloudflare 面板给这个 Worker 绑上 telemetry.narracat.com 这个自定义域。

interface Env {
  /** PostHog 项目写入 Key。缺失时 Worker 直接 204——宁可丢数据，不要泄 Key。 */
  POSTHOG_API_KEY?: string
  /** 上游区域端点，默认欧盟区。 */
  POSTHOG_HOST?: string
}

const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com'

/**
 * 事件字典白名单。**必须与 shared/types/telemetry.ts 的 TELEMETRY_ALLOWED_PROP_KEYS 保持一致。**
 * 两处刻意各写一份而不是共享代码：Worker 与 App 是分开部署的，不能假设线上跑的客户端
 * 就是当前这份源码——服务端要能独立地对着字典拦住任何意外字段。
 */
const ALLOWED: Record<string, readonly string[]> = {
  app_started: ['app_version', 'os', 'arch'],
  feature_used: ['module'],
  chapter_write_started: ['provider', 'model_id', 'chapter_bucket'],
  chapter_write_finished: ['provider', 'model_id', 'outcome', 'duration_bucket'],
  error_occurred: ['code', 'module'],
  telemetry_opt_out: ['app_version'],
}

/** 单个属性值的形态闸：枚举值不可能很长、更不可能带换行。带了就说明它不是枚举值。 */
function acceptableValue(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  return value.length <= 64 && !/[\r\n]/.test(value)
}

/** distinct_id 只接受 UUID：客户端只会发 UUID，别的形态一律当作被篡改过。 */
function acceptableDistinctId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
}

interface CleanEvent {
  event: string
  distinct_id: string
  timestamp: string
  properties: Record<string, string | number>
}

/** 按白名单裁剪一条事件；不合格返回 null（丢弃这一条，不影响同批其他条）。 */
export function sanitizeIncomingEvent(input: unknown): CleanEvent | null {
  if (typeof input !== 'object' || input === null) return null
  const entry = input as Record<string, unknown>
  const name = entry.event
  if (typeof name !== 'string' || !(name in ALLOWED)) return null
  if (!acceptableDistinctId(entry.distinct_id)) return null

  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : ''
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null

  const incoming =
    typeof entry.properties === 'object' && entry.properties !== null
      ? (entry.properties as Record<string, unknown>)
      : {}
  const properties: Record<string, string | number> = {}
  for (const key of [...ALLOWED[name]!, 'schema_version']) {
    const value = incoming[key]
    if (value === undefined || value === null) continue
    if (!acceptableValue(value)) return null
    properties[key] = value
  }

  return { event: name, distinct_id: entry.distinct_id, timestamp, properties }
}

/** 一次请求最多接这么多条：客户端队列上限是 500，留一点余量即可，其余当作异常流量拒掉。 */
const MAX_BATCH = 600

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('narracat telemetry proxy', { status: 405 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return new Response(null, { status: 400 })
    }

    const rawBatch = (body as { batch?: unknown })?.batch
    if (!Array.isArray(rawBatch) || rawBatch.length === 0 || rawBatch.length > MAX_BATCH) {
      return new Response(null, { status: 400 })
    }

    const batch = rawBatch.map(sanitizeIncomingEvent).filter((entry): entry is CleanEvent => entry !== null)
    // 整批都不合格 → 400，让客户端别再重试这批（客户端对 4xx 会直接丢弃，见 telemetry-runtime.ts）。
    if (batch.length === 0) return new Response(null, { status: 400 })

    const apiKey = env.POSTHOG_API_KEY
    // Key 没配好时对客户端谎报成功：这是我们的运维问题，不该让用户的机器反复重试。
    if (!apiKey) return new Response(null, { status: 204 })

    const upstream = await fetch(`${env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, batch }),
    })

    // 上游 5xx 原样回传，客户端据此保留队列下次重试；其余一律 204。
    return new Response(null, { status: upstream.status >= 500 ? 502 : 204 })
  },
}
