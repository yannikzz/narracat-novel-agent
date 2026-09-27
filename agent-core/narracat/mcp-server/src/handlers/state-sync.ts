/**
 * state.yaml 机械写入工具（4 个）
 *
 * state.yaml 对 LLM 零 Edit——全部经以下工具整体安全序列化写入：
 * - novel_sync_structure  : structure 节唯一写入通道（交叉互证，任一不过整体拒写）
 * - novel_update_progress : 章节收尾后更新 progress / word_count 并清 checkpoint（审校新鲜度强门）
 * - novel_restore_progress: 作者手改正文的记忆同步链路专用，同一段进度写逻辑但不设新鲜度门
 * - novel_checkpoint      : 机械写 checkpoint 节
 *
 * 写入一律 read-modify-write：解析整份 state.yaml，只改目标节，其余节原样保留。
 *
 * 与 writers.ts 的边界：writers 写 memory.db 与渲染产物，本模块写小说项目状态文件，
 * 不触碰数据库。writers 的 novel_submit_outline 通过本模块的 writeStructureToState
 * 复用同一套结构写入逻辑。
 */

import { readFile, writeFile, readdir, access, mkdir, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseDocument, Document } from "yaml";
import type { ToolContext, ToolErrorItem } from "../types.js";
import { errorResponse, singleError } from "../types.js";
import { getChapterWordCountRange } from "./readers.js";

// ============================================================
// 共用辅助
// ============================================================

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * 正文字数口径（纯文字）：只数文字（汉字 / 字母 / 数字），剔除空白、标点、符号。
 * 用户设的「每章字数」按纯文字计，state.yaml / chapter_summaries 的权威字数与之同口径。
 * 必须与 App 侧 `src/lib/word-count.ts` 的 countBodyChars 保持一致（两处独立 build，改一处须同步）。
 */
export function countWords(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length;
}

/**
 * chapter_metadata 注释（App 编辑器写入并保留的元数据块）。
 * 必须与 App 侧 `electron/main/novel/manuscript-edit.ts` 的正则保持一致（两处独立 build）。
 */
const CHAPTER_METADATA_COMMENT_RE = /<!--\s*chapter_metadata\s*:[\s\S]*?-->/gi;

/** 剥离 chapter_metadata 注释后的可见正文：字数与片段一律按它计，元数据文本不算正文 */
export function visibleBodyText(content: string): string {
  return content.replace(CHAPTER_METADATA_COMMENT_RE, "").trimEnd();
}

const SNIPPET_LENGTH_DEFAULT = 200;

export interface ManuscriptSnippets {
  opening: string;
  ending: string;
}

/**
 * 正文首尾片段机械提取（收敛于此处的唯一实现，供 writers.ts 收尾入库快照 / readers.ts 组装期
 * 现读共用，避免各自实现漂移）：
 * 1. 剥离 chapter_metadata 注释（App 编辑器写入，固定拼在文件末尾——若漏剥，「取结尾片段」
 *    正好会截进这段元数据 JSON，比不加长片段还糟，是本函数收拢的直接起因）；
 * 2. 跳过开头最多 3 行的标题行（`# ` 或裸标题）；
 * 3. 压平连续空行后按字符数截取首尾。
 * 调用方传入正文文件的原始内容（未剥元数据的 raw string），长度未传时各自默认 200 字。
 */
