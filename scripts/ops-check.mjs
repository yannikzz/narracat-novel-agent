#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIENT_VERSION_RE, resolveClientVersion } from './client-version.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const requiredAgentReferences = [
  'CONTEXT.md',
  'docs/agents/progress.md',
  'docs/agents/workflow.md',
  'docs/agents/issue-workflow.md',
  'docs/agents/verification.md',
]
const placeholderPattern = /\b(TODO|TBD|FIXME)\b/i
const bareBunRunPattern = /(^|[^-])\bbun run\s+/

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

function readMarkdownDir(root, files) {
  if (!existsSync(root)) return

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = join(root, entry.name)
    if (entry.isDirectory()) {
      readMarkdownDir(absolutePath, files)
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.md')) {
      files[relative(repoRoot, absolutePath)] = readFileSync(absolutePath, 'utf8')
    }
  }
}

export function readOpsFiles(root = repoRoot) {
  const files = {}
  const directFiles = ['AGENTS.md', 'CONTEXT.md', 'package.json', 'scripts/client-version.mjs']

  for (const file of directFiles) {
    const content = readIfExists(join(root, file))
    if (typeof content === 'string') files[file] = content
  }

  for (const dir of ['docs/agents', 'docs/adr']) {
    readMarkdownDir(join(root, dir), files)
  }

  return files
}

function addTrailingWhitespaceFailures(files, failures) {
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith('.md')) continue

    const lines = content.split(/\r?\n/)
    lines.forEach((line, index) => {
      if (/[ \t]+$/.test(line)) failures.push(`${path}:${index + 1} has trailing whitespace.`)
    })
  }
}

function addPlaceholderFailures(files, failures) {
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith('.md')) continue
    if (!path.startsWith('docs/adr/') && !path.startsWith('docs/agents/')) continue
    if (placeholderPattern.test(content)) failures.push(`${path} contains placeholder text.`)
  }
}

function addBareBunRunFailures(files, failures) {
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith('.md')) continue
    if (!bareBunRunPattern.test(content)) continue
    failures.push(`${path} contains bare "bun run"; use "bun --no-cache run".`)
  }
}

function addAgentReferenceFailures(files, failures) {
  const agents = files['AGENTS.md'] ?? ''
  const hasAllReferences = requiredAgentReferences.every((reference) => agents.includes(reference))
  if (!hasAllReferences) {
    failures.push(
      'AGENTS.md must reference CONTEXT.md, docs/agents/progress.md, docs/agents/workflow.md, docs/agents/issue-workflow.md, and docs/agents/verification.md.',
    )
  }
}

function addPackageScriptFailures(files, failures) {
  try {
    const scripts = JSON.parse(files['package.json'] ?? '{}').scripts ?? {}
    if (
      typeof scripts['ops:status'] !== 'string' ||
      typeof scripts['ops:issues'] !== 'string' ||
      typeof scripts['ops:check'] !== 'string'
    ) {
      failures.push('package.json must define scripts "ops:status", "ops:issues", and "ops:check".')
    }
  } catch {
    failures.push('package.json must be valid JSON.')
  }
}

function addClientVersionFailures(files, failures, clientVersion) {
  const resolver = files['scripts/client-version.mjs']
  if (
    typeof resolver !== 'string' ||
    !resolver.includes('readPackageVersion') ||
    !resolver.includes('resolveClientVersion')
  ) {
    failures.push('scripts/client-version.mjs must export readPackageVersion and resolveClientVersion.')
  }

  if (typeof clientVersion === 'string' && !CLIENT_VERSION_RE.test(clientVersion)) {
    failures.push(`client version must be a three-part semver, got ${clientVersion}.`)
  }

  // ADR-0038：package.json.version 是版本号唯一真相源。两者不一致 = 有人绕过了 SSOT
  // （旧机制下这里恰恰**不许**比较——版本号派生自提交数，与 manifest 无关；ADR-0038 反转了这条）。
  const manifest = files['package.json']
  if (typeof manifest === 'string' && typeof clientVersion === 'string') {
    try {
      const parsed = JSON.parse(manifest)
      if (parsed?.version !== clientVersion) {
        failures.push(
          `package.json version (${parsed?.version}) must equal the resolved client version (${clientVersion}); package.json is the single source (ADR-0038).`,
        )
      }
    } catch {
      // package.json 不是合法 JSON 已由 addPackageScriptFailures 报过，这里不重复报
    }
  }
}

export function checkOpsDocs({ files, clientVersion }) {
  const failures = []

  addAgentReferenceFailures(files, failures)
  addTrailingWhitespaceFailures(files, failures)
  addPlaceholderFailures(files, failures)
  addBareBunRunFailures(files, failures)
  addPackageScriptFailures(files, failures)
  addClientVersionFailures(files, failures, clientVersion)

  return {
    ok: failures.length === 0,
    failures,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkOpsDocs({ files: readOpsFiles(), clientVersion: resolveClientVersion() })

  if (result.ok) {
    console.log('OPS check passed.')
  } else {
    console.error('OPS check failed:')
    result.failures.forEach((failure) => console.error(`- ${failure}`))
    process.exitCode = 1
  }
}
