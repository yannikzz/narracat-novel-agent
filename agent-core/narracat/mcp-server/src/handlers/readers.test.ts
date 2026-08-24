import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

vi.mock("../utils/embedding.js", () => ({
  embed: vi.fn(async () => null),
}));

import { initSchema } from "../migrate.js";
import { ftsInsert } from "../utils/fts.js";
import { resetPackResolverCache } from "../packs/pack-resolver.js";
import type { ToolContext } from "../types.js";
import {
  novelCommitChapter,
  novelSubmitExtraction,
  novelSubmitOutline,
  novelSubmitChapterOutline,
  novelSubmitReview,
  novelRegisterForeshadowing,
} from "./writers.js";
import { novelSubmitStateVocabulary, novelSubmitCharacterEntity } from "./character-entity.js";
import { novelSubmitStyleAnchor } from "./style-anchor.js";
import {
  novelQuery,
  novelChapterSummary,
  novelCharacterState,
  novelCharacterStatuses,
  novelRelationship,
  novelForeshadowingStatus,
  novelForeshadowingDensity,
  novelGetArc,
  novelCheckProseHygiene,
  novelGetReview,
  novelFailedReviews,
  novelGetStructureBudget,
  novelWritingContext,
  novelBuildWritingContextPack,
  novelGetCharacterDialogueSamples,
  abstractRatio,
  renderStyleDirective,
  positivizeNarratorFreeText,
  positivizeStyleKeywords,
  parseRenderedOutline,
  novelExtractionScaffold,
  novelListStructureCards,
  getForeshadowingDue,
} from "./readers.js";
import { __resetCorpusCachesForTest } from "../corpus-loader.js";

const CORPUS_FIXTURE_DIR = fileURLToPath(
  new URL("../__fixtures__/corpus-extracts/", import.meta.url),
);

function loadFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf-8"),
  ) as T;
}

const BASE_STATE = [
  "progress:",
  "  last_completed_chapter: 0",
  "  completed_chapters: []",
  "  in_progress_chapter: null",
  "word_count:",
  "  total: 0",
  "  by_chapter: {}",
  "structure:",
  "  total_volumes: 0",
  "  total_chapters_planned: 0",
  "  chapter_to_volume: {}",
  "checkpoint:",
  "  last_command: null",
  "  last_step: null",
  "  timestamp: null",
  "",
].join("\n");

const PREMISE_WITH_VOICE = [
  "# 立项卡",
  "",
  "## 7 世界规则可冲突性",
  "",
  "| 规则 | 让谁和谁打起来 |",
  "|---|---|",
  "| 灵气只能从血脉觉醒 | 庶出主角与嫡系争夺觉醒资源 |",
  "",
  "## 8 叙述声音",
  "",
  "- archetype: 猛文热血",
  "- tone: 干净利落的爽文笔调",
  "- pacing: 急",
  "- address: 第三人称",
  "",
].join("\n");

let cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupPaths = [];
});

interface ProjectFixture {
  ctx: ToolContext;
  root: string;
  db: Database.Database;
}

function createProject(overrides: Partial<ToolContext> = {}): ProjectFixture {
  const root = mkdtempSync(join(tmpdir(), "narracat-readers-"));
  cleanupPaths.push(root);
  mkdirSync(join(root, ".narracat"), { recursive: true });
  mkdirSync(join(root, "manuscript", "vol-01"), { recursive: true });
  mkdirSync(join(root, "bible", "characters"), { recursive: true });
  writeFileSync(join(root, ".narracat", "state.yaml"), BASE_STATE);
  writeFileSync(join(root, "bible", "premise.md"), PREMISE_WITH_VOICE);

  const db = new Database(":memory:");
  initSchema(db);

  return {
    root,
    db,
    ctx: {
      novelId: "novel-test",
      db,
      projectRoot: root,
      estimatedTotalChapters: 60,
      wordsPerChapter: 3000,
      styleProfile: "web_standard",
      ...overrides,
    },
  };
}

const LINWAN_UID = "11111111-1111-4111-8111-111111111111";
const ZHAOBO_UID = "22222222-2222-4222-8222-222222222222";

/** 写带 character_identity 的角色档案（提供 character_uid 供工具入口解析） */
function writeCharacter(root: string, name: string, uid: string): void {
  writeFileSync(
    join(root, "bible", "characters", `${name}.md`),
    `<!-- character_identity: {"character_uid":"${uid}","name":"${name}"} -->\n# ${name}\n`,
  );
}

function writeManuscript(root: string, chapter: number): void {
  const padded = String(chapter).padStart(3, "0");
  writeFileSync(
    join(root, "manuscript", "vol-01", `ch-${padded}.md`),
    `# 第${chapter}章\n\n${"林晚握着断剑站在剑冢里，掌心的伤口还在渗血。".repeat(40)}\n`,
  );
}

/** 直插一条角色事实（片4 聊天滤网测试专用；绕开 novel_submit_extraction 走最短路径）。 */
function insertFact(
  db: Database.Database,
  args: {
    id: string;
    novelId: string;
    subjectUid: string;
    subject: string;
    predicate: string;
    object: string;
    fromChapter: number;
    secretKnown?: 0 | 1;
  },
): void {
  db.prepare(
    `INSERT INTO facts
       (id, novel_id, subject, subject_character_uid, predicate, object, from_chapter, event_chapter, secret_known)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.novelId,
    args.subject,
    args.subjectUid,
    args.predicate,
    args.object,
    args.fromChapter,
    args.fromChapter,
    args.secretKnown ?? 0,
  );
}

/** 完整种子：书级大纲 + 章纲 1-2 + 第 1 章收尾入库 */
async function seedFullProject(fixture: ProjectFixture): Promise<void> {
  const { ctx, root } = fixture;
  writeCharacter(root, "林晚", LINWAN_UID);
  writeCharacter(root, "赵伯", ZHAOBO_UID);
  writeCharacter(root, "药圃管事", "33333333-3333-4333-8333-333333333333");
  await novelSubmitOutline(
    { phase: 1, payload: loadFixture("outline-v5-valid-book.json") },
    ctx,
  );
  await novelSubmitChapterOutline(
    { payload: loadFixture("chapter-outline-v5-valid-batch.json") },
    ctx,
  );
  writeManuscript(root, 1);
  await novelCommitChapter(
    {
      chapter: 1,
      summary:
        "晨检发现药圃血参连根失窃，泥土上只有林晚常穿的草鞋印。管事当众翻开林晚的床板，搜出半截带泥的参须，赵伯替他作保被当众驳回，罚俸三月。林晚捏着那截参须没有争辩——切口平整，是剑气削断的，而整个杂役峰没人会用剑。他把参须收进袖中，决定自己查出真正的窃贼，否则外门大比的资格保不住，妹妹的药钱也会断。",
      anchor: {
        core_experience: "被构陷却发现关键证物只有自己看得懂",
        heartbeat_moment: "参须切口平整——是剑气削断的",
      },
      key_events: ["血参失窃", "床板搜出参须", "林晚发现剑气切口"],
      characters_appeared: ["林晚", "赵伯", "药圃管事"],
      emotional_tone: "蒙冤后的冷静",
      continuation_hook: ["真正的窃贼会用剑，外门大比前必须找到他"],
      foreshadowing_actions: [{ id: "S-HERB", action: "plant" }],
    },
    ctx,
  );
  // pass 审校 + 正文指纹：自动兜底取样（pickAutoVoiceSample）对第 1 章要求 checkReviewFreshness
  // 严档，没有这条通过记录会让所有依赖自动取样的既有用例顺延到窗口耗尽、拿不到样章。
  await novelSubmitReview({ chapter: 1, issues: [] }, ctx);
  await novelSubmitExtraction(
    {
      chapter: 1,
      facts: [
        { subject: "林晚", predicate: "status", object: "背负偷参嫌疑", change_type: "new" },
        { subject: "林晚", predicate: "goal", object: "查出真正的窃贼", change_type: "new" },
      ],
      relationship_updates: [{ a: "赵伯", b: "林晚", state: "作保失败后愧疚照拂" }],
    },
    ctx,
  );
}

describe("novel_get_structure_budget", () => {
  it("config 缺篇幅字段时返回带 hint 的错误", async () => {
    const { ctx } = createProject({ estimatedTotalChapters: null, wordsPerChapter: null });
    const result = (await novelGetStructureBudget({}, ctx)) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    const errors = result.errors as Array<{ hint: string }>;
    expect(errors[0].hint).toContain("setup");
  });

  it("返回预算表（tier / 卷数 / arc 跨度 / 伏笔预算）", async () => {
    const { ctx } = createProject();
    const result = (await novelGetStructureBudget({}, ctx)) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      tier: "S",
      total_chapters: 60,
      storyline_budget: 2,
    });
    expect(result.arc_span).toEqual({ min: 5, max: 15 });
  });
});

describe("novel_get_arc", () => {
  it("按章号反查 arc 与卷边界", async () => {
    const fixture = createProject();
    await novelSubmitOutline(
      { phase: 1, payload: loadFixture("outline-v5-valid-book.json") },
      fixture.ctx,
    );

    const result = (await novelGetArc({ chapter: 13 }, fixture.ctx)) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      found: true,
      queried_chapter: 13,
      is_arc_end: false,
      is_volume_end: false,
      arc: {
        arc_id: "V01-A02",
        chapter_start: 13,
        chapter_end: 24,
      },
      volume: { volume_no: 1, chapter_start: 1, chapter_end: 24 },
    });
    const arc = result.arc as Record<string, unknown>;
    expect(arc.core_question).toContain("封冢前");
    expect(arc.payoff_beats).toEqual(["reveal", "counterattack"]);
  });

  it("按章号查询时返回 arc 末/卷末布尔（边界由代码判定）", async () => {
    const fixture = createProject();
    await novelSubmitOutline(
      { phase: 1, payload: loadFixture("outline-v5-valid-book.json") },
      fixture.ctx,
    );

    const arcEnd = (await novelGetArc({ chapter: 12 }, fixture.ctx)) as Record<string, unknown>;
    expect(arcEnd).toMatchObject({ found: true, is_arc_end: true, is_volume_end: false });

    const volumeEnd = (await novelGetArc({ chapter: 24 }, fixture.ctx)) as Record<string, unknown>;
    expect(volumeEnd).toMatchObject({ found: true, is_arc_end: true, is_volume_end: true });
  });

  it("按 arc_id 查询", async () => {
    const fixture = createProject();
    await novelSubmitOutline(
      { phase: 1, payload: loadFixture("outline-v5-valid-book.json") },
      fixture.ctx,
    );
    const result = (await novelGetArc({ arc_id: "V01-A01" }, fixture.ctx)) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({ ok: true, found: true });
    // V01-A01 fixture 填了 antagonist_agent（issue #429）
    const arc = result.arc as Record<string, unknown>;
    expect(arc.antagonist_agent).toBe("药圃管事");
  });

  it("arc 未填 antagonist_agent 时，字段从响应中省略（不放空壳）", async () => {
    const fixture = createProject();
    await novelSubmitOutline(
      { phase: 1, payload: loadFixture("outline-v5-valid-book.json") },
      fixture.ctx,
    );
    // V01-A02 fixture 未填 antagonist_agent
    const result = (await novelGetArc({ arc_id: "V01-A02" }, fixture.ctx)) as Record<
      string,
      unknown
    >;
    const arc = result.arc as Record<string, unknown>;
    expect(arc).not.toHaveProperty("antagonist_agent");
  });

  it("规划末尾之外的章号返回 found=false", async () => {
    const fixture = createProject();
    await novelSubmitOutline(
      { phase: 1, payload: loadFixture("outline-v5-valid-book.json") },
      fixture.ctx,
    );
    const result = (await novelGetArc({ chapter: 25 }, fixture.ctx)) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, found: false });
  });
});

describe("novel_check_prose_hygiene — fingerprint_findings（Task 8）", () => {
  function writeManuscriptText(root: string, chapter: number, text: string): void {
    const padded = String(chapter).padStart(3, "0");
    writeFileSync(join(root, "manuscript", "vol-01", `ch-${padded}.md`), text);
  }

  it("ok:true 分支：含「缓缓」「就在这时」但无破折号 → 洁净通过且带 adverb_universal 指纹", async () => {
    const { ctx, root } = createProject();
    writeManuscriptText(
      root,
      1,
      "# 第1章\n\n林晚缓缓抬起头，握紧了断剑。就在这时，门外传来一阵脚步声。",
    );

    const result = (await novelCheckProseHygiene({ chapter: 1 }, ctx)) as {
      ok: boolean;
      fingerprint_findings: Array<{ category: string }>;
    };

    expect(result.ok).toBe(true);
    expect(result.fingerprint_findings).toBeDefined();
    expect(result.fingerprint_findings.length).toBeGreaterThan(0);
    expect(result.fingerprint_findings.some((f) => f.category === "adverb_universal")).toBe(true);
  });

  it("ok:false 分支：破折号超标（>2.0/千字，>500 汉字）→ errors 不变，同样带 fingerprint_findings", async () => {
    const { ctx, root } = createProject();
    const unit = "林晚握剑而立，眉心一凝——";
    writeManuscriptText(root, 1, `# 第1章\n\n${unit.repeat(60)}`);

    const result = (await novelCheckProseHygiene({ chapter: 1 }, ctx)) as {
      ok: boolean;
      errors: Array<{ field: string }>;
      fingerprint_findings: Array<{ category: string }>;
    };

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].field).toBe("破折号密度");
    expect(result.fingerprint_findings).toBeDefined();
    expect(Array.isArray(result.fingerprint_findings)).toBe(true);
  });
});

describe("novel_get_review", () => {
  it("无审校记录时 found=false", async () => {
    const { ctx } = createProject();
    const result = (await novelGetReview({ chapter: 2 }, ctx)) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, found: false });
  });

  it("返回 verdict 与 blockers（主会话路由依据）", async () => {
    const { ctx } = createProject();
    await novelSubmitReview(loadFixture("review-report-v5-valid-fail-blocker.json"), ctx);

    const result = (await novelGetReview({ chapter: 2 }, ctx)) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, found: true, verdict: "fail" });
    const blockers = result.blockers as Array<Record<string, unknown>>;
    expect(blockers).toHaveLength(1);
    expect(blockers[0].fix_hint).toBeTruthy();
    expect(result.notes).toHaveLength(1);
  });
});

describe("novel_failed_reviews", () => {
  it("无审校记录时返回空清单", async () => {
    const { ctx } = createProject();
    const result = (await novelFailedReviews({}, ctx)) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, count: 0 });
    expect(result.failed_chapters).toEqual([]);
  });

  it("列出 verdict=fail 章节；pass 覆盖后移出清单", async () => {
    const { ctx } = createProject();
    await novelSubmitReview(loadFixture("review-report-v5-valid-fail-blocker.json"), ctx);
    let result = (await novelFailedReviews({}, ctx)) as Record<string, unknown>;
    expect(result.failed_chapters).toEqual([2]);

    await novelSubmitReview(loadFixture("review-report-v5-valid-pass.json"), ctx);
    result = (await novelFailedReviews({}, ctx)) as Record<string, unknown>;
    expect(result.failed_chapters).toEqual([]);
  });
});

describe("novel_foreshadowing_status", () => {
  it("状态从最新已兑现动作机械导出", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);

    const result = (await novelForeshadowingStatus({}, fixture.ctx)) as {
      ok: boolean;
      foreshadowing: Array<Record<string, unknown>>;
    };
    expect(result.ok).toBe(true);
    const byId = new Map(result.foreshadowing.map((f) => [f.id, f]));
    expect(byId.get("S-HERB")).toMatchObject({ status: "planted" });
    expect(byId.get("F-TRAITOR")).toMatchObject({ status: "registered" });
  });

  it("active 过滤排除已揭示伏笔", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    fixture.db
      .prepare(
        `INSERT INTO foreshadowing_actions_log (novel_id, chapter, foreshadowing_id, action, status)
         VALUES ('novel-test', 8, 'S-HERB', 'reveal', 'realized')`,
      )
      .run();

    const active = (await novelForeshadowingStatus({ active: true }, fixture.ctx)) as {
      foreshadowing: Array<{ id: string }>;
    };
    expect(active.foreshadowing.map((f) => f.id)).not.toContain("S-HERB");

    const resolved = (await novelForeshadowingStatus({ active: false }, fixture.ctx)) as {
      foreshadowing: Array<{ id: string; status: string }>;
    };
    expect(resolved.foreshadowing).toEqual([
      expect.objectContaining({ id: "S-HERB", status: "revealed" }),
    ]);
  });
});

describe("novel_foreshadowing_density", () => {
  it("按章 / arc / 卷统计计划与兑现", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);

    const chapter = (await novelForeshadowingDensity({ chapter: 1 }, fixture.ctx)) as Record<
      string,
      unknown
    >;
    expect(chapter).toMatchObject({ ok: true, scope: "chapter", expected: 1, actual: 1 });

    const arc = (await novelForeshadowingDensity({ arc_id: "V01-A01" }, fixture.ctx)) as Record<
      string,
      unknown
    >;
    expect(arc).toMatchObject({ ok: true, scope: "arc", expected: 2, actual: 1 });

    const volume = (await novelForeshadowingDensity({ volume: 1 }, fixture.ctx)) as Record<
      string,
      unknown
    >;
    expect(volume).toMatchObject({ ok: true, scope: "volume" });
  });

  it("arc 不存在时返回错误", async () => {
    const { ctx } = createProject();
    const result = (await novelForeshadowingDensity({ arc_id: "V09-A01" }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(false);
  });
});

