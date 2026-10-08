/**
 * 学习工作区组装（刀4）。合规硬约束的实施点：learned-own 只经 loadNovelChapters 读
 * 成稿正文 manuscript/vol-NN/ch-NNN.md（目录契约=novel-layout.ts，含 legacy 平铺兼容），
 * bible/references 与 bible/reference-guidance 结构上不进入工作区（spec §7；测试锁定）。
 * 两种来源 normalize 成同一 LearnSourceChapters，走同一条管线。
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, extname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { XMLParser } from 'fast-xml-parser'
import { decodeBookBuffer, cleanBookLines, splitBookChapters, type BookChapter } from './book-normalize'
import { MANUSCRIPT_DIR } from '../novel/novel-layout'

export interface LearnSourceChapters {
  sourceKind: 'novel' | 'file' | 'txt'
  title: string
  chapters: BookChapter[]
}

const SKIM_HEAD = 3
const SKIM_TOTAL = 10
const DEEP_TOTAL = 30

export function planSampling(totalChapters: number, tier: 'skim' | 'deep'): number[] {
  const target = tier === 'skim' ? SKIM_TOTAL : DEEP_TOTAL
  if (totalChapters <= target) return Array.from({ length: totalChapters }, (_, i) => i)
  const picks = new Set<number>()
  for (let i = 0; i < SKIM_HEAD; i++) picks.add(i)
  const rest = target - picks.size
  for (let k = 0; k < rest; k++) {
    // 在 [SKIM_HEAD, totalChapters-1] 均匀取点
    picks.add(SKIM_HEAD + Math.round((k * (totalChapters - 1 - SKIM_HEAD)) / Math.max(1, rest - 1)))
  }
  return [...picks].sort((a, b) => a - b).slice(0, target)
}

const CHAPTER_FILE_RE = /^ch-\d+\.md$/
const VOLUME_DIR_RE = /^vol-\d+$/

/**
 * 按 novel-layout 契约（`electron/main/novel/novel-layout.ts`）扫描成稿目录，
 * 返回相对 manuscript/ 的路径列表：`vol-NN/ch-XXX.md` 子目录布局 + legacy 平铺
 * `ch-XXX.md` 两种都读，按数值序排列（跨卷正确，见 reference-works.ts 的
 * localeCompare numeric 先例）。白名单结构性：只在 manuscript/ 下拼路径，
 * 文件名全部来自 readdir 且经正则过滤，不触碰 bible/。
 */
async function collectManuscriptChapterFiles(manuscriptDir: string): Promise<string[]> {
  let topEntries: Dirent[] = []
  try {
    topEntries = await readdir(manuscriptDir, { withFileTypes: true })
  } catch {
    return []
  }
  const relativeFiles: string[] = []
  for (const entry of topEntries) {
    if (entry.isDirectory() && VOLUME_DIR_RE.test(entry.name)) {
      let chapterFiles: string[] = []
      try {
        chapterFiles = (await readdir(join(manuscriptDir, entry.name))).filter((f) => CHAPTER_FILE_RE.test(f))
      } catch {
        chapterFiles = []
      }
      for (const file of chapterFiles) relativeFiles.push(join(entry.name, file))
    } else if (entry.isFile() && CHAPTER_FILE_RE.test(entry.name)) {
      relativeFiles.push(entry.name)
    }
  }
  return relativeFiles.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
}