export function extractManuscriptSnippets(
  rawContent: string,
  options: { openingChars?: number; endingChars?: number } = {},
): ManuscriptSnippets {
  const body = visibleBodyText(rawContent)
    .split("\n")
    .filter((line, idx) => !(idx < 3 && /^#/.test(line.trim())))
    .join("\n")
    .trim();
  const flat = body.replace(/\n{2,}/g, "\n");
  const openingChars = options.openingChars ?? SNIPPET_LENGTH_DEFAULT;
  const endingChars = options.endingChars ?? SNIPPET_LENGTH_DEFAULT;
  return {
    opening: flat.slice(0, openingChars),
    ending: flat.slice(Math.max(0, flat.length - endingChars)),
  };
}

/** 章号 → 三位文件段（如 5 → "005"） */
export function chapterFileSegment(chapter: number): string {
  return String(chapter).padStart(3, "0");
}

/** 卷号 → 两位目录段（如 1 → "vol-01"） */
export function volumeDirSegment(volume: number): string {
  return `vol-${String(volume).padStart(2, "0")}`;
}

export interface ManuscriptEntry {
  chapter: number;
  volume: number;
  path: string;
}

/** 扫描 manuscript/vol-VV/ch-NNN.md，返回全部章节文件 */
export async function scanManuscripts(projectRoot: string): Promise<ManuscriptEntry[]> {
  const root = join(projectRoot, "manuscript");
  let volDirs: string[];
  try {
    volDirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^vol-\d{2,}$/.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }

  const entries: ManuscriptEntry[] = [];
  for (const volDir of volDirs) {
    const volume = parseInt(volDir.replace("vol-", ""), 10);
    let files: string[];
    try {
      files = await readdir(join(root, volDir));
    } catch {
      continue;
    }
    for (const file of files) {
      const m = file.match(/^ch-(\d{3,})\.md$/);
      if (!m) continue;
      entries.push({
        chapter: parseInt(m[1], 10),
        volume,
        path: join(root, volDir, file),
      });
    }
  }
  return entries.sort((a, b) => a.chapter - b.chapter);
}

/** 定位指定章的 manuscript 文件 */
export async function findManuscript(
  projectRoot: string,
  chapter: number,
): Promise<ManuscriptEntry | null> {
  const entries = await scanManuscripts(projectRoot);
  return entries.find((e) => e.chapter === chapter) ?? null;
}

/** 本章待验收正文（staging）绝对路径 */
export function stagingManuscriptPath(projectRoot: string, chapter: number): string {
  return join(projectRoot, ".narracat", "staging", `ch-${chapterFileSegment(chapter)}.md`);
}

export interface WorkingManuscript {
  path: string;
  source: "staging" | "manuscript";
}

/**
 * 工作正文解析：staging 存在 → staging（未验收草稿优先）；否则正式路径。
 * 用于「正在写的这一章」（指纹门 / 洁净扫描 / 本章入库读取）。
 * 定稿类消费（前章结尾摘录、样章取样、全书字数）不得用本函数——那边只认 manuscript/。
 */
export async function resolveWorkingManuscript(
  projectRoot: string,
  chapter: number,
): Promise<WorkingManuscript | null> {
  const staging = stagingManuscriptPath(projectRoot, chapter);
  try {
    await access(staging);
    return { path: staging, source: "staging" };
  } catch {
    // 无 staging → 正式路径
  }
  const entry = await findManuscript(projectRoot, chapter);
  return entry ? { path: entry.path, source: "manuscript" } : null;
}

// ============================================================
// 正文机械合同（novel_check_manuscript_contract）
// ============================================================

const CONTRACT_PREAMBLE_RE = /^(好的|以下是|这是第|下面是)/;
const CONTRACT_TITLE_RE = /^#\s*第\s*(\d+)\s*章/;
const CONTRACT_TERMINAL_RE = /[。！？…”』」》—]$/;
const CONTRACT_ASCII_QUOTE_CN_RE = /"[^"\n]*[一-鿿][^"\n]*"/;

/**
 * 正文机械合同：仅当该章存在 staging 时生效（写作链产出必须过合同；
 * 无 staging = 作者手改 / 存量老书链路，一律免检返回 null）。
 * 硬项进 errors（拒绝提交），软项进 warnings（只提醒）。
 */
export async function checkManuscriptContract(
  ctx: ToolContext,
  chapter: number,
): Promise<{ errors: ToolErrorItem[]; warnings: string[] } | null> {
  let raw: string;
  try {
    raw = await readFile(stagingManuscriptPath(ctx.projectRoot, chapter), "utf-8");
  } catch {
    return null;
  }
  const errors: ToolErrorItem[] = [];
  const warnings: string[] = [];
  const body = visibleBodyText(raw);
  const wordCount = countWords(body);
  const [floor, ceiling] = getChapterWordCountRange(ctx.wordsPerChapter);
  const lines = raw.split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const firstNonEmpty = lines.map((l) => l.trim()).find((l) => l.length > 0) ?? "";

  if (wordCount === 0) {
    errors.push({ field: "manuscript_contract", expected: "可见正文非空", actual: "0 字", hint: "正文文件为空或只有注释，先完成正文写作" });
  } else {
    if (wordCount < floor) {
      errors.push({ field: "manuscript_contract", expected: `可见正文 ≥ ${floor} 字（目标字数下限）`, actual: `${wordCount} 字`, hint: "字数不足是交付缺料：把戏加足（多一个有信息的回合、把对峙与爽点演透），不靠抒情灌水撑长度" });
    }
    if (wordCount > ceiling) warnings.push(`正文 ${wordCount} 字，超出目标上限 ${ceiling}（写长不伤阅读，仅提醒）`);
  }
  if (lines.some((l) => l.trim().startsWith("```"))) {
    errors.push({ field: "manuscript_contract", expected: "正文不含代码围栏", actual: "发现 ``` 围栏行", hint: "删除围栏，正文文件只放小说正文" });
  }
  if (firstLine === "---") {
    errors.push({ field: "manuscript_contract", expected: "首行不是 YAML 头", actual: "首行为 ---", hint: "删除元数据头，正文文件第一行就是正文或章节标题" });
  }
  if (CONTRACT_PREAMBLE_RE.test(firstNonEmpty)) {
    errors.push({ field: "manuscript_contract", expected: "无说明性前言", actual: `首个非空行「${firstNonEmpty.slice(0, 20)}…」`, hint: "删掉写给人看的说明，从正文第一句开始" });
  }
  const titleMatch = firstNonEmpty.match(CONTRACT_TITLE_RE);
  if (titleMatch && parseInt(titleMatch[1], 10) !== chapter) {
    errors.push({ field: "manuscript_contract", expected: `标题行章号为 ${chapter}`, actual: `标题行写的是第 ${titleMatch[1]} 章`, hint: "标题行章号必须与本章一致" });
  }
  const trimmedBody = body.trimEnd();
  if (trimmedBody.length > 0 && !CONTRACT_TERMINAL_RE.test(trimmedBody)) {
    errors.push({ field: "manuscript_contract", expected: "结尾是完整句（句末标点收束）", actual: `末字符「${trimmedBody.slice(-1)}」`, hint: "正文疑似被截断，补完最后一句" });
  }
  if (CONTRACT_ASCII_QUOTE_CN_RE.test(raw)) warnings.push("发现 ASCII 引号包中文对白，建议统一为中文弯引号");
  return { errors, warnings };
}

/**
 * ASCII 引号机械归一：仅处理「同一行内成对出现、且该行含汉字」的 ASCII 双引号，
 * 按开/闭交替替换为中文弯引号。奇数个引号的行不动（宁可留给软警告，不做歧义猜测）。
 */
export function normalizeAsciiQuotesInChinese(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!/[一-鿿]/.test(line)) return line;
      const count = (line.match(/"/g) ?? []).length;
      if (count === 0 || count % 2 !== 0) return line;
      let open = true;
      return line.replace(/"/g, () => {
        const ch = open ? "“" : "”";
        open = !open;
        return ch;
      });
    })
    .join("\n");
}

