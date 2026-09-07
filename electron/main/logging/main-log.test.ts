/**
 * 主进程日志文件的测试：写入格式、轮转、尾读。全走 createMainLog（不碰全局 console / process）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMainLog, warnIfSlow } from './main-log.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'narracat-main-log-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createMainLog', () => {
  test('写入一行 = 时间戳 + 等级 + 消息；目录不存在会自动建', () => {
    const log = createMainLog({ dir: join(dir, 'nested'), now: () => new Date('2026-09-07T10:00:00.000Z') })
    log.write('warn', '磁盘可能被占用')
    expect(readFileSync(log.path, 'utf8')).toBe('2026-09-07T10:00:00.000Z WARN  磁盘可能被占用\n')
  })

  test('超过 maxBytes 时轮转：当前文件变 main.1.log，超出 keep 的最老一份被丢弃', () => {
    const log = createMainLog({ dir, maxBytes: 60, keep: 2, now: () => new Date('2026-09-07T10:00:00.000Z') })
    // 每行约 50 字节：第 2 次写触发轮转，第 3 次再轮转，第 4 次把最老的挤掉。
    log.write('info', '第一段'.padEnd(30, 'x'))
    log.write('info', '第二段'.padEnd(30, 'x'))
    log.write('info', '第三段'.padEnd(30, 'x'))
    log.write('info', '第四段'.padEnd(30, 'x'))
    expect(readFileSync(log.path, 'utf8')).toContain('第四段')
    expect(readFileSync(join(dir, 'main.1.log'), 'utf8')).toContain('第三段')
    expect(readFileSync(join(dir, 'main.2.log'), 'utf8')).toContain('第二段')
    expect(existsSync(join(dir, 'main.3.log'))).toBe(false)
  })

  test('readTail：文件不存在返回空串；超长时只取尾部并丢掉被切断的首行', () => {
    const log = createMainLog({ dir })
    expect(log.readTail(1024)).toBe('')
    writeFileSync(log.path, ['第一行很长很长很长', '第二行', '第三行'].join('\n') + '\n')
    const tail = log.readTail(14)
    expect(tail).not.toContain('第一行')
    expect(tail.endsWith('第三行\n')).toBe(true)
    // 尾读不能以半个多字节字符开头
    expect(tail.startsWith('第') || tail.startsWith('行') || tail.length === 0 || /^[一-龥]/.test(tail)).toBe(true)
  })
})

describe('warnIfSlow', () => {
  test('超过阈值记一条 warn；未超过不记；结果原样透传', async () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '))
    try {
      expect(await warnIfSlow('快操作', Promise.resolve(1), 1_000)).toBe(1)
      expect(warnings).toHaveLength(0)
      expect(await warnIfSlow('慢操作', new Promise((resolve) => setTimeout(() => resolve('done'), 12)), 5)).toBe('done')
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('慢操作')
      expect(warnings[0]).toContain('磁盘可能被占用')
    } finally {
      console.warn = original
    }
  })

  test('操作抛错时照样计时，错误原样冒泡', async () => {
    const original = console.warn
    console.warn = () => {}
    try {
      await expect(warnIfSlow('炸', Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom')
    } finally {
      console.warn = original
    }
  })
})
