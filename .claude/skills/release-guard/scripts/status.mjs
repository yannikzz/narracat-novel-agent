#!/usr/bin/env node
// 内测「释放门控」状态查看：拉线上 Worker 当前配置 + 解读现在拦不拦人 + 检测本地未部署的改动。
// 自定位仓库根（向上找 electron/main/release-guard-runtime.ts），可在任意 cwd 下运行。
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLACEHOLDER = 'https://narracat-release-guard.example.workers.dev'

function findRepoRoot(start) {
  let dir = start
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'electron/main/release-guard-runtime.ts'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function extractUrl(src) {
  const m = src.match(/RELEASE_GUARD_URL\s*=\s*['"]([^'"]+)['"]/)
  return m ? m[1] : null
}

// 从 worker src/index.ts 的 RELEASE_GATE 抠 4 个字段（容错；全抠不到返回 null）
function extractGate(src) {
  const pick = (re) => {
    const m = src.match(re)
    return m ? m[1] : null
  }
  const minVersion = pick(/minVersion:\s*['"]([^'"]*)['"]/)
  const deadline = pick(/deadline:\s*['"]([^'"]*)['"]/)
  const killStr = pick(/kill:\s*(true|false)/)
  const notice = pick(/notice:\s*['"]([^'"]*)['"]/)
  if (minVersion === null && deadline === null && killStr === null) return null
  return {
    minVersion: minVersion ?? '',
    deadline: deadline ?? '',
    kill: killStr === 'true',
    notice: notice ?? '',
  }
}

async function fetchLive(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    return { config: await res.json() }
  } catch (e) {
    return { error: e?.message || String(e) }
  } finally {
    clearTimeout(timer)
  }
}

function interpret(cfg) {
  if (!cfg || typeof cfg !== 'object') return '⚠ 无法解读线上配置'
  if (cfg.kill === true) return '🔴 急刹车开启 —— 所有版本启动即被拦'
  const now = Date.now()
  const deadline = typeof cfg.deadline === 'string' ? cfg.deadline.trim() : ''
  const minVersion = typeof cfg.minVersion === 'string' ? cfg.minVersion.trim() : ''
  if (deadline) {
    const dMs = Date.parse(deadline)
    if (Number.isFinite(dMs)) {
      if (now >= dMs) return `🔴 已过截止日（${deadline}）—— 所有版本被拦`
      const days = Math.ceil((dMs - now) / 86400000)
      let line = `🟢 放行 —— 截止日 ${deadline}，还有 ${days} 天`
      if (minVersion) line += `；且低于 ${minVersion} 的版本会被拦`
      return line
    }
    return `⚠ deadline 格式无法解析（${deadline}）—— App 会忽略该日期`
  }
  if (minVersion) return `🟢 放行 —— 但低于 ${minVersion} 的版本会被拦`
  return '🟢 全放行 —— 未设任何拦截条件'
}

function gateEqual(a, b) {
  if (!a || !b) return false
  return (
    (a.minVersion ?? '') === (b.minVersion ?? '') &&
    (a.deadline ?? '') === (b.deadline ?? '') &&
    Boolean(a.kill) === Boolean(b.kill) &&
    (a.notice ?? '') === (b.notice ?? '')
  )
}

const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)))
if (!root) {
  console.error('找不到仓库根（缺 electron/main/release-guard-runtime.ts）。请在 NarraCat-app 仓库内运行。')
  process.exit(1)
}

const runtimeSrc = await readFile(join(root, 'electron/main/release-guard-runtime.ts'), 'utf8')
const url = extractUrl(runtimeSrc)

console.log('# 内测释放门控 · 状态\n')
console.log(`App 调用地址：${url ?? '（未在 release-guard-runtime.ts 找到 RELEASE_GUARD_URL）'}`)

if (!url || url === PLACEHOLDER) {
  console.log('\n⚠ 尚未部署 / 未回填真实 Worker URL（仍是占位）。')
  console.log('  App 当前会跳过远程拉取，只剩「构建后 90 天」硬过期兜底。')
  console.log('  部署见 workers/release-guard/README.md，或让我直接 wrangler deploy 并回填 URL。')
  process.exit(0)
}

const workerSrcPath = join(root, 'workers/release-guard/src/index.ts')
const localGate = existsSync(workerSrcPath) ? extractGate(await readFile(workerSrcPath, 'utf8')) : null

const { config, error } = await fetchLive(url)
console.log('\n## 线上当前配置（已部署、对所有用户生效）')
if (error) {
  console.log(`⚠ 拉取失败：${error}`)
  console.log('  （App 端遇到拉取失败会 fail-open 放行，只靠硬过期兜底。）')
} else {
  console.log('```json')
  console.log(JSON.stringify(config, null, 2))
  console.log('```')
  console.log(`\n判定：${interpret(config)}`)
}

if (localGate && config && !error) {
  if (!gateEqual(localGate, config)) {
    console.log('\n⚠ 本地 workers/release-guard/src/index.ts 与线上不一致 —— 改了但还没部署。')
    console.log(`  本地（待部署）：${JSON.stringify(localGate)}`)
    console.log('  跑 `cd workers/release-guard && bunx wrangler deploy` 才会生效。')
  } else {
    console.log('\n✓ 本地源码与线上一致（无未部署改动）。')
  }
}

console.log('\n提示：另有「构建后 90 天」硬过期由 App 构建期烤死，与本 Worker 无关、断网也生效。')
