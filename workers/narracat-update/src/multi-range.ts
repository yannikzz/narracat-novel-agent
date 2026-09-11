// 多区间 Range 的翻译层（issue #103 顺带发现：Windows 每次更新都全量下 244MB）。
//
// electron-updater 的差量下载靠 blockmap 算出「哪些字节块变了」，然后发**一个多区间
// Range 请求**（`bytes=0-99, 200-299, ...`）把它们一次取回。GitHub Releases 的资产实际
// 存在 Azure Blob Storage 上，而 Azure **只支持单区间**，多区间一律回 501 Not Implemented
// ——于是差量每次都失败回落全量。实测：
//
//   Range: bytes=0-99              → 206 ✅
//   Range: bytes=0-99, 200-299     → 501 ❌
//
// 上游缺的这块能力由本文件补上：把多区间请求拆成上游认的单区间请求，再把结果拼回标准
// `multipart/byteranges` 还给客户端。客户端一个字节都不用改——差量逻辑它本来就有。
//
// 实测收益（0.4.0 → 0.4.1，用两版真实 blockmap 算）：
//   全量 244.6 MB → 差量 11.8 MB（4.8%），合并取数后实下 ~16.9 MB（6.9%）
//
// ## 子请求预算（免费版实测值，不是查文档来的）
//
// Cloudflare 免费版**每次调用最多 50 个子请求**，而且**重定向单独算一个**：
// github.com 的下载地址会 302 跳到 Azure，所以一个 `redirect: 'follow'` 的请求吃掉 2 个额度
// （实测发 120 个请求断在第 25 个 = 50 ÷ 2）。拿到跳转后的签名地址复用，才能把额度用满。
// 预算算法见 resolveGroupBudget()。
//
// ## 为什么合并区间
//
// 差量碎片有 238 个，逐个取就是 238+ 个子请求，远超预算。把挨得近的碎片合并成一次取
// （中间的间隙数据一起下载后丢弃）能把请求数压到个位数，代价是多下几 MB：
//
//   不合并  238 个请求  11.8 MB  ❌ 爆预算
//   16KB    179 个请求  12.5 MB  ❌ 爆预算
//   32KB     32 个请求  16.1 MB  ✅
//   48KB     10 个请求  16.9 MB  ✅ ← 余量 4 倍，推荐
//
// planFetchGroups() 不用固定阈值，而是**按预算反推**：要压到 K 组，就在最大的 K-1 个间隙处
// 切开，其余合并——这样在「正好 K 组」的前提下多下载量最小，且碎片分布再怪也不会爆预算
// （跨多个版本升级时碎片会比上面这一跳更散）。

/** 闭区间 [start, end]，与 HTTP Range 头的语义一致。 */
export interface ByteRange {
  start: number
  end: number
}

/** 一次上游请求：取 [start, end]，从中切出 ranges 里的各段，间隙丢弃。 */
export interface FetchGroup {
  start: number
  end: number
  ranges: ByteRange[]
}

/**
 * 解析 Range 头，只认 electron-updater 会发的那种形式：`bytes=a-b, c-d, ...`，
 * 每段起止都写明、升序、互不重叠。
 *
 * 任何一点不满足都返回 null（调用方据此原样转发给上游，维持现有行为）。严格是刻意的：
 * 本层拼出的响应会被客户端当成安装包的字节，宽容解析等于拿更新包的完整性冒险。
 * 尤其是**顺序**——multipart 各段必须与请求里的顺序一一对应，一旦排序或去重就对不上了，
 * 所以这里只校验、不修正。
 */
export function parseByteRanges(header: string | null): ByteRange[] | null {
  if (!header) return null

  const spec = /^\s*bytes\s*=\s*(.+)$/i.exec(header)
  if (!spec) return null

  const ranges: ByteRange[] = []
  for (const piece of spec[1].split(',')) {
    // 开放区间（`500-`）与后缀区间（`-500`）都不接：长度要靠文件总大小才能定，
    // 而本层在发探路请求前还不知道总大小。差量下载也从不发这两种。
    const matched = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(piece)
    if (!matched) return null

    const start = Number(matched[1])
    const end = Number(matched[2])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null

    const previous = ranges[ranges.length - 1]
    if (previous && start <= previous.end) return null // 非升序或有重叠

    ranges.push({ start, end })
  }

  return ranges.length > 0 ? ranges : null
}

/**
 * 把区间分组，使组数 ≤ maxGroups 且多下载的字节最少。
 *
 * 组数够用时一段一组（一个字节都不多下）；不够时在**最大的 maxGroups-1 个间隙**处切开，
 * 其余合并——把最贵的间隙留作切点，多下载量就是最小的。
 *
 * maxGroups < 1 或 ranges 为空返回 null；合并后的总取数量由调用方决定是否划算
 * （见 isWorthDownloading）。
 */
