#!/usr/bin/env node
/**
 * 发布说明的格式契约：docs/release-notes/<版本号>.md 怎么写、怎么变成 GitHub Release 的标题与正文。
 * 写法规范见 docs/release-notes/README.md，本文件只管机器能判的那部分。
 *
 * GitHub Release 会被官网更新日志原样同步（标题 → 官网标题，正文 → 官网正文），
 * 所以这里定下的结构就是用户在两处看到的结构：
 *
 *   # 主题标题                    → Release 标题
 *   一句导语。                    ┐
 *   ## 新增 / 改进 / 修复 / 备注  ┘ → Release 正文；通用样板并进「备注」末尾
 *
 * 硬规则（发版前拦下）只管结构对不对；长短、措辞这类判断只出提示，交给写的人和审的人。
 *
 * 命令行预览：node scripts/release-notes.mjs <版本号> [--windows]
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const RELEASE_NOTE_SECTIONS = ['新增', '改进', '修复', '备注']

const TITLE_HINT_MAX = 16
const SUMMARY_HINT_MAX = 60
const ITEM_HINT_MAX = 50

// 按读者看到的字数算：链接只算文字部分，网址不算。
const length = (text) => [...text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')].length

/**
 * 解析一份发布说明。problems = 结构错误（发版会被拦）；hints = 写法提醒（只提示）。
 * 不抛异常：调用方决定拦不拦。
 */
export function parseReleaseNotes(text) {
  const problems = []
  const hints = []
  const lines = String(text).replace(/\r\n/g, '\n').trim().split('\n')

  const titleMatch = /^# (.+)$/.exec(lines[0] ?? '')
  const title = titleMatch ? titleMatch[1].trim() : null
  if (!title) problems.push('第一行要写主题标题：`# 标题`')

  let index = title ? 1 : 0
  const summaryLines = []
  while (index < lines.length && !lines[index].startsWith('## ')) {
    const line = lines[index].trim()
    if (line) summaryLines.push(line)
    index += 1
  }
  const summary = summaryLines.join('')
  if (!summary) problems.push('标题下要有一句导语，说清这一版对用户是什么')
  else if (summaryLines.some((line) => /^([-*#>]|\d+\.)\s/.test(line))) {
    problems.push('导语只写一段话，条目放进下面的分块')
  }

  const sections = []
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      const name = heading[1].trim()
      const order = RELEASE_NOTE_SECTIONS.indexOf(name)
      if (order === -1) {
        problems.push(`分块只能是 ${RELEASE_NOTE_SECTIONS.join(' / ')}，不认「${name}」`)
      } else if (sections.some((section) => section.name === name)) {
        problems.push(`「${name}」出现了两次`)
      } else if (sections.length > 0 && RELEASE_NOTE_SECTIONS.indexOf(sections.at(-1).name) > order) {
        problems.push(`分块顺序要按 ${RELEASE_NOTE_SECTIONS.join(' → ')}，「${name}」放错了位置`)
      }
      sections.push({ name, items: [] })
      continue
    }
    const item = /^- (.+)$/.exec(line)
    if (!item || sections.length === 0) {
      problems.push(`分块里每条都写成一行 \`- 条目\`：${line.slice(0, 30)}`)
      continue
    }
    sections.at(-1).items.push(item[1].trim())
  }

  for (const section of sections) {
    if (section.items.length === 0) problems.push(`「${section.name}」是空的——没有内容就整块删掉`)
  }
  if (!sections.some((section) => section.name !== '备注' && section.items.length > 0)) {
    problems.push('新增 / 改进 / 修复 至少要有一块')
  }

  if (title && length(title) > TITLE_HINT_MAX) hints.push(`标题 ${length(title)} 字，建议 ${TITLE_HINT_MAX} 字以内`)
  if (length(summary) > SUMMARY_HINT_MAX) hints.push(`导语 ${length(summary)} 字，建议一句话、${SUMMARY_HINT_MAX} 字以内`)
  for (const section of sections) {
    for (const item of section.items) {
      if (length(item) > ITEM_HINT_MAX) hints.push(`「${section.name}」有一条 ${length(item)} 字：${item.slice(0, 20)}…`)
      if (item.includes('**')) hints.push(`「${section.name}」有一条用了加粗，条目里不加粗：${item.slice(0, 20)}…`)
    }
  }

  return { title, summary, sections, problems, hints }
}

/** 每一版都要告诉用户的事，并进「备注」末尾。 */
export function boilerplateNotes({ hasWindows }) {
  return [
    `已装旧版启动后会自动更新，重启生效；首次安装 macOS 下载 dmg${hasWindows ? '、Windows 下载 exe' : ''}`,
    ...(hasWindows
      ? ['Windows 版暂未代码签名，首次运行若提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」即可']
      : []),
  ]
}

/** notes = parseReleaseNotes 的结果；null = 这一版没写，只发通用样板。 */
export function renderReleaseBody(notes, { hasWindows }) {
  const sections = (notes?.sections ?? []).map((section) => ({ ...section, items: [...section.items] }))
  let remarks = sections.find((section) => section.name === '备注')
  if (!remarks) {
    remarks = { name: '备注', items: [] }
    sections.push(remarks)
  }
  remarks.items.push(...boilerplateNotes({ hasWindows }))
  return [
    ...(notes?.summary ? [notes.summary] : []),
    ...sections.map((section) => `## ${section.name}\n\n${section.items.map((item) => `- ${item}`).join('\n')}`),
  ].join('\n\n')
}

export function releaseNotesPath(clientVersion, root) {
  return join(root, 'docs', 'release-notes', `${clientVersion}.md`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
  if (!version) {
    process.stderr.write('用法：node scripts/release-notes.mjs <版本号> [--windows]\n')
    process.exit(1)
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const notes = parseReleaseNotes(readFileSync(releaseNotesPath(version, root), 'utf8'))
  const hasWindows = process.argv.includes('--windows')
  process.stdout.write(`标题：${notes.title ?? `NarraCat ${version}`}\n\n${renderReleaseBody(notes, { hasWindows })}\n`)
  for (const hint of notes.hints) process.stdout.write(`\n· 提示：${hint}`)
  for (const problem of notes.problems) process.stdout.write(`\n✗ 问题：${problem}`)
  process.stdout.write('\n')
  process.exit(notes.problems.length > 0 ? 1 : 0)
}
