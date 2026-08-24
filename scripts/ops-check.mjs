#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLIENT_BUILD_VERSION_PREFIX,
  CLIENT_BUILD_VERSION_RE,
  resolveClientBuildVersion,
} from './client-build-version.mjs'

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
  const directFiles = ['AGENTS.md', 'CONTEXT.md', 'package.json', 'scripts/client-build-version.mjs']

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

function addClientBuildVersionFailures(files, failures, clientBuildVersion) {
  const resolver = files['scripts/client-build-version.mjs']
  if (
    typeof resolver !== 'string' ||
    !resolver.includes('formatClientBuildVersion') ||
    !resolver.includes('resolveClientBuildVersion')
  ) {
    failures.push('scripts/client-build-version.mjs must export formatClientBuildVersion and resolveClientBuildVersion.')
  }

  if (typeof clientBuildVersion === 'string' && !CLIENT_BUILD_VERSION_RE.test(clientBuildVersion)) {
    failures.push(
      `client build version must match ${CLIENT_BUILD_VERSION_PREFIX}.<commit count>, got ${clientBuildVersion}.`,
    )
  }
}

export function checkOpsDocs({ files, clientBuildVersion }) {
  const failures = []

  addAgentReferenceFailures(files, failures)
  addTrailingWhitespaceFailures(files, failures)
  addPlaceholderFailures(files, failures)
  addBareBunRunFailures(files, failures)
  addPackageScriptFailures(files, failures)
  addClientBuildVersionFailures(files, failures, clientBuildVersion)

  return {
    ok: failures.length === 0,
    failures,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkOpsDocs({ files: readOpsFiles(), clientBuildVersion: resolveClientBuildVersion() })

  if (result.ok) {
    console.log('OPS check passed.')
  } else {
    console.error('OPS check failed:')
    result.failures.forEach((failure) => console.error(`- ${failure}`))
    process.exitCode = 1
  }
}