/**
 * 直角引号归一：仅当整篇「一个弯引号都没有、却有直角引号」时——那说明写手整章换用了另一套
 * 引号体系（对白职责整体落在直角引号上），按弯引号统一（真人网文对照 14/14 用弯引号）。
 * 弯直混用时一律不动：混用章里的直角引号多半在标术语与专名（异能名、社团名），
 * 无条件替换会把专名标记读成对白。写手 prompt 早已要求用弯引号却仍漂形态，故下沉为机械兜底。
 */
export function normalizeCornerQuotesWhenSoleForm(text: string): string {
  if (!/[一-鿿]/.test(text)) return text;
  if (/[“”]/.test(text)) return text;
  if (!/[「」]/.test(text)) return text;
  return text
    .replace(/『/g, "‘")
    .replace(/』/g, "’")
    .replace(/「/g, "“")
    .replace(/」/g, "”");
}

/**
 * novel_check_manuscript_contract：/write 写手完成后立即预检本章 staging 正文。
 * 先做引号机械归一（ASCII 成对交替 + 整篇独用直角引号时按弯引号统一；
 * 有变化才写回；此时正文尚未进审校，指纹链不受影响），
 * 再跑机械合同。无 staging 一律放行（作者手改 / 存量老书链路不受门）。
 * 归一只在本 handler 做——writers 记忆入口与 update_progress 共用的
 * checkManuscriptContract 保持纯读，账房门不写文件。
 */
export async function novelCheckManuscriptContract(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const chapter = args["chapter"];
  if (!isPositiveInteger(chapter)) {
    return singleError(
      "chapter",
      "integer ≥ 1",
      `${typeof chapter}: ${JSON.stringify(chapter)}`,
      "传入要预检的章节号（正整数）",
    );
  }

  const stagingPath = stagingManuscriptPath(ctx.projectRoot, chapter);
  let normalized = false;
  try {
    const raw = await readFile(stagingPath, "utf-8");
    // 先 ASCII 归一，再判直角：半角与直角混用的章归一后已有弯引号，直角引号按混用规则保留
    const withNormalizedQuotes = normalizeCornerQuotesWhenSoleForm(
      normalizeAsciiQuotesInChinese(raw),
    );
    if (withNormalizedQuotes !== raw) {
      await writeFile(stagingPath, withNormalizedQuotes, "utf-8");
      normalized = true;
    }
  } catch {
    // 无 staging：交由 checkManuscriptContract 返回 null 免检
  }

  const contract = await checkManuscriptContract(ctx, chapter);
  if (!contract) {
    return {
      ok: true,
      chapter,
      staging: false,
      errors: [],
      warnings: [],
      normalized: false,
      message: "本章无草稿区正文，合同免检",
    };
  }

  const { errors, warnings } = contract;
  return {
    ok: errors.length === 0,
    chapter,
    staging: true,
    errors,
    warnings,
    normalized,
    message:
      errors.length === 0
        ? warnings.length > 0
          ? `合同通过，${warnings.length} 条提醒`
          : "合同通过"
        : `合同不通过：${errors.length} 项硬性问题需修复`,
  };
}

async function loadStateDocument(
  projectRoot: string,
): Promise<{ doc: Document; statePath: string } | { error: string }> {
  const statePath = join(projectRoot, ".narracat", "state.yaml");
  let raw: string;
  try {
    raw = await readFile(statePath, "utf-8");
  } catch {
    return {
      error: `无法读取 ${statePath}：state.yaml 不存在或不可读，请确认项目已初始化`,
    };
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    return {
      error: `state.yaml 不是合法 YAML，拒绝写入：${doc.errors[0].message}`,
    };
  }
  return { doc, statePath };
}

