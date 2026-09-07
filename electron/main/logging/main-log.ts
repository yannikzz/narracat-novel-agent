/**
 * 主进程日志文件（用户可回传的取证底座）。
 *
 * ## 为什么
 *
 * 打包版主进程此前没有任何日志落盘：`console.warn` 全部丢进虚空。Windows 用户报「提交按钮点不了」
 * 我们只能拿截图猜（2026-09-07），而代码里那条链上的每个失败分支其实都有 console.warn。
 * 这个模块把 console 五个方法接到文件上，再把未处理异常/拒绝也记进去，一行代码不用改就全部落盘。
 *
 * ## 形态
 *
 * - 位置：`<userData>/logs/main.log`，超过 maxBytes 轮转成 main.1.log … main.{keep}.log。
 * - 同步 appendFileSync：写量小（只有 warn/error 与少量 info），同步保证顺序且崩溃前不丢；
 *   写失败静默（日志不能反过来把 App 弄挂）。
 * - 未处理异常用 `uncaughtExceptionMonitor`（只旁观、**不改变**Electron 默认行为）；
 *   未处理拒绝挂 `unhandledRejection` 只记录（主进程默认也只是打印警告，语义不变）。
 * - 不脱敏：本机文件要保真。脱敏在「报告问题」组装诊断包时做（shared/lib/diagnostics-report）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'

export type MainLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface MainLogOptions {
  dir: string
  /** 单文件上限，默认 2MB。 */
  maxBytes?: number
  /** 轮转保留份数（不含当前文件），默认 3。 */
  keep?: number
  now?: () => Date
}

export interface MainLog {
  readonly path: string
  write(level: MainLogLevel, message: string): void
  /** 读当前文件末尾（最多 maxBytes 字节，按 UTF-8 切齐），没有文件返回空串。 */
  readTail(maxBytes: number): string
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_KEEP = 3
const LOG_FILE_NAME = 'main.log'

export function createMainLog(options: MainLogOptions): MainLog {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const keep = options.keep ?? DEFAULT_KEEP
  const now = options.now ?? (() => new Date())
  const path = join(options.dir, LOG_FILE_NAME)

  function rotateIfNeeded(): void {
    let size = 0
    try {
      size = statSync(path).size
    } catch {
      return
    }
    if (size < maxBytes) return
    // main.{keep} 丢弃，其余依次后移，当前文件变 main.1。
    const rotated = (index: number) => join(options.dir, `main.${index}.log`)
    try {
      if (existsSync(rotated(keep))) unlinkSync(rotated(keep))
      for (let index = keep - 1; index >= 1; index -= 1) {
        if (existsSync(rotated(index))) renameSync(rotated(index), rotated(index + 1))
      }
      renameSync(path, rotated(1))
    } catch {
      // 轮转失败就继续往当前文件写，宁可文件超限也不丢日志。
    }
  }

  return {
    path,
    write(level, message) {
      try {
        mkdirSync(options.dir, { recursive: true })
        rotateIfNeeded()
        appendFileSync(path, `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`)
      } catch {
        // 日志不能反过来把 App 弄挂。
      }
    },
    readTail(readBytes) {
      try {
        const buffer = readFileSync(path)
        const slice = buffer.length > readBytes ? buffer.subarray(buffer.length - readBytes) : buffer
        const text = slice.toString('utf8')
        // 截断点可能落在多字节字符中间：丢掉第一行（不完整）。
        return buffer.length > readBytes ? text.slice(text.indexOf('\n') + 1) : text
      } catch {
        return ''
      }
    },
  }
}

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error'
const CONSOLE_LEVELS: Record<ConsoleMethod, MainLogLevel> = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
}

let installed: MainLog | undefined

/**
 * 装进进程：接管 console + 未处理异常/拒绝。幂等（重复调用返回同一个实例）。
 * 只在主进程入口调用一次；测试用 createMainLog 直接拿实例，不碰全局 console。
 */
export function installMainLog(options: MainLogOptions): MainLog {
  if (installed) return installed
  const log = createMainLog(options)
  installed = log

  for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      original(...args)
      log.write(CONSOLE_LEVELS[method], format(...args))
    }
  }
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    log.write('error', `[uncaught ${origin}] ${formatError(error)}`)
  })
  process.on('unhandledRejection', (reason) => {
    log.write('error', `[unhandledRejection] ${formatError(reason)}`)
  })
  log.write('info', `---- NarraCat 主进程启动 pid=${process.pid} platform=${process.platform} ${process.arch} ----`)
  return log
}

export function getMainLog(): MainLog | undefined {
  return installed
}

function formatError(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  return format(value)
}

/**
 * 慢操作告警：超过阈值就记一条 warn。用在事件落盘这类「本该瞬间完成、卡住就是环境问题」的地方——
 * Windows 上资料目录在 OneDrive / 被杀软实时扫描时文件追加会被锁住，症状是按钮点了没反应，
 * 没有这条告警根本查不出是磁盘在等。
 */
export async function warnIfSlow<T>(label: string, operation: Promise<T>, thresholdMs = 2_000): Promise<T> {
  const startedAt = Date.now()
  try {
    return await operation
  } finally {
    const elapsed = Date.now() - startedAt
    if (elapsed >= thresholdMs) console.warn(`[narracat] ${label} 耗时 ${elapsed}ms（阈值 ${thresholdMs}ms），磁盘可能被占用`)
  }
}