describe("novel_character_state / novel_relationship", () => {
  it("角色状态卡按最新值折叠并尊重失效边界", async () => {
    const fixture = createProject();
    const { ctx, root } = fixture;
    writeCharacter(root, "林晚", LINWAN_UID);
    await novelSubmitExtraction(
      {
        chapter: 1,
        facts: [
          { subject: "林晚", predicate: "location", object: "杂役峰药圃", change_type: "new" },
        ],
      },
      ctx,
    );
    await novelSubmitExtraction(
      {
        chapter: 2,
        facts: [
          { subject: "林晚", predicate: "location", object: "剑冢偏院", change_type: "update" },
        ],
      },
      ctx,
    );

    const at1 = (await novelCharacterState({ character_uid: LINWAN_UID, at_chapter: 1 }, ctx)) as {
      card: Record<string, string>;
    };
    expect(at1.card.location).toBe("杂役峰药圃");

    const at2 = (await novelCharacterState({ character_uid: LINWAN_UID, at_chapter: 2 }, ctx)) as {
      card: Record<string, string>;
    };
    expect(at2.card.location).toBe("剑冢偏院");
  });

  it("关系查询不分参数顺序", async () => {
    const fixture = createProject();
    writeCharacter(fixture.root, "林晚", LINWAN_UID);
    writeCharacter(fixture.root, "赵伯", ZHAOBO_UID);
    await novelSubmitExtraction(
      {
        chapter: 1,
        facts: [],
        relationship_updates: [{ a: "赵伯", b: "林晚", state: "作保失败后愧疚照拂" }],
      },
      fixture.ctx,
    );

    const result = (await novelRelationship(
      { character_a_uid: LINWAN_UID, character_b_uid: ZHAOBO_UID },
      fixture.ctx,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      current_state: "作保失败后愧疚照拂",
    });
  });
});

describe("novel_character_statuses", () => {
  it("facts.status 折叠命中：按截至章取最新 status", async () => {
    const fixture = createProject();
    const { ctx, root } = fixture;
    writeCharacter(root, "林晚", LINWAN_UID);
    await novelSubmitExtraction(
      {
        chapter: 1,
        facts: [
          { subject: "林晚", predicate: "status", object: "背负偷参嫌疑", change_type: "new" },
        ],
      },
      ctx,
    );
    await novelSubmitExtraction(
      {
        chapter: 2,
        facts: [
          { subject: "林晚", predicate: "status", object: "查到剑气切口", change_type: "update" },
        ],
      },
      ctx,
    );

    const at1 = (await novelCharacterStatuses(
      { character_uids: [LINWAN_UID], at_chapter: 1 },
      ctx,
    )) as { ok: boolean; at_chapter: number; statuses: Record<string, string> };
    expect(at1).toMatchObject({ ok: true, at_chapter: 1 });
    expect(at1.statuses[LINWAN_UID]).toBe("背负偷参嫌疑");

    const at2 = (await novelCharacterStatuses(
      { character_uids: [LINWAN_UID], at_chapter: 2 },
      ctx,
    )) as { statuses: Record<string, string> };
    expect(at2.statuses[LINWAN_UID]).toBe("查到剑气切口");
  });

  it("无 facts.status 时回落 character_cards 的 status/current_state", async () => {
    const fixture = createProject();
    const { ctx } = fixture;
    // 无 status fact，直接预置存量卡（兜底来源）。
    ctx.db
      .prepare(
        `INSERT INTO character_cards (novel_id, character_uid, character, as_of_chapter, card_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ctx.novelId, LINWAN_UID, "林晚", 3, JSON.stringify({ status: "刚救回伤员，精神紧绷" }));
    ctx.db
      .prepare(
        `INSERT INTO character_cards (novel_id, character_uid, character, as_of_chapter, card_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ctx.novelId, ZHAOBO_UID, "赵伯", 3, JSON.stringify({ current_state: "作保失败后愧疚照拂" }));

    const result = (await novelCharacterStatuses(
      { character_uids: [LINWAN_UID, ZHAOBO_UID], at_chapter: 3 },
      ctx,
    )) as { statuses: Record<string, string> };
    expect(result.statuses[LINWAN_UID]).toBe("刚救回伤员，精神紧绷");
    expect(result.statuses[ZHAOBO_UID]).toBe("作保失败后愧疚照拂");
  });

  it("无 facts.status 时回落 v2 折叠卡（status 归入维度显示名'生死'）仍能读出状态值", async () => {
    const fixture = createProject();
    const { ctx, root } = fixture;
    mkdirSync(join(root, "bible"), { recursive: true });
    writeFileSync(
      join(root, "bible", "state-vocabulary.json"),
      JSON.stringify({
        dimensions: [
          {
            key: "life_state",
            predicate: "status",
            display_name: "生死",
            cardinality: "one",
            value_type: "free",
          },
        ],
      }),
      "utf-8",
    );
    // 无 status fact，直接预置存量 v2 折叠卡（status 谓词已归入「生死」维度，顶层无 status 键）。
    ctx.db
      .prepare(
        `INSERT INTO character_cards (novel_id, character_uid, character, as_of_chapter, card_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.novelId,
        LINWAN_UID,
        "林晚",
        3,
        JSON.stringify({
          _v: 2,
          dimensions: { life_state: { display_name: "生死", value: "身负重伤，昏迷未醒" } },
          extras: {},
        }),
      );

    const result = (await novelCharacterStatuses(
      { character_uids: [LINWAN_UID], at_chapter: 3 },
      ctx,
    )) as { statuses: Record<string, string> };
    expect(result.statuses[LINWAN_UID]).toBe("身负重伤，昏迷未醒");
  });

  it("未命中的 uid 不放入 statuses", async () => {
    const fixture = createProject();
    const { ctx, root } = fixture;
    writeCharacter(root, "林晚", LINWAN_UID);
    await novelSubmitExtraction(
      {
        chapter: 1,
        facts: [
          { subject: "林晚", predicate: "status", object: "背负偷参嫌疑", change_type: "new" },
        ],
      },
      ctx,
    );

    const result = (await novelCharacterStatuses(
      { character_uids: [LINWAN_UID, ZHAOBO_UID] },
      ctx,
    )) as { statuses: Record<string, string> };
    expect(result.statuses[LINWAN_UID]).toBe("背负偷参嫌疑");
    expect(ZHAOBO_UID in result.statuses).toBe(false);
  });

  it("空列表合法：返回空 statuses 与默认章号", async () => {
    const fixture = createProject();
    const result = (await novelCharacterStatuses({ character_uids: [] }, fixture.ctx)) as {
      ok: boolean;
      statuses: Record<string, string>;
    };
    expect(result.ok).toBe(true);
    expect(result.statuses).toEqual({});
  });
});

describe("novel_chapter_summary", () => {
  it("单章返回摘要 + 锚点 + 可继续写的戏", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);

    const result = (await novelChapterSummary({ chapter: 1 }, fixture.ctx)) as {
      ok: boolean;
      summaries: Array<Record<string, unknown>>;
    };
    expect(result.ok).toBe(true);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]).toMatchObject({
      chapter: 1,
      emotional_tone: "蒙冤后的冷静",
    });
    // P2: characters 解析 CharacterReference[] 返回显示名（非空）
    expect(result.summaries[0].characters).toEqual(["林晚", "赵伯", "药圃管事"]);
    const anchor = result.summaries[0].anchor as Record<string, unknown>;
    expect(anchor.heartbeat_moment).toContain("剑气削断");
    expect(result.summaries[0].continuation_hook).toEqual([
      "真正的窃贼会用剑，外门大比前必须找到他",
    ]);
  });
});

describe("novel_query", () => {
  it("混合检索返回结果并按章节距离衰减排序", async () => {
    const { ctx, db } = createProject();
    const insert = db.prepare(
      `INSERT INTO chapter_summaries (id, novel_id, chapter, summary, characters, events)
       VALUES (?, 'novel-test', ?, ?, '[]', '[]')`,
    );
    insert.run("s1", 1, "执法堂首座深夜独自进入剑冢外道。");
    insert.run("s9", 9, "执法堂首座深夜再次出现在剑冢外道。");
    ftsInsert(db, "执法堂首座深夜独自进入剑冢外道。", "chapter_summaries", "s1", "novel-test", "episodic");
    ftsInsert(db, "执法堂首座深夜再次出现在剑冢外道。", "chapter_summaries", "s9", "novel-test", "episodic");

    const result = (await novelQuery({ query: "执法堂首座" }, ctx)) as {
      ok: boolean;
      results: Array<{ chapter: number | null }>;
    };
    expect(result.ok).toBe(true);
    expect(result.results.length).toBe(2);
    // 距最新章（9）更近的结果排前
    expect(result.results[0].chapter).toBe(9);
  });

  it("空查询返回参数错误", async () => {
    const { ctx } = createProject();
    const result = (await novelQuery({ query: "  " }, ctx)) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });
});

describe("聊天只读滤网（片4 A4×D2 外审 P1-1：ctx.secretFilter + secret_known）", () => {
  const SECRET_HIDDEN = "身世是前朝余孽血脉";
  const SECRET_KNOWN = "曾在剑冢屠村这事林晚自己知道";
  const NORMAL_ABILITY = "御剑术初成";

  it("novel_character_state：滤网开时未打标secret不出现在card或facts里，已打标与普通事实正常返回", async () => {
    const fixture = createProject({ secretFilter: true });
    const { ctx, root } = fixture;
    writeCharacter(root, "林晚", LINWAN_UID);
    insertFact(ctx.db, {
      id: "f-secret-hidden",
      novelId: ctx.novelId,
      subjectUid: LINWAN_UID,
      subject: "林晚",
      predicate: "secret",
      object: SECRET_HIDDEN,
      fromChapter: 1,
      secretKnown: 0,
    });
    insertFact(ctx.db, {
      id: "f-ability",
      novelId: ctx.novelId,
      subjectUid: LINWAN_UID,
      subject: "林晚",
      predicate: "ability",
      object: NORMAL_ABILITY,
      fromChapter: 1,
      secretKnown: 0,
    });

    const result = (await novelCharacterState(
      { character_uid: LINWAN_UID, at_chapter: 1 },
      ctx,
    )) as { card: Record<string, string>; facts: Array<{ object: string }> };

    const objects = result.facts.map((f) => f.object);
    expect(objects).not.toContain(SECRET_HIDDEN);
    expect(objects).toContain(NORMAL_ABILITY);
    expect(result.card.secret).toBeUndefined();
    expect(result.card.ability).toBe(NORMAL_ABILITY);
  });

  it("novel_character_state：滤网开时已打标 secret_known=1 正常可见", async () => {
    const fixture = createProject({ secretFilter: true });
    const { ctx, root } = fixture;
    writeCharacter(root, "林晚", LINWAN_UID);
    insertFact(ctx.db, {
      id: "f-secret-known",
      novelId: ctx.novelId,
      subjectUid: LINWAN_UID,
      subject: "林晚",
      predicate: "secret",
      object: SECRET_KNOWN,
      fromChapter: 1,
      secretKnown: 1,
    });

    const result = (await novelCharacterState(
      { character_uid: LINWAN_UID, at_chapter: 1 },
      ctx,
    )) as { card: Record<string, string>; facts: Array<{ object: string }> };

    expect(result.facts.map((f) => f.object)).toContain(SECRET_KNOWN);
    expect(result.card.secret).toBe(SECRET_KNOWN);
  });

  it("novel_character_state：滤网关（默认）时未打标与已打标 secret 均可见（写作链路不回归）", async () => {
    const fixture = createProject(); // secretFilter 未设 → undefined，等同 sdk-runner 写作链路
    const { ctx, root } = fixture;
    writeCharacter(root, "林晚", LINWAN_UID);
    insertFact(ctx.db, {
      id: "f-secret-hidden",
      novelId: ctx.novelId,
      subjectUid: LINWAN_UID,
      subject: "林晚",
      predicate: "secret",
      object: SECRET_HIDDEN,
      fromChapter: 1,
      secretKnown: 0,
    });

    const result = (await novelCharacterState(
      { character_uid: LINWAN_UID, at_chapter: 1 },
      ctx,
    )) as { facts: Array<{ object: string }> };

    expect(result.facts.map((f) => f.object)).toContain(SECRET_HIDDEN);
  });

  it("novel_relationship：滤网开不影响正常关系事实（secret 谓词与 relationship 谓词结构互斥的回归验证）", async () => {
    const fixture = createProject({ secretFilter: true });
    const { ctx, root } = fixture;
    writeCharacter(root, "林晚", LINWAN_UID);
    writeCharacter(root, "赵伯", ZHAOBO_UID);
    await novelSubmitExtraction(
      {
        chapter: 1,
        facts: [],
        relationship_updates: [{ a: "赵伯", b: "林晚", state: "作保失败后愧疚照拂" }],
      },
      ctx,
    );

    const result = (await novelRelationship(
      { character_a_uid: LINWAN_UID, character_b_uid: ZHAOBO_UID },
      ctx,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, current_state: "作保失败后愧疚照拂" });
  });

  it("novel_query：滤网开时未打标secret的检索命中不出现在结果里，已打标与普通事实正常返回", async () => {
    const fixture = createProject({ secretFilter: true });
    const { ctx, db } = fixture;
    insertFact(db, {
      id: "f-secret-hidden",
      novelId: ctx.novelId,
      subjectUid: LINWAN_UID,
      subject: "林晚",
      predicate: "secret",
      object: SECRET_HIDDEN,
      fromChapter: 1,
      secretKnown: 0,
    });
    insertFact(db, {
      id: "f-secret-known",
      novelId: ctx.novelId,
      subjectUid: LINWAN_UID,
      subject: "林晚",
      predicate: "secret",
      object: SECRET_KNOWN,
      fromChapter: 1,
      secretKnown: 1,
    });
    insertFact(db, {
      id: "f-ability",
      novelId: ctx.novelId,
      subjectUid: LINWAN_UID,
      subject: "林晚",
      predicate: "ability",
      object: NORMAL_ABILITY,
      fromChapter: 1,
      secretKnown: 0,
    });
    ftsInsert(db, `林晚 secret ${SECRET_HIDDEN}`, "facts", "f-secret-hidden", ctx.novelId, "semantic");
    ftsInsert(db, `林晚 secret ${SECRET_KNOWN}`, "facts", "f-secret-known", ctx.novelId, "semantic");
    ftsInsert(db, `林晚 ability ${NORMAL_ABILITY}`, "facts", "f-ability", ctx.novelId, "semantic");

    const result = (await novelQuery({ query: "林晚" }, ctx)) as {
      ok: boolean;
      results: Array<{ content: string }>;
    };
    expect(result.ok).toBe(true);
    const contents = result.results.map((r) => r.content);
    expect(contents.some((c) => c.includes(SECRET_HIDDEN))).toBe(false);
    expect(contents.some((c) => c.includes(SECRET_KNOWN))).toBe(true);
    expect(contents.some((c) => c.includes(NORMAL_ABILITY))).toBe(true);
  });

  it("novel_query：滤网关（默认）时未打标secret也可见（写作链路不回归）", async () => {
    const fixture = createProject();
    const { ctx, db } = fixture;
    insertFact(db, {
      id: "f-secret-hidden",
      novelId: ctx.novelId,
      subjectUid: LINWAN_UID,
      subject: "林晚",
      predicate: "secret",
      object: SECRET_HIDDEN,
      fromChapter: 1,
      secretKnown: 0,
    });
    ftsInsert(db, `林晚 secret ${SECRET_HIDDEN}`, "facts", "f-secret-hidden", ctx.novelId, "semantic");

    const result = (await novelQuery({ query: "林晚" }, ctx)) as {
      results: Array<{ content: string }>;
    };
    expect(result.results.some((r) => r.content.includes(SECRET_HIDDEN))).toBe(true);
  });
});

describe("novel_writing_context", () => {
  it("聚合前章 brief、角色卡、伏笔 due-list 与故事线聚焦", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);

    const result = (await novelWritingContext({ chapter: 2 }, fixture.ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(true);
    expect(result.arc).toMatchObject({ arc_id: "V01-A01" });
    expect(result.previous_chapter_briefs).toHaveLength(1);
    const cards = result.character_cards as Array<{ character: string }>;
    expect(cards.map((c) => c.character)).toContain("林晚");
    const due = result.foreshadowing_due as { due: Array<{ id: string }> };
    expect(due.due.map((f) => f.id)).toContain("S-HERB");
    const focus = result.storyline_focus as Array<{ id: string }>;
    expect(focus.map((f) => f.id)).toEqual(["SL-main", "SL-growth"]);
  });

  it("章纲结构化 foreshadowing_touch 引用的未种下伏笔与 WCP builder 行为一致（挂账① Task 4 Step 4）", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    await novelRegisterForeshadowing(
      {
        id: "F-CTX-REF",
        type: "major",
        description: "novel_writing_context 路径结构化引用但还没种下的核心伏笔",
        planted_chapter: 6,
        target_reveal: "50",
      },
      fixture.ctx,
    );

    const batch = loadFixture<Array<Record<string, unknown>>>("chapter-outline-v5-valid-batch.json");
    const ch2 = batch.find((c) => c.chapter === 2)!;
    const { foreshadowing_touch: _drop, ...ch2Rest } = ch2;
    const submitResult = (await novelSubmitChapterOutline(
      {
        payload: [
          {
            ...ch2Rest,
            chapter: 4,
            title: "轻上下文引用测试章",
            foreshadowing_touch: [{ id: "F-CTX-REF", action: "develop" }],
          },
        ],
      },
      fixture.ctx,
    )) as { ok: boolean };
    expect(submitResult.ok).toBe(true);

    const result = (await novelWritingContext({ chapter: 4 }, fixture.ctx)) as Record<
      string,
      unknown
    >;
    const due = result.foreshadowing_due as { due: Array<{ id: string }> };
    expect(due.due.map((f) => f.id)).toContain("F-CTX-REF");
  });
});

describe("novel_build_writing_context_pack 未来状态不进当前卡（PR#452评审P1-B）", () => {
  it("effective_chapter 晚于已写章节的状态不入包；存量卡回落不吐超前 as_of 的卡（双保险）", async () => {
    const fixture = createProject();
    await seedFullProject(fixture); // chapter_summaries 只到第 1 章

    await novelSubmitStateVocabulary(
      {
        payload: {
          dimensions: [
            {
              key: "life_status",
              predicate: "life_status",
              display_name: "生死",
              cardinality: "one",
              value_type: "enum",
              values: ["存活", "死亡"],
            },
          ],
        },
      },
      fixture.ctx,
    );

    // 提交 effective_chapter=10 的「死亡」（书只写到第 1 章）
    await novelSubmitCharacterEntity(
      {
        payload: {
          character_uid: LINWAN_UID,
          name: "林晚",
          effective_chapter: 10,
          initial_states: [{ dimension: "life_status", value: "死亡" }],
        },
      },
      fixture.ctx,
    );

    // 双保险第 2 层：手工模拟一条泄露的未来存量卡（如旧版本残留 / 其他写路径产生的陈旧数据），
    // 挂在零现有 facts 的「药圃管事」身上，确保下面走的是「折叠为空→存量卡回落」分支，
    // 而不是林晚那种「折叠非空→直接用新鲜折叠结果」分支
    fixture.db
      .prepare(
        `INSERT INTO character_cards (novel_id, character_uid, character, as_of_chapter, card_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        fixture.ctx.novelId,
        "33333333-3333-4333-8333-333333333333",
        "药圃管事",
        10,
        JSON.stringify({
          _v: 2,
          dimensions: { life_status: { display_name: "生死", value: "死亡" } },
          extras: {},
        }),
      );

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      pack_path: string;
    };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      character_cards: Array<{ character: string; card: Record<string, string> }>;
    };

    // 修复 1（cardAsOf 不取 effective）：林晚卡走的是新鲜折叠路径，不含「死亡」
    const lin = pack.character_cards.find((c) => c.character === "林晚");
    expect(JSON.stringify(lin ?? {})).not.toContain("死亡");

    // 修复 2（存量卡回落加 as_of_chapter <= 请求时点 双保险）：药圃管事零 facts、折叠为空，
    // 回落到 as_of_chapter=10 的陈旧未来卡时必须被过滤掉，不得把「死亡」泄露进包
    const guan = pack.character_cards.find((c) => c.character === "药圃管事");
    expect(guan).toBeUndefined();
  });
});