export function planFetchGroups(ranges: ByteRange[], maxGroups: number): FetchGroup[] | null {
  if (ranges.length === 0 || maxGroups < 1) return null

  // 需要切开的位置：ranges[i-1] 与 ranges[i] 之间。留下最大的若干个间隙作为切点。
  const cutAfter = new Set<number>()
  if (ranges.length > maxGroups) {
    const gaps = ranges
      .slice(1)
      .map((range, index) => ({ index, size: range.start - ranges[index].end - 1 }))
      .sort((a, b) => b.size - a.size)
    for (const gap of gaps.slice(0, maxGroups - 1)) cutAfter.add(gap.index)
  } else {
    for (let index = 0; index < ranges.length - 1; index++) cutAfter.add(index)
  }

  const groups: FetchGroup[] = []
  let current: FetchGroup | null = null
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]
    if (current === null) {
      current = { start: range.start, end: range.end, ranges: [range] }
    } else {
      current.end = range.end
      current.ranges.push(range)
    }
    if (cutAfter.has(index) || index === ranges.length - 1) {
      groups.push(current)
      current = null
    }
  }

  return groups
}

/** 分组后实际要下载的字节数（含被合并进来的间隙）。 */
export function totalFetchBytes(groups: FetchGroup[]): number {
  return groups.reduce((sum, group) => sum + (group.end - group.start + 1), 0)
}

/**
 * 合并到这个地步还值不值得走差量。
 *
 * 碎片过散时合并会把大半个文件都拖下来，那还不如让客户端直接回落全量下载——全量是一条
 * 连续流，比几十段拼接更快也更不容易出错。取一半作为分界。
 */
export function isWorthDownloading(fetchBytes: number, totalSize: number): boolean {
  return totalSize > 0 && fetchBytes <= totalSize / 2
}

/** 免费版每次调用的子请求上限（实测值）。 */
export const SUBREQUEST_BUDGET = 50
/** 探路请求的开销：一次 302 + 一次 206，各算一个子请求。 */
const PROBE_COST = 2
/** 留给意外重试/边缘情况的余量，不要把预算用到一个不剩。 */
const RESERVED = 2

/**
 * 还能发几个取数请求。
 *
 * 拿到跳转后的签名地址后每组只花 1 个额度；万一拿不到（上游不再重定向，或响应没带最终
 * 地址），每组仍要走一次 302，额度减半。两种情况都不能超预算，所以这里按实际情况算。
 */
export function resolveGroupBudget(canReuseSignedUrl: boolean): number {
  const perGroup = canReuseSignedUrl ? 1 : 2
  return Math.floor((SUBREQUEST_BUDGET - PROBE_COST - RESERVED) / perGroup)
}

/**
 * multipart 的分隔串。只用 [A-Za-z0-9]，避免客户端解析时要处理引号转义。
 */
export function createBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `narracat${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * 一段 part 的头部。
 *
 * electron-updater 的 DataSplitter 拿到后**整段忽略头内容**（源码原话：`header list is
 * ignored, we don't need it`），只按 `\r\n\r\n` 找头尾、按自己算出的长度读 body、按
 * `\r\n--<boundary>` 找下一段。所以这里按 RFC 7233 老实写全即可，不必迎合谁。
 *
 * 首段前面不带 `\r\n`：DataSplitter 从响应开头就期望 `--<boundary>`。
 */
export function buildPartHeader(
  boundary: string,
  range: ByteRange,
  totalSize: number,
  isFirst: boolean,
): string {
  return [
    isFirst ? '' : '\r\n',
    `--${boundary}\r\n`,
    'Content-Type: application/octet-stream\r\n',
    `Content-Range: bytes ${range.start}-${range.end}/${totalSize}\r\n`,
    '\r\n',
  ].join('')
}

/** 结束分隔串。 */
export function buildClosingBoundary(boundary: string): string {
  return `\r\n--${boundary}--\r\n`
}

/**
 * 从 `Content-Range: bytes 0-0/256435237` 里取文件总大小。拿不到返回 null。
 *
 * 总大小要写进每一段 part 的 Content-Range，取不到就不能拼——宁可回落全量。
 */
export function parseTotalSize(contentRange: string | null): number | null {
  if (!contentRange) return null
  const matched = /^\s*bytes\s+\d+\s*-\s*\d+\s*\/\s*(\d+)\s*$/i.exec(contentRange)
  if (!matched) return null
  const total = Number(matched[1])
  return Number.isSafeInteger(total) && total > 0 ? total : null
}