// ============================================================
// structure 节写入（novel_sync_structure 与 novel_submit_outline 共用）
// ============================================================

interface StructureSyncInput {
  totalVolumes: number;
  totalChaptersPlanned: number;
  chapterToVolume: Map<number, number>;
}

function syncError(
  field: string,
  expected: string,
  actualValue: unknown,
  hint: string,
): ToolErrorItem {
  let actual: string;
  try {
    actual = `${Array.isArray(actualValue) ? "array" : typeof actualValue}: ${JSON.stringify(actualValue)}`;
  } catch {
    actual = String(actualValue);
  }
  if (actual.length > 120) actual = `${actual.slice(0, 120)}…`;
  return { field, expected, actual, hint };
}

/**
 * 三层交叉校验：
 * 1. 标量字段类型（total_volumes / total_chapters_planned 为正整数，map 为 object）
 * 2. 覆盖互证：章号键恰好覆盖 1..total_chapters_planned（无缺口无多余）；
 *    卷号值落在 1..total_volumes 且每卷至少一章
 * 3. 区间语义：章到卷单调不减（卷是连续章节区间）
 */
function validateStructureSync(
  args: Record<string, unknown>,
): { input: StructureSyncInput; errors: null } | { input: null; errors: ToolErrorItem[] } {
  const errors: ToolErrorItem[] = [];
  const totalVolumes = args["total_volumes"];
  const totalChapters = args["total_chapters_planned"];
  const rawMap = args["chapter_to_volume"];

  if (!isPositiveInteger(totalVolumes)) {
    errors.push(syncError("total_volumes", "integer ≥ 1", totalVolumes, "传入全书总卷数（正整数）"));
  }
  if (!isPositiveInteger(totalChapters)) {
    errors.push(
      syncError("total_chapters_planned", "integer ≥ 1", totalChapters, "传入全书规划总章数（正整数）"),
    );
  }
  if (typeof rawMap !== "object" || rawMap === null || Array.isArray(rawMap)) {
    errors.push(
      syncError("chapter_to_volume", "object（章号 → 卷号）", rawMap, "以 JSON object 传入完整章到卷映射"),
    );
  }
  if (errors.length > 0) return { input: null, errors };

  const volumes = totalVolumes as number;
  const chapters = totalChapters as number;
  const chapterToVolume = new Map<number, number>();
  const invalidKeys: string[] = [];
  const invalidValues: Array<{ chapter: string; volume: unknown }> = [];

  for (const [key, value] of Object.entries(rawMap as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || !isPositiveInteger(Number(key))) {
      invalidKeys.push(key);
      continue;
    }
    if (!isPositiveInteger(value) || value > volumes) {
      invalidValues.push({ chapter: key, volume: value });
      continue;
    }
    chapterToVolume.set(Number(key), value);
  }

  if (invalidKeys.length > 0) {
    errors.push(
      syncError(
        "chapter_to_volume",
        "键为章号（正整数字符串）",
        invalidKeys,
        "章号键必须是正整数，检查映射键的拼写",
      ),
    );
  }
  if (invalidValues.length > 0) {
    errors.push(
      syncError(
        "chapter_to_volume",
        `值为 1..${volumes} 的卷号`,
        invalidValues,
        "卷号必须是正整数且不超过 total_volumes",
      ),
    );
  }

  const missing: number[] = [];
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    if (!chapterToVolume.has(chapter)) missing.push(chapter);
  }
  const extra = [...chapterToVolume.keys()].filter((chapter) => chapter > chapters);

  if (missing.length > 0 && invalidKeys.length === 0 && invalidValues.length === 0) {
    errors.push(
      syncError(
        "chapter_to_volume",
        `覆盖第 1..${chapters} 全部章节`,
        { missing_chapters: missing },
        "映射缺章：与 total_chapters_planned 互证失败，按 arc 的 chapter_start/chapter_end 重新展开",
      ),
    );
  }
  if (extra.length > 0) {
    errors.push(
      syncError(
        "chapter_to_volume",
        `章号不超过 total_chapters_planned (${chapters})`,
        { extra_chapters: extra },
        "映射含超出规划总章数的章号：检查 total_chapters_planned 是否传错",
      ),
    );
  }

  if (errors.length === 0) {
    const coveredVolumes = new Set(chapterToVolume.values());
    const missingVolumes: number[] = [];
    for (let volume = 1; volume <= volumes; volume += 1) {
      if (!coveredVolumes.has(volume)) missingVolumes.push(volume);
    }
    if (missingVolumes.length > 0) {
      errors.push(
        syncError(
          "total_volumes",
          "每卷至少包含一章",
          { empty_volumes: missingVolumes },
          "有卷没有任何章节归属：与 total_volumes 互证失败，检查卷数是否传错",
        ),
      );
    }

    let previousVolume = 0;
    for (let chapter = 1; chapter <= chapters; chapter += 1) {
      const volume = chapterToVolume.get(chapter) as number;
      if (volume < previousVolume) {
        errors.push(
          syncError(
            "chapter_to_volume",
            "章到卷单调不减（卷是连续章节区间）",
            { chapter, volume, previous_volume: previousVolume },
            `第 ${chapter} 章的卷号 ${volume} 小于前一章的卷号 ${previousVolume}，归卷乱序`,
          ),
        );
        break;
      }
      previousVolume = volume;
    }
  }

  if (errors.length > 0) return { input: null, errors };

  return {
    input: { totalVolumes: volumes, totalChaptersPlanned: chapters, chapterToVolume },
    errors: null,
  };
}

