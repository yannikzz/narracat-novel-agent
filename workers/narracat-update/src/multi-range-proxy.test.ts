// 多区间 Range 走完整条链路的测试：拼出来的字节必须与源文件逐字节对得上。
//
// 这些字节会被 electron-updater 直接写进安装包，错一个字节就是装不上的更新包，
// 而且错法很隐蔽（sha512 对不上，用户只看到「更新失败」）。所以这里不断言「有没有返回
// multipart」，而是把响应当成客户端那样解析回来，跟源数据逐段比对。

import { afterEach, describe, expect, test } from 'bun:test'
import worker from './index.ts'

const ASSET_URL =
  'https://github.com/yannikzz/narracat-novel-agent/releases/download/v0.4.1/NarraCat-0.4.1-win-x64.exe'
const SIGNED_URL = 'https://release-assets.githubusercontent.com/signed-asset?se=2026-09-11T09%3A31%3A51Z'
const REQUEST_URL = 'https://update.narracat.com/win-x64/NarraCat-0.4.1-win-x64.exe'

/** 可预测但不重复的假文件，逐字节比对时错位一个字节就会被抓出来。 */
function makeFile(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff
  return bytes
}

interface UpstreamCall {
  url: string
  range: string | null
}

/**
 * 把字节按固定大小分多次 enqueue，模拟真实网络。
 *
 * **这件事必须做**：`new Response(uint8Array)` 会一次吐完，`reader.read()` 只跑一轮，
 * `pumpGroup` 里跨 chunk 的偏移推进（position / offset / taken）**一次都不会执行**。
 * 变异实验证实过：stub 一次吐完时，把 `position > range.end` 改成 `>=`（真 off-by-one，
 * 每段会丢最后一个字节）、把 `if (done) throw` 改成 `break`（交出缺段却格式完整的响应），
 * 全部 71 条测试**照样全绿**。改成分块之后，第一个变异当场变红。
 */
function chunkedBody(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      const next = Math.min(chunkSize, bytes.length - offset)
      controller.enqueue(bytes.slice(offset, offset + next))
      offset += next
    },
  })
}

interface StubOptions {
  redirects?: boolean
  failOnRangeStart?: number
  /** 上游每次吐多少字节。默认取个不对齐的小数，专门把切片逻辑逼到跨块分支上。 */
  chunkSize?: number
  /** 返回的 Content-Range 整体平移多少字节（模拟 CDN 对齐 / 重放导致的错位）。 */
  contentRangeShift?: number
  /** 只给前多少字节就结束（模拟上游提前断流）。 */
  truncateTo?: number
}

/**
 * 假上游：只认单区间 Range（多区间回 501，与 Azure Blob 的真实行为一致），
 * 并模拟 github.com → 签名地址的那一跳（fetch 的 redirect: 'follow' 之后
 * response.url 是最终地址，测试里用 defineProperty 还原这个行为）。
 */
function stubUpstream(file: Uint8Array, options: StubOptions = {}): UpstreamCall[] {
  const { redirects = true, failOnRangeStart, chunkSize = 7, contentRangeShift = 0, truncateTo } = options
  const calls: UpstreamCall[] = []

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const range = new Headers(init?.headers).get('range')
    calls.push({ url, range })

    if (url !== ASSET_URL && url !== SIGNED_URL) throw new Error(`未编排的上游请求: ${url}`)

    if (range === null) {
      return withUrl(new Response(file, { headers: { 'accept-ranges': 'bytes' } }), url)
    }
    // 真实上游对多区间的回应就是这个
    if (range.includes(',')) return withUrl(new Response('Not Implemented', { status: 501 }), url)

    const matched = /^bytes=(\d+)-(\d+)$/.exec(range)
    if (!matched) return withUrl(new Response('Bad Range', { status: 400 }), url)

    const start = Number(matched[1])
    const end = Number(matched[2])
    if (failOnRangeStart !== undefined && start === failOnRangeStart) {
      return withUrl(new Response('Server Error', { status: 500 }), url)
    }

    let payload = file.slice(start, end + 1)
    if (truncateTo !== undefined) payload = payload.slice(0, truncateTo)

    return withUrl(
      new Response(chunkedBody(payload, chunkSize), {
        status: 206,
        headers: {
          'content-range': `bytes ${start + contentRangeShift}-${end + contentRangeShift}/${file.length}`,
          'accept-ranges': 'bytes',
        },
      }),
      // redirect: 'follow' 之后 response.url 是跳转后的最终地址
      redirects ? SIGNED_URL : url,
    )
  }) as typeof fetch

  return calls
}

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url })
  return response
}

interface ParsedPart {
  contentRange: string
  body: Uint8Array
}

