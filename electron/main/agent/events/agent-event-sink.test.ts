import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEventEnvelopeV1 } from '@shared/types/agent'
import { createAgentConversationStore } from './agent-conversation-store'
import { createAgentEventSink } from './agent-event-sink'

const roots: string[] = []
const threadId = 'novel:sink-test'
const segmentId = 'seg-33333333-3333-3333-3333-333333333333'
const nextSegmentId = 'seg-44444444-4444-4444-4444-444444444444'
const occurredAt = '2026-07-24T12:00:00.000Z'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'narracat-agent-sink-'))
  roots.push(root)
  return root
}

async function allJsonText(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true })
  const parts: string[] = []
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) parts.push(await allJsonText(child))
    else if (entry.name.endsWith('.json')) parts.push(await readFile(child, 'utf8'))
  }
  return parts.join('\n')
}

describe('agent event sink', () => {
  test('commits durable events before broadcasting them', async () => {
    const order: string[] = []
    let releaseCommit!: () => void
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    const store = {
      ensureActiveSegment: async () => ({
        manifest: {
          schemaVersion: 1 as const,
          threadId,
          segmentId,
          createdAt: occurredAt,
          lastDurableSeq: 1,
        },
        projection: {
          schemaVersion: 1 as const,
          threadId,
          segmentId,
          lastSeq: 1,
          thread: { id: threadId, messages: [], activeRun: null, lastRun: null },
        },
      }),
      appendDurableEvent: async () => {
        await commitGate
        order.push('commit')
        throw new Error('stop after observing order')
      },
      getThreadSnapshot: async () => {
        throw new Error('unused')
      },
      listHistorySegments: async () => [],
      startNewConversation: async () => {
        throw new Error('unused')
      },
    }
    const sink = createAgentEventSink({
      store,
      broadcast: () => order.push('broadcast'),
    })
    const publishing = sink.publish({
      type: 'run.started',
      runId: 'run-1',
      threadId,
      command: 'freeform',
      prompt: '你好',
      createdAt: occurredAt,
    })
    await Promise.resolve()
    expect(order).toEqual([])
    releaseCommit()
    await expect(publishing).rejects.toThrow('stop after observing order')
    expect(order).toEqual(['commit'])
  })

  test('persists only sanitized visible semantics and restores the final projection', async () => {
    const root = await createRoot()
    const broadcasts: AgentEventEnvelopeV1[] = []
    const store = createAgentConversationStore({
      rootDir: root,
      now: () => occurredAt,
      createSegmentId: () => segmentId,
    })
    const sink = createAgentEventSink({
      store,
      broadcast: (event) => broadcasts.push(event),
    })
    await sink.publish({
      type: 'run.started',
      runId: 'run-1',
      threadId,
      command: 'freeform',
      prompt: '公开问题',
      projectPath: '/Users/writer/secret-novel',
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'reasoning.delta',
      runId: 'run-1',
      messageId: 'assistant-run-1',
      text: 'PRIVATE_CHAIN_OF_THOUGHT',
      createdAt: occurredAt,
    })
    // 工具边界前的文本是过程叙述：不进最终转录（段落边界语义，A/B dogfood 修复）
    await sink.publish({
      type: 'message.delta',
      runId: 'run-1',
      messageId: 'assistant-run-1',
      text: '让我先读取章节内容…',
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'tool.started',
      runId: 'run-1',
      messageId: 'assistant-run-1',
      toolCallId: 'tool-1',
      toolName: 'Read',
      title: '读取 /Users/writer/secret-novel/chapter.md',
      input: { path: '/Users/writer/secret-novel/chapter.md', apiKey: 'sk-secret' },
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'tool.completed',
      runId: 'run-1',
      toolCallId: 'tool-1',
      summary: '已读取 /Users/writer/secret-novel/chapter.md',
      result: 'RAW_TOOL_RESULT',
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'task-plan.updated',
      runId: 'run-1',
      items: [
        {
          id: '1',
          title: '完成场景',
          status: 'complete',
          detail: 'Bearer abcdefghijklmnop',
        },
      ],
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'question.requested',
      runId: 'run-1',
      messageId: 'assistant-run-1',
      questionRequestId: 'question-1',
      toolCallId: 'question-1',
      questions: [
        {
          header: '走向',
          question: '下一步怎么写？',
          options: [
            {
              label: '追出去',
              description: '提高速度',
              preview: '参考 /Users/writer/secret-novel/outline.md',
            },
            { label: '留在原地', description: '增加悬念' },
          ],
        },
      ],
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'question.answered',
      runId: 'run-1',
      questionRequestId: 'question-1',
      answers: { '下一步怎么写？': '追出去，sk-abcdefghijk' },
      createdAt: occurredAt,
    })
    // 问答边界之后的最后一段 = 总结，才进最终转录
    await sink.publish({
      type: 'message.delta',
      runId: 'run-1',
      messageId: 'assistant-run-1',
      text: '最终可见回答',
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'run.completed',
      runId: 'run-1',
      createdAt: occurredAt,
    })

    const snapshot = await store.getThreadSnapshot(threadId)
    expect(snapshot.history[1]?.parts).toContainEqual(
      expect.objectContaining({ type: 'text', text: '最终可见回答' }),
    )
    expect(
      snapshot.history[1]?.parts.some(
        (part) => part.type === 'text' && part.text.includes('让我先读取章节内容'),
      ),
    ).toBe(false)
    expect(snapshot.lastRun?.taskPlan?.items).toEqual([
      {
        id: '1',
        title: '完成场景',
        status: 'complete',
        detail: 'Bearer [已隐藏]',
      },
    ])
    expect(snapshot.history[1]?.parts).toContainEqual(
      expect.objectContaining({
        type: 'question',
        questionRequestId: 'question-1',
        answers: { '下一步怎么写？': '追出去，[敏感令牌已隐藏]' },
      }),
    )
    const diskText = await allJsonText(join(root, 'agent-state', 'v1'))
    expect(diskText).not.toContain('PRIVATE_CHAIN_OF_THOUGHT')
    expect(diskText).not.toContain('RAW_TOOL_RESULT')
    expect(diskText).not.toContain('/Users/writer')
    expect(diskText).not.toContain('sk-secret')
    expect(diskText).not.toContain('sk-abcdefghijk')
    expect(diskText).not.toContain('abcdefghijklmnop')
    expect(diskText).toContain('最终可见回答')
    expect(broadcasts.some((event) => event.durability === 'transient')).toBe(true)
  })

  test('persists an explicit quit interruption as the run terminal state', async () => {
    const root = await createRoot()
    const store = createAgentConversationStore({
      rootDir: root,
      now: () => occurredAt,
      createSegmentId: () => segmentId,
    })
    const sink = createAgentEventSink({ store, broadcast: () => {} })
    await sink.publish({
      type: 'run.started',
      runId: 'run-quit',
      threadId,
      command: 'freeform',
      prompt: '继续写',
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'run.interrupted',
      runId: 'run-quit',
      error: 'App 退出时中断了这项任务。',
      createdAt: occurredAt,
    })

    await expect(store.getThreadSnapshot(threadId)).resolves.toMatchObject({
      activeRun: null,
      lastRun: { id: 'run-quit', status: 'interrupted' },
    })
  })

  test('keeps renderer delivery fail-soft and serves contiguous gaps from the ring', async () => {
    const root = await createRoot()
    const store = createAgentConversationStore({
      rootDir: root,
      now: () => occurredAt,
      createSegmentId: () => segmentId,
    })
    const sink = createAgentEventSink({
      store,
      ringSize: 4,
      broadcast: () => {
        throw new Error('renderer gone')
      },
    })
    await expect(
      sink.publish({
        type: 'run.started',
        runId: 'run-1',
        threadId,
        command: 'freeform',
        prompt: '你好',
        createdAt: occurredAt,
      }),
    ).resolves.toBeUndefined()
    await sink.publish({
      type: 'message.delta',
      runId: 'run-1',
      messageId: 'assistant-run-1',
      text: 'A',
      createdAt: occurredAt,
    })
    const snapshot = await sink.getThreadSnapshot(threadId)
    const result = await sink.getEventsAfter(threadId, snapshot.segmentId, snapshot.lastSeq)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected ring events')
    expect(result.events.map((event) => event.seq)).toEqual([3, 4])
  })

  test('overlays partial assistant text and running tools into a live reload snapshot', async () => {
    const root = await createRoot()
    const sink = createAgentEventSink({
      store: createAgentConversationStore({ rootDir: root }),
      broadcast: () => {},
    })
    await sink.publish({
      type: 'run.started',
      runId: 'run-live-reload',
      threadId,
      command: 'freeform',
      prompt: '继续生成',
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'run.running',
      runId: 'run-live-reload',
      createdAt: occurredAt,
    })
    // 段落边界语义：工具边界后的当前段（进行中的半段文字）进 live reload 快照
    await sink.publish({
      type: 'tool.started',
      runId: 'run-live-reload',
      messageId: 'assistant-run-live-reload',
      toolCallId: 'tool-live',
      toolName: 'Read',
      title: '读取章纲',
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'message.delta',
      runId: 'run-live-reload',
      messageId: 'assistant-run-live-reload',
      text: '已经生成的半段文字',
      createdAt: occurredAt,
    })

    const snapshot = await sink.getThreadSnapshot(threadId)
    expect(snapshot.activeRun?.status).toBe('running')
    expect(snapshot.history[1]?.parts).toEqual([
      expect.objectContaining({
        type: 'tool-call',
        toolCallId: 'tool-live',
        status: 'running',
      }),
      expect.objectContaining({
        type: 'text',
        text: '已经生成的半段文字',
        status: 'running',
      }),
    ])
  })

  test('keeps the completed run ownership needed for the terminal project refresh', async () => {
    const root = await createRoot()
    const broadcasts: AgentEventEnvelopeV1[] = []
    const store = createAgentConversationStore({
      rootDir: root,
      now: () => occurredAt,
      createSegmentId: () => segmentId,
    })
    const sink = createAgentEventSink({
      store,
      broadcast: (event) => broadcasts.push(event),
    })
    await sink.publish({
      type: 'run.started',
      runId: 'run-refresh',
      threadId,
      command: 'write-next',
      prompt: '1',
      projectPath: '/novels/stars',
      createdAt: occurredAt,
    })
    await sink.publish({ type: 'run.completed', runId: 'run-refresh', createdAt: occurredAt })

    await expect(
      sink.publish({
        type: 'novel.project.updated',
        runId: 'run-refresh',
        projectPath: '/novels/stars',
        selectedChapter: 1,
        createdAt: occurredAt,
      }),
    ).resolves.toBeUndefined()
    expect(broadcasts.at(-1)).toMatchObject({
      threadId,
      durability: 'transient',
      payload: { type: 'novel.project.updated', runId: 'run-refresh' },
    })
  })

  test('deduplicates a retried new-conversation request without adding a second divider', async () => {
    const root = await createRoot()
    const ids = [segmentId, nextSegmentId]
    const store = createAgentConversationStore({
      rootDir: root,
      now: () => occurredAt,
      createSegmentId: () => ids.shift()!,
    })
    const sink = createAgentEventSink({ store, broadcast: () => {} })
    await sink.publish({
      type: 'run.started',
      runId: 'run-1',
      threadId,
      command: 'freeform',
      prompt: '第一段',
      createdAt: occurredAt,
    })
    await sink.publish({ type: 'run.completed', runId: 'run-1', createdAt: occurredAt })

    const first = await sink.startNewConversation(threadId, 'request-1', occurredAt)
    const retried = await sink.startNewConversation(threadId, 'request-1', occurredAt)
    expect(retried).toEqual(first)
    expect(retried.history.filter((message) => message.role === 'divider')).toHaveLength(1)
    expect(await sink.listHistorySegments(threadId)).toHaveLength(2)
  })

  test('does not split a thread while any per-window manager still has a live run', async () => {
    const root = await createRoot()
    const store = createAgentConversationStore({
      rootDir: root,
      now: () => occurredAt,
      createSegmentId: () => segmentId,
    })
    const sink = createAgentEventSink({ store, broadcast: () => {} })
    await sink.publish({
      type: 'run.started',
      runId: 'run-live',
      threadId,
      command: 'freeform',
      prompt: '仍在运行',
      createdAt: occurredAt,
    })

    await expect(sink.startNewConversation(threadId, 'request-live', occurredAt)).rejects.toThrow('仍在运行')
    expect(await sink.listHistorySegments(threadId)).toHaveLength(1)
  })

  test('rejects a second live run for the same thread across window managers', async () => {
    const root = await createRoot()
    const store = createAgentConversationStore({
      rootDir: root,
      now: () => occurredAt,
      createSegmentId: () => segmentId,
    })
    const sink = createAgentEventSink({ store, broadcast: () => {} })
    await sink.publish({
      type: 'run.started',
      runId: 'run-first',
      threadId,
      command: 'freeform',
      prompt: '第一个任务',
      createdAt: occurredAt,
    })

    await expect(
      sink.publish({
        type: 'run.started',
        runId: 'run-second',
        threadId,
        command: 'freeform',
        prompt: '第二个任务',
        createdAt: occurredAt,
      }),
    ).rejects.toThrow('已有任务运行中')
    expect(await sink.listHistorySegments(threadId)).toHaveLength(1)
  })

  test('reconciles an accepted run as interrupted after a full main-process restart', async () => {
    const root = await createRoot()
    const firstStore = createAgentConversationStore({
      rootDir: root,
      now: () => occurredAt,
      createSegmentId: () => segmentId,
    })
    const firstSink = createAgentEventSink({ store: firstStore, broadcast: () => {} })
    await firstSink.publish({
      type: 'run.started',
      runId: 'run-interrupted',
      threadId,
      command: 'freeform',
      prompt: '尚未完成',
      createdAt: occurredAt,
    })
    await firstSink.establishSessionContext(threadId, 'project-command', 'fingerprint-before-restart')

    const restartedSink = createAgentEventSink({
      store: createAgentConversationStore({ rootDir: root }),
      broadcast: () => {},
      now: () => '2026-07-24T13:00:00.000Z',
    })
    expect(await restartedSink.reconcileInterruptedRuns()).toBe(1)
    const snapshot = await restartedSink.getThreadSnapshot(threadId)
    expect(snapshot.activeRun).toBeNull()
    expect(snapshot.lastRun).toBeNull()
    const segments = await restartedSink.listHistorySegments(threadId)
    expect(segments).toHaveLength(2)
    const interrupted = await restartedSink.getThreadSnapshot(threadId, segments[0]!.segmentId)
    expect(interrupted.lastRun).toMatchObject({ id: 'run-interrupted', status: 'interrupted' })
    expect(interrupted.history[1]?.parts).toContainEqual(
      expect.objectContaining({
        type: 'error',
        tone: 'interrupted',
        title: '任务已中断',
        detail: '上次关闭 App 时，这项任务还没有完成。已完成的内容仍然保留。',
      }),
    )
    expect(interrupted.history.map((message) => message.role)).toEqual(['user', 'assistant'])
    const next = await restartedSink.getThreadSnapshot(threadId, segments[1]!.segmentId)
    expect(next.history.map((message) => message.role)).toEqual(['divider'])
    expect(await restartedSink.reconcileInterruptedRuns()).toBe(0)
    expect(await restartedSink.listHistorySegments(threadId)).toHaveLength(2)
  })

  test('aggregates TaskCreate/TaskUpdate tool.started into task-plan.updated and finalizes at run completion', async () => {
    const root = await createRoot()
    const broadcasts: AgentEventEnvelopeV1[] = []
    const store = createAgentConversationStore({
      rootDir: root,
      now: () => occurredAt,
      createSegmentId: () => segmentId,
    })
    const sink = createAgentEventSink({
      store,
      broadcast: (event) => broadcasts.push(event),
    })
    await sink.publish({
      type: 'run.started',
      runId: 'run-task-cards',
      threadId,
      command: 'freeform',
      prompt: '拆解任务',
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'tool.started',
      runId: 'run-task-cards',
      messageId: 'assistant-run-task-cards',
      toolCallId: 'tool-task-create',
      toolName: 'TaskCreate',
      title: '创建任务',
      input: { subject: '上下文聚合' },
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'tool.started',
      runId: 'run-task-cards',
      messageId: 'assistant-run-task-cards',
      toolCallId: 'tool-task-update',
      toolName: 'TaskUpdate',
      title: '更新任务',
      input: { taskId: '1', status: 'in_progress' },
      createdAt: occurredAt,
    })

    const taskPlanUpdates = broadcasts.filter((event) => event.payload.type === 'task-plan.updated')
    expect(taskPlanUpdates).toHaveLength(2)
    expect(taskPlanUpdates[0]?.payload).toMatchObject({
      type: 'task-plan.updated',
      items: [{ id: '1', title: '上下文聚合', status: 'pending' }],
    })
    expect(taskPlanUpdates[1]?.payload).toMatchObject({
      type: 'task-plan.updated',
      items: [{ id: '1', title: '上下文聚合', status: 'running' }],
    })

    await sink.publish({ type: 'run.completed', runId: 'run-task-cards', createdAt: occurredAt })

    const snapshot = await store.getThreadSnapshot(threadId)
    expect(snapshot.lastRun?.taskPlan?.items).toEqual([{ id: '1', title: '上下文聚合', status: 'running' }])
  })

  test('invalidates a durable session projection when the App restarts without a live SDK handle', async () => {
    const root = await createRoot()
    const firstSink = createAgentEventSink({
      store: createAgentConversationStore({ rootDir: root }),
      broadcast: () => {},
    })
    await firstSink.establishSessionContext(threadId, 'project-command', 'fingerprint-1')

    const broadcasts: AgentEventEnvelopeV1[] = []
    const restartedSink = createAgentEventSink({
      store: createAgentConversationStore({ rootDir: root }),
      broadcast: (event) => broadcasts.push(event),
    })
    await restartedSink.reconcileInterruptedRuns()

    expect(broadcasts.at(-1)?.payload).toMatchObject({
      type: 'session.invalidated',
      reason: 'app-restarted',
    })
  })
})