/**
 * 校验后整体写入 state.yaml.structure（read-modify-write，其余节原样保留）。
 * novel_sync_structure 工具与 novel_submit_outline 入库链共用本函数。
 */
export async function writeStructureToState(
  projectRoot: string,
  totalVolumes: number,
  totalChaptersPlanned: number,
  chapterToVolume: Map<number, number>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const loaded = await loadStateDocument(projectRoot);
  if ("error" in loaded) return { ok: false, message: loaded.error };
  const { doc, statePath } = loaded;

  // 章号升序的 Map：yaml 对 number 键输出无引号的 `1: 1` 形态
  const orderedMap = new Map<number, number>();
  for (let chapter = 1; chapter <= totalChaptersPlanned; chapter += 1) {
    orderedMap.set(chapter, chapterToVolume.get(chapter) as number);
  }

  doc.set(
    "structure",
    doc.createNode(
      new Map<string, unknown>([
        ["total_volumes", totalVolumes],
        ["total_chapters_planned", totalChaptersPlanned],
        ["chapter_to_volume", orderedMap],
      ]),
    ),
  );

  await writeFile(statePath, String(doc), "utf-8");
  return { ok: true };
}

// ============================================================
// novel_sync_structure — 校验后机械写入 state.yaml.structure
// ============================================================

export async function novelSyncStructure(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const validation = validateStructureSync(args);
  if (validation.errors) {
    return errorResponse(validation.errors);
  }

  const { totalVolumes, totalChaptersPlanned, chapterToVolume } = validation.input;
  const written = await writeStructureToState(
    ctx.projectRoot,
    totalVolumes,
    totalChaptersPlanned,
    chapterToVolume,
  );
  if (!written.ok) {
    return singleError("state.yaml", "可读写的合法 YAML", "不可用", written.message);
  }

  return {
    ok: true,
    total_volumes: totalVolumes,
    total_chapters_planned: totalChaptersPlanned,
    mapped_chapters: totalChaptersPlanned,
    message: `全书结构已同步：${totalVolumes} 卷 / ${totalChaptersPlanned} 章`,
  };
}

// ============================================================
// novel_update_progress / novel_restore_progress — 章节进度机械更新
//
// 两个工具共用同一段进度写逻辑（applyProgressUpdate），区别只在门：
// - novel_update_progress ：写作链尾强门，必须有 PASS 审校且指纹匹配（审过的 = 提交的）
// - novel_restore_progress：作者手改正文的记忆同步链路专用，不做新鲜度校验；
//   豁免边界由命令 allowed-tools 白名单持有（只有 /sync-chapter-memory 拿得到本工具），
//   不做成 update_progress 的入参开关——参数型豁免口任何调用方都能自行打开。
// ============================================================

/**
 * 审校新鲜度检查（写作链共用的一道门）。
 *
 * requireReview=true（链尾强门，novel_update_progress）：无记录 / 非 pass / 指纹不匹配均拒；
 * requireReview=false（记忆写入门，章摘要与事实落库）：无记录放行——回滚后重建链路此时本就
 * 没有审校记录，门若在这里拒绝会把 /rewrite 与 /sync-chapter-memory 锁死；有记录则必须
 * pass 且指纹匹配，即「审过之后又被改过的正文」进不了记忆。
 *
 * 通过返回 null，否则返回 ToolErrorItem[]（field="review_freshness"）。
 */
export async function checkReviewFreshness(
  ctx: ToolContext,
  chapter: number,
  requireReview: boolean,
): Promise<ToolErrorItem[] | null> {
  const review = ctx.db
    .prepare(
      `SELECT verdict, reviewed_manuscript_sha256 FROM chapter_reviews
       WHERE novel_id = ? AND chapter = ?`,
    )
    .get(ctx.novelId, chapter) as
    | { verdict: string; reviewed_manuscript_sha256: string | null }
    | undefined;

  if (!review && !requireReview) return null;

  const manuscript = await resolveWorkingManuscript(ctx.projectRoot, chapter);
  if (!manuscript) {
    return [
      {
        field: "review_freshness",
        expected: "本章正文文件存在",
        actual: "未找到正文文件",
        hint: "先完成正文写作与审校，再继续",
      },
    ];
  }
  const content = await readFile(manuscript.path, "utf-8");
  const currentSha256 = createHash("sha256").update(content, "utf8").digest("hex");

  if (!review || review.verdict !== "pass") {
    return [
      {
        field: "review_freshness",
        expected: "本章最新审校结论为 pass",
        actual: review ? `最新审校为 ${review.verdict}` : "本章没有审校记录",
        hint: "先派发审校并通过，再继续",
      },
    ];
  }
  if (review.reviewed_manuscript_sha256 !== currentSha256) {
    return [
      {
        field: "review_freshness",
        expected: "最终正文与最后一次审校通过的版本一致",
        actual: review.reviewed_manuscript_sha256
          ? "正文在审校通过后又被修改过"
          : "该审校记录没有正文指纹（升级前的旧审校）",
        hint: "正文在审校后发生过变化（段落替换、机械腔擦除、重缝，或外部工具改写——注意部分模型会静默替换全角引号）。请重新审校后再继续",
      },
    ];
  }
  return null;
}