/** 按 RFC 7233 把 multipart/byteranges 拆回各段——站在客户端的角度验收。 */
function parseMultipart(buffer: Uint8Array, boundary: string): ParsedPart[] {
  const text = new TextDecoder('latin1').decode(buffer)
  const delimiter = `--${boundary}`
  const parts: ParsedPart[] = []

  let cursor = text.indexOf(delimiter)
  expect(cursor).toBe(0) // 首段必须紧贴响应开头，前面不能有多余的 \r\n

  while (cursor !== -1) {
    const afterDelimiter = cursor + delimiter.length
    if (text.startsWith('--', afterDelimiter)) break // 结束分隔串

    const headerEnd = text.indexOf('\r\n\r\n', afterDelimiter)
    expect(headerEnd).toBeGreaterThan(-1)

    const headers = text.slice(afterDelimiter, headerEnd)
    const bodyStart = headerEnd + 4
    const nextDelimiter = text.indexOf(`\r\n${delimiter}`, bodyStart)
    expect(nextDelimiter).toBeGreaterThan(-1)

    parts.push({
      contentRange: /Content-Range:\s*(.+)\r?\n?/i.exec(headers)?.[1].trim() ?? '',
      body: buffer.slice(bodyStart, nextDelimiter),
    })
    cursor = nextDelimiter + 2
  }

  return parts
}

function boundaryOf(response: Response): string {
  const contentType = response.headers.get('content-type') ?? ''
  const matched = /boundary=([^\s;]+)/.exec(contentType)
  expect(matched).not.toBeNull()
  return matched![1]
}

/**
 * 断言这条响应的流被中断了（而不是交出一份完整但错误的 body）。
 *
 * 用 try/catch 而非 `.rejects.toThrow()`：当**第一组就失败、一个字节都没来得及写**时，
 * 流以「从未产出数据就 error」的形态收场，bun 会把它额外当成一次未处理错误上报，
 * `.rejects` 拦不住那一次上报，测试会红在与断言无关的地方。
 */
async function expectStreamAborted(response: Response): Promise<void> {
  let aborted = false
  try {
    await response.arrayBuffer()
  } catch {
    aborted = true
  }
  expect(aborted).toBe(true)
}

async function requestRanges(range: string): Promise<Response> {
  return worker.fetch(new Request(REQUEST_URL, { headers: { range } }))
}

describe('多区间 Range：拼回来的字节必须与源文件一致', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('分散的几段：逐字节比对', async () => {
    const file = makeFile(100_000)
    stubUpstream(file)

    const wanted = [
      { start: 0, end: 999 },
      { start: 50_000, end: 50_499 },
      { start: 99_000, end: 99_999 },
    ]
    const response = await requestRanges(`bytes=${wanted.map((r) => `${r.start}-${r.end}`).join(', ')}`)

    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toContain('multipart/byteranges')

    const parts = parseMultipart(
      new Uint8Array(await response.arrayBuffer()),
      boundaryOf(response),
    )
    expect(parts).toHaveLength(wanted.length)
    for (const [index, range] of wanted.entries()) {
      expect(parts[index].contentRange).toBe(`bytes ${range.start}-${range.end}/${file.length}`)
      expect(parts[index].body).toEqual(file.slice(range.start, range.end + 1))
    }
  })

  // 预算不够时多段会并成一次取，中间的间隙数据必须被丢掉而不是混进 part 里。
  // 这是最容易出错也最难发现的一处：错了照样是完整的 multipart，只是字节错位。
  test('被合并成一次取时，间隙数据不会混进来', async () => {
    // 文件要足够大，否则 100 段铺下来合并后等于整个文件，会被 isWorthDownloading
    // 判成「不如回落全量」而不接管（那是对的行为，但测不到这里要测的东西）。
    const file = makeFile(500_000)

    // 100 段小区间挤在前 20KB 里，远超预算（46），必然触发合并
    const wanted = Array.from({ length: 100 }, (_, i) => ({ start: i * 200, end: i * 200 + 49 }))
    const calls = stubUpstream(file)
    const response = await requestRanges(`bytes=${wanted.map((r) => `${r.start}-${r.end}`).join(', ')}`)

    expect(response.status).toBe(206)
    const parts = parseMultipart(new Uint8Array(await response.arrayBuffer()), boundaryOf(response))

    expect(parts).toHaveLength(100)
    for (const [index, range] of wanted.entries()) {
      expect(parts[index].body).toEqual(file.slice(range.start, range.end + 1))
    }
    // 确实合并了（取数请求数远少于 100），且没超预算
    const fetches = calls.filter((call) => call.range !== 'bytes=0-0')
    expect(fetches.length).toBeLessThan(100)
    expect(calls.length).toBeLessThanOrEqual(50)
  })

  test('相邻区间（间隙为零）也不会串位', async () => {
    const file = makeFile(3000)
    stubUpstream(file)

    const response = await requestRanges('bytes=0-99, 100-199, 200-299')
    const parts = parseMultipart(new Uint8Array(await response.arrayBuffer()), boundaryOf(response))

    expect(parts).toHaveLength(3)
    expect(parts[0].body).toEqual(file.slice(0, 100))
    expect(parts[1].body).toEqual(file.slice(100, 200))
    expect(parts[2].body).toEqual(file.slice(200, 300))
  })

  test('文件末尾的区间取得到', async () => {
    const file = makeFile(5000)
    stubUpstream(file)

    const response = await requestRanges('bytes=0-9, 4990-4999')
    const parts = parseMultipart(new Uint8Array(await response.arrayBuffer()), boundaryOf(response))

    expect(parts).toHaveLength(2)
    expect(parts[1].body).toEqual(file.slice(4990, 5000))
  })
})