describe("novel_build_writing_context_pack", () => {
  // 跨书段真人范例消费点改三态源异步化（Task 6）：本 describe 内多个用例断言
  // style_examples 的跨书段真实存在（长度/截断行为），指向 Task 5 的 corpus fixture
  // 目录让 selectStyleExamples 走 local 源，而非默认 disabled 空数组。
  beforeEach(() => {
    __resetCorpusCachesForTest();
    vi.stubEnv("NARRACAT_CORPUS_DIR", CORPUS_FIXTURE_DIR);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 第 1 章正文里的原话（writeManuscript 写的重复句），取 100 字落在 80-400 区间
  const ANCHOR_PARA = "林晚握着断剑站在剑冢里，掌心的伤口还在渗血。".repeat(5);

  it("有作者样章时 style_examples 前两段是本书段、总数仍 3", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    await novelSubmitStyleAnchor({ action: "add", chapter: 1, excerpt: ANCHOR_PARA }, fixture.ctx);
    // 第二段样章须是正文里的真实原话（写手 novel_submit_style_anchor 会核对存在性）：
    // 正文是同一句无缝重复 40 遍，ANCHOR_PARA 后紧跟的原话是「林晚握着断剑站在剑冢里，」（逗号），
    // 不是句号——用句号会拼不出正文里真实存在的子串，校验必挂。
    await novelSubmitStyleAnchor(
      { action: "add", chapter: 1, excerpt: `${ANCHOR_PARA}林晚握着断剑站在剑冢里，` },
      fixture.ctx,
    );

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      style_examples: Array<{ excerpt: string; mechanism_note: string }>;
    };

    expect(pack.style_examples).toHaveLength(3);
    expect(pack.style_examples[0].mechanism_note).toContain("作者选定为本书声音基准");
    expect(pack.style_examples[1].mechanism_note).toContain("作者选定为本书声音基准");
    expect(pack.style_examples[2].mechanism_note).not.toContain("作者选定");
  });

  it("无样章且兜底开启时自动取最近一章开场段", async () => {
    const fixture = createProject({ styleAnchorAutoFallback: true }); // 默认已关，本例专测自动取样路径
    await seedFullProject(fixture);
    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      style_examples: Array<{ mechanism_note: string }>;
    };
    expect(pack.style_examples[0].mechanism_note).toContain("系统自动取样");
    expect(pack.style_examples).toHaveLength(3);
  });

  it("自动取样跳过无 # 前缀的标题行（chapter-writer 标题行非强制 # 前缀，App 编辑器也可能删掉 #）", async () => {
    const fixture = createProject({ styleAnchorAutoFallback: true }); // 默认已关，本例专测自动取样路径
    await seedFullProject(fixture);
    // 覆盖第 1 章正文：标题行没有 `#` 前缀（章节标题行在 chapter-writer 契约里是可选项，
    // App 正文编辑器又是自由文本框零格式校验，真实存量正文完全可能是这个形态）。
    const body = "林晚握着断剑站在剑冢里，掌心的伤口还在渗血。".repeat(10);
    writeFileSync(
      join(fixture.root, "manuscript", "vol-01", "ch-001.md"),
      `第1章 剑冢\n\n${body}\n`,
    );
    // 正文改了，指纹随之变化——重新走一次 pass 审校让 checkReviewFreshness 认这份新正文
    // （否则自动兜底会判「审校后又被改过」而跳过第 1 章，这里测的是标题行剥离，不是新鲜度门）
    await novelSubmitReview({ chapter: 1, issues: [] }, fixture.ctx);
    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      style_examples: Array<{ excerpt: string; mechanism_note: string }>;
    };
    const autoSample = pack.style_examples.find((e) => e.mechanism_note.includes("系统自动取样"));
    expect(autoSample).toBeDefined();
    expect(autoSample?.excerpt).not.toContain("第1章 剑冢");
    expect(autoSample?.excerpt).toContain("林晚握着断剑站在剑冢里");
  });

  it("超预算截断优先丢跨书段，本书声音段不被截断吞掉", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);

    // novel_submit_style_anchor 有 400 字上限（MAX_EXCERPT_CHARS），正常途径两段本书锚
    // 合计最多 ~927 token，撑不爆 style_examples 的 2000 token 预算——这也是为什么旧代码
    // 「length > 1」的截断下限从未在真实输入下露过馅。这里绕过提交工具直接写库，构造两段
    // 远超正常上限的本书锚（本书段单独就 >2000 token），逼真实截断分支执行，验证「至少保住
    // 全部本书段」这条不变量，而不是巧合地被数值边界挡住。
    const hugeExcerpt = "华".repeat(1200);
    fixture.db
      .prepare(
        `INSERT INTO style_anchors (novel_id, anchor_id, chapter, excerpt) VALUES (?, ?, ?, ?)`,
      )
      .run(fixture.ctx.novelId, "ch001-huge-a", 1, hugeExcerpt);
    fixture.db
      .prepare(
        `INSERT INTO style_anchors (novel_id, anchor_id, chapter, excerpt) VALUES (?, ?, ?, ?)`,
      )
      .run(fixture.ctx.novelId, "ch001-huge-b", 1, hugeExcerpt);

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      pack_path: string;
      warnings: string[];
    };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      style_examples: Array<{ excerpt: string; mechanism_note: string }>;
    };

    // 两段本书声音段都还在——没有被截断挤掉，即便这意味着本区块实际超出了预算上限
    expect(
      pack.style_examples.filter((e) => e.mechanism_note.includes("作者选定为本书声音基准")),
    ).toHaveLength(2);
    // 被丢的是跨书段，不是本书段：截断后只剩这两段本书锚，长度恰为 2
    expect(pack.style_examples).toHaveLength(2);
    expect(pack.style_examples.every((e) => e.excerpt === hugeExcerpt)).toBe(true);
    expect(result.warnings.some((w) => w.includes("范例区块超预算"))).toBe(true);
  });

  it("兜底关闭且无样章时与现状一致（全跨书）", async () => {
    const fixture = createProject({ styleAnchorAutoFallback: false });
    await seedFullProject(fixture);
    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      style_examples: Array<{ mechanism_note: string }>;
    };
    for (const ex of pack.style_examples) {
      expect(ex.mechanism_note).not.toContain("本书第");
    }
  });

  it("自动兜底跳过未收尾的残稿章，顺延取更早已收尾的成稿", async () => {
    const fixture = createProject({ styleAnchorAutoFallback: true }); // 默认已关，本例专测自动取样路径
    await seedFullProject(fixture); // 第 1 章已走 novel_commit_chapter 收尾入库

    // batch fixture 只覆盖第 1-2 章，补第 3 章章纲（克隆第 2 章骨架，去掉伏笔触碰避免重复 plant）
    const batch = loadFixture("chapter-outline-v5-valid-batch.json") as Array<Record<string, unknown>>;
    const ch2 = batch.find((c) => c.chapter === 2);
    if (!ch2) throw new Error("fixture 缺第2章");
    const { foreshadowing_touch: _drop, ...ch2Rest } = ch2;
    const ch3 = { ...ch2Rest, chapter: 3, title: "剑冢夜话" };
    const submitResult = (await novelSubmitChapterOutline({ payload: [ch3] }, fixture.ctx)) as { ok: boolean };
    expect(submitResult.ok).toBe(true);

    // 第 2 章正文文件存在，但从未跑过 novel_commit_chapter——模拟失败中断留下的未过审残稿
    writeFileSync(
      join(fixture.root, "manuscript", "vol-01", "ch-002.md"),
      `# 第2章\n\n${"这是尚未过审的第二章残稿，不该被当成语感基准。".repeat(6)}\n`,
    );

    const result = (await novelBuildWritingContextPack({ chapter: 3 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      style_examples: Array<{ excerpt: string; mechanism_note: string }>;
    };
    const autoSample = pack.style_examples.find((e) => e.mechanism_note.includes("系统自动取样"));
    expect(autoSample).toBeDefined();
    // 顺延到已收尾的第 1 章，不是紧邻但未收尾的第 2 章残稿
    expect(autoSample?.mechanism_note).toContain("本书第 1 章");
    expect(autoSample?.excerpt).not.toContain("残稿");
  });

  it("正文在审校后被改过（指纹不匹配）的章不被自动取样，顺延到窗口耗尽退回纯跨书", async () => {
    const fixture = createProject();
    await seedFullProject(fixture); // 第 1 章已 pass 审校，指纹对应旧正文

    // 作者事后手改了第 1 章正文（或外部工具改写），但没有重新走审校——
    // review 记录还在、指纹却对不上现在的正文了
    writeFileSync(
      join(fixture.root, "manuscript", "vol-01", "ch-001.md"),
      `# 第1章\n\n${"审校通过之后又被悄悄改动过的正文。".repeat(10)}\n`,
    );

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      style_examples: Array<{ mechanism_note: string }>;
    };
    // 窗口内只有第 1 章可选，指纹不新鲜被跳过后顺延无门可入，退回纯跨书（不含任何本书段）
    for (const ex of pack.style_examples) {
      expect(ex.mechanism_note).not.toContain("本书第");
    }
  });

  it("已收尾但从未走过审校的章（老书典型：刀 1 之前收尾入库、审校记录不存在）不被自动取样，安全退回纯跨书，不抛错", async () => {
    const fixture = createProject();
    const { ctx, root } = fixture;
    writeCharacter(root, "林晚", LINWAN_UID);
    writeCharacter(root, "赵伯", ZHAOBO_UID);
    writeCharacter(root, "药圃管事", "33333333-3333-4333-8333-333333333333");
    await novelSubmitOutline({ phase: 1, payload: loadFixture("outline-v5-valid-book.json") }, ctx);
    await novelSubmitChapterOutline(
      { payload: loadFixture("chapter-outline-v5-valid-batch.json") },
      ctx,
    );
    writeManuscript(root, 1);
    // 只走收尾入库，刻意不调用 novelSubmitReview——模拟 chapter_reviews 里完全没有这一章记录
    // 的老书场景（区别于上一条用例「审校记录在但指纹对不上」）
    await novelCommitChapter(
      {
        chapter: 1,
        summary:
          "晨检发现药圃血参连根失窃，泥土上只有林晚常穿的草鞋印。管事当众翻开林晚的床板，搜出半截带泥的参须，赵伯替他作保被当众驳回，罚俸三月。林晚捏着那截参须没有争辩——切口平整，是剑气削断的，而整个杂役峰没人会用剑。他把参须收进袖中，决定自己查出真正的窃贼，否则外门大比的资格保不住，妹妹的药钱也会断。",
        anchor: {
          core_experience: "被构陷却发现关键证物只有自己看得懂",
          heartbeat_moment: "参须切口平整——是剑气削断的",
        },
        key_events: ["血参失窃", "床板搜出参须", "林晚发现剑气切口"],
        characters_appeared: ["林晚", "赵伯", "药圃管事"],
        emotional_tone: "蒙冤后的冷静",
        continuation_hook: ["真正的窃贼会用剑，外门大比前必须找到他"],
      },
      ctx,
    );

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, ctx)) as {
      ok: boolean;
      pack_path: string;
    };
    expect(result.ok).toBe(true);
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      style_examples: Array<{ mechanism_note: string }>;
    };
    for (const ex of pack.style_examples) {
      expect(ex.mechanism_note).not.toContain("本书第");
    }
  });

  it("自动兜底窗口内全部未收尾时退回纯跨书（不误用残稿）", async () => {
    const fixture = createProject();
    const { ctx, root } = fixture;
    await novelSubmitOutline({ phase: 1, payload: loadFixture("outline-v5-valid-book.json") }, ctx);
    await novelSubmitChapterOutline(
      { payload: loadFixture("chapter-outline-v5-valid-batch.json") },
      ctx,
    );
    // 第 1 章正文存在，但从未提交收尾（novel_commit_chapter 从未跑过）
    writeManuscript(root, 1);

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      style_examples: Array<{ mechanism_note: string }>;
    };
    for (const ex of pack.style_examples) {
      expect(ex.mechanism_note).not.toContain("本书第");
    }
  });

  it("样章锚表读取异常时退回纯跨书范例，不阻断整包组装（规格 §4.6）", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    // 模拟锚表不可读（如迁移未完成/表损坏）：直接删表，SQL 查询会抛异常
    fixture.db.exec("DROP TABLE style_anchors");

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      ok: boolean;
      pack_path: string;
      warnings: string[];
    };
    expect(result.ok).toBe(true);
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      style_examples: Array<{ mechanism_note: string }>;
    };
    // 纯跨书：不含任何本书声音段（无论作者标记还是自动取样）
    for (const ex of pack.style_examples) {
      expect(ex.mechanism_note).not.toContain("本书第");
    }
    // 异常原因走 buildNotes（系统诊断通道，只回主会话工具返回值，不进包内 warnings）
    expect(result.warnings.some((w) => w.includes("样章锚表读取失败"))).toBe(true);
  });

  it("重提已有章：写手经包看到最新 payoff_beat（json 现渲染，不被陈旧 md 拖住）", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    // 重提整批，把第2章 payoff_beat 从 reveal 改成 level_up：
    // .md 已存在 → 受保护被跳过（陈旧、仍是 reveal）；.json 总写 → 更新为 level_up
    const batch = loadFixture("chapter-outline-v5-valid-batch.json") as Array<Record<string, unknown>>;
    const ch2 = batch.find((c) => c.chapter === 2);
    if (!ch2) throw new Error("fixture 缺第2章");
    ch2.payoff_beat = "level_up";
    const resubmit = (await novelSubmitChapterOutline({ payload: batch }, fixture.ctx)) as {
      files_skipped: string[];
    };
    expect(resubmit.files_skipped.some((p) => p.includes("ch-002.md"))).toBe(true);

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      pack_path: string;
    };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as Record<string, string>;
    // 写手看到的是最新 level_up（来自 json 现渲染），而非陈旧 md 里的 reveal
    expect(pack.chapter_outline).toContain("- 本章爽点: 升级突破（level_up）");
    expect(pack.chapter_outline).not.toContain("真相揭示（reveal）");
  });

  // 护栏（PR#385 review P1 的根因防回归）：WCP 是 MCP 产出、写手直接 Read 消费的
  // 运行时数据，不经 SDK plugin 运行时、也不经 App expandPluginRoot 任何 ${CLAUDE_PLUGIN_ROOT}
  // 展开层——任何字段把字面 ${CLAUDE_PLUGIN_ROOT} 写进 WCP，写手都会 Read 到坏路径。
  // 故立一条全包不变量：整包序列化里绝不允许出现字面 ${CLAUDE_PLUGIN_ROOT}。
  // 未来任何 MCP 工具往 WCP 任何字段塞未解析变量，本测试当场红。
  it("护栏：WCP 全字段不含字面 ${CLAUDE_PLUGIN_ROOT}，craft_pack_hints 路径写手可 Read", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    // 第2章章纲含「真相揭示」→「真相」命中 payoff-delivery 的 trigger + 震撼情绪，必产出 craft_pack_hints
    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      pack_path: string;
    };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as Record<string, unknown>;

    // 护栏 1（覆盖未来所有出口）：整包不得含字面 ${CLAUDE_PLUGIN_ROOT}
    expect(JSON.stringify(pack).includes("${CLAUDE_PLUGIN_ROOT}")).toBe(false);

    // 护栏 2：本 fixture 必命中 payoff-delivery，其 reference_path 必须是写手可 Read 的绝对路径
    const hints = (pack.craft_pack_hints ?? []) as Array<{ reference_path: string }>;
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) {
      expect(isAbsolute(h.reference_path)).toBe(true);
      expect(existsSync(h.reference_path)).toBe(true);
    }
  });

  it("组装全区块上下文包并落盘 context-packs/ch-NNN.json", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      ok: boolean;
      pack_path: string;
      outline_path: string;
      manuscript_path: string;
      word_count_range: [number, number];
      warnings: string[];
    };

    expect(result.ok).toBe(true);
    expect(existsSync(result.pack_path)).toBe(true);
    expect(result.outline_path).toBe("outline/vol-01/ch-002.md");
    // 全新章：无 staging、无正式稿 → manuscript_path 落到 staging（写手写入目标，staging 工作解析语义）
    expect(result.manuscript_path).toBe(".narracat/staging/ch-002.md");
    expect(result.word_count_range).toEqual([2400, 3600]);
    expect(result).not.toHaveProperty("writing_context_pack");

    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as Record<string, unknown>;
    // schema required 键齐备
    for (const key of [
      "target_chapter",
      "word_count_range",
      "chapter_outline",
      "world_rules",
      "style_directive",
      "style_examples",
      "previous_chapter_briefs",
      "arc_summaries",
      "character_cards",
      "character_relationships",
      "foreshadowing_due",
      "storyline_focus",
      "semantic_context",
      "warnings",
    ]) {
      expect(pack).toHaveProperty(key);
    }

    expect(pack.target_chapter).toBe(2);
    expect(pack.volume).toBe(1);
    // 本 arc（V01-A01）core_question 非空 → current_arc_tension 进包（S0.1 · 章纲之上、贯穿线之下的中间层）
    expect(pack.current_arc_tension).toBe("林晚能否在外门大比前自证没有偷血参?");
    // 本 arc antagonist_agent 非空 → current_antagonist_agent 进包（issue #429）
    expect(pack.current_antagonist_agent).toBe("药圃管事");
    // fixture 叙述声音（猛文热血/干净利落）命中「少年·滚烫」→ 卡正文进包，作为讲法范本供写手参考
    // （不命中即省略字段的回退路径由 persona-loader.test.ts 专项覆盖）
    expect(pack.persona).toContain("你讲故事的时候，血是热的。");
    expect(pack.word_count_range).toEqual([2400, 3600]);
    expect(pack.chapter_outline).toContain("# 第2章");
    // payoff_beat 透传：fixture 第2章标了 reveal，章纲 md 经包带到写手手里
    expect(pack.chapter_outline).toContain("- 本章爽点: 真相揭示（reveal）");

    // world_rules：从 premise.md card 7 机械抽取（设定违背核对依据）
    const worldRules = pack.world_rules as string;
    expect(worldRules).toContain("灵气只能从血脉觉醒");
    expect((pack.warnings as string[]).some((w) => w.includes("世界规则"))).toBe(false);

    const directive = pack.style_directive as string;
    expect(directive).toContain("猛文热血");
    expect(directive).toContain("写法水位");

    const examples = pack.style_examples as Array<Record<string, unknown>>;
    for (const example of examples) {
      expect(example.excerpt).toBeTruthy();
      expect(example.mechanism_note).toBeTruthy();
    }

    const briefs = pack.previous_chapter_briefs as Array<Record<string, unknown>>;
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({ chapter: 1, emotional_tone: "蒙冤后的冷静" });

    const cards = pack.character_cards as Array<{ character: string; card: Record<string, string> }>;
    const lin = cards.find((c) => c.character === "林晚");
    expect(lin?.card.status).toBe("背负偷参嫌疑");

    // 角色关系：本章涉及角色对的当前关系，供写手/审校核查一致性
    const relationships = pack.character_relationships as Array<{
      character_a: string;
      character_b: string;
      current_state: string;
    }>;
    const rel = relationships.find((r) => r.character_a === "林晚" && r.character_b === "赵伯");
    expect(rel?.current_state).toBe("作保失败后愧疚照拂");

    // due-list：major 全部 + medium 本卷 + small 本 arc；F-TRAITOR（major，planted_chapter=3）
    // 在目标章=2 尚未种下，未种下的伏笔不进 due 也不进计数（spec §4.1 P1）
    const due = pack.foreshadowing_due as { due: Array<{ id: string }>; others_count: number };
    expect(due.due.map((f) => f.id).sort()).toEqual(["F-SWORD-CORE", "S-HERB"]);
    expect(due.others_count).toBe(0);

    const focus = pack.storyline_focus as Array<{ id: string }>;
    expect(focus.map((f) => f.id)).toEqual(["SL-main", "SL-growth"]);

    // 与 schemas/writing-context-pack.json 零漂移
    const Ajv2020 = (await import("ajv/dist/2020.js")).default as unknown as new (
      opts?: Record<string, unknown>,
    ) => { compile(schema: unknown): ((data: unknown) => boolean) & { errors?: unknown } };
    const schema = JSON.parse(
      readFileSync(
        new URL("../../../schemas/writing-context-pack.json", import.meta.url),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    const valid = validate(pack);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it("manuscript_path 路径规则：staging 存在时返回 staging 路径", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    mkdirSync(join(fixture.root, ".narracat", "staging"), { recursive: true });
    writeFileSync(join(fixture.root, ".narracat", "staging", "ch-002.md"), "# 第2章（草稿）\n");

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      manuscript_path: string;
    };

    expect(result.manuscript_path).toBe(".narracat/staging/ch-002.md");
  });

  it("manuscript_path 路径规则：无 staging 且正式章存在时仍为 manuscript/vol-VV/ch-NNN.md", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    writeManuscript(fixture.root, 2); // 已完成成品且无 staging（/review 等旁路照常）

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      manuscript_path: string;
    };

    expect(result.manuscript_path).toBe("manuscript/vol-01/ch-002.md");
  });

  it("semantic_context 剔除与前章摘要逐字重叠的冗余检索结果，同时保留不重叠的合法条目（真机实锤：score 0.03-0.05 的冗余凑数，spec §1.3 P5）", async () => {
    const fixture = createProject();
    const { ctx, root } = fixture;
    await seedFullProject(fixture); // 第 1 章已收尾入库 + 章纲 1-2 已提交

    // 补第 3/4 章章纲（克隆第 2 章骨架，去掉伏笔触碰避免重复 plant——同现有「重提已有章」用例手法）
    const batch = loadFixture("chapter-outline-v5-valid-batch.json") as Array<Record<string, unknown>>;
    const ch2 = batch.find((c) => c.chapter === 2);
    if (!ch2) throw new Error("fixture 缺第2章");
    const { foreshadowing_touch: _drop, ...ch2Rest } = ch2;
    const ch3Outline = { ...ch2Rest, chapter: 3, title: "旧档" };
    const ch4Outline = { ...ch2Rest, chapter: 4, title: "追凶" };
    const submitResult = (await novelSubmitChapterOutline(
      { payload: [ch3Outline, ch4Outline] },
      ctx,
    )) as { ok: boolean };
    expect(submitResult.ok).toBe(true);

    writeManuscript(root, 2);
    await novelCommitChapter(
      {
        chapter: 2,
        summary:
          "林晚在剑冢外扫地三月，日日挥帚不敢懈怠，唯恐再被寻个由头赶出山门。某夜断剑忽然震鸣，剑鞘裂开一道缝，割破他手掌，一滴血珠没入剑身，剑气顺着伤口涌入四肢百骸，剑意认主的悸动让他浑身发颤，却也让他明白自己身上藏着不能让人知晓的秘密。",
        anchor: { core_experience: "断剑认主", heartbeat_moment: "血珠没入剑身" },
        key_events: ["断剑认主"],
        characters_appeared: ["林晚"],
        emotional_tone: "震惊",
        continuation_hook: ["认主之后必须瞒住众人"],
      },
      ctx,
    );

    // 第 3 章摘要即语义检索唯一召回来源（同一段文本经 novelCommitChapter 入前章摘要）：
    // ch4 自己章纲的出场角色「林晚」作为查询词，必然经 FTS LIKE 兜底命中含「林晚」的任意
    // memory_fts 行——包括这条第 3 章摘要本身，真机实锤即此路径产出逐字重叠的冗余凑数。
    writeManuscript(root, 3);
    const CH3_SUMMARY =
      "林晚趁夜潜入执事阁翻查旧档，借着微弱的烛光一页页比对陈年卷宗，发现三十年前也有一起几乎一模一样的血参失窃案，案卷末尾记着失踪的杂役正是当年剑冢守卫，而那人的画像眉眼竟与自己有几分相似，他把卷宗仔细折好藏进怀中，决定天亮前把这条线索告诉赵伯。";
    await novelCommitChapter(
      {
        chapter: 3,
        summary: CH3_SUMMARY,
        anchor: { core_experience: "旧案浮现", heartbeat_moment: "三十年前的失窃案" },
        key_events: ["翻查旧档"],
        characters_appeared: ["林晚"],
        emotional_tone: "警觉",
        continuation_hook: ["旧案与新案的关联"],
      },
      ctx,
    );

    // 合法且不重叠的语义条目：文本含查询词「林晚」（能被 FTS LIKE 兜底命中），
    // 但 subjectUid 特意不指向真实角色（不会被折进任何角色卡），且内容也不出现在
    // 任何前章摘要/结尾快照里——用来证明过滤没有被写成「全剔」。
    const LEGIT_FACT_ID = "legit-unlinked-fact";
    const LEGIT_CONTENT = "林晚 x-observation 剑冢石阶第七级刻着一个陌生姓氏，与户籍册上任何名字都对不上";
    insertFact(ctx.db, {
      id: LEGIT_FACT_ID,
      novelId: ctx.novelId,
      subjectUid: "99999999-9999-4999-8999-999999999999",
      subject: "林晚",
      predicate: "x-observation",
      object: "剑冢石阶第七级刻着一个陌生姓氏，与户籍册上任何名字都对不上",
      fromChapter: 3,
    });
    ftsInsert(ctx.db, LEGIT_CONTENT, "facts", LEGIT_FACT_ID, ctx.novelId, "semantic");

    const result = (await novelBuildWritingContextPack({ chapter: 4 }, ctx)) as {
      pack_path: string;
    };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      semantic_context: Array<{ content: string }>;
      previous_chapter_briefs: Array<{ summary: string }>;
    };

    const normalize = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "");
    const lastBrief = pack.previous_chapter_briefs.at(-1);
    expect(lastBrief?.summary).toBe(CH3_SUMMARY); // 确认窗口末项即第 3 章
    const lastBriefNorm = normalize(lastBrief!.summary);

    // 反面断言：不含与前章摘要互为子串的冗余条目
    for (const item of pack.semantic_context) {
      const itemNorm = normalize(item.content);
      const overlaps = itemNorm.length > 0 && (lastBriefNorm.includes(itemNorm) || itemNorm.includes(lastBriefNorm));
      expect(overlaps).toBe(false);
    }

    // 正面断言：不重叠的合法条目仍在，防止把过滤写成全剔
    expect(pack.semantic_context.some((item) => item.content === LEGIT_CONTENT)).toBe(true);
  });

  it("semantic_context 剔重设最短长度阈值：短角色卡值（normalize 后 <10 字）不参与剔除，避免误杀独立长句命中（终审 F2，spec §4.1 P5）", async () => {
    const fixture = createProject();
    const { ctx, root } = fixture;
    await seedFullProject(fixture);

    const batch = loadFixture("chapter-outline-v5-valid-batch.json") as Array<Record<string, unknown>>;
    const ch2 = batch.find((c) => c.chapter === 2);
    if (!ch2) throw new Error("fixture 缺第2章");
    const { foreshadowing_touch: _drop, ...ch2Rest } = ch2;
    const ch3Outline = { ...ch2Rest, chapter: 3, title: "旧档" };
    const ch4Outline = { ...ch2Rest, chapter: 4, title: "追凶" };
    const submitResult = (await novelSubmitChapterOutline(
      { payload: [ch3Outline, ch4Outline] },
      ctx,
    )) as { ok: boolean };
    expect(submitResult.ok).toBe(true);

    writeManuscript(root, 2);
    await novelCommitChapter(
      {
        chapter: 2,
        summary:
          "林晚在剑冢外扫地三月，日日挥帚不敢懈怠，唯恐再被寻个由头赶出山门。某夜断剑忽然震鸣，剑鞘裂开一道缝，割破他手掌，一滴血珠没入剑身，剑气顺着伤口涌入四肢百骸，剑意认主的悸动让他浑身发颤，却也让他明白自己身上藏着不能让人知晓的秘密。",
        anchor: { core_experience: "断剑认主", heartbeat_moment: "血珠没入剑身" },
        key_events: ["断剑认主"],
        characters_appeared: ["林晚"],
        emotional_tone: "震惊",
        continuation_hook: ["认主之后必须瞒住众人"],
      },
      ctx,
    );

    // 把 林晚 的 status 更新为短值「警觉」——normalize 后仅 2 字，远短于 10 字阈值，
    // 是 spec 里描述的「短角色卡值」典型样本。
    await novelSubmitExtraction(
      {
        chapter: 2,
        facts: [{ subject: "林晚", predicate: "status", object: "警觉", change_type: "update" }],
      },
      ctx,
    );

    writeManuscript(root, 3);
    const CH3_SUMMARY =
      "林晚趁夜潜入执事阁翻查旧档，借着微弱的烛光一页页比对陈年卷宗，发现三十年前也有一起几乎一模一样的血参失窃案，案卷末尾记着失踪的杂役正是当年剑冢守卫，而那人的画像眉眼竟与自己有几分相似，他把卷宗仔细折好藏进怀中，决定天亮前把这条线索告诉赵伯。";
    await novelCommitChapter(
      {
        chapter: 3,
        summary: CH3_SUMMARY,
        anchor: { core_experience: "旧案浮现", heartbeat_moment: "三十年前的失窃案" },
        key_events: ["翻查旧档"],
        characters_appeared: ["林晚"],
        emotional_tone: "戒备",
        continuation_hook: ["旧案与新案的关联"],
      },
      ctx,
    );

    // 命中条目：整体是一句独立长句，内部含「警觉」二字（与短卡值「警觉」互为子串），
    // 但不与「警觉」整体重叠、也不出现在任何前章摘要/结尾快照里——若剔重误把「警觉」当
    // 剔除词，会把这条整句命中当「逐字重叠」误杀，实为召回损失。
    const TARGET_FACT_ID = "short-value-survivor-fact";
    const TARGET_TEXT = "林晚独自值守剑冢夜岗时警觉地留意着四周的风吹草动，生怕再被人寻着由头栽赃嫁祸";
    // getSourceDetail 对 facts 源拼装 content = `${subject} ${predicate} ${object}`，
    // FTS 索引须存同一份拼装文本才能被检索命中，故 TARGET_CONTENT 是重建后的全文。
    const TARGET_CONTENT = `林晚 x-observation ${TARGET_TEXT}`;
    insertFact(ctx.db, {
      id: TARGET_FACT_ID,
      novelId: ctx.novelId,
      subjectUid: "99999999-9999-4999-8999-999999999998",
      subject: "林晚",
      predicate: "x-observation",
      object: TARGET_TEXT,
      fromChapter: 3,
    });
    ftsInsert(ctx.db, TARGET_CONTENT, "facts", TARGET_FACT_ID, ctx.novelId, "semantic");

    const result = (await novelBuildWritingContextPack({ chapter: 4 }, ctx)) as {
      pack_path: string;
    };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      semantic_context: Array<{ content: string }>;
      character_cards: Array<{ character: string; card: Record<string, string> }>;
    };

    // 前置守卫：短卡值确实进了 excludeTexts 的来源（角色卡 status=警觉），
    // 否则本用例对回退（把阈值删掉）不敏感。
    const lin = pack.character_cards.find((c) => c.character === "林晚");
    expect(lin?.card.status).toBe("警觉");

    expect(pack.semantic_context.some((item) => item.content === TARGET_CONTENT)).toBe(true);
  });

  it("细纲缺失时返回带 plan 引导的错误", async () => {
    const { ctx } = createProject();
    const result = (await novelBuildWritingContextPack({ chapter: 99 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(false);
    const errors = result.errors as Array<{ hint: string }>;
    expect(errors[0].hint).toContain("plan");
  });

  it("config 缺 words_per_chapter 时按默认区间并写 warning", async () => {
    const fixture = createProject({ wordsPerChapter: null, styleProfile: null });
    await seedFullProject(fixture);

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      ok: boolean;
      word_count_range: [number, number];
      warnings: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.word_count_range).toEqual([2400, 3600]);
    expect(result.warnings.some((w) => w.includes("words_per_chapter"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("style_profile"))).toBe(true);
  });

  it("config.yaml 原文含 voltage_bestof 行（旧项目残留）时写忽略提示（电压点判优已下线）", async () => {
    const fixture = createProject({ voltageBestofPresentInConfig: true });
    await seedFullProject(fixture);

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      ok: boolean;
      warnings: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("voltage_bestof") && w.includes("已停用"))).toBe(
      true,
    );
  });

  it("config.yaml 无 voltage_bestof 行（新项目 / 已清理）时不写忽略提示", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      ok: boolean;
      warnings: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("voltage_bestof"))).toBe(false);
  });

  it("storyline 连续 ≥5 章无 focus 时写入缺席预警", async () => {
    const { ctx, root, db } = createProject();
    db.prepare(
      `INSERT INTO arc_meta (novel_id, arc_id, volume_no, title, chapter_start, chapter_end,
         core_question, irreversible_change, next_arc_seed, payoff_beats)
       VALUES ('novel-test', 'V01-A01', 1, '测试', 1, 12, 'q?', 'x', 'y', '[]')`,
    ).run();
    const insertStoryline = db.prepare(
      `INSERT INTO storylines (novel_id, id, name, type, priority, entry_chapter, status)
       VALUES ('novel-test', ?, ?, ?, ?, 1, 'active')`,
    );
    insertStoryline.run("SL-A", "主线", "main", 1);
    insertStoryline.run("SL-B", "暗线", "mystery", 2);
    db.prepare(
      `INSERT INTO chapter_storyline_focus (novel_id, chapter, storyline_id)
       VALUES ('novel-test', 1, 'SL-B'), ('novel-test', 7, 'SL-A')`,
    ).run();
    mkdirSync(join(root, "outline", "vol-01"), { recursive: true });
    writeFileSync(
      join(root, "outline", "vol-01", "ch-007.md"),
      [
        "# 第7章 试探",
        "",
        "- 价值转换: 平静→不安",
        "- 情感赌注: 失去庇护",
        "- 戏剧焦点: 执事突然到访",
        "- 聚焦故事线: SL-A「主线」",
        "",
        "## 场景",
        "",
        "### 场景 1 · 剑冢",
        "",
        "- 出场角色: 林晚",
        "- 压力点: 执事盯着断剑看了很久",
        "",
      ].join("\n"),
    );

    const result = (await novelBuildWritingContextPack({ chapter: 7 }, ctx)) as {
      ok: boolean;
      warnings: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("SL-B") && w.includes("未聚焦"))).toBe(true);
  });

  it("某区块多次截断时，超预算 warning 只 push 一次（不重复刷屏）", async () => {
    const { ctx, root, db } = createProject();
    // 灌 3 条长 brief（章 4/5/6），令热层（previous_chapter_briefs 预算 2000）多次截断
    const longSummary = "林晚在剑冢外道反复追查窃贼，发现执法堂首座的剑气切口与参须吻合。".repeat(40);
    const insertSummary = db.prepare(
      `INSERT INTO chapter_summaries (id, novel_id, chapter, summary, characters, events)
       VALUES (?, ?, ?, ?, '[]', '[]')`,
    );
    for (const ch of [4, 5, 6]) {
      insertSummary.run(`s-${ch}`, ctx.novelId, ch, longSummary);
    }
    mkdirSync(join(root, "outline", "vol-01"), { recursive: true });
    writeFileSync(
      join(root, "outline", "vol-01", "ch-007.md"),
      [
        "# 第7章 追查",
        "",
        "- 价值转换: 怀疑→锁定",
        "- 戏剧焦点: 林晚确认窃贼身份",
        "",
        "## 场景",
        "",
        "### 场景 1 · 剑冢",
        "",
        "- 出场角色: 林晚",
        "- 压力点: 首座的剑气切口与参须吻合",
        "",
      ].join("\n"),
    );

    const result = (await novelBuildWritingContextPack({ chapter: 7 }, ctx)) as {
      ok: boolean;
      pack_path: string;
      warnings: string[];
    };
    expect(result.ok).toBe(true);
    // 返回值（回主会话）拿到系统截断诊断，且每条只 1 次、不重复
    const hotLayerWarnings = result.warnings.filter((w) => w.includes("热层超预算"));
    expect(hotLayerWarnings).toHaveLength(1);
    expect(hotLayerWarnings[0]).toMatch(/已丢弃最早 \d+ 章/);
    expect(result.warnings.length).toBe(new Set(result.warnings).size);

    // 但落盘包 pack.warnings（喂写手）只留连贯性预警，系统截断/降级诊断不进包、不刷写手注意力
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as { warnings: string[] };
    for (const w of pack.warnings) {
      expect(w).not.toMatch(/超预算|已截断|已硬截断|已丢弃|转入计数|按.*默认/);
    }
    // 系统诊断确实从包内移到了返回值（差集非空）
    expect(result.warnings.length).toBeGreaterThan(pack.warnings.length);
  });

  it("本章 outline 出场角色即便前 3 章未露面也进角色卡（回归角色不漏）", async () => {
    const fixture = createProject();
    await seedFullProject(fixture); // 林晚 在第 1 章入库 status=背负偷参嫌疑
    const { ctx, root } = fixture;

    // 第 5 章：前 3 章（2/3/4）无 chapter_summaries（林晚不在热层窗口），
    // 但本章 outline 出场角色含林晚——修复后必须仍拿到林晚的状态卡
    mkdirSync(join(root, "outline", "vol-01"), { recursive: true });
    writeFileSync(
      join(root, "outline", "vol-01", "ch-005.md"),
      [
        "# 第5章 回访",
        "",
        "- 价值转换: 蛰伏→出手",
        "- 戏剧焦点: 林晚再次现身剑冢",
        "",
        "## 场景",
        "",
        "### 场景 1 · 剑冢",
        "",
        "- 出场角色: 林晚",
        "- 压力点: 林晚摊牌",
        "",
      ].join("\n"),
    );

    const result = (await novelBuildWritingContextPack({ chapter: 5 }, ctx)) as {
      ok: boolean;
      pack_path: string;
    };
    expect(result.ok).toBe(true);
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      character_cards: Array<{ character: string; card: Record<string, string> }>;
    };
    const lin = pack.character_cards.find((c) => c.character === "林晚");
    expect(lin).toBeDefined();
    expect(lin?.card.status).toBe("背负偷参嫌疑");
  });

  it("叙述声音命中 persona 卡时，卡正文随包投递（persona 字段）", async () => {
    const { ctx, root } = createProject();
    // 覆写叙述声音为诙谐系：archetype 关键词命中「说书人·诙谐」卡
    writeFileSync(
      join(root, "bible", "premise.md"),
      PREMISE_WITH_VOICE.replace("archetype: 猛文热血", "archetype: 轻幽默说书腔，戏谑调侃"),
    );
    mkdirSync(join(root, "outline", "vol-01"), { recursive: true });
    writeFileSync(
      join(root, "outline", "vol-01", "ch-007.md"),
      [
        "# 第7章 试探",
        "",
        "- 价值转换: 平静→不安",
        "",
        "## 场景",
        "",
        "### 场景 1 · 剑冢",
        "",
        "- 出场角色: 林晚",
        "- 压力点: 执事盯着断剑看了很久",
        "",
      ].join("\n"),
    );

    const personaResult = (await novelBuildWritingContextPack({ chapter: 7 }, ctx)) as {
      ok: boolean;
      pack_path: string;
    };
    expect(personaResult.ok).toBe(true);
    const personaPack = JSON.parse(readFileSync(personaResult.pack_path, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(typeof personaPack.persona).toBe("string");
    expect(personaPack.persona as string).toContain("茶馆");
  });

  it("诙谐书遇悲怆主导章：persona 调制生效，字段省略且回主会话可解释说明", async () => {
    const { ctx, root } = createProject();
    // 覆写叙述声音为诙谐系：按书级关键词本应命中「说书人·诙谐」卡
    writeFileSync(
      join(root, "bible", "premise.md"),
      PREMISE_WITH_VOICE.replace("archetype: 猛文热血", "archetype: 轻幽默说书腔，戏谑调侃"),
    );
    mkdirSync(join(root, "outline", "vol-01"), { recursive: true });
    writeFileSync(
      join(root, "outline", "vol-01", "ch-007.md"),
      [
        "# 第7章 诀别",
        "",
        "- 价值转换: 团聚→诀别",
        "- 戏剧焦点: 面对离别，悲痛欲绝，独自痛哭，深感绝望孤独，就此诀别",
        "",
        "## 场景",
        "",
        "### 场景 1 · 灵堂",
        "",
        "- 出场角色: 林晚",
        "- 压力点: 生死永诀",
        "",
      ].join("\n"),
    );

    const result = (await novelBuildWritingContextPack({ chapter: 7 }, ctx)) as {
      ok: boolean;
      pack_path: string;
      warnings: string[];
    };
    expect(result.ok).toBe(true);
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as Record<string, unknown>;
    // 被调制掉：包内不带 persona 字段，写手回退 style_directive
    expect(pack.persona).toBeUndefined();
    // 可解释：回主会话的系统诊断里能看到调制原因（不进包、不刷写手注意力）
    expect(
      result.warnings.some((w) => w.includes("persona 调制") && w.includes("悲伤")),
    ).toBe(true);
  });

  it("冷峻书遇悲怆主导章：调制只治诙谐卡，冷峻卡照常投递", async () => {
    const { ctx, root } = createProject();
    writeFileSync(
      join(root, "bible", "premise.md"),
      PREMISE_WITH_VOICE.replace("archetype: 猛文热血", "archetype: 冷峻凌厉").replace(
        "pacing: 急",
        "pacing: 急\n- style_keywords: 肃杀、压迫",
      ),
    );
    mkdirSync(join(root, "outline", "vol-01"), { recursive: true });
    writeFileSync(
      join(root, "outline", "vol-01", "ch-007.md"),
      [
        "# 第7章 诀别",
        "",
        "- 价值转换: 团聚→诀别",
        "- 戏剧焦点: 面对离别，悲痛欲绝，独自痛哭，深感绝望孤独，就此诀别",
        "",
        "## 场景",
        "",
        "### 场景 1 · 灵堂",
        "",
        "- 出场角色: 林晚",
        "- 压力点: 生死永诀",
        "",
      ].join("\n"),
    );

    const result = (await novelBuildWritingContextPack({ chapter: 7 }, ctx)) as {
      ok: boolean;
      pack_path: string;
      warnings: string[];
    };
    expect(result.ok).toBe(true);
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as Record<string, unknown>;
    expect(typeof pack.persona).toBe("string");
    expect(pack.persona as string).toContain("刀尖");
    expect(result.warnings.some((w) => w.includes("persona 调制"))).toBe(false);
  });

  it("本章未找到所属 arc 时，current_arc_tension 从包中省略（不放空壳）", async () => {
    const { ctx, root } = createProject();
    // 不插入任何 arc_meta 行，本章落在任何 arc 区间之外
    mkdirSync(join(root, "outline", "vol-01"), { recursive: true });
    writeFileSync(
      join(root, "outline", "vol-01", "ch-007.md"),
      [
        "# 第7章 试探",
        "",
        "- 价值转换: 平静→不安",
        "- 情感赌注: 失去庇护",
        "- 戏剧焦点: 执事突然到访",
        "",
        "## 场景",
        "",
        "### 场景 1 · 剑冢",
        "",
        "- 出场角色: 林晚",
        "- 压力点: 执事盯着断剑看了很久",
        "",
      ].join("\n"),
    );

    const result = (await novelBuildWritingContextPack({ chapter: 7 }, ctx)) as {
      ok: boolean;
      pack_path: string;
    };
    expect(result.ok).toBe(true);
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as Record<string, unknown>;
    expect(pack).not.toHaveProperty("current_arc_tension");
    expect(pack).not.toHaveProperty("current_antagonist_agent");
  });

  it("arc 存在但 core_question 为空串时，current_arc_tension 从包中省略（不放空壳）", async () => {
    const { ctx, root, db } = createProject();
    db.prepare(
      `INSERT INTO arc_meta (novel_id, arc_id, volume_no, title, chapter_start, chapter_end,
         core_question, irreversible_change, next_arc_seed, payoff_beats)
       VALUES ('novel-test', 'V01-A01', 1, '测试', 1, 12, '', 'x', 'y', '[]')`,
    ).run();
    mkdirSync(join(root, "outline", "vol-01"), { recursive: true });
    writeFileSync(
      join(root, "outline", "vol-01", "ch-007.md"),
      [
        "# 第7章 试探",
        "",
        "- 价值转换: 平静→不安",
        "- 情感赌注: 失去庇护",
        "- 戏剧焦点: 执事突然到访",
        "",
        "## 场景",
        "",
        "### 场景 1 · 剑冢",
        "",
        "- 出场角色: 林晚",
        "- 压力点: 执事盯着断剑看了很久",
        "",
      ].join("\n"),
    );

    const result = (await novelBuildWritingContextPack({ chapter: 7 }, ctx)) as {
      ok: boolean;
      pack_path: string;
    };
    expect(result.ok).toBe(true);
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as Record<string, unknown>;
    expect(pack).not.toHaveProperty("current_arc_tension");
    // antagonist_agent 列未插（NULL）→ current_antagonist_agent 同样省略
    expect(pack).not.toHaveProperty("current_antagonist_agent");
  });

  it("arc 存在 antagonist_agent 但 core_question 为空串时，两字段各自独立省略/进包", async () => {
    const { ctx, root, db } = createProject();
    db.prepare(
      `INSERT INTO arc_meta (novel_id, arc_id, volume_no, title, chapter_start, chapter_end,
         core_question, irreversible_change, next_arc_seed, antagonist_agent, payoff_beats)
       VALUES ('novel-test', 'V01-A01', 1, '测试', 1, 12, '', 'x', 'y', '红眼巨兽', '[]')`,
    ).run();
    mkdirSync(join(root, "outline", "vol-01"), { recursive: true });
    writeFileSync(
      join(root, "outline", "vol-01", "ch-007.md"),
      [
        "# 第7章 试探",
        "",
        "- 价值转换: 平静→不安",
        "- 情感赌注: 失去庇护",
        "- 戏剧焦点: 执事突然到访",
        "",
        "## 场景",
        "",
        "### 场景 1 · 剑冢",
        "",
        "- 出场角色: 林晚",
        "- 压力点: 执事盯着断剑看了很久",
        "",
      ].join("\n"),
    );

    const result = (await novelBuildWritingContextPack({ chapter: 7 }, ctx)) as {
      ok: boolean;
      pack_path: string;
    };
    expect(result.ok).toBe(true);
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as Record<string, unknown>;
    // core_question 空串 → current_arc_tension 省略；antagonist_agent 非空 → current_antagonist_agent 独立进包
    expect(pack).not.toHaveProperty("current_arc_tension");
    expect(pack.current_antagonist_agent).toBe("红眼巨兽");
  });

  it("最近一章的 ending_snippet 从正文现读约 500 字", async () => {
    const fixture = createProject();
    await seedFullProject(fixture); // 第 1 章正文约 880 字，足够取 500 字结尾
    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      previous_chapter_briefs: Array<{ chapter: number; ending_snippet?: string }>;
    };

    const briefs = pack.previous_chapter_briefs;
    const latest = briefs[briefs.length - 1]; // briefs 升序，末项 = 最近一章
    expect(latest.chapter).toBe(1);
    expect(Array.from(latest.ending_snippet ?? "").length).toBeGreaterThan(400);
  });

  it("正文文件缺失时保持入库快照，不报错也不进 warnings", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    rmSync(join(fixture.root, "manuscript"), { recursive: true, force: true });
    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      previous_chapter_briefs: Array<{ ending_snippet?: string }>;
      warnings: string[];
    };
    const latest = pack.previous_chapter_briefs[pack.previous_chapter_briefs.length - 1];
    expect(Array.from(latest.ending_snippet ?? "").length).toBeLessThanOrEqual(200);
    expect(pack.warnings.join("")).not.toContain("ending");
  });

  it("正文文件末尾带 chapter_metadata 注释时，现读结尾不混入元数据（App 编辑器保存后的真实形态）", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    // App 编辑器保存时把 chapter_metadata 注释拼在正文可见文字之后（electron/main/novel/
    // manuscript-file.ts 的 joinChapterMetadataComment：`${body}\n\n${metadataComments}\n`），
    // 正好落在「取末尾 500 字」的窗口内——覆盖这一形态复现修复前的漏剥问题。
    const body = "林晚握着断剑站在剑冢里，掌心的伤口还在渗血。".repeat(40);
    const metadataComment = '<!-- chapter_metadata: {"chapter_num":1,"summary":"旧摘要"} -->';
    writeFileSync(
      join(fixture.root, "manuscript", "vol-01", "ch-001.md"),
      `# 第1章\n\n${body}\n\n${metadataComment}\n`,
    );

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      previous_chapter_briefs: Array<{ chapter: number; ending_snippet?: string }>;
    };
    const latest = pack.previous_chapter_briefs[pack.previous_chapter_briefs.length - 1];
    expect(latest.ending_snippet).not.toContain("chapter_metadata");
    expect(latest.ending_snippet).not.toContain("旧摘要");
    // 结尾须是正文真实末尾文字，不是被元数据注释顶替
    expect(latest.ending_snippet?.endsWith("掌心的伤口还在渗血。")).toBe(true);
  });
});

