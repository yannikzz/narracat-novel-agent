import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import {
  planSampling,
  loadNovelChapters,
  loadExternalBook,
  estimateLearnRun,
  assembleLearnWorkspace,
  MAX_EXTERNAL_BOOK_BYTES,
} from './pack-learn-workspace'

// T11 评审 F2：loadExternalBook 的超限拒绝靠 stat().size 判断，真造一个 >100MB 的 fixture 不现实
// （拖慢测试、污染仓库体积）。改为 mock `node:fs/promises` 的 `stat`，只接管这一个函数，其余
// （mkdir/readdir/readFile/writeFile）经 spread 原始 fsp 命名空间保持真实实现。已用最小复现脚本
// 验证过：bun test 对每个测试文件的模块图独立隔离，本文件内的 mock.module 不会泄漏到同目录其它
// *.test.ts（两个独立文件，一个 mock stat 另一个仍读到真实文件大小），不影响 pack-store.test.ts
// 等同样用到 stat 的其它文件的回归。
// 坑（已实测踩到并修复）：`mock.module()` 会retroactively 改写同一 specifier 的活绑定——如果
// pass-through 分支直接调 `fsp.stat(path)`，`fsp` 这个模块命名空间在 mock 生效后会自我指向刚装好
// 的 mock（`fsp.stat === 这个 mock 函数本身`），导致每次调用真实 stat 都会递归调用自己，
// CPU 100% 死循环、测试永不收尾。修法：在 `mock.module()` 调用之前把真实 `stat` 抓成一个普通变量
// （`realStat`，非模块活绑定），pass-through 分支调 `realStat` 而不是 `fsp.stat`。
const realStat = fsp.stat
let forcedStatSize: number | null = null
mock.module('node:fs/promises', () => ({
  ...fsp,
  stat: (path: Parameters<typeof fsp.stat>[0]) =>
    forcedStatSize !== null ? Promise.resolve({ size: forcedStatSize }) : realStat(path),
}))

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'narracat-learn-ws-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

