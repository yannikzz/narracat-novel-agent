import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import {
  pruneMissingRecentNovelPaths,
  reconcileRecentNovelPaths,
  scanNovelProjects,
} from './novel-index'

async function makeNovelRoot(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `narracat-library-${name}-`))
}

async function makeNovelProject(parent: string, dirName: string, title: string): Promise<string> {
  const root = join(parent, dirName)
  await mkdir(join(root, '.narracat'), { recursive: true })
  await writeFile(
    join(root, '.narracat', 'config.yaml'),
    [`novel_id: ${dirName}`, `title: ${title}`, ''].join('\n'),
    'utf-8',
  )
  await writeFile(
    join(root, '.narracat', 'state.yaml'),
    [
      'progress:',
      '  completed_chapters: []',
      '  in_progress_chapter: null',
      '  total_chapters_planned: 2',
      'word_count:',
      '  total: 0',
      'structure:',
      '  total_chapters_planned: 2',
      '',
    ].join('\n'),
    'utf-8',
  )
  return root
}

async function makeMalformedNovelProject(parent: string, dirName: string): Promise<string> {
  const root = join(parent, dirName)
  await mkdir(join(root, '.narracat'), { recursive: true })
  await writeFile(
    join(root, '.narracat', 'config.yaml'),
    [`novel_id: ${dirName}`, `title: 损坏项目`, ''].join('\n'),
    'utf-8',
  )
  await writeFile(join(root, '.narracat', 'state.yaml'), 'progress: [\n', 'utf-8')
  return root
}

describe('novel index scanning', () => {
  test('prunes only missing recent paths after disaster recovery and preserves order', async () => {
    const existing = new Set(['/novels/restored', '/novels/other'])
    await expect(
      pruneMissingRecentNovelPaths(
        ['/novels/restored', '/novels/missing', '/novels/other', '/novels/restored'],
        async (path) => existing.has(path),
      ),
    ).resolves.toEqual(['/novels/restored', '/novels/other'])
  })

  test('promotes a moved project path and removes its previous recent entry', () => {
    expect(
      reconcileRecentNovelPaths(
        ['/novels/old-stars', '/novels/moon', '/novels/new-stars'],
        '/novels/old-stars',
        '/novels/new-stars',
      ),
    ).toEqual(['/novels/new-stars', '/novels/moon'])
  })

  test('scans direct child NarraCat projects under root and excludes plain folders', async () => {
    const root = await makeNovelRoot('children')
    const project = await makeNovelProject(root, 'valid-project', '有效项目')
    await mkdir(join(root, 'plain-folder'), { recursive: true })

    const summaries = await scanNovelProjects({ novelRootDir: root, recentNovelPaths: [] })

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: 'valid-project',
      title: '有效项目',
      path: project,
      status: 'ready',
    })
  })

  test('deduplicates recent paths and root children by project path', async () => {
    const root = await makeNovelRoot('dedupe')
    const project = await makeNovelProject(root, 'same-project', '同一个项目')
    const equivalentRecentPath = `${project}/.`

    const summaries = await scanNovelProjects({
      novelRootDir: root,
      recentNovelPaths: ['', equivalentRecentPath, equivalentRecentPath],
    })

    expect(summaries.map((summary) => summary.path)).toEqual([equivalentRecentPath])
  })

  test('uses title and path tie-breakers when updatedAt values are missing', async () => {
    const root = await makeNovelRoot('tie-breakers')
    const zeta = join(root, 'zeta')
    const alpha = join(root, 'alpha')

    const summaries = await scanNovelProjects({
      novelRootDir: root,
      recentNovelPaths: [zeta, alpha],
    })

    expect(summaries.map((summary) => summary.path)).toEqual([alpha, zeta])
  })

  test('a recent path whose directory is gone is reported as missing, with no identity (ADR-0046)', async () => {
    const root = await makeNovelRoot('missing-recent')
    const missing = join(root, 'missing')

    const summaries = await scanNovelProjects({
      novelRootDir: root,
      recentNovelPaths: [missing],
    })

    // 目录整个没了 ≠ 文件不完整：状态是 missing，文案说「文件夹不存在」；id 恒空串——路径永远不当身份。
    expect(summaries).toEqual([
      {
        id: '',
        title: 'missing',
        genre: '未分类',
        coverPreset: expect.stringMatching(/^cover-\d{2}$/),
        path: missing,
        status: 'missing',
        chapterProgress: '0 / 0 章',
        wordCountLabel: '0 字',
        problem: '项目文件夹不存在，可能已被移动、删除，或所在磁盘未连接',
      },
    ])
  })

  test('a recent path whose directory exists but lacks the contract files is invalid, not missing', async () => {
    const root = await makeNovelRoot('invalid-recent')
    const invalid = join(root, 'half-created')
    await mkdir(invalid, { recursive: true })

    const summaries = await scanNovelProjects({
      novelRootDir: root,
      recentNovelPaths: [invalid],
    })

    expect(summaries).toEqual([
      expect.objectContaining({
        id: '',
        path: invalid,
        status: 'invalid',
        problem: '缺少 .narracat/config.yaml 或 .narracat/state.yaml',
      }),
    ])
  })

  test('keeps valid projects visible when a sibling project has malformed yaml', async () => {
    const root = await makeNovelRoot('malformed-yaml')
    const valid = await makeNovelProject(root, 'valid-project', '有效项目')
    const malformed = await makeMalformedNovelProject(root, 'broken-project')

    const summaries = await scanNovelProjects({ novelRootDir: root, recentNovelPaths: [] })

    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({
      path: valid,
      status: 'ready',
    })
    expect(summaries[1]).toMatchObject({
      id: '',
      title: 'broken-project',
      path: malformed,
      status: 'invalid',
    })
    expect(summaries[1]?.problem).toContain('state.yaml')
  })
})