describe("getForeshadowingDue — 未种下的伏笔不进包（spec §4.1 P1）", () => {
  it("planted_chapter 晚于目标章的条目不进 due 也不进 others_count", async () => {
    const { ctx } = createProject();
    await novelRegisterForeshadowing(
      { id: "F-PAST-MAJ", type: "major", description: "已种下的核心伏笔", planted_chapter: 2, target_reveal: "95" },
      ctx,
    );
    await novelRegisterForeshadowing(
      { id: "F-FUT-MAJ", type: "major", description: "还没种下的核心伏笔", planted_chapter: 6, target_reveal: "95" },
      ctx,
    );
    await novelRegisterForeshadowing(
      { id: "F-FUT-MED", type: "medium", description: "还没种下的中期伏笔", planted_chapter: 9, target_reveal: "40" },
      ctx,
    );
    await novelRegisterForeshadowing(
      { id: "F-NOW-SML", type: "small", description: "本章正要种下的小伏笔", planted_chapter: 4, target_reveal: "10" },
      ctx,
    );

    const due = getForeshadowingDue(ctx, 4, undefined, null, null);
    expect(due.due.map((f) => f.id).sort()).toEqual(["F-NOW-SML", "F-PAST-MAJ"]);
    expect(due.others_count).toBe(0); // 未来条目连计数都不进
  });

  it("本章细纲『伏笔动作』显式引用的条目穿透 planted 过滤（referencedIds 白名单）", async () => {
    const { ctx } = createProject();
    await novelRegisterForeshadowing(
      { id: "F-FUT-REF", type: "major", description: "还没种下但本章细纲显式引用的核心伏笔", planted_chapter: 6, target_reveal: "95" },
      ctx,
    );
    await novelRegisterForeshadowing(
      { id: "F-FUT-UNREF", type: "major", description: "还没种下且未被引用的核心伏笔", planted_chapter: 6, target_reveal: "95" },
      ctx,
    );

    const withoutReferences = getForeshadowingDue(ctx, 4, undefined, null, null);
    expect(withoutReferences.due.map((f) => f.id)).not.toContain("F-FUT-REF");

    const withReferences = getForeshadowingDue(ctx, 4, undefined, null, null, ["F-FUT-REF"]);
    expect(withReferences.due.map((f) => f.id)).toContain("F-FUT-REF");
    // 对照组：未被引用的条目仍照旧被排除
    expect(withReferences.due.map((f) => f.id)).not.toContain("F-FUT-UNREF");
  });
});