describe('多区间 Range：上游不老实时不能交出错字节', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  // 只看 206 是不够的：上游可以返回 206 却把 Content-Range 写成另一个偏移（CDN 对齐、重放、
  // 透明解压导致错位）。不对账的话，交出去的是一份**每段长度全对、结束分隔串齐全、字节全错**
  // 的 multipart——electron-updater 的 sha512 会兜住不变成坏包，但用户白下一次，
  // 日志里只有一行校验失败，属于最难查的那类。
  test('Content-Range 与请求不符 → 中断流，不交出错位的字节', async () => {
    const file = makeFile(100_000)
    stubUpstream(file, { contentRangeShift: 64 })

    const response = await requestRanges('bytes=0-99, 50000-50099')
    expect(response.status).toBe(206) // 头已经发出去了，只能中断流

    await expectStreamAborted(response)
  })

  test('上游 206 但少给字节 → 中断流，不交出缺段的响应', async () => {
    const file = makeFile(100_000)
    stubUpstream(file, { truncateTo: 10 })

    const response = await requestRanges('bytes=0-99, 50000-50099')

    await expectStreamAborted(response)
  })

  // 上游分块大小不该影响结果。7 与 13 都不是 2 的幂，专门用来撞跨块边界。
  test('上游无论怎么分块，拼出来的字节都一样', async () => {
    const file = makeFile(50_000)
    const wanted = [
      { start: 0, end: 999 },
      { start: 20_000, end: 20_999 },
      { start: 49_000, end: 49_999 },
    ]
    const header = `bytes=${wanted.map((r) => `${r.start}-${r.end}`).join(', ')}`

    for (const chunkSize of [1, 7, 13, 1024, 1_000_000]) {
      stubUpstream(file, { chunkSize })
      const response = await requestRanges(header)
      const parts = parseMultipart(new Uint8Array(await response.arrayBuffer()), boundaryOf(response))

      expect(parts).toHaveLength(wanted.length)
      for (const [index, range] of wanted.entries()) {
        expect(parts[index].body).toEqual(file.slice(range.start, range.end + 1))
      }
    }
  })

  test('区间末尾正好顶到文件末尾（边界）', async () => {
    const file = makeFile(10_000)
    stubUpstream(file)

    const response = await requestRanges('bytes=0-9, 9990-9999')
    const parts = parseMultipart(new Uint8Array(await response.arrayBuffer()), boundaryOf(response))

    expect(parts).toHaveLength(2)
    expect(parts[1].body).toEqual(file.slice(9990, 10_000))
  })

  test('区间末尾刚好越过文件末尾一个字节 → 不接管', async () => {
    const file = makeFile(10_000)
    stubUpstream(file)

    const response = await requestRanges('bytes=0-9, 9990-10000')

    expect(response.status).toBe(501) // 原样交还上游
  })
})

describe('多区间 Range：合成响应不可被缓存', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  // body 的内容取决于请求里的 Range 头。按 URL 缓存下来就会被当成完整文件发给下一个人。
  // 资产路径本身是 immutable 的，但那说的是「整个文件不变」，不是「这份合成响应可复用」。
  test('固定 no-store，不跟随资产路径的 immutable', async () => {
    stubUpstream(makeFile(100_000))

    const response = await requestRanges('bytes=0-99, 50000-50099')

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('cache-control')).not.toContain('immutable')
  })
})

