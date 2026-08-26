/**
 * Agent 事件里的路径取证（#37 刀①）。
 *
 * durable 事件的脱敏会把所有绝对路径整段抹成 `[本机路径]`，初衷是作者截图求助时不泄露
 * 用户名与本机目录结构。代价是连我们也拿不到 agent 究竟读了哪个文件，read 失败率 25.6%
 * 却无从定位。本模块在脱敏**之前**先把已知根下的路径改写成 `<项目>/…` / `<引擎>/…`，
 * 既不泄露根以上的部分，又能一眼看出读的是哪一类文件；根之外的路径继续交给脱敏整段抹掉。
 */

export interface ScrubRoot {
  /** 占位标签，渲染为 `<label>`。 */
  label: string
  /** 根的绝对路径。 */
  path: string
}

/**
 * 工具 input 里表示「操作目标文件」的字段名，按优先级排列。
 * 与 `src/components/workbench/agent/tool-phrase.ts` 的路径读取共用同一份，避免两处漂移。
 *
 * `path` 是当前 pi runtime 的真实契约——真机会话取证：read / write / find / grep
 * 一律用 `path`，无一使用 `file_path`。后两个是 claude-sdk 时代（工具名还是大写 `Read`）
 * 的遗留字段，留作兼容存量数据，新链路不会命中。
 *
 * 教训：最初只照搬了 tool-phrase.ts 的 ['file_path','filePath']，结果 target 在真实
 * run 里恒为空，而全部单测照样绿——字段名这类跨系统契约必须拿真实数据核对，不能靠读同仓代码推断。
 */
export const TOOL_PATH_INPUT_KEYS = ['path', 'file_path', 'filePath'] as const

/**
 * 从工具调用入参里取出操作目标路径。取不到就返回 undefined——宁可没有 target 字段，
 * 也不要把别的字段当路径落进取证数据里。
 */
export function extractToolTargetPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  for (const key of TOOL_PATH_INPUT_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function relativizeKnownRoots(text: string, roots: ScrubRoot[]): string {
  let result = text
  for (const root of roots) {
    // 去掉尾部分隔符后再匹配，并要求根后面是分隔符或边界：否则 /novel-x 会吃掉
    // 兄弟目录 /novel-x-backup，把另一本书的路径伪装成项目内路径。
    const normalized = root.path.replace(/[/\\]+$/, '')
    if (!normalized) continue
    // 两侧分隔符可能不一致（Windows 上配置里是 `/`、Node 错误信息里是 `\`），
    // 所以按段拆开、用 [/\\]+ 重连，而不是按字面匹配。
    const segments = normalized.split(/[/\\]+/).map(escapeRegExp)
    const pattern = new RegExp(
      `${segments.join('[/\\\\]+')}(?=[/\\\\]|$|['"\`\\s,;:)\\]}])`,
      'g',
    )
    result = result.replace(pattern, `<${root.label}>`)
  }
  return result
}
