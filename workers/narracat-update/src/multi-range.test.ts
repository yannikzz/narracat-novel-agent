import { describe, expect, test } from 'bun:test'
import {
  SUBREQUEST_BUDGET,
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
} from './multi-range.ts'

describe('parseByteRanges', () => {
  test('多区间按原顺序解析', () => {
    expect(parseByteRanges('bytes=0-99, 200-299, 500-599')).toEqual([
      { start: 0, end: 99 },
      { start: 200, end: 299 },
      { start: 500, end: 599 },
    ])
  })

  test('单区间也解析（调用方按长度判断走不走多区间路径）', () => {
    expect(parseByteRanges('bytes=0-99')).toEqual([{ start: 0, end: 99 }])
  })

  test('空格与大小写都容得下', () => {
    expect(parseByteRanges('BYTES = 0 - 9 ,  20 - 29 ')).toEqual([
      { start: 0, end: 9 },
      { start: 20, end: 29 },
    ])
  })

  test('没有 Range 头', () => {
    expect(parseByteRanges(null)).toBeNull()
    expect(parseByteRanges('')).toBeNull()
  })

  // 下面这些一律返回 null 让请求原样转给上游。本层拼出的字节会被写进安装包，
  // 解析上宽容一点就是拿更新包的完整性冒险。
  test('开放区间与后缀区间不接（长度要靠总大小才能定）', () => {
    expect(parseByteRanges('bytes=500-')).toBeNull()
    expect(parseByteRanges('bytes=-500')).toBeNull()
    expect(parseByteRanges('bytes=0-99, 200-')).toBeNull()
  })

  test('非升序不接——multipart 各段必须与请求顺序一一对应，排序会错位', () => {
    expect(parseByteRanges('bytes=200-299, 0-99')).toBeNull()
  })

  test('区间重叠不接', () => {
    expect(parseByteRanges('bytes=0-99, 50-199')).toBeNull()
    expect(parseByteRanges('bytes=0-99, 99-199')).toBeNull()
  })

  test('起点大于终点不接', () => {
    expect(parseByteRanges('bytes=99-0')).toBeNull()
  })

  test('非 bytes 单位不接', () => {
    expect(parseByteRanges('items=0-99')).toBeNull()
  })

  test('数字不合法不接', () => {
    expect(parseByteRanges('bytes=a-b')).toBeNull()
    expect(parseByteRanges('bytes=0-99,')).toBeNull()
    expect(parseByteRanges('bytes=')).toBeNull()
    // 超出安全整数范围的数字会在后续运算里悄悄失真，直接拒掉
    expect(parseByteRanges('bytes=0-99999999999999999999')).toBeNull()
  })
})

describe('planFetchGroups', () => {
  const ranges: ByteRange[] = [
    { start: 0, end: 99 },
    { start: 1000, end: 1099 },
    { start: 1100, end: 1199 },
  ]

  test('预算够时一段一组，一个字节都不多下', () => {
    const groups = planFetchGroups(ranges, 5)!
    expect(groups).toHaveLength(3)
    expect(totalFetchBytes(groups)).toBe(300)
  })

  test('预算不够时在最大的间隙处切开', () => {
    // 间隙：0-99 与 1000-1099 之间 900 字节；1000-1099 与 1100-1199 之间 0 字节。
    // 压到 2 组就该在那个 900 字节的间隙处切，把后两段并起来。
    const groups = planFetchGroups(ranges, 2)!
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({ start: 0, end: 99, ranges: [ranges[0]] })
    expect(groups[1]).toEqual({ start: 1000, end: 1199, ranges: [ranges[1], ranges[2]] })
    expect(totalFetchBytes(groups)).toBe(300) // 相邻两段之间无间隙，合并不多下
  })

  test('压到 1 组就是首尾连成一片', () => {
    const groups = planFetchGroups(ranges, 1)!
    expect(groups).toHaveLength(1)
    expect(groups[0].start).toBe(0)
    expect(groups[0].end).toBe(1199)
    expect(groups[0].ranges).toHaveLength(3)
    expect(totalFetchBytes(groups)).toBe(1200) // 把 900 字节的间隙也带下来了
  })

  test('切点选最大的那些间隙——多下载量最小', () => {
    const spread: ByteRange[] = [
      { start: 0, end: 9 },
      { start: 100, end: 109 }, // 前面间隙 90
      { start: 10_000, end: 10_009 }, // 前面间隙 9890 ← 最大，应在此切开
      { start: 10_100, end: 10_109 }, // 前面间隙 90
    ]
    const groups = planFetchGroups(spread, 2)!
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ start: 0, end: 109 })
    expect(groups[1]).toMatchObject({ start: 10_000, end: 10_109 })
    expect(totalFetchBytes(groups)).toBe(110 + 110)
  })

  test('每组的区间加起来还是原来那些，一个不丢一个不串', () => {
    const groups = planFetchGroups(ranges, 2)!
    expect(groups.flatMap((group) => group.ranges)).toEqual(ranges)
  })

  test('空输入或预算为零', () => {
    expect(planFetchGroups([], 5)).toBeNull()
    expect(planFetchGroups(ranges, 0)).toBeNull()
  })
})

