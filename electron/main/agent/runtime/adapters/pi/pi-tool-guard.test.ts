/**
 * pi 权限门禁单测（阶段2切片③）：工具面映射（SDK 名 → pi 名 + AskUserQuestion 拆分 +
 * disallowed 过滤 + 无等价物丢弃）、tool_call guard 的目录圈禁（realpath 软链逃逸 /
 * 不存在路径按最深存在祖先 / 相对路径以 cwd 解析 / 可选 path 缺省 cwd）与 canUseTool
 * 委托（工具名映射、deny → block、AskUserQuestion 不重复触发）。
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeCanUseTool } from '../../types.ts'
import { createAskUserQuestionTool, createPiToolGuard, mapSdkToolFaceToPi } from './pi-tool-guard.ts'

function makeSandbox() {
  const base = mkdtempSync(join(tmpdir(), 'pi-guard-'))
  const inside = join(base, 'allowed')
  const outside = join(base, 'outside')
  mkdirSync(inside, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(inside, 'ok.txt'), 'ok')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  return { base, inside, outside }
}

async function fireToolCall(
  guard: ReturnType<typeof createPiToolGuard>,
  event: { toolCallId: string; toolName: string; input: Record<string, unknown> },
): Promise<{ block?: boolean; reason?: string } | undefined> {
  const handlers = guard.handlers.get('tool_call')
  expect(handlers).toBeDefined()
  expect(handlers).toHaveLength(1)
  const result = await handlers![0]({ type: 'tool_call', ...event }, {})
  return result as { block?: boolean; reason?: string } | undefined
}

describe('mapSdkToolFaceToPi', () => {
  test('SDK 名映射为 pi 名，AskUserQuestion 拆为 customTools 标记，无等价物丢弃', () => {
    const face = mapSdkToolFaceToPi([
      'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
      'Agent', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', 'Skill',
      'mcp__narracat-novel-memory__novel_search_memory',
    ])
    expect(face.tools).toEqual(['read', 'write', 'edit', 'find', 'grep', 'bash'])
    expect(face.includeAskUserQuestion).toBe(true)
  })

  test('disallowedTools 过滤在映射前生效，重复项去重', () => {
    const face = mapSdkToolFaceToPi(['Read', 'Read', 'Bash', 'AskUserQuestion'], ['Bash', 'AskUserQuestion'])
    expect(face.tools).toEqual(['read'])
    expect(face.includeAskUserQuestion).toBe(false)
  })

  test('切片⑤：Agent/Task 置 includeTaskDispatch，TaskCreate/TaskUpdate 置 includeTaskCards，均不进 tools 数组', () => {
    const face = mapSdkToolFaceToPi(['Read', 'Agent', 'TaskCreate', 'TaskUpdate'])
    expect(face.tools).toEqual(['read'])
    expect(face.includeTaskDispatch).toBe(true)
    expect(face.includeTaskCards).toBe(true)
    expect(mapSdkToolFaceToPi(['Task']).includeTaskDispatch).toBe(true)
    expect(mapSdkToolFaceToPi(['TaskUpdate']).includeTaskCards).toBe(true)
  })

  test('切片⑤：两个旗标缺省为 false，且受 disallowedTools 抑制', () => {
    const bare = mapSdkToolFaceToPi(['Read'])
    expect(bare.includeTaskDispatch).toBe(false)
    expect(bare.includeTaskCards).toBe(false)
    const blocked = mapSdkToolFaceToPi(['Agent', 'TaskCreate'], ['Agent', 'TaskCreate'])
    expect(blocked.includeTaskDispatch).toBe(false)
    expect(blocked.includeTaskCards).toBe(false)
  })

  test('mcp__narracat_memory__* 进 memoryTools，其余 mcp__* 仍丢弃', () => {
    const face = mapSdkToolFaceToPi([
      'Read',
      'mcp__narracat_memory__novel_query',
      'mcp__narracat_memory__novel_query',
      'mcp__other_server__something',
    ])
    expect(face.tools).toEqual(['read'])
    expect(face.memoryTools).toEqual(['mcp__narracat_memory__novel_query'])
  })

  test('disallowedTools 挡记忆工具全限定名：不进 memoryTools（disallowed 判定在 memory 前缀判定之前生效）', () => {
    const face = mapSdkToolFaceToPi(
      ['Read', 'mcp__narracat_memory__novel_query', 'mcp__narracat_memory__novel_search_memory'],
      ['mcp__narracat_memory__novel_query'],
    )
    expect(face.memoryTools).toEqual(['mcp__narracat_memory__novel_search_memory'])
    expect(face.memoryTools).not.toContain('mcp__narracat_memory__novel_query')
  })
})

describe('createPiToolGuard 目录圈禁', () => {
  test('白名单根内的绝对路径放行（返回 undefined）', async () => {
    const { inside } = makeSandbox()
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal })
    const result = await fireToolCall(guard, { toolCallId: 't1', toolName: 'read', input: { path: join(inside, 'ok.txt') } })
    expect(result).toBeUndefined()
  })

  test('根外绝对路径 block，reason 带路径', async () => {
    const { inside, outside } = makeSandbox()
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal })
    const result = await fireToolCall(guard, { toolCallId: 't2', toolName: 'read', input: { path: join(outside, 'secret.txt') } })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('secret.txt')
  })

  test('软链逃逸按 realpath 判：根内软链指向根外 → block', async () => {
    const { inside, outside } = makeSandbox()
    symlinkSync(join(outside, 'secret.txt'), join(inside, 'sneaky-link'))
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal })
    const result = await fireToolCall(guard, { toolCallId: 't3', toolName: 'read', input: { path: join(inside, 'sneaky-link') } })
    expect(result?.block).toBe(true)
  })

  test('write 不存在的新文件按最深存在祖先圈禁：根内放行、根外 block', async () => {
    const { inside, outside } = makeSandbox()
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal })
    const ok = await fireToolCall(guard, { toolCallId: 't4', toolName: 'write', input: { path: join(inside, 'new-dir', 'new.txt'), content: 'x' } })
    expect(ok).toBeUndefined()
    const bad = await fireToolCall(guard, { toolCallId: 't5', toolName: 'write', input: { path: join(outside, 'new-dir', 'new.txt'), content: 'x' } })
    expect(bad?.block).toBe(true)
  })

  test('相对路径以 cwd 解析；..逃逸 block', async () => {
    const { inside } = makeSandbox()
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal })
    const ok = await fireToolCall(guard, { toolCallId: 't6', toolName: 'edit', input: { path: 'ok.txt', edits: [] } })
    expect(ok).toBeUndefined()
    const bad = await fireToolCall(guard, { toolCallId: 't7', toolName: 'read', input: { path: join('..', 'outside', 'secret.txt') } })
    expect(bad?.block).toBe(true)
  })

  test('grep/find/ls 可选 path 缺省用 cwd：cwd 在根内放行；显式根外 path block', async () => {
    const { inside, outside } = makeSandbox()
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal })
    expect(await fireToolCall(guard, { toolCallId: 't8', toolName: 'grep', input: { pattern: 'x' } })).toBeUndefined()
    const bad = await fireToolCall(guard, { toolCallId: 't9', toolName: 'ls', input: { path: outside } })
    expect(bad?.block).toBe(true)
  })

  test('bash 不做路径圈禁（与 SDK additionalDirectories 语义对齐）', async () => {
    const { inside, outside } = makeSandbox()
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal })
    const result = await fireToolCall(guard, { toolCallId: 't10', toolName: 'bash', input: { command: `cat ${join(outside, 'secret.txt')}` } })
    expect(result).toBeUndefined()
  })

  test('多根白名单：任一根命中即放行', async () => {
    const { inside, outside } = makeSandbox()
    const guard = createPiToolGuard({ allowedRoots: [inside, outside], cwd: inside, signal: new AbortController().signal })
    expect(await fireToolCall(guard, { toolCallId: 't11', toolName: 'read', input: { path: join(outside, 'secret.txt') } })).toBeUndefined()
  })

  test('前缀碰撞：同前缀的兄弟目录不因裸 startsWith 误放行（回归锁 isWithinRoot 的 root+sep 判定）', async () => {
    const { base, inside } = makeSandbox()
    const insideExtra = `${inside}-extra`
    mkdirSync(insideExtra, { recursive: true })
    writeFileSync(join(insideExtra, 'leak.txt'), 'leak')
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: base, signal: new AbortController().signal })
    const bad = await fireToolCall(guard, { toolCallId: 't12', toolName: 'read', input: { path: join(insideExtra, 'leak.txt') } })
    expect(bad?.block).toBe(true)
    const ok = await fireToolCall(guard, { toolCallId: 't13', toolName: 'read', input: { path: join(inside, 'ok.txt') } })
    expect(ok).toBeUndefined()
  })

  test('`~/某文件` 越界：pi 的 expandPath 会把 ~ 展开成 homedir，guard 须同款展开才能拦住', async () => {
    const { inside } = makeSandbox()
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal })
    // homedir 不在允许根内（inside 是 tmpdir 下的临时目录），~/.ssh/id_rsa 展开后必然越界。
    const bad = await fireToolCall(guard, { toolCallId: 't14', toolName: 'read', input: { path: '~/.ssh/id_rsa' } })
    expect(bad?.block).toBe(true)
    expect(bad?.reason).toContain(homedir())
  })

  test('前导 `@` 剥离后判定：`@/etc/passwd` 等价于 `/etc/passwd`，越界 block', async () => {
    const { inside } = makeSandbox()
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal })
    const bad = await fireToolCall(guard, { toolCallId: 't15', toolName: 'read', input: { path: '@/etc/passwd' } })
    expect(bad?.block).toBe(true)
  })

  test('Unicode 空格（NBSP）变体路径踩中软链逃逸：不归一会误放行，归一后正确 block', async () => {
    const { inside, outside } = makeSandbox()
    const NBSP = '\u00a0'
    // 根内放一个名字带普通空格的软链、指向根外文件。模型传入路径里的空格是 NBSP（pi expandPath
    // 会把它归一成普通空格再打开）——不归一时这条路径的字面 basename 在磁盘上根本不存在，
    // resolveRealPath 找不到它、只能回落到「最深存在祖先」= inside 本身，于是被误判「在根内」放行
    // （凑巧没找到那个软链，也就没机会发现它指向根外）；归一后才能定位到真实软链，realpath 出根外，
    // 正确 block。这条测的是「不归一反而更危险」的真实逃逸场景，不是无差别的存在性 cosmetics。
    symlinkSync(join(outside, 'secret.txt'), join(inside, 'a b'))
    const nbspPath = join(inside, `a${NBSP}b`)
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal })
    const result = await fireToolCall(guard, { toolCallId: 't16', toolName: 'read', input: { path: nbspPath } })
    expect(result?.block).toBe(true)
  })
})

describe('createPiToolGuard canUseTool 委托', () => {
  function recordingCanUseTool(behavior: 'allow' | 'deny'): { calls: Array<{ toolName: string; toolUseID: string }>; fn: RuntimeCanUseTool } {
    const calls: Array<{ toolName: string; toolUseID: string }> = []
    const fn: RuntimeCanUseTool = async (toolName, _input, options) => {
      calls.push({ toolName, toolUseID: options.toolUseID })
      return behavior === 'allow'
        ? { behavior: 'allow', updatedInput: {}, toolUseID: options.toolUseID }
        : { behavior: 'deny', message: 'NovelMemory 拦截', toolUseID: options.toolUseID, decisionClassification: 'user_reject' }
    }
    return { calls, fn }
  }

  test('pi 工具名映射回 SDK 名后委托（bash→Bash），allow → 放行', async () => {
    const { inside } = makeSandbox()
    const { calls, fn } = recordingCanUseTool('allow')
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal, canUseTool: fn })
    const result = await fireToolCall(guard, { toolCallId: 'c1', toolName: 'bash', input: { command: 'echo hi' } })
    expect(result).toBeUndefined()
    expect(calls).toEqual([{ toolName: 'Bash', toolUseID: 'c1' }])
  })

  test('deny → block 且 reason 透传 message（记忆库直写拦截经此生效）', async () => {
    const { inside } = makeSandbox()
    const { fn } = recordingCanUseTool('deny')
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal, canUseTool: fn })
    const result = await fireToolCall(guard, { toolCallId: 'c2', toolName: 'write', input: { path: join(inside, 'a.txt'), content: 'x' } })
    expect(result?.block).toBe(true)
    expect(result?.reason).toBe('NovelMemory 拦截')
  })

  test('AskUserQuestion 的 tool_call 不委托 canUseTool（问答由自定义工具 execute 自理，避免双触发）', async () => {
    const { inside } = makeSandbox()
    const { calls, fn } = recordingCanUseTool('allow')
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal, canUseTool: fn })
    const result = await fireToolCall(guard, { toolCallId: 'c3', toolName: 'AskUserQuestion', input: { questions: [] } })
    expect(result).toBeUndefined()
    expect(calls).toEqual([])
  })

  test('未注入 canUseTool 时仅做目录圈禁', async () => {
    const { inside, outside } = makeSandbox()
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal })
    expect(await fireToolCall(guard, { toolCallId: 'c4', toolName: 'bash', input: { command: 'echo hi' } })).toBeUndefined()
    const bad = await fireToolCall(guard, { toolCallId: 'c5', toolName: 'read', input: { path: join(outside, 'secret.txt') } })
    expect(bad?.block).toBe(true)
  })

  test('真实 createCanUseTool 组合：记忆库直写 bash 被 block（端到端正则复用证明）', async () => {
    const { inside } = makeSandbox()
    const { createCanUseTool } = await import('../../../permissions/can-use-tool.ts')
    const canUseTool = createCanUseTool({
      runId: 'run-guard-test',
      abortController: new AbortController(),
      now: () => new Date(0).toISOString(),
      sendEventSafe: async () => true,
      markDurabilityFailed: () => {},
      waitForQuestionAnswer: async () => ({ requestId: 'unused', answers: {} }),
    })
    const guard = createPiToolGuard({ allowedRoots: [inside], cwd: inside, signal: new AbortController().signal, canUseTool })
    const result = await fireToolCall(guard, {
      toolCallId: 'c6',
      toolName: 'bash',
      input: { command: 'sqlite3 .narracat/memory.db "INSERT INTO facts VALUES (1)"' },
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('NovelMemory')
  })
})

describe('createAskUserQuestionTool', () => {
  const questionsInput = {
    questions: [
      {
        question: '下一章走哪条线？',
        header: '剧情走向',
        options: [
          { label: '主线推进', description: '继续宗门大比' },
          { label: '支线插叙', description: '回收前文伏笔' },
        ],
      },
    ],
  }

  test('canUseTool allow → 返回 answers JSON 文本结果', async () => {
    const canUseTool: RuntimeCanUseTool = async (toolName, input, options) => {
      expect(toolName).toBe('AskUserQuestion')
      return {
        behavior: 'allow',
        updatedInput: { ...input, answers: { 剧情走向: '主线推进' } },
        toolUseID: options.toolUseID,
      }
    }
    const tool = createAskUserQuestionTool({ canUseTool, signal: new AbortController().signal })
    expect(tool.name).toBe('AskUserQuestion')
    const result = await tool.execute('q1', questionsInput, undefined, undefined, {} as never)
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(JSON.parse(text)).toEqual({ answers: { 剧情走向: '主线推进' } })
  })

  test('canUseTool deny → throw（agent-loop 会转 isError 工具结果）', async () => {
    const canUseTool: RuntimeCanUseTool = async (_toolName, _input, options) => ({
      behavior: 'deny',
      message: '用户问题已取消。',
      toolUseID: options.toolUseID,
      decisionClassification: 'user_reject',
    })
    const tool = createAskUserQuestionTool({ canUseTool, signal: new AbortController().signal })
    await expect(tool.execute('q2', questionsInput, undefined, undefined, {} as never)).rejects.toThrow('用户问题已取消。')
  })

  test('工具级 signal 优先于 run 级 signal 传给 canUseTool', async () => {
    const toolSignal = new AbortController().signal
    let seenSignal: AbortSignal | undefined
    const canUseTool: RuntimeCanUseTool = async (_toolName, input, options) => {
      seenSignal = options.signal
      return { behavior: 'allow', updatedInput: { ...input, answers: {} } }
    }
    const tool = createAskUserQuestionTool({ canUseTool, signal: new AbortController().signal })
    await tool.execute('q3', questionsInput, toolSignal, undefined, {} as never)
    expect(seenSignal).toBe(toolSignal)
  })
})