describe('多区间 Range：子请求预算', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  // 免费版每次调用 50 个子请求，重定向另算一个。这条测试守的是「无论客户端要多少段，
  // 我们发出去的请求数都不会把额度撑爆」——爆了整个响应会直接失败。
  // ⚠️ 这条曾经是假绿：文件只有 500KB 时 500 段铺开会被判成「不如回落全量」，实际只发了
  // 1 个探路请求就返回了，`calls.length <= 50` 当然成立——根本没验到预算。文件必须足够大，
  // 让它真的走进接管路径，断言才有意义。
  test('段数再多也不超预算（必须真的接管，不能靠不接管蒙混）', async () => {
    const file = makeFile(5_000_000)
    const wanted = Array.from({ length: 500 }, (_, i) => ({ start: i * 1000, end: i * 1000 + 99 }))
    const calls = stubUpstream(file)

    const response = await requestRanges(`bytes=${wanted.map((r) => `${r.start}-${r.end}`).join(', ')}`)
    const parts = parseMultipart(new Uint8Array(await response.arrayBuffer()), boundaryOf(response))

    // 先证明确实接管了（返回的是 multipart 且段数对得上），再谈预算
    expect(response.status).toBe(206)
    expect(parts).toHaveLength(500)
    expect(calls.length).toBeLessThanOrEqual(50)
    // 取数请求数 = 分组数，必须远少于段数，否则等于没合并
    expect(calls.length).toBeLessThan(wanted.length)
  })

  test('复用签名地址——除探路外都打跳转后的地址，每个只花一个额度', async () => {
    const file = makeFile(100_000)
    const calls = stubUpstream(file, { redirects: true })

    const response = await requestRanges('bytes=0-99, 50000-50099, 99000-99099')
    await response.arrayBuffer()

    expect(calls[0].url).toBe(ASSET_URL) // 探路走原地址
    expect(calls[0].range).toBe('bytes=0-0')
    for (const call of calls.slice(1)) expect(call.url).toBe(SIGNED_URL)
  })

  test('拿不到签名地址时仍然可用，只是额度减半', async () => {
    const file = makeFile(100_000)
    const calls = stubUpstream(file, { redirects: false })

    const response = await requestRanges('bytes=0-99, 50000-50099')
    const parts = parseMultipart(new Uint8Array(await response.arrayBuffer()), boundaryOf(response))

    expect(parts).toHaveLength(2)
    expect(parts[0].body).toEqual(file.slice(0, 100))
    for (const call of calls) expect(call.url).toBe(ASSET_URL)
  })
})

describe('多区间 Range：接不住就原样交还上游', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  // 拼不出来时必须退回改动之前的行为（客户端拿到 501 → 回落全量下载），
  // 绝不能交出拼错的字节。
  test('探路拿不到总大小就不接管', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range')
      calls.push(range ?? '')
      if (range === 'bytes=0-0') {
        // 上游不认 Range 了：没有 206、没有 content-range
        return withUrl(new Response('whole file', { status: 200 }), ASSET_URL)
      }
      return withUrl(new Response('Not Implemented', { status: 501 }), ASSET_URL)
    }) as typeof fetch

    const response = await requestRanges('bytes=0-99, 200-299')

    expect(response.status).toBe(501) // 上游原样的回应
    expect(response.headers.get('content-type') ?? '').not.toContain('multipart')
  })

  test('区间超出文件末尾就不接管（客户端与上游对不上，别猜）', async () => {
    const file = makeFile(1000)
    stubUpstream(file)

    const response = await requestRanges('bytes=0-99, 5000-5099')

    expect(response.status).toBe(501)
  })

  test('单区间保持原路，不进多区间逻辑', async () => {
    const file = makeFile(1000)
    const calls = stubUpstream(file)

    const response = await requestRanges('bytes=100-199')

    expect(response.status).toBe(206)
    expect(response.headers.get('content-type') ?? '').not.toContain('multipart')
    expect(calls).toHaveLength(1) // 没有探路请求
    expect(calls[0].range).toBe('bytes=100-199')
  })

  test('没有 Range 的普通下载完全不受影响', async () => {
    const file = makeFile(1000)
    const calls = stubUpstream(file)

    const response = await worker.fetch(new Request(REQUEST_URL))

    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(file)
    expect(calls).toHaveLength(1)
  })

  test('格式不合法的多区间原样转给上游，由上游裁决', async () => {
    const file = makeFile(1000)
    const calls = stubUpstream(file)

    // 非升序：本层拒绝解析
    const response = await requestRanges('bytes=200-299, 0-99')

    expect(response.status).toBe(501)
    expect(calls).toHaveLength(1)
    expect(calls[0].range).toBe('bytes=200-299, 0-99')
  })

  // 头已经发出去之后才出错，只能中断流。客户端会判定差量失败并回落全量——
  // 这正是要的结果：宁可截断，也不能把不完整的内容当成完整响应交出去。
  test('取数中途失败时流被中断，而不是交出残缺内容', async () => {
    const file = makeFile(100_000)
    stubUpstream(file, { failOnRangeStart: 50_000 })

    const response = await requestRanges('bytes=0-99, 50000-50099, 99000-99099')
    expect(response.status).toBe(206)

    await expectStreamAborted(response)
  })
})
