import { describe, expect, test } from 'bun:test'

import { CLIENT_BUILD_VERSION_PREFIX } from './client-build-version.mjs'
import { checkOpsDocs } from './ops-check.mjs'

describe('ops check', () => {
  test('passes a minimal compliant OPS document set', () => {
    const result = checkOpsDocs({
      files: {
        'AGENTS.md':
          'Read CONTEXT.md, docs/agents/progress.md, docs/agents/workflow.md, docs/agents/issue-workflow.md. Use docs/agents/verification.md.',
        'CONTEXT.md': '# Context\n',
        'docs/agents/progress.md': '# Progress\n',
        'docs/agents/workflow.md': '# Workflow\n',
        'docs/agents/verification.md': 'Run bun --no-cache run typecheck.\n',
        'docs/adr/0001-test.md': '# ADR\n\nAccepted\n',
        'scripts/client-build-version.mjs':
          "export function formatClientBuildVersion() {}\nexport function resolveClientBuildVersion() {}\n",
        'package.json': JSON.stringify({
          version: '0.1.0',
          scripts: {
            'ops:status': 'node scripts/ops-status.mjs',
            'ops:issues': 'node scripts/ops-issues.mjs',
            'ops:check': 'node scripts/ops-check.mjs',
          },
        }),
      },
      clientBuildVersion: `${CLIENT_BUILD_VERSION_PREFIX}.12`,
    })

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
      'scripts/client-build-version.mjs must export formatClientBuildVersion and resolveClientBuildVersion.',
    ])
  })

  test('requires the client build version resolver instead of package version drift checks', () => {
    const result = checkOpsDocs({
      files: {
        'AGENTS.md':
          'Read CONTEXT.md, docs/agents/progress.md, docs/agents/workflow.md, docs/agents/issue-workflow.md. Use docs/agents/verification.md.',
        'CONTEXT.md': '# Context\n',
        'docs/agents/progress.md': '# Progress\n',
        'docs/agents/workflow.md': '# Workflow\n',
        'docs/agents/verification.md': 'Run bun --no-cache run typecheck.\n',
        'package.json': JSON.stringify({
          version: '0.0.1',
          scripts: {
            'ops:status': 'node scripts/ops-status.mjs',
            'ops:issues': 'node scripts/ops-issues.mjs',
            'ops:check': 'node scripts/ops-check.mjs',
          },
        }),
      },
      clientBuildVersion: `${CLIENT_BUILD_VERSION_PREFIX}.227`,
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toContain(
      'scripts/client-build-version.mjs must export formatClientBuildVersion and resolveClientBuildVersion.',
    )
    expect(result.failures).not.toContain(
      `package.json version must be ${CLIENT_BUILD_VERSION_PREFIX}.227 for the current OPS client version rule.`,
    )
  })
})
