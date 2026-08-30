import { describe, expect, test } from 'bun:test'

import { checkOpsDocs } from './ops-check.mjs'

const RESOLVER_SOURCE = 'export function readPackageVersion() {}\nexport function resolveClientVersion() {}\n'

function compliantFiles(version = '0.3.0') {
  return {
    'AGENTS.md':
      'Read CONTEXT.md, docs/agents/progress.md, docs/agents/workflow.md, docs/agents/issue-workflow.md. Use docs/agents/verification.md.',
    'CONTEXT.md': '# Context\n',
    'docs/agents/progress.md': '# Progress\n',
    'docs/agents/workflow.md': '# Workflow\n',
    'docs/agents/verification.md': 'Run bun --no-cache run typecheck.\n',
    'docs/adr/0001-test.md': '# ADR\n\nAccepted\n',
    'scripts/client-version.mjs': RESOLVER_SOURCE,
    'package.json': JSON.stringify({
      version,
      scripts: {
        'ops:status': 'node scripts/ops-status.mjs',
        'ops:issues': 'node scripts/ops-issues.mjs',
        'ops:check': 'node scripts/ops-check.mjs',
      },
    }),
  }
}

describe('ops check', () => {
  test('passes a minimal compliant OPS document set', () => {
    const result = checkOpsDocs({ files: compliantFiles('0.3.0'), clientVersion: '0.3.0' })

    expect(result.ok).toBe(true)
    expect(result.failures).toEqual([])
  })

  test('reports common OPS drift', () => {
    const result = checkOpsDocs({
      files: {
        'AGENTS.md': 'Only this file.\n',
        'CONTEXT.md': '# Context\n',
        'docs/agents/progress.md': '# Progress  \n',
        'docs/agents/verification.md': 'Run bun run typecheck.\n',
        'docs/adr/0001-test.md': '# ADR\n\nTODO\n',
        'package.json': JSON.stringify({ scripts: { 'ops:status': 'node scripts/ops-status.mjs' } }),
      },
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toEqual([
      'AGENTS.md must reference CONTEXT.md, docs/agents/progress.md, docs/agents/workflow.md, docs/agents/issue-workflow.md, and docs/agents/verification.md.',
      'docs/agents/progress.md:1 has trailing whitespace.',
      'docs/adr/0001-test.md contains placeholder text.',
      'docs/agents/verification.md contains bare "bun run"; use "bun --no-cache run".',
      'package.json must define scripts "ops:status", "ops:issues", and "ops:check".',
      'scripts/client-version.mjs must export readPackageVersion and resolveClientVersion.',
    ])
  })

  test('requires the client version resolver to exist', () => {
    const files = compliantFiles('0.3.0')
    delete files['scripts/client-version.mjs']

    const result = checkOpsDocs({ files, clientVersion: '0.3.0' })

    expect(result.ok).toBe(false)
    expect(result.failures).toContain(
      'scripts/client-version.mjs must export readPackageVersion and resolveClientVersion.',
    )
  })

  test('package.json version 必须与解析出的客户端版本一致（ADR-0038 反转了 0006 的规则）', () => {
    // 旧规则（ADR-0006）下这里**不许**比较：版本号派生自提交数，与 manifest 无关，比了必然漂移。
    // 新规则下 package.json 就是唯一真相源，对不上说明有人绕过了 SSOT——比如直接改
    // electron-builder 的 extraMetadata，那样设置页显示的版本与包的实际版本会分家。
    const result = checkOpsDocs({ files: compliantFiles('0.3.0'), clientVersion: '0.4.1' })

    expect(result.ok).toBe(false)
    expect(result.failures).toContain(
      'package.json version (0.3.0) must equal the resolved client version (0.4.1); package.json is the single source (ADR-0038).',
    )
  })

  test('版本号不是三段 semver 时报错', () => {
    const result = checkOpsDocs({ files: compliantFiles('0.3'), clientVersion: '0.3' })

    expect(result.ok).toBe(false)
    expect(result.failures).toContain('client version must be a three-part semver, got 0.3.')
  })
})