/** state.yaml structure.chapter_to_volume 取目标卷号；取不到返回 null（不猜路径） */
async function resolveChapterVolume(projectRoot: string, chapter: number): Promise<number | null> {
  const loaded = await loadStateDocument(projectRoot);
  if ("error" in loaded) return null;
  const map = loaded.doc.getIn(["structure", "chapter_to_volume"]);
  const json = map && typeof (map as { toJSON?: unknown }).toJSON === "function"
    ? (map as { toJSON: () => unknown }).toJSON()
    : null;
  if (!json || typeof json !== "object") return null;
  const value = (json as Record<string, unknown>)[String(chapter)];
  return isPositiveInteger(value) ? value : null;
}

/**
 * 原子提交：staging → manuscript/vol-VV/ch-NNN.md（同文件系统 rename 原子）；
 * 随手清理同章任务书与 brief-lint marker 文件（marker 是已删除的 shell 钩子遗留——现钩子把状态存在
 * App 侧内存里、不再落 marker；这段清理只为扫掉存量老书目录里的残留文件，新链路无产出也无害）。
 * 无 staging（作者手改 / 存量老书链路 / 该章已提交过）→ 静默跳过，不算错误。
 */
async function promoteStagingManuscript(
  ctx: ToolContext,
  chapter: number,
): Promise<{ promoted: boolean } | { errors: ToolErrorItem[] }> {
  const stagingPath = stagingManuscriptPath(ctx.projectRoot, chapter);
  try {
    await access(stagingPath);
  } catch {
    return { promoted: false }; // 无 staging：作者链路 / 重跑已完成章，静默跳过
  }
  const volume = await resolveChapterVolume(ctx.projectRoot, chapter);
  if (volume === null) {
    return {
      errors: [
        {
          field: "structure.chapter_to_volume",
          expected: `包含第 ${chapter} 章的卷号映射`,
          actual: "取不到该章卷号",
          hint: "先执行大纲提交（novel_submit_outline / novel_sync_structure）建立章到卷映射，再完成本章",
        },
      ],
    };
  }
  const targetDir = join(ctx.projectRoot, "manuscript", volumeDirSegment(volume));
  await mkdir(targetDir, { recursive: true });
  await rename(stagingPath, join(targetDir, `ch-${chapterFileSegment(chapter)}.md`));
  await rm(join(ctx.projectRoot, ".narracat", "staging", `ch-${chapterFileSegment(chapter)}.brief.md`), {
    force: true,
  });
  await rm(
    join(ctx.projectRoot, ".narracat", "staging", `.brief-lint-warned-ch-${chapterFileSegment(chapter)}`),
    { force: true },
  );
  return { promoted: true };
}

/** 进度写入本体：完成集合去重升序、字数读文件实算、清 checkpoint，整体安全写 state.yaml */
async function applyProgressUpdate(
  chapter: number,
  ctx: ToolContext,
): Promise<
  | { ok: false; error: string }
  | { ok: true; completed: number[]; lastCompleted: number; total: number }
> {
  const loaded = await loadStateDocument(ctx.projectRoot);
  if ("error" in loaded) {
    return { ok: false, error: loaded.error };
  }
  const { doc, statePath } = loaded;

  // completed_chapters：追加 + 去重 + 升序
  const existingRaw = doc.getIn(["progress", "completed_chapters"]);
  const existing: number[] = [];
  if (existingRaw && typeof (existingRaw as { toJSON?: unknown }).toJSON === "function") {
    const parsed = (existingRaw as { toJSON: () => unknown }).toJSON();
    if (Array.isArray(parsed)) {
      for (const v of parsed) {
        if (isPositiveInteger(v)) existing.push(v);
      }
    }
  }
  const completed = [...new Set([...existing, chapter])].sort((a, b) => a - b);
  const lastCompleted = completed[completed.length - 1];

  doc.setIn(["progress", "completed_chapters"], doc.createNode(completed));
  doc.setIn(["progress", "last_completed_chapter"], lastCompleted);
  doc.setIn(["progress", "in_progress_chapter"], null);

  // word_count：读 manuscript 文件实数求和（不信任 LLM 报数）
  const manuscripts = await scanManuscripts(ctx.projectRoot);
  const byChapter = new Map<number, number>();
  let total = 0;
  for (const entry of manuscripts) {
    let content: string;
    try {
      content = await readFile(entry.path, "utf-8");
    } catch {
      continue;
    }
    const count = countWords(visibleBodyText(content));
    byChapter.set(entry.chapter, count);
    total += count;
  }
  doc.setIn(["word_count", "total"], total);
  doc.setIn(["word_count", "by_chapter"], doc.createNode(byChapter));

  // 清 checkpoint（别的章写到一半的中断记录保留，见 clearCheckpointKeepingPendingWrite）
  clearCheckpointKeepingPendingWrite(doc);

  await writeFile(statePath, String(doc), "utf-8");

  return { ok: true, completed, lastCompleted, total };
}