export async function loadNovelChapters(projectPath: string, title: string): Promise<LearnSourceChapters> {
  const manuscriptDir = join(projectPath, MANUSCRIPT_DIR)
  const files = await collectManuscriptChapterFiles(manuscriptDir)
  if (files.length === 0) throw new Error('这本书还没有正文，无法学习。')
  const chapters: BookChapter[] = []
  for (const file of files) {
    const raw = await readFile(join(manuscriptDir, file), 'utf8')
    const newline = raw.indexOf('\n')
    const first = (newline === -1 ? raw : raw.slice(0, newline)).replace(/^#+\s*/, '').trim()
    chapters.push({
      title: first || basename(file, '.md'),
      body: (newline === -1 ? '' : raw.slice(newline + 1)).trim(),
    })
  }
  return { sourceKind: 'novel', title, chapters }
}

// T11 评审 F2：外部 txt 是用户自己选的文件，没有 Task 5 那层白名单装载兜底——选错文件（整套合集、
// 网页存档、日志导出……）会把巨量文本塞进内存/发进学习会话。30MB 已远超单本网文正常体量
// （千万字级单本网文 utf8 编码约 30MB，百万字长篇通常几 MB），超出即视为选错，直接拒绝而不是
// 让后面的 decode/split/学习会话去扛（PR#477 外审 P2-6：原 100MB 上限配合全书精确 Set 索引可致
// 主进程 OOM，现窗口层已改 Bloom filter 覆盖全书，此处上限单纯收紧到"正常单本书"量级）。
export const MAX_EXTERNAL_BOOK_BYTES = 30 * 1024 * 1024
const MAX_EPUB_CONTENT_BYTES = 40 * 1024 * 1024
const MAX_EPUB_ENTRIES = 5000
const MAX_PDF_PAGES = 2000

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true, processEntities: false })
const xhtmlParser = new XMLParser({ preserveOrder: true, removeNSPrefix: true, trimValues: false, processEntities: false })
const blockTags = new Set(['article', 'blockquote', 'br', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'p', 'section', 'tr'])
const ignoredTags = new Set(['head', 'nav', 'script', 'style', 'svg'])

function decodeXmlEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' }
  return text.replace(/&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match
    const codePoint = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
    return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match
  })
}

function orderedBodyText(nodes: unknown, inBody = false): string {
  if (!Array.isArray(nodes)) return ''
  let output = ''
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    for (const [tag, value] of Object.entries(node)) {
      if (tag === '#text') {
        if (inBody) output += decodeXmlEntities(String(value))
      } else if (!tag.startsWith(':') && !ignoredTags.has(tag)) {
        const active = inBody || tag === 'body'
        if (active && blockTags.has(tag)) output += '\n'
        output += orderedBodyText(value, active)
        if (active && blockTags.has(tag)) output += '\n'
      }
    }
  }
  return output
}

