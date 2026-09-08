import { describe, expect, test } from 'bun:test'
import { getAgentThreadIdForProjectIdentity } from './agent'

describe('getAgentThreadIdForProjectIdentity', () => {
  test('a novel id is the thread identity', () => {
    expect(getAgentThreadIdForProjectIdentity({ id: 'novel-f200e083', path: '/novels/x' })).toBe('novel:novel-f200e083')
  })

  test('an empty id falls back to a path hash, never the path itself', () => {
    const threadId = getAgentThreadIdForProjectIdentity({ id: '', path: 'D:\\NarraCat\\novel-x' })
    expect(threadId).toMatch(/^novel-path:[0-9a-f]{16}$/)
    expect(threadId).not.toContain('\\')
  })

  test('a path smuggled in as the id is treated as no identity (ADR-0046)', () => {
    // 书架曾把路径当成残缺项目的 id，Windows 上会造出 `novel:D:\…`，被线程存储的 threadKey 判非法。
    for (const path of ['D:\\NarraCat\\novel-x', '/Users/a/Novels/novel-x']) {
      const threadId = getAgentThreadIdForProjectIdentity({ id: path, path })
      expect(threadId).toMatch(/^novel-path:[0-9a-f]{16}$/)
      expect(threadId).toBe(getAgentThreadIdForProjectIdentity({ id: '', path }))
    }
  })
})
