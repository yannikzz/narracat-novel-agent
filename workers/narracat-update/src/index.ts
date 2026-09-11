// 更新源加速代理（开源路线图 ④）。把 update.narracat.com/<平台>/<文件名>
// 翻译成 GitHub Releases 的下载地址并转发，让国内用户不必直连 GitHub。
//
// 为什么不调 GitHub API：匿名接口 60 次/小时/IP，而 Worker 的出口 IP 高度共享，
// 必然超限。改用 GitHub 两条稳定的地址规律，版本号直接从文件名解析：
//   latest-mac.yml                  → releases/latest/download/latest-mac.yml
//   NarraCat-<版本>-mac-arm64.zip   → releases/download/v<版本>/<同名>
// 代价是「哪个版本是最新」完全由 GitHub 的 latest 标记决定——这正好成了回退开关
// （网页上把旧 release 设为 latest 即可，见 README）。
//
// 本 Worker 无密钥：发布仓是 public，资产匿名可下载。
//
// 另外补了一层上游缺失的能力：多区间 Range（Windows 差量更新靠它，Azure Blob 不支持）。
// 见 multi-range.ts。

import {
  buildClosingBoundary,
  buildPartHeader,
  createBoundary,
  isWorthDownloading,
  parseByteRanges,
  parseTotalSize,
  planFetchGroups,
  resolveGroupBudget,
  totalFetchBytes,
  type ByteRange,
  type FetchGroup,
} from './multi-range.ts'

/** 安装包所在的公开仓。与开发主仓不是同一个。 */
const RELEASE_REPO = 'yannikzz/narracat-novel-agent'
const RELEASES_BASE = `https://github.com/${RELEASE_REPO}/releases`

/** 允许的平台目录（mac arm64 与 win x64 两个，不做 mac Intel、不做 Windows ARM）。 */
const PLATFORM_DIRS = new Set(['mac-arm64', 'win-x64'])

/** electron-updater 的清单文件名（不带版本号，恒取最新 release）。 */
const MANIFEST_NAMES = new Set(['latest-mac.yml', 'latest.yml'])

/** 产物命名：NarraCat-<主.次.补>-<平台>.<扩展名>，扩展名可再带 .blockmap。 */
const ASSET_NAME_PATTERN = /^NarraCat-(\d+\.\d+\.\d+)-[a-z0-9-]+\.[a-z0-9.]+$/

export function isManifestPath(pathname: string): boolean {
  const fileName = pathname.split('/').pop() ?? ''
  return MANIFEST_NAMES.has(fileName)
}

/**
 * 把对外路径翻译成 GitHub 下载地址；无法翻译一律返回 null（调用方回 404）。
 * 这里是公网入口，白名单式判断：平台目录、文件名格式、路径层级三样都必须过。
 */
export function resolveUpstreamUrl(pathname: string): string | null {
  // 先解码再校验，避免 %2F、%2E%2E 这类编码绕过白名单。
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('..') || decoded.includes('\\')) return null

  const parts = decoded.replace(/^\/+/, '').split('/')
  if (parts.length !== 2) return null

  const [platform, fileName] = parts
  if (!PLATFORM_DIRS.has(platform)) return null

  if (MANIFEST_NAMES.has(fileName)) {
    return `${RELEASES_BASE}/latest/download/${fileName}`
  }

  const matched = ASSET_NAME_PATTERN.exec(fileName)
  if (!matched) return null
  return `${RELEASES_BASE}/download/v${matched[1]}/${fileName}`
}

/**
 * 对外的永久下载地址。给人用（公众号、群公告、落地页这类发出去就改不动的地方），
 * 不是给 electron-updater 用的——自动更新走清单，不经过这里。
 *
 * 地址不带版本号，指向哪一版由 GitHub 的 latest 标记决定：先取清单读出版本号，
 * 再转发到该版本的产物。代价是每次多一次上游往返，换来链接永不失效。
 *
 * 白名单精确匹配：只有登记过的地址才认，免得凭空拼出不存在的产物名。
 *
 * **这里的 key 与 `scripts/update-feed.mjs` 的 MAC_LATEST_DOWNLOAD_FILE /
 * WIN_LATEST_DOWNLOAD_FILE 是同一件事**，本 Worker 独立部署、不 import 本仓代码，
 * 只能靠这条注释互指：改一边必须同时改另一边（那边有一条断言扫本文件源码兜底）。
 */