describe("novelBuildWritingContextPack — 细纲『伏笔动作』引用穿透 planted 过滤（spec §4.1 P1，PR#502 R2）", () => {
  it("章纲显式引用的未种下 major 伏笔出现在 pack.foreshadowing_due.due，未被引用的同类条目仍排除", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    await novelRegisterForeshadowing(
      {
        id: "F-FUT-REF",
        type: "major",
        description: "本章细纲显式引用但还没种下的核心伏笔",
        planted_chapter: 6,
        target_reveal: "50",
      },
      fixture.ctx,
    );
    await novelRegisterForeshadowing(
      {
        id: "F-FUT-UNREF",
        type: "major",
        description: "还没种下且未被细纲引用的核心伏笔",
        planted_chapter: 6,
        target_reveal: "50",
      },
      fixture.ctx,
    );

    const batch = loadFixture<Array<Record<string, unknown>>>("chapter-outline-v5-valid-batch.json");
    const ch2 = batch.find((c) => c.chapter === 2)!;
    const { foreshadowing_touch: _drop, ...ch2Rest } = ch2;
    const submitResult = (await novelSubmitChapterOutline(
      {
        payload: [
          {
            ...ch2Rest,
            chapter: 4,
            title: "细纲引用测试章",
            foreshadowing_touch: [{ id: "F-FUT-REF", action: "develop" }],
          },
        ],
      },
      fixture.ctx,
    )) as { ok: boolean };
    expect(submitResult.ok).toBe(true);

    const result = (await novelBuildWritingContextPack({ chapter: 4 }, fixture.ctx)) as {
      pack_path: string;
    };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      foreshadowing_due: { due: Array<{ id: string }> };
    };
    const dueIds = pack.foreshadowing_due.due.map((f) => f.id);
    expect(dueIds).toContain("F-FUT-REF");
    expect(dueIds).not.toContain("F-FUT-UNREF");
  });
});