function archivePath(base: string, href: string): string {
  const decoded = decodeURIComponent(decodeXmlEntities(href).split(/[?#]/, 1)[0])
  if (!decoded || decoded.startsWith('/') || decoded.includes('\\')) throw new Error('EPUB 内的正文路径不合法。')
  const path = posix.normalize(posix.join(posix.dirname(base), decoded))
  if (path === '..' || path.startsWith('../')) throw new Error('EPUB 内的正文路径不合法。')
  return path
}

function asList<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function loadEpubChapters(data: Buffer): BookChapter[] {
  const zip = new AdmZip(data)
  const mimetype = zip.getEntry('mimetype')
  if (zip.getEntries().length > MAX_EPUB_ENTRIES || !mimetype || mimetype.header.size > 64 || mimetype.getData().toString('utf8').trim() !== 'application/epub+zip') {
    throw new Error('这不是可读取的 EPUB 文件。')
  }
  let decodedBytes = 0
  const readEntry = (name: string): string => {
    const entry = zip.getEntry(name)
    if (!entry || entry.isDirectory || entry.header.size > MAX_EXTERNAL_BOOK_BYTES) throw new Error('EPUB 的正文文件缺失或过大。')
    decodedBytes += entry.header.size
    if (decodedBytes > MAX_EPUB_CONTENT_BYTES) throw new Error('这本 EPUB 的正文过大。')
    return entry.getData().toString('utf8')
  }
  const container = xmlParser.parse(readEntry('META-INF/container.xml')) as {
    container?: { rootfiles?: { rootfile?: { 'full-path'?: string } | Array<{ 'full-path'?: string }> } }
  }
  const packagePath = asList(container.container?.rootfiles?.rootfile)[0]?.['full-path']
  if (!packagePath) throw new Error('EPUB 缺少书籍目录。')
  const opfPath = archivePath('root.opf', packagePath)
  const opf = xmlParser.parse(readEntry(opfPath)) as {
    package?: {
      manifest?: { item?: { id?: string; href?: string; 'media-type'?: string; properties?: string } | Array<{ id?: string; href?: string; 'media-type'?: string; properties?: string }> }
      spine?: { itemref?: { idref?: string; linear?: string } | Array<{ idref?: string; linear?: string }> }
    }
  }
  const manifest = new Map(asList(opf.package?.manifest?.item).map((item) => [item.id, item]))
  const chapters: BookChapter[] = []
  for (const ref of asList(opf.package?.spine?.itemref)) {
    const item = manifest.get(ref.idref)
    if (!item?.href || ref.linear === 'no' || item.properties?.split(/\s+/).includes('nav')) continue
    if (item['media-type'] !== 'application/xhtml+xml' && item['media-type'] !== 'text/html') continue
    const path = archivePath(opfPath, item.href)
    const raw = orderedBodyText(xhtmlParser.parse(readEntry(path)))
    const body = cleanBookLines(raw).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (!body) continue
    const title = body.split('\n', 1)[0].trim().slice(0, 80) || basename(path)
    chapters.push({ title, body })
  }
  if (chapters.length === 1) return splitBookChapters(chapters[0].body)
  return chapters
}

async function loadPdfChapters(data: Buffer): Promise<BookChapter[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const standardFontDataUrl = fileURLToPath(new URL('../../standard_fonts/', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')))
  const task = getDocument({ data: new Uint8Array(data), disableFontFace: true, standardFontDataUrl })
  try {
    const pdf = await task.promise
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error('这本 PDF 页数过多。')
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join('').trim()
      if (text) pages.push(text)
      page.cleanup()
    }
    if (pages.length === 0) throw new Error('这本 PDF 没有可提取的文字；扫描版暂不支持。')
    return splitBookChapters(cleanBookLines(pages.join('\n')))
  } finally {
    await task.destroy()
  }
}

export async function loadExternalBook(filePath: string): Promise<LearnSourceChapters> {
  const extension = extname(filePath).toLowerCase()
  if (!['.txt', '.epub', '.pdf'].includes(extension)) throw new Error('请选择 TXT、EPUB 或 PDF 文件。')
  const fileStat = await stat(filePath)
  if (fileStat.size > MAX_EXTERNAL_BOOK_BYTES) {
    throw new Error('这个文件太大，请确认选的是单本电子书。')
  }
  const buf = await readFile(filePath)
  const chapters = extension === '.epub'
    ? loadEpubChapters(buf)
    : extension === '.pdf'
      ? await loadPdfChapters(buf)
      : splitBookChapters(cleanBookLines(decodeBookBuffer(new Uint8Array(buf)).text))
  if (chapters.length === 0) throw new Error('这个文件里读不出正文内容。')
  return { sourceKind: 'file', title: basename(filePath, extension), chapters }
}

export function estimateLearnRun(
  source: LearnSourceChapters,
  tier: 'skim' | 'deep',
): { chapterCount: number; sampledCount: number; approxChars: number } {
  const picks = planSampling(source.chapters.length, tier)
  const approxChars = picks.reduce((sum, i) => sum + source.chapters[i].body.length, 0)
  return { chapterCount: source.chapters.length, sampledCount: picks.length, approxChars }
}

export async function assembleLearnWorkspace(input: {
  workspaceDir: string
  source: LearnSourceChapters
  tier: 'skim' | 'deep'
}): Promise<{ sampledIndices: number[]; fullText: string; sampledText: string }> {
  const sampledIndices = planSampling(input.source.chapters.length, input.tier)
  await mkdir(join(input.workspaceDir, 'source'), { recursive: true })
  await mkdir(join(input.workspaceDir, 'output'), { recursive: true })
  for (const i of sampledIndices) {
    const ch = input.source.chapters[i]
    const name = `ch-${String(i + 1).padStart(4, '0')}.md`
    await writeFile(join(input.workspaceDir, 'source', name), `# ${ch.title}\n\n${ch.body}\n`, 'utf8')
  }
  if (input.tier === 'deep') {
    const toc = input.source.chapters.map((ch, index) => ({ index: index + 1, title: ch.title, chars: ch.body.length }))
    await writeFile(join(input.workspaceDir, 'source', 'toc.json'), JSON.stringify(toc, null, 2), 'utf8')
  }
  const fullText = input.source.chapters.map((c) => c.body).join('\n')
  // 模型只见过抽样章——精确窗口 Set（buildWindowIndex）只该对这部分文本建，不该对全书建
  // （PR#477 外审 P2-6：全书精确 Set 是百万字级、几十 MB 常驻内存的 OOM 风险源；全书层的
  // 防抄袭覆盖交给 fingerprint.windowBloom，见 pack-learn.ts / text-reuse-scan.ts）。
  const sampledText = sampledIndices.map((i) => input.source.chapters[i].body).join('\n')
  return { sampledIndices, fullText, sampledText }
}
