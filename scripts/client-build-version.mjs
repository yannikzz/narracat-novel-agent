#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')

export const CLIENT_BUILD_VERSION_PREFIX = '0.1'

export function formatClientBuildVersion(commitCount) {
  const count = Number(commitCount)
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Invalid git commit count for client build version: ${commitCount}`)
  }

  return `${CLIENT_BUILD_VERSION_PREFIX}.${count}`
}

export function readGitCommitCount(root = repoRoot, { execFile = execFileSync } = {}) {
  const args = ['rev-list', '--count', 'HEAD']
  let value

  try {
    value = execFile('git', args, { cwd: root, encoding: 'utf8' })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    value = execFile('/usr/bin/git', args, { cwd: root, encoding: 'utf8' })
  }

  value = String(value).trim()
  return Number(value)
}

export function resolveClientBuildVersion({ root = repoRoot, readCommitCount = readGitCommitCount } = {}) {
  return formatClientBuildVersion(readCommitCount(root))
}

export const CLIENT_VERSION_OVERRIDE_ENV = 'NARRACAT_CLIENT_VERSION'

/**
 * 带覆盖的客户端版本解析（SSOT——打包链上所有取版本号的地方都必须经这里）。
 *
 * 为什么需要覆盖：版本号 = `git rev-list --count HEAD`，squash 合并会让计数回落，
 * 于是本地测试包版本号可能低于线上正式版；而 electron-updater 配的是
 * autoDownload + autoInstallOnAppQuit，会静默把测试包换成线上版本，真机验收因此
 * 测到老引擎且日志里毫无痕迹（真实踩过，#48 验收第二轮整份日志作废）。
 *
 * 为什么必须是 SSOT：版本号在打包链上有**两条**独立取值路径——
 *   ① electron-builder `--config.extraMetadata.version` → Info.plist / asar package.json
 *      （app.getVersion()，自动更新比较用的就是它）
 *   ② electron.vite.config.ts 构建期 define `__NARRACAT_CLIENT_VERSION__`
 *      （经本文件的 CLI 入口取值）→ 设置页「关于」展示用的就是它
 * 只覆盖 ① 的话，包不会被自动更新换掉，但设置页显示的仍是 git 计数——两个数字对不上，
 * 用户没法确认自己在跑哪个版本（真实踩过：装了 0.1.9999 的包，设置页显示 0.1.64）。
 *
 * 边界：`resolveClientBuildVersion`（无覆盖）留给 release.mjs 正式发布与 ops-check，
 * 免得环境变量残留把正式版本号打歪。
 */
export function resolveOverridableClientVersion({
  root = repoRoot,
  env = process.env,
  readCommitCount = readGitCommitCount,
} = {}) {
  const override = String(env[CLIENT_VERSION_OVERRIDE_ENV] ?? '').trim()
  if (!override) return resolveClientBuildVersion({ root, readCommitCount })
  if (!/^\d+\.\d+\.\d+$/.test(override)) {
    throw new Error(
      `${CLIENT_VERSION_OVERRIDE_ENV} 必须是 x.y.z 三段数字版本号，实际收到：${override}`,
    )
  }
  return override
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // CLI 入口唯一的调用方是 electron.vite.config.ts（构建期 define 取值），故走带覆盖的那支；
  // release.mjs / ops-check.mjs 用的是 import 的 resolveClientBuildVersion，不受影响。
  process.stdout.write(`${resolveOverridableClientVersion({ root: process.cwd() })}\n`)
}