describe("章纲伏笔引用改结构化 foreshadowing_touch 取值（挂账① Task 4）", () => {
  it("章纲 json 存在时 referencedIds 走结构化 foreshadowing_touch，不受渲染文本里巧合大写串影响", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    await novelRegisterForeshadowing(
      {
        id: "F-MAJ-01",
        type: "major",
        description: "本章细纲结构化引用但还没种下的核心伏笔",
        planted_chapter: 6,
        target_reveal: "50",
      },
      fixture.ctx,
    );
    await novelRegisterForeshadowing(
      {
        id: "X-FAKE-ID",
        type: "major",
        description: "只在渲染文本里巧合出现、未被结构化引用的伏笔",
        planted_chapter: 6,
        target_reveal: "50",
      },
      fixture.ctx,
    );

    const batch = loadFixture<Array<Record<string, unknown>>>("chapter-outline-v5-valid-batch.json");
    const ch2 = batch.find((c) => c.chapter === 2)!;
    const { foreshadowing_touch: _drop, ...ch2Rest } = ch2;
    const submitResult = (await novelSubmitChapterOutline(
      {
        payload: [
          {
            ...ch2Rest,
            chapter: 4,
            // 渲染首行「# 第N章 标题」会把标题原样带入文本；positioning/beats/must_deliver
            // 有散文洁净门挡机器 token，title 无此检查——巧合塞一个正则会命中的大写串，
            // 验证结构化路径不受它污染
            title: "细纲结构化引用测试章 X-FAKE-ID",
            foreshadowing_touch: [{ id: "F-MAJ-01", action: "develop" }],
          },
        ],
      },
      fixture.ctx,
    )) as { ok: boolean };
    expect(submitResult.ok).toBe(true);

    const result = (await novelBuildWritingContextPack({ chapter: 4 }, fixture.ctx)) as {
      pack_path: string;
    };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      foreshadowing_due: { due: Array<{ id: string }> };
    };
    const dueIds = pack.foreshadowing_due.due.map((f) => f.id);
    expect(dueIds).toContain("F-MAJ-01");
    expect(dueIds).not.toContain("X-FAKE-ID");
  });

  it("章纲只有 .md（旧书）→ 回退正则提取", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    await novelRegisterForeshadowing(
      {
        id: "F-OLD-REF",
        type: "major",
        description: "旧书场景：结构化 .json 已丢失，只能靠正则从 .md 提取的引用",
        planted_chapter: 6,
        target_reveal: "50",
      },
      fixture.ctx,
    );

    const batch = loadFixture<Array<Record<string, unknown>>>("chapter-outline-v5-valid-batch.json");
    const ch2 = batch.find((c) => c.chapter === 2)!;
    const { foreshadowing_touch: _drop, ...ch2Rest } = ch2;
    const submitResult = (await novelSubmitChapterOutline(
      {
        payload: [
          {
            ...ch2Rest,
            chapter: 4,
            title: "旧书回退测试章",
            foreshadowing_touch: [{ id: "F-OLD-REF", action: "develop" }],
          },
        ],
      },
      fixture.ctx,
    )) as { ok: boolean };
    expect(submitResult.ok).toBe(true);

    // 模拟旧书：结构化 .json 丢失，只剩机械渲染的 .md（渲染文本里仍留有 id 字样，供正则兜底提取）
    rmSync(join(fixture.root, "outline", "vol-01", "ch-004.json"), { force: true });

    const result = (await novelBuildWritingContextPack({ chapter: 4 }, fixture.ctx)) as {
      pack_path: string;
    };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      foreshadowing_due: { due: Array<{ id: string }> };
    };
    expect(pack.foreshadowing_due.due.map((f) => f.id)).toContain("F-OLD-REF");
  });
});

