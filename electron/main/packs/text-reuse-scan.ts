/**
 * 防抄袭确定性扫描（刀4）。算法规格照 agent-core/narracat/commands/reference.md 步骤 4.5：
 * 句子按「。！？；.!?」分割、仅 ≥10 字句子 SHA256 入集合；窗口 10 字滑窗。
 *
 * 窗口层（PR#477 P1-2 修复）：指纹文件不得存可还原原文的内容——滑窗子串本身就是原文，
 * 不能像 sentenceHashes 那样直接落一份子串/哈希列表（哈希碰撞空间小，10 字中文子串
 * 实践上可逆推）。改用 Bloom filter（位集）：只记"是否可能出现过"，无假阴性（原文窗口
 * 保证命中，红线成立）、有可控假阳性（误拦让用户改写，方向 fail-closed，不放行）。
 * 发布重扫因此不再需要在场的完整 windowIndex 也能挡住非整句 ≥10 字片段。
 * 输入约定：text 必须先过 extractNonEvidenceText（摘录区内允许原文）。
 */
import { createHash } from 'node:crypto'

const SENTENCE_SPLIT_RE = /[。！？；.!?]/
const MIN_LEN = 10
const WINDOW = 10
/** 目标假阳率：~22 bits/元素、k≈16（经典 Bloom filter 最优参数公式 m/n=-ln(p)/(ln2)^2, k=(m/n)ln2）。 */
const BLOOM_TARGET_FP = 2e-5

export interface WindowBloom {
  version: 1
  /** 位集，base64 编码；不可从中还原任何原文子串。 */
  bits: string
  /** 每个元素的哈希探针数。 */
  k: number
  /** 位集总位数。 */
  mBits: number
  /** 构建时纳入的窗口元素数（诊断用，不影响判定）。 */
  count: number
}

export interface SourceFingerprint {
  version: 2
  sourceKind: 'novel' | 'file' | 'txt'
  sourceTitle: string
  builtAt: string
  sentenceHashes: string[]
  properNouns: string[]
  windowBloom: WindowBloom
}

export interface TextReuseFinding {
  kind: 'sentence' | 'window' | 'proper-noun'
  sample: string
}

export function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** sha256 双基础哈希，各取 32bit：h1+i*h2 组合出 k 个探针位（经典 Bloom filter 双哈希技法）。
 * h2 强制非零，否则 i*h2 恒为 0，k 个探针会退化成同一个位（丧失区分度）。
 * 实测过 FNV-1a 变种替代：500k 次调用够快，但对 10 字 CJK 窗口这类短输入扩散不足——
 * 相邻探针位相关性偏高，实测假阳率比 sha256 高出一个数量级以上，不满足 fail-closed 的假阳率
 * 上界要求。sha256 本身 500k 次调用只需约 0.2s（Buffer 分配开销远小于早前误判的量级），
 * 真正的性能瓶颈在解码位集环节，已用 decodeBloomBits 的 WeakMap 缓存 + 避免
 * `Uint8Array.from()` 逐元素装箱拷贝解决（见下方）。 */
function hashPair(s: string): [number, number] {
  const digest = createHash('sha256').update(s).digest()
  const h1 = digest.readUInt32BE(0)
  const h2 = digest.readUInt32BE(4) || 1
  return [h1, h2]
}

function setBit(bytes: Uint8Array, index: number): void {
  bytes[index >>> 3] |= 1 << (index & 7)
}

function getBit(bytes: Uint8Array, index: number): boolean {
  return (bytes[index >>> 3] & (1 << (index & 7))) !== 0
}

/** m（位数）/k（探针数）最优参数：m/n = -ln(p)/(ln2)^2，k = (m/n)·ln2。n=0 时兜底成 1 避免除零。 */
function computeBloomParams(n: number): { mBits: number; k: number } {
  const count = Math.max(n, 1)
  const mBits = Math.max(Math.ceil((-count * Math.log(BLOOM_TARGET_FP)) / (Math.LN2 * Math.LN2)), 8)
  const k = Math.max(1, Math.round((mBits / count) * Math.LN2))
  return { mBits, k }
}

function bloomHasBits(bytes: Uint8Array, k: number, mBits: number, window: string): boolean {
  const [h1, h2] = hashPair(window)
  for (let i = 0; i < k; i++) {
    if (!getBit(bytes, (h1 + i * h2) % mBits)) return false
  }
  return true
}

/** 全文所有 10 字滑窗构建 Bloom filter。O(n) 流式：逐窗口即时折入位集，不 materialize 窗口列表
 * （几百万字全本书也只留一份位集在内存，不是几十 MB 的子串 Set——P2-6 修复的另一半）。 */