export async function novelUpdateProgress(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const chapter = args["chapter"];
  if (!isPositiveInteger(chapter)) {
    return singleError(
      "chapter",
      "integer ≥ 1",
      `${typeof chapter}: ${JSON.stringify(chapter)}`,
      "传入刚完成的章节号（正整数）",
    );
  }

  // 机械合同门：staging 上的半成品不得进正式路径（无 staging 免检，见 checkManuscriptContract）
  const contract = await checkManuscriptContract(ctx, chapter);
  if (contract && contract.errors.length > 0) return errorResponse(contract.errors);

  // 审校新鲜度硬门：最终提交的正文必须就是最后一次审校 PASS 的那份文件（指纹一致）
  const freshnessErrors = await checkReviewFreshness(ctx, chapter, true);
  if (freshnessErrors) return errorResponse(freshnessErrors);

  // 原子 promote：门全过后才把 staging 转正；无 staging 静默跳过（老书 / 作者链路）
  const promoted = await promoteStagingManuscript(ctx, chapter);
  if ("errors" in promoted) return errorResponse(promoted.errors);

  const written = await applyProgressUpdate(chapter, ctx);
  if (!written.ok) {
    return singleError("state.yaml", "可读写的合法 YAML", "不可用", written.error);
  }

  return {
    ok: true,
    chapter,
    completed_chapters: written.completed,
    last_completed_chapter: written.lastCompleted,
    word_count_total: written.total,
    message: `第${chapter}章进度已更新（累计完成 ${written.completed.length} 章，总字数 ${written.total}）`,
  };
}

/**
 * 作者手改正文后的记忆同步链路专用：恢复章节完成进度，不做审校新鲜度校验。
 * 作者自己改的稿不要求机器复审——但豁免只对持有本工具的命令成立，写作链拿不到它。
 */
export async function novelRestoreProgress(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const chapter = args["chapter"];
  if (!isPositiveInteger(chapter)) {
    return singleError(
      "chapter",
      "integer ≥ 1",
      `${typeof chapter}: ${JSON.stringify(chapter)}`,
      "传入要恢复进度的章节号（正整数）",
    );
  }

  const written = await applyProgressUpdate(chapter, ctx);
  if (!written.ok) {
    return singleError("state.yaml", "可读写的合法 YAML", "不可用", written.error);
  }

  return {
    ok: true,
    chapter,
    completed_chapters: written.completed,
    last_completed_chapter: written.lastCompleted,
    word_count_total: written.total,
    message: `第${chapter}章进度已恢复（累计完成 ${written.completed.length} 章，总字数 ${written.total}）`,
  };
}

// ============================================================
// novel_checkpoint — 机械写 checkpoint 节
// ============================================================

/** 当前断点是写章且该章尚未完成时返回它（章号取自「write N」）。 */
function unfinishedWriteCheckpoint(doc: Document): { lastCommand: string; chapter: number } | null {
  const raw = doc.getIn(["checkpoint", "last_command"]);
  if (typeof raw !== "string") return null;
  const match = /^(?:\/narracat:)?write\s+(\d+)$/.exec(raw.trim());
  if (!match) return null;
  const chapter = Number(match[1]);
  if (!isPositiveInteger(chapter) || parseCompletedChapters(doc).includes(chapter)) return null;
  return { lastCommand: raw.trim(), chapter };
}

/**
 * 收尾清断点：当前断点若是另一章写到一半（write N、第 N 章仍未完成），保留它——作品页靠它认出
 * 可继续写的中断章，改写 / 同步别的章收尾时不能顺手清掉。须在完成进度写回 doc 之后调用：
 * 写章自己完成第 N 章时 N 已进完成集合，断点照常清。
 */
function clearCheckpointKeepingPendingWrite(doc: Document): void {
  if (unfinishedWriteCheckpoint(doc)) return;
  doc.setIn(["checkpoint", "last_command"], null);
  doc.setIn(["checkpoint", "last_step"], null);
  doc.setIn(["checkpoint", "context_snapshot"], null);
  doc.setIn(["checkpoint", "timestamp"], null);
}

