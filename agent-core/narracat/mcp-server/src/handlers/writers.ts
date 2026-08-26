/**
 * 写工具实现（12 个）
 *
 * 每个 agent 只持有自己产物的提交工具：
 * - setup / write 主会话 : novel_submit_premise / novel_commit_extraction_union（多采样并集落库）
 * - memory-keeper       : novel_commit_chapter / novel_submit_extraction / novel_stage_extraction / novel_consolidate
 * - continuity-editor   : novel_submit_review
 * - outline-architect   : novel_submit_outline / novel_submit_chapter_outline
 * - 补登 / 修复          : novel_register_foreshadowing / novel_rollback_chapter
 *
 * 统一纪律：入口 ajv + 语义校验 → 通过整体写入 / 失败返回
 * { ok: false, errors: [{field, expected, actual, hint}] }；
 * 一切渲染产物（outline md / review md / 叙述者腔调节）由本文件从已验证数据机械生成。
 */

import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, readdir, mkdir, unlink, rmdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ftsInsert, ftsDelete, ftsDeleteBySourceIds } from "../utils/fts.js";
import { vecInsert, vecDelete, vecDeleteBySourceIds } from "../utils/vec.js";
import { embed } from "../utils/embedding.js";
import { foldCharacterCard, isEmptyFoldedCard } from "./character-card-fold.js";
import { revalidateVictimsOf } from "./fact-temporal.js";
import {
  validateCommitChapter,
  validateExtraction,
  validateConsolidate,
  validateReview,
  validateOutlinePayload,
  validateOutlineBookPayload,
  validateChapterOutlineBatch,
  validateForeshadowingItem,
  checkOutlineSemantics,
  checkOutlineBudget,
  checkStructureRhythm,
  checkDilemmaMilestones,
  checkForeshadowingPayoffTiming,
  checkChapterBatch,
  checkChapterProseHygiene,
  checkChapterWordCount,
  checkStateChanges,
  checkPayoffIntensityConsistency,
  checkOpeningRetention,
  checkOpeningArcPayoff,
  checkHookCadence,
  HOOK_CADENCE_THRESHOLDS,
  computeStructureBudget,
  validatePremise,
  checkPremiseSemantics,
  checkNarratorAddress,
  validateDialogueSamples,
} from "./validators.js";
import { renderChapterOutlineMarkdown } from "./chapter-outline-render.js";
import { loadStateVocabulary } from "./state-dimensions.js";
import { mirrorChapterPlannedState } from "./planned-state.js";
import { buildBenchmarkNote } from "./grid-benchmark.js";
import { narratorAddressPhrase } from "./narrator-address.js";
import type {
  OutlinePayload,
  ChapterOutlineItem,
  PremiseCardsPayload,
  PremiseCard,
  PremiseCardKey,
  PremiseField,
  PremiseCertainty,
  WordCountShortfall,
} from "./validators.js";
import {
  writeStructureToState,
  checkReviewFreshness,
  checkManuscriptContract,
  resolveWorkingManuscript,
  countWords,
  visibleBodyText,
  extractManuscriptSnippets,
  chapterFileSegment,
  volumeDirSegment,
  revertProgressToChapter,
} from "./state-sync.js";
import { errorResponse, singleError } from "../types.js";
import type {
  ToolContext,
  ToolErrorItem,
  ArcMetaRow,
  StorylineRow,
  ForeshadowingRegistryRow,
} from "../types.js";
import {
  loadAliasMap,
  normalizeName,
  resolveCharacterUid,
  relationshipSubject,
} from "./alias-map.js";

// ============================================================
// 共用辅助：伏笔生命周期
// ============================================================

interface RealizedPlant {
  chapter: number;
}

/** 查最早的已兑现 plant（status='realized'），用于 plant→develop 矫正 */
function findRealizedPlant(
  ctx: ToolContext,
  foreshadowingId: string,
  maxChapter: number,
): RealizedPlant | null {
  const row = ctx.db
    .prepare(
      `SELECT chapter FROM foreshadowing_actions_log
       WHERE novel_id = ? AND foreshadowing_id = ? AND action = 'plant'
         AND status = 'realized' AND chapter <= ?
       ORDER BY chapter LIMIT 1`,
    )
    .get(ctx.novelId, foreshadowingId, maxChapter) as { chapter: number } | undefined;
  return row ? { chapter: row.chapter } : null;
}

