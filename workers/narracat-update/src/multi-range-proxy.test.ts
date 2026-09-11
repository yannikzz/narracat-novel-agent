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
 * 假上游：只认单区间 Range（多区间回 501，与 Azure Blob 的真实行为一致），
 * 并模拟 github.com → 签名地址的那一跳（fetch 的 redirect: 'follow' 之后
 * response.url 是最终地址，测试里用 defineProperty 还原这个行为）。
 */
function stubUpstream(
  file: Uint8Array,
  options: { redirects?: boolean; failOnRangeStart?: number } = {},
): UpstreamCall[] {
  const { redirects = true, failOnRangeStart } = options
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

    return withUrl(
      new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${end}/${file.length}`,
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

describe('多区间 Range：子请求预算', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  // 免费版每次调用 50 个子请求，重定向另算一个。这条测试守的是「无论客户端要多少段，
  // 我们发出去的请求数都不会把额度撑爆」——爆了整个响应会直接失败。
  test('段数再多也不超预算', async () => {
    const file = makeFile(500_000)
    const wanted = Array.from({ length: 500 }, (_, i) => ({ start: i * 1000, end: i * 1000 + 99 }))
    const calls = stubUpstream(file)

    const response = await requestRanges(`bytes=${wanted.map((r) => `${r.start}-${r.end}`).join(', ')}`)
    await response.arrayBuffer()

    expect(calls.length).toBeLessThanOrEqual(50)
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

    await expect(response.arrayBuffer()).rejects.toThrow()
  })
})
