/**
 * 读工具实现（12 个；novel_query_style_reference 在独立 handler 中）
 *
 * - 检索统一走 hybrid（FTS5 + 向量，RRF 合并），排序加确定性章节距离衰减
 *   score * 1/(1 + 0.05 * chapter_distance)
 * - novel_build_writing_context_pack 是纯代码 builder：按区块预算组装、
 *   超限硬截断并写入 warnings，落盘 .narracat/context-packs/ch-NNN.json
 * - 参数错误统一返回 { ok: false, errors: [{field, expected, actual, hint}] }
 */

import { readFile, writeFile, mkdir, readdir, access } from "node:fs/promises";
import { basename, join, dirname } from "node:path";
import {
  hybridSearch,
  multiQueryHybridSearch,
  type HybridSearchResult,
} from "../utils/hybrid-search.js";
import {
  computeStructureBudget,
  scanManuscriptProseHygiene,
  type ChapterOutlineItem,
} from "./validators.js";
import { scanProseFingerprints } from "../utils/prose-fingerprints.js";
import { scanProseShape } from "../utils/prose-shape.js";
import { renderChapterOutlineMarkdown } from "./chapter-outline-render.js";
import {
  chapterFileSegment,
  extractManuscriptSnippets,
  checkReviewFreshness,
  resolveWorkingManuscript,
  findManuscript,
  volumeDirSegment,
} from "./state-sync.js";
import { selectStyleExamples, detectChapterEmotions } from "../corpus-loader.js";
import { listStyleAnchorRows } from "./style-anchor.js";
import { selectCraftPacks } from "../craft-pack-loader.js";
import { selectPersona } from "../persona-loader.js";
import { resolvePackPools } from "../packs/pack-resolver.js";
import { STRUCTURE_STAGES, type StructureStage } from "../packs/pack-manifest.js";
import { buildReceiptEntries, writeCapabilityReceipt, writePlanningCapabilityReceipt } from "../packs/capability-receipt.js";
import { narratorAddressPhrase } from "./narrator-address.js";
import {
  loadAliasMap,
  resolveCharacterUid,
  normalizeName,
  type ResolvedCharacter,
} from "./alias-map.js";
import { classifyQuery } from "./query-router.js";
import { buildEntityGraph, type GraphFactRow } from "./entity-graph.js";
import { personalizedPageRank } from "../utils/ppr.js";
import {
  FACT_VALID_AT_SQL,
  FACT_LATEST_ORDER_SQL,
  isFactValidAt,
  SECRET_FILTER_SQL,
  isSecretHiddenForChat,
} from "./fact-temporal.js";
import {
  foldCharacterCard,
  renderCardHumanMap,
  isEmptyFoldedCard,
  readPredicateFromCard,
  normalizeExtraValue,
  type FoldedCard,
} from "./character-card-fold.js";
import { loadStateVocabulary } from "./state-dimensions.js";
import {
  computeDerivedRelationships,
  loadFactCountByUid,
  loadValidRelationshipEdges,
} from "./derived-relationships.js";
import { singleError } from "../types.js";
import type {
  ToolContext,
  SummaryRow,
  FactRow,
  SettingRow,
  ArcMetaRow,
  ArcSummaryRow,
  StorylineRow,
  ForeshadowingRegistryRow,
  CharacterCardRow,
  ChapterReviewRow,
} from "../types.js";

// ============================================================
// 共用辅助
// ============================================================

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : null;
}

function describe(value: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = String(value);
  }
  if (rendered.length > 80) rendered = `${rendered.slice(0, 80)}…`;
  return `${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}: ${rendered}`;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * 章目标字数区间：有 words_per_chapter → ±20%（`[round(x*0.8), round(x*1.2)]`）；
 * 缺失 → 通用默认 2400-3600。本 builder（区块字数区间）与 state-sync.ts 的
 * checkManuscriptContract（机械合同字数下限/上限）共用同一份公式，避免两处独立漂移。
 */
export function getChapterWordCountRange(
  wordsPerChapter: number | null | undefined,
): [number, number] {
  if (wordsPerChapter) {
    return [Math.round(wordsPerChapter * 0.8), Math.round(wordsPerChapter * 1.2)];
  }
  return [2400, 3600];
}

/**
 * 聊天只读滤网 SQL 追加片段：ctx.secretFilter 为真（聊天 MCP 代理路径）时返回
 * ` AND ${SECRET_FILTER_SQL}`，否则空串（写作链路不回归）。供 facts 查询直接拼接。
 */
function secretFilterClause(ctx: ToolContext): string {
  return ctx.secretFilter ? ` AND ${SECRET_FILTER_SQL}` : "";
}

/** 已入库的最新章号（无章时 null） */
function latestChapter(ctx: ToolContext): number | null {
  const row = ctx.db
    .prepare(
      "SELECT MAX(chapter) AS c FROM chapter_summaries WHERE novel_id = ?",
    )
    .get(ctx.novelId) as { c: number | null };
  return row.c;
}

/** 确定性章节距离衰减 */
function decayScore(
  score: number,
  sourceChapter: number | null,
  referenceChapter: number | null,
): number {
  if (sourceChapter === null || referenceChapter === null) return score;
  return score * (1 / (1 + 0.05 * Math.abs(referenceChapter - sourceChapter)));
}

interface SourceDetail {
  content: string;
  source: string;
  chapter: number | null;
}

/** 检索命中回表：取内容与来源章号（失效事实直接丢弃） */
function getSourceDetail(
  ctx: ToolContext,
  sourceTable: string,
  sourceId: string,
): SourceDetail | null {
  switch (sourceTable) {
    case "chapter_summaries": {
      const row = ctx.db
        .prepare("SELECT * FROM chapter_summaries WHERE id = ?")
        .get(sourceId) as SummaryRow | undefined;
      if (!row) return null;
      return { content: row.summary, source: "chapter_summary", chapter: row.chapter };
    }
    case "facts": {
      const row = ctx.db
        .prepare("SELECT * FROM facts WHERE id = ?")
        .get(sourceId) as FactRow | undefined;
      if (!row || row.invalidated_at_chapter !== null) return null;
      // 聊天只读滤网（片4）：非 SQL 检索段（hybridSearch 命中集）在此行装配处按同判据过滤，
      // 与 novel_character_state / novel_relationship 的 SQL 侧过滤同一判据（fact-temporal.ts SSOT）。
      if (isSecretHiddenForChat(row, ctx.secretFilter ?? false)) return null;
      return {
        content: `${row.subject} ${row.predicate} ${row.object}`,
        source: "fact",
        chapter: row.from_chapter,
      };
    }
    case "settings": {
      const row = ctx.db
        .prepare("SELECT * FROM settings WHERE id = ?")
        .get(sourceId) as SettingRow | undefined;
      if (!row) return null;
      return { content: row.content, source: "setting", chapter: null };
    }
    case "arc_summaries": {
      const sep = sourceId.indexOf(":");
      if (sep === -1) return null;
      const row = ctx.db
        .prepare(
          "SELECT * FROM arc_summaries WHERE novel_id = ? AND scope = ? AND scope_id = ?",
        )
        .get(ctx.novelId, sourceId.slice(0, sep), sourceId.slice(sep + 1)) as
        | ArcSummaryRow
        | undefined;
      if (!row) return null;
      return { content: row.summary, source: "arc_summary", chapter: row.chapter_end };
    }
    default:
      return null;
  }
}

// 角色状态卡机械折叠：收敛于 character-card-fold.ts（SSOT，writers.ts 同源共用）

function getArcForChapter(ctx: ToolContext, chapter: number): ArcMetaRow | undefined {
  return ctx.db
    .prepare(
      `SELECT * FROM arc_meta
       WHERE novel_id = ? AND chapter_start <= ? AND chapter_end >= ?
       ORDER BY chapter_start LIMIT 1`,
    )
    .get(ctx.novelId, chapter, chapter) as ArcMetaRow | undefined;
}

function getVolumeRange(
  ctx: ToolContext,
  volumeNo: number,
): { chapter_start: number; chapter_end: number } | null {
  const row = ctx.db
    .prepare(
      `SELECT MIN(chapter_start) AS s, MAX(chapter_end) AS e
       FROM arc_meta WHERE novel_id = ? AND volume_no = ?`,
    )
    .get(ctx.novelId, volumeNo) as { s: number | null; e: number | null };
  return row.s !== null && row.e !== null
    ? { chapter_start: row.s, chapter_end: row.e }
    : null;
}

// ============================================================
// novel_query — 查询类型路由 + 混合检索（FTS + 向量，RRF 合并 + 距离衰减）
// ============================================================

/** 摘要类来源：弧线查询只取这几类，过滤掉零碎事实 */
const SUMMARY_SOURCE_TABLES = new Set(["arc_summaries", "chapter_summaries"]);

/**
 * 弧线召回：混合检索后过滤到摘要类来源（卷 / 弧 / 章摘要），
 * 让全局走向类查询拿到摘要脉络而非零碎事实；过滤后为空则回退全部命中。
 */
async function arcRecall(
  ctx: ToolContext,
  query: string,
  limit: number,
): Promise<HybridSearchResult[]> {
  const hits = await hybridSearch(ctx.db, query, ctx.novelId, { limit: limit * 5 });
  const summaryHits = hits.filter((h) => SUMMARY_SOURCE_TABLES.has(h.sourceTable));
  return (summaryHits.length > 0 ? summaryHits : hits).slice(0, limit * 3);
}

/** 种子无 uid（角色未建 character_identity）或不在图中时，回退多查询混合检索 */
function multiHopFallback(
  ctx: ToolContext,
  query: string,
  seedEntities: ResolvedCharacter[],
  limit: number,
): Promise<HybridSearchResult[]> {
  const queries = [query, ...seedEntities.map((e) => e.canonical)];
  return multiQueryHybridSearch(ctx.db, queries, ctx.novelId, { limit: limit * 3 });
}

/**
 * 多跳召回：在 facts 实体图上以种子角色为重启点跑 Personalized PageRank，
 * 把「与种子多跳相关」的实体对应的 facts 按得分聚合返回——单点检索一次走不到的
 * ≥2 跳关系 / 交集由扩散一次答出。种子缺 uid 或不在图中时回退多查询混合检索。
 */
async function multiHopRecall(
  ctx: ToolContext,
  query: string,
  seedEntities: ResolvedCharacter[],
  aliasMap: Map<string, ResolvedCharacter>,
  limit: number,
): Promise<HybridSearchResult[]> {
  const seedUids = seedEntities
    .map((e) => e.uid)
    .filter((u): u is string => u !== null && u.length > 0);
  if (seedUids.length === 0) {
    return multiHopFallback(ctx, query, seedEntities, limit);
  }

  const facts = ctx.db
    .prepare(
      `SELECT id, subject_character_uid, subject_character_b_uid, predicate, object
       FROM facts
       WHERE novel_id = ? AND invalidated_at_chapter IS NULL`,
    )
    .all(ctx.novelId) as GraphFactRow[];

  const { adjacency, factsByEntity } = buildEntityGraph(facts, aliasMap);
  const scores = personalizedPageRank(adjacency, seedUids);
  if (scores.size === 0) {
    return multiHopFallback(ctx, query, seedEntities, limit);
  }

  // fact 得分 = 其关联实体的 PPR 得分之和（连接高分实体的 facts 排前）
  const factScore = new Map<string, number>();
  for (const [uid, factIds] of factsByEntity) {
    const s = scores.get(uid) ?? 0;
    if (s === 0) continue;
    for (const fid of factIds) {
      factScore.set(fid, (factScore.get(fid) ?? 0) + s);
    }
  }

  return [...factScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit * 3)
    .map(([id, score]) => ({ sourceTable: "facts", sourceId: id, rrfScore: score }));
}

export async function novelQuery(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const query = args["query"];
  if (typeof query !== "string" || !query.trim()) {
    return singleError(
      "query",
      "non-empty string",
      describe(query),
      "传入查询短语，宜短宜具体（人名 / 物件名 / 事件短语），或一句话问题",
    );
  }
  const limit = asPositiveInt(args["limit"]) ?? 10;
  const reference = latestChapter(ctx);
  const q = query.trim();

  const aliasMap = await loadAliasMap(ctx.projectRoot);
  const { route, seedEntities } = classifyQuery(q, aliasMap);

  const hits =
    route === "arc"
      ? await arcRecall(ctx, q, limit)
      : route === "multi_hop"
        ? await multiHopRecall(ctx, q, seedEntities, aliasMap, limit)
        : await hybridSearch(ctx.db, q, ctx.novelId, { limit: limit * 3 });

  const results = hits
    .flatMap((hit) => {
      const detail = getSourceDetail(ctx, hit.sourceTable, hit.sourceId);
      if (!detail) return [];
      return [
        {
          content: detail.content,
          source: detail.source,
          chapter: detail.chapter,
          score: decayScore(hit.rrfScore, detail.chapter, reference),
        },
      ];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    ok: true,
    route,
    ...(seedEntities.length > 0
      ? { seed_entities: seedEntities.map((e) => e.canonical) }
      : {}),
    count: results.length,
    results,
  };
}

// ============================================================
// novel_chapter_summary — 章节摘要（单章 / 范围 / 全部）
// ============================================================

function summaryItem(row: SummaryRow) {
  return {
    chapter: row.chapter,
    summary: row.summary,
    characters: parseCharacterRefs(row.characters).map((r) => r.name),
    key_events: parseJsonArray(row.events),
    word_count: row.word_count,
    anchor: {
      core_experience: row.anchor_core,
      heartbeat_moment: row.anchor_heartbeat,
    },
    emotional_tone: row.emotional_tone,
    continuation_hook: parseJsonArray(row.continuation_hook),
    timeline_note: row.timeline_note,
  };
}

export async function novelChapterSummary(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const chapter = asPositiveInt(args["chapter"]);
  const from = asPositiveInt(args["from"]);
  const to = asPositiveInt(args["to"]);

  let rows: SummaryRow[];
  if (chapter !== null) {
    rows = ctx.db
      .prepare(
        "SELECT * FROM chapter_summaries WHERE novel_id = ? AND chapter = ?",
      )
      .all(ctx.novelId, chapter) as SummaryRow[];
  } else if (from !== null && to !== null) {
    rows = ctx.db
      .prepare(
        "SELECT * FROM chapter_summaries WHERE novel_id = ? AND chapter BETWEEN ? AND ? ORDER BY chapter",
      )
      .all(ctx.novelId, from, to) as SummaryRow[];
  } else {
    rows = ctx.db
      .prepare(
        "SELECT * FROM chapter_summaries WHERE novel_id = ? ORDER BY chapter",
      )
      .all(ctx.novelId) as SummaryRow[];
  }

  return { ok: true, count: rows.length, summaries: rows.map(summaryItem) };
}

// ============================================================
// novel_character_state — 角色截至某章的状态（facts 折叠）
// ============================================================

export async function novelCharacterState(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const characterUid = args["character_uid"];
  if (typeof characterUid !== "string" || !characterUid.trim()) {
    return singleError(
      "character_uid",
      "non-empty string",
      describe(characterUid),
      "传入角色 character_uid（取自角色档案 character_identity）",
    );
  }
  const at = asPositiveInt(args["at_chapter"]) ?? latestChapter(ctx) ?? 1;
  const uid = characterUid.trim();

  const rows = ctx.db
    .prepare(
      `SELECT predicate, object, from_chapter FROM facts
       WHERE novel_id = ? AND subject_character_uid = ? AND subject_character_b_uid IS NULL
         AND ${FACT_VALID_AT_SQL}${secretFilterClause(ctx)}
       ORDER BY predicate ASC, ${FACT_LATEST_ORDER_SQL}`,
    )
    .all(ctx.novelId, uid, at, at) as Array<{
    predicate: string;
    object: string;
    from_chapter: number;
  }>;

  const card: Record<string, string> = {};
  for (const row of rows) {
    if (!(row.predicate in card)) card[row.predicate] = row.object;
  }

  return {
    ok: true,
    character_uid: uid,
    at_chapter: at,
    card,
    facts: rows,
  };
}

// ============================================================
// novel_character_statuses — 批量查多个角色截至某章的当前状态
// （facts.status 折叠 + character_cards 兜底；App 联系人列表富化用）
// ============================================================

/** 单角色 status：先折叠 facts.status 实时值，无则回落存量 character_cards 的 status/current_state */
function readCharacterStatus(
  ctx: ToolContext,
  characterUid: string,
  atChapter: number,
): string | null {
  const factRow = ctx.db
    .prepare(
      `SELECT object FROM facts
       WHERE novel_id = ? AND subject_character_uid = ? AND subject_character_b_uid IS NULL
         AND predicate = 'status'
         AND ${FACT_VALID_AT_SQL}
       ORDER BY ${FACT_LATEST_ORDER_SQL}
       LIMIT 1`,
    )
    .get(ctx.novelId, characterUid, atChapter, atChapter) as
    | { object: string }
    | undefined;
  const factStatus = factRow?.object?.trim();
  if (factStatus) return factStatus;

  const cardRow = ctx.db
    .prepare(
      `SELECT card_json FROM character_cards
       WHERE novel_id = ? AND character_uid = ? AND as_of_chapter <= ?
       ORDER BY as_of_chapter DESC
       LIMIT 1`,
    )
    .get(ctx.novelId, characterUid, atChapter) as
    | { card_json: string }
    | undefined;
  if (!cardRow?.card_json) return null;
  try {
    const card = JSON.parse(cardRow.card_json) as FoldedCard;
    const vocab = loadStateVocabulary(ctx.projectRoot);
    const status = readPredicateFromCard(card, "status", vocab);
    if (status) return status;
    return readPredicateFromCard(card, "current_state", vocab);
  } catch {
    return null;
  }
}

export async function novelCharacterStatuses(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const rawUids = args["character_uids"];
  if (!Array.isArray(rawUids)) {
    return singleError(
      "character_uids",
      "string[]（角色 character_uid 列表）",
      describe(rawUids),
      "传入 character_uids 数组（取自角色档案 character_identity）",
    );
  }
  const atChapter = asPositiveInt(args["at_chapter"]) ?? latestChapter(ctx) ?? 1;

  // 去重 + 去空白，保持稳定（空列表合法，直接返回空 statuses）。
  const uids: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawUids) {
    if (typeof raw !== "string") continue;
    const uid = raw.trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    uids.push(uid);
  }

  const statuses: Record<string, string> = {};
  for (const uid of uids) {
    const status = readCharacterStatus(ctx, uid, atChapter);
    if (status) statuses[uid] = status;
  }

  return { ok: true, at_chapter: atChapter, statuses };
}