describe('resolveGroupBudget', () => {
  // 免费版每次调用 50 个子请求，重定向单独算一个——这两个数字是实测出来的，
  // 改动前先读 multi-range.ts 顶部那段说明。
  test('复用签名地址时每组只花 1 个额度', () => {
    expect(resolveGroupBudget(true)).toBe(46)
  })

  test('拿不到签名地址时每组要走一次 302，额度减半', () => {
    expect(resolveGroupBudget(false)).toBe(23)
  })

  test('两种情况都不能超预算（含探路与余量）', () => {
    expect(resolveGroupBudget(true) * 1 + 2 + 2).toBeLessThanOrEqual(SUBREQUEST_BUDGET)
    expect(resolveGroupBudget(false) * 2 + 2 + 2).toBeLessThanOrEqual(SUBREQUEST_BUDGET)
  })
})

describe('isWorthDownloading', () => {
  // 碎片太散时合并会把大半个文件拖下来，那还不如让客户端回落全量——
  // 全量是一条连续流，比几十段拼接更快也更不容易出错。
  test('只下一小半划算', () => {
    expect(isWorthDownloading(17_000_000, 244_000_000)).toBe(true)
  })

  test('超过一半就不划算', () => {
    expect(isWorthDownloading(150_000_000, 244_000_000)).toBe(false)
  })

  test('正好一半仍然接受', () => {
    expect(isWorthDownloading(50, 100)).toBe(true)
  })

  test('总大小不合法时不接', () => {
    expect(isWorthDownloading(10, 0)).toBe(false)
  })
})

describe('parseTotalSize', () => {
  test('从探路响应里取出文件总大小', () => {
    expect(parseTotalSize('bytes 0-0/256435237')).toBe(256435237)
  })

  test('格式不对或长度未知时拿不到', () => {
    expect(parseTotalSize(null)).toBeNull()
    expect(parseTotalSize('bytes 0-0/*')).toBeNull()
    expect(parseTotalSize('bytes */256435237')).toBeNull()
    expect(parseTotalSize('0-0/256435237')).toBeNull()
    expect(parseTotalSize('bytes 0-0/0')).toBeNull()
  })
})

describe('multipart 组装', () => {
  test('分隔串只含字母数字，省掉客户端的引号转义', () => {
    const boundary = createBoundary()
    expect(boundary).toMatch(/^[A-Za-z0-9]+$/)
    expect(createBoundary()).not.toBe(boundary)
  })

  // electron-updater 的 DataSplitter 从响应开头就期望 `--<boundary>`，
  // 首段前面多一个 \r\n 会让它第一段就对不齐。
  test('首段前面不带换行，后续段带', () => {
    const range = { start: 10, end: 19 }
    expect(buildPartHeader('B', range, 100, true)).toBe(
      '--B\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 10-19/100\r\n\r\n',
    )
    expect(buildPartHeader('B', range, 100, false)).toBe(
      '\r\n--B\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 10-19/100\r\n\r\n',
    )
  })

  test('头部以空行结束——DataSplitter 靠 \\r\\n\\r\\n 找 body 起点', () => {
    expect(buildPartHeader('B', { start: 0, end: 1 }, 9, true).endsWith('\r\n\r\n')).toBe(true)
  })

  test('结束分隔串', () => {
    expect(buildClosingBoundary('B')).toBe('\r\n--B--\r\n')
  })
})
