/**
 * 不依赖外部二进制的文件检索工具（替换 pi 内置 find 与 grep）。
 *
 * pi 的 find 走 fd、grep 走 ripgrep：都是先查系统 PATH，找不到就去 GitHub Releases 下载。两条路在生产上都不通——
 * macOS 从 Finder 启动的 App 继承 launchd 的窄 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`，不含
 * Homebrew），而目标用户（网文作者）机器上本来就不会装 fd 这类开发者工具，GitHub 下载对国内
 * 用户更是基本不可达。真机打包版实测：find 有一半调用直接报「fd is not available and could
 * not be downloaded」。dev 从终端启动继承了完整 PATH，所以这个缺陷一直没暴露。
 *
 * 做法是复用 pi 自己的 `createFindToolDefinition`，只把底层 FindOperations 换成 tinyglobby——
 * 工具名、schema、描述、输出格式与截断语义全部原样继承，零漂移。同名工具经 customTools 注入
 * 即可覆盖内置那个。
 *
 * 为什么不用 Node 内置 `fs.glob`：①它没有 `dot` 选项，`**` 不跨隐藏目录，而 `.narracat/staging/`
 * 正是任务书所在，搜不到任务书 agent 就会去猜文件名；②实测 Electron 的 Node 24 与 bun 对同一
 * pattern 结果不同（`**\/.narracat/**\/*.md` 在 Node 下命中、bun 下不命中），测试跑在 bun、
 * 生产跑在 Node，那样的测试根本代表不了生产。tinyglobby 在两个运行时结果逐字一致。
 *
 * 一处已知差异：fd 会读 `.gitignore`，本实现不读。pi 在 customOps 分支硬编码了
 * `ignore: ['**\/node_modules/**', '**\/.git/**']`，对小说项目足够——小说目录里没有需要靠
 * .gitignore 屏蔽的产物。
 *
 * grep 没有同样的省事路子：它的 GrepOperations 只能替换 isDirectory/readFile，搜索本身无条件
 * `ensureTool("rg")`，换不掉。所以 grep 只继承 pi 的**工具定义**（name/label/description/schema/
 * 渲染函数原样复用，模型看到的那一面零漂移），单独重写 execute——用纯 JS 扫描替掉 rg 子进程，
 * 并逐条复刻 pi 的输出格式（相对路径、`file:line: `/`file-line- ` 两种前缀、匹配上限与截断提示）。
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { glob } from 'tinyglobby'
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
} from '@mariozechner/pi-coding-agent'
import type { FindOperations, ToolDefinition } from '@mariozechner/pi-coding-agent'

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath)
    return true
  } catch {
    return false
  }
}

const globOperations: FindOperations = {
  exists: pathExists,
  async glob(pattern, cwd, options) {
    // dot:true 是关键——`.narracat/` 是引擎工作区（任务书、暂存区都在里面），按「隐藏文件」
    // 跳过就等于让 agent 看不见自己的任务书。
    const matches = await glob(pattern, { cwd, dot: true, ignore: options.ignore })
    // 必须回绝对路径：pi 的 relativize 只认「以搜索根开头」的绝对路径，拿到相对路径会
    // 走 path.relative(searchPath, 相对路径)，那是按进程 cwd 解析的，算出来是错的。
    return matches.slice(0, options.limit).map((entry) => join(cwd, entry))
  },
}

/** 与内置 find 同名同形，只是不需要 fd。 */
export function createPortableFindTool(cwd: string): ToolDefinition {
  return createFindToolDefinition(cwd, { operations: globOperations }) as ToolDefinition
}

/** 与 pi 的 find customOps 分支同一份排除项：小说目录里没有需要靠 .gitignore 屏蔽的产物。 */
const IGNORED_GLOBS = ['**/node_modules/**', '**/.git/**']
/** pi grep 的默认匹配上限（`grep.js` 的 DEFAULT_LIMIT，未导出）。 */
const GREP_DEFAULT_LIMIT = 100
/**
 * pi 的 `GREP_MAX_LINE_LENGTH`（truncate.ts 里 500，未从包入口导出），只用于截断提示文案。
 * 值漂移由 `pi-fs-tools.test.ts` 的守卫用例盯着：它拿 pi 自己的 truncateLine 反测这个边界。
 */
const GREP_MAX_LINE_LENGTH = 500
/**
 * 单文件体积上限。rg 不设这条，但它是流式扫描；我们要把整份内容读进主进程内存，撞上打包
 * 资源（embedding 模型上百 MB）就是实打实的卡顿。小说项目里没有接近这个量级的文本文件。
 */
