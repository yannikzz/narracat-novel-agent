/**
 * 埋点字典的防漂移守卫（ADR-0039）。
 *
 * 埋点挂在 IPC 装配处，靠 IPC_CHANNEL_MODULES 决定归属。这张表一旦落后于真实通道，
 * 新功能就会静默地"永远没人用"——数据看着正常，结论是错的。所以这里双向卡死：
 *   ①每个已注册通道都必须在表里（新增通道必须有人判归属，不能默认漏掉）；
 *   ②表里不许有已经不存在的通道（删功能时同步清理，避免表变成坟场）。
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { TELEMETRY_MODULES } from '@shared/types/telemetry'
import { IPC_CHANNEL_MODULES, resolveModuleForChannel } from './ipc-modules.ts'

const IPC_DIR = fileURLToPath(new URL('../ipc', import.meta.url))

/** 扫描 IPC 域文件里真实注册的通道名（通道名可能换行写在 handle( 的下一行）。 */
function collectRegisteredChannels(dir: string): string[] {
  const channels = new Set<string>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
    const source = readFileSync(join(dir, file), 'utf8')
    for (const match of source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) {
      channels.add(match[1]!)
    }
  }
  return [...channels].sort()
}

describe('IPC 通道 → 埋点模块归属表', () => {
  const registered = collectRegisteredChannels(IPC_DIR)

  test('扫描确实扫到了通道（扫不到时下面两条断言会假绿）', () => {
    expect(registered.length).toBeGreaterThan(100)
  })

  test('每个已注册通道都判过归属', () => {
    const missing = registered.filter((channel) => !(channel in IPC_CHANNEL_MODULES))
    expect(missing).toEqual([])
  })

  test('表里没有已不存在的通道', () => {
    const registeredSet = new Set(registered)
    const stale = Object.keys(IPC_CHANNEL_MODULES).filter((channel) => !registeredSet.has(channel))
    expect(stale).toEqual([])
  })

  test('归属值只能是已声明的模块或显式 null', () => {
    const modules = new Set<string>(TELEMETRY_MODULES)
    const bad = Object.entries(IPC_CHANNEL_MODULES).filter(
      ([, module]) => module !== null && !modules.has(module),
    )
    expect(bad).toEqual([])
  })

  test('每个模块都至少有一个通道喂它——否则该模块的使用率恒为 0，是假数据', () => {
    const covered = new Set(Object.values(IPC_CHANNEL_MODULES).filter((m) => m !== null))
    // write-chapter 例外：它由 chapter_write_started 专用事件驱动，不挂在任何通道上。
    const uncovered = TELEMETRY_MODULES.filter(
      (module) => module !== 'write-chapter' && !covered.has(module),
    )
    expect(uncovered).toEqual([])
  })

  test('未知通道不猜归属', () => {
    expect(resolveModuleForChannel('nope:whatever')).toBeNull()
  })
})