function writeEpub(path: string): void {
  const zip = new AdmZip()
  zip.addFile('mimetype', Buffer.from('application/epub+zip'))
  zip.addFile('META-INF/container.xml', Buffer.from('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>'))
  zip.addFile('OPS/content.opf', Buffer.from('<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="second" href="second.xhtml" media-type="application/xhtml+xml"/><item id="first" href="first.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="first"/><itemref idref="nav"/><itemref idref="second"/></spine></package>'))
  zip.addFile('OPS/nav.xhtml', Buffer.from('<html><body><p>目录不可当正文</p></body></html>'))
  zip.addFile('OPS/first.xhtml', Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>甲 &amp; 乙。</p><script>不要读脚本</script></body></html>'))
  zip.addFile('OPS/second.xhtml', Buffer.from('<html><body><h1>第二章</h1><p>后续正文。</p></body></html>'))
  zip.writeZip(path)
}

function writePdf(path: string, text: string | null): void {
  const commands = text === null ? '' : `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  writeFileSync(path, pdf)
}

describe('planSampling', () => {
  test('skim：前3 + 均匀7，升序去重', () => {
    const picks = planSampling(100, 'skim')
    expect(picks.length).toBe(10)
    expect(picks.slice(0, 3)).toEqual([0, 1, 2])
    expect([...picks].sort((a, b) => a - b)).toEqual(picks)
    expect(new Set(picks).size).toBe(picks.length)
  })
  test('deep：补至 30', () => {
    expect(planSampling(200, 'deep').length).toBe(30)
  })
  test('总章数不足全取', () => {
    expect(planSampling(5, 'deep')).toEqual([0, 1, 2, 3, 4])
  })
})

describe('loadNovelChapters（合规白名单）', () => {
  test('只读 manuscript/vol-NN/，references 内容不进结果', async () => {
    const project = join(tmp, 'novel-x')
    mkdirSync(join(project, 'manuscript', 'vol-01'), { recursive: true })
    mkdirSync(join(project, 'bible', 'references'), { recursive: true })
    mkdirSync(join(project, 'bible', 'reference-guidance'), { recursive: true })
    writeFileSync(join(project, 'manuscript', 'vol-01', 'ch-001.md'), '# 第一章\n\n正文甲', 'utf8')
    writeFileSync(join(project, 'manuscript', 'vol-01', 'ch-002.md'), '# 第二章\n\n正文乙', 'utf8')
    writeFileSync(join(project, 'bible', 'references', 'ext.md'), '外部参考原文·不得进入', 'utf8')
    writeFileSync(join(project, 'bible', 'reference-guidance', 'style.md'), '提炼指导·不得进入', 'utf8')
    const source = await loadNovelChapters(project, '试书')
    expect(source.chapters.length).toBe(2)
    const all = source.chapters.map((c) => `${c.title}\n${c.body}`).join('\n')
    expect(all).not.toContain('不得进入')
  })
  test('legacy 平铺布局 manuscript/ch-NNN.md 也读得到', async () => {
    const project = join(tmp, 'novel-legacy')
    mkdirSync(join(project, 'manuscript'), { recursive: true })
    writeFileSync(join(project, 'manuscript', 'ch-001.md'), '# 第一章\n\n正文甲', 'utf8')
    writeFileSync(join(project, 'manuscript', 'ch-002.md'), '# 第二章\n\n正文乙', 'utf8')
    const source = await loadNovelChapters(project, '试书')
    expect(source.chapters.length).toBe(2)
    expect(source.chapters[0].title).toBe('第一章')
    expect(source.chapters[1].title).toBe('第二章')
  })
  test('排序按数值序，且跨卷正确（vol-01 全部在 vol-02 之前）', async () => {
    const project = join(tmp, 'novel-order')
    mkdirSync(join(project, 'manuscript', 'vol-01'), { recursive: true })
    mkdirSync(join(project, 'manuscript', 'vol-02'), { recursive: true })
    writeFileSync(join(project, 'manuscript', 'vol-01', 'ch-999.md'), '# 卷一·999\n\n正文', 'utf8')
    writeFileSync(join(project, 'manuscript', 'vol-01', 'ch-002.md'), '# 卷一·002\n\n正文', 'utf8')
    writeFileSync(join(project, 'manuscript', 'vol-01', 'ch-1000.md'), '# 卷一·1000\n\n正文', 'utf8')
    writeFileSync(join(project, 'manuscript', 'vol-02', 'ch-001.md'), '# 卷二·001\n\n正文', 'utf8')
    const source = await loadNovelChapters(project, '试书')
    expect(source.chapters.map((c) => c.title)).toEqual(['卷一·002', '卷一·999', '卷一·1000', '卷二·001'])
  })
  test('无章节时抛人话错误', async () => {
    const project = join(tmp, 'novel-empty')
    mkdirSync(project, { recursive: true })
    await expect(loadNovelChapters(project, '空书')).rejects.toThrow('这本书还没有正文')
  })
})

describe('assembleLearnWorkspace', () => {
  const source = {
    sourceKind: 'txt' as const,
    title: '试书',
    chapters: Array.from({ length: 40 }, (_, i) => ({ title: `第${i + 1}章`, body: `正文${i + 1}`.repeat(50) })),
  }
  test('skim：落抽样章 + output/，无 toc.json', async () => {
    const ws = join(tmp, 'ws1')
    const { sampledIndices } = await assembleLearnWorkspace({ workspaceDir: ws, source, tier: 'skim' })
    expect(sampledIndices.length).toBe(10)
    expect(existsSync(join(ws, 'output'))).toBe(true)
    expect(existsSync(join(ws, 'source', 'toc.json'))).toBe(false)
    const files = readdirSync(join(ws, 'source'))
    expect(files.filter((f) => f.endsWith('.md')).length).toBe(10)
    expect(await readFile(join(ws, 'source', 'ch-0001.md'), 'utf8')).toContain('# 第1章')
  })
  test('deep：含全书 toc.json；fullText 含未抽样章（index 30 = 第31章，deep 40 章抽样不含它）', async () => {
    const ws = join(tmp, 'ws2')
    const { sampledIndices, fullText } = await assembleLearnWorkspace({ workspaceDir: ws, source, tier: 'deep' })
    const toc = JSON.parse(await readFile(join(ws, 'source', 'toc.json'), 'utf8'))
    expect(toc.length).toBe(40)
    expect(sampledIndices).not.toContain(30)
    expect(fullText).toContain('正文31')
  })
  test('sampledText 只含抽样章正文，不含未抽样章（PR#477 P2-6：精确窗口索引只该对模型看过的文本建）', async () => {
    const ws = join(tmp, 'ws3')
    const { sampledIndices, sampledText } = await assembleLearnWorkspace({ workspaceDir: ws, source, tier: 'deep' })
    expect(sampledIndices).not.toContain(30)
    expect(sampledText).not.toContain('正文31') // index 30 = 第31章，deep 未抽样到
    for (const i of sampledIndices) expect(sampledText).toContain(`正文${i + 1}`)
  })
})

describe('loadExternalBook（外部书大小护栏，T11 评审 F2）', () => {
  afterEach(() => { forcedStatSize = null })

  test('超过 MAX_EXTERNAL_BOOK_BYTES 拒绝，走人话错误', async () => {
    const txtPath = join(tmp, '太大了.txt')
    writeFileSync(txtPath, '正文'.repeat(10), 'utf8')
    forcedStatSize = MAX_EXTERNAL_BOOK_BYTES + 1
    await expect(loadExternalBook(txtPath)).rejects.toThrow('这个文件太大，请确认选的是单本电子书。')
  })

  test('阈值以内正常读出章节（真实文件大小，不 mock stat）', async () => {
    const txtPath = join(tmp, '正常书.txt')
    writeFileSync(txtPath, `第1章 开局\n${'正文。'.repeat(100)}\n第2章 发展\n正文二`, 'utf8')
    const source = await loadExternalBook(txtPath)
    expect(source.chapters.length).toBeGreaterThan(0)
  })

  test('EPUB 按 spine 顺序读取正文，跳过目录和脚本', async () => {
    const path = join(tmp, '测试.epub')
    writeEpub(path)
    const source = await loadExternalBook(path)
    expect(source.sourceKind).toBe('file')
    expect(source.title).toBe('测试')
    expect(source.chapters.map((chapter) => chapter.title)).toEqual(['第一章', '第二章'])
    expect(source.chapters[0].body).toContain('甲 & 乙。')
    expect(source.chapters.map((chapter) => chapter.body).join('')).not.toContain('目录不可当正文')
    expect(source.chapters.map((chapter) => chapter.body).join('')).not.toContain('不要读脚本')
  })

  test('文字版 PDF 可提取正文；扫描版给出明确错误', async () => {
    const textPath = join(tmp, 'text.pdf')
    const scanPath = join(tmp, 'scan.pdf')
    writePdf(textPath, 'A readable chapter')
    writePdf(scanPath, null)
    expect((await loadExternalBook(textPath)).chapters[0].body).toContain('A readable chapter')
    await expect(loadExternalBook(scanPath)).rejects.toThrow('扫描版暂不支持')
  })

  test('拒绝不支持的后缀和伪造的 EPUB', async () => {
    const unsupported = join(tmp, 'book.docx')
    const fake = join(tmp, 'fake.epub')
    writeFileSync(unsupported, 'text')
    writeFileSync(fake, 'text')
    await expect(loadExternalBook(unsupported)).rejects.toThrow('请选择 TXT、EPUB 或 PDF 文件。')
    await expect(loadExternalBook(fake)).rejects.toThrow()
  })
})

describe('estimateLearnRun', () => {
  test('返回抽样字数', () => {
    const est = estimateLearnRun({ sourceKind: 'txt', title: 't', chapters: [{ title: 'a', body: '字'.repeat(2000) }, { title: 'b', body: '字'.repeat(2000) }] }, 'skim')
    expect(est.chapterCount).toBe(2)
    expect(est.sampledCount).toBe(2)
    expect(est.approxChars).toBe(4000)
  })
})