const MAX_SEARCHED_FILE_BYTES = 2 * 1024 * 1024
/** 二进制判据。不写字面 NUL——它会让 git 把整个源文件判成 binary。 */
const NUL = String.fromCharCode(0)

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/** 复刻 pi 内部的 `resolveToCwd`（未导出）：`@` 前缀、unicode 空格、`~` 展开，语义与 find 一致。 */
function resolveToCwd(filePath: string, cwd: string): string {
  const normalized = (filePath.startsWith('@') ? filePath.slice(1) : filePath).replace(UNICODE_SPACES, ' ')
  const expanded =
    normalized === '~' ? homedir() : normalized.startsWith('~/') ? homedir() + normalized.slice(1) : normalized
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 读成行数组；二进制、超大、读不出的一律跳过（rg 同样不搜二进制）。 */
async function readSearchableLines(filePath: string): Promise<string[] | undefined> {
  try {
    const stats = await fs.stat(filePath)
    if (!stats.isFile() || stats.size > MAX_SEARCHED_FILE_BYTES) return undefined
    const content = await fs.readFile(filePath, 'utf-8')
    if (content.includes(NUL)) return undefined
    return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  } catch {
    return undefined
  }
}

async function collectSearchFiles(searchPath: string, globFilter: string | undefined): Promise<string[]> {
  // rg 的 --glob 里不带 `/` 的模式匹配任意深度的文件名（`*.ts` = 全树的 .ts）；tinyglobby 的
  // `*.ts` 只匹配一层，故补 `**/`，否则 agent 写 `glob: '*.md'` 会搜不到任何子目录。
  const pattern = globFilter ? (globFilter.includes('/') ? globFilter : `**/${globFilter}`) : '**/*'
  const matches = await glob(pattern, { cwd: searchPath, dot: true, ignore: IGNORED_GLOBS, onlyFiles: true })
  // tinyglobby 不保证顺序，而 grep 输出顺序会进模型上下文——不排序则同一次搜索两次结果不同。
  return matches.sort().map((entry) => join(searchPath, entry))
}

/**
 * 与内置 grep 同名同形，只是不需要 ripgrep。
 *
 * 拿真 ripgrep 逐项对拍过（真实小说项目，9 组查询）：8 组行集合逐字一致，两处有意分歧——
 *
 * ① **遍历顺序**：rg 并行遍历，同一次搜索两次的文件顺序都可能不同；本实现按字典序，撞上匹配
 *    上限时截到的是同一批。顺序会进模型上下文，稳定比「跟 rg 一样」更重要。
 * ② **带路径的 glob**：rg 的 `--glob` 按**进程 cwd** 匹配，而 pi 的 spawn 从不传 cwd——打包版
 *    主进程的 cwd 不是小说目录，`glob: 'manuscript/**\/*.md'` 在生产上恒零命中（本机实测：
 *    cwd=仓库时 0 命中、cwd=小说目录时 4 命中）。本实现按搜索根解析，这条是修 bug 不是漂移。
 *
 * 其余已知差异（与 find 那刀同源）：不读 `.gitignore`（描述里那句继承自 pi，对小说项目无实际
 * 影响，排除项由 IGNORED_GLOBS 兜住）；单文件超过 2MB 不搜。
 */
export function createPortableGrepTool(cwd: string): ToolDefinition {
  const base = createGrepToolDefinition(cwd)
  const execute: ToolDefinition['execute'] = async (_toolCallId, params, signal) => {
    const {
      pattern,
      path: searchDir,
      glob: globFilter,
      ignoreCase,
      literal,
      context,
      limit,
    } = params as {
      pattern: string
      path?: string
      glob?: string
      ignoreCase?: boolean
      literal?: boolean
      context?: number
      limit?: number
    }
    if (signal?.aborted) throw new Error('Operation aborted')

    const searchPath = resolveToCwd(searchDir || '.', cwd)
    let isDirectory: boolean
    try {
      isDirectory = (await fs.stat(searchPath)).isDirectory()
    } catch {
      throw new Error(`Path not found: ${searchPath}`)
    }

    let regex: RegExp
    try {
      regex = new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? 'i' : '')
    } catch (error) {
      throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`)
    }

    const contextValue = context && context > 0 ? context : 0
    const effectiveLimit = Math.max(1, limit ?? GREP_DEFAULT_LIMIT)
    const files = isDirectory ? await collectSearchFiles(searchPath, globFilter) : [searchPath]

    const matches: Array<{ filePath: string; lineNumber: number; lines: string[] }> = []
    let matchLimitReached = false
    scan: for (const filePath of files) {
      if (signal?.aborted) throw new Error('Operation aborted')
      const lines = await readSearchableLines(filePath)
      if (!lines) continue
      for (let index = 0; index < lines.length; index++) {
        if (!regex.test(lines[index]!)) continue
        matches.push({ filePath, lineNumber: index + 1, lines })
        if (matches.length >= effectiveLimit) {
          matchLimitReached = true
          break scan
        }
      }
    }

    if (matches.length === 0) {
      return { content: [{ type: 'text', text: 'No matches found' }], details: undefined }
    }

    const formatPath = (filePath: string): string => {
      if (isDirectory) {
        const relativePath = relative(searchPath, filePath)
        if (relativePath && !relativePath.startsWith('..')) return relativePath.replace(/\\/g, '/')
      }
      return basename(filePath)
    }

    let linesTruncated = false
    const outputLines: string[] = []
    for (const match of matches) {
      const relativePath = formatPath(match.filePath)
      const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber
      const end = contextValue > 0 ? Math.min(match.lines.length, match.lineNumber + contextValue) : match.lineNumber
      for (let current = start; current <= end; current++) {
        const { text, wasTruncated } = truncateLine(match.lines[current - 1] ?? '')
        if (wasTruncated) linesTruncated = true
        outputLines.push(
          current === match.lineNumber ? `${relativePath}:${current}: ${text}` : `${relativePath}-${current}- ${text}`,
        )
      }
    }

    // 行数不再设限——匹配上限已经封了行数，这里只按字节截。与 pi 逐字一致。
    const truncation = truncateHead(outputLines.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER })
    let output = truncation.content
    const details: { truncation?: typeof truncation; matchLimitReached?: number; linesTruncated?: boolean } = {}
    const notices: string[] = []
    if (matchLimitReached) {
      notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`)
      details.matchLimitReached = effectiveLimit
    }
    if (truncation.truncated) {
      notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`)
      details.truncation = truncation
    }
    if (linesTruncated) {
      notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`)
      details.linesTruncated = true
    }
    if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`

    return {
      content: [{ type: 'text', text: output }],
      details: Object.keys(details).length > 0 ? details : undefined,
    }
  }
  // 只换 execute：name/label/description/schema/渲染函数全部继承 pi 的定义，模型看到的那一面零漂移。
  return { ...(base as unknown as ToolDefinition), execute }
}
