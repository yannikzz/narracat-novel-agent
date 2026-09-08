import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { deleteNovelProject } from './novel-delete'

async function makeRoot(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `narracat-delete-${name}-`))
}

async function makeNarraCatProject(parent: string, dirName: string): Promise<string> {
  const root = join(parent, dirName)
  await mkdir(join(root, '.narracat'), { recursive: true })
  await writeFile(join(root, '.narracat', 'config.yaml'), 'novel_id: novel-1\ntitle: 星辰大海\n', 'utf-8')
  await writeFile(join(root, '.narracat', 'state.yaml'), 'progress:\n  completed_chapters: []\n', 'utf-8')
  return root
}

describe('deleteNovelProject', () => {
  test('moves a NarraCat project to trash and removes equivalent recent paths', async () => {
    const root = await makeRoot('valid')
    const projectPath = await makeNarraCatProject(root, 'stars')
    const trashedPaths: string[] = []

    const result = await deleteNovelProject({
      projectPath,
      recentNovelPaths: [projectPath, `${projectPath}/.`, join(root, 'other')],
      trashItem: async (path) => {
        trashedPaths.push(path)
      },
    })

    expect(trashedPaths).toEqual([projectPath])
    expect(result).toEqual({
      projectPath,
      recentNovelPaths: [join(root, 'other')],
      trashed: true,
    })
  })

  test('forget mode never trashes, even when the directory is a complete NarraCat project at click time (ADR-0046)', async () => {
    // 书架对 Missing / Invalid 的「从书架移除」承诺「不会动任何文件」。点击那一刻目录可能刚好又回来了
    //（外置盘重新连上、yaml 只是坏了但两个文件都在），按缺省 trash 判会把整本书扔进废纸篓。
    const root = await makeRoot('forget')
    const projectPath = await makeNarraCatProject(root, 'came-back')
    const trashedPaths: string[] = []

    const result = await deleteNovelProject({
      projectPath,
      recentNovelPaths: [projectPath, join(root, 'other')],
      trashItem: async (path) => {
        trashedPaths.push(path)
      },
      mode: 'forget',
    })

    expect(trashedPaths).toEqual([])
    expect(result).toEqual({
      projectPath,
      recentNovelPaths: [join(root, 'other')],
      trashed: false,
    })
  })

  test('only removes a dead or non-NarraCat recent path without trashing arbitrary folders', async () => {
    const root = await makeRoot('invalid')
    const plainFolder = join(root, 'plain-folder')
    await mkdir(plainFolder, { recursive: true })
    const trashedPaths: string[] = []

    const result = await deleteNovelProject({
      projectPath: plainFolder,
      recentNovelPaths: [plainFolder, join(root, 'other')],
      trashItem: async (path) => {
        trashedPaths.push(path)
      },
    })

    expect(trashedPaths).toEqual([])
    expect(result).toEqual({
      projectPath: plainFolder,
      recentNovelPaths: [join(root, 'other')],
      trashed: false,
    })
  })
})
