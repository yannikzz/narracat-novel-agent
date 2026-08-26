import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 装配层接线守卫（#37）。
 *
 * 路径取证依赖 sink 拿到「已知根」，根为空时功能不报错、不失败，只是默默什么都不做——
 * 落盘里照旧是 `[本机路径]`，而所有单测仍然全绿。这类静默失效只能在装配处拦。
 */
describe('agent runtime IPC wiring', () => {
  const source = readFileSync(fileURLToPath(new URL('./agent.ts', import.meta.url)), 'utf-8')

  test('passes the resolved Agent Core path into the runtime coordinator', () => {
    expect(source).toContain('resolveNarraCatAgentCorePath')
    expect(source).toMatch(/agentCorePath[,:]/)
  })
})