const DOWNLOAD_ALIASES: Record<string, DownloadAlias> = {
  '/mac-arm64/latest.dmg': { manifestName: 'latest-mac.yml', assetSuffix: '-mac-arm64.dmg' },
  // Windows 的更新载体就是 NSIS 安装器本身（不像 mac 另有 zip），所以永久链接直指 exe。
  // key 与 scripts/update-feed.mjs 的 WIN_LATEST_DOWNLOAD_FILE 是同一件事，改一边必须同改另一边。
  '/win-x64/latest.exe': { manifestName: 'latest.yml', assetSuffix: '-win-x64.exe' },
}

export type DownloadAlias = {
  /** 该平台的 electron-updater 清单文件名，版本号从它里面读。 */
  manifestName: string
  /** 产物名在版本号之后的部分，拼作 NarraCat-<版本><assetSuffix>。 */
  assetSuffix: string
}

export function resolveDownloadAlias(pathname: string): DownloadAlias | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  return DOWNLOAD_ALIASES[decoded] ?? null
}

export function aliasManifestUrl(alias: DownloadAlias): string {
  return `${RELEASES_BASE}/latest/download/${alias.manifestName}`
}

/**
 * 从清单里取版本号。**必须严格三段数字**——这个值要拼进上游 URL，
 * 松一点就等于允许清单内容左右我们去请求什么。
 */
export function parseManifestVersion(manifestText: string): string | null {
  return /^version:[ \t]*(\d+\.\d+\.\d+)[ \t]*$/m.exec(manifestText)?.[1] ?? null
}

export function buildAliasAssetUrl(alias: DownloadAlias, version: string): string {
  return `${RELEASES_BASE}/download/v${version}/NarraCat-${version}${alias.assetSuffix}`
}

/**
 * 透传给上游的请求头。**Range 必须透传**——electron-updater 的差量下载
 * （blockmap）靠它只取变化的字节块，丢了就退化成每次全量下载 275MB。
 */
function forwardHeaders(incoming: Headers): Headers {
  const headers = new Headers()
  for (const name of ['range', 'if-none-match', 'if-modified-since', 'accept-encoding']) {
    const value = incoming.get(name)
    if (value) headers.set(name, value)
  }
  headers.set('user-agent', 'narracat-update-proxy')
  return headers
}

/**
 * 上游响应头只白名单转发，不整份复制。
 *
 * 原因：workerd 在上游返回 gzip 时会**透明解压 body，却保留解压前的
 * content-encoding / content-length**（workerd 已知行为，因为 forwardHeaders()
 * 把客户端的 accept-encoding 转给了上游，上游因此可能选择 gzip）。若整份转发
 * 响应头，客户端会拿到「声称 gzip、长度却对不上」的响应——风险最高的是
 * latest-mac.yml，它是整套自动更新的入口也是回退的唯一开关，一旦被 gzip，
 * 版本检测可能解析失败或截断。
 *
 * 因此：content-encoding 一律不转发（交给运行时按实际 body 重新决定传输编码）；
 * 上游带 content-encoding 时 content-length 也不转发（那个长度是压缩前后不一致
 * 的根源，转发了等于把错误的账目发给客户端）。顺带效果：不会把上游可能带的
 * Set-Cookie、CSP 等无关头转给客户端——代理对外只应该暴露白名单，而不是靠黑名单
 * 事后剔除。
 */
function forwardResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers()
  const upstreamEncoded = Boolean(upstream.get('content-encoding'))
  for (const name of ['content-type', 'content-length', 'etag', 'last-modified', 'accept-ranges', 'content-range']) {
    if (name === 'content-length' && upstreamEncoded) continue
    const value = upstream.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

/** 地址不带版本号 = 内容会变，一律不缓存；否则回退要等边缘缓存过期。 */
const MUTABLE_CACHE_CONTROL = 'no-cache, max-age=0'
/** 按版本号寻址的包内容不可变，可以长缓存。 */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * 探路请求：拿文件总大小，顺便拿到跳转后的签名地址。
 *
 * 取 `bytes=0-0` 一个字节，图的是响应头里的 `Content-Range: bytes 0-0/<总大小>`。
 * `redirect: 'follow'` 之后 `response.url` 是最终地址（github.com → Azure 的签名 URL，
 * 实测约 45 分钟有效，单次更新内复用绰绰有余）；复用它能让后续每组只花 1 个子请求额度
 * 而不是 2 个。拿不到就退回原地址，预算减半但仍然可用。
 */
async function probeUpstream(
  upstream: string,
): Promise<{ totalSize: number; assetUrl: string; canReuseSignedUrl: boolean } | null> {
  const response = await fetch(upstream, {
    headers: { Range: 'bytes=0-0', 'user-agent': 'narracat-update-proxy' },
    redirect: 'follow',
  })
  // 只要头，body 必须显式丢掉，否则连接悬着不放。
  await response.body?.cancel()

  if (response.status !== 206) return null

  const totalSize = parseTotalSize(response.headers.get('content-range'))
  if (totalSize === null) return null

  const finalUrl = response.url
  const canReuseSignedUrl = finalUrl.startsWith('https://') && finalUrl !== upstream
  return { totalSize, assetUrl: canReuseSignedUrl ? finalUrl : upstream, canReuseSignedUrl }
}

/**
 * 取一组数据，从中切出该组的各个区间写进 multipart 流，间隙丢弃。
 *
 * 边收边切边写：整个响应最大也就十几 MB，但一次性收进内存既没必要、也会把 CPU 集中在
 * 一个点上（免费版按两次 I/O 之间的 CPU 计量，流式处理天然分摊得开——实测切 40 MB 无碍）。
 */
async function pumpGroup(
  group: FetchGroup,
  assetUrl: string,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  boundary: string,
  totalSize: number,
  isFirstPart: () => boolean,
  onPartStarted: () => void,
): Promise<void> {
  const response = await fetch(assetUrl, {
    headers: { Range: `bytes=${group.start}-${group.end}`, 'user-agent': 'narracat-update-proxy' },
    redirect: 'follow',
  })
  if (response.status !== 206 || !response.body) {
    await response.body?.cancel()
    throw new Error(`上游拒绝区间请求：${response.status}`)
  }

  const reader = response.body.getReader()
  let position = group.start // 当前 chunk 起点在整个文件里的绝对偏移
  let index = 0 // 本组处理到第几个区间
  let headerWritten = false

  while (index < group.ranges.length) {
    const { done, value } = await reader.read()
    if (done) throw new Error('上游数据提前结束')

    let offset = 0
    while (offset < value.length && index < group.ranges.length) {
      const range = group.ranges[index]

      // 还没到这一段的起点：中间是被合并进来的间隙，直接跳过。
      if (position < range.start) {
        const skipped = Math.min(range.start - position, value.length - offset)
        offset += skipped
        position += skipped
        continue
      }

      if (!headerWritten) {
        await writer.write(encoder.encode(buildPartHeader(boundary, range, totalSize, isFirstPart())))
        onPartStarted()
        headerWritten = true
      }

      const taken = Math.min(range.end - position + 1, value.length - offset)
      // slice 而非 subarray：写入是排队的，不能让下游拿到一块随时可能被复用的底层 buffer。
      await writer.write(value.slice(offset, offset + taken))
      offset += taken
      position += taken

      if (position > range.end) {
        index++
        headerWritten = false
      }
    }
  }

  await reader.cancel()
}

/**
 * 多区间 Range 的应答：拆成上游认的单区间请求，拼回 `multipart/byteranges`。
 *
 * 返回 null 表示这次不接管（预算不够、碎片太散、上游不配合……），调用方照原样把请求转给
 * 上游——客户端会拿到 501 并回落全量下载，也就是本改动之前的行为。**宁可不接管，也不能
 * 交出拼错的字节**：这些字节会被写进安装包。
 */
async function serveMultiRange(
  upstream: string,
  ranges: ByteRange[],
  cacheControl: string,
): Promise<Response | null> {
  const probe = await probeUpstream(upstream)
  if (probe === null) return null

  const { totalSize, assetUrl, canReuseSignedUrl } = probe
  // 请求的区间超出文件末尾说明客户端与上游对不上（版本换了？），别猜，交还上游。
  if (ranges[ranges.length - 1].end >= totalSize) return null

  const groups = planFetchGroups(ranges, resolveGroupBudget(canReuseSignedUrl))
  if (groups === null) return null
  if (!isWorthDownloading(totalFetchBytes(groups), totalSize)) return null

  const boundary = createBoundary()
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  // 这里之后不再 return null：响应头已经发出去了，出错只能中断流，让客户端回落。
  void (async () => {
    let partCount = 0
    try {
      for (const group of groups) {
        await pumpGroup(
          group,
          assetUrl,
          writer,
          encoder,
          boundary,
          totalSize,
          () => partCount === 0,
          () => {
            partCount++
          },
        )
      }
      await writer.write(encoder.encode(buildClosingBoundary(boundary)))
      await writer.close()
    } catch (error) {
      // abort 而不是 close：截断的流会让客户端判定差量失败并回落全量下载，
      // close 则会把不完整的内容当成完整响应交出去。
      await writer.abort(error instanceof Error ? error.message : String(error)).catch(() => {})
    }
  })()

  return new Response(readable, {
    status: 206,
    headers: {
      'content-type': `multipart/byteranges; boundary=${boundary}`,
      'accept-ranges': 'bytes',
      'cache-control': cacheControl,
    },
  })
}

async function proxy(
  request: Request,
  upstream: string,
  cacheControl: string,
  downloadFileName?: string,
): Promise<Response> {
  // 多区间请求上游一律回 501，本层代劳；单区间与普通下载保持原路，不受影响。
  const ranges = request.method === 'GET' ? parseByteRanges(request.headers.get('range')) : null
  if (ranges !== null && ranges.length > 1) {
    const multiRange = await serveMultiRange(upstream, ranges, cacheControl)
    if (multiRange !== null) return multiRange
  }

  const upstreamResponse = await fetch(upstream, {
    method: request.method,
    headers: forwardHeaders(request.headers),
    redirect: 'follow',
  })

  const headers = forwardResponseHeaders(upstreamResponse.headers)
  headers.set('cache-control', cacheControl)
  // 永久链接的路径里没有版本号，不补这一行的话用户存到本地的文件就叫 latest.dmg，
  // 内测反馈时说不清自己装的是哪一版。
  if (downloadFileName) headers.set('content-disposition', `attachment; filename="${downloadFileName}"`)
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  })
}