export async function novelCheckpoint(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const command = args["command"];
  const step = args["step"];
  const chapter = args["chapter"];

  if (typeof command !== "string" || command.trim() === "") {
    return singleError(
      "command",
      "non-empty string",
      `${typeof command}: ${JSON.stringify(command)}`,
      "传入当前命令名（如 \"write\"）",
    );
  }
  if (typeof step !== "number" && typeof step !== "string") {
    return singleError(
      "step",
      "number | string",
      `${typeof step}: ${JSON.stringify(step)}`,
      "传入当前步骤编号（如 4）",
    );
  }
  if (chapter !== undefined && !isPositiveInteger(chapter)) {
    return singleError(
      "chapter",
      "integer ≥ 1",
      `${typeof chapter}: ${JSON.stringify(chapter)}`,
      "chapter 可省略；提供时必须是正整数章号",
    );
  }

  const loaded = await loadStateDocument(ctx.projectRoot);
  if ("error" in loaded) {
    return singleError("state.yaml", "可读写的合法 YAML", "不可用", loaded.error);
  }
  const { doc, statePath } = loaded;

  const lastCommand = isPositiveInteger(chapter) ? `${command.trim()} ${chapter}` : command.trim();
  const timestamp = new Date().toISOString();

  // 未完成的写章断点只让写章自己覆盖：作品页靠 last_command="write N" 认出可继续写的中断章，
  // 中途跑设定 / 大纲等别的命令若把它改掉，作者就找不回「继续写第 N 章」。这些命令只拿断点做展示、
  // 不据此恢复，所以跳过它们的断点不影响它们自己。
  const pendingWrite = unfinishedWriteCheckpoint(doc);
  if (pendingWrite && !/^(?:\/narracat:)?write$/.test(command.trim())) {
    return {
      ok: true,
      preserved_write_checkpoint: true,
      last_command: pendingWrite.lastCommand,
      message: `第${pendingWrite.chapter}章写作中断的断点保留，本次「${lastCommand}」步骤 ${step} 不记断点`,
    };
  }

  doc.setIn(["checkpoint", "last_command"], lastCommand);
  doc.setIn(["checkpoint", "last_step"], step);
  doc.setIn(["checkpoint", "timestamp"], timestamp);

  await writeFile(statePath, String(doc), "utf-8");

  return {
    ok: true,
    last_command: lastCommand,
    last_step: step,
    timestamp,
  };
}

// ============================================================
// readCompletedChapters — 只读取完成章节列表（novel_rollback_chapter 判断后文是否已写完）
// ============================================================

function parseCompletedChapters(doc: Document): number[] {
  const existingRaw = doc.getIn(["progress", "completed_chapters"]);
  const existing: number[] = [];
  if (existingRaw && typeof (existingRaw as { toJSON?: unknown }).toJSON === "function") {
    const parsed = (existingRaw as { toJSON: () => unknown }).toJSON();
    if (Array.isArray(parsed)) {
      for (const v of parsed) {
        if (isPositiveInteger(v)) existing.push(v);
      }
    }
  }
  return [...new Set(existing)].sort((a, b) => a - b);
}

export async function readCompletedChapters(
  projectRoot: string,
): Promise<{ ok: true; chapters: number[] } | { ok: false; error: string }> {
  const loaded = await loadStateDocument(projectRoot);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  return { ok: true, chapters: parseCompletedChapters(loaded.doc) };
}

// ============================================================
// revertProgressToChapter — 回滚 state.yaml 进度到指定章之前
// （novel_rollback_chapter 调用；LLM 对 state.yaml 零 Edit）
// ============================================================

export async function revertProgressToChapter(
  projectRoot: string,
  chapter: number,
): Promise<
  | { ok: true; completed_chapters: number[]; word_count_total: number }
  | { ok: false; error: string }
> {
  const loaded = await loadStateDocument(projectRoot);
  if ("error" in loaded) {
    return { ok: false, error: loaded.error };
  }
  const { doc, statePath } = loaded;

  // completed_chapters：仅保留回滚点之前的章
  const completed = parseCompletedChapters(doc).filter((c) => c < chapter);
  const lastCompleted = completed.length > 0 ? completed[completed.length - 1] : null;

  doc.setIn(["progress", "completed_chapters"], doc.createNode(completed));
  doc.setIn(["progress", "last_completed_chapter"], lastCompleted);
  doc.setIn(["progress", "in_progress_chapter"], null);

  // word_count：只统计保留章节的 manuscript 实数（被回滚章的文件可能尚未删除/重写）
  const keep = new Set(completed);
  const manuscripts = await scanManuscripts(projectRoot);
  const byChapter = new Map<number, number>();
  let total = 0;
  for (const entry of manuscripts) {
    if (!keep.has(entry.chapter)) continue;
    let content: string;
    try {
      content = await readFile(entry.path, "utf-8");
    } catch {
      continue;
    }
    const count = countWords(visibleBodyText(content));
    byChapter.set(entry.chapter, count);
    total += count;
  }
  doc.setIn(["word_count", "total"], total);
  doc.setIn(["word_count", "by_chapter"], doc.createNode(byChapter));

  // 清 checkpoint（回滚后旧断点不再有效；别的章写到一半的中断记录保留）
  clearCheckpointKeepingPendingWrite(doc);

  await writeFile(statePath, String(doc), "utf-8");

  return { ok: true, completed_chapters: completed, word_count_total: total };
}
