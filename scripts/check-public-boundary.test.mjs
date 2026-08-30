// 公开仓防泄漏守卫：私有资产不得被 git 追踪，个人标识不得入库。
// 旧私有仓（license=UNLICENSED）自动跳过；新公开仓（AGPL-3.0-only）强制生效。
import { test, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const license = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).license
const isPublicRepo = license === 'AGPL-3.0-only'

// 2026-08-16：本仓升格为唯一开发仓，工程契约文档（项目地图 / ADR / 工作流纪律）随代码公开，
// 故从本表移除。留在表里的是私产：研究工具、内部战略与过程流水（COMPASS / report / plans / research）。
// 引擎侧 docs/ 整体放行，但其中同性质的 plans/ 与 reports/ 单独禁回来——与仓库根的
// docs/plans/ docs/report/ 对称，别让引擎侧成为绕过口。
const FORBIDDEN_TRACKED_PREFIXES = [
  'agent-core/narracat/skills/novel-style-reference/references/corpus/',
  'agent-core/narracat/eval/', 'agent-core/narracat/CHANGELOG.md',
  'docs/COMPASS.md',
  '.claude/', '.agents/', '.superpowers/', 'poc/',
  'docs/superpowers/', 'docs/plans/', 'docs/report/', 'docs/research/',
  'scripts/corpus-factory/',
  'scripts/reader-sim/',
  'agent-core/narracat/docs/plans/', 'agent-core/narracat/docs/reports/',
]
// 上面两个引擎侧前缀是 2026-08-16 补的（此前完全无守卫）。补的时候这 4 份已通过逐文件
// 人工脱敏扫描、判定可公开并入库，故按文件粒度放行；目的是「今后新增的一律拦下」，
// 而不是回头把已审文件挖掉。新增文件要进这两个目录，得先过同一道人工扫描再显式加进来。
const TRACKED_ALLOWLIST = new Set([
  'agent-core/narracat/docs/plans/2026-06-12-agent-core-4.0-rebuild-design.md',
  'agent-core/narracat/docs/plans/2026-06-13-legacy-capability-backlog.md',
  'agent-core/narracat/docs/reports/2026-03-28-system-audit-anti-template.md',
  'agent-core/narracat/docs/reports/2026-04-26-system-debt-analysis.md',
  // 2026-08-30：`.claude/skills/` 下的工程工具（发版、内测门控）随代码入仓——它们是
  // 团队工具而非上面注释所指的「私产」，且 scripts/release-skill-preflight.test.mjs
  // 引用 release-app 的预检脚本，不跟踪的话那条守卫在 CI 上必红。
  // 仍按文件粒度放行、不整目录开口：`.claude/` 里还有 settings.local.json 这类本机配置，
  // 而 skill 正文最容易夹带本机绝对路径或内部端点。以下 4 份已过内容扫描，
  // 今后新增的 skill 文件依旧会被前缀规则拦下，逼人再审一次——这正是本表的用法。
  '.claude/skills/release-app/SKILL.md',
  '.claude/skills/release-app/scripts/preflight.mjs',
  '.claude/skills/release-guard/SKILL.md',
  '.claude/skills/release-guard/scripts/status.mjs',
])
// 允许 yannikzz；禁其余个人标识与私有基础设施标识。
// Yannik Zhang / AHRB2HD27M（Apple Team ID）是 2026-08-16 人工扫描才发现的正则盲区，补入防复发。
// the-lumos-labs / narracat-corpus-service：私有组织名与私有仓名，两道守卫原本都不拦，同日补入。
// corpus.narracat.com 有意不收：那是客户端真实调用的线上端点，反编译即得，藏不住也不必藏。
const FORBIDDEN_CONTENT = [
  '/Users/yannik', 'yangnik528', 'yannikzhang528', '张子扬', 'Yannik Zhang', 'AHRB2HD27M',
  'the-lumos-labs', 'narracat-corpus-service',
]
// 内容扫描的文件级豁免：值本身是被代码消费的事实记录，改值会让记录失真。
// narracat-agent-core.lock.json 的 upstream.repo 由 audit-narracat-prompts.mjs 的
// formatPromptDriftReport 读出并打印（`${report.upstream.repo}@${commit}`），是 2026-06-02
// 那次 accepted upstream import 的溯源凭证，不是可随手改写的文案。
const CONTENT_EXEMPT_FILES = new Set(['agent-core/narracat-agent-core.lock.json'])

const tracked = () => execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)

test(isPublicRepo ? '私有资产路径不被 git 追踪' : '(skip)', () => {
  if (!isPublicRepo) return
  const bad = tracked().filter((f) =>
    !TRACKED_ALLOWLIST.has(f) &&
    FORBIDDEN_TRACKED_PREFIXES.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)))
  expect(bad).toEqual([])
})

test(isPublicRepo ? '追踪文件内容不含个人标识与私有基础设施标识' : '(skip)', () => {
  if (!isPublicRepo) return
  const hits = []
  for (const f of tracked()) {
    // 跳过守卫自身（包含禁用串作为数据常量，导致自指）
    if (f === 'scripts/check-public-boundary.test.mjs') continue
    if (CONTENT_EXEMPT_FILES.has(f)) continue
    let text
    try { text = readFileSync(join(repoRoot, f), 'utf8') } catch { continue }
    for (const needle of FORBIDDEN_CONTENT) if (text.includes(needle)) hits.push(`${f}: ${needle}`)
  }
  expect(hits).toEqual([])
})

test(!isPublicRepo ? '私有仓：守卫按设计跳过' : '(skip)', () => {
  if (isPublicRepo) return
  expect(license).toBe('UNLICENSED')
})
