import { describe, expect, test } from 'bun:test'
import {
  BRAND_ASSET_ALLOWLIST,
  allowlistCoverageFailure,
  collectBrandAssetViolations,
  collectOffScaleFontSizeViolations,
  isProductionSource,
  normalizeLineEndings,
  toPosixPath,
} from './check-design-system.mjs'

// Windows 检出形态：反斜杠路径 + CRLF 行尾。mac 上永远看不见，只能靠喂输入拦（#24）。
const windowsPath = (posixPath) => posixPath.replaceAll('/', '\\')

describe('toPosixPath（路径归一化）', () => {
  test('反斜杠归一化为正斜杠，POSIX 路径原样通过', () => {
    expect(toPosixPath('src\\components\\brand\\BrandMark.tsx')).toBe(
      'src/components/brand/BrandMark.tsx',
    )
    expect(toPosixPath('src/components/brand/BrandMark.tsx')).toBe(
      'src/components/brand/BrandMark.tsx',
    )
  })
})

describe('normalizeLineEndings（行尾归一化）', () => {
  test('CRLF 归一化后，跨行子串契约才匹配得上', () => {
    const crlf = 'Record<BrandIllustrationPurpose,\r\n  BrandIllustrationAsset>'
    expect(crlf.includes('Purpose,\n  Brand')).toBe(false)
    expect(normalizeLineEndings(crlf).includes('Purpose,\n  Brand')).toBe(true)
  })
})

describe('collectBrandAssetViolations（品牌资产收口）', () => {
  const rawImport = "import mark from '../../assets/brand/narracat-mark.webp'"

  test('白名单里的合规包装器豁免——反斜杠路径同样豁免（#24 回归）', () => {
    const files = BRAND_ASSET_ALLOWLIST.map((path) => ({
      path: windowsPath(path),
      content: rawImport,
    }))
    expect(collectBrandAssetViolations({ files })).toEqual([])
  })

  test('白名单外的文件直接引用原始资产判违规，路径以 POSIX 形态报出', () => {
    const violations = collectBrandAssetViolations({
      files: [
        { path: windowsPath('src/routes/library.tsx'), content: rawImport },
        {
          path: 'src/components/workbench/Panel.tsx',
          content: "import art from '@/assets/illustrations/narracat/empty.webp'",
        },
        { path: 'src/components/ui/button.tsx', content: 'export const Button = () => null' },
      ],
    })
    expect(violations).toEqual(['src/routes/library.tsx', 'src/components/workbench/Panel.tsx'])
  })

  test('全部违规都报出来，不止第一条', () => {
    const files = ['src/a.tsx', 'src/b.tsx', 'src/c.tsx'].map((path) => ({ path, content: rawImport }))
    expect(collectBrandAssetViolations({ files })).toHaveLength(3)
  })
})

describe('allowlistCoverageFailure（白名单覆盖自检）', () => {
  test('白名单条目齐全时放行', () => {
    expect(allowlistCoverageFailure([...BRAND_ASSET_ALLOWLIST, 'src/routes/library.tsx'])).toBeNull()
  })

  test('扫描结果是反斜杠形态时自检自身也归一化，不假报', () => {
    expect(allowlistCoverageFailure(BRAND_ASSET_ALLOWLIST.map(windowsPath))).toBeNull()
  })

  test('白名单条目搬迁/改名后 fail loud，并列出落空条目', () => {
    const failure = allowlistCoverageFailure(['src/components/brand/BrandMark.tsx'])
    expect(failure).toContain('src/components/brand/BrandStoryBanner.tsx')
    expect(failure).toContain('src/components/brand/brand-illustrations.ts')
    expect(failure).toContain('白名单已形同虚设')
  })

  test('扫描范围塌成空时同样 fail loud，不许静默放行', () => {
    expect(allowlistCoverageFailure([])).not.toBeNull()
  })
})

describe('isProductionSource（测试文件豁免）', () => {
  test('.test.ts / .test.tsx 不算生产源码——反斜杠路径同样识别', () => {
    expect(isProductionSource('src/lib/a.test.ts')).toBe(false)
    expect(isProductionSource('src/components/B.test.tsx')).toBe(false)
    expect(isProductionSource(windowsPath('src/components/B.test.tsx'))).toBe(false)
  })

  test('生产文件算生产源码（含名字里带 test 但不是测试文件的）', () => {
    expect(isProductionSource('src/components/ui/button.tsx')).toBe(true)
    expect(isProductionSource('src/lib/test-utils.ts')).toBe(true)
  })
})

describe('collectOffScaleFontSizeViolations（字号刻度）', () => {
  test('生产文件里的 text-[13px] / text-[17px] 判违规', () => {
    const violations = collectOffScaleFontSizeViolations({
      files: [
        { path: 'src/components/A.tsx', content: 'className="text-[13px]"' },
        { path: 'src/components/B.tsx', content: 'className="text-[17px]"' },
        { path: 'src/components/C.tsx', content: 'className="text-[15px]"' },
      ],
    })
    expect(violations.map((v) => v.file)).toEqual(['src/components/A.tsx', 'src/components/B.tsx'])
  })

  test('测试文件里的负向断言不误伤——守卫只扫生产代码', () => {
    const violations = collectOffScaleFontSizeViolations({
      files: [
        { path: 'src/components/A.test.tsx', content: "expect(cls).not.toContain('text-[13px]')" },
      ],
    })
    expect(violations).toEqual([])
  })
})
