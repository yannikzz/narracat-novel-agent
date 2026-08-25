/**
 * NovelMemory 工具在 pi 的注册件（切片⑥）：43 个白名单工具以与 SDK 路径逐字一致的全限定名
 * （mcp__narracat_memory__novel_*）注册为自定义工具——引擎 agent .md 的 tools 声明
 * 一字不改即生效。schema 用 Type.Unsafe 包引擎 JSON Schema 原文（tools.js SSOT，不复刻第二份）；
 * execute 剥前缀委托 MemoryToolChannel（生产 = memory-host utilityProcess RPC）。
 */
import { defineTool } from '@mariozechner/pi-coding-agent'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { Type } from 'typebox'
import type { MemoryToolCallResult } from '@shared/types/memory-rpc'
import { getMemoryHost } from '../../../../memory/index.ts'
import type { MemoryHostPaths } from '../../../../memory/index.ts'
import { loadMemoryToolDefinitions } from '../../../../memory/memory-tool-definitions.ts'
import type { MemoryToolDefinition } from '../../../../memory/memory-tool-definitions.ts'
import { NOVEL_MEMORY_TOOL_PREFIX } from '@shared/lib/novel-memory-tool-names'

export const MEMORY_TOOL_PREFIX = NOVEL_MEMORY_TOOL_PREFIX

export type MemoryToolChannel = (
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<MemoryToolCallResult>

export interface CreateMemoryToolsArgs {
  definitions: MemoryToolDefinition[]
  /** 全限定名（face.memoryTools）；名单与定义漂移在构造期 fail-loud */
  allowedNames: string[]
  channel: MemoryToolChannel
}

export function createMemoryTools({ definitions, allowedNames, channel }: CreateMemoryToolsArgs): ToolDefinition[] {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  return allowedNames.map((fullName) => {
    const engineName = fullName.startsWith(MEMORY_TOOL_PREFIX) ? fullName.slice(MEMORY_TOOL_PREFIX.length) : fullName
    const definition = byName.get(engineName)
    if (!definition) throw new Error(`引擎工具定义缺失：${engineName}（工具白名单与引擎 tools.js 漂移）`)
    return defineTool({
      name: fullName,
      label: engineName,
      description: definition.description,
      parameters: Type.Unsafe(definition.inputSchema),
      // pi execute 第三参是 AbortSignal（生产接线门前项④）：父 run abort 时在途 RPC 立即解除等待，
      // 不再等 worker 跑完才收口。
      async execute(_toolCallId, params, signal) {
        const result = await channel(engineName, (params ?? {}) as Record<string, unknown>, signal)
        // isError 信封（未知工具/配置失败/处理器异常）throw 成 isError 工具结果；校验失败（ok:false）
        // 是正常结果文本，与 SDK 路径「isError 才标错」的模型可见语义对齐。
        if (result.isError) throw new Error(result.text)
        return { content: [{ type: 'text', text: result.text }], details: undefined }
      },
    }) as ToolDefinition
  })
}

export interface PiMemoryBridge {
  loadDefinitions(agentCorePath: string): Promise<MemoryToolDefinition[]>
  createChannel(args: { projectPath: string } & MemoryHostPaths): MemoryToolChannel
}

/** 生产桥：定义走引擎 dist/tools.js，通道走 memory-host（每项目一 utilityProcess）。 */
export const productionPiMemoryBridge: PiMemoryBridge = {
  loadDefinitions: loadMemoryToolDefinitions,
  createChannel: ({ projectPath, ...paths }) => {
    return (tool, args, signal) => getMemoryHost(paths).callTool(projectPath, tool, args, { signal })
  },
}
