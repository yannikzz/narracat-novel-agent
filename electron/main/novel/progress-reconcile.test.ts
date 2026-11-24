import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import type { MemoryHost } from '../memory/memory-host.ts'
import { findUnrecordedReceiptChapters, reconcileProgressOnOpen } from './progress-reconcile.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeProject(completed: number[], receipts: number[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'narracat-progress-reconcile-'))
  roots.push(root)
  await mkdir(join(root, '.narracat', 'receipts'), { recursive: true })
  await writeFile(
    join(root, '.narracat', 'state.yaml'),
    `progress:\n  completed_chapters: [${completed.join(', ')}]\n`,
    'utf-8',
  )
  for (const chapter of receipts) {
    await writeFile(join(root, '.narracat', 'receipts', `ch-${String(chapter).padStart(3, '0')}.json`), '{}', 'utf-8')
  }
  return root
}

function fakeHost(text = '{"ok": true, "added_chapters": [1, 2, 3]}') {
  const calls: Array<{ projectPath: string; tool: string; args: Record<string, unknown> }> = []
  const host: MemoryHost = {
    async callTool(projectPath, tool, args) {
      calls.push({ projectPath, tool, args })
      return { text }
    },
    shutdown() {},
  }
  return { host, calls }
}

function deps(host: MemoryHost, busy = false) {
  const locked: string[] = []
  return {
    locked,
    value: {
      paths: { appRoot: '/app' },
      host,
      isProjectBusy: async () => busy,
      withProjectLock: async <T>(projectPath: string, operation: () => Promise<T>) => {
        locked.push(projectPath)
        return operation()
      },
    },
  }
}

describe('打开作品时对齐完成进度', () => {
  test('有收尾回执却不在进度里的章 → 在项目锁内调引擎对账工具', async () => {
    const projectPath = await makeProject([], [1, 2, 3])
    const { host, calls } = fakeHost()
    const { value, locked } = deps(host)

    await reconcileProgressOnOpen(projectPath, value)

    expect(calls).toEqual([{ projectPath, tool: 'novel_reconcile_progress', args: {} }])
    expect(locked).toEqual([projectPath])
  })

  test('回执对应的章都已在进度里 → 不叫醒引擎', async () => {
    const projectPath = await makeProject([1, 2], [1, 2])
    const { host, calls } = fakeHost()

    await reconcileProgressOnOpen(projectPath, deps(host).value)

    expect(await findUnrecordedReceiptChapters(projectPath)).toEqual([])
    expect(calls).toEqual([])
  })

  test('本作品有 Agent 任务在跑 → 让给它，不对账', async () => {
    const projectPath = await makeProject([], [1])
    const { host, calls } = fakeHost()

    await reconcileProgressOnOpen(projectPath, deps(host, true).value)

    expect(calls).toEqual([])
  })

  test('引擎拒绝或调用抛错都不挡打开作品', async () => {
    const projectPath = await makeProject([], [1])
    const rejected = fakeHost('{"ok": false, "errors": [{"hint": "state.yaml 不是合法 YAML"}]}')
    await expect(reconcileProgressOnOpen(projectPath, deps(rejected.host).value)).resolves.toBeUndefined()

    const throwing: MemoryHost = {
      async callTool() {
        throw new Error('worker 挂了')
      },
      shutdown() {},
    }
    await expect(reconcileProgressOnOpen(projectPath, deps(throwing).value)).resolves.toBeUndefined()
  })

  test('state.yaml 读不出 → 不调用引擎', async () => {
    const projectPath = await makeProject([], [1])
    await writeFile(join(projectPath, '.narracat', 'state.yaml'), 'progress: [unclosed\n', 'utf-8')

    expect(await findUnrecordedReceiptChapters(projectPath)).toEqual([])
  })
})