/** 永久下载链接：先读清单定版本，再转发到该版本的产物。 */
async function serveDownloadAlias(request: Request, alias: DownloadAlias): Promise<Response> {
  // 清单必须用 GET——HEAD 拿不到 body 就解析不出版本号，哪怕本次是 HEAD 请求。
  const manifestResponse = await fetch(aliasManifestUrl(alias), {
    method: 'GET',
    headers: forwardHeaders(new Headers()),
    redirect: 'follow',
  })
  // 清单取不到或内容不对是上游故障，不是「地址不存在」。回 404 会让人以为链接给错了。
  if (!manifestResponse.ok) return new Response('Bad Gateway', { status: 502 })

  const version = parseManifestVersion(await manifestResponse.text())
  if (!version) return new Response('Bad Gateway', { status: 502 })

  const fileName = `NarraCat-${version}${alias.assetSuffix}`
  return proxy(request, buildAliasAssetUrl(alias, version), MUTABLE_CACHE_CONTROL, fileName)
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const pathname = new URL(request.url).pathname

    const alias = resolveDownloadAlias(pathname)
    if (alias) return serveDownloadAlias(request, alias)

    const upstream = resolveUpstreamUrl(pathname)
    if (!upstream) return new Response('Not Found', { status: 404 })

    // 清单是「哪个版本是最新」的唯一开关，同样不能缓存。
    return proxy(request, upstream, isManifestPath(pathname) ? MUTABLE_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL)
  },
}