// ============================================================
// novel_relationship — 两个角色的关系（主体字典序归一）
// ============================================================

export async function novelRelationship(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const uidA = args["character_a_uid"];
  const uidB = args["character_b_uid"];
  if (typeof uidA !== "string" || !uidA.trim() || typeof uidB !== "string" || !uidB.trim()) {
    return singleError(
      "character_a_uid / character_b_uid",
      "两个非空 character_uid",
      `character_a_uid=${describe(uidA)}, character_b_uid=${describe(uidB)}`,
      "传入两个角色的 character_uid（取自角色档案 character_identity）",
    );
  }
  const a = uidA.trim();
  const b = uidB.trim();
  const at = asPositiveInt(args["at_chapter"]);

  const rows = ctx.db
    .prepare(
      `SELECT object, event_chapter, from_chapter, invalidated_at_chapter FROM facts
       WHERE novel_id = ? AND predicate = 'relationship'
         AND ((subject_character_uid = ? AND subject_character_b_uid = ?)
           OR (subject_character_uid = ? AND subject_character_b_uid = ?))${secretFilterClause(ctx)}
       ORDER BY ${FACT_LATEST_ORDER_SQL}`,
    )
    .all(ctx.novelId, a, b, b, a) as Array<{
    object: string;
    event_chapter: number | null;
    from_chapter: number;
    invalidated_at_chapter: number | null;
  }>;

  const current =
    at !== null
      ? rows.find((r) => isFactValidAt(r, at))
      : rows.find((r) => r.invalidated_at_chapter === null);

  return {
    ok: true,
    character_a_uid: a,
    character_b_uid: b,
    at_chapter: at ?? "latest",
    current_state: current?.object ?? null,
    history: rows.map((r) => ({
      state: r.object,
      from_chapter: r.from_chapter,
      invalidated_at_chapter: r.invalidated_at_chapter,
    })),
  };
}

// ============================================================
// novel_foreshadowing_status — 伏笔状态（从 actions_log 最新动作机械导出）
// ============================================================

type ForeshadowingDerivedStatus = "registered" | "planted" | "developing" | "revealed";

const STATUS_BY_ACTION: Record<string, ForeshadowingDerivedStatus> = {
  plant: "planted",
  develop: "developing",
  reveal: "revealed",
};

const ACTION_RANK: Record<string, number> = { plant: 1, develop: 2, reveal: 3 };

/** 每条伏笔截至 upTo 章的最新已兑现动作（同章取生命周期更靠后的动作） */
function latestRealizedActions(
  ctx: ToolContext,
  upTo: number | null,
): Map<string, { action: string; chapter: number }> {
  const rows = (
    upTo !== null
      ? ctx.db
          .prepare(
            `SELECT foreshadowing_id, chapter, action FROM foreshadowing_actions_log
             WHERE novel_id = ? AND status = 'realized' AND chapter <= ?
             ORDER BY chapter ASC`,
          )
          .all(ctx.novelId, upTo)
      : ctx.db
          .prepare(
            `SELECT foreshadowing_id, chapter, action FROM foreshadowing_actions_log
             WHERE novel_id = ? AND status = 'realized'
             ORDER BY chapter ASC`,
          )
          .all(ctx.novelId)
  ) as Array<{ foreshadowing_id: string; chapter: number; action: string }>;

  const latest = new Map<string, { action: string; chapter: number }>();
  for (const row of rows) {
    const existing = latest.get(row.foreshadowing_id);
    if (
      !existing ||
      row.chapter > existing.chapter ||
      (row.chapter === existing.chapter &&
        (ACTION_RANK[row.action] ?? 0) > (ACTION_RANK[existing.action] ?? 0))
    ) {
      latest.set(row.foreshadowing_id, { action: row.action, chapter: row.chapter });
    }
  }
  return latest;
}

export async function novelForeshadowingStatus(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const active = args["active"] as boolean | undefined;
  const chapter = asPositiveInt(args["chapter"]);

  const registry = ctx.db
    .prepare(
      `SELECT * FROM foreshadowing_registry WHERE novel_id = ? ORDER BY planted_chapter, id`,
    )
    .all(ctx.novelId) as ForeshadowingRegistryRow[];
  const latest = latestRealizedActions(ctx, chapter);

  const items = registry
    .map((row) => {
      const action = latest.get(row.id) ?? null;
      const status: ForeshadowingDerivedStatus = action
        ? (STATUS_BY_ACTION[action.action] ?? "registered")
        : "registered";
      return {
        id: row.id,
        type: row.type,
        description: row.description,
        planted_chapter: row.planted_chapter,
        target_reveal: row.target_reveal,
        theme_link: row.theme_link,
        latest_action: action,
        status,
      };
    })
    .filter((item) => {
      if (active === true) return item.status !== "revealed";
      if (active === false) return item.status === "revealed";
      return true;
    });

  return { ok: true, count: items.length, foreshadowing: items };
}

// ============================================================
// novel_foreshadowing_density — 伏笔计划兑现度（chapter / arc / volume）
// ============================================================

function buildDensityResult(
  scope: "chapter" | "arc" | "volume",
  scopeId: string | number,
  expected: number,
  actual: number,
) {
  let warning: string | null = null;
  if (expected > 0) {
    if (actual < expected * 0.8) warning = "density_below_target";
    else if (actual > expected * 1.5) warning = "density_above_target";
  }
  return {
    ok: true,
    scope,
    scope_id: scopeId,
    expected,
    actual,
    gap: actual - expected,
    warning,
  };
}