describe("getCrossChapterWarnings — 伏笔兑现预警分期（spec §4.1 P2）", () => {
  /** 克隆章纲 fixture 第2章骨架当第 chapter 章的最小细纲（去掉 foreshadowing_touch 避免重复 plant） */
  function cloneOutlineSkeleton(chapter: number, title: string): Record<string, unknown> {
    const batch = loadFixture("chapter-outline-v5-valid-batch.json") as Array<Record<string, unknown>>;
    const ch2 = batch.find((c) => c.chapter === 2);
    if (!ch2) throw new Error("fixture 缺第2章");
    const { foreshadowing_touch: _drop, ...ch2Rest } = ch2;
    return { ...ch2Rest, chapter, title };
  }

  /** 完成第 chapter 章最小收尾（无 foreshadowing_actions，不污染 develop/reveal 日志） */
  async function completeChapter(fixture: ProjectFixture, chapter: number): Promise<void> {
    writeManuscript(fixture.root, chapter);
    await novelCommitChapter(
      {
        chapter,
        summary: `林晚在剑冢的第${chapter}日仍旧洒扫度日，一边留意断剑不时传来的轻微震颤，一边提防执事堂对血参旧案的追查会不会重新盯上自己。药圃那边的流言渐渐淡去，妹妹的药钱却始终没有着落，他只能白天做好份内洒扫，夜里独自摸索断剑的秘密，不敢让任何人看出异样。`,
        anchor: { core_experience: "在压抑的日常里独自摸索秘密", heartbeat_moment: "断剑又发出一声轻微的鸣响" },
        key_events: [`第${chapter}章例行洒扫与暗中观察断剑`],
        characters_appeared: [],
        emotional_tone: "压抑中带一丝警惕",
        continuation_hook: [`断剑的异动会不会引来执法堂的注意`],
      },
      fixture.ctx,
    );
  }

  it("铺设期（chapter <= 8）不触发「连续无伏笔兑现」预警", async () => {
    const fixture = createProject();
    await seedFullProject(fixture); // 书级大纲已含 3 条伏笔登记 + 第1章收尾（只 plant，无 develop/reveal）
    await novelRegisterForeshadowing(
      { id: "F-SETUP-TEST", type: "small", description: "测试用已种下伏笔", planted_chapter: 1, target_reveal: "20" },
      fixture.ctx,
    );
    const submitResult = (await novelSubmitChapterOutline(
      { payload: [cloneOutlineSkeleton(4, "剑冢的第四日")] },
      fixture.ctx,
    )) as { ok: boolean };
    expect(submitResult.ok).toBe(true);

    const result = (await novelBuildWritingContextPack({ chapter: 4 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as { warnings?: string[] };
    expect(pack.warnings ?? []).not.toContainEqual(expect.stringContaining("无伏笔兑现"));
  });

  it("过了铺设期（chapter=9）且近 3 章无 develop/reveal 时仍触发", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    await novelRegisterForeshadowing(
      { id: "F-SETUP-TEST", type: "small", description: "测试用已种下伏笔", planted_chapter: 1, target_reveal: "20" },
      fixture.ctx,
    );
    for (let c = 2; c <= 8; c += 1) {
      await completeChapter(fixture, c);
    }
    const submitResult = (await novelSubmitChapterOutline(
      { payload: [cloneOutlineSkeleton(9, "剑冢的第九日")] },
      fixture.ctx,
    )) as { ok: boolean };
    expect(submitResult.ok).toBe(true);

    const result = (await novelBuildWritingContextPack({ chapter: 9 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as { warnings?: string[] };
    expect(pack.warnings).toContainEqual(expect.stringContaining("已连续 3 章无伏笔兑现"));
  });

  /** fixture 自带 S-HERB(target=8)/F-SWORD-CORE(target=24 落卷内规则) 会天然进「临期」，
   *  中和掉二者才能干净测试「只剩远期 major」这一场景（PR#502 人审 R3）。*/
  function neutralizeNearTermFixtureForeshadowing(fixture: ProjectFixture): void {
    fixture.db
      .prepare(
        `INSERT INTO foreshadowing_actions_log (novel_id, chapter, foreshadowing_id, action, status)
         VALUES ('novel-test', 2, 'S-HERB', 'reveal', 'realized')`,
      )
      .run();
    fixture.db
      .prepare(
        `INSERT INTO foreshadowing_actions_log (novel_id, chapter, foreshadowing_id, action, status)
         VALUES ('novel-test', 2, 'F-SWORD-CORE', 'reveal', 'realized')`,
      )
      .run();
  }

  it("只有远期 major（target=55）到期账不触发——不是随便有条活跃伏笔就催（spec §4.1 P2，PR#502 R3）", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    neutralizeNearTermFixtureForeshadowing(fixture); // due 里只剩 F-TRAITOR（major，target=55）
    for (let c = 2; c <= 8; c += 1) {
      await completeChapter(fixture, c);
    }
    const submitResult = (await novelSubmitChapterOutline(
      { payload: [cloneOutlineSkeleton(9, "剑冢的第九日·远期伏笔")] },
      fixture.ctx,
    )) as { ok: boolean };
    expect(submitResult.ok).toBe(true);

    const result = (await novelBuildWritingContextPack({ chapter: 9 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as {
      warnings?: string[];
      foreshadowing_due: { due: Array<{ id: string }> };
    };
    // 确认 F-TRAITOR（远期 major）确实还在 due 里——旧判据（活跃就催）会因此误触发
    expect(pack.foreshadowing_due.due.map((f) => f.id)).toContain("F-TRAITOR");
    expect(pack.warnings ?? []).not.toContainEqual(expect.stringContaining("无伏笔兑现"));
  });

  it("有临期项（target=12）且近 3 章无 develop/reveal 时触发——到期账判据抓真实临期（PR#502 R3）", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    neutralizeNearTermFixtureForeshadowing(fixture);
    await novelRegisterForeshadowing(
      { id: "F-NEAR-DUE", type: "small", description: "临期待兑现的小伏笔", planted_chapter: 1, target_reveal: "12" },
      fixture.ctx,
    );
    for (let c = 2; c <= 8; c += 1) {
      await completeChapter(fixture, c);
    }
    const submitResult = (await novelSubmitChapterOutline(
      { payload: [cloneOutlineSkeleton(9, "剑冢的第九日·临期伏笔")] },
      fixture.ctx,
    )) as { ok: boolean };
    expect(submitResult.ok).toBe(true);

    const result = (await novelBuildWritingContextPack({ chapter: 9 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as { warnings?: string[] };
    expect(pack.warnings).toContainEqual(expect.stringContaining("已连续 3 章无伏笔兑现"));
  });
});

describe("abstractRatio（锚点泛泛判定 · cross-chapter-warnings §2）", () => {
  it("具体锚点 ratio 低于阈值", () => {
    expect(abstractRatio("主角第一次直面父辈的过往")).toBeLessThan(0.5);
    expect(abstractRatio("在书房抽屉里发现那封信")).toBeLessThan(0.5);
  });

  it("泛泛锚点 ratio 不低于阈值", () => {
    expect(abstractRatio("重大的转折与变化")).toBeGreaterThanOrEqual(0.5);
    expect(abstractRatio("震惊与警醒后的觉醒")).toBeGreaterThanOrEqual(0.5);
  });

  it("极短文本不判定为泛泛", () => {
    expect(abstractRatio("觉醒")).toBe(0);
  });
});

describe("风格指令正向化（ADR-0024 · 克制类校准翻成正向写法）", () => {
  const RESTRAINT = ["克制", "留白", "节制", "收敛", "含蓄", "内敛", "不煽情"];

  it("形容词位克制词就地去除、保留被修饰的正向名词", () => {
    const [out, dropped] = positivizeNarratorFreeText(
      "底下是克制的冷峻与孤独",
    );
    expect(out).toBe("底下是冷峻与孤独");
    expect(out).not.toContain("克制");
    expect(out).toContain("孤独"); // 孤独底色保留
    expect(dropped).toBe(false); // 仅形容词清理，不触发正向句
  });

  it("作者破折号「——」不被分隔符清理折断", () => {
    const [out] = positivizeNarratorFreeText(
      "韩寒式轻幽默——底下是克制的冷峻",
    );
    expect(out).toBe("韩寒式轻幽默——底下是冷峻");
    expect(out).toContain("——");
  });

  it("谓语/独立位克制词整小句丢弃，正向小句保留", () => {
    const [out, dropped] = positivizeNarratorFreeText(
      "日常以口语化吐槽节奏推进，冲突时对话加快但叙述不碎片化，关键情感节点留白不煽情",
    );
    expect(out).toBe(
      "日常以口语化吐槽节奏推进，冲突时对话加快但叙述不碎片化",
    );
    for (const t of RESTRAINT) expect(out).not.toContain(t);
    expect(out).toContain("不碎片化"); // 正向校准（反碎句）不是克制词，保留
    expect(dropped).toBe(true);
  });

  it("无克制词的自由文本原样返回", () => {
    const [out, dropped] = positivizeNarratorFreeText("干净利落的爽文笔调");
    expect(out).toBe("干净利落的爽文笔调");
    expect(dropped).toBe(false);
  });

  it("关键词表丢弃克制 token、保留正向腔调词", () => {
    const [out, dropped] = positivizeStyleKeywords(
      "轻幽默、反讽、口语化节奏、节制抒情、留白、现代化叙事",
    );
    expect(out).toBe("轻幽默、反讽、口语化节奏、现代化叙事");
    for (const t of RESTRAINT) expect(out).not.toContain(t);
    expect(dropped).toBe(true);
  });

  it("renderStyleDirective：dogfood 叙述声音 → 出口无克制词、保留正向腔调、追加正向写法", () => {
    const voice = new Map<string, string>([
      ["archetype", "谐趣吐槽"],
      [
        "tone",
        "韩寒式轻幽默——表面用漫不经心的调侃讲述，底下是克制的冷峻与孤独。幽默是外衣不是答案，反差来自「笑着讲沉重的事」",
      ],
      [
        "pacing",
        "日常以口语化吐槽节奏推进，冲突时对话加快但叙述不碎片化，关键情感节点留白不煽情",
      ],
      ["style_keywords", "轻幽默、反讽、口语化节奏、节制抒情、留白、现代化叙事"],
    ]);
    const warnings: string[] = [];
    const directive = renderStyleDirective(voice, "web_standard", warnings);

    // 1) 出口不再出现任何克制类校准措辞
    for (const t of RESTRAINT) expect(directive).not.toContain(t);

    // 2) 该书正向腔调基因保留，不被削平到档位默认
    expect(directive).toContain("谐趣吐槽");
    expect(directive).toContain("轻幽默");
    expect(directive).toContain("反讽");
    expect(directive).toContain("孤独"); // 形容词清理后孤独底色仍在

    // 3) 拿掉克制后追加正向写法（承接「别滥情、别堆砌」意图）
    expect(directive).toContain("情绪靠画面、动作和细节演出来");

    // 4) 档位水位照常渲染
    expect(directive).toContain("写法水位");
    expect(warnings).toEqual([]);
  });

  it("renderStyleDirective：叙述声音无克制词时不追加正向句、原样透传", () => {
    const voice = new Map<string, string>([
      ["archetype", "猛文热血"],
      ["tone", "干净利落的爽文笔调"],
      ["pacing", "急"],
    ]);
    const directive = renderStyleDirective(voice, "web_fast", []);
    expect(directive).toContain("猛文热血");
    expect(directive).toContain("干净利落的爽文笔调");
    expect(directive).not.toContain("情绪靠画面、动作和细节演出来");
  });

  it("renderStyleDirective：句法处方类措辞不透传，节奏意图正向承接", () => {
    // 真机 dogfood 数据（novel-51136a98 叙述声音卡原文）：立项阶段写进卡里的「短句 / 段落实短 /
    // 描写精简」被弱模型当成可执行句长指标顶格执行——实测均句长掉到真人网文的 55-65%、
    // ≥25 字长句只剩真人的 1/3。同 ADR-0024 病理：文学直觉形容词 ≠ 句法处方。
    const voice = new Map<string, string>([
      [
        "archetype",
        "毒舌吐槽流——贴紧主角脑内OS，碎嘴但不啰嗦，短句快节奏，翻车时疯狂吐槽、队友犯蠢时精准暴击",
      ],
      ["tone", "轻松爆笑为主，吐槽火力全开；温暖底色藏在吐槽背后"],
      ["pacing", "短句快节奏，段落实短，适合移动端阅读。吐槽和对话占比高，描写精简"],
      ["style_keywords", "吐槽向、碎嘴、节奏感强、反差萌、笑中带暖"],
    ]);
    const directive = renderStyleDirective(voice, "web_fast", []);

    // 1) 句法处方措辞一个都不进出口
    for (const t of ["短句", "段落实短", "描写精简", "句子短", "段落短"]) {
      expect(directive).not.toContain(t);
    }
    // 2) 处方之外的正向意图全部保留（节奏快、对话多、腔调基因）
    expect(directive).toContain("快节奏");
    expect(directive).toContain("对话占比高");
    expect(directive).toContain("毒舌吐槽流");
    expect(directive).toContain("反差萌");
    // 3) 追加句长自由的正向承接（对症「别让读者为读懂一句话回头重看」）
    expect(directive).toContain("句子长短跟着情绪走");
    // 4) 维度名不与内容重复（删词后「节奏」+「快节奏」会撞成「节奏快节奏」）
    expect(directive).not.toContain("节奏快节奏");
    expect(directive).toContain("快节奏");
  });

  it("renderStyleDirective：维度名未被内容自带时照常冠上", () => {
    const voice = new Map<string, string>([["pacing", "急"]]);
    const directive = renderStyleDirective(voice, "web_standard", []);
    expect(directive).toContain("节奏急");
  });

  it("renderStyleDirective：archetype 里的克制类措辞同样被过滤（原先整段透传）", () => {
    const voice = new Map<string, string>([
      ["archetype", "冷峻悬疑——克制的白描，情绪留白"],
    ]);
    const directive = renderStyleDirective(voice, "web_standard", []);
    for (const t of ["克制", "留白"]) expect(directive).not.toContain(t);
    expect(directive).toContain("冷峻悬疑");
    expect(directive).toContain("情绪靠画面、动作和细节演出来");
  });

  it("STYLE_PROFILES：web_fast 档位文案不含句长处方（句长归本书声音，不归档位）", () => {
    const directive = renderStyleDirective(null, "web_fast", []);
    for (const t of ["句子短", "段落短"]) expect(directive).not.toContain(t);
    // 档位仍表达「快」——靠钩子密度与场景切换速度，不靠规定句长
    expect(directive).toContain("钩子");
  });

  it("renderStyleDirective：ornamentation/digression 自由文本里的克制词同样被过滤", () => {
    const voice = new Map<string, string>([
      ["archetype", "冷峻悬疑"],
      ["ornamentation", "克制"], // 修饰密度填了校准词
      ["digression", "极少离题，叙述留白"], // 离题倾向里夹了校准词
      ["address", "third_limited"],
    ]);
    const directive = renderStyleDirective(voice, "web_standard", []);
    for (const t of ["克制", "留白", "节制", "收敛", "含蓄", "内敛", "不煽情"]) {
      expect(directive).not.toContain(t);
    }
    // 单值克制词的维度被整段丢弃，不会渲染出「修饰密度克制」
    expect(directive).not.toContain("修饰密度");
    // 删除了校准 → 追加正向写法；正向腔调（archetype）保留
    expect(directive).toContain("情绪靠画面、动作和细节演出来");
    expect(directive).toContain("冷峻悬疑");
  });
});

describe("novel_get_character_dialogue_samples", () => {
  const DLG_UID = "11111111-1111-4111-8111-111111111111";

  function seedDialogue(
    db: Database.Database,
    rows: Array<{
      id: string;
      chapter: number;
      text: string;
      type?: string;
      context?: string | null;
      emotion?: string | null;
      pos?: number | null;
      uid?: string;
    }>,
  ): void {
    const stmt = db.prepare(
      `INSERT INTO character_dialogue_samples
        (id, novel_id, chapter, character, character_uid, dialogue_text, context, emotion, dialogue_type, position_in_chapter)
       VALUES (?, 'novel-test', ?, '林晚', ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      stmt.run(
        r.id,
        r.chapter,
        r.uid ?? DLG_UID,
        r.text,
        r.context ?? null,
        r.emotion ?? null,
        r.type ?? "dialogue",
        r.pos ?? null,
      );
    }
  }

  it("按 character_uid 查到样本，按 chapter / position 升序", async () => {
    const { ctx, db } = createProject();
    seedDialogue(db, [
      { id: "d2", chapter: 2, text: "第二章后半", pos: 5 },
      { id: "d1", chapter: 1, text: "第一章台词", pos: 1 },
      { id: "d3", chapter: 2, text: "第二章前半", pos: 1 },
    ]);

    const result = (await novelGetCharacterDialogueSamples({ character_uid: DLG_UID }, ctx)) as {
      ok: boolean;
      character_uid: string;
      samples: Array<{ chapter: number; dialogue_text: string }>;
      total: number;
    };
    expect(result.ok).toBe(true);
    expect(result.character_uid).toBe(DLG_UID);
    expect(result.samples.map((s) => s.dialogue_text)).toEqual([
      "第一章台词",
      "第二章前半",
      "第二章后半",
    ]);
    expect(result.total).toBe(3);
  });

  it("chapter_end 边界过滤 + dialogue_type 过滤", async () => {
    const { ctx, db } = createProject();
    seedDialogue(db, [
      { id: "a", chapter: 1, text: "对话1", type: "dialogue", pos: 1 },
      { id: "b", chapter: 2, text: "独白2", type: "monologue", pos: 1 },
      { id: "c", chapter: 5, text: "对话5", type: "dialogue", pos: 1 },
    ]);

    const result = (await novelGetCharacterDialogueSamples(
      { character_uid: DLG_UID, chapter_end: 2, dialogue_type: "dialogue" },
      ctx,
    )) as { samples: Array<{ dialogue_text: string }>; total: number };
    expect(result.samples.map((s) => s.dialogue_text)).toEqual(["对话1"]);
    expect(result.total).toBe(1);
  });

  it("limit 截断返回条数，total 反映全部匹配", async () => {
    const { ctx, db } = createProject();
    seedDialogue(
      db,
      Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, chapter: 1, text: `台词${i}`, pos: i })),
    );

    const result = (await novelGetCharacterDialogueSamples(
      { character_uid: DLG_UID, limit: 10 },
      ctx,
    )) as { samples: unknown[]; total: number };
    expect(result.samples).toHaveLength(10);
    expect(result.total).toBe(25);
  });

  it("空 character_uid 返回 singleError", async () => {
    const { ctx } = createProject();
    const result = (await novelGetCharacterDialogueSamples({ character_uid: "  " }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(false);
    const errors = result.errors as Array<{ field: string }>;
    expect(errors[0].field).toBe("character_uid");
  });

  it("context / emotion 存在时透出，缺省不带键", async () => {
    const { ctx, db } = createProject();
    seedDialogue(db, [
      { id: "x", chapter: 1, text: "带情绪", emotion: "愤怒", context: "对峙", pos: 1 },
      { id: "y", chapter: 1, text: "纯台词", pos: 2 },
    ]);

    const result = (await novelGetCharacterDialogueSamples({ character_uid: DLG_UID }, ctx)) as {
      samples: Array<Record<string, unknown>>;
    };
    expect(result.samples[0]).toMatchObject({ dialogue_text: "带情绪", emotion: "愤怒", context: "对峙" });
    expect(result.samples[1]).not.toHaveProperty("emotion");
    expect(result.samples[1]).not.toHaveProperty("context");
  });
});

describe("parseRenderedOutline — beat 骨架检索种子", () => {
  it("新 beat 骨架 md 取压力点/角色/定位种子", () => {
    const md = [
      "# 第4章 藏经阁对质",
      "",
      "## 本章定位",
      "",
      "张力峰值章。",
      "",
      "## 场景骨架",
      "",
      "1. 入场压力：进阁。",
      "2. 升级：拍玉佩。",
      "",
      "- 视角人物: 沈砚",
      "- 出场角色: 沈砚、陆昭",
    ].join("\n");
    const p = parseRenderedOutline(md);
    expect(p.pressure_points.length).toBeGreaterThanOrEqual(2);
    expect(p.pressure_points[0]).toContain("入场压力");
    expect(p.characters).toContain("沈砚");
    expect(p.characters).toContain("陆昭");
    expect(p.dramatic_focus).toContain("张力峰值章");
  });

  it("旧格式 md 仍解析戏剧焦点/压力点/角色（不回归）", () => {
    const md = [
      "# 第1章",
      "- 戏剧焦点: 焦点X",
      "## 场景",
      "### 场景 1 · 阁",
      "- 出场角色: 甲",
      "- 压力点: 压力Y",
    ].join("\n");
    const p = parseRenderedOutline(md);
    expect(p.dramatic_focus).toBe("焦点X");
    expect(p.pressure_points).toContain("压力Y");
    expect(p.characters).toContain("甲");
  });
});

describe("novel_get_extraction_scaffold — dimension_cheatsheet（T4：按维度渲染词表提示）", () => {
  it("词表存在时，scaffold 返回 dimension_cheatsheet 含维度 key/谓词/值域", async () => {
    const fixture = createProject();
    await novelSubmitStateVocabulary(
      {
        payload: {
          dimensions: [
            { key: "cultivation_level", predicate: "ability", display_name: "境界", cardinality: "one", value_type: "enum", values: ["练气", "筑基", "金丹"] },
            { key: "inventory", predicate: "possession", display_name: "持有物", cardinality: "many", value_type: "free" },
          ],
        },
      },
      fixture.ctx,
    );

    const result = (await novelExtractionScaffold({ chapter: 5 }, fixture.ctx)) as {
      dimension_cheatsheet?: Array<{
        key: string;
        display_name: string;
        predicate: string;
        cardinality: string;
        value_type: string;
        values?: string[];
      }>;
    };

    expect(result.dimension_cheatsheet).toBeDefined();
    expect(result.dimension_cheatsheet).toHaveLength(2);
    expect(result.dimension_cheatsheet).toContainEqual({
      key: "cultivation_level",
      display_name: "境界",
      predicate: "ability",
      cardinality: "one",
      value_type: "enum",
      values: ["练气", "筑基", "金丹"],
    });
    // many/free 维度无值域：不应出现 values 键（非 undefined 值域，而是键本身不存在）
    const inventoryDim = result.dimension_cheatsheet!.find((d) => d.key === "inventory");
    expect(inventoryDim).toBeDefined();
    expect(inventoryDim).not.toHaveProperty("values");
  });

  it("词表缺失时，scaffold 返回结果不含 dimension_cheatsheet 键（存量零回归）", async () => {
    const fixture = createProject(); // 未提交 novel_submit_state_vocabulary

    const result = (await novelExtractionScaffold({ chapter: 5 }, fixture.ctx)) as Record<string, unknown>;

    expect(result).not.toHaveProperty("dimension_cheatsheet");
  });
});

describe("novel_build_writing_context_pack · planned_state_changes 前置区块（A4×D2 片3）", () => {
  const LIN_UID = "11111111-1111-4111-8111-111111111111";

  it("本章有 planned 行：区块按词表 display_name 渲染人读行；已处置行不进包", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    writeFileSync(
      join(fixture.root, "bible", "state-vocabulary.json"),
      JSON.stringify({
        dimensions: [
          { key: "cultivation_level", predicate: "ability", display_name: "境界", cardinality: "one", value_type: "enum", values: ["练气", "筑基"] },
        ],
      }),
    );
    const insert = fixture.db.prepare(
      `INSERT INTO planned_state_changes (id, novel_id, chapter, character_uid, character_name, dimension, operation, value, reason, status)
       VALUES (?, 'novel-test', 2, ?, '林晚', 'cultivation_level', 'set', ?, ?, ?)`,
    );
    insert.run("p1", LIN_UID, "筑基", "自证清白后突破", "planned");
    insert.run("p2", LIN_UID, "练气", null, "cancelled");

    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8")) as { planned_state_changes?: string[] };
    expect(pack.planned_state_changes).toEqual(["林晚：境界变为「筑基」（自证清白后突破）"]);
  });

  it("本章无 planned 行：包不带该键（可选区块）", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as { pack_path: string };
    const pack = JSON.parse(readFileSync(result.pack_path, "utf-8"));
    expect(pack).not.toHaveProperty("planned_state_changes");
  });
});

describe("WCP characters_without_cards — 出场名单不静默缺人（issue #48）", () => {
  const GUANSHI_UID = "33333333-3333-4333-8333-333333333333";

  /** 撑爆区块预算的厚卡：BLOCK_BUDGETS.character_cards = 1500，中文 estimateTokens ≈ 1/字 */
  function seedFatCard(fixture: ProjectFixture, uid: string, name: string): void {
    insertFact(fixture.db, {
      id: `f-fat-${uid}`,
      novelId: fixture.ctx.novelId,
      subjectUid: uid,
      subject: name,
      predicate: "status",
      object: "刀".repeat(900),
      fromChapter: 1,
    });
  }

  function seedThinCard(fixture: ProjectFixture, uid: string, name: string): void {
    insertFact(fixture.db, {
      id: `f-thin-${uid}`,
      novelId: fixture.ctx.novelId,
      subjectUid: uid,
      subject: name,
      predicate: "status",
      object: `${name}守在药圃外`,
      fromChapter: 1,
    });
  }

  async function buildPack(fixture: ProjectFixture): Promise<{
    pack: {
      character_cards: Array<{ character: string }>;
      characters_without_cards?: Array<{
        character: string;
        character_uid?: string;
        reason: string;
      }>;
    };
    warnings: string[];
  }> {
    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      pack_path: string;
      warnings: string[];
    };
    return {
      pack: JSON.parse(readFileSync(result.pack_path, "utf-8")),
      warnings: result.warnings,
    };
  }

  it("折叠不出卡的出场角色点名到人并带 uid（赵伯只有双主体关系事实、药圃管事零事实）", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);

    const { pack } = await buildPack(fixture);
    const missing = pack.characters_without_cards ?? [];

    // 名单不变量：有卡的 + 没卡的 == 全部出场角色，一个都不能静默消失
    expect(
      [...pack.character_cards.map((c) => c.character), ...missing.map((m) => m.character)].sort(),
    ).toEqual(["林晚", "药圃管事", "赵伯"]);

    const guanshi = missing.find((m) => m.character === "药圃管事");
    expect(guanshi?.reason).toBe("尚无状态记录");
    // uid 必须带上：novel_character_state 只认 character_uid，只给名字等于让消费者自己
    // 去翻角色档案找 uid——真机实测审校就是在这一步开始猜文件路径的
    expect(guanshi?.character_uid).toBe(GUANSHI_UID);
    expect(missing.find((m) => m.character === "赵伯")?.character_uid).toBe(ZHAOBO_UID);
  });

  it("超预算裁掉的卡按人点名，诊断给名字而不是只报个数", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    seedFatCard(fixture, LINWAN_UID, "林晚");
    seedFatCard(fixture, ZHAOBO_UID, "赵伯");
    seedFatCard(fixture, GUANSHI_UID, "药圃管事");

    const { pack, warnings } = await buildPack(fixture);
    const missing = pack.characters_without_cards ?? [];

    // 三张厚卡远超 1500 预算，裁到下限 1 张 → 另外两人进名单
    expect(pack.character_cards).toHaveLength(1);
    const dropped = missing.filter((m) => m.reason === "状态卡超预算未随包给出");
    expect(dropped).toHaveLength(2);
    // 名单不变量在裁剪路径上同样成立（不依赖谁被留下这个排序细节）
    expect(
      [...pack.character_cards.map((c) => c.character), ...missing.map((m) => m.character)].sort(),
    ).toEqual(["林晚", "药圃管事", "赵伯"]);
    for (const entry of dropped) expect(entry.character_uid).toBeTruthy();

    // 回给主会话的诊断必须点名到人：write.md 步骤 2 的补查指令挂在名字上，
    // 只报「已丢弃 2 个角色」的话它知道少了人却不知道少了谁，整条补救链路空转（#48 根因）
    const note = warnings.find((w) => w.includes("角色状态卡超预算"));
    expect(note).toBeTruthy();
    for (const entry of dropped) expect(note).toContain(entry.character);
    expect(note).toContain("novel_character_state");
  });

  it("全员有卡且不超预算时不带该键（可选区块，不给零缺口的包添噪音）", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    seedThinCard(fixture, ZHAOBO_UID, "赵伯");
    seedThinCard(fixture, GUANSHI_UID, "药圃管事");

    const { pack } = await buildPack(fixture);
    expect(pack.character_cards.map((c) => c.character).sort()).toEqual([
      "林晚",
      "药圃管事",
      "赵伯",
    ]);
    expect(pack).not.toHaveProperty("characters_without_cards");
  });
});

describe("WCP derived_relationships（读时 2 跳共邻）", () => {
  const ZHISHI_UID = "44444444-4444-4444-8444-444444444444";
  const XUANCHEN_UID = "55555555-5555-4555-8555-555555555555";
  const PASSERBY_UID = "66666666-6666-4666-8666-666666666666";

  function insertRelEdge(
    db: Database.Database,
    args: {
      id: string;
      aUid: string;
      aName: string;
      bUid: string;
      bName: string;
      state: string;
      fromChapter: number;
      invalidatedAt?: number;
    },
  ): void {
    db.prepare(
      `INSERT INTO facts
         (id, novel_id, subject, subject_character_uid, subject_character_b_uid,
          predicate, object, from_chapter, event_chapter, invalidated_at_chapter)
       VALUES (?, 'novel-test', ?, ?, ?, 'relationship', ?, ?, ?, ?)`,
    ).run(
      args.id,
      `${args.aName}|${args.bName}`,
      args.aUid,
      args.bUid,
      args.state,
      args.fromChapter,
      args.fromChapter,
      args.invalidatedAt ?? null,
    );
  }

  /** 给玄尘子塞 3 条非关系事实，过资格门槛 */
  function qualifyXuanchen(db: Database.Database): void {
    for (const [i, predicate] of ["identity", "location", "goal"].entries()) {
      insertFact(db, {
        id: `xc-f${i}`,
        novelId: "novel-test",
        subjectUid: XUANCHEN_UID,
        subject: "玄尘子",
        predicate,
        object: `事实${i}`,
        fromChapter: 1,
      });
    }
  }

  async function buildPack(fixture: ProjectFixture): Promise<Record<string, unknown>> {
    const result = (await novelBuildWritingContextPack({ chapter: 2 }, fixture.ctx)) as {
      pack_path: string;
    };
    return JSON.parse(readFileSync(result.pack_path, "utf-8")) as Record<string, unknown>;
  }

  it("林晚、执事同师从玄尘子且无直接边 → 派生条目进包，标推断、不命名", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    writeCharacter(fixture.root, "执事", ZHISHI_UID);
    writeCharacter(fixture.root, "玄尘子", XUANCHEN_UID);
    const linUid = LINWAN_UID;
    insertRelEdge(fixture.db, {
      id: "dr1", aUid: linUid, aName: "林晚", bUid: XUANCHEN_UID, bName: "玄尘子",
      state: "师徒", fromChapter: 1,
    });
    insertRelEdge(fixture.db, {
      id: "dr2", aUid: ZHISHI_UID, aName: "执事", bUid: XUANCHEN_UID, bName: "玄尘子",
      state: "师徒", fromChapter: 1,
    });
    qualifyXuanchen(fixture.db);

    const pack = await buildPack(fixture);
    const derived = pack.derived_relationships as string[];
    expect(derived).toHaveLength(1);
    expect(derived[0]).toContain("推断");
    expect(derived[0]).toContain("林晚");
    expect(derived[0]).toContain("执事");
    expect(derived[0]).toContain("玄尘子");
    expect(derived[0]).toContain("师徒");
    expect(derived[0]).not.toContain("同门");
  });

  it("角色改名后派生条目显示当前档案名，不透传 facts.subject 旧名", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    writeCharacter(fixture.root, "执事", ZHISHI_UID);
    writeCharacter(fixture.root, "玄尘子", XUANCHEN_UID); // 档案已是新名
    // 两条边落库时玄尘子还叫「玄尘老道」（改名流程只迁档案文件，不重写历史 facts.subject）
    insertRelEdge(fixture.db, {
      id: "dr-r1", aUid: LINWAN_UID, aName: "林晚", bUid: XUANCHEN_UID, bName: "玄尘老道",
      state: "师徒", fromChapter: 1,
    });
    insertRelEdge(fixture.db, {
      id: "dr-r2", aUid: ZHISHI_UID, aName: "执事", bUid: XUANCHEN_UID, bName: "玄尘老道",
      state: "师徒", fromChapter: 1,
    });
    qualifyXuanchen(fixture.db);

    const pack = await buildPack(fixture);
    const derived = pack.derived_relationships as string[];
    expect(derived).toHaveLength(1);
    expect(derived[0]).toContain("玄尘子");
    expect(derived[0]).not.toContain("玄尘老道");
  });

  it("一条搭桥边已失效 → 不再推出", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    writeCharacter(fixture.root, "执事", ZHISHI_UID);
    writeCharacter(fixture.root, "玄尘子", XUANCHEN_UID);
    insertRelEdge(fixture.db, {
      id: "dr3", aUid: LINWAN_UID, aName: "林晚", bUid: XUANCHEN_UID, bName: "玄尘子",
      state: "师徒", fromChapter: 1, invalidatedAt: 1, // asOf = chapter-1 = 1 时已失效
    });
    insertRelEdge(fixture.db, {
      id: "dr4", aUid: ZHISHI_UID, aName: "执事", bUid: XUANCHEN_UID, bName: "玄尘子",
      state: "师徒", fromChapter: 1,
    });
    qualifyXuanchen(fixture.db);

    const pack = await buildPack(fixture);
    expect(pack.derived_relationships).toEqual([]);
  });

  it("有直接边的对不推派生；无任何派生时字段为恒在空数组", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    writeCharacter(fixture.root, "执事", ZHISHI_UID);
    writeCharacter(fixture.root, "玄尘子", XUANCHEN_UID);
    insertRelEdge(fixture.db, {
      id: "dr5", aUid: LINWAN_UID, aName: "林晚", bUid: ZHISHI_UID, bName: "执事",
      state: "上下级", fromChapter: 1,
    });
    insertRelEdge(fixture.db, {
      id: "dr6", aUid: LINWAN_UID, aName: "林晚", bUid: XUANCHEN_UID, bName: "玄尘子",
      state: "师徒", fromChapter: 1,
    });
    insertRelEdge(fixture.db, {
      id: "dr7", aUid: ZHISHI_UID, aName: "执事", bUid: XUANCHEN_UID, bName: "玄尘子",
      state: "师徒", fromChapter: 1,
    });
    qualifyXuanchen(fixture.db);

    const pack = await buildPack(fixture);
    expect(pack.derived_relationships).toEqual([]);
  });

  it("唯一共邻是龙套（事实 <3）→ 不输出", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    writeCharacter(fixture.root, "执事", ZHISHI_UID);
    writeCharacter(fixture.root, "路人甲", PASSERBY_UID);
    insertRelEdge(fixture.db, {
      id: "dr8", aUid: LINWAN_UID, aName: "林晚", bUid: PASSERBY_UID, bName: "路人甲",
      state: "旧识", fromChapter: 1,
    });
    insertRelEdge(fixture.db, {
      id: "dr9", aUid: ZHISHI_UID, aName: "执事", bUid: PASSERBY_UID, bName: "路人甲",
      state: "旧识", fromChapter: 1,
    });
    // 路人甲仅 2 条关系边，无其他事实 → 计数 2 < 3

    const pack = await buildPack(fixture);
    expect(pack.derived_relationships).toEqual([]);
  });

  it("历史角色不当派生端点：赵伯（仅前章出场）×执事的共邻不产出", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    writeCharacter(fixture.root, "执事", ZHISHI_UID);
    writeCharacter(fixture.root, "玄尘子", XUANCHEN_UID);
    // 只给 赵伯、执事 搭桥（林晚 不连玄尘子）→ 本章端点对 (林晚,执事) 无共邻
    insertRelEdge(fixture.db, {
      id: "dr10", aUid: ZHAOBO_UID, aName: "赵伯", bUid: XUANCHEN_UID, bName: "玄尘子",
      state: "师徒", fromChapter: 1,
    });
    insertRelEdge(fixture.db, {
      id: "dr11", aUid: ZHISHI_UID, aName: "执事", bUid: XUANCHEN_UID, bName: "玄尘子",
      state: "师徒", fromChapter: 1,
    });
    qualifyXuanchen(fixture.db);

    const pack = await buildPack(fixture);
    const derived = pack.derived_relationships as string[];
    expect(derived.every((line) => !line.includes("赵伯"))).toBe(true);
    expect(derived).toEqual([]);
  });

  it("P1 复现：林晚×执事有畸形 subject 的直接边（不可展示）+ 与玄尘子各有一条好边共邻 → 不推派生", async () => {
    const fixture = createProject();
    await seedFullProject(fixture);
    writeCharacter(fixture.root, "执事", ZHISHI_UID);
    writeCharacter(fixture.root, "玄尘子", XUANCHEN_UID);
    // 直插一条 subject 无「|」分隔的畸形直接边（林晚×执事），loader 会跳过展示但仍占 directPairKeys 名额
    fixture.db
      .prepare(
        `INSERT INTO facts
           (id, novel_id, subject, subject_character_uid, subject_character_b_uid,
            predicate, object, from_chapter, event_chapter, invalidated_at_chapter)
         VALUES ('dr12', 'novel-test', '林晚与执事', ?, ?, 'relationship', '旧识', 1, 1, NULL)`,
      )
      .run(LINWAN_UID, ZHISHI_UID);
    insertRelEdge(fixture.db, {
      id: "dr13", aUid: LINWAN_UID, aName: "林晚", bUid: XUANCHEN_UID, bName: "玄尘子",
      state: "师徒", fromChapter: 1,
    });
    insertRelEdge(fixture.db, {
      id: "dr14", aUid: ZHISHI_UID, aName: "执事", bUid: XUANCHEN_UID, bName: "玄尘子",
      state: "师徒", fromChapter: 1,
    });
    qualifyXuanchen(fixture.db);

    const pack = await buildPack(fixture);
    expect(pack.derived_relationships).toEqual([]);
  });
});

describe("novel_list_structure_cards", () => {
  it("stage-1 默认返回官方 3 张书级结构卡（绝对路径）", async () => {
    resetPackResolverCache();
    const { ctx } = createProject();
    const result = (await novelListStructureCards(
      { stage: "stage-1" },
      ctx,
    )) as Record<string, unknown>;
    const cards = result.cards as Array<{ id: string; path: string }>;
    expect(result.stage).toBe("stage-1");
    expect(cards.map((c) => c.id).sort()).toEqual([
      "arc-rhythm",
      "foreshadow-distance",
      "storyline-weave",
    ]);
    expect(cards.every((c) => isAbsolute(c.path))).toBe(true);
  });

  it("stage-2 默认返回官方 5 张章级结构卡", async () => {
    resetPackResolverCache();
    const { ctx } = createProject();
    const result = (await novelListStructureCards(
      { stage: "stage-2" },
      ctx,
    )) as Record<string, unknown>;
    const cards = result.cards as Array<{ id: string; path: string; dimension: string }>;
    expect(result.stage).toBe("stage-2");
    expect(cards.map((c) => c.id).sort()).toEqual([
      "hook-cadence",
      "payoff-cadence",
      "pressure-release",
      "stakes-ladder",
      "twist-mechanics",
    ]);
    expect(cards.every((c) => isAbsolute(c.path))).toBe(true);
    expect(cards.every((c) => typeof c.dimension === "string" && c.dimension.length > 0)).toBe(
      true,
    );
  });

  it("stage-opening 默认返回官方 2 张开局结构卡", async () => {
    resetPackResolverCache();
    const { ctx } = createProject();
    const result = (await novelListStructureCards(
      { stage: "stage-opening" },
      ctx,
    )) as Record<string, unknown>;
    const cards = result.cards as Array<{ id: string; path: string }>;
    expect(result.stage).toBe("stage-opening");
    expect(cards.map((c) => c.id).sort()).toEqual(["opening-hook", "selling-point-front"]);
    expect(cards.every((c) => isAbsolute(c.path))).toBe(true);
  });

  it("每张卡携带 dimension / one_line / origin，notes 透传池发现期诊断", async () => {
    resetPackResolverCache();
    const { ctx } = createProject();
    const result = (await novelListStructureCards(
      { stage: "stage-1" },
      ctx,
    )) as Record<string, unknown>;
    const cards = result.cards as Array<{
      id: string;
      dimension: string;
      one_line: string;
      origin: string;
    }>;
    expect(cards.every((c) => c.dimension && c.one_line && c.origin === "official")).toBe(true);
    expect(Array.isArray(result.notes)).toBe(true);
  });

  it("落盘规划期装载回执 planning-<stage>.json，供 App 展示剧作卡被规划阶段装载过（spec §6）", async () => {
    resetPackResolverCache();
    const { ctx, root } = createProject();
    await novelListStructureCards({ stage: "stage-1" }, ctx);
    const receiptPath = join(root, ".narracat", "capability-receipts", "planning-stage-1.json");
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      stage: string;
      generated_at: string;
      entries: Array<{ card_id: string; pack_id: string; pack_version: string; origin: string }>;
    };
    expect(receipt.stage).toBe("stage-1");
    expect(typeof receipt.generated_at).toBe("string");
    expect(receipt.entries.map((e) => e.card_id).sort()).toEqual([
      "arc-rhythm",
      "foreshadow-distance",
      "storyline-weave",
    ]);
    expect(receipt.entries.every((e) => e.pack_id === "official-base" && e.origin === "official")).toBe(
      true,
    );
  });
});