describe('durable tool forensics (#37)', () => {
  test('records the project-relative target path of a failed tool call', async () => {
    // EISDIR 类错误串本身不含路径，只有 tool.started 的 input 里有。落盘不记 target 就
    // 永远查不出 agent 到底读了哪个目录——这正是 read 失败率 25.6% 却无从定位的原因。
    const root = await createRoot()
    const store = createAgentConversationStore({
      rootDir: root,
      now: () => occurredAt,
      createSegmentId: () => segmentId,
    })
    const sink = createAgentEventSink({ store, broadcast: () => {} })
    const projectPath = '/Users/somebody/Novels/novel-x'

    await sink.publish({
      type: 'run.started',
      runId: 'run-forensics',
      threadId,
      command: 'freeform',
      prompt: '写第 20 章',
      projectPath,
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'tool.started',
      runId: 'run-forensics',
      messageId: 'assistant-run-forensics',
      toolCallId: 'tool-forensics',
      toolName: 'Read',
      title: '调用 Read',
      // pi runtime 的真实参数名是 `path`（真机会话取证），测试必须用真实形态
      input: { path: `${projectPath}/bible/characters` },
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'tool.failed',
      runId: 'run-forensics',
      toolCallId: 'tool-forensics',
      error: 'EISDIR: illegal operation on a directory, read',
      createdAt: occurredAt,
    })

    const durable = await allJsonText(root)
    expect(durable).toContain('<项目>/bible/characters')
    expect(durable).not.toContain('/Users/somebody')
  })

  test('rewrites in-project paths inside the error string but still scrubs anything outside the root', async () => {
    // ENOENT 类错误串自带路径（33/50 次属此类）。相对化只能作用在项目根以内——根以外的
    // 路径必须继续整段抹掉，否则作者截图求助就会泄露用户名与本机目录结构。
    const root = await createRoot()
    const store = createAgentConversationStore({
      rootDir: root,
      now: () => occurredAt,
      createSegmentId: () => segmentId,
    })
    const sink = createAgentEventSink({ store, broadcast: () => {} })
    const projectPath = '/Users/somebody/Novels/novel-x'

    await sink.publish({
      type: 'run.started',
      runId: 'run-enoent',
      threadId,
      command: 'freeform',
      prompt: '写第 20 章',
      projectPath,
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'tool.started',
      runId: 'run-enoent',
      messageId: 'assistant-run-enoent',
      toolCallId: 'tool-enoent',
      toolName: 'Read',
      title: '调用 Read',
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'tool.failed',
      runId: 'run-enoent',
      toolCallId: 'tool-enoent',
      error: `ENOENT: no such file or directory, access '${projectPath}/chapters/020.md' (also tried /Users/somebody/Desktop/草稿.md)`,
      createdAt: occurredAt,
    })

    const durable = await allJsonText(root)
    expect(durable).toContain('<项目>/chapters/020.md')
    expect(durable).toContain('[本机路径]')
    expect(durable).not.toContain('/Users/somebody')
  })

  test('rewrites Agent Core paths as <引擎> so engine reads stay traceable too', async () => {
    // agent 读的不只是小说项目，还有引擎的 skill/command 文件。开发机上引擎目录同样在
    // /Users/… 下，不给它一个根就会被整段抹掉，引擎侧的读取失败照样查不了。
    const root = await createRoot()
    const store = createAgentConversationStore({
      rootDir: root,
      now: () => occurredAt,
      createSegmentId: () => segmentId,
    })
    const agentCorePath = '/Users/somebody/app/agent-core/narracat'
    const sink = createAgentEventSink({ store, broadcast: () => {}, agentCorePath })

    await sink.publish({
      type: 'run.started',
      runId: 'run-engine',
      threadId,
      command: 'freeform',
      prompt: '写第 20 章',
      projectPath: '/Users/somebody/Novels/novel-x',
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'tool.started',
      runId: 'run-engine',
      messageId: 'assistant-run-engine',
      toolCallId: 'tool-engine',
      toolName: 'Read',
      title: '调用 Read',
      input: { path: `${agentCorePath}/skills/write.md` },
      createdAt: occurredAt,
    })
    await sink.publish({
      type: 'tool.failed',
      runId: 'run-engine',
      toolCallId: 'tool-engine',
      error: 'ENOENT: no such file or directory',
      createdAt: occurredAt,
    })

    const durable = await allJsonText(root)
    expect(durable).toContain('<引擎>/skills/write.md')
    expect(durable).not.toContain('/Users/somebody')
  })
})