function registryIds(ctx: ToolContext): Set<string> {
  const rows = ctx.db
    .prepare(`SELECT id FROM foreshadowing_registry WHERE novel_id = ?`)
    .all(ctx.novelId) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

// ============================================================
// 共用辅助：角色状态卡机械折叠（latest-value per predicate）
// 折叠逻辑收敛于 character-card-fold.ts（SSOT，readers.ts 同源共用）
// ============================================================

/** 刷新一批角色（按 uid）的状态卡；返回实际写入的角色名。跨 handler 复用（见 character-entity.ts） */
export function refreshCharacterCards(
  ctx: ToolContext,
  characters: Iterable<{ uid: string; name: string }>,
  asOfChapter: number,
): string[] {
  const refreshed: string[] = [];
  const upsert = ctx.db.prepare(
    `INSERT INTO character_cards (novel_id, character_uid, character, as_of_chapter, card_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(novel_id, character_uid) DO UPDATE SET
       character = excluded.character,
       as_of_chapter = excluded.as_of_chapter,
       card_json = excluded.card_json`,
  );
  for (const { uid, name } of characters) {
    const card = foldCharacterCard(ctx, uid, asOfChapter);
    if (isEmptyFoldedCard(card)) continue;
    upsert.run(ctx.novelId, uid, name, asOfChapter, JSON.stringify(card));
    refreshed.push(name);
  }
  return refreshed;
}

// ============================================================
// novel_commit_chapter — 章节收尾一次性提交（memory-keeper）
// ============================================================

export async function novelCommitChapter(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const validation = validateCommitChapter(args);
  if (!validation.valid) return errorResponse(validation.errors);

  const chapter = args["chapter"] as number;

  // 机械合同门：staging 上的半成品不得进记忆（无 staging 免检，见 checkManuscriptContract）
  const contract = await checkManuscriptContract(ctx, chapter);
  if (contract && contract.errors.length > 0) return errorResponse(contract.errors);

  // 记忆写入门：审过之后又被改过的正文不得进记忆（无审校记录时放行，见 checkReviewFreshness）
  const freshnessErrors = await checkReviewFreshness(ctx, chapter, false);
  if (freshnessErrors) return errorResponse(freshnessErrors);

  const summary = args["summary"] as string;
  const anchor = args["anchor"] as { core_experience: string; heartbeat_moment: string };
  const keyEvents = args["key_events"] as string[];
  const charactersAppeared = args["characters_appeared"] as string[];
  const emotionalTone = args["emotional_tone"] as string;
  const continuationHook = args["continuation_hook"] as string[];
  const foreshadowingActions =
    (args["foreshadowing_actions"] as Array<{ id: string; action: "plant" | "develop" | "reveal" }> | undefined) ?? [];
  const timelineNote = (args["timeline_note"] as string | undefined) ?? null;

  // 机械补全：读工作正文实数（staging 优先，无 staging 落回正式路径）
  const manuscript = await resolveWorkingManuscript(ctx.projectRoot, chapter);
  if (!manuscript) {
    return singleError(
      "chapter",
      `manuscript/vol-VV/ch-${chapterFileSegment(chapter)}.md 存在`,
      "正文文件未找到",
      `第${chapter}章正文不存在：先确认 chapter-writer 已写入本章正文，再提交收尾`,
    );
  }
  // 字数与片段按可见正文计：chapter_metadata 注释是 App 元数据，不算正文
  const raw = await readFile(manuscript.path, "utf-8");
  const wordCount = countWords(visibleBodyText(raw));
  if (wordCount === 0) {
    return singleError(
      "chapter",
      "非空正文",
      "0 字",
      `第${chapter}章正文文件为空，先补写正文再提交收尾`,
    );
  }
  const { opening, ending } = extractManuscriptSnippets(raw);

  // 伏笔预检：id 必须已注册
  const knownIds = registryIds(ctx);
  const unknownErrors: ToolErrorItem[] = foreshadowingActions
    .filter((a) => !knownIds.has(a.id))
    .map((a) => ({
      field: "foreshadowing_actions",
      expected: "引用已注册的伏笔 id",
      actual: a.id,
      hint: `伏笔 ${a.id} 未注册：改用已注册 id，或先用 novel_register_foreshadowing 补登`,
    }));
  if (unknownErrors.length > 0) return errorResponse(unknownErrors);

  // 生命周期矫正：已有更早的兑现 plant → 本次 plant 矫正为 develop
  const lifecycleGuards: Array<Record<string, unknown>> = [];
  const resolvedActions = foreshadowingActions.map((a) => {
    if (a.action !== "plant") return a;
    const existing = findRealizedPlant(ctx, a.id, chapter - 1);
    if (!existing) return a;
    lifecycleGuards.push({
      guard: "duplicate_foreshadowing_plant_coerced",
      foreshadowing_id: a.id,
      existing_planted_chapter: existing.chapter,
      requested_chapter: chapter,
      coerced_to: "develop",
    });
    return { id: a.id, action: "develop" as const };
  });

  const aliasMap = await loadAliasMap(ctx.projectRoot);
  const characterRefs = charactersAppeared.map((raw) => ({
    character_uid: resolveCharacterUid(raw, aliasMap),
    name: normalizeName(raw, aliasMap),
  }));
  /*
   * 出场角色只入库解析得到 uid 的（不入库 null uid 引用）。**原先未建档即整单驳回**，与
   * relationship_updates 同一笔账：memory-keeper 没有建档权限，驳回只会让它剔掉名字重发整份
   * 收尾清单，真机第 23 章就白跑了一轮。改为跳过并点名，与本函数下方 checkChapterWordCount
   * 「finding-only，只标不阻断」的处置对齐。
   */
  const skippedCharacters = characterRefs.filter((c) => !c.character_uid).map((c) => c.name);
  const resolvedCharacterRefs = characterRefs.filter((c) => c.character_uid);

  const summaryId = randomUUID();
  const embedding = await embed(summary);

  const tx = ctx.db.transaction(() => {
    const existing = ctx.db
      .prepare(
        "SELECT id FROM chapter_summaries WHERE novel_id = ? AND chapter = ?",
      )
      .get(ctx.novelId, chapter) as { id: string } | undefined;
    if (existing) {
      ftsDelete(ctx.db, "chapter_summaries", existing.id);
      vecDelete(ctx.db, "chapter_summaries", existing.id);
      ctx.db.prepare("DELETE FROM chapter_summaries WHERE id = ?").run(existing.id);
    }

    ctx.db
      .prepare(
        `INSERT INTO chapter_summaries
           (id, novel_id, chapter, summary, characters, events, word_count,
            opening_snippet, ending_snippet, anchor_core, anchor_heartbeat,
            emotional_tone, continuation_hook, timeline_note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        summaryId,
        ctx.novelId,
        chapter,
        summary,
        JSON.stringify(resolvedCharacterRefs),
        JSON.stringify(keyEvents),
        wordCount,
        opening,
        ending,
        anchor.core_experience,
        anchor.heartbeat_moment,
        emotionalTone,
        JSON.stringify(continuationHook),
        timelineNote,
      );

    ftsInsert(ctx.db, summary, "chapter_summaries", summaryId, ctx.novelId, "episodic");
    if (embedding) {
      vecInsert(ctx.db, "chapter_summaries", summaryId, ctx.novelId, "episodic", embedding);
    }

    const insertAction = ctx.db.prepare(
      `INSERT OR IGNORE INTO foreshadowing_actions_log
         (novel_id, chapter, foreshadowing_id, action, status)
       VALUES (?, ?, ?, ?, 'realized')`,
    );
    for (const a of resolvedActions) {
      insertAction.run(ctx.novelId, chapter, a.id, a.action);
    }
  });
  tx();

  // 写 receipt 文件（SubagentStop 钩子核对它）
  const receiptPath = join(
    ctx.projectRoot,
    ".narracat",
    "receipts",
    `ch-${chapterFileSegment(chapter)}.json`,
  );
  const checklist = {
    chapter,
    word_count: wordCount,
    summary_chars: summary.length,
    anchor: true,
    key_events: keyEvents.length,
    // 只计真正入库的，被跳过的不充数
    characters_appeared: resolvedCharacterRefs.length,
    continuation_hook: continuationHook.length,
    foreshadowing_actions: resolvedActions.map((a) => `${a.id}:${a.action}`),
    timeline_note: timelineNote !== null,
    committed_at: new Date().toISOString(),
  };
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, JSON.stringify(checklist, null, 2), "utf-8");

  // 字数守卫（评价层 finding-only）：缺口只标注，不阻断收尾
  const wordCountShortfall = checkChapterWordCount(wordCount, ctx.wordsPerChapter);

  return {
    ok: true,
    chapter,
    word_count: wordCount,
    word_count_warning: wordCountShortfall ?? undefined,
    receipt: receiptPath,
    checklist,
    lifecycle_guards: lifecycleGuards.length > 0 ? lifecycleGuards : undefined,
    skipped_characters: skippedCharacters.length > 0 ? skippedCharacters : undefined,
    message:
      `第${chapter}章已收尾入库（${wordCount} 字，${resolvedActions.length} 条伏笔动作）` +
      (skippedCharacters.length > 0
        ? `；已跳过 ${skippedCharacters.length} 个未建档角色（${skippedCharacters.join("、")}）——需要它们进记忆的话，补档案后重提，不必为此重发本次收尾`
        : "") +
      (wordCountShortfall
        ? `；⚠️ 低于字数目标（${wordCountShortfall.actual}/${wordCountShortfall.target}，${Math.round(wordCountShortfall.ratio * 100)}%）`
        : ""),
  };
}

// ============================================================
// 抽取共享层：UID 解析 / 共享落库（novel_submit_extraction / novel_stage_extraction /
// novel_commit_extraction_union 三个写工具共用同一套校验、归一与落库逻辑）
// ============================================================

interface ExtractionFact {
  subject: string;
  predicate: string;
  object: string;
  change_type: "new" | "update" | "invalidate";
  upsert_key?: string;
}

/** 已归一 + 已 UID 解析的事实；extraction_stage.facts_json 即此结构的数组序列化。 */
interface ResolvedFact extends ExtractionFact {
  subject_character_uid: string | null;
  subject_character_b_uid: string | null;
}

/**
 * 把原始 facts + relationship_updates 归一、UID 解析、relationship 折算为 ResolvedFact[]。
 * 返回 facts + 实际折算进去的关系条数 + 累积的 warnings（不再有整单驳回这条路）。
 */
async function resolveExtractionFacts(
  rawFacts: ExtractionFact[],
  relationshipUpdates: Array<{ a: string; b: string; state: string }>,
  ctx: ToolContext,
): Promise<{ facts: ResolvedFact[]; relationshipsApplied: number; warnings: string[] }> {
  const aliasMap = await loadAliasMap(ctx.projectRoot);
  const warnings: string[] = [];

  /*
   * 关系两端都建了档才折算得出 uid。这里**原先是整单驳回**——一条关系不合格，整份事实清单
   * 一条都不落。真机实测（第 23 章）证明这笔买卖不划算：memory-keeper 没有建档权限，驳回换
   * 来的唯一结果是它剔掉那条、把整份清单重新生成并重发一遍。当章新登场五个未建档角色，三个
   * 暂存 agent 加一个收尾 agent 各白跑一轮；其中一次重发还漏掉了 run_id，撞上 schema 校验
   * 直接失败。而驳回文案写的是「确认角色名与档案一致」，假设的是名字写错——对真·新登场角色
   * 完全没用。
   *
   * 改为跳过该条并点名。这也让同一个函数里的两套标准归一：下方「非关系事实主体未建档」本来
   * 就是只 warning、照常入库。
   */
  const usableRels = relationshipUpdates.filter((rel) => {
    if (resolveCharacterUid(rel.a, aliasMap) && resolveCharacterUid(rel.b, aliasMap)) return true;
    warnings.push(
      `关系「${rel.a}—${rel.b}」已跳过：至少一端未建档（未解析到 character_uid）。两人都该有档案的话，补 bible/characters/ 档案的 character_identity 后重提；确属新登场角色则先登记为候选角色，不必为此重发本次清单`,
    );
    return false;
  });

  // 归一 + uid 解析 + relationship 折算为 facts
  const facts: ResolvedFact[] = rawFacts.map((f) => {
    if (f.predicate === "relationship" && f.subject.includes("|")) {
      const parts = f.subject
        .split("|")
        .map((n) => normalizeName(n, aliasMap))
        .sort();
      return {
        ...f,
        subject: parts.join("|"),
        subject_character_uid: resolveCharacterUid(parts[0] ?? "", aliasMap),
        subject_character_b_uid: parts[1] ? resolveCharacterUid(parts[1], aliasMap) : null,
      };
    }
    return {
      ...f,
      subject: normalizeName(f.subject, aliasMap),
      subject_character_uid: resolveCharacterUid(f.subject, aliasMap),
      subject_character_b_uid: null,
    };
  });
  for (const rel of usableRels) {
    const nameA = normalizeName(rel.a, aliasMap);
    const nameB = normalizeName(rel.b, aliasMap);
    const swap = nameA > nameB;
    facts.push({
      subject: relationshipSubject(nameA, nameB),
      subject_character_uid: swap
        ? resolveCharacterUid(rel.b, aliasMap)
        : resolveCharacterUid(rel.a, aliasMap),
      subject_character_b_uid: swap
        ? resolveCharacterUid(rel.a, aliasMap)
        : resolveCharacterUid(rel.b, aliasMap),
      predicate: "relationship",
      object: rel.state,
      change_type: "update",
    });
  }

  for (const f of facts) {
    if (f.predicate.startsWith("x-")) {
      warnings.push(`谓词 ${f.predicate} 在受控词表之外（x- 扩展），已入库但建议优先用 12 词表`);
    }
    // 非关系事实主体未匹配已建档角色：可能是势力/物件（合理），也可能是写错的角色名（漏存）
    if (f.predicate !== "relationship" && f.subject_character_uid === null) {
      warnings.push(
        `主体「${f.subject}」未匹配已建档角色（character_uid 为空）：若为角色请补 bible/characters/ 档案 character_identity，若为势力/物件可忽略`,
      );
    }
  }

  return { facts, relationshipsApplied: usableRels.length, warnings };
}

/**
 * 共享落库：把已解析的 ResolvedFact[] 写入正式 facts 表（事务内 findExisting →
 * invalidate/insert + FTS/vec 索引）。embedding 在事务外预生成（invalidate 不 embed）。
 * novel_submit_extraction 与 novel_commit_extraction_union 共用此函数，行为一致。
 * 落库时新增的 warnings（update/invalidate 未命中）追加进传入的 warnings 数组。
 */
async function commitResolvedFacts(
  facts: ResolvedFact[],
  chapter: number,
  ctx: ToolContext,
  warnings: string[],
): Promise<{ stored: number; invalidated: number }> {
  // 预生成 embedding（事务外）
  const inserts: Array<{
    fact: ResolvedFact;
    id: string;
    content: string;
    embedding: Float32Array | null;
  }> = [];
  for (const f of facts) {
    if (f.change_type === "invalidate") continue;
    const content = `${f.subject} ${f.predicate} ${f.object}`;
    inserts.push({
      fact: f,
      id: randomUUID(),
      content,
      embedding: await embed(content),
    });
  }
  const insertByFact = new Map(inserts.map((i) => [i.fact, i]));

  let stored = 0;
  let invalidated = 0;

  const findExisting = (f: ResolvedFact): { id: string } | undefined => {
    if (f.upsert_key) {
      const byId = ctx.db
        .prepare(
          `SELECT id FROM facts
           WHERE novel_id = ? AND id = ? AND invalidated_at_chapter IS NULL`,
        )
        .get(ctx.novelId, f.upsert_key) as { id: string } | undefined;
      if (byId) return byId;
    }
    return ctx.db
      .prepare(
        `SELECT id FROM facts
         WHERE novel_id = ? AND subject = ? AND predicate = ?
           AND invalidated_at_chapter IS NULL
         ORDER BY from_chapter DESC, created_at DESC LIMIT 1`,
      )
      .get(ctx.novelId, f.subject, f.predicate) as { id: string } | undefined;
  };

  const tx = ctx.db.transaction(() => {
    const invalidate = ctx.db.prepare(
      `UPDATE facts SET invalidated_at_chapter = ?, invalidated_by = ?, updated_at = datetime('now')
       WHERE id = ? AND novel_id = ?`,
    );
    const insert = ctx.db.prepare(
      `INSERT INTO facts (id, novel_id, subject, subject_character_uid, subject_character_b_uid, predicate, object, sector, from_chapter, event_chapter, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'semantic', ?, ?, 'extracted')`,
    );

    for (const f of facts) {
      if (f.change_type === "update" || f.change_type === "invalidate") {
        const existing = findExisting(f);
        if (existing) {
          // update 的旧值被新 fact 取代 → invalidated_by 指向新 fact id；invalidate 无取代者 → null
          const replacedBy =
            f.change_type === "update" ? (insertByFact.get(f)?.id ?? null) : null;
          invalidate.run(chapter, replacedBy, existing.id, ctx.novelId);
          invalidated += 1;
        } else if (f.change_type === "invalidate") {
          warnings.push(
            `invalidate 未命中：${f.subject} ${f.predicate} 没有可失效的旧值，已跳过`,
          );
          continue;
        } else {
          warnings.push(`update 未命中旧值：${f.subject} ${f.predicate} 按新事实入库`);
        }
      }
      if (f.change_type === "invalidate") continue;

      const op = insertByFact.get(f);
      if (!op) continue;
      insert.run(
        op.id,
        ctx.novelId,
        f.subject,
        f.subject_character_uid,
        f.subject_character_b_uid,
        f.predicate,
        f.object,
        chapter, // from_chapter（ingestion：记录章）
        chapter, // event_chapter 默认 = from_chapter（倒叙填充留后续）
      );
      ftsInsert(ctx.db, op.content, "facts", op.id, ctx.novelId, "semantic");
      if (op.embedding) {
        vecInsert(ctx.db, "facts", op.id, ctx.novelId, "semantic", op.embedding);
      }
      stored += 1;
    }
  });
  tx();

  return { stored, invalidated };
}

// ============================================================
// novel_submit_extraction — 事实变更清单提交（memory-keeper；/rewrite、追溯回填等一次性场景）
// ============================================================

export async function novelSubmitExtraction(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const validation = validateExtraction(args);
  if (!validation.valid) return errorResponse(validation.errors);

  const chapter = args["chapter"] as number;

  // 机械合同门：staging 上的半成品不得进记忆（无 staging 免检，见 checkManuscriptContract）
  const contract = await checkManuscriptContract(ctx, chapter);
  if (contract && contract.errors.length > 0) return errorResponse(contract.errors);

  // 记忆写入门：审过之后又被改过的正文不得进记忆（无审校记录时放行，见 checkReviewFreshness）
  const freshnessErrors = await checkReviewFreshness(ctx, chapter, false);
  if (freshnessErrors) return errorResponse(freshnessErrors);

  const rawFacts = args["facts"] as ExtractionFact[];
  const relationshipUpdates =
    (args["relationship_updates"] as Array<{ a: string; b: string; state: string }> | undefined) ?? [];

  const resolved = await resolveExtractionFacts(rawFacts, relationshipUpdates, ctx);
  const warnings = resolved.warnings;
  const { stored, invalidated } = await commitResolvedFacts(
    resolved.facts,
    chapter,
    ctx,
    warnings,
  );

  return {
    ok: true,
    chapter,
    facts_stored: stored,
    facts_invalidated: invalidated,
    // 报实际折算进去的条数，不报入参条数——跳过了却报「已更新」就是骗调用方
    relationships_updated: resolved.relationshipsApplied,
    warnings,
    message: `第${chapter}章事实变更已入库（新增 ${stored} / 失效 ${invalidated}）`,
  };
}

// ============================================================
// novel_stage_extraction — 单轮抽取暂存（memory-keeper；多采样并集的一轮）
//
// 与 submit 同一套校验 + UID 解析，但把 ResolvedFact[] 序列化入 extraction_stage 暂存，
// 不写正式 facts、不建索引、不调 embed。K 轮各调一次（带 run_id），最后由
// novel_commit_extraction_union 取并集一次落库。
// ============================================================

export async function novelStageExtraction(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const runId = args["run_id"];
  if (typeof runId !== "number" || !Number.isInteger(runId) || runId < 1 || runId > 9) {
    return singleError(
      "run_id",
      "integer 1-9",
      `${typeof runId}: ${JSON.stringify(runId)}`,
      "传入本轮抽取的 run_id（任务 envelope 里给定，照传，1-9）",
    );
  }

  const validation = validateExtraction(args);
  if (!validation.valid) return errorResponse(validation.errors);

  const chapter = args["chapter"] as number;
  const rawFacts = args["facts"] as ExtractionFact[];
  const relationshipUpdates =
    (args["relationship_updates"] as Array<{ a: string; b: string; state: string }> | undefined) ?? [];

  const resolved = await resolveExtractionFacts(rawFacts, relationshipUpdates, ctx);

  // upsert：同一 (novel_id, chapter, run_id) 重试/恢复覆盖既有暂存，不留陈旧行被并集重复计
  ctx.db
    .prepare(
      `INSERT INTO extraction_stage (id, novel_id, chapter, run_id, facts_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(novel_id, chapter, run_id) DO UPDATE SET
         facts_json = excluded.facts_json,
         created_at = datetime('now')`,
    )
    .run(randomUUID(), ctx.novelId, chapter, runId, JSON.stringify(resolved.facts));

  return {
    ok: true,
    chapter,
    run_id: runId,
    staged: resolved.facts.length,
    warnings: resolved.warnings,
    message: `第${chapter}章第${runId}轮抽取已暂存（${resolved.facts.length} 条候选事实，未入正式记忆）`,
  };
}

// ============================================================
// novel_commit_extraction_union — 多采样并集落库（主会话；读 K 份暂存全等去重后一次写库）
// ============================================================

/** 跨样本冲突取更强信号：invalidate > update > new。 */
const CHANGE_TYPE_RANK: Record<ExtractionFact["change_type"], number> = {
  new: 0,
  update: 1,
  invalidate: 2,
};

export async function novelCommitExtractionUnion(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const chapter = args["chapter"];
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter < 1) {
    return singleError(
      "chapter",
      "integer ≥ 1",
      `${typeof chapter}: ${JSON.stringify(chapter)}`,
      "传入要落并集的章号",
    );
  }

  // 机械合同门：staging 上的半成品不得进记忆（无 staging 免检，见 checkManuscriptContract）
  const contract = await checkManuscriptContract(ctx, chapter);
  if (contract && contract.errors.length > 0) return errorResponse(contract.errors);

  // 记忆写入门：审过之后又被改过的正文不得进记忆（无审校记录时放行，见 checkReviewFreshness）
  const freshnessErrors = await checkReviewFreshness(ctx, chapter, false);
  if (freshnessErrors) return errorResponse(freshnessErrors);

  const rows = ctx.db
    .prepare(
      `SELECT facts_json FROM extraction_stage WHERE novel_id = ? AND chapter = ?`,
    )
    .all(ctx.novelId, chapter) as Array<{ facts_json: string }>;

  const warnings: string[] = [];
  const stagedRuns = rows.length;

  if (stagedRuns === 0) {
    // 三轮抽取均未暂存（疑似全部失败/跳过）——本章未沉淀任何事实，收尾不应据此判定完成
    warnings.push(
      "该章无任何暂存事实：抽取暂存为空（疑似各轮均失败或被跳过），本章未沉淀事实",
    );
  }

  // 反序列化 + 全等去重（key = subject | predicate | object）；冲突取更强 change_type
  // subject 已 normalizeName 归一、relationship 已字典序折成 "A|B"，天然区分两端身份，
  // 直接作键即规范形式——不可改用 subject_character_uid（关系只取 A 端 uid，会把 A-B 与 A-C 误并丢一条）
  const union = new Map<string, ResolvedFact>();
  let totalCandidates = 0;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.facts_json);
    } catch {
      warnings.push("一份暂存的 facts_json 解析失败，已跳过");
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const raw of parsed as ResolvedFact[]) {
      totalCandidates += 1;
      const key = `${raw.subject}|${raw.predicate}|${raw.object}`;
      const prev = union.get(key);
      if (!prev) {
        union.set(key, raw);
      } else if (CHANGE_TYPE_RANK[raw.change_type] > CHANGE_TYPE_RANK[prev.change_type]) {
        // 同一三元组取更强信号；保留更强 change_type 的那条（其余字段同构）
        union.set(key, raw);
      }
    }
  }

  const facts = [...union.values()];
  const deduped = totalCandidates - facts.length;

  let stored = 0;
  let invalidated = 0;
  if (facts.length > 0) {
    const result = await commitResolvedFacts(facts, chapter, ctx, warnings);
    stored = result.stored;
    invalidated = result.invalidated;
  }

  // 清空该章暂存（落库后；幂等：再次 commit 该章返回 staged_runs=0）
  ctx.db
    .prepare(`DELETE FROM extraction_stage WHERE novel_id = ? AND chapter = ?`)
    .run(ctx.novelId, chapter);

  return {
    ok: true,
    chapter,
    staged_runs: stagedRuns,
    facts_committed: stored,
    facts_invalidated: invalidated,
    facts_deduped: deduped,
    warnings,
    message: `第${chapter}章并集已落库（${stagedRuns} 轮暂存，新增 ${stored} / 失效 ${invalidated} / 全等去重 ${deduped}）`,
  };
}

// ============================================================
// novel_consolidate — arc/卷压缩摘要 + 角色卡刷新（memory-keeper）
// ============================================================

export async function novelConsolidate(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const validation = validateConsolidate(args);
  if (!validation.valid) return errorResponse(validation.errors);

  const scope = args["scope"] as "arc" | "volume";
  const scopeId = args["scope_id"] as string;
  const summary = args["summary"] as string;
  const warnings: string[] = [];

  // 解析章节区间
  let chapterStart: number;
  let chapterEnd: number;
  if (scope === "arc") {
    const arc = ctx.db
      .prepare(
        `SELECT chapter_start, chapter_end FROM arc_meta WHERE novel_id = ? AND arc_id = ?`,
      )
      .get(ctx.novelId, scopeId) as { chapter_start: number; chapter_end: number } | undefined;
    if (!arc) {
      const known = (
        ctx.db
          .prepare(`SELECT arc_id FROM arc_meta WHERE novel_id = ? ORDER BY chapter_start`)
          .all(ctx.novelId) as Array<{ arc_id: string }>
      ).map((r) => r.arc_id);
      return singleError(
        "scope_id",
        "已注册的 arc_id",
        scopeId,
        `arc ${scopeId} 不存在。可用 arc_id：${known.join(", ") || "(空，先提交书级大纲)"}`,
      );
    }
    chapterStart = arc.chapter_start;
    chapterEnd = arc.chapter_end;
  } else {
    const m = scopeId.match(/^vol-0*(\d+)$/) ?? scopeId.match(/^0*(\d+)$/);
    if (!m) {
      return singleError(
        "scope_id",
        'scope=volume 时形如 "vol-01"',
        scopeId,
        '卷标识用 "vol-NN" 形态（如 "vol-01"）',
      );
    }
    const volumeNo = parseInt(m[1], 10);
    const range = ctx.db
      .prepare(
        `SELECT MIN(chapter_start) AS s, MAX(chapter_end) AS e
         FROM arc_meta WHERE novel_id = ? AND volume_no = ?`,
      )
      .get(ctx.novelId, volumeNo) as { s: number | null; e: number | null };
    if (range.s === null || range.e === null) {
      return singleError(
        "scope_id",
        "已提交大纲的卷号",
        scopeId,
        `第 ${volumeNo} 卷没有任何 arc 记录：先用 novel_submit_outline 提交该卷大纲`,
      );
    }
    chapterStart = range.s;
    chapterEnd = range.e;
  }

  const len = summary.length;
  if (scope === "arc" && (len < 300 || len > 500)) {
    warnings.push(`arc 摘要建议 300-500 字（当前 ${len} 字）`);
  }
  if (scope === "volume" && (len < 500 || len > 800)) {
    warnings.push(`卷摘要建议 500-800 字（当前 ${len} 字）`);
  }

  const embedding = await embed(summary);
  const sourceId = `${scope}:${scopeId}`;

  let refreshed: string[] = [];
  const tx = ctx.db.transaction(() => {
    ftsDelete(ctx.db, "arc_summaries", sourceId);
    vecDelete(ctx.db, "arc_summaries", sourceId);
    ctx.db
      .prepare(
        `INSERT INTO arc_summaries (novel_id, scope, scope_id, chapter_start, chapter_end, summary)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(novel_id, scope, scope_id) DO UPDATE SET
           chapter_start = excluded.chapter_start,
           chapter_end = excluded.chapter_end,
           summary = excluded.summary,
           created_at = datetime('now')`,
      )
      .run(ctx.novelId, scope, scopeId, chapterStart, chapterEnd, summary);
    ftsInsert(ctx.db, summary, "arc_summaries", sourceId, ctx.novelId, "episodic");
    if (embedding) {
      vecInsert(ctx.db, "arc_summaries", sourceId, ctx.novelId, "episodic", embedding);
    }

    // 区间内出场角色 → 机械折叠刷新状态卡
    const rows = ctx.db
      .prepare(
        `SELECT characters FROM chapter_summaries
         WHERE novel_id = ? AND chapter BETWEEN ? AND ?`,
      )
      .all(ctx.novelId, chapterStart, chapterEnd) as Array<{ characters: string }>;
    const characters = new Map<string, { uid: string; name: string }>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.characters) as unknown;
        if (Array.isArray(parsed)) {
          for (const ref of parsed) {
            const uid =
              ref && typeof ref === "object"
                ? (ref as { character_uid?: unknown }).character_uid
                : undefined;
            if (typeof uid === "string" && uid.trim()) {
              const nm = (ref as { name?: unknown }).name;
              characters.set(uid.trim(), {
                uid: uid.trim(),
                name: typeof nm === "string" && nm.trim() ? nm.trim() : uid.trim(),
              });
            }
          }
        }
      } catch {
        // 单行损坏不阻断
      }
    }
    refreshed = refreshCharacterCards(ctx, characters.values(), chapterEnd);
  });
  tx();

  return {
    ok: true,
    scope,
    scope_id: scopeId,
    chapter_start: chapterStart,
    chapter_end: chapterEnd,
    character_cards_refreshed: refreshed,
    warnings,
    message: `${scope === "arc" ? "arc" : "卷"} ${scopeId} 摘要已入库，刷新 ${refreshed.length} 张角色卡`,
  };
}

// ============================================================
// novel_submit_review — 审校结果提交 + 报告机械渲染（continuity-editor）
// ============================================================

interface ReviewIssue {
  severity: "blocker" | "note";
  where: string;
  what: string;
  fix_hint: string;
}

interface ReviewReport {
  chapter: number;
  verdict: "pass" | "fail";
  issues: ReviewIssue[];
  /** 工具机械补充：成稿可见正文字数（剥 chapter_metadata；正文缺失时无此字段） */
  word_count?: number;
  /** 工具机械补充：字数缺口（低于目标 70% 时在场；finding-only，不影响 verdict） */
  word_count_warning?: WordCountShortfall;
  /** 工具机械补充：提交审校时正文文件全文 SHA-256（正文缺失时无此字段；novel_update_progress 新鲜度硬门依据） */
  reviewed_manuscript_sha256?: string;
}

export async function novelSubmitReview(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const validation = validateReview(args);
  if (!validation.valid) return errorResponse(validation.errors);

  const chapter = args["chapter"] as number;
  const issues = args["issues"] as ReviewIssue[];

  // 字数守卫（评价层 finding-only）：机械度量成稿字数缺口，写进报告顶层独立字段——
  // 不混入 continuity-editor 的 issues（机械度量不是「存疑」判断），不影响 verdict；
  // 正文缺失时静默跳过（不给审校提交新增失败模式）。字数按可见正文计（剥 chapter_metadata）。
  let wordCount: number | undefined;
  let shortfall: ReturnType<typeof checkChapterWordCount> = null;
  let manuscriptSha256: string | undefined;
  // 审校指纹必须对工作正文（staging 优先）取 hash：staging 阶段的审校要绑定草稿版本
  const manuscript = await resolveWorkingManuscript(ctx.projectRoot, chapter);
  if (manuscript) {
    const content = await readFile(manuscript.path, "utf-8");
    wordCount = countWords(visibleBodyText(content));
    shortfall = checkChapterWordCount(wordCount, ctx.wordsPerChapter);
    // 审校新鲜度指纹：对文件原始内容整体取 hash（不剥 metadata——任何字节变化都应使旧审校失效）
    manuscriptSha256 = createHash("sha256").update(content, "utf8").digest("hex");
  }

  // verdict 代码计算：任一 blocker → fail
  const blockers = issues.filter((i) => i.severity === "blocker");
  const notes = issues.filter((i) => i.severity === "note");
  const verdict: "pass" | "fail" = blockers.length > 0 ? "fail" : "pass";

  // 结构化数据契约落盘：App 经 data-source 读取渲染（ADR-0018，不再渲染 markdown 本体）
  const report: ReviewReport = {
    chapter,
    verdict,
    issues,
    ...(wordCount !== undefined ? { word_count: wordCount } : {}),
    ...(shortfall ? { word_count_warning: shortfall } : {}),
    ...(manuscriptSha256 !== undefined ? { reviewed_manuscript_sha256: manuscriptSha256 } : {}),
  };
  const reportPath = join(
    ctx.projectRoot,
    "reviews",
    `ch-${chapterFileSegment(chapter)}-review.json`,
  );
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  // 路由信号入库（novel_get_review 读取）
  ctx.db
    .prepare(
      `INSERT INTO chapter_reviews (novel_id, chapter, verdict, issues_json, reviewed_manuscript_sha256)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(novel_id, chapter) DO UPDATE SET
         verdict = excluded.verdict,
         issues_json = excluded.issues_json,
         reviewed_manuscript_sha256 = excluded.reviewed_manuscript_sha256,
         created_at = datetime('now')`,
    )
    .run(ctx.novelId, chapter, verdict, JSON.stringify(issues), manuscriptSha256 ?? null);

  return {
    ok: true,
    chapter,
    verdict,
    blockers,
    notes_count: notes.length,
    word_count: wordCount,
    word_count_warning: shortfall ?? undefined,
    report_path: reportPath,
    message:
      `第${chapter}章审校结果 ${verdict.toUpperCase()}（blocker ${blockers.length} / note ${notes.length}）` +
      (shortfall ? `；⚠️ 字数缺口 ${shortfall.actual}/${shortfall.target}（${Math.round(shortfall.ratio * 100)}%）` : ""),
  };
}

// ============================================================
// 审校契约 backfill — 存量 chapter_reviews 重灌 ch-NNN-review.json（幂等）
// ============================================================

export async function backfillReviewArtifacts(ctx: ToolContext): Promise<void> {
  const rows = ctx.db
    .prepare(
      `SELECT chapter, verdict, issues_json, reviewed_manuscript_sha256
       FROM chapter_reviews WHERE novel_id = ?`,
    )
    .all(ctx.novelId) as Array<{
    chapter: number;
    verdict: "pass" | "fail";
    issues_json: string;
    reviewed_manuscript_sha256: string | null;
  }>;

  for (const row of rows) {
    const reportPath = join(
      ctx.projectRoot,
      "reviews",
      `ch-${chapterFileSegment(row.chapter)}-review.json`,
    );
    if (existsSync(reportPath)) continue;

    let issues: ReviewIssue[] = [];
    try {
      const parsed = JSON.parse(row.issues_json) as unknown;
      if (Array.isArray(parsed)) issues = parsed as ReviewIssue[];
    } catch {
      // 损坏的 issues_json 按空清单处理（verdict 仍有效）
    }

    // 指纹随行重灌：丢了它，重灌出的报告会让新鲜度门永远判「无指纹的旧审校」而误要求重审
    const report: ReviewReport = {
      chapter: row.chapter,
      verdict: row.verdict,
      issues,
      ...(row.reviewed_manuscript_sha256
        ? { reviewed_manuscript_sha256: row.reviewed_manuscript_sha256 }
        : {}),
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  }
}

// ============================================================
// novel_submit_premise — 立项卡提交（setup 主会话）
//
// 立项卡结构化真相归引擎（premise_cards 表 cards_json）；premise.md 由工具机械
// 渲染为只读视图，DTO 投影到 bible/premise-cards.json（App 经数据契约读取）。
// 渲染套审校/大纲同模式：单一写入口、机械渲染、不解析人读 markdown 反推（ADR-0018/0019）。
//
// 叙述声音卡（narrator_voice）的 field.key 用英文（archetype/tone/...），premise.md
// 「## 8 叙述声音」节按英文 key 行渲染，保 readNarratorVoiceFromBible 解析兼容——
// novel_submit_outline 渲染 master-outline 腔调节仍读 premise.md（ADR-0019）。
// ============================================================

const PREMISE_CARD_ORDER: PremiseCardKey[] = [
  "genre_contract",
  "core_hook",
  "golden_finger",
  "protagonist_desire",
  "antagonistic_force",
  "central_dramatic_question",
  "world_rules",
  "narrator_voice",
];

const PREMISE_CARD_TITLES: Record<PremiseCardKey, string> = {
  genre_contract: "题材读者契约",
  core_hook: "核心钩子",
  golden_finger: "金手指与爽点引擎",
  protagonist_desire: "主角欲望与代价",
  antagonistic_force: "对抗力量",
  central_dramatic_question: "中心戏剧问题",
  world_rules: "世界规则可冲突性",
  narrator_voice: "叙述声音",
};

/** 子字段卡的 field.key → 中文标签（premise.md 人读视图渲染用） */
const PREMISE_FIELD_LABELS: Record<string, string> = {
  // 题材读者契约
  subgenre: "细分题材",
  reader_expectation: "读者默认期待",
  surprise_point: "本书超预期点",
  emotional_tone: "情绪基调",
  // 金手指与爽点引擎
  ability: "能力",
  limit: "限制",
  growth: "成长性",
  feedback_loop: "反馈回路",
  sustains_conflict: "为何不消灭冲突",
  // 主角欲望与代价
  surface_want: "表层想要",
  deep_need: "深层需要",
  cost: "付出代价",
  bottom_line: "底线",
};

/** 单段卡：无子字段标签，直接渲染 value 段落 */
const PREMISE_PROSE_CARDS = new Set<PremiseCardKey>([
  "core_hook",
  "antagonistic_force",
  "central_dramatic_question",
]);

/** 非 canon（含未标注视为 canon）才标注，供 agent 识别暂定/留白；canon 不标 */
function premiseCertaintyTag(certainty?: PremiseCertainty): string {
  if (!certainty || certainty === "canon") return "";
  return ` [${certainty}]`;
}

/**
 * 立项卡机械渲染为只读 premise.md。九卡按固定序渲染；缺卡安静跳过（降级不报错）。
 * 第 9「留白声明」由各条 certainty 自动汇总，不读手写。
 */
export function renderPremiseMarkdown(payload: PremiseCardsPayload): string {
  const byCard = new Map<PremiseCardKey, PremiseField[]>();
  for (const card of payload.cards) byCard.set(card.card, card.fields);

  const lines: string[] = ["# 立项卡", ""];

  PREMISE_CARD_ORDER.forEach((cardKey, index) => {
    const fields = byCard.get(cardKey);
    if (!fields || fields.length === 0) return;
    lines.push(`## ${index + 1} ${PREMISE_CARD_TITLES[cardKey]}`, "");

    if (cardKey === "narrator_voice") {
      // 英文 key 行，兼容 readNarratorVoiceFromBible：不加确定度标注，保持纯净 value
      for (const f of fields) {
        if (f.key === "reference_example") {
          lines.push(`- source_excerpt: ${f.value.trim()}`);
          if (f.note && f.note.trim()) lines.push(`  mechanism_note: ${f.note.trim()}`);
        } else {
          lines.push(`- ${f.key}: ${f.value.trim()}`);
        }
      }
      lines.push("");
      return;
    }

    if (cardKey === "world_rules") {
      // 每条：规则本身（value） —— 让谁和谁打起来（note）
      for (const f of fields) {
        const conflict = f.note && f.note.trim() ? ` —— ${f.note.trim()}` : "";
        lines.push(`- ${f.value.trim()}${conflict}${premiseCertaintyTag(f.certainty)}`);
      }
      lines.push("");
      return;
    }

    if (PREMISE_PROSE_CARDS.has(cardKey)) {
      for (const f of fields) {
        lines.push(`${f.value.trim()}${premiseCertaintyTag(f.certainty)}`, "");
      }
      return;
    }

    // 子字段卡：中文标签: value
    for (const f of fields) {
      const label = PREMISE_FIELD_LABELS[f.key] ?? f.key;
      lines.push(`- ${label}: ${f.value.trim()}${premiseCertaintyTag(f.certainty)}`);
    }
    lines.push("");
  });

  // 第 9 卡：留白声明（自动汇总 tentative / open）
  const tentative: string[] = [];
  const open: string[] = [];
  for (const cardKey of PREMISE_CARD_ORDER) {
    const fields = byCard.get(cardKey);
    if (!fields) continue;
    for (const f of fields) {
      const certainty = f.certainty ?? "canon";
      if (certainty === "canon") continue;
      const label = PREMISE_FIELD_LABELS[f.key] ?? f.key;
      const ref = `${PREMISE_CARD_TITLES[cardKey]}·${label}`;
      if (certainty === "tentative") tentative.push(ref);
      else if (certainty === "open") open.push(ref);
    }
  }
  lines.push("## 9 留白声明", "");
  if (tentative.length === 0 && open.length === 0) {
    lines.push("（九卡均已定为 canon，暂无暂定或留白项）", "");
  } else {
    if (tentative.length > 0) lines.push(`- 暂定: ${tentative.join("、")}`);
    if (open.length > 0) lines.push(`- 留白: ${open.join("、")}`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// 立项卡内容与大纲引擎重叠的四项（subject='全书' facts）：地基卡定点修订时同步，
// 使 novel_submit_outline 写入的那份不变旧（ADR-0019）。stakes_progression 大纲独有、
// premise 无对应，不在此列；premise→facts 映射各取一条 field.value。
const PREMISE_ENGINE_FACT_MAP: ReadonlyArray<{
  card: PremiseCardKey;
  fieldKey: string;
  predicate: string;
}> = [
  { card: "central_dramatic_question", fieldKey: "question", predicate: "central_dramatic_question" },
  { card: "protagonist_desire", fieldKey: "surface_want", predicate: "protagonist_core_desire" },
  { card: "protagonist_desire", fieldKey: "deep_need", predicate: "protagonist_core_lack" },
  { card: "antagonistic_force", fieldKey: "force", predicate: "antagonistic_force" },
];

/** 从 payload 收集四项重叠字段的 predicate→value；open / 空值跳过（不用占位覆盖既有真相）。 */
function collectPremiseEngineOverlap(
  payload: PremiseCardsPayload,
): Array<{ predicate: string; value: string }> {
  const byCard = new Map<PremiseCardKey, PremiseField[]>();
  for (const card of payload.cards) byCard.set(card.card, card.fields);
  const overlap: Array<{ predicate: string; value: string }> = [];
  for (const { card, fieldKey, predicate } of PREMISE_ENGINE_FACT_MAP) {
    const field = byCard.get(card)?.find((f) => f.key === fieldKey);
    if (!field) continue;
    const value = (field.value ?? "").trim();
    if (!value) continue; // 空值跳过
    if (field.certainty === "open") continue; // 未确定跳过，不覆盖
    overlap.push({ predicate, value });
  }
  return overlap;
}

/** 把重叠项写入 subject='全书' facts（删旧索引→插新，套 submit_outline 引擎字段模式）。返回同步的谓词。 */
async function syncPremiseEngineFacts(
  overlap: Array<{ predicate: string; value: string }>,
  ctx: ToolContext,
): Promise<string[]> {
  // embedding 在事务外算（与 submit_outline 一致）
  const ops: Array<{
    id: string;
    predicate: string;
    object: string;
    content: string;
    embedding: Float32Array | null;
  }> = [];
  for (const { predicate, value } of overlap) {
    const content = `全书 ${predicate} ${value}`;
    ops.push({ id: randomUUID(), predicate, object: value, content, embedding: await embed(content) });
  }

  const tx = ctx.db.transaction(() => {
    for (const op of ops) {
      const stale = ctx.db
        .prepare(`SELECT id FROM facts WHERE novel_id = ? AND subject = '全书' AND predicate = ?`)
        .all(ctx.novelId, op.predicate) as Array<{ id: string }>;
      const staleIds = stale.map((r) => r.id);
      ftsDeleteBySourceIds(ctx.db, "facts", staleIds);
      vecDeleteBySourceIds(ctx.db, "facts", staleIds);
      for (const id of staleIds) {
        ctx.db.prepare(`DELETE FROM facts WHERE id = ?`).run(id);
      }
      ctx.db
        .prepare(
          `INSERT INTO facts (id, novel_id, subject, predicate, object, sector, from_chapter, source)
           VALUES (?, ?, '全书', ?, ?, 'semantic', 1, 'authored')`,
        )
        .run(op.id, ctx.novelId, op.predicate, op.object);
      ftsInsert(ctx.db, op.content, "facts", op.id, ctx.novelId, "semantic");
      if (op.embedding) {
        vecInsert(ctx.db, "facts", op.id, ctx.novelId, "semantic", op.embedding);
      }
    }
  });
  tx();
  return ops.map((op) => op.predicate);
}

/**
 * 把 payload 写回 outline-structure.json 并重渲 master-outline.md（叙述声音取法与原 sync 逻辑一致）。
 */
async function persistOutlineStructure(ctx: ToolContext, payload: OutlinePayload): Promise<void> {
  const structurePath = join(ctx.projectRoot, "outline", "outline-structure.json");
  await writeFile(structurePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

  const masterPath = join(ctx.projectRoot, "outline", "master-outline.md");
  if (existsSync(masterPath)) {
    const narratorVoice = await readNarratorVoiceFromBible(ctx.projectRoot);
    await writeFile(masterPath, renderMasterOutlineMarkdown(payload, narratorVoice), "utf-8");
  }
}

/**
 * 把重叠项回灌到机械渲染的大纲产物（仅在已提交大纲时）：patch outline-structure.json 的同名引擎字段，
 * 并按更新后的 payload 重渲 master-outline.md，使 App 渲染/复制的全书大纲与立项卡一致。
 * 无 outline-structure.json（尚未提交大纲）时跳过——facts 已更新，待 /plan 提交时写出一致的大纲。
 */
async function syncPremiseToOutlineRender(
  overlap: Array<{ predicate: string; value: string }>,
  ctx: ToolContext,
): Promise<boolean> {
  const structurePath = join(ctx.projectRoot, "outline", "outline-structure.json");
  if (!existsSync(structurePath)) return false;

  let payload: OutlinePayload;
  try {
    payload = JSON.parse(await readFile(structurePath, "utf-8")) as OutlinePayload;
  } catch {
    return false; // 坏 JSON 不阻断 premise 写入
  }

  let changed = false;
  const fields = payload as unknown as Record<string, unknown>;
  for (const { predicate, value } of overlap) {
    if (fields[predicate] !== value) {
      fields[predicate] = value;
      changed = true;
    }
  }
  if (!changed) return false;

  await persistOutlineStructure(ctx, payload);
  return true;
}

/**
 * 增量合并（merge_cards=true）：把提交的卡按 card key 并入现有 cards_json，未提交的卡原样保留。
 * 定点修订只需提交目标卡（完整 fields），避免弱模型漏卡导致其余立项卡被整体覆盖丢失。
 */
function mergePremiseCards(submitted: PremiseCardsPayload, ctx: ToolContext): PremiseCardsPayload {
  const byCard = new Map<PremiseCardKey, PremiseCard>();
  const row = ctx.db
    .prepare(`SELECT cards_json FROM premise_cards WHERE novel_id = ?`)
    .get(ctx.novelId) as { cards_json: string } | undefined;
  if (row) {
    try {
      const existing = JSON.parse(row.cards_json) as PremiseCard[];
      if (Array.isArray(existing)) for (const card of existing) byCard.set(card.card, card);
    } catch {
      // 坏存量 cards_json 忽略，按全量提交处理
    }
  }
  for (const card of submitted.cards) byCard.set(card.card, card);
  return { cards: [...byCard.values()] };
}

export async function novelSubmitPremise(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const rawPayload = args["payload"];
  const validation = validatePremise(rawPayload);
  if (!validation.valid) return errorResponse(validation.errors);

  // 叙述人称受控校验（校验本次提交的卡 rawPayload，不掺存量）：值域合法性无条件——任何写入路径
  // （含定点修订 merge_cards）都不许把 address 写成自由文本如 "第三人称"；"卡/字段必须存在" 仅
  // 全量立项要求，定点修订只提交目标卡、不带 narrator_voice 属正常 → 豁免，不惩罚存量（#297 方案 E）。
  const addressErrors = checkNarratorAddress(rawPayload as PremiseCardsPayload, {
    requirePresence: args["merge_cards"] !== true,
  });
  if (addressErrors.length > 0) return errorResponse(addressErrors);

  // 增量合并：定点修订只提交目标卡时，先并入现有立项卡再校验/写回（避免漏卡丢失其余卡）
  const payload =
    args["merge_cards"] === true
      ? mergePremiseCards(rawPayload as PremiseCardsPayload, ctx)
      : (rawPayload as PremiseCardsPayload);

  const semanticErrors = checkPremiseSemantics(payload);
  if (semanticErrors.length > 0) return errorResponse(semanticErrors);

  // 结构化真相入库：upsert cards_json（单行/小说，与 chapter_reviews 同模式）
  ctx.db
    .prepare(
      `INSERT INTO premise_cards (novel_id, cards_json)
       VALUES (?, ?)
       ON CONFLICT(novel_id) DO UPDATE SET
         cards_json = excluded.cards_json,
         updated_at = datetime('now')`,
    )
    .run(ctx.novelId, JSON.stringify(payload.cards));

  // 机械渲染只读 premise.md（人读 + plan/world/叙述声音腔调消费）+ App 数据契约落盘。
  // 先写 premise.md，使后续大纲回灌读到最新叙述声音。
  const premiseMdPath = join(ctx.projectRoot, "bible", "premise.md");
  await mkdir(dirname(premiseMdPath), { recursive: true });
  await writeFile(premiseMdPath, renderPremiseMarkdown(payload), "utf-8");
  const dataPath = join(ctx.projectRoot, "bible", "premise-cards.json");
  await writeFile(dataPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

  // 地基卡定点修订：同步与大纲重叠的四项内容（仅 sync_engine_facts=true 时；setup 全量立项
  // 与 App 信心标记不传，保持 facts 由 submit_outline 拥有）——写 subject='全书' facts + 回灌
  // 已渲染的 outline DTO/md，使记忆与用户可见大纲一致。
  let syncedFacts: string[] = [];
  let syncedOutline = false;
  if (args["sync_engine_facts"] === true) {
    const overlap = collectPremiseEngineOverlap(payload);
    if (overlap.length > 0) {
      syncedFacts = await syncPremiseEngineFacts(overlap, ctx);
      syncedOutline = await syncPremiseToOutlineRender(overlap, ctx);
    }
  }

  return {
    ok: true,
    cards: payload.cards.length,
    files_rendered: [premiseMdPath, dataPath],
    ...(syncedFacts.length > 0 ? { synced_engine_facts: syncedFacts } : {}),
    ...(syncedOutline ? { synced_outline_render: true } : {}),
    message: `立项卡已入库：${payload.cards.length} 张卡（premise.md 已机械渲染为只读视图）${
      syncedFacts.length > 0 ? `；已同步 ${syncedFacts.length} 项全书 facts` : ""
    }${syncedOutline ? "、回灌大纲渲染" : ""}`,
  };
}

// ============================================================
// 立项卡契约 backfill — 存量 premise_cards 重灌 bible/premise-cards.json（幂等）
//
// 仅从库（cards_json）重灌缺失的数据契约，不解析旧 premise.md（一次性迁移走重跑
// /setup，非运行时解析；ADR-0019）。premise_cards 表为 SCHEMA_VERSION 8 新增，
// 旧库会因版本不兼容重建，故 backfill 只覆盖「已用新版 setup 提交过、但 json 缺失」的库。
// ============================================================

export async function backfillPremiseArtifacts(ctx: ToolContext): Promise<void> {
  const dataPath = join(ctx.projectRoot, "bible", "premise-cards.json");
  if (existsSync(dataPath)) return;

  const row = ctx.db
    .prepare(`SELECT cards_json FROM premise_cards WHERE novel_id = ?`)
    .get(ctx.novelId) as { cards_json: string } | undefined;
  if (!row) return;

  let cards: unknown;
  try {
    cards = JSON.parse(row.cards_json);
  } catch {
    return; // 损坏的 cards_json 跳过，不阻断启动
  }
  if (!Array.isArray(cards) || cards.length === 0) return;

  const payload = { cards } as PremiseCardsPayload;
  await mkdir(dirname(dataPath), { recursive: true });
  await writeFile(dataPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

// ============================================================
// 大纲契约 backfill — 存量多表聚合重建 outline-structure.json（幂等）
//
// 套审校 backfill 模式，但跨表聚合：引擎 5 字段（facts subject='全书'）+
// storylines + foreshadowing_registry + arc_meta（分卷分 arc）重建书级
// OutlineStructure，落 outline/outline-structure.json。
//
// 仅书级可重建：章细纲全字段（value_shift / scenes / pov_character 等）不入库，
// DB 只有 chapter_storyline_focus / foreshadowing_actions_log，不足以重建章 DTO，
// 故 ch-NNN.json 不 backfill（仅新提交写入；存量章细纲 md 仍可读）。
//
// DB 未持久化卷标题与 dilemma_milestone（只在 master-outline md），故卷标题
// 合成「第 N 卷」、dilemma_milestone 省略——backfill 是尽力重建，不反解析 md。
// ============================================================

const ENGINE_PREDICATES = [
  "central_dramatic_question",
  "protagonist_core_desire",
  "protagonist_core_lack",
  "antagonistic_force",
  "stakes_progression",
] as const;

export async function backfillOutlineArtifacts(ctx: ToolContext): Promise<void> {
  const structurePath = join(ctx.projectRoot, "outline", "outline-structure.json");
  if (existsSync(structurePath)) return;

  // arc_meta 是书级大纲是否存在的判据：无 arc 即未提交大纲，跳过
  const arcRows = ctx.db
    .prepare(
      `SELECT arc_id, volume_no, title, chapter_start, chapter_end,
              core_question, irreversible_change, next_arc_seed, antagonist_agent, payoff_beats
       FROM arc_meta WHERE novel_id = ? ORDER BY volume_no, chapter_start`,
    )
    .all(ctx.novelId) as ArcMetaRow[];
  if (arcRows.length === 0) return;

  // 引擎 5 字段：subject='全书' 的 facts，每谓词取最新一条（提交链整体覆盖，通常各一条）
  const engine: Record<string, string> = {};
  for (const predicate of ENGINE_PREDICATES) {
    const row = ctx.db
      .prepare(
        `SELECT object FROM facts
         WHERE novel_id = ? AND subject = '全书' AND predicate = ?
         ORDER BY from_chapter DESC, created_at DESC LIMIT 1`,
      )
      .get(ctx.novelId, predicate) as { object: string } | undefined;
    engine[predicate] = row?.object ?? "";
  }

  // 故事线
  const storylineRows = ctx.db
    .prepare(
      `SELECT id, name, type, priority, entry_chapter, planned_payoff_chapter, status, is_through_line
       FROM storylines WHERE novel_id = ? ORDER BY priority, entry_chapter`,
    )
    .all(ctx.novelId) as StorylineRow[];
  const storylines = storylineRows.map((sl) => ({
    id: sl.id,
    name: sl.name,
    type: sl.type,
    priority: sl.priority,
    entry_chapter: sl.entry_chapter,
    ...(sl.planned_payoff_chapter !== null
      ? { planned_payoff_chapter: sl.planned_payoff_chapter }
      : {}),
    ...(sl.status ? { status: sl.status } : {}),
    ...(sl.is_through_line ? { is_through_line: true } : {}),
  }));

  // 伏笔注册表
  const registryRows = ctx.db
    .prepare(
      `SELECT id, type, description, planted_chapter, target_reveal, theme_link
       FROM foreshadowing_registry WHERE novel_id = ? ORDER BY id`,
    )
    .all(ctx.novelId) as ForeshadowingRegistryRow[];
  const foreshadowingRegistry = registryRows.map((fs) => ({
    id: fs.id,
    type: fs.type,
    description: fs.description,
    planted_chapter: fs.planted_chapter ?? 1,
    target_reveal: fs.target_reveal ?? String(fs.planted_chapter ?? 1),
    ...(fs.theme_link ? { theme_link: fs.theme_link } : {}),
  }));

  // 卷级：arc_meta 按 volume_no 分组（卷标题 DB 无，合成「第 N 卷」；dilemma_milestone 省略）
  const volumeMap = new Map<number, OutlinePayload["volumes"][number]>();
  for (const arc of arcRows) {
    let vol = volumeMap.get(arc.volume_no);
    if (!vol) {
      vol = { volume_no: arc.volume_no, title: `第 ${arc.volume_no} 卷`, arc_list: [] };
      volumeMap.set(arc.volume_no, vol);
    }
    let beats: string[] = [];
    try {
      const parsed = JSON.parse(arc.payoff_beats) as unknown;
      if (Array.isArray(parsed)) beats = parsed.filter((b): b is string => typeof b === "string");
    } catch {
      // 坏 JSON 按空爽点列表处理
    }
    vol.arc_list.push({
      arc_id: arc.arc_id,
      title: arc.title,
      chapter_start: arc.chapter_start,
      chapter_end: arc.chapter_end,
      core_question: arc.core_question,
      irreversible_change: arc.irreversible_change,
      next_arc_seed: arc.next_arc_seed,
      ...(arc.antagonist_agent ? { antagonist_agent: arc.antagonist_agent } : {}),
      payoff_beats: beats,
    });
  }
  const volumes = [...volumeMap.values()].sort((a, b) => a.volume_no - b.volume_no);

  const payload: OutlinePayload = {
    central_dramatic_question: engine.central_dramatic_question,
    protagonist_core_desire: engine.protagonist_core_desire,
    protagonist_core_lack: engine.protagonist_core_lack,
    antagonistic_force: engine.antagonistic_force,
    stakes_progression: engine.stakes_progression,
    storylines,
    foreshadowing_registry: foreshadowingRegistry,
    volumes,
  };

  await mkdir(dirname(structurePath), { recursive: true });
  await writeFile(structurePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

// ============================================================
// 叙述者腔调：从 bible 立项卡读数据 → 渲染 master-outline 腔调节
// ============================================================

const NARRATOR_BOLD_KEYS = new Set(["archetype", "reference_inspiration"]);
const NARRATOR_KEYS = [
  "archetype",
  "tone",
  "pacing",
  "ornamentation",
  "digression",
  "address",
  "style_keywords",
  "reference_inspiration",
] as const;

interface NarratorVoiceData {
  values: Map<string, string>;
  examples: Array<{ source_excerpt: string; mechanism_note?: string }>;
}

/**
 * 从 bible/premise.md 的「叙述声音」立项卡解析英文 key: value 数据。
 * 容忍 `- key: value` / `- **key**: value` / `key: value` 三种行形态。
 */
async function readNarratorVoiceFromBible(
  projectRoot: string,
): Promise<NarratorVoiceData | null> {
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
  const examples: Array<{ source_excerpt: string; mechanism_note?: string }> = [];
  for (const line of lines.slice(start + 1, end)) {
    const kv = line.match(/^[\s>*-]*(?:\*\*)?([a-z_]+)(?:\*\*)?\s*[:：]\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (!value) continue;
    if (key === "source_excerpt") {
      examples.push({ source_excerpt: value });
      continue;
    }
    if (key === "mechanism_note") {
      const current = examples[examples.length - 1];
      if (current) current.mechanism_note = value;
      continue;
    }
    if ((NARRATOR_KEYS as readonly string[]).includes(key) && !values.has(key)) {
      values.set(key, value);
    }
  }

  if (values.size === 0 && examples.length === 0) return null;
  return { values, examples };
}

function renderNarratorVoiceSection(data: NarratorVoiceData | null): string {
  const lines: string[] = ["## 叙述者腔调", ""];
  if (!data) {
    lines.push("（立项卡未声明叙述声音数据）");
    return lines.join("\n");
  }
  for (const key of NARRATOR_KEYS) {
    const raw = data.values.get(key);
    if (!raw) continue;
    const value = key === "address" ? narratorAddressPhrase(raw) : raw;
    lines.push(
      NARRATOR_BOLD_KEYS.has(key) ? `- **${key}**: ${value}` : `- ${key}: ${value}`,
    );
  }
  if (data.examples.length > 0) {
    lines.push("- **reference_examples**");
    for (const ex of data.examples.slice(0, 3)) {
      lines.push(`  - source_excerpt: ${ex.source_excerpt}`);
      if (ex.mechanism_note) {
        lines.push(`    mechanism_note: ${ex.mechanism_note}`);
      }
    }
  }
  return lines.join("\n");
}

// ============================================================
// novel_submit_outline — 书级+卷级大纲提交（outline-architect）
// ============================================================

const STORYLINE_TYPE_LABEL: Record<string, string> = {
  main: "主线",
  growth: "成长线",
  romance: "感情线",
  faction: "势力线",
  mystery: "悬疑线",
  rivalry: "宿敌线",
  world: "世界线",
  other: "其他",
};

const ENGINE_FIELDS = [
  ["central_dramatic_question", "中心戏剧问题"],
  ["protagonist_core_desire", "主角核心欲望"],
  ["protagonist_core_lack", "主角核心缺失"],
  ["antagonistic_force", "对抗力量"],
  ["stakes_progression", "赌注递增曲线"],
] as const;

function renderArcLines(arc: OutlinePayload["volumes"][number]["arc_list"][number]): string[] {
  const lines = [
    `### ${arc.arc_id} ${arc.title}（第 ${arc.chapter_start}-${arc.chapter_end} 章）`,
    "",
    `- 核心问题: ${arc.core_question}`,
    `- 不可逆变化: ${arc.irreversible_change}`,
    `- 下一 arc 种子: ${arc.next_arc_seed}`,
  ];
  if (arc.antagonist_agent) {
    lines.push(`- 施压者: ${arc.antagonist_agent}`);
  }
  if (arc.payoff_beats.length > 0) {
    lines.push(`- 爽点: ${arc.payoff_beats.join(", ")}`);
  }
  lines.push("");
  return lines;
}

/** 机械渲染 master-outline.md：引擎字段 + 叙述者腔调节 + 故事线 + 伏笔注册表 + 卷结构。 */
export function renderMasterOutlineMarkdown(
  payload: OutlinePayload,
  narratorVoice: NarratorVoiceData | null,
): string {
  const masterLines: string[] = ["# 全书大纲", ""];
  for (const [key, label] of ENGINE_FIELDS) {
    masterLines.push(`## ${label}`, "", payload[key as keyof OutlinePayload] as string, "");
  }
  masterLines.push(renderNarratorVoiceSection(narratorVoice), "");

  masterLines.push("## 故事线", "");
  for (const sl of [...payload.storylines].sort((a, b) => a.priority - b.priority)) {
    const label = STORYLINE_TYPE_LABEL[sl.type] ?? sl.type;
    const payoff = sl.planned_payoff_chapter
      ? `，计划第 ${sl.planned_payoff_chapter} 章收线`
      : "";
    const throughLine = sl.is_through_line ? " [贯穿线]" : "";
    masterLines.push(
      `- ${sl.id}「${sl.name}」（${label}，优先级 ${sl.priority}）：第 ${sl.entry_chapter} 章入场${payoff}${throughLine}`,
    );
  }
  masterLines.push("");

  masterLines.push("## 伏笔注册表", "");
  for (const fs of payload.foreshadowing_registry) {
    const theme = fs.theme_link ? `，主题联系：${fs.theme_link}` : "";
    masterLines.push(
      `- ${fs.id}（${fs.type}）：${fs.description} —— 埋设第 ${fs.planted_chapter} 章，计划兑现 ${fs.target_reveal}${theme}`,
    );
  }
  masterLines.push("");

  masterLines.push("## 卷结构", "");
  if (payload.volumes.length === 0) {
    masterLines.push("（待展开：全书骨架确认后生成分卷结构）", "");
  } else {
    const sortedVolumes = [...payload.volumes].sort((a, b) => a.volume_no - b.volume_no);
    for (const vol of sortedVolumes) {
      const arcs = [...vol.arc_list].sort((a, b) => a.chapter_start - b.chapter_start);
      const volStart = arcs[0].chapter_start;
      const volEnd = arcs[arcs.length - 1].chapter_end;
      masterLines.push(`### 第 ${vol.volume_no} 卷 ${vol.title}（第 ${volStart}-${volEnd} 章）`, "");
      if (vol.dilemma_milestone) {
        masterLines.push(`- 困境里程碑: ${vol.dilemma_milestone}`);
      }
      for (const arc of arcs) {
        masterLines.push(
          `- ${arc.arc_id} ${arc.title}（第 ${arc.chapter_start}-${arc.chapter_end} 章）：${arc.core_question}`,
        );
      }
      masterLines.push("");
    }
  }

  return masterLines.join("\n");
}

const OUTLINE_SCOPES = ["full", "book", "volumes"] as const;

/**
 * 已写结构身份门（issue #450）：大纲重提交不许把已写结构身份（arc / 卷 / 故事线 id）
 * 从提交集里注销——章摘要 / arc·卷摘要 / 聚焦记忆按旧 id 挂靠，id 一旦从提交集消失，
 * #448 的清理会把 DB 行删成孤儿，WCP 读取时静默丢失（写手「失忆」）。未写区间零限制：
 * 只挡「已写记忆」关联的 id 被删除，字段调整（如 chapter_end / core_question）不受影响，
 * 查询走事前（事务外）。「已写」判据取并集（PR#451 评审 P1）：章摘要（chapter_summaries）
 * 或温层摘要（arc_summaries）任一存在即算——novel_consolidate 不要求章摘要存在就能写
 * arc / 卷摘要，只查章摘要会让「仅存温层摘要」的结构溜过门。
 */
function checkWrittenStructureIdentity(
  payload: OutlinePayload,
  scope: (typeof OUTLINE_SCOPES)[number],
  ctx: ToolContext,
): ToolErrorItem[] {
  const errors: ToolErrorItem[] = [];

  // 剧情弧门 + 卷门：book 段 volumes 恒为占位空数组（不删任何 arc / 卷），天然豁免。
  if (scope !== "book") {
    const submittedArcIds = new Set(
      payload.volumes.flatMap((vol) => vol.arc_list.map((arc) => arc.arc_id)),
    );
    const existingArcs = ctx.db
      .prepare(`SELECT arc_id, chapter_start, chapter_end FROM arc_meta WHERE novel_id = ?`)
      .all(ctx.novelId) as Array<{ arc_id: string; chapter_start: number; chapter_end: number }>;
    const hasWrittenChapterInRange = ctx.db.prepare(
      `SELECT 1 FROM chapter_summaries WHERE novel_id = ? AND chapter BETWEEN ? AND ? LIMIT 1`,
    );
    // consolidate 落 arc 摘要前已验 arc_id 注册在案，scope_id === arc_id 精确匹配可靠。
    const hasArcSummary = ctx.db.prepare(
      `SELECT 1 FROM arc_summaries WHERE novel_id = ? AND scope = 'arc' AND scope_id = ? LIMIT 1`,
    );
    for (const arc of existingArcs) {
      if (submittedArcIds.has(arc.arc_id)) continue;
      const written =
        hasWrittenChapterInRange.get(ctx.novelId, arc.chapter_start, arc.chapter_end) ??
        hasArcSummary.get(ctx.novelId, arc.arc_id);
      if (written) {
        errors.push({
          field: `arc ${arc.arc_id}`,
          expected: "已写剧情弧的 arc_id 保留在提交集内",
          actual: `arc ${arc.arc_id}（第 ${arc.chapter_start}-${arc.chapter_end} 章）已从提交集消失，但该弧已有章摘要或剧情摘要（已写）`,
          hint: "该剧情弧的章节已写或已存剧情摘要，保留原 arc_id，只调整未写部分（chapter_end / core_question 等字段仍可改）",
        });
      }
    }

    // 卷门：novel_consolidate(scope="volume") 可独立写卷摘要，被删卷号同样会留孤儿。
    // 落库的 scope_id 原样保留入参（consolidate 接受 "vol-01" / "vol-1" / 纯数字），
    // 不能按 'vol-NN' 字符串精确匹配——把 DB 行解析回卷号（与 consolidate 同一正则）再比对。
    const submittedVolumeNos = new Set(payload.volumes.map((vol) => vol.volume_no));
    const removedVolumeNos = new Set(
      (
        ctx.db
          .prepare(`SELECT DISTINCT volume_no FROM arc_meta WHERE novel_id = ?`)
          .all(ctx.novelId) as Array<{ volume_no: number }>
      )
        .map((r) => r.volume_no)
        .filter((no) => !submittedVolumeNos.has(no)),
    );
    if (removedVolumeNos.size > 0) {
      const volumeSummaryRows = ctx.db
        .prepare(`SELECT scope_id FROM arc_summaries WHERE novel_id = ? AND scope = 'volume'`)
        .all(ctx.novelId) as Array<{ scope_id: string }>;
      for (const row of volumeSummaryRows) {
        const m = row.scope_id.match(/^vol-0*(\d+)$/) ?? row.scope_id.match(/^0*(\d+)$/);
        if (!m) continue;
        const volumeNo = parseInt(m[1], 10);
        if (removedVolumeNos.has(volumeNo)) {
          errors.push({
            field: `volume ${row.scope_id}`,
            expected: "已存卷摘要的卷号保留在提交集内",
            actual: `第 ${volumeNo} 卷已从提交集消失，但该卷已存卷摘要（scope_id=${row.scope_id}）`,
            hint: "该卷已写并存有卷摘要，保留原卷号，只调整未写部分；剧情收束用后续卷承接，不注销已写卷",
          });
          removedVolumeNos.delete(volumeNo); // 同卷多形态 scope_id 只报一次
        }
      }
    }
  }

  // 故事线门：全部 scope 生效（storylines 删除对全形态生效）。
  const submittedStorylineIds = new Set(payload.storylines.map((sl) => sl.id));
  const existingStorylines = ctx.db
    .prepare(`SELECT id FROM storylines WHERE novel_id = ?`)
    .all(ctx.novelId) as Array<{ id: string }>;
  const hasWrittenFocusRef = ctx.db.prepare(
    `SELECT 1 FROM chapter_storyline_focus f
     JOIN chapter_summaries s ON s.novel_id = f.novel_id AND s.chapter = f.chapter
     WHERE f.novel_id = ? AND f.storyline_id = ? LIMIT 1`,
  );
  for (const sl of existingStorylines) {
    if (submittedStorylineIds.has(sl.id)) continue;
    const referenced = hasWrittenFocusRef.get(ctx.novelId, sl.id);
    if (referenced) {
      errors.push({
        field: `storyline ${sl.id}`,
        expected: "被已写章聚焦引用的故事线 id 保留在提交集内",
        actual: `storyline ${sl.id} 已从提交集消失，但已写章节仍聚焦引用该故事线`,
        hint: "收线用 status=resolved、暂停用 dormant（不删行）；已写章的聚焦记忆按 id 挂靠，删除该 id 会让记忆变孤儿",
      });
    }
  }

  return errors;
}

export async function novelSubmitOutline(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  // phase 恒为 1、没有第二个取值，不值得让模型每次记着传（漏传只会白撞一轮入参校验）：
  // 缺省即 1。显式传了别的值仍 fail-loud——那是「误把章级细纲提交到书级入口」的真实误用，
  // 这条 hint 有价值，不能连它一起砍掉。
  //
  // 判「省略」只认 undefined，不能用 `?? 1`：`null ?? 1` 也是 1，会把显式传入的 null 当成
  // 省略静默放行，而 null 属于「显式传了但不等于 1」，必须走 fail-loud。runTool
  // （core.ts）拿到 args 直接调 handler、不跑 tool inputSchema 校验，这里是唯一防线。
  const phase = "phase" in args && args["phase"] !== undefined ? args["phase"] : 1;
  if (phase !== 1) {
    return singleError(
      "phase",
      "integer 1（可省略，缺省即 1）",
      `${typeof phase}: ${JSON.stringify(phase)}`,
      "书级+卷级大纲提交 phase 固定为 1；章级细纲改用 novel_submit_chapter_outline",
    );
  }

  const rawScope = args["scope"] ?? "full";
  if (!OUTLINE_SCOPES.includes(rawScope as (typeof OUTLINE_SCOPES)[number])) {
    return singleError(
      "scope",
      `"full" | "book" | "volumes"（缺省 full）`,
      `${typeof rawScope}: ${JSON.stringify(rawScope)}`,
      `full=书级+卷级一次提交；book=只提交书级骨架；volumes=书级确认后只提交卷级`,
    );
  }
  const scope = rawScope as (typeof OUTLINE_SCOPES)[number];

  let rawPayload = args["payload"];
  if (scope === "volumes") {
    const structurePath = join(ctx.projectRoot, "outline", "outline-structure.json");
    if (!existsSync(structurePath)) {
      return singleError(
        "scope",
        "书级骨架已提交（outline/outline-structure.json 存在）",
        "文件不存在",
        `卷级段须在书级骨架提交并确认后使用；先用 scope="book" 提交书级`,
      );
    }
    let existing: OutlinePayload;
    try {
      existing = JSON.parse(await readFile(structurePath, "utf-8")) as OutlinePayload;
    } catch {
      return singleError(
        "outline",
        "outline/outline-structure.json 可解析",
        "JSON 解析失败",
        `大纲结构文件已损坏：先用 scope="book" 重新提交书级骨架修复该文件，确认后再展开卷级`,
      );
    }
    const submittedVolumes = ((rawPayload ?? {}) as Record<string, unknown>)["volumes"];
    if (!Array.isArray(submittedVolumes) || submittedVolumes.length === 0) {
      return singleError(
        "payload.volumes",
        "非空 volumes 数组",
        `${typeof submittedVolumes}: ${JSON.stringify(submittedVolumes)?.slice(0, 80)}`,
        "卷级段 payload 只需 { volumes: [...] }",
      );
    }
    // 书级以库内为准（含作者在确认窗口的直接修改），payload 里 volumes 以外的字段一律忽略
    rawPayload = { ...existing, volumes: submittedVolumes };
  }

  const validation =
    scope === "book" ? validateOutlineBookPayload(rawPayload) : validateOutlinePayload(rawPayload);
  if (!validation.valid) return errorResponse(validation.errors);

  let payload = rawPayload as OutlinePayload;
  if (scope === "book") {
    // fail-loud 守卫：卷级已展开的书禁止用 book 段重提——否则 outline-structure.json
    // 的卷结构会被 volumes: [] 覆写（master-outline 渲染回「待展开」），且 DB 旧 arc_meta
    // 会让 fullCoverage=true 触发 structure 重同步。书级待展开状态（文件不存在或
    // volumes 为空数组）重派书级段是合法路径，放行。
    const existingStructurePath = join(ctx.projectRoot, "outline", "outline-structure.json");
    if (existsSync(existingStructurePath)) {
      let existingVolumes: unknown;
      try {
        existingVolumes = (
          JSON.parse(await readFile(existingStructurePath, "utf-8")) as Record<string, unknown>
        )["volumes"];
      } catch {
        existingVolumes = undefined; // 坏 JSON 不阻断：book 段重写恰可修复该文件
      }
      if (Array.isArray(existingVolumes) && existingVolumes.length > 0) {
        return singleError(
          "scope",
          "book 段仅限卷级未展开的书",
          `outline-structure.json 已含 ${existingVolumes.length} 卷`,
          "卷级已展开：书级定点修改走 novel_update_outline_book_field，结构调整走全量提交（scope 缺省）",
        );
      }
    }
    const submittedVolumes = (rawPayload as Record<string, unknown>)["volumes"];
    if (Array.isArray(submittedVolumes) && submittedVolumes.length > 0) {
      return singleError(
        "payload.volumes",
        "书级段不含 volumes",
        `${submittedVolumes.length} 卷`,
        `书级段只提交引擎字段 + storylines + 伏笔注册表；卷级在书级确认后用 scope="volumes" 展开`,
      );
    }
    payload = { ...(rawPayload as object), volumes: [] } as unknown as OutlinePayload;
  }

  const warnings: string[] = [];
  const errors: ToolErrorItem[] = [];

  const semantics = checkOutlineSemantics(payload);
  errors.push(...semantics.errors);
  warnings.push(...semantics.warnings);

  // 开局 arc 爽点底线（始终运行，不依赖 budget）：开局 arc 须 ≥1 payoff_beats，
  // 否则阶段二章级 D-open-1 与「章级爽点从 arc 落」契约冲突（S 档其它 arc 仍可 0）
  errors.push(...checkOpeningArcPayoff(payload).errors);

  // 伏笔兑现节奏核验（确定性、非阻断）：每卷 major 密度 + small/medium 远期距离
  const payoffTiming = checkForeshadowingPayoffTiming(payload);
  const foreshadowingPayoffWarnings = payoffTiming.warnings;
  warnings.push(...foreshadowingPayoffWarnings);

  // 结构预算核验（config 缺篇幅参数时跳过并提示）
  if (ctx.estimatedTotalChapters && ctx.wordsPerChapter) {
    const budget = computeStructureBudget(ctx.estimatedTotalChapters, ctx.wordsPerChapter);
    const budgetCheck = checkOutlineBudget(payload, budget);
    errors.push(...budgetCheck.errors);
    warnings.push(...budgetCheck.warnings);
    const rhythmCheck = checkStructureRhythm(payload, budget);
    errors.push(...rhythmCheck.errors);
    warnings.push(...rhythmCheck.warnings);
    const milestoneCheck = checkDilemmaMilestones(payload, ctx.estimatedTotalChapters);
    errors.push(...milestoneCheck.errors);
    warnings.push(...milestoneCheck.warnings);
  } else {
    warnings.push(
      "config.yaml 缺 estimated_total_chapters / words_per_chapter，结构预算核验已跳过",
    );
    const milestoneCheck = checkDilemmaMilestones(payload, null);
    errors.push(...milestoneCheck.errors);
  }

  // 已写结构身份门（issue #450）：任何写入之前拦住会造成孤儿章摘要/聚焦记忆的重提交。
  errors.push(...checkWrittenStructureIdentity(payload, scope, ctx));

  if (errors.length > 0) return errorResponse(errors);

  // 引擎字段 embedding（事务外）
  const engineOps: Array<{
    id: string;
    predicate: string;
    object: string;
    content: string;
    embedding: Float32Array | null;
  }> = [];
  for (const [key] of ENGINE_FIELDS) {
    const object = payload[key as keyof OutlinePayload] as string;
    const content = `全书 ${key} ${object}`;
    engineOps.push({
      id: randomUUID(),
      predicate: key,
      object,
      content,
      embedding: await embed(content),
    });
  }

  let arcCount = 0;
  const tx = ctx.db.transaction(() => {
    // 引擎 5 字段：删旧（含索引）→ 插新
    for (const op of engineOps) {
      const stale = ctx.db
        .prepare(
          `SELECT id FROM facts WHERE novel_id = ? AND subject = '全书' AND predicate = ?`,
        )
        .all(ctx.novelId, op.predicate) as Array<{ id: string }>;
      const staleIds = stale.map((r) => r.id);
      ftsDeleteBySourceIds(ctx.db, "facts", staleIds);
      vecDeleteBySourceIds(ctx.db, "facts", staleIds);
      for (const id of staleIds) {
        ctx.db.prepare(`DELETE FROM facts WHERE id = ?`).run(id);
      }
      ctx.db
        .prepare(
          `INSERT INTO facts (id, novel_id, subject, predicate, object, sector, from_chapter, source)
           VALUES (?, ?, '全书', ?, ?, 'semantic', 1, 'authored')`,
        )
        .run(op.id, ctx.novelId, op.predicate, op.object);
      ftsInsert(ctx.db, op.content, "facts", op.id, ctx.novelId, "semantic");
      if (op.embedding) {
        vecInsert(ctx.db, "facts", op.id, ctx.novelId, "semantic", op.embedding);
      }
    }

    // storylines upsert
    const upsertStoryline = ctx.db.prepare(
      `INSERT INTO storylines
         (novel_id, id, name, type, priority, entry_chapter, planned_payoff_chapter, status, is_through_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(novel_id, id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         priority = excluded.priority,
         entry_chapter = excluded.entry_chapter,
         planned_payoff_chapter = excluded.planned_payoff_chapter,
         status = excluded.status,
         is_through_line = excluded.is_through_line`,
    );
    for (const sl of payload.storylines) {
      upsertStoryline.run(
        ctx.novelId,
        sl.id,
        sl.name,
        sl.type,
        sl.priority,
        sl.entry_chapter,
        sl.planned_payoff_chapter ?? null,
        sl.status ?? "active",
        sl.is_through_line ? 1 : 0,
      );
    }

    // 伏笔注册（保留既有 planted_chapter——后章重复 plant 由生命周期链矫正）
    const upsertForeshadowing = ctx.db.prepare(
      `INSERT INTO foreshadowing_registry
         (novel_id, id, type, description, planted_chapter, target_reveal, theme_link)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(novel_id, id) DO UPDATE SET
         type = excluded.type,
         description = excluded.description,
         planted_chapter = COALESCE(foreshadowing_registry.planted_chapter, excluded.planted_chapter),
         target_reveal = excluded.target_reveal,
         theme_link = excluded.theme_link`,
    );
    for (const fs of payload.foreshadowing_registry) {
      upsertForeshadowing.run(
        ctx.novelId,
        fs.id,
        fs.type,
        fs.description,
        fs.planted_chapter,
        fs.target_reveal,
        fs.theme_link ?? null,
      );
    }

    // arc_meta upsert
    const upsertArc = ctx.db.prepare(
      `INSERT INTO arc_meta
         (novel_id, arc_id, volume_no, title, chapter_start, chapter_end,
          core_question, irreversible_change, next_arc_seed, antagonist_agent, payoff_beats)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(novel_id, arc_id) DO UPDATE SET
         volume_no = excluded.volume_no,
         title = excluded.title,
         chapter_start = excluded.chapter_start,
         chapter_end = excluded.chapter_end,
         core_question = excluded.core_question,
         irreversible_change = excluded.irreversible_change,
         next_arc_seed = excluded.next_arc_seed,
         antagonist_agent = excluded.antagonist_agent,
         payoff_beats = excluded.payoff_beats`,
    );
    for (const vol of payload.volumes) {
      for (const arc of vol.arc_list) {
        upsertArc.run(
          ctx.novelId,
          arc.arc_id,
          vol.volume_no,
          arc.title,
          arc.chapter_start,
          arc.chapter_end,
          arc.core_question,
          arc.irreversible_change,
          arc.next_arc_seed,
          arc.antagonist_agent ?? null,
          JSON.stringify(arc.payoff_beats),
        );
        arcCount += 1;
      }
    }

    // 重提交清理（issue #448）：DB 镜像最新提交集，不在本次提交集内的旧行须删除，
    // 否则幽灵行会让 structure 同步 / novel_get_arc / state.yaml 章数继续引用已作废数据。
    // book 段 volumes 恒为占位空数组（见上文），若参与 arc_meta 清理会清空全部 arc——排除。
    if (scope !== "book") {
      const submittedArcIds = payload.volumes.flatMap((vol) => vol.arc_list.map((arc) => arc.arc_id));
      const arcPlaceholders = submittedArcIds.map(() => "?").join(",");
      ctx.db
        .prepare(`DELETE FROM arc_meta WHERE novel_id = ? AND arc_id NOT IN (${arcPlaceholders})`)
        .run(ctx.novelId, ...submittedArcIds);
    }

    // storylines：payload.storylines 在所有 scope 下都是权威故事线全集（book/full 来自本次
    // 提交，volumes 段来自 existing 文件合成），删除对 volumes 天然 no-op（集合与库内一致）。
    const submittedStorylineIds = payload.storylines.map((sl) => sl.id);
    const storylinePlaceholders = submittedStorylineIds.map(() => "?").join(",");
    ctx.db
      .prepare(`DELETE FROM storylines WHERE novel_id = ? AND id NOT IN (${storylinePlaceholders})`)
      .run(ctx.novelId, ...submittedStorylineIds);

    // 伏笔注册表有意保留不删（issue #448 单独裁定）：planted_chapter 保留语义 +
    // 伏笔生命周期链（auditForeshadowingLifecycle）依赖历史行仍在，删除=数据损失；
    // 重提交漏提的伏笔沿用既有 upsert-only 行为，不受本次清理影响。
  });
  tx();

  // structure 同步：从 DB 全量 arc_meta 展开章到卷映射（与 novel_sync_structure 同一写入逻辑）
  const allArcs = ctx.db
    .prepare(
      `SELECT arc_id, volume_no, chapter_start, chapter_end
       FROM arc_meta WHERE novel_id = ? ORDER BY chapter_start`,
    )
    .all(ctx.novelId) as Array<Pick<ArcMetaRow, "arc_id" | "volume_no" | "chapter_start" | "chapter_end">>;
  const chapterToVolume = new Map<number, number>();
  let maxChapter = 0;
  let maxVolume = 0;
  for (const arc of allArcs) {
    for (let c = arc.chapter_start; c <= arc.chapter_end; c += 1) {
      chapterToVolume.set(c, arc.volume_no);
    }
    maxChapter = Math.max(maxChapter, arc.chapter_end);
    maxVolume = Math.max(maxVolume, arc.volume_no);
  }
  let structureSynced = false;
  let fullCoverage = maxChapter > 0;
  for (let c = 1; c <= maxChapter; c += 1) {
    if (!chapterToVolume.has(c)) {
      fullCoverage = false;
      break;
    }
  }
  if (fullCoverage) {
    const written = await writeStructureToState(
      ctx.projectRoot,
      maxVolume,
      maxChapter,
      chapterToVolume,
    );
    if (written.ok) {
      structureSynced = true;
    } else {
      warnings.push(`structure 同步失败：${written.message}`);
    }
  } else if (scope !== "book") {
    warnings.push("arc 章节区间存在缺口，state.yaml structure 节本次未同步");
  }

  // 机械渲染 master-outline.md（含叙述者腔调节，数据来自 bible 立项卡）
  const narratorVoice = await readNarratorVoiceFromBible(ctx.projectRoot);
  if (!narratorVoice) {
    warnings.push("bible/premise.md 未找到叙述声音立项卡数据，腔调节按缺省占位渲染");
  }

  const masterPath = join(ctx.projectRoot, "outline", "master-outline.md");
  await mkdir(dirname(masterPath), { recursive: true });
  await writeFile(masterPath, renderMasterOutlineMarkdown(payload, narratorVoice), "utf-8");
  const rendered: string[] = [masterPath];

  // 书级结构化数据契约落盘：App 经 data-source 读取渲染（ADR-0018；master/vol md 保留供 agent 读与模式判定）
  const structurePath = join(ctx.projectRoot, "outline", "outline-structure.json");
  await writeFile(structurePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  rendered.push(structurePath);

  // 机械渲染各卷 vol-outline.md
  const sortedVolumes = [...payload.volumes].sort((a, b) => a.volume_no - b.volume_no);
  for (const vol of sortedVolumes) {
    const arcs = [...vol.arc_list].sort((a, b) => a.chapter_start - b.chapter_start);
    const volStart = arcs[0].chapter_start;
    const volEnd = arcs[arcs.length - 1].chapter_end;
    const volLines: string[] = [
      `# 第 ${vol.volume_no} 卷 ${vol.title}`,
      "",
      `- 章节范围: 第 ${volStart}-${volEnd} 章`,
    ];
    if (vol.dilemma_milestone) {
      volLines.push(`- 困境里程碑: ${vol.dilemma_milestone}`);
    }
    volLines.push("");
    for (const arc of arcs) {
      volLines.push(...renderArcLines(arc));
    }
    const volPath = join(
      ctx.projectRoot,
      "outline",
      volumeDirSegment(vol.volume_no),
      "vol-outline.md",
    );
    await mkdir(dirname(volPath), { recursive: true });
    await writeFile(volPath, volLines.join("\n"), "utf-8");
    rendered.push(volPath);
  }

  // 卷级重排清理（issue #448 扩大自 PR#449 评审 P2）：scope=volumes 与 scope=full（缺省，
  // 即整份修改模式重提交）都是整卷集合重排语义，本次提交的 volumes 即新的完整卷集合——
  // DB 与文件同镜像最新提交集。不再出现的卷号，其 vol-outline.md 已随重写作废，须清理
  // 避免与 outline-structure.json / master-outline.md 不一致。book 段 volumes 恒为占位空
  // 数组，不适用本清理（排除）。章级细纲（ch-NNN.md，novel_submit_chapter_outline 所有）
  // 不属本工具管辖，目录非空时只保留+告警，不删。
  const filesRemoved: string[] = [];
  if (scope !== "book") {
    const submittedVolumeNos = new Set(payload.volumes.map((vol) => vol.volume_no));
    const outlineDir = join(ctx.projectRoot, "outline");
    let outlineEntries: string[] = [];
    try {
      outlineEntries = await readdir(outlineDir);
    } catch {
      outlineEntries = []; // outline/ 目录不存在（理论不可达：本函数刚写过 structurePath）
    }
    for (const entry of outlineEntries) {
      const m = /^vol-(\d+)$/.exec(entry);
      if (!m) continue;
      const volNo = parseInt(m[1], 10);
      if (submittedVolumeNos.has(volNo)) continue;

      const volDir = join(outlineDir, entry);
      const staleVolOutlinePath = join(volDir, "vol-outline.md");
      if (existsSync(staleVolOutlinePath)) {
        await unlink(staleVolOutlinePath);
        filesRemoved.push(staleVolOutlinePath);
      }
      const remaining = await readdir(volDir);
      if (remaining.length === 0) {
        await rmdir(volDir);
      } else {
        warnings.push(
          `第 ${volNo} 卷已不在大纲结构中，其卷级大纲文件已清理；该卷章级细纲文件仍保留，需人工确认处置`,
        );
      }
    }
  }

  const message =
    scope === "book"
      ? `书级骨架已入库：${payload.storylines.length} 条故事线 / ${payload.foreshadowing_registry.length} 条伏笔，卷级待展开`
      : scope === "volumes"
        ? `卷级大纲已展开：${payload.volumes.length} 卷 / ${arcCount} 个 arc`
        : `书级大纲已入库：${payload.volumes.length} 卷 / ${arcCount} 个 arc / ${payload.storylines.length} 条故事线`;

  return {
    ok: true,
    scope,
    volumes: payload.volumes.length,
    arcs: arcCount,
    storylines: payload.storylines.length,
    foreshadowing_registered: payload.foreshadowing_registry.length,
    structure_synced: structureSynced,
    files_rendered: rendered,
    files_removed: filesRemoved,
    warnings,
    foreshadowing_payoff_warnings: foreshadowingPayoffWarnings,
    message,
  };
}

// ============================================================
// novel_submit_chapter_outline — 章级细纲批量提交（outline-architect）
// ============================================================

export async function novelSubmitChapterOutline(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const rawPayload = args["payload"];
  const validation = validateChapterOutlineBatch(rawPayload);
  if (!validation.valid) return errorResponse(validation.errors);
  const chapters = rawPayload as ChapterOutlineItem[];

  // 引用一致性核验（arc 覆盖 / 故事线 id / 伏笔 id / 批量 ≤4 arc）
  const arcRows = ctx.db
    .prepare(
      `SELECT arc_id, volume_no, chapter_start, chapter_end
       FROM arc_meta WHERE novel_id = ?`,
    )
    .all(ctx.novelId) as Array<Pick<ArcMetaRow, "arc_id" | "volume_no" | "chapter_start" | "chapter_end">>;
  const chapterArcIndex = new Map<number, { arcId: string; volumeNo: number }>();
  for (const arc of arcRows) {
    for (let c = arc.chapter_start; c <= arc.chapter_end; c += 1) {
      chapterArcIndex.set(c, { arcId: arc.arc_id, volumeNo: arc.volume_no });
    }
  }
  const storylineRows = ctx.db
    .prepare(`SELECT id, name FROM storylines WHERE novel_id = ?`)
    .all(ctx.novelId) as Array<Pick<StorylineRow, "id" | "name">>;
  const storylineNames = new Map(storylineRows.map((r) => [r.id, r.name]));
  const registryRows = ctx.db
    .prepare(`SELECT id, description FROM foreshadowing_registry WHERE novel_id = ?`)
    .all(ctx.novelId) as Array<Pick<ForeshadowingRegistryRow, "id" | "description">>;
  const foreshadowingDescriptions = new Map(registryRows.map((r) => [r.id, r.description]));

  const check = checkChapterBatch(chapters, {
    chapterArcIndex,
    storylineIds: new Set(storylineNames.keys()),
    foreshadowingIds: new Set(foreshadowingDescriptions.keys()),
  });
  // 开局留存门控：按「完整开局 arc」判（已落盘 ch JSON ∪ 本批 payload），不只看当前批——
  // /plan 窗口化提交会把开局 arc 切到多批（outline-planning §3），只看当前批会漏抓跨批死区，
  // 或在续跑补章（ch1-2 已落盘、本批只补 ch3）时误判黄金三章。
  let opening: { errors: ToolErrorItem[]; warnings: string[] } = { errors: [], warnings: [] };
  const openingArc = arcRows.find((a) => a.chapter_start === 1);
  if (
    openingArc &&
    chapters.some(
      (c) => c.chapter >= openingArc.chapter_start && c.chapter <= openingArc.chapter_end,
    )
  ) {
    const byChapter = new Map(chapters.map((c) => [c.chapter, c]));
    const mergedOpening: ChapterOutlineItem[] = [];
    for (let c = openingArc.chapter_start; c <= openingArc.chapter_end; c += 1) {
      const fromPayload = byChapter.get(c);
      if (fromPayload) {
        mergedOpening.push(fromPayload);
        continue;
      }
      const jsonPath = join(
        ctx.projectRoot,
        "outline",
        volumeDirSegment(openingArc.volume_no),
        `ch-${chapterFileSegment(c)}.json`,
      );
      if (existsSync(jsonPath)) {
        try {
          mergedOpening.push(JSON.parse(await readFile(jsonPath, "utf-8")) as ChapterOutlineItem);
        } catch {
          // 落盘 JSON 损坏 → 跳过该章（门控只读 chapter/payoff_beat，缺一章不阻断提交）
        }
      }
      // 文件不存在 = 该章尚未规划，跳过
    }
    opening = checkOpeningRetention(mergedOpening);
  }
  // 章末钩节奏门（W1/W2 皆 WARN 不阻断）：合并窗口 = 本批章号 min-2..max+2（HOOK_CADENCE_THRESHOLDS.window_pad），
  // 窗口内非本批章从已落盘 ch JSON 读，跨卷用 chapterArcIndex 定位卷目录（不复用开局门的单卷构造）；
  // 文件不存在/JSON 损坏/章号不在任何 arc = 未规划，不进 merged（章号断档即截断连续段）。
  // 三态语义（显式 none 延长 / 缺字段 unknown 截断 / 缺章截断）见 checkHookCadence。
  const batchChapterNums = chapters.map((c) => c.chapter);
  const batchNums = new Set(batchChapterNums);
  const byChapterHook = new Map(chapters.map((c) => [c.chapter, c]));
  const hookMerged: Array<Pick<ChapterOutlineItem, "chapter" | "end_hook">> = [];
  const hookLo = Math.max(1, Math.min(...batchChapterNums) - HOOK_CADENCE_THRESHOLDS.window_pad);
  const hookHi = Math.max(...batchChapterNums) + HOOK_CADENCE_THRESHOLDS.window_pad;
  for (let c = hookLo; c <= hookHi; c += 1) {
    const fromPayload = byChapterHook.get(c);
    if (fromPayload) {
      hookMerged.push({ chapter: c, end_hook: fromPayload.end_hook });
      continue;
    }
    const arcOfChapter = chapterArcIndex.get(c);
    if (!arcOfChapter) continue; // 章号不在任何 arc → 视同未规划
    const storedPath = join(
      ctx.projectRoot,
      "outline",
      volumeDirSegment(arcOfChapter.volumeNo),
      `ch-${chapterFileSegment(c)}.json`,
    );
    if (!existsSync(storedPath)) continue;
    try {
      const stored = JSON.parse(await readFile(storedPath, "utf-8")) as ChapterOutlineItem;
      hookMerged.push({ chapter: c, end_hook: stored.end_hook });
    } catch {
      // 落盘 JSON 损坏 → 视同 unknown 未规划，跳过（与开局门同款容错）
    }
  }
  const hookCadence = checkHookCadence(hookMerged, batchNums);
  // 大纲散文洁净门：positioning/beats/must_deliver 命中机器 token 或破折号 —— 打回自修正
  const prose = checkChapterProseHygiene(chapters);
  // 爽点强度配对完整性（issue #429）：仅查本批内 payoff_beat/payoff_intensity 配对，WARN 不阻断
  const payoffIntensity = checkPayoffIntensityConsistency(chapters);
  // 计划状态变更语义门：维度∈词表 / enum 值域 / operation×cardinality，fail-loud 打回自修正
  const stateVocab = loadStateVocabulary(ctx.projectRoot);
  const stateChangeErrors = checkStateChanges(chapters, stateVocab);
  const blockingErrors = [...check.errors, ...opening.errors, ...prose, ...stateChangeErrors];
  if (blockingErrors.length > 0) return errorResponse(blockingErrors);
  const warnings = [
    ...check.warnings,
    ...opening.warnings,
    ...hookCadence.warnings,
    ...payoffIntensity.warnings,
  ];

  // 入库：chapter_storyline_focus + 伏笔 planned 预登记 + 计划状态变更镜像
  const dimCardinality = new Map((stateVocab?.dimensions ?? []).map((d) => [d.key, d.cardinality]));
  const tx = ctx.db.transaction(() => {
    const clearFocus = ctx.db.prepare(
      `DELETE FROM chapter_storyline_focus WHERE novel_id = ? AND chapter = ?`,
    );
    const insertFocus = ctx.db.prepare(
      `INSERT OR IGNORE INTO chapter_storyline_focus (novel_id, chapter, storyline_id)
       VALUES (?, ?, ?)`,
    );
    const insertPlanned = ctx.db.prepare(
      `INSERT OR IGNORE INTO foreshadowing_actions_log
         (novel_id, chapter, foreshadowing_id, action, status)
       VALUES (?, ?, ?, ?, 'planned')`,
    );
    // 计划表镜像（#448 纪律）——共享 helper 见 planned-state.ts mirrorChapterPlannedState
    for (const ch of chapters) {
      clearFocus.run(ctx.novelId, ch.chapter);
      for (const slId of ch.storyline_focus) {
        insertFocus.run(ctx.novelId, ch.chapter, slId);
      }
      for (const ft of ch.foreshadowing_touch ?? []) {
        insertPlanned.run(ctx.novelId, ch.chapter, ft.id, ft.action);
      }
      mirrorChapterPlannedState(
        ctx.db,
        ctx.novelId,
        ch.chapter,
        (ch.state_changes ?? []).map((sc) => ({
          character_uid: sc.character.character_uid,
          character_name: sc.character.name,
          dimension: sc.dimension,
          operation: sc.operation ?? (dimCardinality.get(sc.dimension) === "one" ? "set" : "add"),
          value: sc.value,
          reason: sc.reason ?? null,
        })),
        "any-status", // 架构师重提交，原纪律不变——防止已处置的历史行被重排悄悄复活
      );
    }
  });
  tx();

  // 机械渲染 outline/vol-VV/ch-NNN.md（首行「# 第N章 …」是 App 锚点）
  // 已存在的细纲文件不覆盖（用户可能手改过）；数据照常入库，回执列 skipped
  const files: string[] = [];
  const skipped: string[] = [];
  for (const ch of [...chapters].sort((a, b) => a.chapter - b.chapter)) {
    const arc = chapterArcIndex.get(ch.chapter);
    if (!arc) continue; // checkChapterBatch 已保证覆盖；防御性跳过
    const markdown = renderChapterOutlineMarkdown(ch, {
      storylineNames,
      foreshadowingDescriptions,
    });

    const chapterDir = join(ctx.projectRoot, "outline", volumeDirSegment(arc.volumeNo));
    await mkdir(chapterDir, { recursive: true });

    // 章细纲结构化数据契约 .json 总写（App 读、WCP 读取侧优先从它现渲染、反映最新提交；
    // .md 保护用户手改不覆盖、可能陈旧——故写手侧不直接信任 .md，见 WCP builder）
    const jsonPath = join(chapterDir, `ch-${chapterFileSegment(ch.chapter)}.json`);
    await writeFile(jsonPath, `${JSON.stringify(ch, null, 2)}\n`, "utf-8");

    const filePath = join(chapterDir, `ch-${chapterFileSegment(ch.chapter)}.md`);
    if (existsSync(filePath)) {
      skipped.push(filePath);
      continue;
    }
    await writeFile(filePath, markdown, "utf-8");
    files.push(filePath);
  }

  // 网格对标尺（issue #428）：满足最小样本量时追加独立字段，与 warnings 平级但语义不同——
  // warnings 是问题，benchmark_note 是中性对照，不影响提交（永远不产生新 errors/warnings）。
  const benchmarkNote = await buildBenchmarkNote(ctx);

  return {
    ok: true,
    chapters: chapters.map((c) => c.chapter).sort((a, b) => a - b),
    arcs_covered: check.arcsCovered,
    files_rendered: files,
    files_skipped: skipped,
    warnings,
    ...(benchmarkNote ? { benchmark_note: benchmarkNote } : {}),
    message: `已提交 ${chapters.length} 章细纲（覆盖 ${check.arcsCovered.length} 个 arc${skipped.length > 0 ? `；${skipped.length} 个已存在文件未覆盖` : ""}）`,
  };
}

// ============================================================
// novel_register_foreshadowing — 伏笔单条补登
// ============================================================

export async function novelRegisterForeshadowing(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  // 剥离 undefined/null 的可选字段（ajv 中 undefined ≠ missing）
  const candidate: Record<string, unknown> = { ...args };
  for (const key of ["theme_link"]) {
    if (candidate[key] === undefined || candidate[key] === null) delete candidate[key];
  }
  const validation = validateForeshadowingItem(candidate);
  if (!validation.valid) return errorResponse(validation.errors);

  const id = args["id"] as string;
  const type = args["type"] as "small" | "medium" | "major";
  const description = args["description"] as string;
  const plantedChapter = args["planted_chapter"] as number;
  const targetReveal = args["target_reveal"] as string;
  const themeLink = (args["theme_link"] as string | undefined) ?? null;

  const existing = ctx.db
    .prepare(
      `SELECT planted_chapter FROM foreshadowing_registry WHERE novel_id = ? AND id = ?`,
    )
    .get(ctx.novelId, id) as { planted_chapter: number | null } | undefined;

  ctx.db
    .prepare(
      `INSERT INTO foreshadowing_registry
         (novel_id, id, type, description, planted_chapter, target_reveal, theme_link)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(novel_id, id) DO UPDATE SET
         type = excluded.type,
         description = excluded.description,
         planted_chapter = COALESCE(foreshadowing_registry.planted_chapter, excluded.planted_chapter),
         target_reveal = excluded.target_reveal,
         theme_link = excluded.theme_link`,
    )
    .run(ctx.novelId, id, type, description, plantedChapter, targetReveal, themeLink);

  const existingPlanted = existing?.planted_chapter;
  return {
    ok: true,
    id,
    lifecycle_guard:
      existingPlanted !== undefined &&
      existingPlanted !== null &&
      existingPlanted !== plantedChapter
        ? {
            guard: "existing_foreshadowing_register_preserved",
            existing_planted_chapter: existingPlanted,
            requested_planted_chapter: plantedChapter,
            message: "既有埋设章号已保留；后续章节对该伏笔用 develop/reveal 动作",
          }
        : undefined,
    message: `伏笔 ${id} 已登记`,
  };
}

// ============================================================
// novel_update_outline_book_field — 书级大纲定点机械更新（CAS + 三写原子）
//
// 分档红线：target 白名单仅三值——立项卡映射的四个引擎字段（中心戏剧问题 / 主角核心
// 欲望 / 主角核心缺失 / 对抗力量）不在此列，须走 novel_submit_premise(sync_engine_facts)
// 保持立项卡↔大纲同步，本工具不承接（无立项卡孪生的字段才走这里）。
// ============================================================

const OUTLINE_BOOK_FIELD_TARGETS = [
  "stakes_progression",
  "storyline_name",
  "foreshadowing_description",
] as const;
type OutlineBookFieldTarget = (typeof OUTLINE_BOOK_FIELD_TARGETS)[number];

export async function novelUpdateOutlineBookField(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const target = args["target"];
  const id = typeof args["id"] === "string" ? (args["id"] as string) : undefined;
  const newValue =
    typeof args["new_value"] === "string" ? (args["new_value"] as string).trim() : "";
  const expected =
    typeof args["expected_old_value"] === "string"
      ? (args["expected_old_value"] as string).trim()
      : "";

  if (!OUTLINE_BOOK_FIELD_TARGETS.includes(target as OutlineBookFieldTarget)) {
    return errorResponse([
      {
        field: "target",
        expected: OUTLINE_BOOK_FIELD_TARGETS.join(" | "),
        actual: `${typeof target}: ${JSON.stringify(target)}`,
        hint:
          "立项卡映射字段（中心戏剧问题 / 主角核心欲望 / 主角核心缺失 / 对抗力量）不在本工具范围，" +
          "须经 novel_submit_premise（sync_engine_facts）修订以保持立项卡与大纲同步",
      },
    ]);
  }
  const validatedTarget = target as OutlineBookFieldTarget;

  if (!newValue) {
    return errorResponse([
      {
        field: "new_value",
        expected: "trim 后非空字符串",
        actual: `${typeof args["new_value"]}: ${JSON.stringify(args["new_value"])}`,
        hint: "内容不能为空",
      },
    ]);
  }

  if (validatedTarget !== "stakes_progression" && !id) {
    return errorResponse([
      {
        field: "id",
        expected: "非空字符串（storyline_name / foreshadowing_description 必填）",
        actual: `${typeof args["id"]}: ${JSON.stringify(args["id"])}`,
        hint: "storyline_name / foreshadowing_description 必须携带 id",
      },
    ]);
  }

  // 读 JSON（不存在即拒，不臆造结构）
  const structurePath = join(ctx.projectRoot, "outline", "outline-structure.json");
  if (!existsSync(structurePath)) {
    return errorResponse([
      {
        field: "outline",
        expected: "outline/outline-structure.json 已存在",
        actual: "文件不存在",
        hint: "大纲尚未生成，无法定点更新",
      },
    ]);
  }
  const payload = JSON.parse(await readFile(structurePath, "utf-8")) as OutlinePayload;

  // 定位当前值 + CAS（三分支互斥定位，均取不到即视为「条目不存在」）
  let current: string | undefined;
  if (validatedTarget === "stakes_progression") current = payload.stakes_progression;
  if (validatedTarget === "storyline_name")
    current = payload.storylines?.find((s) => s.id === id)?.name;
  if (validatedTarget === "foreshadowing_description")
    current = payload.foreshadowing_registry?.find((f) => f.id === id)?.description;
  if (current === undefined) {
    return errorResponse([
      {
        field: "id",
        expected: "大纲中存在的条目 id",
        actual: String(id),
        hint: "未在大纲中找到该条目",
      },
    ]);
  }
  if (current.trim() !== expected) {
    return errorResponse([
      {
        field: "expected_old_value",
        expected: current,
        actual: expected,
        hint: "大纲已更新，请刷新后重试",
      },
    ]);
  }

  // 更新 payload（不可变改写）+ DB 孪生
  let nextPayload: OutlinePayload = payload;
  if (validatedTarget === "stakes_progression") {
    nextPayload = { ...payload, stakes_progression: newValue };

    // facts 删旧→插新，逐行照抄 syncPremiseEngineFacts（writers.ts:1311-1354）既有模式；
    // embedding 在事务外先算，与 submit_outline / syncPremiseEngineFacts 一致
    const content = `全书 stakes_progression ${newValue}`;
    const embedding = await embed(content);
    const factId = randomUUID();
    const tx = ctx.db.transaction(() => {
      const stale = ctx.db
        .prepare(`SELECT id FROM facts WHERE novel_id = ? AND subject = '全书' AND predicate = ?`)
        .all(ctx.novelId, "stakes_progression") as Array<{ id: string }>;
      const staleIds = stale.map((r) => r.id);
      ftsDeleteBySourceIds(ctx.db, "facts", staleIds);
      vecDeleteBySourceIds(ctx.db, "facts", staleIds);
      for (const staleId of staleIds) {
        ctx.db.prepare(`DELETE FROM facts WHERE id = ?`).run(staleId);
      }
      ctx.db
        .prepare(
          `INSERT INTO facts (id, novel_id, subject, predicate, object, sector, from_chapter, source)
           VALUES (?, ?, '全书', ?, ?, 'semantic', 1, 'authored')`,
        )
        .run(factId, ctx.novelId, "stakes_progression", newValue);
      ftsInsert(ctx.db, content, "facts", factId, ctx.novelId, "semantic");
      if (embedding) {
        vecInsert(ctx.db, "facts", factId, ctx.novelId, "semantic", embedding);
      }
    });
    tx();
  } else if (validatedTarget === "storyline_name") {
    nextPayload = {
      ...payload,
      storylines: payload.storylines.map((s) => (s.id === id ? { ...s, name: newValue } : s)),
    };
    ctx.db
      .prepare(`UPDATE storylines SET name = ? WHERE novel_id = ? AND id = ?`)
      .run(newValue, ctx.novelId, id);
  } else {
    nextPayload = {
      ...payload,
      foreshadowing_registry: payload.foreshadowing_registry.map((f) =>
        f.id === id ? { ...f, description: newValue } : f,
      ),
    };
    ctx.db
      .prepare(`UPDATE foreshadowing_registry SET description = ? WHERE novel_id = ? AND id = ?`)
      .run(newValue, ctx.novelId, id);
  }

  // 三写收口：JSON + master-outline.md（Task 9 抽出的既有写函数，含叙述者腔调重渲）
  await persistOutlineStructure(ctx, nextPayload);

  return { ok: true, target: validatedTarget, ...(id ? { id } : {}), new_value: newValue };
}

// ============================================================
// novel_rollback_chapter — 回滚章节（按 invalidated_at_chapter 恢复）
// ============================================================

export async function novelRollbackChapter(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const chapter = args["chapter"];
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter < 1) {
    return singleError(
      "chapter",
      "integer ≥ 1",
      `${typeof chapter}: ${JSON.stringify(chapter)}`,
      "传入回滚起始章号（该章及之后的记忆将被清除）",
    );
  }

  let deletedSummaries = 0;
  let deletedFacts = 0;
  let restoredFacts = 0;
  let deletedActions = 0;
  let deletedReviews = 0;
  let deletedArcSummaries = 0;
  let refreshedCards: string[] = [];

  const tx = ctx.db.transaction(() => {
    // 1. 章摘要：chapter ≥ target 全删（含索引）
    const summaryIds = (
      ctx.db
        .prepare(
          "SELECT id FROM chapter_summaries WHERE novel_id = ? AND chapter >= ?",
        )
        .all(ctx.novelId, chapter) as Array<{ id: string }>
    ).map((r) => r.id);
    ftsDeleteBySourceIds(ctx.db, "chapter_summaries", summaryIds);
    vecDeleteBySourceIds(ctx.db, "chapter_summaries", summaryIds);
    ctx.db
      .prepare("DELETE FROM chapter_summaries WHERE novel_id = ? AND chapter >= ?")
      .run(ctx.novelId, chapter);
    deletedSummaries = summaryIds.length;

    // 1b. 样章锚：该章正文被回滚后，指向它的声音锚随之失去出处，一并清理
    ctx.db
      .prepare("DELETE FROM style_anchors WHERE novel_id = ? AND chapter >= ?")
      .run(ctx.novelId, chapter);

    // 2. 事实：from_chapter ≥ target 删除（含索引）
    const factIds = (
      ctx.db
        .prepare("SELECT id FROM facts WHERE novel_id = ? AND from_chapter >= ?")
        .all(ctx.novelId, chapter) as Array<{ id: string }>
    ).map((r) => r.id);
    ftsDeleteBySourceIds(ctx.db, "facts", factIds);
    vecDeleteBySourceIds(ctx.db, "facts", factIds);
    ctx.db
      .prepare("DELETE FROM facts WHERE novel_id = ? AND from_chapter >= ?")
      .run(ctx.novelId, chapter);
    deletedFacts = factIds.length;

    // 3. 恢复被回滚区间失效的旧事实：invalidated_at_chapter ≥ target → 重新生效
    const restored = ctx.db
      .prepare(
        `UPDATE facts SET invalidated_at_chapter = NULL, invalidated_by = NULL, updated_at = datetime('now')
         WHERE novel_id = ? AND invalidated_at_chapter >= ? AND from_chapter < ?`,
      )
      .run(ctx.novelId, chapter, chapter);
    restoredFacts = restored.changes;

    // 3b. 悬垂失效兜底：本次删除的 factIds 若曾是某些行的 invalidated_by（取代者），那些受害行
    // 须复活——即便受害行自身的 invalidated_at_chapter 早于回滚点、不满足步骤 3 的阈值判定。
    // 典型场景：correct 把新行生效章后移（new_event_chapter 晚于原发生章）后回滚到中间点，
    // 新行 from_chapter ≥ target 被步骤 2 删除，但旧行的 invalidated_at_chapter 仍是更早的原发生
    // 章（< target），不会被步骤 3 捞回，形成「事实空洞」——本步骤按取代者 id 兜底恢复（评审 I2）
    for (const deletedId of factIds) {
      restoredFacts += revalidateVictimsOf(ctx.db, ctx.novelId, deletedId);
    }

    // 4. 伏笔兑现动作：chapter ≥ target 的 realized 删除（planned 来自大纲，保留）
    const actions = ctx.db
      .prepare(
        `DELETE FROM foreshadowing_actions_log
         WHERE novel_id = ? AND chapter >= ? AND status = 'realized'`,
      )
      .run(ctx.novelId, chapter);
    deletedActions = actions.changes;

    // 5. 审校路由信号
    const reviews = ctx.db
      .prepare("DELETE FROM chapter_reviews WHERE novel_id = ? AND chapter >= ?")
      .run(ctx.novelId, chapter);
    deletedReviews = reviews.changes;

    // 5b. 抽取暂存：回滚区间内残留的 stage 行清掉，否则回滚后重写时旧暂存会被 commit-union 混入
    ctx.db
      .prepare("DELETE FROM extraction_stage WHERE novel_id = ? AND chapter >= ?")
      .run(ctx.novelId, chapter);

    // 6. 温层摘要：区间触及回滚范围的整条删除（后续 consolidate 重建）
    const staleScopes = ctx.db
      .prepare(
        `SELECT scope, scope_id FROM arc_summaries WHERE novel_id = ? AND chapter_end >= ?`,
      )
      .all(ctx.novelId, chapter) as Array<{ scope: string; scope_id: string }>;
    const staleSourceIds = staleScopes.map((s) => `${s.scope}:${s.scope_id}`);
    ftsDeleteBySourceIds(ctx.db, "arc_summaries", staleSourceIds);
    vecDeleteBySourceIds(ctx.db, "arc_summaries", staleSourceIds);
    ctx.db
      .prepare("DELETE FROM arc_summaries WHERE novel_id = ? AND chapter_end >= ?")
      .run(ctx.novelId, chapter);
    deletedArcSummaries = staleScopes.length;

    // 7. 角色卡：as_of_chapter ≥ target 的按回滚后事实重折叠（无事实则删卡）
    const staleCards = ctx.db
      .prepare(
        `SELECT character_uid, character FROM character_cards WHERE novel_id = ? AND as_of_chapter >= ?`,
      )
      .all(ctx.novelId, chapter) as Array<{ character_uid: string; character: string }>;
    const asOf = chapter - 1;
    const deleteCard = ctx.db.prepare(
      `DELETE FROM character_cards WHERE novel_id = ? AND character_uid = ?`,
    );
    const survivors: Array<{ uid: string; name: string }> = [];
    for (const { character_uid, character } of staleCards) {
      const card = foldCharacterCard(ctx, character_uid, asOf);
      if (isEmptyFoldedCard(card)) {
        deleteCard.run(ctx.novelId, character_uid);
      } else {
        survivors.push({ uid: character_uid, name: character });
      }
    }
    refreshedCards = refreshCharacterCards(ctx, survivors, asOf);
  });
  tx();

  // receipt 文件清理（hook 据 receipt 判断收尾完成度）
  const receiptsDir = join(ctx.projectRoot, ".narracat", "receipts");
  let deletedReceipts = 0;
  try {
    for (const file of await readdir(receiptsDir)) {
      const m = file.match(/^ch-(\d{3,})\.json$/);
      if (m && parseInt(m[1], 10) >= chapter) {
        await unlink(join(receiptsDir, file));
        deletedReceipts += 1;
      }
    }
  } catch {
    // receipts 目录不存在时静默
  }

  // 审校契约文件清理（与 chapter_reviews DB 删除保持一致，避免 App 渲染已回滚章节的过期审校）
  const reviewsDir = join(ctx.projectRoot, "reviews");
  let deletedReviewFiles = 0;
  try {
    for (const file of await readdir(reviewsDir)) {
      const m = file.match(/^ch-(\d{3,})-review\.json$/);
      if (m && parseInt(m[1], 10) >= chapter) {
        await unlink(join(reviewsDir, file));
        deletedReviewFiles += 1;
      }
    }
  } catch {
    // reviews 目录不存在时静默
  }

  // state.yaml 进度同步回退（机械完成，LLM 零 Edit）
  const stateRevert = await revertProgressToChapter(ctx.projectRoot, chapter);
  const stateNote = stateRevert.ok
    ? `进度已回退（完成 ${stateRevert.completed_chapters.length} 章，总字数 ${stateRevert.word_count_total}）`
    : `state.yaml 进度回退失败：${stateRevert.error}`;

  return {
    ok: true,
    from_chapter: chapter,
    deleted: {
      chapter_summaries: deletedSummaries,
      facts: deletedFacts,
      foreshadowing_actions: deletedActions,
      chapter_reviews: deletedReviews,
      review_files: deletedReviewFiles,
      arc_summaries: deletedArcSummaries,
      receipts: deletedReceipts,
    },
    restored_facts: restoredFacts,
    character_cards_refreshed: refreshedCards,
    state_progress_reverted: stateRevert.ok,
    message: `已回滚第${chapter}章及之后的记忆（恢复 ${restoredFacts} 条曾被覆盖的事实）；${stateNote}`,
  };
}

// ============================================================
// novel_submit_dialogue_samples — 角色台词语料入库（memory-keeper；声音支柱 A）
//
// 逐章提取的角色台词样本经 ajv 校验 → 别名归一到 character_uid →
// INSERT OR IGNORE 落 character_dialogue_samples（UNIQUE 防重）。
// 无法归一到 uid 的样本计入 warnings 并跳过——按 uid 取料的读路径不留死数据。
// ============================================================

interface DialogueSampleArg {
  character: string;
  dialogue_text: string;
  dialogue_type: string;
  context?: string;
  emotion?: string;
  position_in_chapter?: number;
}

export async function novelSubmitDialogueSamples(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const validation = validateDialogueSamples(args);
  if (!validation.valid) return errorResponse(validation.errors);

  const chapter = args["chapter"] as number;
  const samples = args["samples"] as DialogueSampleArg[];

  const aliasMap = await loadAliasMap(ctx.projectRoot);
  const warnings: string[] = [];
  const unresolved = new Set<string>();
  const resolved = samples
    .map((s) => ({ sample: s, uid: resolveCharacterUid(s.character, aliasMap) }))
    .filter(({ sample, uid }) => {
      if (uid) return true;
      unresolved.add(sample.character);
      return false;
    })
    .map(({ sample, uid }) => ({ sample, uid, name: normalizeName(sample.character, aliasMap) }));

  for (const name of unresolved) {
    warnings.push(
      `角色「${name}」未解析到 character_uid，台词样本已跳过：确认该名与 bible/characters/ 档案文件名或「别名:」声明一致`,
    );
  }

  let stored = 0;
  const tx = ctx.db.transaction(() => {
    const stmt = ctx.db.prepare(
      `INSERT OR IGNORE INTO character_dialogue_samples
        (id, novel_id, chapter, character, character_uid, dialogue_text, context, emotion, dialogue_type, position_in_chapter)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { sample, uid, name } of resolved) {
      const info = stmt.run(
        randomUUID(),
        ctx.novelId,
        chapter,
        name,
        uid,
        sample.dialogue_text,
        sample.context ?? null,
        sample.emotion ?? null,
        sample.dialogue_type,
        sample.position_in_chapter ?? null,
      );
      stored += info.changes;
    }
  });
  tx();

  return {
    ok: true,
    chapter,
    samples_stored: stored,
    warnings,
    message: `第${chapter}章台词语料已入库（新增 ${stored} 条${
      unresolved.size > 0 ? `，跳过 ${unresolved.size} 个未建档角色` : ""
    }）`,
  };
}
