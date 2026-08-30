import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, test } from 'bun:test'

// 发版 skill 的预检脚本（.claude/skills/release-app/scripts/preflight.mjs）刻意不重新实现任何
// 判据——版本号规则、产物命名、凭证清单全部从本目录的真实契约 import，这样 ADR-0038 那类规则
// 变化时它自动跟上。代价是它对这些模块的导出面有依赖，而**它平时不跑**：谁改了导出名，
// 要到下一次发版当天才撞见，那正是人最急、最不想调试脚本的时候。
//
// 这一组就是那道守卫。它不重复各模块自己的行为测试，只钉「预检脚本引用的符号还在不在」——
// 而且是从脚本源码里解析出 import 清单再逐个核对，所以将来给预检加新 import 也自动纳入覆盖，
// 不需要有人记得回来补断言。

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(scriptsDir)
const preflightPath = join(repoRoot, '.claude/skills/release-app/scripts/preflight.mjs')

/**
 * 从预检脚本源码里解析出 `const { A, B } = await import(...'scripts/x.mjs'...)` 形态的依赖。
 * 返回 [{ moduleFile, symbols }]。
 */
function parseContractImports(source) {
  const pattern = /const\s*\{([^}]+)\}\s*=\s*await import\(\s*pathToFileURL\(join\(repoRoot,\s*'scripts',\s*'([^']+)'\)\)\.href\s*\)/g
  const found = []
  for (const match of source.matchAll(pattern)) {
    const symbols = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    found.push({ moduleFile: match[2], symbols })
  }
  return found
}

describe('发版预检脚本与真实契约同源', () => {
  const source = readFileSync(preflightPath, 'utf8')
  const contractImports = parseContractImports(source)

  test('解析出了依赖清单（解析器本身失效就等于守卫静默失守）', () => {
    // 空数组会让下面的 for 循环一条断言都不跑、测试却全绿——守卫必须先证明自己在工作。
    expect(contractImports.length).toBeGreaterThan(0)
    expect(contractImports.map((i) => i.moduleFile).sort()).toContain('client-version.mjs')
  })

  for (const { moduleFile, symbols } of contractImports) {
    test(`${moduleFile} 仍导出预检用到的 ${symbols.length} 个符号`, async () => {
      const mod = await import(pathToFileURL(join(scriptsDir, moduleFile)).href)

      for (const symbol of symbols) {
        expect(`${moduleFile}:${symbol}`).toBe(
          symbol in mod ? `${moduleFile}:${symbol}` : `${moduleFile}: 缺少导出 ${symbol}`,
        )
        expect(mod[symbol]).toBeDefined()
      }
    })
  }

  test('预检只读——不含任何写入、发布或部署动作', () => {
    // 预检的全部价值在于「跑它没有任何代价」。一旦它开始改东西，人就会犹豫要不要跑，
    // 而一个让人犹豫的检查等于没有检查。
    for (const forbidden of ['writeFile', 'release create', 'release upload', 'wrangler deploy']) {
      expect(source).not.toContain(forbidden)
    }
    // git 只允许读状态与 fetch，不许改本地历史或推送
    for (const forbidden of ['git push', "'push'", "'commit'", "'reset'", "'checkout'"]) {
      expect(source).not.toContain(forbidden)
    }
  })

  test('不打印凭证值——只报有无', () => {
    // 凭证名可以出现（要报缺了哪个），值绝不能进 stdout：发版时人常把输出贴给别人看。
    expect(source).toContain('绝不打印值')
    expect(source).not.toMatch(/process\.env\[[^\]]+\]\s*\)?\s*\}?\s*`/)
    // 缺失项走的是 key 名拼接，不是值
    expect(source).toContain('missingNotarize.join')
    expect(source).toContain('missingCorpus.join')
  })
})