export async function novelForeshadowingDensity(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const chapter = asPositiveInt(args["chapter"]);
  const arcId = typeof args["arc_id"] === "string" ? (args["arc_id"] as string) : null;
  const volume = asPositiveInt(args["volume"]);

  const countByStatus = (start: number, end: number, status: "planned" | "realized") =>
    (
      ctx.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM foreshadowing_actions_log
           WHERE novel_id = ? AND chapter BETWEEN ? AND ? AND status = ?`,
        )
        .get(ctx.novelId, start, end, status) as { cnt: number }
    ).cnt;

  if (chapter !== null) {
    return buildDensityResult(
      "chapter",
      chapter,
      countByStatus(chapter, chapter, "planned"),
      countByStatus(chapter, chapter, "realized"),
    );
  }

  if (arcId !== null) {
    const arc = ctx.db
      .prepare(
        `SELECT chapter_start, chapter_end FROM arc_meta WHERE novel_id = ? AND arc_id = ?`,
      )
      .get(ctx.novelId, arcId) as
      | { chapter_start: number; chapter_end: number }
      | undefined;
    if (!arc) {
      return singleError(
        "arc_id",
        "已注册的 arc_id",
        arcId,
        "该 arc 不存在：先用 novel_get_arc 确认 arc_id，或先提交书级大纲",
      );
    }
    return buildDensityResult(
      "arc",
      arcId,
      countByStatus(arc.chapter_start, arc.chapter_end, "planned"),
      countByStatus(arc.chapter_start, arc.chapter_end, "realized"),
    );
  }

  if (volume !== null) {
    const range = getVolumeRange(ctx, volume);
    if (!range) return buildDensityResult("volume", volume, 0, 0);
    return buildDensityResult(
      "volume",
      volume,
      countByStatus(range.chapter_start, range.chapter_end, "planned"),
      countByStatus(range.chapter_start, range.chapter_end, "realized"),
    );
  }

  return singleError(
    "scope",
    "chapter / arc_id / volume 三选一",
    "全部缺失",
    "传入 chapter（章号）、arc_id 或 volume（卷号）之一",
  );
}

// ============================================================
// novel_get_arc — 按 arc_id 或章号查 arc 元信息与卷边界
// ============================================================

function arcResponse(ctx: ToolContext, row: ArcMetaRow, queriedChapter?: number) {
  const range = getVolumeRange(ctx, row.volume_no);
  const volumeEnd = range?.chapter_end ?? row.chapter_end;
  return {
    ok: true,
    found: true,
    ...(queriedChapter !== undefined
      ? {
          queried_chapter: queriedChapter,
          is_arc_end: queriedChapter === row.chapter_end,
          is_volume_end: queriedChapter === volumeEnd,
        }
      : {}),
    arc: {
      arc_id: row.arc_id,
      volume_no: row.volume_no,
      title: row.title,
      chapter_start: row.chapter_start,
      chapter_end: row.chapter_end,
      core_question: row.core_question,
      irreversible_change: row.irreversible_change,
      next_arc_seed: row.next_arc_seed,
      ...(row.antagonist_agent ? { antagonist_agent: row.antagonist_agent } : {}),
      payoff_beats: parseJsonArray(row.payoff_beats),
    },
    volume: {
      volume_no: row.volume_no,
      chapter_start: range?.chapter_start ?? row.chapter_start,
      chapter_end: range?.chapter_end ?? row.chapter_end,
    },
  };
}

export async function novelGetArc(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const arcId = typeof args["arc_id"] === "string" ? (args["arc_id"] as string) : null;
  const chapter = asPositiveInt(args["chapter"]);

  if (arcId !== null) {
    const row = ctx.db
      .prepare(`SELECT * FROM arc_meta WHERE novel_id = ? AND arc_id = ?`)
      .get(ctx.novelId, arcId) as ArcMetaRow | undefined;
    if (!row) return { ok: true, found: false, arc_id: arcId, message: "arc 不存在" };
    return arcResponse(ctx, row);
  }

  if (chapter !== null) {
    const row = getArcForChapter(ctx, chapter);
    if (!row) {
      return {
        ok: true,
        found: false,
        chapter,
        message: "该章不在任何已提交 arc 的区间内（可能已到规划末尾）",
      };
    }
    return arcResponse(ctx, row, chapter);
  }

  return singleError(
    "arc_id / chapter",
    "二选一",
    "全部缺失",
    "传入 arc_id（如 \"V01-A02\"）或 chapter（章号）之一",
  );
}

// ============================================================
// novel_check_prose_hygiene — 正文散文洁净门（去 AI 味，只读扫描）
// ============================================================

/**
 * 机械扫本章正文的 AI 腔马脚（破折号密度 + 「不是X是Y」对仗转折密度/连排），代码算不用 LLM。
 * 正文全程不经 MCP、历来无门；本工具 Read 正文 → 扫 → 返 errors[]+hint，供写手定点擦除
 * 自修正（与账房层同构的回路，落点在 /write 步骤 5 末尾）。只扫确定的机械对仗腔、不判文笔好坏。
 */
export async function novelCheckProseHygiene(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const chapter = asPositiveInt(args["chapter"]);
  if (chapter === null) {
    return singleError(
      "chapter",
      "正整数（被扫描的章节号）",
      describe(args["chapter"]),
      "传本章章号，例如 chapter: 12",
    );
  }
  if (!ctx.projectRoot) {
    return singleError(
      "projectRoot",
      "可用的项目根目录",
      "缺失",
      "NOVEL_CONFIG_PATH 未指向有效项目",
    );
  }

  const manuscript = await resolveWorkingManuscript(ctx.projectRoot, chapter);
  if (manuscript === null) {
    return singleError(
      "manuscript",
      "本章正文存在（草稿区或正式路径）",
      "未找到本章正文文件",
      "先完成正文生成（/write 步骤 3）再扫描散文洁净度",
    );
  }

  const text = await readFile(manuscript.path, "utf-8");
  const { errors, stats } = scanManuscriptProseHygiene(text);
  const reading = `破折号 ${stats.emDashPerKilo.toFixed(1)}/千字、「不是…是…」对仗 ${stats.antithesisPerKilo.toFixed(1)}/千字`;
  const fingerprintFindings = scanProseFingerprints(text);
  const shapeFindings = scanProseShape(text);

  if (errors.length > 0) {
    return {
      ok: false,
      chapter,
      errors,
      fingerprint_findings: fingerprintFindings,
      shape_findings: shapeFindings,
      message: `第 ${chapter} 章正文机械腔超标（${reading}）。按 errors[].hint 定点擦除后重扫。`,
    };
  }
  return {
    ok: true,
    chapter,
    fingerprint_findings: fingerprintFindings,
    shape_findings: shapeFindings,
    message: `第 ${chapter} 章正文散文洁净：${reading}，均在阈值内。`,
  };
}

// ============================================================
// novel_get_review — 审校路由信号（verdict + blockers）
// ============================================================

interface ReviewIssue {
  severity: "blocker" | "note";
  where: string;
  what: string;
  fix_hint: string;
}

export async function novelGetReview(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const chapter = asPositiveInt(args["chapter"]);
  if (chapter === null) {
    return singleError(
      "chapter",
      "integer ≥ 1",
      describe(args["chapter"]),
      "传入被审章节号（正整数）",
    );
  }

  const row = ctx.db
    .prepare(`SELECT * FROM chapter_reviews WHERE novel_id = ? AND chapter = ?`)
    .get(ctx.novelId, chapter) as ChapterReviewRow | undefined;
  if (!row) {
    return {
      ok: true,
      found: false,
      chapter,
      message: "该章尚无审校记录：先派发 continuity-editor 提交审校",
    };
  }

  let issues: ReviewIssue[] = [];
  try {
    const parsed = JSON.parse(row.issues_json) as unknown;
    if (Array.isArray(parsed)) issues = parsed as ReviewIssue[];
  } catch {
    // 损坏的 issues_json 按空清单处理（verdict 列仍有效）
  }

  return {
    ok: true,
    found: true,
    chapter,
    verdict: row.verdict,
    blockers: issues.filter((i) => i.severity === "blocker"),
    notes: issues.filter((i) => i.severity === "note"),
    created_at: row.created_at,
  };
}

// ============================================================
// novel_failed_reviews — 未过审章节清单（verdict=fail）
// ============================================================

export async function novelFailedReviews(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const rows = ctx.db
    .prepare(
      `SELECT chapter FROM chapter_reviews
       WHERE novel_id = ? AND verdict = 'fail'
       ORDER BY chapter ASC`,
    )
    .all(ctx.novelId) as Array<{ chapter: number }>;

  return {
    ok: true,
    failed_chapters: rows.map((row) => row.chapter),
    count: rows.length,
  };
}

// ============================================================
// novel_get_structure_budget — 结构预算表（读 config 篇幅参数）
// ============================================================

export async function novelGetStructureBudget(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  if (!ctx.estimatedTotalChapters || !ctx.wordsPerChapter) {
    return singleError(
      "config.yaml",
      "estimated_total_chapters 与 words_per_chapter 均已设置",
      `estimated_total_chapters=${ctx.estimatedTotalChapters ?? "缺失"}, words_per_chapter=${ctx.wordsPerChapter ?? "缺失"}`,
      "config.yaml 缺篇幅字段：先执行 /narracat:setup 收集预计总章数与每章字数",
    );
  }
  const budget = computeStructureBudget(ctx.estimatedTotalChapters, ctx.wordsPerChapter);
  return { ok: true, ...budget };
}

// ============================================================
// novel_list_structure_cards — 结构手法卡清单（按 stage 过滤，供 outline-architect
// 规划前按需 Read；卡内容不入 prompt 常驻，改弃硬编码路径列表）
// ============================================================

export async function novelListStructureCards(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const stage = args["stage"];
  if (typeof stage !== "string" || !STRUCTURE_STAGES.includes(stage as StructureStage)) {
    return singleError(
      "stage",
      `"${STRUCTURE_STAGES.join("\" | \"")}" 三选一`,
      describe(stage),
      "传入规划所处阶段：stage-1（书级 storylines/伏笔注册表/arc）/ stage-2（章级细纲）/ stage-opening（全书开局）",
    );
  }
  const pools = resolvePackPools(ctx.projectRoot);
  const stageCards = pools.structure.filter((s) => s.stage === stage);
  const notes = [...pools.notes];

  // 规划期装载回执（spec §6：structure 回执补账）：本次按 stage 返回的候选池落盘，
  // 让用户造的剧作卡「被规划阶段装载过」可见。写盘失败不得阻断本工具返回，fail-soft
  // 转 notes（见本文件 novelBuildWritingContextPack 内 writeCapabilityReceipt 调用点的同款容错）。
  try {
    writePlanningCapabilityReceipt(
      ctx.projectRoot,
      stage as StructureStage,
      stageCards.map(({ id, source_pack_id, source_pack_version, origin, dimension, one_line }) => ({
        card_id: id,
        pack_id: source_pack_id,
        pack_version: source_pack_version,
        origin,
        dimension,
        one_line,
      })),
    );
  } catch (err) {
    notes.push(`规划期装载回执写入失败：${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    stage: stage as StructureStage,
    cards: stageCards.map(({ id, path, dimension, one_line, origin }) => ({ id, path, dimension, one_line, origin })),
    notes,
  };
}

// ============================================================
// 上下文聚合共用区块（novel_writing_context 与 builder 共用）
// ============================================================

interface BriefForPack {
  chapter: number;
  summary: string;
  opening_snippet?: string;
  ending_snippet?: string;
  core_experience?: string;
  heartbeat_moment?: string;
  emotional_tone?: string;
  continuation_hook: string[];
}

/** L1 热层：前 3 章 ChapterBrief（升序；空字段省略不输出 null） */
function getPreviousBriefs(ctx: ToolContext, chapter: number): BriefForPack[] {
  const from = Math.max(1, chapter - 3);
  const to = chapter - 1;
  if (to < from) return [];
  const rows = ctx.db
    .prepare(
      `SELECT * FROM chapter_summaries
       WHERE novel_id = ? AND chapter BETWEEN ? AND ? ORDER BY chapter`,
    )
    .all(ctx.novelId, from, to) as SummaryRow[];
  return rows.map((row) => ({
    chapter: row.chapter,
    summary: row.summary,
    ...(row.opening_snippet ? { opening_snippet: row.opening_snippet } : {}),
    ...(row.ending_snippet ? { ending_snippet: row.ending_snippet } : {}),
    ...(row.anchor_core ? { core_experience: row.anchor_core } : {}),
    ...(row.anchor_heartbeat ? { heartbeat_moment: row.anchor_heartbeat } : {}),
    ...(row.emotional_tone ? { emotional_tone: row.emotional_tone } : {}),
    continuation_hook: parseJsonArray(row.continuation_hook),
  }));
}

const RECENT_ENDING_CHARS = 500;

/**
 * 最近一章的逐字结尾从正文文件现读（比入库时截取的 200 字快照长）：
 * 清洗逻辑（含剥离 chapter_metadata 注释）收敛于 state-sync.ts 的 extractManuscriptSnippets，
 * 与 writers.ts 收尾入库时的快照截取同一实现，避免两处口径漂移。
 * 老书无需回填即受益；文件读不到就保持快照，不报错也不进 warnings（写手对此无从处理）。
 */
async function widenLatestEndingSnippet(ctx: ToolContext, briefs: BriefForPack[]): Promise<void> {
  const latest = briefs[briefs.length - 1];
  if (!latest) return;
  try {
    const path = await findChapterManuscriptFile(ctx.projectRoot, latest.chapter);
    if (path === null) return;
    const raw = await readFile(path, "utf-8");
    const { ending } = extractManuscriptSnippets(raw, { endingChars: RECENT_ENDING_CHARS });
    if (!ending) return;
    latest.ending_snippet = ending;
  } catch {
    // 读不到就用快照
  }
}

const AUTO_SAMPLE_MIN_CHARS = 80;
const AUTO_SAMPLE_MAX_CHARS = 400;

function anchorNote(chapter: number): string {
  return `本书第 ${chapter} 章已定稿段落，作者选定为本书声音基准——句子长短、说话方式、叙述距离照这一段来（学语感，不抄内容）。`;
}

function autoSampleNote(chapter: number): string {
  return `本书第 ${chapter} 章已定稿开头（系统自动取样，非作者选定）——可作本书语感参考。`;
}

/**
 * 章节标题行判据：chapter-writer 的正文契约里标题行是可选的（"可含章节标题行"，非强制
 * `# ` 前缀），App 正文编辑器又是自由文本框、零格式校验——真实正文完全可能出现「第N章…」
 * 这类标题但没有 `#` 前缀（作者手改/旧版本遗留）。只判 `#` 前缀会漏判，把标题当正文开场
 * 段取样，语感基准会被一句标题污染。故双重判据：`#` 前缀 或「第…章/卷/回/节」标题词形。
 */
const CHAPTER_TITLE_LINE = /^#{0,6}\s*第[0-9〇零一二三四五六七八九十百千]+[章卷回节]/;

function isChapterTitleLine(line: string): boolean {
  return line.startsWith("#") || CHAPTER_TITLE_LINE.test(line);
}

/**
 * 该章是否已收尾入库：chapter_summaries 有该章记录，等价于「已过审校 + 洁净门 + 重缝的成稿」
 * ——novel_commit_chapter 是这张表唯一写入口，写入前已跑过 checkReviewFreshness（记忆写入门）。
 * 未收尾章可能是失败中断留下的残稿，不得当本书语感基准。也供 style-anchor.ts 的作者标记判据复用
 * （作者标记只看「已收尾」这一档，不叠加下面的审校新鲜度严档——见该文件头注）。
 */
export function isChapterCommitted(ctx: ToolContext, chapter: number): boolean {
  return (
    ctx.db
      .prepare(`SELECT 1 FROM chapter_summaries WHERE novel_id = ? AND chapter = ? LIMIT 1`)
      .get(ctx.novelId, chapter) !== undefined
  );
}

/**
 * 自动兜底取样：最近一章已收尾正文的开场段（跳过标题行；不足下限则并入下一段；超上限截断）。
 *
 * 比作者手动标记（isChapterCommitted 即可）多叠一道 checkReviewFreshness 严档
 * （requireReview=true）：这一段是系统替作者做的默认选择，标准该高于作者主动认可；若正文在
 * 审校通过后又被手改/外部工具改写过，指纹不匹配即跳过，顺延更早章。刀 1 之前的老章审校记录
 * 无指纹，同样会被判不新鲜——都取不到就顺延到窗口耗尽，最终由 buildBookVoiceExamples 退回纯
 * 跨书范例（等价于本功能上线前的现状，可接受的降级，不抛错）。
 */
async function pickAutoVoiceSample(
  ctx: ToolContext,
  chapter: number,
): Promise<{ chapter: number; excerpt: string } | null> {
  for (let prev = chapter - 1; prev >= 1 && prev >= chapter - 3; prev -= 1) {
    if (!isChapterCommitted(ctx, prev)) continue;
    if ((await checkReviewFreshness(ctx, prev, true)) !== null) continue;
    const path = await findChapterManuscriptFile(ctx.projectRoot, prev);
    if (path === null) continue;
    const content = await readFile(path, "utf-8");
    const paragraphs = content
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !isChapterTitleLine(p));
    let buffer = "";
    for (const para of paragraphs) {
      buffer = buffer ? `${buffer}\n${para}` : para;
      if (Array.from(buffer).length >= AUTO_SAMPLE_MIN_CHARS) break;
    }
    const chars = Array.from(buffer);
    if (chars.length < AUTO_SAMPLE_MIN_CHARS) continue;
    return { chapter: prev, excerpt: chars.slice(0, AUTO_SAMPLE_MAX_CHARS).join("") };
  }
  return null;
}

/**
 * 本书声音段：作者标记优先（最新 2 段），无标记时按开关自动取样 1 段。
 * 锚表读取异常（规格 §4.6）不得让整个 WCP 组装抛错断链：退回纯跨书范例（不进 anchors、
 * 也不尝试自动取样），异常原因写进 buildNotes（系统诊断通道，不进包、不刷写手注意力）。
 */
async function buildBookVoiceExamples(
  ctx: ToolContext,
  chapter: number,
  buildNotes: string[],
): Promise<Array<{ excerpt: string; mechanism_note: string }>> {
  let anchors: ReturnType<typeof listStyleAnchorRows>;
  try {
    anchors = listStyleAnchorRows(ctx).slice(0, 2);
  } catch (err) {
    buildNotes.push(
      `样章锚表读取失败，本次退回纯跨书范例：${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (anchors.length > 0) {
    return anchors.map((a) => ({ excerpt: a.excerpt, mechanism_note: anchorNote(a.chapter) }));
  }
  // 默认关闭（口径与 config 解析一致）：只有显式 style_anchor_auto_fallback: true 才自动取样，
  // 否则无作者样章时退回纯跨书范例——不让写手学 AI 自己上一章的句法（见 config.ts 注释的实测数据）
  if (ctx.styleAnchorAutoFallback !== true) return [];
  const auto = await pickAutoVoiceSample(ctx, chapter);
  return auto ? [{ excerpt: auto.excerpt, mechanism_note: autoSampleNote(auto.chapter) }] : [];
}

interface ArcSummaryForPack {
  scope: "arc" | "volume";
  scope_id: string;
  chapter_start: number;
  chapter_end: number;
  summary: string;
}

/** L2 温层：各前卷摘要 + 本卷已完成 arc 摘要（升序） */
function getArcSummariesForPack(
  ctx: ToolContext,
  chapter: number,
  currentVolume: number | null,
): ArcSummaryForPack[] {
  const rows = ctx.db
    .prepare(
      `SELECT * FROM arc_summaries
       WHERE novel_id = ? AND chapter_end < ? ORDER BY chapter_start`,
    )
    .all(ctx.novelId, chapter) as ArcSummaryRow[];

  const arcVolume = new Map<string, number>();
  if (currentVolume !== null) {
    const arcs = ctx.db
      .prepare(`SELECT arc_id, volume_no FROM arc_meta WHERE novel_id = ?`)
      .all(ctx.novelId) as Array<{ arc_id: string; volume_no: number }>;
    for (const a of arcs) arcVolume.set(a.arc_id, a.volume_no);
  }

  return rows
    .filter((row) => {
      if (row.scope === "volume") return true;
      // arc 摘要只取本卷的（前卷细节由卷摘要承载）
      if (currentVolume === null) return true;
      return arcVolume.get(row.scope_id) === currentVolume;
    })
    .map((row) => ({
      scope: row.scope,
      scope_id: row.scope_id,
      chapter_start: row.chapter_start,
      chapter_end: row.chapter_end,
      summary: row.summary,
    }));
}

interface CharacterCardForPack {
  character: string;
  as_of_chapter: number;
  card: Record<string, string>;
}

/**
 * 本章出场、但状态卡没随包给出的角色（issue #48）。包是子 agent 的全部世界——审校读的是包
 * 文件，看不到只回给主会话的 buildNotes，此前它连「少了人」都不知道，只能靠猜文件路径找补。
 * 名单在此保持完整，缺口点名到人并带上 novel_character_state 唯一认的 character_uid。
 */
interface CharacterWithoutCard {
  character: string;
  character_uid?: string;
  reason: "尚无状态记录" | "状态卡超预算未随包给出";
}

/** 从 chapter_summaries.characters 的 CharacterReference[] JSON 提 {uid, name}（无 uid 项跳过） */
function parseCharacterRefs(
  raw: string | null | undefined,
): Array<{ uid: string; name: string }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: Array<{ uid: string; name: string }> = [];
    for (const ref of parsed) {
      const uid =
        ref && typeof ref === "object"
          ? (ref as { character_uid?: unknown }).character_uid
          : undefined;
      if (typeof uid === "string" && uid.trim()) {
        const nm = (ref as { name?: unknown }).name;
        out.push({
          uid: uid.trim(),
          name: typeof nm === "string" && nm.trim() ? nm.trim() : uid.trim(),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 角色状态卡（按 uid）：优先实时折叠 facts，无事实时回落 arc 收尾刷新的存量卡 */
function getCharacterCardsForPack(
  ctx: ToolContext,
  characters: Array<{ uid: string; name: string }>,
  asOfChapter: number,
): CharacterCardForPack[] {
  const cards: CharacterCardForPack[] = [];
  for (const { uid, name } of characters) {
    const folded = foldCharacterCard(ctx, uid, asOfChapter);
    if (!isEmptyFoldedCard(folded)) {
      cards.push({ character: name, as_of_chapter: asOfChapter, card: renderCardHumanMap(folded) });
      continue;
    }
    // 双保险（PR#452评审P1-B）：存量卡回落不得吐出比请求时点更靠未来的卡——
    // as_of_chapter 记录该卡最后一次折叠时看到的章节，若晚于本次请求时点，卡内可能已
    // 折进「尚未发生」的状态（如未来 effective_chapter 的状态提交），继续用会把未来事实
    // 泄露进当前上下文。折叠新鲜时（!isEmptyFoldedCard 命中）不经此路径，只兜底折叠为空
    // 且存量卡陈旧/超前的场景。
    const stored = ctx.db
      .prepare(
        `SELECT * FROM character_cards WHERE novel_id = ? AND character_uid = ? AND as_of_chapter <= ?`,
      )
      .get(ctx.novelId, uid, asOfChapter) as CharacterCardRow | undefined;
    if (!stored) continue;
    try {
      const card = JSON.parse(stored.card_json) as FoldedCard;
      if (card && typeof card === "object" && !isEmptyFoldedCard(card)) {
        cards.push({
          character: name,
          as_of_chapter: stored.as_of_chapter,
          card: renderCardHumanMap(card),
        });
      }
    } catch {
      // 损坏的卡片跳过
    }
  }
  return cards;
}

interface CharacterRelationshipForPack {
  character_a: string;
  character_b: string;
  current_state: string;
  from_chapter: number;
}

/**
 * 角色关系（本章涉及角色两两之间的当前关系）：查 facts predicate='relationship'，
 * 取每对截至 asOfChapter 仍有效的最新状态。关系已按字典序归一存储（subject_character_uid
 * = 字典序小者），故 (a_uid,b_uid) 对唯一，首条即最新。无关系的对不产出。
 */
function getCharacterRelationshipsForPack(
  ctx: ToolContext,
  characters: Array<{ uid: string; name: string }>,
  asOfChapter: number,
): CharacterRelationshipForPack[] {
  if (characters.length < 2) return [];
  const nameByUid = new Map(characters.map((c) => [c.uid, c.name]));
  const uids = [...nameByUid.keys()];
  const placeholders = uids.map(() => "?").join(", ");
  const rows = ctx.db
    .prepare(
      `SELECT subject_character_uid AS a_uid, subject_character_b_uid AS b_uid, object, from_chapter
       FROM facts
       WHERE novel_id = ? AND predicate = 'relationship'
         AND subject_character_uid IN (${placeholders})
         AND subject_character_b_uid IN (${placeholders})
         AND ${FACT_VALID_AT_SQL}
       ORDER BY ${FACT_LATEST_ORDER_SQL}`,
    )
    .all(ctx.novelId, ...uids, ...uids, asOfChapter, asOfChapter) as Array<{
    a_uid: string;
    b_uid: string;
    object: string;
    from_chapter: number;
  }>;

  const seen = new Set<string>();
  const relationships: CharacterRelationshipForPack[] = [];
  for (const row of rows) {
    const key = `${row.a_uid}|${row.b_uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const nameA = nameByUid.get(row.a_uid);
    const nameB = nameByUid.get(row.b_uid);
    if (!nameA || !nameB) continue;
    relationships.push({
      character_a: nameA,
      character_b: nameB,
      current_state: row.object,
      from_chapter: row.from_chapter,
    });
  }
  relationships.sort(
    (l, r) =>
      l.character_a.localeCompare(r.character_a, "zh") ||
      l.character_b.localeCompare(r.character_b, "zh"),
  );
  return relationships;
}

interface ForeshadowingDueItem {
  id: string;
  type: "small" | "medium" | "major";
  description: string;
  planted_chapter?: number;
  target_reveal?: string;
}

interface ForeshadowingDue {
  due: ForeshadowingDueItem[];
  others_count: number;
}

/**
 * 从本章细纲全文提取『伏笔动作』显式引用的伏笔 id（spec §4.1 P1 后半句）。
 * registry id 形如 F-SWORD-CORE / S-HERB / F-MAJ-01：大写字母/数字段，连字符分隔。
 * 正则刻意放宽——细纲全文里不在 registry 里的巧合 id 自然在 getForeshadowingDue 里匹配不上
 * 任何行，无害；只用于白名单穿透，不用于其他判定。
 */
export function extractReferencedForeshadowingIds(chapterOutlineText: string): string[] {
  const matches = chapterOutlineText.match(/[A-Z]-[A-Z0-9]+(?:-[A-Z0-9]+)*/g) ?? [];
  return [...new Set(matches)];
}

/**
 * 伏笔 due-list 过滤：major 全部 + medium 限本卷 + small 限本 arc
 * + target_reveal ≤ 本章+10 的临期项；其余活跃伏笔只计数。
 * 未种下（planted_chapter 晚于目标章）的条目整体排除——不进 due 也不进计数，
 * 除非其 id 出现在 referencedIds 白名单（本章细纲『伏笔动作』显式引用，spec §4.1 P1 后半句：
 * 架构师既然在细纲里点名要用，写手就该看到，不该被「未种下」的机械过滤挡在外面）。
 */
export function getForeshadowingDue(
  ctx: ToolContext,
  chapter: number,
  arc: ArcMetaRow | undefined,
  volumeRange: { chapter_start: number; chapter_end: number } | null,
  currentVolume: number | null,
  referencedIds: string[] = [],
): ForeshadowingDue {
  const registry = ctx.db
    .prepare(
      `SELECT * FROM foreshadowing_registry WHERE novel_id = ? ORDER BY planted_chapter, id`,
    )
    .all(ctx.novelId) as ForeshadowingRegistryRow[];
  const latest = latestRealizedActions(ctx, null);

  const within = (
    value: number | null,
    range: { chapter_start: number; chapter_end: number } | null,
  ) =>
    value !== null &&
    range !== null &&
    value >= range.chapter_start &&
    value <= range.chapter_end;

  const numericTarget = (target: string | null): number | null => {
    if (!target) return null;
    return /^[1-9][0-9]*$/.test(target) ? parseInt(target, 10) : null;
  };
  const volumeTarget = (target: string | null): number | null => {
    const m = target?.match(/^vol-0*(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  };

  const arcRange = arc
    ? { chapter_start: arc.chapter_start, chapter_end: arc.chapter_end }
    : null;

  const active = registry.filter(
    (row) => latest.get(row.id)?.action !== "reveal",
  );
  // spec §4.1 P1：未种下（planted_chapter 晚于目标章）的伏笔是未来计划，
  // 不进 due 也不进计数——写手不该看到还没发生的秘密（剧透 + 催兑现双重污染）。
  // planted_chapter 可空时保守放行（视为已存在）。
  const planted = active.filter(
    (row) =>
      row.planted_chapter === null ||
      row.planted_chapter <= chapter ||
      referencedIds.includes(row.id),
  );
  const due = planted.filter((row) => {
    if (row.type === "major") return true;
    const target = numericTarget(row.target_reveal);
    if (target !== null && target <= chapter + 10) return true;
    if (row.type === "medium") {
      return (
        within(row.planted_chapter, volumeRange) ||
        within(target, volumeRange) ||
        (currentVolume !== null && volumeTarget(row.target_reveal) === currentVolume)
      );
    }
    return within(row.planted_chapter, arcRange) || within(target, arcRange);
  });

  return {
    due: due.map((row) => ({
      id: row.id,
      type: row.type,
      description: row.description,
      ...(row.planted_chapter !== null ? { planted_chapter: row.planted_chapter } : {}),
      ...(row.target_reveal !== null ? { target_reveal: row.target_reveal } : {}),
    })),
    others_count: planted.length - due.length,
  };
}

// ============================================================
// through_line_anchor — 全书贯穿线常驻层（WCP 区块 4.5）
//
// 远卷不丢的根治：L2 arc_summaries 是卷级滚动窗（远卷被 shift 丢弃），
// 而全书核心线（身世/宿敌/中心戏剧问题）是结构承诺，应独立常驻、永不滚动。
// 三类来源全部 authored（novel_submit_outline 写入），零 LLM 臆断：
//   - engine_fields: facts WHERE subject='全书' 的 5 个引擎字段
//   - through_storylines: storylines WHERE is_through_line=1 AND status!='resolved'
//   - core_foreshadowing: foreshadowing_registry WHERE type='major' 且未 reveal
// ============================================================

const ENGINE_FACT_PREDICATES = [
  "central_dramatic_question",
  "protagonist_core_desire",
  "protagonist_core_lack",
  "antagonistic_force",
  "stakes_progression",
] as const;

interface ThroughLineAnchor {
  engine_fields: Array<{ key: string; value: string }>;
  through_storylines: Array<{ id: string; name: string; type: StorylineRow["type"] }>;
  core_foreshadowing: Array<{
    id: string;
    description: string;
    planted_chapter?: number;
    target_reveal?: string;
  }>;
}

function getThroughLineAnchor(ctx: ToolContext, chapter: number): ThroughLineAnchor {
  // 引擎 5 字段：subject='全书' 的有效 facts，每谓词取最新一条
  const engine_fields: Array<{ key: string; value: string }> = [];
  for (const predicate of ENGINE_FACT_PREDICATES) {
    const row = ctx.db
      .prepare(
        `SELECT object FROM facts
         WHERE novel_id = ? AND subject = '全书' AND predicate = ?
           AND invalidated_at_chapter IS NULL
         ORDER BY COALESCE(event_chapter, from_chapter) DESC, updated_at DESC LIMIT 1`,
      )
      .get(ctx.novelId, predicate) as { object: string } | undefined;
    if (row && row.object.trim()) engine_fields.push({ key: predicate, value: row.object });
  }

  // 贯穿故事线：作者标注、未收线
  const through_storylines = (
    ctx.db
      .prepare(
        `SELECT id, name, type FROM storylines
         WHERE novel_id = ? AND is_through_line = 1 AND status != 'resolved'
         ORDER BY priority, id`,
      )
      .all(ctx.novelId) as Array<{ id: string; name: string; type: StorylineRow["type"] }>
  ).map((r) => ({ id: r.id, name: r.name, type: r.type }));

  // 核心 major 伏笔：豁免距离/临期衰减，已种下且未 reveal 的全部进常驻层。
  // 与 foreshadowing_due 的关系：due 与此处都对 planted_chapter 做同款过滤
  // （未种下的伏笔是未来计划，写手不该看到——剧透 + 催兑现双重污染）；
  // 二者意图不同——due-list 是「本章可兑现/须留意」（含临期/区间规则），
  // core_foreshadowing 是「全书核心线常驻、不随兑现节奏或卷/arc 窗口滚动」，
  // 覆盖面更广（已种下的 major 全集，不限临期）。
  const latest = latestRealizedActions(ctx, null);
  const core_foreshadowing = (
    ctx.db
      .prepare(
        `SELECT id, description, planted_chapter, target_reveal FROM foreshadowing_registry
         WHERE novel_id = ? AND type = 'major' ORDER BY planted_chapter, id`,
      )
      .all(ctx.novelId) as ForeshadowingRegistryRow[]
  )
    .filter((row) => row.planted_chapter === null || row.planted_chapter <= chapter)
    .filter((row) => latest.get(row.id)?.action !== "reveal")
    .map((row) => ({
      id: row.id,
      description: row.description,
      ...(row.planted_chapter !== null ? { planted_chapter: row.planted_chapter } : {}),
      ...(row.target_reveal !== null ? { target_reveal: row.target_reveal } : {}),
    }));

  return { engine_fields, through_storylines, core_foreshadowing };
}

interface StorylineFocusItem {
  id: string;
  name: string;
  type: StorylineRow["type"];
}

function getStorylineFocus(ctx: ToolContext, chapter: number): StorylineFocusItem[] {
  return ctx.db
    .prepare(
      `SELECT s.id, s.name, s.type
       FROM chapter_storyline_focus f
       JOIN storylines s ON s.novel_id = f.novel_id AND s.id = f.storyline_id
       WHERE f.novel_id = ? AND f.chapter = ?
       ORDER BY s.priority, s.id`,
    )
    .all(ctx.novelId, chapter) as StorylineFocusItem[];
}

const STORYLINE_ABSENCE_GAP = 5;

/** storyline 缺席预警：某条活跃线连续 ≥5 章无 focus（含本章） */
function getStorylineAbsenceWarnings(ctx: ToolContext, chapter: number): string[] {
  const warnings: string[] = [];
  const storylines = ctx.db
    .prepare(
      `SELECT * FROM storylines
       WHERE novel_id = ? AND status = 'active' AND entry_chapter <= ?
       ORDER BY priority, id`,
    )
    .all(ctx.novelId, chapter) as StorylineRow[];

  for (const sl of storylines) {
    const focusedNow = ctx.db
      .prepare(
        `SELECT 1 FROM chapter_storyline_focus
         WHERE novel_id = ? AND chapter = ? AND storyline_id = ?`,
      )
      .get(ctx.novelId, chapter, sl.id);
    if (focusedNow) continue;

    const last = (
      ctx.db
        .prepare(
          `SELECT MAX(chapter) AS c FROM chapter_storyline_focus
           WHERE novel_id = ? AND storyline_id = ? AND chapter < ?`,
        )
        .get(ctx.novelId, sl.id, chapter) as { c: number | null }
    ).c;

    const gap = last !== null ? chapter - last : chapter - sl.entry_chapter + 1;
    if (gap >= STORYLINE_ABSENCE_GAP) {
      warnings.push(
        `故事线 ${sl.id}「${sl.name}」已连续 ${gap} 章未聚焦` +
          (last !== null ? `（上次第 ${last} 章）` : "（入场后从未聚焦）") +
          "，可在本章用一次间接提及让读者知道它还活着",
      );
    }
  }
  return warnings;
}

// ============================================================
// novel_writing_context — 主会话轻量上下文聚合
// ============================================================

export async function novelWritingContext(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const chapter = asPositiveInt(args["chapter"]);
  if (chapter === null) {
    return singleError(
      "chapter",
      "integer ≥ 1",
      describe(args["chapter"]),
      "传入即将撰写的章节号（正整数）",
    );
  }

  const arc = getArcForChapter(ctx, chapter);
  const volumeRange = arc ? getVolumeRange(ctx, arc.volume_no) : null;
  const briefs = getPreviousBriefs(ctx, chapter);

  const characters = new Map<string, { uid: string; name: string }>();
  for (const brief of briefs) {
    const row = ctx.db
      .prepare(
        `SELECT characters FROM chapter_summaries WHERE novel_id = ? AND chapter = ?`,
      )
      .get(ctx.novelId, brief.chapter) as { characters: string } | undefined;
    for (const ref of parseCharacterRefs(row?.characters)) characters.set(ref.uid, ref);
  }

  // 伏笔白名单：与 WCP builder 同构——本章细纲结构化 foreshadowing_touch 优先，
  // .json 缺失/解析失败（旧书）或本章尚未细化时回退全文正则兜底
  let referencedForeshadowingIds: string[] = [];
  if (ctx.projectRoot) {
    const outlinePath = await findChapterOutlineFile(ctx.projectRoot, chapter);
    if (outlinePath) {
      const { text, touchIds } = await readChapterOutlineForPack(ctx, outlinePath);
      referencedForeshadowingIds = touchIds ?? extractReferencedForeshadowingIds(text);
    }
  }

  return {
    ok: true,
    target_chapter: chapter,
    arc: arc
      ? {
          arc_id: arc.arc_id,
          volume_no: arc.volume_no,
          title: arc.title,
          chapter_start: arc.chapter_start,
          chapter_end: arc.chapter_end,
          core_question: arc.core_question,
        }
      : null,
    previous_chapter_briefs: briefs,
    character_cards: getCharacterCardsForPack(
      ctx,
      [...characters.values()],
      Math.max(1, chapter - 1),
    ),
    foreshadowing_due: getForeshadowingDue(
      ctx,
      chapter,
      arc,
      volumeRange,
      arc?.volume_no ?? null,
      referencedForeshadowingIds,
    ),
    storyline_focus: getStorylineFocus(ctx, chapter),
  };
}

// ============================================================
// novel_build_writing_context_pack — WritingContextPack builder
// ============================================================

/** token 估算：CJK 字符按 1、其余按 0.3 */
function estimateTokens(text: string): number {
  let total = 0;
  for (const ch of text) {
    total += ch.charCodeAt(0) > 0x2e80 ? 1 : 0.3;
  }
  return Math.ceil(total);
}

function estimateBlockTokens(block: unknown): number {
  try {
    return estimateTokens(JSON.stringify(block));
  } catch {
    return 0;
  }
}

/** 字符串硬截断到 token 预算内 */
function truncateToBudget(text: string, budget: number): string {
  let result = text;
  while (result.length > 0 && estimateTokens(result) > budget) {
    result = result.slice(0, Math.floor(result.length * 0.9));
  }
  return result;
}

// 各区块独立 token 预算（中文≈1 token/字）。包总占用实测仅用到总额约 44%，
// 但 style_examples / foreshadowing_due / through_line_anchor 长期顶格被截断——
// 故把这三块的预算抬到能装下目标内容（用闲置余量补，总额仍远低于实际用量）：
// - style_examples 1200→2000：3 段范例实测最大 1460，1200 下 43% 章节被砍成 2 段，
//   抬到 2000 让 3 段稳定容纳、并给番茄向新范例留余量
// - through_line_anchor 400→600：常驻锚（引擎字段/核心伏笔，设计上「永不丢弃」）
//   在 400 下连引擎字段都被截断，抬高以保住全书贯穿线
// - foreshadowing_due 500→800：减少把待兑现伏笔压成纯计数，让写手看到更多伏笔内容
// previous_chapter_briefs 2000→2600：最近一章的逐字结尾从 200 字加到 500 字（开章接得住前章质感）
const BLOCK_BUDGETS = {
  chapter_outline: 3000,
  world_rules: 700,
  style_directive: 800,
  style_examples: 2000,
  previous_chapter_briefs: 2600,
  through_line_anchor: 600,
  arc_summaries: 1600,
  character_cards: 1500,
  planned_state_changes: 400,
  character_relationships: 500,
  derived_relationships: 300,
  foreshadowing_due: 800,
  storyline_focus: 300,
  semantic_context: 800,
} as const;

const TOTAL_BUDGET = 12000;

/** 在 outline/vol-VV/ch-NNN.{ext} 中定位指定章号的细纲文件（默认 md；电压点判据直读 json） */
async function findChapterOutlineFile(
  projectRoot: string,
  chapter: number,
  extension: "md" | "json" = "md",
): Promise<string | null> {
  const padded = chapterFileSegment(chapter);
  const outlineDir = join(projectRoot, "outline");
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(outlineDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const volumeDirs = entries
    .filter((e) => e.isDirectory() && /^vol-\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "en"));
  for (const dir of volumeDirs) {
    const filePath = join(outlineDir, dir, `ch-${padded}.${extension}`);
    try {
      await access(filePath);
      return filePath;
    } catch {
      // 该卷无此章，继续
    }
  }
  return null;
}

/** 在 manuscript/vol-VV/ch-NNN.md 中定位指定章号的正文文件（与细纲同构的按卷扫描） */
export async function findChapterManuscriptFile(
  projectRoot: string,
  chapter: number,
): Promise<string | null> {
  const padded = chapterFileSegment(chapter);
  const manuscriptDir = join(projectRoot, "manuscript");
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(manuscriptDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const volumeDirs = entries
    .filter((e) => e.isDirectory() && /^vol-\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "en"));
  for (const dir of volumeDirs) {
    const filePath = join(manuscriptDir, dir, `ch-${padded}.md`);
    try {
      await access(filePath);
      return filePath;
    } catch {
      // 该卷无此章，继续
    }
  }
  return null;
}

export interface ChapterOutlineForPack {
  text: string;
  /** 结构化 foreshadowing_touch[].id 去重；.json 缺失/解析失败（旧书）时为 null，消费方回退正则 */
  touchIds: string[] | null;
}

/**
 * 章纲文本 + 结构化伏笔引用：优先从结构化 ch-NNN.json 现渲染（反映最新提交），.md 仅作兼容回退。
 * 重提已有章时 .md 受保护不覆盖会变陈旧，直接读 md 会让写手丢掉 payoff_beat 等重提后才补的字段；
 * 从 .json 现渲染则与 App 展示、与最新提交一致。旧书无 .json 或解析失败时回退读 .md，
 * touchIds 为 null——消费方用 `touchIds ?? extractReferencedForeshadowingIds(text)` 兜底走正则。
 */
async function readChapterOutlineForPack(
  ctx: ToolContext,
  mdPath: string,
): Promise<ChapterOutlineForPack> {
  const jsonPath = mdPath.replace(/\.md$/, ".json");
  try {
    const ch = JSON.parse(await readFile(jsonPath, "utf-8")) as ChapterOutlineItem;
    const storylineNames = new Map(
      (
        ctx.db
          .prepare(`SELECT id, name FROM storylines WHERE novel_id = ?`)
          .all(ctx.novelId) as Array<{ id: string; name: string }>
      ).map((r) => [r.id, r.name]),
    );
    const foreshadowingDescriptions = new Map(
      (
        ctx.db
          .prepare(`SELECT id, description FROM foreshadowing_registry WHERE novel_id = ?`)
          .all(ctx.novelId) as Array<{ id: string; description: string }>
      ).map((r) => [r.id, r.description]),
    );
    const touchIds = [
      ...new Set(
        (ch.foreshadowing_touch ?? [])
          .map((t) => t.id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    return {
      text: renderChapterOutlineMarkdown(ch, { storylineNames, foreshadowingDescriptions }),
      touchIds,
    };
  } catch {
    // .json 缺失（旧书）或解析失败 → 回退读机械渲染的 .md，touchIds 交给消费方走正则兜底
    return { text: await readFile(mdPath, "utf-8"), touchIds: null };
  }
}

export interface ParsedRenderedOutline {
  dramatic_focus: string | null;
  characters: string[];
  pressure_points: string[];
}

/** 解析机械渲染的细纲（格式由 novel_submit_chapter_outline 渲染器保证）。
 *  新格式（含「## 场景骨架」）从编号 beats 取 pressure_points、从「## 本章定位」取 dramatic_focus；
 *  旧格式保留原「- 戏剧焦点 / - 压力点」逻辑。出场角色两格式通用（renderer 新旧都渲 `- 出场角色:`）。 */
export function parseRenderedOutline(text: string): ParsedRenderedOutline {
  const isNew = text.includes("## 场景骨架");
  // 出场角色：两格式通用
  const characters = new Set<string>();
  for (const m of text.matchAll(/^- 出场角色[:：]\s*(.+)$/gm)) {
    for (const name of m[1].split(/[、,，]/)) {
      const trimmed = name.trim();
      if (trimmed) characters.add(trimmed);
    }
  }
  if (isNew) {
    const pressurePoints: string[] = [];
    // 取「## 场景骨架」与下一个「## 」之间的编号行作压力点种子
    const sec = text.split(/^## 场景骨架\s*$/m)[1]?.split(/^## /m)[0] ?? "";
    for (const m of sec.matchAll(/^\d+\.\s+(.+)$/gm)) {
      const trimmed = m[1].trim();
      if (trimmed) pressurePoints.push(trimmed);
    }
    const posSec = text.split(/^## 本章定位\s*$/m)[1]?.split(/^## /m)[0]?.trim() ?? "";
    return {
      dramatic_focus: posSec || null,
      characters: [...characters],
      pressure_points: pressurePoints,
    };
  }
  // 旧格式：原有逻辑
  const focusMatch = text.match(/^- 戏剧焦点[:：]\s*(.+)$/m);
  const pressurePoints: string[] = [];
  for (const m of text.matchAll(/^- 压力点[:：]\s*(.+)$/gm)) {
    const trimmed = m[1].trim();
    if (trimmed) pressurePoints.push(trimmed);
  }
  return {
    dramatic_focus: focusMatch ? focusMatch[1].trim() : null,
    characters: [...characters],
    pressure_points: pressurePoints,
  };
}

const NARRATOR_KEYS = [
  "archetype",
  "tone",
  "pacing",
  "ornamentation",
  "digression",
  "address",
  "style_keywords",
] as const;

/** 从 bible/premise.md 的「叙述声音」立项卡读英文 key: value 数据 */
async function readNarratorVoice(
  projectRoot: string,
): Promise<Map<string, string> | null> {
  let content: string;
  try {
    content = await readFile(join(projectRoot, "bible", "premise.md"), "utf-8");
  } catch {
    return null;
  }
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) =>
    /^#{2,4}\s*.*(叙述声音|叙述者腔调)/.test(line.trim()),
  );
  if (start === -1) return null;
  const headingLevel = (lines[start].match(/^#+/) ?? ["##"])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= headingLevel) {
      end = i;
      break;
    }
  }
  const values = new Map<string, string>();
  for (const line of lines.slice(start + 1, end)) {
    const kv = line.match(/^[\s>*-]*(?:\*\*)?([a-z_]+)(?:\*\*)?\s*[:：]\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (
      value &&
      (NARRATOR_KEYS as readonly string[]).includes(key) &&
      !values.has(key)
    ) {
      values.set(key, value);
    }
  }
  return values.size > 0 ? values : null;
}

/**
 * 从 bible/premise.md 读「世界规则可冲突性」立项卡的正文（card 7）。
 * 这是写手与审校核对「设定违背」的权威依据——写手只有 Read 工具、无 MCP 查询，
 * 故基础世界规则必须随上下文包注入，不能只靠语义检索的 top-k 碰运气。
 * 返回去掉标题行的小节原文（保留表格/列表形态），找不到返回 null。
 */
async function readWorldRules(projectRoot: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(join(projectRoot, "bible", "premise.md"), "utf-8");
  } catch {
    return null;
  }
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) =>
    /^#{2,4}\s*.*世界规则/.test(line.trim()),
  );
  if (start === -1) return null;
  const headingLevel = (lines[start].match(/^#+/) ?? ["##"])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= headingLevel) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  // 只剩空表头（如 "| 规则 | … |\n|---|---|"）或全空视为未填写
  const meaningful = body
    .split("\n")
    .filter((l) => l.trim() && !/^\|[\s|:-]*\|$/.test(l.trim()) && !/^\|\s*规则/.test(l.trim()))
    .join("\n")
    .trim();
  return meaningful.length > 0 ? body : null;
}

const STYLE_PROFILES: Record<string, string> = {
  // 「快」由钩子密度与场景切换速度表达，不由句长表达：档位一旦写「句子短」，
  // 就成了系统替所有 web_fast 书下的句法处方，与本书声音叠加后把句长压到读不懂
  web_fast:
    "钩子排布要密，场景快进快出不拖，情绪直接给到位，爽点不憋着",
  web_standard:
    "钩子稳定出现，长短句相间，情绪外显、该热就热，场景推进顺滑不拖",
  literary:
    "钩子可以舒缓，句式从容，情绪更多藏在动作与细节里，允许停留与余味",
};

// 克制类校准词典（ADR-0024）：作者按文学直觉填入「克制/留白…」时，渲染出口翻译成正向写法，
// 不透传进风格指令——弱模型会把重复的克制信号误读为「写冷、写碎、不写情绪」。
// 立项卡数据态不变（作者意图是 canon），正向化只发生在喂写手的这道出口。
const RESTRAINT_TERMS = [
  "克制", "留白", "节制", "收敛", "含蓄", "内敛", "不煽情",
];
const RESTRAINT_RE = new RegExp(RESTRAINT_TERMS.join("|"));
// 形容词位「克制的/含蓄地…」：去掉校准词与其后的「的/地」，保留被修饰的正向名词
const RESTRAINT_ADJ_RE = new RegExp(`(?:${RESTRAINT_TERMS.join("|")})[的地]`, "g");
// 拿掉克制校准后，承接「别滥情、别堆砌」正当意图的正向写法（沿 ADR-0024 决策一）
const POSITIVE_CRAFT = "情绪靠画面、动作和细节演出来，写到位、写具体。";

// 句法处方类校准词典：作者用来表达「读起来快」的形容词，被弱模型当成可执行的句长指标顶格执行。
// 真机实测（叙述声音卡写「短句快节奏，段落实短…描写精简」的书）：均句长掉到真人网文的
// 55-65%、≥25 字长句只剩真人的 1/3、极短句翻倍，疑问句连问号都省成句号，读者读不懂。
// 病理与 RESTRAINT_TERMS 同源（ADR-0024）：文学直觉形容词 ≠ 句法处方；节奏该由钩子与
// 场景切换承载，句长必须留给写手按情绪自由裁量。同样只在喂写手的这道出口翻译，卡里数据不动。
const PROSODY_TERMS = [
  "段落实短", "描写精简", "精简描写",
  "句子短", "段落短", "短句", "长句", "句短", "短段", "碎句", "碎段",
  "惜字", "简练", "凝练", "精简",
];
// 长词优先匹配，避免「段落实短」被「短句」之类的短词切碎
const PROSODY_SORTED = [...PROSODY_TERMS].sort((a, b) => b.length - a.length);
const PROSODY_TEST_RE = new RegExp(PROSODY_SORTED.join("|"));
const PROSODY_STRIP_RE = new RegExp(PROSODY_SORTED.join("|"), "g");
// 拿掉句长处方后，承接「读起来要顺、要快」正当意图的正向写法
const POSITIVE_PROSODY =
  "句子长短跟着情绪走，该短就短、该展开就展开，别让读者为读懂一句话回头重看。";

/** 小句丢弃后清理悬空分隔符：只清软分隔符，保留作者破折号「——」不被折断 */
function joinClauses(parts: string[]): string {
  return parts
    .join("")
    .replace(/^[，。；、—\s]+/, "")
    .replace(/[，。；、\s]+(?=[，。；、])/g, "")
    .replace(/[，、；—\s]+$/g, "");
}

/** 按小句切分（分隔符保留在奇数位，供原样回填） */
function splitClauses(text: string): string[] {
  return text.split(/(——|，|。|；|、|—)/);
}

/**
 * 自由文本（tone/pacing）正向化：按小句切分，形容词位的校准词就地去除、保留正向名词；
 * 谓语/独立位的校准词整小句丢弃（其正当意图由 POSITIVE_CRAFT 统一承接）。
 * 返回 [cleaned, droppedCalibration]——droppedCalibration 仅在丢弃了整小句时为真。
 * 导出供单测。
 */
export function positivizeNarratorFreeText(text: string): [string, boolean] {
  if (!RESTRAINT_RE.test(text)) return [text, false];
  let dropped = false;
  const parts = splitClauses(text);
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i];
    if (!RESTRAINT_RE.test(clause)) continue;
    const cleaned = clause.replace(RESTRAINT_ADJ_RE, "");
    if (RESTRAINT_RE.test(cleaned)) {
      // 形容词位去除后仍残留校准词 = 该词在谓语/独立位，整小句承载的是校准 → 丢弃
      parts[i] = "";
      dropped = true;
    } else {
      parts[i] = cleaned;
    }
  }
  return [joinClauses(parts), dropped];
}

/**
 * 句长处方正向化：命中小句里就地删掉处方词——删完仍有实义的保留（「短句快节奏」→「快节奏」），
 * 只剩处方本身的整小句丢弃（「段落实短」/「描写精简」）。正当意图由 POSITIVE_PROSODY 承接。
 * 返回 [cleaned, droppedProsody]。导出供单测。
 */
export function positivizeProsody(text: string): [string, boolean] {
  if (!PROSODY_TEST_RE.test(text)) return [text, false];
  let dropped = false;
  const parts = splitClauses(text);
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i];
    if (!clause || !PROSODY_TEST_RE.test(clause)) continue;
    dropped = true;
    const cleaned = clause.replace(PROSODY_STRIP_RE, "");
    // 删掉处方词后剩不足两个汉字 = 该小句除处方外无实义 → 整小句丢弃
    const han = cleaned.match(/[一-鿿]/g)?.length ?? 0;
    parts[i] = han <= 2 ? "" : cleaned;
  }
  return [joinClauses(parts), dropped];
}

/**
 * 喂写手的风格文本统一正向化出口：先克制类（ADR-0024）、再句长处方类。
 * archetype 与 tone/pacing/ornamentation/digression 共用此出口——archetype 是风格指令首句、
 * 权重最高，原先整段透传是同一病灶未覆盖的洞。
 */
function positivizeVoiceText(text: string): {
  text: string;
  droppedRestraint: boolean;
  droppedProsody: boolean;
} {
  const [afterRestraint, droppedRestraint] = positivizeNarratorFreeText(text);
  const [afterProsody, droppedProsody] = positivizeProsody(afterRestraint);
  return { text: afterProsody, droppedRestraint, droppedProsody };
}

/**
 * 风格关键词（顿号/逗号分隔表）正向化：丢弃命中校准词的 token，保留正向腔调词。
 * 返回 [cleaned, droppedRestraint, droppedProsody]——两类命中分开报，供出口追加对症的正向句。
 */
export function positivizeStyleKeywords(text: string): [string, boolean, boolean] {
  const tokens = text
    .split(/[、，,／/\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const kept: string[] = [];
  let droppedRestraint = false;
  let droppedProsody = false;
  for (const t of tokens) {
    if (RESTRAINT_RE.test(t)) {
      droppedRestraint = true;
    } else if (PROSODY_TEST_RE.test(t)) {
      droppedProsody = true;
    } else {
      kept.push(t);
    }
  }
  return [kept.join("、"), droppedRestraint, droppedProsody];
}

/** 风格指令渲染：叙述声音数据 + style_profile 档位 → 一段中文自然语言 */
export function renderStyleDirective(
  voice: Map<string, string> | null,
  styleProfile: string | null,
  warnings: string[],
): string {
  const parts: string[] = [];
  if (voice) {
    let droppedCalibration = false;
    let droppedProsody = false;
    const archetype = voice.get("archetype");
    if (archetype) {
      const cleaned = positivizeVoiceText(archetype);
      if (cleaned.droppedRestraint) droppedCalibration = true;
      if (cleaned.droppedProsody) droppedProsody = true;
      if (cleaned.text) parts.push(`本书叙述声音是「${cleaned.text}」。`);
    }
    const dims: string[] = [];
    // tone/pacing/ornamentation/digression 都是叙述声音卡的自由文本维度，
    // 同样可能被作者填入克制类校准或句长处方措辞，统一走正向化出口（见 ADR-0024）
    const freeTextDims: Array<[string | undefined, string]> = [
      [voice.get("tone"), "基调"],
      [voice.get("pacing"), "节奏"],
      [voice.get("ornamentation"), "修饰密度"],
      [voice.get("digression"), "离题倾向"],
    ];
    for (const [raw, prefix] of freeTextDims) {
      if (!raw) continue;
      const cleaned = positivizeVoiceText(raw);
      if (cleaned.droppedRestraint) droppedCalibration = true;
      if (cleaned.droppedProsody) droppedProsody = true;
      // 维度名已被内容自带时不重复冠上（「节奏」+「快节奏…」→「快节奏…」，不是「节奏快节奏」）
      if (cleaned.text) {
        const firstClause = cleaned.text.split(/[，。；、]/)[0] ?? "";
        dims.push(`${firstClause.includes(prefix) ? "" : prefix}${cleaned.text}`);
      }
    }
    const address = voice.get("address");
    if (address) dims.push(`以${narratorAddressPhrase(address)}叙述`);
    if (dims.length > 0) parts.push(`${dims.join("，")}。`);
    const rawKeywords = voice.get("style_keywords");
    if (rawKeywords) {
      const [keywords, droppedR, droppedP] = positivizeStyleKeywords(rawKeywords);
      if (droppedR) droppedCalibration = true;
      if (droppedP) droppedProsody = true;
      if (keywords) parts.push(`风格关键词：${keywords}。`);
    }
    if (droppedCalibration) parts.push(POSITIVE_CRAFT);
    if (droppedProsody) parts.push(POSITIVE_PROSODY);
  } else {
    warnings.push("bible/premise.md 未找到叙述声音数据，风格指令按档位默认渲染");
  }

  let profile = styleProfile ?? "web_standard";
  if (!(profile in STYLE_PROFILES)) {
    warnings.push(`style_profile "${profile}" 不在档位表内，按 web_standard 渲染`);
    profile = "web_standard";
  }
  if (!styleProfile) {
    warnings.push("config.yaml 缺 style_profile，按 web_standard 渲染风格指令");
  }
  parts.push(`写法水位：${STYLE_PROFILES[profile]}。`);
  return parts.join("");
}

interface SemanticContextItem {
  content: string;
  source_chapter?: number;
  score: number;
}

/**
 * 多短查询 hybrid 检索 + 距离衰减，top5。
 *
 * excludeTexts（真机实锤 spec §1.3 P5）：前章摘要/角色卡已随包投递的文本经
 * FTS LIKE 兜底也常被自己的查询词命中——把逐字重叠的冗余条目当成「新语义」凑数，
 * score 仅 0.03-0.05 却挤占 top5 名额。命中判据同 Task 3 dedupeCardExtras：
 * normalize 后互为子串即剔除，在 slice(0, 5) 之前过滤，不影响 decayScore 排序。
 */
async function getSemanticContext(
  ctx: ToolContext,
  chapter: number,
  parsed: ParsedRenderedOutline,
  storylineNames: string[],
  dueDescriptions: string[],
  excludeTexts: string[] = [],
): Promise<SemanticContextItem[]> {
  const queries: string[] = [];
  const push = (q: string | null | undefined) => {
    const trimmed = q?.trim();
    if (trimmed && trimmed.length >= 2 && !queries.includes(trimmed)) {
      queries.push(trimmed);
    }
  };
  for (const p of parsed.pressure_points.slice(0, 2)) push(p);
  for (const name of parsed.characters.slice(0, 2)) push(name);
  push(storylineNames[0]);
  push(dueDescriptions[0]);
  push(parsed.dramatic_focus);
  const selected = queries.slice(0, 5);
  if (selected.length === 0) return [];

  // 最短长度阈值 10（normalize 后，标点/空白已剥离）：spec §4.1 P5 的剔重针对
  // 「逐字重叠的冗余条目」，短角色卡值（如「警觉」）常作为独立词出现在检索条目的
  // 长句内部，若不设阈值会把整条命中当「子串重叠」误杀，反而损失召回。
  const excludeNorms = excludeTexts
    .map((t) => normalizeExtraValue(t))
    .filter((t) => t.length >= 10);

  try {
    const hits = await multiQueryHybridSearch(ctx.db, selected, ctx.novelId, {
      limit: 15,
    });
    return hits
      .flatMap((hit) => {
        const detail = getSourceDetail(ctx, hit.sourceTable, hit.sourceId);
        if (!detail) return [];
        const item: SemanticContextItem = {
          content: detail.content,
          score: Number(
            decayScore(hit.rrfScore, detail.chapter, chapter).toFixed(6),
          ),
        };
        if (detail.chapter !== null) item.source_chapter = detail.chapter;
        return [item];
      })
      .filter((item) => {
        const norm = normalizeExtraValue(item.content);
        if (!norm) return true;
        return !excludeNorms.some((ex) => norm.includes(ex) || ex.includes(norm));
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  } catch {
    return [];
  }
}

// ============================================================
// 跨章预警纯代码扫描（contract: docs/contracts/cross-chapter-warnings.md）
// 确定性逻辑，结果写入 WCP warnings[]，chapter-writer 逐条回应。
// 4.0 实现两类客观连续性扫描；不做「避免重复手法/收尾」类轮换压制
// （网文靠模式重复建立节奏期待，强制轮换是错误诊断）。
// ============================================================

const ABSTRACT_RATIO = 0.5;
const NO_REVEAL_WINDOW = 3;
/** spec §4.1 P2：前 N 章是铺设期，不催伏笔结算（真机实锤：第 4 章被催结算诱发审校越权加戏） */
const FORESHADOW_SETUP_WINDOW = 8;

// 锚点泛泛判定用抽象词词典（cross-chapter-warnings §2）
const ABSTRACT_WORDS = [
  "震惊", "打击", "崩塌", "动摇", "震撼", "觉醒", "警醒", "心境", "起伏", "波动",
  "转折", "转机", "转变", "变化", "改变", "蜕变", "跨越", "突破",
  "重大", "关键", "重要", "深刻", "根本", "彻底", "全面", "巨大",
  "某种", "某个", "某些", "一切", "所有", "整个", "全部",
].sort((a, b) => b.length - a.length);

const FUNCTION_CHARS = new Set(
  "的了和在是有对与着过地得之其也而就都把被让向从这那个一不你我他她它们之乎者也".split(""),
);

/** 抽象词占比：cross-chapter-warnings §2 算法（导出供单测） */
export function abstractRatio(text: string): number {
  const meaningful = [...text].filter(
    (ch) => /[一-鿿]/.test(ch) && !FUNCTION_CHARS.has(ch),
  );
  const total = meaningful.length;
  if (total < 4) return 0;
  const s = meaningful.join("");
  let covered = 0;
  let i = 0;
  while (i < s.length) {
    const hit = ABSTRACT_WORDS.find((w) => s.startsWith(w, i));
    if (hit) {
      covered += hit.length;
      i += hit.length;
    } else {
      i += 1;
    }
  }
  return covered / total;
}

interface DueLike {
  due: Array<{ target_reveal?: string }>;
  others_count: number;
}

/** 跨章预警：锚点泛泛（4.3）+ 伏笔无 reveal（4.2）。缺数据即跳过，不报错 */
function getCrossChapterWarnings(
  ctx: ToolContext,
  chapter: number,
  briefs: BriefForPack[],
  foreshadowingDue: DueLike,
): string[] {
  const out: string[] = [];

  // 4.3 锚点泛泛
  const withAnchor = briefs.filter((b) => b.core_experience && b.core_experience.trim());
  if (withAnchor.length >= 2) {
    const scored = withAnchor
      .map((b) => ({ text: b.core_experience as string, ratio: abstractRatio(b.core_experience as string) }))
      .filter((x) => x.ratio >= ABSTRACT_RATIO)
      .sort((a, b) => b.ratio - a.ratio);
    if (scored.length >= 2) {
      const samples = scored.slice(0, 2).map((x) => `「${x.text}」`).join("、");
      out.push(`前文锚点描述偏抽象（${samples}），本章 outline 可能也需要细化为具体场景`);
    }
  }

  // 4.2 伏笔无 reveal——判据须是「确有到期账」（spec §4.1 P2），不是「随便有条活跃伏笔」：
  // due-list 里全部已种下的 major 恒在 due（core_foreshadowing 同款豁免距离衰减，见
  // getThroughLineAnchor 注释），远期 major（如 target=95）不该催结算；只有 target_reveal
  // 落在临期窗口（≤ 本章+10，与 due-list 临期规则同款）才算「到期账」，配合 due-list 既有的
  // major 恒纳入，可正确识别出「due 里有真正临期的伏笔」而非「随便有条 major 挂着」。
  const dueSoon = foreshadowingDue.due.filter((f) => {
    const target = /^[1-9][0-9]*$/.test(String(f.target_reveal))
      ? Number(f.target_reveal)
      : null;
    return target !== null && target <= chapter + 10;
  });
  if (dueSoon.length > 0 && chapter > FORESHADOW_SETUP_WINDOW) {
    const from = chapter - NO_REVEAL_WINDOW;
    const to = chapter - 1;
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM foreshadowing_actions_log
         WHERE novel_id = ? AND chapter BETWEEN ? AND ? AND action IN ('develop', 'reveal')`,
      )
      .get(ctx.novelId, from, to) as { c: number };
    if (row.c === 0) {
      out.push(`已连续 ${NO_REVEAL_WINDOW} 章无伏笔兑现（develop/reveal），建议本章安排一次小结算`);
    }
  }

  return out;
}

export async function novelBuildWritingContextPack(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const chapter = asPositiveInt(args["chapter"]);
  if (chapter === null) {
    return singleError(
      "chapter",
      "integer ≥ 1",
      describe(args["chapter"]),
      "传入即将撰写的章节号（正整数）",
    );
  }
  if (!ctx.projectRoot) {
    return singleError(
      "projectRoot",
      "可用的项目根目录",
      "缺失",
      "NOVEL_CONFIG_PATH 未指向有效项目：检查 MCP 配置后重试",
    );
  }

  const outlinePath = await findChapterOutlineFile(ctx.projectRoot, chapter);
  if (!outlinePath) {
    return singleError(
      "chapter",
      `outline/vol-VV/ch-${chapterFileSegment(chapter)}.md 存在`,
      "细纲文件未找到",
      `第${chapter}章细纲不存在：先执行 /narracat:plan 细化本章`,
    );
  }

  // warnings 分两路，避免预算诊断刷掉写手对真连贯性预警的注意力：
  //  - warnings：连贯性/数据缺口预警（故事线缺席、伏笔无兑现、世界规则/brief/角色卡缺失等）
  //    —— 写手据此调整写法、按红线 3 逐条回应；随包 pack.warnings 落盘喂写手。
  //  - buildNotes：预算截断 / 渲染降级的系统诊断（超预算、已截断、按档位默认等）
  //    —— 既成事实、写手无从处理；只随工具返回值回主会话（/write step-2 展示），不进包内、不喂写手。
  const warnings: string[] = [];
  const buildNotes: string[] = [];
  if (ctx.voltageBestofPresentInConfig) {
    buildNotes.push("配置项 voltage_bestof 已停用（电压点判优环节已移除），本次忽略");
  }

  // 区块 1：本章细纲全文（优先从 ch-NNN.json 现渲染，反映最新提交；陈旧/旧书回退读 .md）
  const { text: chapterOutlineFull, touchIds } = await readChapterOutlineForPack(ctx, outlinePath);
  let chapterOutline = chapterOutlineFull;
  if (estimateTokens(chapterOutline) > BLOCK_BUDGETS.chapter_outline) {
    chapterOutline = truncateToBudget(chapterOutline, BLOCK_BUDGETS.chapter_outline);
    buildNotes.push("细纲全文超预算，已硬截断");
  }
  const parsed = parseRenderedOutline(chapterOutline);

  // 本章目标情绪（章级）：persona 调制（区块 2b）与范例情绪匹配（区块 3）共用同一次探测结果
  const chapterEmotions = detectChapterEmotions(chapterOutline);

  // 结构定位
  const arc = getArcForChapter(ctx, chapter);
  if (!arc) {
    buildNotes.push("本章未找到所属 arc（大纲结构数据缺失），温层与伏笔过滤按降级处理");
  }
  const currentVolume = arc?.volume_no ?? null;
  const volumeRange = currentVolume !== null ? getVolumeRange(ctx, currentVolume) : null;

  // 字数区间
  const wordCountRange = getChapterWordCountRange(ctx.wordsPerChapter);
  if (!ctx.wordsPerChapter) {
    buildNotes.push("config.yaml 缺 words_per_chapter，字数区间按 2400-3600 默认");
  }

  // 区块 2：风格指令（渲染降级提示归 buildNotes：叙述声音缺失/档位默认是系统态，写手无从处理）
  const voice = await readNarratorVoice(ctx.projectRoot);
  let styleDirective = renderStyleDirective(voice, ctx.styleProfile ?? null, buildNotes);
  if (estimateTokens(styleDirective) > BLOCK_BUDGETS.style_directive) {
    styleDirective = truncateToBudget(styleDirective, BLOCK_BUDGETS.style_directive);
    buildNotes.push("风格指令超预算，已硬截断");
  }

  // 能力包候选池（ADR-0034 v1.1）：按 .narracat/packs.json 启用清单解析官方/用户包，
  // 供下方 persona/craft 选卡消费；发现期 warning 随 buildNotes 走系统诊断通道。
  const packPools = resolvePackPools(ctx.projectRoot);
  for (const note of packPools.notes) buildNotes.push(note);

  // 区块 2b：persona 说书人卡（按叙述声音关键词机械选卡，叠加章级情绪调制；
  // 无命中/被调制省略字段，写手回退 style_directive）
  const personaCard = selectPersona(voice, chapterEmotions, buildNotes, packPools.personas);
  if (personaCard) {
    buildNotes.push(`persona 选卡：${personaCard.name}（${personaCard.id}）`);
  }

  // 区块 2.5：世界规则（设定违背核对的权威依据，写手无 MCP 查询故必须随包注入）
  let worldRules = (await readWorldRules(ctx.projectRoot)) ?? "";
  if (worldRules === "") {
    // 数据缺口 → warnings：写手据此知道设定违背核对只能靠角色卡/检索，须更谨慎
    warnings.push("bible/premise.md 未填写世界规则，设定违背核对仅能依据角色卡与语义检索");
  } else if (estimateTokens(worldRules) > BLOCK_BUDGETS.world_rules) {
    buildNotes.push("世界规则超预算，已硬截断");
    worldRules = truncateToBudget(worldRules, BLOCK_BUDGETS.world_rules);
  }

  // 区块 3：文风范例——本书声音段排最前（作者标记 > 自动取样），跨书真人范例补足到 3 段。
  // 顺序即优先级：下方超预算时从末位丢弃，天然先丢跨书段、保住本书段。
  const bookVoiceExamples = await buildBookVoiceExamples(ctx, chapter, buildNotes);
  const crossBookExamples = await selectStyleExamples(
    chapter,
    3 - bookVoiceExamples.length,
    chapterEmotions,
  );
  const styleExamples = [...bookVoiceExamples, ...crossBookExamples];
  if (bookVoiceExamples.length > 0) {
    buildNotes.push(`本书声音段 ${bookVoiceExamples.length} 段进包`);
  }
  // 区块 3.5：写手向 Craft Pack（结构化触发选包，命中则写指针，无命中则不写——向后兼容）
  const craftPackHints = selectCraftPacks(chapterOutline, 3, packPools.craft);
  if (styleExamples.length === 0) {
    buildNotes.push("真人范例不可用（语料服务未配置或暂不可达），本次不注入范例");
  }
  // 截断下限：至少留 1 段，且不得吞掉本书声音段——bookVoiceExamples 排在数组最前，
  // pop() 从末位丢弃时天然先丢跨书段；下限设为 bookVoiceExamples.length 才能保证
  // 本书段不会被超预算截断到，与上方注释「保住本书段」的承诺对齐。
  let droppedExamples = 0;
  const minKeep = Math.max(1, bookVoiceExamples.length);
  while (
    styleExamples.length > minKeep &&
    estimateBlockTokens(styleExamples) > BLOCK_BUDGETS.style_examples
  ) {
    styleExamples.pop();
    droppedExamples += 1;
  }
  if (droppedExamples > 0) {
    buildNotes.push(`范例区块超预算，已减少 ${droppedExamples} 段范例`);
  }

  // 区块 4：L1 热层
  const briefs = getPreviousBriefs(ctx, chapter);
  await widenLatestEndingSnippet(ctx, briefs);
  if (chapter > 1 && briefs.length === 0) {
    warnings.push("前文章节 brief 缺失（前章可能未收尾入库），连续性核对依据不足");
  }
  let droppedBriefs = 0;
  while (
    briefs.length > 1 &&
    estimateBlockTokens(briefs) > BLOCK_BUDGETS.previous_chapter_briefs
  ) {
    briefs.shift();
    droppedBriefs += 1;
  }
  if (droppedBriefs > 0) {
    buildNotes.push(`热层超预算，已丢弃最早 ${droppedBriefs} 章 brief`);
  }

  // 区块 4.5：全书贯穿线常驻层（独立预算，永不随卷滚动丢弃）
  // 超预算时按「核心伏笔 → 贯穿故事线 → 引擎字段」顺序截断（引擎字段最重要、最后丢）
  const throughLineAnchor = getThroughLineAnchor(ctx, chapter);
  let droppedCoreForeshadowing = 0;
  while (
    estimateBlockTokens(throughLineAnchor) > BLOCK_BUDGETS.through_line_anchor &&
    throughLineAnchor.core_foreshadowing.length > 0
  ) {
    throughLineAnchor.core_foreshadowing.pop();
    droppedCoreForeshadowing += 1;
  }
  if (droppedCoreForeshadowing > 0) {
    buildNotes.push(`常驻层超预算，已截断 ${droppedCoreForeshadowing} 条核心伏笔`);
  }
  let droppedThroughStorylines = 0;
  while (
    estimateBlockTokens(throughLineAnchor) > BLOCK_BUDGETS.through_line_anchor &&
    throughLineAnchor.through_storylines.length > 0
  ) {
    throughLineAnchor.through_storylines.pop();
    droppedThroughStorylines += 1;
  }
  if (droppedThroughStorylines > 0) {
    buildNotes.push(`常驻层超预算，已截断 ${droppedThroughStorylines} 条贯穿故事线`);
  }
  let droppedEngineFields = 0;
  while (
    estimateBlockTokens(throughLineAnchor) > BLOCK_BUDGETS.through_line_anchor &&
    throughLineAnchor.engine_fields.length > 0
  ) {
    throughLineAnchor.engine_fields.pop();
    droppedEngineFields += 1;
  }
  if (droppedEngineFields > 0) {
    buildNotes.push(`常驻层超预算，已截断 ${droppedEngineFields} 个引擎字段`);
  }

  // 区块 5：L2 温层
  const arcSummaries = getArcSummariesForPack(ctx, chapter, currentVolume);
  let droppedArcSummaries = 0;
  while (
    arcSummaries.length > 1 &&
    estimateBlockTokens(arcSummaries) > BLOCK_BUDGETS.arc_summaries
  ) {
    arcSummaries.shift();
    droppedArcSummaries += 1;
  }
  if (droppedArcSummaries > 0) {
    buildNotes.push(`温层超预算，已丢弃最早 ${droppedArcSummaries} 段区间摘要`);
  }

  // 区块 6：角色状态卡（按 uid 折叠）。取源 = 本章 outline 出场角色 ∪ 前 3 章出场角色。
  // 本章出场角色优先入卡（含隔多章回归者）——否则写手只拿到「出场角色: X」却没有 X 的
  // 状态卡，只能凭空补写、易出连续性错。outline 名经 alias-map 解析为 uid，新角色（无 uid）
  // 自然跳过（本无往史可折叠）。优先插入使其靠前，预算紧张时不被前 3 章的旧角色挤掉。
  const cardCharacterMap = new Map<string, { uid: string; name: string }>();
  const cardAliasMap = await loadAliasMap(ctx.projectRoot);
  for (const name of parsed.characters) {
    const uid = resolveCharacterUid(name, cardAliasMap);
    if (uid) cardCharacterMap.set(uid, { uid, name: normalizeName(name, cardAliasMap) });
  }
  // 本章 outline 角色快照（派生关系端点只取本章，不含前 3 章历史角色）
  const chapterOutlineCharacters = [...cardCharacterMap.values()];
  const cardRows = ctx.db
    .prepare(
      `SELECT characters FROM chapter_summaries
       WHERE novel_id = ? AND chapter BETWEEN ? AND ?`,
    )
    .all(ctx.novelId, Math.max(1, chapter - 3), chapter - 1) as Array<{
    characters: string;
  }>;
  for (const row of cardRows) {
    for (const ref of parseCharacterRefs(row.characters)) {
      if (!cardCharacterMap.has(ref.uid)) cardCharacterMap.set(ref.uid, ref);
    }
  }
  if (cardCharacterMap.size === 0) {
    warnings.push("未解析出出场角色，角色状态卡为空");
  }
  const characterCards = getCharacterCardsForPack(
    ctx,
    [...cardCharacterMap.values()],
    Math.max(1, chapter - 1),
  );
  // 出场角色名单必须完整，哪怕卡没随包给出（issue #48）。缺卡分两种成因，都得点名到人：
  //  ① 尚无状态记录——角色在 cardCharacterMap 里但折叠不出卡（新登场 stub / 未抽出事实），
  //     getCharacterCardsForPack 内部直接跳过，从来不在下面的裁剪计数里；
  //  ② 超预算被裁——下面的 while 从尾部丢整张卡。
  // 两类都带 character_uid：novel_character_state 只吃 uid，只给名字等于让消费者自己去
  // 翻角色档案找 uid（真机实测审校就是在这一步开始猜文件路径的），名单就白给了。
  const cardedNames = new Set(characterCards.map((card) => card.character));
  const uidByName = new Map(
    [...cardCharacterMap.values()].map((entry) => [entry.name, entry.uid] as const),
  );
  const charactersWithoutCards: CharacterWithoutCard[] = [];
  for (const { uid, name } of cardCharacterMap.values()) {
    if (cardedNames.has(name)) continue;
    charactersWithoutCards.push({ character: name, character_uid: uid, reason: "尚无状态记录" });
  }
  const droppedCardNames: string[] = [];
  while (
    characterCards.length > 1 &&
    estimateBlockTokens(characterCards) > BLOCK_BUDGETS.character_cards
  ) {
    const dropped = characterCards.pop();
    if (!dropped) break;
    droppedCardNames.unshift(dropped.character); // pop 是从尾部丢，unshift 还原成原排序
  }
  for (const name of droppedCardNames) {
    const uid = uidByName.get(name);
    charactersWithoutCards.push({
      character: name,
      ...(uid ? { character_uid: uid } : {}),
      reason: "状态卡超预算未随包给出",
    });
  }
  if (droppedCardNames.length > 0) {
    // 点名到人，而不是只报个数：主会话手上有 novel_character_state，write.md 步骤 2 也早就
    // 写着「包内信息有缺口时补查」——此前只报「已丢弃 2 个角色」，它知道少了人却不知道少了谁，
    // 那条补救链路整条空转（issue #48 根因）。
    buildNotes.push(
      `角色状态卡超预算，未随包给出 ${droppedCardNames.length} 个角色的卡（${droppedCardNames.join("、")}）` +
        `——需要其状态时按 character_uid 调 novel_character_state 补查，结果写进任务书`,
    );
  }

  // 区块 6.2：本章计划状态变更（planned_state_changes 计划账 → 写手前置）。
  // 具名数据行喂给写手（靶而非纪律段）；display_name 与角色卡同一词表口径。
  // 计划账与事实账分离：这里只报「本章该发生什么变化」，当前状态仍以角色卡为准。
  const plannedStateRows = ctx.db
    .prepare(
      `SELECT character_name, dimension, operation, value, reason FROM planned_state_changes
       WHERE novel_id = ? AND chapter = ? AND status = 'planned'
       ORDER BY rowid ASC`,
    )
    .all(ctx.novelId, chapter) as Array<{
    character_name: string;
    dimension: string;
    operation: "set" | "add" | "remove";
    value: string;
    reason: string | null;
  }>;
  const plannedVocab = loadStateVocabulary(ctx.projectRoot);
  const plannedDimNames = new Map(
    (plannedVocab?.dimensions ?? []).map((d) => [d.key, d.display_name]),
  );
  const plannedStateChanges = plannedStateRows.map((row) => {
    const opLabel = row.operation === "remove" ? "失去" : row.operation === "add" ? "获得" : "变为";
    const base = `${row.character_name}：${plannedDimNames.get(row.dimension) ?? row.dimension}${opLabel}「${row.value}」`;
    return row.reason ? `${base}（${row.reason}）` : base;
  });
  let droppedPlannedChanges = 0;
  while (
    plannedStateChanges.length > 1 &&
    estimateBlockTokens(plannedStateChanges) > BLOCK_BUDGETS.planned_state_changes
  ) {
    plannedStateChanges.pop();
    droppedPlannedChanges += 1;
  }
  if (droppedPlannedChanges > 0) {
    buildNotes.push(`计划状态变更超预算，已丢弃排序靠后的 ${droppedPlannedChanges} 项`);
  }

  // 区块 6.5：角色关系（本章涉及角色两两之间的当前关系）
  const characterRelationships = getCharacterRelationshipsForPack(
    ctx,
    [...cardCharacterMap.values()],
    Math.max(1, chapter - 1),
  );
  let droppedRelationships = 0;
  while (
    characterRelationships.length > 1 &&
    estimateBlockTokens(characterRelationships) > BLOCK_BUDGETS.character_relationships
  ) {
    characterRelationships.pop();
    droppedRelationships += 1;
  }
  if (droppedRelationships > 0) {
    buildNotes.push(`角色关系超预算，已丢弃排序靠后的 ${droppedRelationships} 个关系对`);
  }

  // 区块 6.6：派生关系读时 2 跳共邻——仅本章角色对且查不到直接边才推；
  // 直接边判定走全量有效边邻接表（与包内展示截断无关，被截断的对仍算有直接边）。
  // 展示名以当前档案 canonical 名为准（角色改名后历史 facts.subject 是旧名）。
  const canonicalNameByUid = new Map<string, string>();
  for (const resolved of cardAliasMap.values()) {
    if (resolved.uid && !canonicalNameByUid.has(resolved.uid)) {
      canonicalNameByUid.set(resolved.uid, resolved.canonical);
    }
  }
  const { edges: relationshipEdges, directPairKeys } = loadValidRelationshipEdges(
    ctx,
    Math.max(1, chapter - 1),
  );
  const derivedRelationships = computeDerivedRelationships({
    edges: relationshipEdges,
    directPairKeys,
    chapterCharacters: chapterOutlineCharacters,
    factCountByUid: loadFactCountByUid(ctx, Math.max(1, chapter - 1)),
    canonicalNameByUid,
  });
  let droppedDerived = 0;
  while (
    derivedRelationships.length > 0 &&
    estimateBlockTokens(derivedRelationships) > BLOCK_BUDGETS.derived_relationships
  ) {
    derivedRelationships.pop();
    droppedDerived += 1;
  }
  if (droppedDerived > 0) {
    buildNotes.push(`派生关系超预算，已丢弃排序靠后的 ${droppedDerived} 条`);
  }

  // 区块 7：伏笔 due-list（本章细纲『伏笔动作』显式引用的条目穿透 planted 过滤，spec §4.1 P1）
  // 结构化 foreshadowing_touch 优先；.json 缺失/解析失败（旧书）时 touchIds 为 null，回退全文正则兜底
  const foreshadowingDue = getForeshadowingDue(
    ctx,
    chapter,
    arc,
    volumeRange,
    currentVolume,
    touchIds ?? extractReferencedForeshadowingIds(chapterOutline),
  );
  // major 优先保留：major 排前、non-major 排后；超预算时只 pop 末尾的 non-major，
  // 直到 non-major 耗尽才允许 pop major（核心伏笔豁免距离衰减，不因预算溢出被丢）
  const TYPE_RANK: Record<string, number> = { major: 0, medium: 1, small: 2 };
  foreshadowingDue.due.sort(
    (a, b) => (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9),
  );
  let foreshadowingToCount = 0;
  while (
    foreshadowingDue.due.length > 1 &&
    foreshadowingDue.due[foreshadowingDue.due.length - 1].type !== "major" &&
    estimateBlockTokens(foreshadowingDue) > BLOCK_BUDGETS.foreshadowing_due
  ) {
    foreshadowingDue.due.pop();
    foreshadowingDue.others_count += 1;
    foreshadowingToCount += 1;
  }
  if (foreshadowingToCount > 0) {
    buildNotes.push(`伏笔 due-list 超预算，已将 ${foreshadowingToCount} 条转入计数`);
  }

  // 区块 8：storyline 聚焦 + 缺席预警
  const storylineFocus = getStorylineFocus(ctx, chapter);
  warnings.push(...getStorylineAbsenceWarnings(ctx, chapter));

  // 跨章预警纯代码扫描（锚点泛泛 + 伏笔无 reveal）
  warnings.push(...getCrossChapterWarnings(ctx, chapter, briefs, foreshadowingDue));

  // 区块 9：语义检索 top5（excludeTexts：前章摘要 + 角色卡已随包投递，过滤逐字重叠的冗余命中）
  const semanticExcludeTexts: string[] = [];
  for (const brief of briefs) {
    semanticExcludeTexts.push(brief.summary);
    if (brief.opening_snippet) semanticExcludeTexts.push(brief.opening_snippet);
    if (brief.ending_snippet) semanticExcludeTexts.push(brief.ending_snippet);
  }
  for (const card of characterCards) {
    semanticExcludeTexts.push(...Object.values(card.card));
  }
  let semanticContext = await getSemanticContext(
    ctx,
    chapter,
    parsed,
    storylineFocus.map((s) => s.name),
    foreshadowingDue.due.map((f) => f.description),
    semanticExcludeTexts,
  );
  while (
    semanticContext.length > 0 &&
    estimateBlockTokens(semanticContext) > BLOCK_BUDGETS.semantic_context
  ) {
    semanticContext = semanticContext.slice(0, -1);
  }

  // 章级能力回执（spec §4.4）：选中卡回查候选池溯源落盘，供 App 展示「本章用了哪些能力」
  // （Task 9b 消费）。写盘失败不得阻断 WCP 构建，故 fail-soft：捕获后转 buildNotes 警告。
  try {
    writeCapabilityReceipt(ctx.projectRoot, chapter, {
      entries: buildReceiptEntries({ personaCard, craftPackHints, pools: packPools }),
      warnings: packPools.notes,
    });
  } catch (err) {
    buildNotes.push(
      `章级能力回执写入失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const pack: Record<string, unknown> = {
    target_chapter: chapter,
    ...(currentVolume !== null ? { volume: currentVolume } : {}),
    ...(arc?.core_question ? { current_arc_tension: arc.core_question } : {}),
    ...(arc?.antagonist_agent ? { current_antagonist_agent: arc.antagonist_agent } : {}),
    word_count_range: wordCountRange,
    chapter_outline: chapterOutline,
    world_rules: worldRules,
    style_directive: styleDirective,
    ...(personaCard ? { persona: personaCard.body } : {}),
    style_examples: styleExamples,
    ...(craftPackHints.length > 0 ? { craft_pack_hints: craftPackHints } : {}),
    previous_chapter_briefs: briefs,
    through_line_anchor: throughLineAnchor,
    arc_summaries: arcSummaries,
    character_cards: characterCards,
    ...(charactersWithoutCards.length > 0
      ? { characters_without_cards: charactersWithoutCards }
      : {}),
    ...(plannedStateChanges.length > 0 ? { planned_state_changes: plannedStateChanges } : {}),
    character_relationships: characterRelationships,
    derived_relationships: derivedRelationships,
    foreshadowing_due: foreshadowingDue,
    storyline_focus: storylineFocus,
    semantic_context: semanticContext,
    // 只把连贯性预警随包喂写手；buildNotes（预算诊断）不进包、不刷写手注意力
    warnings,
  };

  // 总量预算只核包内实际内容（含连贯性 warnings）；buildNotes 不进包故不计入写手上下文
  const totalTokens = estimateBlockTokens(pack);
  if (totalTokens > TOTAL_BUDGET) {
    buildNotes.push(`上下文包总量约 ${totalTokens} token，超出 ${TOTAL_BUDGET} 预算`);
  }

  const packPath = join(
    ctx.projectRoot,
    ".narracat",
    "context-packs",
    `ch-${chapterFileSegment(chapter)}.json`,
  );
  await mkdir(dirname(packPath), { recursive: true });
  await writeFile(packPath, JSON.stringify(pack, null, 2), "utf-8");

  const volDirSegment = basename(dirname(outlinePath));

  // manuscript_path 语义：写作链的工作正文路径。已有 staging → staging；
  // 已完成成品且无 staging → 正式路径（/review 等旁路照常）；全新章 → staging（写手写入目标）。
  const stagingRel = join(".narracat", "staging", `ch-${chapterFileSegment(chapter)}.md`);
  let manuscriptPathOut = stagingRel;
  try {
    await access(join(ctx.projectRoot, stagingRel));
  } catch {
    const formal = await findManuscript(ctx.projectRoot, chapter);
    if (formal) {
      manuscriptPathOut = join("manuscript", volumeDirSegment(formal.volume), `ch-${chapterFileSegment(chapter)}.md`);
    }
  }

  return {
    ok: true,
    pack_path: packPath,
    outline_path: join("outline", volDirSegment, basename(outlinePath)),
    manuscript_path: manuscriptPathOut,
    word_count_range: wordCountRange,
    // 主会话（/write step-2）拿连贯性预警 + 系统诊断的全集；写手只拿包内 warnings
    warnings: [...warnings, ...buildNotes],
  };
}

// ============================================================
// novel_extraction_scaffold —— memory-keeper 专用只读抽取脚手架
// ============================================================

/** 12 个受控谓词常量（与 tools schema / memory-keeper 指令同源） */
const PREDICATE_CHEATSHEET = [
  "identity",
  "location",
  "possession",
  "goal",
  "injury",
  "ability",
  "status",
  "secret",
  "reputation",
  "oath",
  "debt",
  "relationship",
] as const;

/**
 * 抽取脚手架（纯只读）：把弱模型抽取所需的确定性参考一次性聚合。
 * - alias_table：bible/characters/*.md 解析的「canonical → 别名[] + uid」转置表，归一角色名
 * - known_facts_summary：前文（from_chapter < chapter）已入库的有效 facts 最近 30 条，判断 change_type
 * - predicate_cheatsheet：12 个受控谓词常量，选谓词
 * - dimension_cheatsheet：本书状态词表存在时按维度给谓词+值域提示（词表缺失时该键不出现，T4）
 * 不含任何写操作，不读章节正文（正文由 memory-keeper 自行 Read）。
 */
export async function novelExtractionScaffold(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const chapter = asPositiveInt(args["chapter"]);
  if (chapter === null) {
    return singleError(
      "chapter",
      "正整数（当前抽取的章节号）",
      describe(args["chapter"]),
      "传当前抽取章号，例如 chapter: 5",
    );
  }
  if (!ctx.projectRoot) {
    return singleError(
      "projectRoot",
      "可用的项目根目录",
      "缺失",
      "NOVEL_CONFIG_PATH 未指向有效项目",
    );
  }

  // alias_table：Map<name, {canonical, uid}> 转置为按 canonical 聚合的别名表
  const aliasMap = await loadAliasMap(ctx.projectRoot);
  const byCanonical = new Map<
    string,
    { canonical: string; aliases: string[]; uid: string | null }
  >();
  for (const [name, resolved] of aliasMap) {
    let entry = byCanonical.get(resolved.canonical);
    if (!entry) {
      entry = { canonical: resolved.canonical, aliases: [], uid: resolved.uid };
      byCanonical.set(resolved.canonical, entry);
    }
    if (name !== resolved.canonical) entry.aliases.push(name);
  }
  const alias_table = [...byCanonical.values()];

  // known_facts_summary：前文有效 facts（最近 30 条，时间倒序），轻量四字段
  // 注意：此处按 ingestion 轴且不引用 FACT_LATEST_ORDER_SQL（见 fact-temporal.ts 头注）；
  // §3.3「同章 authored 压 extracted」只作用于折叠/时点回溯读侧，抽取脚手架的前情提要有意不参与。
  const known_facts_summary = ctx.db
    .prepare(
      `SELECT subject, predicate, object, from_chapter FROM facts
       WHERE novel_id = ? AND from_chapter < ?
         AND (invalidated_at_chapter IS NULL OR invalidated_at_chapter > ?)
       ORDER BY from_chapter DESC, created_at DESC
       LIMIT 30`,
    )
    .all(ctx.novelId, chapter, chapter) as Array<{
    subject: string;
    predicate: string;
    object: string;
    from_chapter: number;
  }>;

  const predicate_cheatsheet = [...PREDICATE_CHEATSHEET];

  // dimension_cheatsheet：本书状态词表存在时，按维度给谓词+值域提示（spec §3.2：抽取入口仍写谓词层，
  // 维度归属由读侧机械完成；此块只是帮 memory-keeper 把 object 写进值域、少造同义词）
  const vocab = loadStateVocabulary(ctx.projectRoot);
  const dimension_cheatsheet = vocab
    ? vocab.dimensions.map((d) => ({
        key: d.key,
        display_name: d.display_name,
        predicate: d.predicate,
        cardinality: d.cardinality,
        value_type: d.value_type,
        ...(d.values ? { values: d.values } : {}),
      }))
    : undefined;

  const token_estimate = estimateBlockTokens({
    alias_table,
    known_facts_summary,
    predicate_cheatsheet,
    ...(dimension_cheatsheet ? { dimension_cheatsheet } : {}),
  });

  return {
    ok: true,
    chapter,
    alias_table,
    known_facts_summary,
    predicate_cheatsheet,
    ...(dimension_cheatsheet ? { dimension_cheatsheet } : {}),
    token_estimate,
  };
}

// ============================================================
// novel_get_character_dialogue_samples — 按角色取真实台词语料（声音支柱 A）
//
// A2 风格卡的取料读路径：按 character_uid 拉该角色截至某章的真实台词。
// 默认 limit 20，按 chapter / position 升序；total 反映全部匹配（截断前）。
// ============================================================

const DIALOGUE_TYPE_VALUES = new Set([
  "dialogue",
  "monologue",
  "thought",
  "action_narration",
]);

export async function novelGetCharacterDialogueSamples(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const characterUid =
    typeof args["character_uid"] === "string" ? (args["character_uid"] as string).trim() : "";
  if (!characterUid) {
    return singleError(
      "character_uid",
      "非空 character_uid",
      describe(args["character_uid"]),
      "必须提供要查询台词的角色 character_uid（机器主键，见 bible/characters/ 档案的 character_identity）",
    );
  }

  const chapterStart = asPositiveInt(args["chapter_start"]);
  const chapterEnd = asPositiveInt(args["chapter_end"]);
  const dialogueType =
    typeof args["dialogue_type"] === "string" &&
    DIALOGUE_TYPE_VALUES.has(args["dialogue_type"] as string)
      ? (args["dialogue_type"] as string)
      : null;
  const limit = asPositiveInt(args["limit"]) ?? 20;

  const where: string[] = ["novel_id = ?", "character_uid = ?"];
  const params: unknown[] = [ctx.novelId, characterUid];
  if (chapterStart !== null) {
    where.push("chapter >= ?");
    params.push(chapterStart);
  }
  if (chapterEnd !== null) {
    where.push("chapter <= ?");
    params.push(chapterEnd);
  }
  if (dialogueType) {
    where.push("dialogue_type = ?");
    params.push(dialogueType);
  }
  const whereSql = where.join(" AND ");

  const total = (
    ctx.db
      .prepare(`SELECT COUNT(*) AS c FROM character_dialogue_samples WHERE ${whereSql}`)
      .get(...params) as { c: number }
  ).c;

  const rows = ctx.db
    .prepare(
      `SELECT chapter, dialogue_text, dialogue_type, context, emotion, position_in_chapter
       FROM character_dialogue_samples
       WHERE ${whereSql}
       ORDER BY chapter ASC, position_in_chapter ASC, id ASC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    chapter: number;
    dialogue_text: string;
    dialogue_type: string;
    context: string | null;
    emotion: string | null;
    position_in_chapter: number | null;
  }>;

  const samples = rows.map((r) => ({
    chapter: r.chapter,
    dialogue_text: r.dialogue_text,
    dialogue_type: r.dialogue_type,
    ...(r.context ? { context: r.context } : {}),
    ...(r.emotion ? { emotion: r.emotion } : {}),
  }));

  return { ok: true, character_uid: characterUid, samples, total };
}

// ============================================================
// novel_pack_authoring_vocab — 造包中心词表/情境清单（App 专用，不进 agent 白名单）
// ============================================================
export async function novelPackAuthoringVocab(): Promise<unknown> {
  const { AUTHORING_EMOTION_TAGS, AUTHORING_TECHNIQUE_TAGS, loadTypicalScenarios, loadTypicalVoices } = await import("../packs/authoring.js");
  return {
    emotion_tags: AUTHORING_EMOTION_TAGS,
    technique_tags: AUTHORING_TECHNIQUE_TAGS,
    structure_stages: STRUCTURE_STAGES,
    scenarios: loadTypicalScenarios().map(({ id, name }) => ({ id, name })),
    voices: loadTypicalVoices().map(({ id, name }) => ({ id, name })),
  };
}

// ============================================================
// novel_pack_authoring_preview — 造包中心卡片干跑预览（App 专用，不进 agent 白名单）
// ============================================================
export async function novelPackAuthoringPreview(args: Record<string, unknown>): Promise<unknown> {
  const card = args["card"];
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    return singleError("card", "manifest 卡条目对象", String(card), "传入 { card: { type: persona|craft, ... } }");
  }
  const c = card as Record<string, unknown>;
  const type = c["type"];
  if (type !== "persona" && type !== "craft") {
    return singleError(
      "card.type",
      "persona | craft",
      String(type),
      "structure 卡装载预览由 App 本地映射；本工具只接受 card.type=persona 或 craft",
    );
  }

  const { previewCraftCard, previewPersonaCard } = await import("../packs/authoring.js");

  if (type === "craft") {
    const triggers = c["triggers"];
    if (!Array.isArray(triggers) || !triggers.every((t) => typeof t === "string")) {
      return singleError(
        "card.triggers",
        "字符串数组",
        JSON.stringify(triggers),
        "craft 卡需提供 triggers: string[]（选卡命中的触发词）",
      );
    }
    const emotionTags = c["emotion_tags"];
    if (!Array.isArray(emotionTags) || !emotionTags.every((t) => typeof t === "string")) {
      return singleError(
        "card.emotion_tags",
        "字符串数组",
        JSON.stringify(emotionTags),
        "craft 卡需提供 emotion_tags: string[]（无情绪标签传空数组 []）",
      );
    }
    const exclusions = c["exclusions"];
    if (!Array.isArray(exclusions) || !exclusions.every((t) => typeof t === "string")) {
      return singleError(
        "card.exclusions",
        "字符串数组",
        JSON.stringify(exclusions),
        "craft 卡需提供 exclusions: string[]（无排除词传空数组 []）",
      );
    }
    const results = previewCraftCard({
      id: String(c["id"] ?? ""),
      triggers,
      emotion_tags: emotionTags,
      exclusions,
      priority: typeof c["priority"] === "number" ? (c["priority"] as number) : 50,
    });
    return { type: "craft", results };
  }

  const keywords = c["keywords"];
  if (!Array.isArray(keywords) || !keywords.every((k) => typeof k === "string")) {
    return singleError(
      "card.keywords",
      "字符串数组",
      JSON.stringify(keywords),
      "persona 卡需提供 keywords: string[]（叙述声音关键词）",
    );
  }
  const results = previewPersonaCard({
    id: String(c["id"] ?? ""),
    name: String(c["name"] ?? ""),
    keywords,
  });
  return { type: "persona", results };
}
