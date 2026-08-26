/**
 * NovelMemory 工具全限定名的单一来源（两进程共用，ADR-0036）。
 *
 * 工具以 `mcp__<server>__<tool>` 的形状注册进 pi 的工具面。这个形状是历史遗留的
 * 命名约定——claude-sdk 时代它确实对应一个 MCP server 连接，pi 时代生产路径上
 * NovelMemory 工具全部由 `pi-memory-tools.ts` 以自定义工具注册、execute 剥前缀后
 * 委托 memory-host utilityProcess RPC，没有任何按此名 spawn 的 MCP 进程。
 * 也就是说：**server 段现在纯粹是标识符**，改它不影响任何进程连接，只需全仓同步。
 *
 * 为什么两侧都要用这里的常量：主进程按前缀注册与守卫工具面，渲染进程按前缀把
 * `mcp__…__novel_*` 反解成人读动作名（`tool-phrase.ts`）。此前渲染端硬编码了
 * 一份 server 名副本，改名时漏改一侧不会报错，只会让工具卡悄悄退回「记忆引擎操作」
 * 的兜底文案——这类漂移不该靠人记住。
 */

/**
 * 工具全限定名的长度上限，取自各家 wire 里最严的那条。
 *
 * - Anthropic Messages wire：`^[a-zA-Z0-9_-]{1,128}$`（128）
 * - OpenAI Chat Completions wire：`^[a-zA-Z0-9_-]{1,64}$`（**64**）
 * - 部分 Anthropic 兼容网关：自行按 64 截断并改写成 hash 短名（社区 issue #12）
 *
 * custom 渠道自 #5 刀 1 起可选 openai wire，所以 64 是我们必须满足的实际下限，
 * 不是「某个网关的怪癖」。越界的后果在 openai wire 上是请求被拒，在做 hash 改写的
 * 网关上是模型收到 `Tool not found`——两者都不会指向真正的原因，所以用守卫挡在前面。
 */
export const MAX_QUALIFIED_TOOL_NAME_LENGTH = 64

/**
 * NovelMemory 工具全名里的 server 段。
 *
 * 曾用 `plugin_narracat_novelmemory`（27 字符），光前缀就吃掉 34，导致 7 个工具的
 * 全限定名越过 64。缩短到 15 字符后最长的一个是 58，留 6 字符余量。
 */
export const NOVEL_MEMORY_MCP_SERVER_NAME = 'narracat_memory'

/** 工具全限定名前缀：`mcp__narracat_memory__`。 */
export const NOVEL_MEMORY_TOOL_PREFIX = `mcp__${NOVEL_MEMORY_MCP_SERVER_NAME}__`

/** 引擎侧短名 → 工具面全限定名。 */
export function qualifyNovelMemoryToolName(engineToolName: string): string {
  return `${NOVEL_MEMORY_TOOL_PREFIX}${engineToolName}`
}

/** 全限定名 → 引擎侧短名；不带本前缀的名字原样返回（调用方按短名兜底）。 */
export function unqualifyNovelMemoryToolName(qualifiedToolName: string): string {
  return qualifiedToolName.startsWith(NOVEL_MEMORY_TOOL_PREFIX)
    ? qualifiedToolName.slice(NOVEL_MEMORY_TOOL_PREFIX.length)
    : qualifiedToolName
}