export function buildWindowBloom(fullText: string): WindowBloom {
  const compact = fullText.replace(/\s/g, '')
  const count = Math.max(compact.length - WINDOW + 1, 0)
  const { mBits, k } = computeBloomParams(count)
  const bytes = new Uint8Array(Math.ceil(mBits / 8))
  for (let i = 0; i < count; i++) {
    const win = compact.slice(i, i + WINDOW)
    const [h1, h2] = hashPair(win)
    for (let j = 0; j < k; j++) setBit(bytes, (h1 + j * h2) % mBits)
  }
  return { version: 1, bits: Buffer.from(bytes).toString('base64'), k, mBits, count }
}

// 解码结果按 WindowBloom 对象引用缓存：重复查询同一份指纹（如 pack-learn.ts 的重写重试循环，
// 同一 fingerprint 在一次学习会话内被 scanTextReuse 反复调用）不用每次都重新 base64 解码。
// 用 `Buffer.from(...)` 本身即可当 Uint8Array 用——绝不能再包一层 `Uint8Array.from(buffer)`：
// 那是逐元素装箱拷贝（走 iterable 协议每个字节单独取一次），对几十 KB 的位集会比直接内存拷贝慢
// 一到两个数量级（实测：14KB 位集下 50 万次调用差出 500ms vs 53s）。
const decodedBitsCache = new WeakMap<WindowBloom, Uint8Array>()
function decodeBloomBits(bloom: WindowBloom): Uint8Array {
  let bytes = decodedBitsCache.get(bloom)
  if (!bytes) {
    bytes = Buffer.from(bloom.bits, 'base64')
    decodedBitsCache.set(bloom, bytes)
  }
  return bytes
}

export function windowBloomHas(bloom: WindowBloom, window: string): boolean {
  return bloomHasBits(decodeBloomBits(bloom), bloom.k, bloom.mBits, window)
}

export function buildSourceFingerprint(input: {
  fullText: string
  properNouns: string[]
  sourceKind: 'novel' | 'file' | 'txt'
  sourceTitle: string
  now: () => string
}): SourceFingerprint {
  const hashes = new Set<string>()
  for (const sentence of splitSentences(input.fullText)) {
    if (sentence.length >= MIN_LEN) hashes.add(sha256(sentence))
  }
  return {
    version: 2,
    sourceKind: input.sourceKind,
    sourceTitle: input.sourceTitle,
    builtAt: input.now(),
    sentenceHashes: [...hashes],
    properNouns: input.properNouns.map((n) => n.trim()).filter((n) => n.length >= 2),
    windowBloom: buildWindowBloom(input.fullText),
  }
}

/** 精确窗口 Set：只供调用方对「模型实际看过的文本」（抽样文本）建索引——学习期抄袭只可能
 * 来自抽样输入，全书层的防抄袭覆盖交给 fingerprint.windowBloom（位集，O(1) 量级常驻内存，
 * 见 P2-6）。勿用全书文本调用本函数：几十万到百万字级窗口子串 Set 会撑爆主进程内存。 */
export function buildWindowIndex(sourceText: string): Set<string> {
  const compact = sourceText.replace(/\s/g, '')
  const index = new Set<string>()
  for (let i = 0; i + WINDOW <= compact.length; i++) index.add(compact.slice(i, i + WINDOW))
  return index
}

export function scanTextReuse(
  text: string,
  opts: { fingerprint: SourceFingerprint; windowIndex?: Set<string> },
): TextReuseFinding[] {
  const findings: TextReuseFinding[] = []
  const hashSet = new Set(opts.fingerprint.sentenceHashes)
  for (const sentence of splitSentences(text)) {
    if (sentence.length >= MIN_LEN && hashSet.has(sha256(sentence))) {
      findings.push({ kind: 'sentence', sample: sentence.slice(0, 30) })
    }
  }
  for (const noun of opts.fingerprint.properNouns) {
    if (text.includes(noun)) findings.push({ kind: 'proper-noun', sample: noun })
  }
  const bloom = opts.fingerprint.windowBloom
  if (opts.windowIndex || bloom) {
    const bloomBytes = bloom ? decodeBloomBits(bloom) : null
    const compact = text.replace(/\s/g, '')
    for (let i = 0; i + WINDOW <= compact.length; i++) {
      const win = compact.slice(i, i + WINDOW)
      const hitExact = opts.windowIndex?.has(win) ?? false
      const hitBloom = bloomBytes && bloom ? bloomHasBits(bloomBytes, bloom.k, bloom.mBits, win) : false
      if (hitExact || hitBloom) {
        findings.push({ kind: 'window', sample: win })
        i += WINDOW - 1 // 命中后跳过一个窗口宽度：紧邻 10 字内起始的第二处独立命中会被跳过（可接受——目的是防同一片段重叠刷屏，不是精确计数）
      }
    }
  }
  return findings
}
