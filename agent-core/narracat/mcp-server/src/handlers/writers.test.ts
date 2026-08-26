import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { parse } from "yaml";

vi.mock("../utils/embedding.js", () => ({
  embed: vi.fn(async () => null),
}));

import { initSchema } from "../migrate.js";
import { auditForeshadowingLifecycle, formatForeshadowingLifecycleAuditReport } from "../foreshadowing-audit.js";
import type { ToolContext } from "../types.js";
import {
  novelCommitChapter,
  novelSubmitExtraction,
  novelStageExtraction,
  novelCommitExtractionUnion,
  novelConsolidate,
  novelSubmitReview,
  novelSubmitOutline,
  novelSubmitChapterOutline,
  novelSubmitPremise,
  novelRegisterForeshadowing,
  novelRollbackChapter,
  backfillOutlineArtifacts,
  backfillReviewArtifacts,
  novelSubmitDialogueSamples,
} from "./writers.js";
import { stagingManuscriptPath } from "./state-sync.js";
import { validateOutlineBookPayload } from "./validators.js";

function loadFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf-8"),
  ) as T;
}

const CHAR_UID: Record<string, string> = {
  林晚: "11111111-1111-4111-8111-111111111111",
  赵伯: "22222222-2222-4222-8222-222222222222",
  药圃管事: "33333333-3333-4333-8333-333333333333",
  执事: "44444444-4444-4444-8444-444444444444",
  沈决: "55555555-5555-4555-8555-555555555555",
};

/** 写带 character_identity 的角色档案（uid 必达校验所需） */
function writeCharacter(root: string, name: string, aliases = ""): void {
  writeFileSync(
    join(root, "bible", "characters", `${name}.md`),
    `<!-- character_identity: {"character_uid":"${CHAR_UID[name]}","name":"${name}"} -->\n# ${name}\n${aliases ? `\n别名: ${aliases}\n` : ""}`,
  );
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
  "## 叙述声音",
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

function createProject(): ProjectFixture {
  const root = mkdtempSync(join(tmpdir(), "narracat-writers-"));
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
    },
  };
}

async function submitValidOutline(ctx: ToolContext): Promise<Record<string, unknown>> {
  return (await novelSubmitOutline(
    { phase: 1, payload: loadFixture("outline-v5-valid-book.json") },
    ctx,
  )) as Record<string, unknown>;
}

/**
 * 双卷版本（checkHookCadence 跨卷合并窗口测试专用）：把 outline-v5-valid-book.json 唯一一卷
 * 的两个 arc 拆成两卷各一个 arc（章号范围不变，V01-A01=1-12 留卷1，V01-A02 章号搬进卷2改名
 * V02-A01），预算/里程碑数字对 60 章全书仍成立（两卷跨度均落在 S 档 arc_span 5-15 内）。
 */
async function submitTwoVolumeOutline(ctx: ToolContext): Promise<Record<string, unknown>> {
  const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
  const payload = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const [vol1] = payload.volumes as Array<Record<string, unknown>>;
  const [arc1, arc2] = vol1.arc_list as Array<Record<string, unknown>>;
  payload.volumes = [
    { volume_no: 1, title: vol1.title, dilemma_milestone: "choice", arc_list: [arc1] },
    { volume_no: 2, title: "剑冢", arc_list: [{ ...arc2, arc_id: "V02-A01" }] },
  ];
  return (await novelSubmitOutline({ phase: 1, payload }, ctx)) as Record<string, unknown>;
}

async function submitBookScopeOutline(ctx: ToolContext): Promise<Record<string, unknown>> {
  const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
  const { volumes: _volumes, ...book } = base;
  return (await novelSubmitOutline(
    { phase: 1, scope: "book", payload: book },
    ctx,
  )) as Record<string, unknown>;
}

function writeManuscript(root: string, chapter: number, content?: string): void {
  const padded = String(chapter).padStart(3, "0");
  writeFileSync(
    join(root, "manuscript", "vol-01", `ch-${padded}.md`),
    content ??
      `# 第${chapter}章\n\n${"林晚握着断剑站在剑冢里，掌心的伤口还在渗血。".repeat(40)}\n`,
  );
}

describe("novel_submit_outline", () => {
  it("入库 + 机械渲染 master-outline 与 vol-outline + 同步 structure", async () => {
    const { ctx, root, db } = createProject();

    const result = await submitValidOutline(ctx);

    expect(result.ok).toBe(true);
    expect(result.volumes).toBe(1);
    expect(result.arcs).toBe(2);
    expect(result.storylines).toBe(3);
    expect(result.structure_synced).toBe(true);

    const master = readFileSync(join(root, "outline", "master-outline.md"), "utf-8");
    expect(master).toContain("## 中心戏剧问题");
    expect(master).toContain("## 叙述者腔调");
    expect(master).toContain("**archetype**: 猛文热血");
    expect(master).toContain("V01-A01");

    const volOutline = readFileSync(join(root, "outline", "vol-01", "vol-outline.md"), "utf-8");
    expect(volOutline).toContain("药圃失窃案");
    // 施压者行（issue #429）：V01-A01 fixture 填了 antagonist_agent，渲染进 vol-outline
    expect(volOutline).toContain("- 施压者: 药圃管事");
    // V01-A02 fixture 未填 antagonist_agent，不应出现空「施压者:」行
    const a02Section = volOutline.slice(volOutline.indexOf("V01-A02"));
    expect(a02Section).not.toContain("施压者");

    const arcs = db
      .prepare("SELECT arc_id, antagonist_agent FROM arc_meta WHERE novel_id = ? ORDER BY chapter_start")
      .all("novel-test") as Array<{ arc_id: string; antagonist_agent: string | null }>;
    expect(arcs.map((a) => a.arc_id)).toEqual(["V01-A01", "V01-A02"]);
    expect(arcs[0].antagonist_agent).toBe("药圃管事");
    expect(arcs[1].antagonist_agent).toBeNull();

    // is_through_line 经写入口落库（SL-main 标记贯穿线），并在 master-outline 标注 [贯穿线]
    const sls = db
      .prepare("SELECT id, is_through_line FROM storylines WHERE novel_id = ? ORDER BY id")
      .all("novel-test") as Array<{ id: string; is_through_line: number }>;
    const through = sls.find((s) => s.id === "SL-main");
    expect(through?.is_through_line).toBe(1);
    expect(sls.find((s) => s.id === "SL-growth")?.is_through_line).toBe(0);
    expect(master).toContain("[贯穿线]");

    const state = parse(readFileSync(join(root, ".narracat", "state.yaml"), "utf-8"));
    expect(state.structure.total_volumes).toBe(1);
    expect(state.structure.total_chapters_planned).toBe(24);
    expect(state.structure.chapter_to_volume[24]).toBe(1);
  });

  it("ajv 校验失败时返回 errors[] 且不写任何文件", async () => {
    const { ctx, root } = createProject();

    const result = (await novelSubmitOutline(
      { phase: 1, payload: loadFixture("outline-v5-invalid-missing-arc-fields.json") },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    const errors = result.errors as Array<Record<string, unknown>>;
    expect(errors.length).toBeGreaterThan(0);
    expect(existsSync(join(root, "outline", "master-outline.md"))).toBe(false);
  });

  it("phase 不为 1 时拒绝", async () => {
    const { ctx } = createProject();
    const result = (await novelSubmitOutline({ phase: 2, payload: {} }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(false);
  });

  // 显式 null 属于「传了但不等于 1」，不是省略——`?? 1` 会把它静默当成 1 放行。
  // runTool 直接调 handler、不跑 tool inputSchema 校验，这里是唯一防线。
  it("phase 显式为 null 时拒绝（不当成省略）", async () => {
    const { ctx } = createProject();
    const result = (await novelSubmitOutline({ phase: null, payload: {} }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(false);
    const fields = (result.errors as Array<{ field: string }>).map((e) => e.field);
    expect(fields).toContain("phase");
  });

  // phase 恒为 1、无第二个取值，故不强制模型传：漏传不该白撞一轮入参校验。
  // 显式传错值的拒绝路径由上一条锁住，两条一起才是完整语义。
  it("省略 phase 与显式传 1 等价（缺省即 1）", async () => {
    const { ctx, root } = createProject();
    const result = (await novelSubmitOutline(
      { payload: loadFixture("outline-v5-valid-book.json") },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.volumes).toBe(1);
    expect(result.arcs).toBe(2);
    expect(existsSync(join(root, "outline", "master-outline.md"))).toBe(true);
  });

  it("省略 phase 时 scope 分支照常生效（不因缺省而回落 full）", async () => {
    const { ctx } = createProject();
    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const { volumes: _volumes, ...book } = base;
    const result = (await novelSubmitOutline({ scope: "book", payload: book }, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.ok).toBe(true);
    // scope=book 只落书级骨架、卷结构待展开，故卷数为 0——若 phase 缺省把整条分支带偏回落
    // full，这里会拿到 fixture 的 1 卷。
    expect(result.volumes).toBe(0);
  });

  it("伏笔延迟兑现告警随回执返回、不阻断入库（ok 仍 true）", async () => {
    const { ctx } = createProject();
    const payload = loadFixture<Record<string, any>>("outline-v5-valid-book.json");
    // S-HERB 是 small，埋第 1 章（V01-A01），改成第 13 章（V01-A02）兑现 → 跨 arc 延迟告警
    const herb = payload.foreshadowing_registry.find((f: any) => f.id === "S-HERB");
    herb.target_reveal = "13";

    const result = (await novelSubmitOutline({ phase: 1, payload }, ctx)) as Record<
      string,
      unknown
    >;

    // 非阻断：照常入库
    expect(result.ok).toBe(true);
    // 专属字段 + 并入既有 warnings
    const payoffWarnings = result.foreshadowing_payoff_warnings as string[];
    expect(payoffWarnings.some((w) => w.includes("S-HERB") && w.includes("small"))).toBe(true);
    expect((result.warnings as string[]).some((w) => w.includes("S-HERB"))).toBe(true);
  });

});

describe("novel_submit_outline · scope=book（书级段）", () => {
  it("书级入库：master 渲染待展开占位、structure.json volumes 空、不渲染卷文件、不同步 structure、无缺口警告", async () => {
    const { ctx, root, db } = createProject();
    const result = await submitBookScopeOutline(ctx);
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("book");
    const master = readFileSync(join(root, "outline", "master-outline.md"), "utf-8");
    expect(master).toContain("## 卷结构");
    expect(master).toContain("待展开");
    const structure = JSON.parse(
      readFileSync(join(root, "outline", "outline-structure.json"), "utf-8"),
    ) as { volumes: unknown[] };
    expect(structure.volumes).toEqual([]);
    expect(existsSync(join(root, "outline", "vol-01"))).toBe(false);
    expect(readFileSync(join(root, ".narracat", "state.yaml"), "utf-8")).toContain(
      "total_chapters_planned: 0",
    );
    const arcRow = db
      .prepare("SELECT COUNT(*) AS n FROM arc_meta WHERE novel_id = ?")
      .get("novel-test") as { n: number };
    expect(arcRow.n).toBe(0);
    const slRow = db
      .prepare("SELECT COUNT(*) AS n FROM storylines WHERE novel_id = ?")
      .get("novel-test") as { n: number };
    expect(slRow.n).toBeGreaterThan(0);
    expect((result.warnings as string[]).join("")).not.toContain("缺口");
    // message 是下游硬契约（Task 3/5/6 依赖回执形状），精确断言
    expect(result.message).toBe("书级骨架已入库：3 条故事线 / 3 条伏笔，卷级待展开");
  });

  it("book 段 payload 携带非空 volumes → 拒绝", async () => {
    const { ctx } = createProject();
    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const result = (await novelSubmitOutline(
      { phase: 1, scope: "book", payload: base },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    // 锁定是显式检查拒绝（payload.volumes 字段级 error），而非 schema 层泛化报错
    expect((result.errors as Array<{ field: string }>)[0].field).toBe("payload.volumes");
  });

  it("卷级已展开后误用 scope=book 重提 → 拒绝，outline-structure.json 卷结构不被覆写", async () => {
    const { ctx, root } = createProject();
    const full = await submitValidOutline(ctx);
    expect(full.ok).toBe(true);

    const result = await submitBookScopeOutline(ctx);

    expect(result.ok).toBe(false);
    expect((result.errors as Array<{ field: string }>)[0].field).toBe("scope");
    const structure = JSON.parse(
      readFileSync(join(root, "outline", "outline-structure.json"), "utf-8"),
    ) as { volumes: unknown[] };
    expect(structure.volumes.length).toBeGreaterThan(0);
  });

  it("非法 scope → 拒绝", async () => {
    const { ctx } = createProject();
    const result = (await novelSubmitOutline(
      { phase: 1, scope: "chapter", payload: {} },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("outline-structure.json 是坏 JSON 时，book 段重提放行（守卫 catch 视同未展开，书级重写顺带修复该文件）", async () => {
    const { ctx, root } = createProject();
    const first = await submitBookScopeOutline(ctx);
    expect(first.ok).toBe(true);

    const structurePath = join(root, "outline", "outline-structure.json");
    writeFileSync(structurePath, "{not json");

    const result = await submitBookScopeOutline(ctx);

    expect(result.ok).toBe(true);
    const structure = JSON.parse(readFileSync(structurePath, "utf-8")) as { volumes: unknown[] };
    expect(structure.volumes).toEqual([]);
  });
});

describe("novel_submit_outline · scope=volumes（卷级展开）", () => {
  it("合成库内书级（含作者手改）+ 提交卷级走全量管线；书级不被覆盖", async () => {
    const { ctx, root } = createProject();
    await submitBookScopeOutline(ctx);
    // 模拟作者在确认窗口经编辑器直改故事线名（三写原子的文件面）
    const structurePath = join(root, "outline", "outline-structure.json");
    const stored = JSON.parse(readFileSync(structurePath, "utf-8")) as {
      storylines: Array<{ name: string }>;
    };
    stored.storylines[0].name = "作者改过的主线名";
    writeFileSync(structurePath, `${JSON.stringify(stored, null, 2)}\n`);

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const result = (await novelSubmitOutline(
      {
        phase: 1,
        scope: "volumes",
        payload: { central_dramatic_question: "恶意覆盖", volumes: base.volumes },
      },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("volumes");

    const merged = JSON.parse(readFileSync(structurePath, "utf-8")) as {
      central_dramatic_question: string;
      storylines: Array<{ name: string }>;
      volumes: unknown[];
    };
    expect(merged.storylines[0].name).toBe("作者改过的主线名");
    expect(merged.central_dramatic_question).not.toBe("恶意覆盖");
    expect(merged.volumes.length).toBeGreaterThan(0);

    const master = readFileSync(join(root, "outline", "master-outline.md"), "utf-8");
    expect(master).not.toContain("待展开");
    expect(master).toContain("作者改过的主线名");
    expect(existsSync(join(root, "outline", "vol-01", "vol-outline.md"))).toBe(true);
    expect(readFileSync(join(root, ".narracat", "state.yaml"), "utf-8")).not.toContain(
      "total_chapters_planned: 0",
    );
  });

  it("outline-structure.json 是坏 JSON 时，volumes 段返回结构化错误而非抛异常（PR#449 评审 P1）", async () => {
    const { ctx, root } = createProject();
    await submitBookScopeOutline(ctx);
    const structurePath = join(root, "outline", "outline-structure.json");
    writeFileSync(structurePath, "{not json");

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const result = (await novelSubmitOutline(
      { phase: 1, scope: "volumes", payload: { volumes: base.volumes } },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect((result.errors as Array<{ field: string }>)[0].field).toBe("outline");
  });

  it("重排卷数变少时清理不再存在卷的 vol-outline.md（PR#449 评审 P2）", async () => {
    const { ctx, root } = createProject();
    await submitBookScopeOutline(ctx);
    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const [vol1] = base.volumes as Array<Record<string, unknown>>;
    const [arc1, arc2] = vol1.arc_list as Array<Record<string, unknown>>;
    const twoVolumes = [
      { volume_no: 1, title: vol1.title, dilemma_milestone: "choice", arc_list: [arc1] },
      { volume_no: 2, title: "剑冢", arc_list: [{ ...arc2, arc_id: "V02-A01" }] },
    ];

    const expanded = (await novelSubmitOutline(
      { phase: 1, scope: "volumes", payload: { volumes: twoVolumes } },
      ctx,
    )) as Record<string, unknown>;
    expect(expanded.ok).toBe(true);
    expect(existsSync(join(root, "outline", "vol-02", "vol-outline.md"))).toBe(true);

    const shrunk = (await novelSubmitOutline(
      { phase: 1, scope: "volumes", payload: { volumes: [twoVolumes[0]] } },
      ctx,
    )) as Record<string, unknown>;

    expect(shrunk.ok).toBe(true);
    expect(existsSync(join(root, "outline", "vol-02", "vol-outline.md"))).toBe(false);
    expect(existsSync(join(root, "outline", "vol-02"))).toBe(false);
    const master = readFileSync(join(root, "outline", "master-outline.md"), "utf-8");
    expect(master).not.toContain("第 2 卷");
    expect(shrunk.files_removed).toEqual([
      join(root, "outline", "vol-02", "vol-outline.md"),
    ]);
  });

  it("重排后目录仍有章级细纲文件时保留目录与文件、只清理 vol-outline.md 并告警（PR#449 评审 P2）", async () => {
    const { ctx, root } = createProject();
    await submitBookScopeOutline(ctx);
    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const [vol1] = base.volumes as Array<Record<string, unknown>>;
    const [arc1, arc2] = vol1.arc_list as Array<Record<string, unknown>>;
    const twoVolumes = [
      { volume_no: 1, title: vol1.title, dilemma_milestone: "choice", arc_list: [arc1] },
      { volume_no: 2, title: "剑冢", arc_list: [{ ...arc2, arc_id: "V02-A01" }] },
    ];
    await novelSubmitOutline(
      { phase: 1, scope: "volumes", payload: { volumes: twoVolumes } },
      ctx,
    );
    mkdirSync(join(root, "outline", "vol-02"), { recursive: true });
    writeFileSync(join(root, "outline", "vol-02", "ch-013.md"), "# 第13章细纲\n");

    const shrunk = (await novelSubmitOutline(
      { phase: 1, scope: "volumes", payload: { volumes: [twoVolumes[0]] } },
      ctx,
    )) as Record<string, unknown>;

    expect(shrunk.ok).toBe(true);
    expect(existsSync(join(root, "outline", "vol-02", "vol-outline.md"))).toBe(false);
    expect(existsSync(join(root, "outline", "vol-02", "ch-013.md"))).toBe(true);
    expect((shrunk.warnings as string[]).some((w) => w.includes("人工确认"))).toBe(true);
  });

  it("书级骨架未提交时拒绝 volumes 段", async () => {
    const { ctx } = createProject();
    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const result = (await novelSubmitOutline(
      { phase: 1, scope: "volumes", payload: { volumes: base.volumes } },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("volumes 缺失或为空数组时拒绝", async () => {
    const { ctx } = createProject();
    await submitBookScopeOutline(ctx);
    const result = (await novelSubmitOutline(
      { phase: 1, scope: "volumes", payload: {} },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("volumes 显式传空数组时同样拒绝", async () => {
    const { ctx } = createProject();
    await submitBookScopeOutline(ctx);
    const result = (await novelSubmitOutline(
      { phase: 1, scope: "volumes", payload: { volumes: [] } },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect((result.errors as Array<{ field: string }>)[0].field).toBe("payload.volumes");
  });
});

describe("novel_submit_outline · 重提交清理陈旧行（issue #448）", () => {
  it("scope=volumes 二次提交少一卷：DB arc_meta 无幽灵行、state.yaml 章数以新提交集为准", async () => {
    const { ctx, root, db } = createProject();
    await submitBookScopeOutline(ctx);
    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const [vol1] = base.volumes as Array<Record<string, unknown>>;
    const [arc1, arc2] = vol1.arc_list as Array<Record<string, unknown>>;
    const twoVolumes = [
      { volume_no: 1, title: vol1.title, dilemma_milestone: "choice", arc_list: [arc1] },
      { volume_no: 2, title: "剑冢", arc_list: [{ ...arc2, arc_id: "V02-A01" }] },
    ];

    const expanded = (await novelSubmitOutline(
      { phase: 1, scope: "volumes", payload: { volumes: twoVolumes } },
      ctx,
    )) as Record<string, unknown>;
    expect(expanded.ok).toBe(true);
    let state = parse(readFileSync(join(root, ".narracat", "state.yaml"), "utf-8"));
    expect(state.structure.total_chapters_planned).toBe(24);

    // 重提交：只剩第一卷（第二卷 arc V02-A01 应从 DB 清理，不再是幽灵行）
    const shrunk = (await novelSubmitOutline(
      { phase: 1, scope: "volumes", payload: { volumes: [twoVolumes[0]] } },
      ctx,
    )) as Record<string, unknown>;
    expect(shrunk.ok).toBe(true);

    const arcs = db
      .prepare("SELECT arc_id FROM arc_meta WHERE novel_id = ? ORDER BY arc_id")
      .all("novel-test") as Array<{ arc_id: string }>;
    expect(arcs.map((a) => a.arc_id)).toEqual(["V01-A01"]);
    const ghost = db
      .prepare("SELECT COUNT(*) AS n FROM arc_meta WHERE novel_id = ? AND chapter_start >= 13")
      .get("novel-test") as { n: number };
    expect(ghost.n).toBe(0);

    state = parse(readFileSync(join(root, ".narracat", "state.yaml"), "utf-8"));
    expect(state.structure.total_chapters_planned).toBe(12);
  });

  it("full 重提交卷数变少：DB 幽灵 arc 与 vol-outline.md 文件残留同时清理", async () => {
    const { ctx, root, db } = createProject();
    const twoVolResult = await submitTwoVolumeOutline(ctx);
    expect(twoVolResult.ok).toBe(true);
    expect(existsSync(join(root, "outline", "vol-02", "vol-outline.md"))).toBe(true);

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const [vol1] = base.volumes as Array<Record<string, unknown>>;
    const [arc1] = vol1.arc_list as Array<Record<string, unknown>>;
    const shrunkPayload = {
      ...base,
      volumes: [{ ...vol1, arc_list: [arc1] }],
    };

    const result = (await novelSubmitOutline(
      { phase: 1, payload: shrunkPayload },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);

    const arcs = db
      .prepare("SELECT arc_id FROM arc_meta WHERE novel_id = ? ORDER BY arc_id")
      .all("novel-test") as Array<{ arc_id: string }>;
    expect(arcs.map((a) => a.arc_id)).toEqual(["V01-A01"]);

    expect(existsSync(join(root, "outline", "vol-02", "vol-outline.md"))).toBe(false);
    expect(existsSync(join(root, "outline", "vol-02"))).toBe(false);

    const state = parse(readFileSync(join(root, ".narracat", "state.yaml"), "utf-8"));
    expect(state.structure.total_chapters_planned).toBe(12);
    expect(state.structure.total_volumes).toBe(1);
  });

  it("scope=book 对待展开状态重提（3A 调整路径）：storylines 以第二次提交集为准，arc_meta 不受影响", async () => {
    const { ctx, db } = createProject();
    const first = await submitBookScopeOutline(ctx);
    expect(first.ok).toBe(true);

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const { volumes: _volumes, ...book } = base;
    const storylines = (book.storylines as Array<Record<string, unknown>>).filter(
      (sl) => sl.id !== "SL-rival",
    );
    storylines[0] = { ...storylines[0], name: "作者改过的主线名" };
    const rescoped = { ...book, storylines };

    const result = (await novelSubmitOutline(
      { phase: 1, scope: "book", payload: rescoped },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);

    const sls = db
      .prepare("SELECT id, name FROM storylines WHERE novel_id = ? ORDER BY id")
      .all("novel-test") as Array<{ id: string; name: string }>;
    expect(sls.map((s) => s.id)).toEqual(["SL-growth", "SL-main"]);
    expect(sls.find((s) => s.id === "SL-main")?.name).toBe("作者改过的主线名");

    const arcRow = db
      .prepare("SELECT COUNT(*) AS n FROM arc_meta WHERE novel_id = ?")
      .get("novel-test") as { n: number };
    expect(arcRow.n).toBe(0);
  });

  it("伏笔注册表重提交不清理旧行（有意保留 planted_chapter 语义）", async () => {
    const { ctx, db } = createProject();
    const first = await submitValidOutline(ctx);
    expect(first.ok).toBe(true);

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const trimmed = {
      ...base,
      foreshadowing_registry: (
        base.foreshadowing_registry as Array<Record<string, unknown>>
      ).filter((fs) => fs.id !== "S-HERB"),
    };

    const result = (await novelSubmitOutline(
      { phase: 1, payload: trimmed },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);

    const rows = db
      .prepare("SELECT id FROM foreshadowing_registry WHERE novel_id = ? ORDER BY id")
      .all("novel-test") as Array<{ id: string }>;
    // 本次提交少了 S-HERB，但注册表仍保留三条——伏笔不参与重提交清理
    expect(rows.map((r) => r.id)).toEqual(["F-SWORD-CORE", "F-TRAITOR", "S-HERB"]);
  });
});

describe("novel_submit_outline · 已写结构身份门（issue #450）", () => {
  function writeChapterSummary(db: Database.Database, novelId: string, chapter: number): void {
    db.prepare(
      `INSERT INTO chapter_summaries (id, novel_id, chapter, summary) VALUES (?, ?, ?, ?)`,
    ).run(`sum-${novelId}-${chapter}`, novelId, chapter, `第${chapter}章摘要`);
  }

  function writeStorylineFocus(
    db: Database.Database,
    novelId: string,
    chapter: number,
    storylineId: string,
  ): void {
    db.prepare(
      `INSERT INTO chapter_storyline_focus (novel_id, chapter, storyline_id) VALUES (?, ?, ?)`,
    ).run(novelId, chapter, storylineId);
  }

  it("full 重提交删掉区间含已写章的 arc → 拒绝，DB 零变化", async () => {
    const { ctx, db } = createProject();
    const first = await submitValidOutline(ctx);
    expect(first.ok).toBe(true);
    // V01-A01 覆盖第 1-12 章，第 5 章已写入章摘要
    writeChapterSummary(db, "novel-test", 5);

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const [vol1] = base.volumes as Array<Record<string, unknown>>;
    const [, arc2] = vol1.arc_list as Array<Record<string, unknown>>;
    // 重提交只留 V01-A02，删掉已写的 V01-A01
    const shrunkPayload = { ...base, volumes: [{ ...vol1, arc_list: [arc2] }] };

    const result = (await novelSubmitOutline(
      { phase: 1, payload: shrunkPayload },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    const errors = result.errors as Array<{ field: string; hint: string }>;
    expect(errors.some((e) => e.field.includes("V01-A01"))).toBe(true);
    expect(errors.some((e) => e.hint.includes("保留原 arc_id"))).toBe(true);

    // DB 零变化：两个 arc 仍在
    const arcs = db
      .prepare("SELECT arc_id FROM arc_meta WHERE novel_id = ? ORDER BY arc_id")
      .all("novel-test") as Array<{ arc_id: string }>;
    expect(arcs.map((a) => a.arc_id)).toEqual(["V01-A01", "V01-A02"]);
  });

  it("同 arc 保 id 只改 chapter_end 等字段 → 通过", async () => {
    const { ctx, db } = createProject();
    const first = await submitValidOutline(ctx);
    expect(first.ok).toBe(true);
    writeChapterSummary(db, "novel-test", 5);

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const [vol1] = base.volumes as Array<Record<string, unknown>>;
    const [arc1, arc2] = vol1.arc_list as Array<Record<string, unknown>>;
    // arc_id 不变，只改核心问题字段
    const editedPayload = {
      ...base,
      volumes: [
        { ...vol1, arc_list: [{ ...arc1, core_question: "林晚能否洗清污名？" }, arc2] },
      ],
    };

    const result = (await novelSubmitOutline(
      { phase: 1, payload: editedPayload },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    const arc = db
      .prepare("SELECT core_question FROM arc_meta WHERE novel_id = ? AND arc_id = ?")
      .get("novel-test", "V01-A01") as { core_question: string };
    expect(arc.core_question).toBe("林晚能否洗清污名？");
  });

  it("删掉纯未写区间的 arc → 通过（#448 既有缩卷用例已覆盖，见「full 重提交卷数变少」）", async () => {
    const { ctx } = createProject();
    const twoVolResult = await submitTwoVolumeOutline(ctx);
    expect(twoVolResult.ok).toBe(true);
    // 无任何 chapter_summaries 写入——两个 arc 区间均未写

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const [vol1] = base.volumes as Array<Record<string, unknown>>;
    const [arc1] = vol1.arc_list as Array<Record<string, unknown>>;
    const shrunkPayload = { ...base, volumes: [{ ...vol1, arc_list: [arc1] }] };

    const result = (await novelSubmitOutline(
      { phase: 1, payload: shrunkPayload },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });

  it("被已写章 chapter_storyline_focus 引用的故事线从提交集消失 → 拒绝，hint 引导 status 收线/蛰伏", async () => {
    const { ctx, db } = createProject();
    const first = await submitValidOutline(ctx);
    expect(first.ok).toBe(true);
    writeChapterSummary(db, "novel-test", 4);
    writeStorylineFocus(db, "novel-test", 4, "SL-rival");

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const storylines = (base.storylines as Array<Record<string, unknown>>).filter(
      (sl) => sl.id !== "SL-rival",
    );
    const payload = { ...base, storylines };

    const result = (await novelSubmitOutline({ phase: 1, payload }, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.ok).toBe(false);
    const errors = result.errors as Array<{ field: string; hint: string }>;
    expect(errors.some((e) => e.field.includes("SL-rival"))).toBe(true);
    expect(
      errors.some((e) => e.hint.includes("resolved") && e.hint.includes("dormant")),
    ).toBe(true);

    // DB 零变化：SL-rival 仍在
    const sls = db
      .prepare("SELECT id FROM storylines WHERE novel_id = ? ORDER BY id")
      .all("novel-test") as Array<{ id: string }>;
    expect(sls.map((s) => s.id)).toContain("SL-rival");
  });

  it("无已写引用的故事线删除 → 通过（#448 既有用例已覆盖，见「scope=book 对待展开状态重提」）", async () => {
    const { ctx, db } = createProject();
    const first = await submitValidOutline(ctx);
    expect(first.ok).toBe(true);
    // SL-rival 无任何 chapter_storyline_focus 引用

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const storylines = (base.storylines as Array<Record<string, unknown>>).filter(
      (sl) => sl.id !== "SL-rival",
    );
    const payload = { ...base, storylines };

    const result = (await novelSubmitOutline({ phase: 1, payload }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(true);
    const sls = db
      .prepare("SELECT id FROM storylines WHERE novel_id = ? ORDER BY id")
      .all("novel-test") as Array<{ id: string }>;
    expect(sls.map((s) => s.id)).not.toContain("SL-rival");
  });

  it("仅存 arc 摘要（无任何章摘要）的 arc 从提交集消失 → 拒绝（PR#451 评审 P1）", async () => {
    const { ctx, db } = createProject();
    const first = await submitValidOutline(ctx);
    expect(first.ok).toBe(true);
    // 不插任何 chapter_summaries——只插 V01-A01 的弧摘要（consolidate 不要求章摘要存在）
    db.prepare(
      `INSERT INTO arc_summaries (novel_id, scope, scope_id, chapter_start, chapter_end, summary)
       VALUES ('novel-test', 'arc', 'V01-A01', 1, 12, '药圃失窃案收束：林晚被逐出药圃调入剑冢。')`,
    ).run();

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const [vol1] = base.volumes as Array<Record<string, unknown>>;
    const [, arc2] = vol1.arc_list as Array<Record<string, unknown>>;
    const shrunkPayload = { ...base, volumes: [{ ...vol1, arc_list: [arc2] }] };

    const result = (await novelSubmitOutline(
      { phase: 1, payload: shrunkPayload },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    const errors = result.errors as Array<{ field: string }>;
    expect(errors.some((e) => e.field.includes("V01-A01"))).toBe(true);
    const arcs = db
      .prepare("SELECT arc_id FROM arc_meta WHERE novel_id = ? ORDER BY arc_id")
      .all("novel-test") as Array<{ arc_id: string }>;
    expect(arcs.map((a) => a.arc_id)).toEqual(["V01-A01", "V01-A02"]);
  });

  it("已存卷摘要的卷从提交集消失 → 拒绝（PR#451 评审 P1 卷级变体）", async () => {
    const { ctx, db } = createProject();
    const twoVolResult = await submitTwoVolumeOutline(ctx);
    expect(twoVolResult.ok).toBe(true);
    // 只插第 2 卷卷摘要（无任何章摘要；V02-A01 也无弧摘要——单独验证卷门）
    db.prepare(
      `INSERT INTO arc_summaries (novel_id, scope, scope_id, chapter_start, chapter_end, summary)
       VALUES ('novel-test', 'volume', 'vol-02', 13, 24, '第二卷收束：玉符现世，师徒决裂。')`,
    ).run();

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const [vol1] = base.volumes as Array<Record<string, unknown>>;
    const [arc1] = vol1.arc_list as Array<Record<string, unknown>>;
    const shrunkPayload = { ...base, volumes: [{ ...vol1, arc_list: [arc1] }] };

    const result = (await novelSubmitOutline(
      { phase: 1, payload: shrunkPayload },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    const errors = result.errors as Array<{ field: string; hint: string }>;
    expect(errors.some((e) => e.field.includes("vol-02"))).toBe(true);
    expect(errors.some((e) => e.hint.includes("卷摘要"))).toBe(true);
    // DB 零变化：两卷的 arc 仍在
    const arcs = db
      .prepare("SELECT arc_id FROM arc_meta WHERE novel_id = ? ORDER BY arc_id")
      .all("novel-test") as Array<{ arc_id: string }>;
    expect(arcs.map((a) => a.arc_id)).toEqual(["V01-A01", "V02-A01"]);
  });

  it("scope=book 重提（volumes 空）不触发剧情弧门", async () => {
    const { ctx, db } = createProject();
    const first = await submitBookScopeOutline(ctx);
    expect(first.ok).toBe(true);
    // 书级待展开：arc_meta 恒为空，无从触发剧情弧门

    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const { volumes: _volumes, ...book } = base;
    const result = (await novelSubmitOutline(
      { phase: 1, scope: "book", payload: book },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    const arcRow = db
      .prepare("SELECT COUNT(*) AS n FROM arc_meta WHERE novel_id = ?")
      .get("novel-test") as { n: number };
    expect(arcRow.n).toBe(0);
  });
});

describe("novel_submit_premise（地基卡定点修订 facts 同步）", () => {
  const PREMISE_PAYLOAD = {
    cards: [
      {
        card: "central_dramatic_question",
        fields: [{ key: "question", value: "林晚能否在不变成仇人的前提下复仇？" }],
      },
      {
        card: "protagonist_desire",
        fields: [
          { key: "surface_want", value: "夺回被夺走的灵根、亲手了结仇人" },
          { key: "deep_need", value: "承认复仇填不上失去家人的空洞" },
        ],
      },
      {
        card: "antagonistic_force",
        fields: [{ key: "force", value: "掌控吞噬功法的宗门长老会" }],
      },
      {
        // 全量立项必须含合法叙述人称（#297）——facts 同步测试以此为完整前置
        card: "narrator_voice",
        fields: [
          { key: "archetype", value: "冷峻说书人" },
          { key: "address", value: "third_limited" },
        ],
      },
    ],
  };

  function engineFacts(db: Database.Database): Record<string, string> {
    const rows = db
      .prepare("SELECT predicate, object FROM facts WHERE novel_id = ? AND subject = '全书'")
      .all("novel-test") as Array<{ predicate: string; object: string }>;
    return Object.fromEntries(rows.map((r) => [r.predicate, r.object]));
  }

  it("sync_engine_facts=true 把四项重叠内容写入 subject='全书' facts", async () => {
    const { ctx, db } = createProject();

    const result = (await novelSubmitPremise(
      { payload: PREMISE_PAYLOAD, sync_engine_facts: true },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.synced_engine_facts).toEqual([
      "central_dramatic_question",
      "protagonist_core_desire",
      "protagonist_core_lack",
      "antagonistic_force",
    ]);

    expect(engineFacts(db)).toEqual({
      central_dramatic_question: "林晚能否在不变成仇人的前提下复仇？",
      protagonist_core_desire: "夺回被夺走的灵根、亲手了结仇人",
      protagonist_core_lack: "承认复仇填不上失去家人的空洞",
      antagonistic_force: "掌控吞噬功法的宗门长老会",
    });

    const sources = (
      db
        .prepare("SELECT source FROM facts WHERE novel_id = ? AND subject = '全书'")
        .all("novel-test") as Array<{ source: string }>
    ).map((r) => r.source);
    expect(sources).toEqual(["authored", "authored", "authored", "authored"]); // 立项卡同步的引擎字段须显式 source='authored'
  });

  it("默认（不传 sync_engine_facts）不触碰任何 facts", async () => {
    const { ctx, db } = createProject();

    const result = (await novelSubmitPremise({ payload: PREMISE_PAYLOAD }, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.ok).toBe(true);
    expect(result.synced_engine_facts).toBeUndefined();
    expect(engineFacts(db)).toEqual({});
  });

  it("open / 空值字段跳过，不覆盖既有 fact", async () => {
    const { ctx, db } = createProject();

    const result = (await novelSubmitPremise(
      {
        payload: {
          cards: [
            {
              card: "central_dramatic_question",
              fields: [{ key: "question", value: "未定方向", certainty: "open" }],
            },
            {
              card: "protagonist_desire",
              fields: [
                { key: "surface_want", value: "夺回灵根" },
                { key: "deep_need", value: "   " },
              ],
            },
            {
              // 全量立项必须含合法叙述人称（#297）
              card: "narrator_voice",
              fields: [{ key: "address", value: "third_limited" }],
            },
          ],
        },
        sync_engine_facts: true,
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    // open 的 central_dramatic_question 与空白 deep_need 都跳过，只同步 surface_want
    expect(result.synced_engine_facts).toEqual(["protagonist_core_desire"]);
    expect(engineFacts(db)).toEqual({ protagonist_core_desire: "夺回灵根" });
  });

  it("再次提交以新值覆盖同谓词（删旧插新，每谓词单条）", async () => {
    const { ctx, db } = createProject();

    await novelSubmitPremise({ payload: PREMISE_PAYLOAD, sync_engine_facts: true }, ctx);
    await novelSubmitPremise(
      {
        payload: {
          cards: [
            {
              card: "antagonistic_force",
              fields: [{ key: "force", value: "改判后的对抗力量：旧友执掌的审判庭" }],
            },
          ],
        },
        merge_cards: true,
        sync_engine_facts: true,
      },
      ctx,
    );

    const rows = db
      .prepare(
        "SELECT object FROM facts WHERE novel_id = ? AND subject = '全书' AND predicate = 'antagonistic_force'",
      )
      .all("novel-test") as Array<{ object: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].object).toBe("改判后的对抗力量：旧友执掌的审判庭");
  });

  it("merge_cards=true 只提交目标卡时合并、保留其余立项卡", async () => {
    const { ctx, root } = createProject();

    await novelSubmitPremise({ payload: PREMISE_PAYLOAD }, ctx);
    const result = (await novelSubmitPremise(
      {
        payload: {
          cards: [{ card: "antagonistic_force", fields: [{ key: "force", value: "审判庭" }] }],
        },
        merge_cards: true,
        sync_engine_facts: true,
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    const stored = JSON.parse(readFileSync(join(root, "bible", "premise-cards.json"), "utf-8")) as {
      cards: Array<{ card: string; fields: Array<{ key: string; value: string }> }>;
    };
    // 其余卡仍在（central_dramatic_question / protagonist_desire / narrator_voice 未被丢弃），antagonistic_force 取新值
    expect(stored.cards.map((c) => c.card).sort()).toEqual([
      "antagonistic_force",
      "central_dramatic_question",
      "narrator_voice",
      "protagonist_desire",
    ]);
    expect(stored.cards.find((c) => c.card === "antagonistic_force")?.fields[0].value).toBe("审判庭");
    expect(stored.cards.find((c) => c.card === "central_dramatic_question")?.fields[0].value).toBe(
      "林晚能否在不变成仇人的前提下复仇？",
    );
  });

  it("sync 回灌 outline-structure.json 与 master-outline.md 的重叠字段", async () => {
    const { ctx, root } = createProject();
    await submitValidOutline(ctx); // 先有大纲（写 outline-structure.json + master-outline.md）

    await novelSubmitPremise(
      {
        payload: {
          cards: [{ card: "central_dramatic_question", fields: [{ key: "question", value: "改后的中心问题：复仇还是放下？" }] }],
        },
        merge_cards: true,
        sync_engine_facts: true,
      },
      ctx,
    );

    const structure = JSON.parse(
      readFileSync(join(root, "outline", "outline-structure.json"), "utf-8"),
    ) as { central_dramatic_question: string };
    expect(structure.central_dramatic_question).toBe("改后的中心问题：复仇还是放下？");

    const master = readFileSync(join(root, "outline", "master-outline.md"), "utf-8");
    expect(master).toContain("改后的中心问题：复仇还是放下？");
  });
});

describe("novel_submit_premise · 叙述人称受控校验", () => {
  const withNarrator = (addressField: Record<string, unknown> | null) => ({
    cards: [
      { card: "core_hook", fields: [{ key: "hook", value: "黄金三章承诺一场吞噬复仇" }] },
      {
        card: "narrator_voice",
        fields: [
          { key: "archetype", value: "冷峻说书人" },
          ...(addressField ? [addressField] : []),
        ],
      },
    ],
  });

  it("全量立项：narrator_voice 缺 address 被拒并给修复 hint", async () => {
    const { ctx } = createProject();
    const result = (await novelSubmitPremise({ payload: withNarrator(null) }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(false);
    const errors = result.errors as Array<{ field: string; hint: string }>;
    expect(errors[0].field).toBe("narrator_voice.address");
    expect(errors[0].hint).toContain("first_person");
  });

  it("全量立项：address 非受控值被拒", async () => {
    const { ctx } = createProject();
    const result = (await novelSubmitPremise(
      { payload: withNarrator({ key: "address", value: "第三人称" }) },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("全量立项：合法 address 通过入库", async () => {
    const { ctx } = createProject();
    const result = (await novelSubmitPremise(
      { payload: withNarrator({ key: "address", value: "third_limited" }) },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });

  it("merge_cards=true：缺 address 豁免（不惩罚存量未填人称的小说）", async () => {
    const { ctx } = createProject();
    const result = (await novelSubmitPremise(
      { payload: withNarrator(null), merge_cards: true },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });

  it("merge_cards=true：提交非法 address 仍被拒（受控值域不被修订路径架空，审核 High）", async () => {
    const { ctx } = createProject();
    const result = (await novelSubmitPremise(
      { payload: withNarrator({ key: "address", value: "第三人称" }), merge_cards: true },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    const errors = result.errors as Array<{ field: string }>;
    expect(errors[0].field).toBe("narrator_voice.address");
  });

  it("merge_cards=true：提交合法 address 通过（/revise-premise 改人称的正路）", async () => {
    const { ctx } = createProject();
    const result = (await novelSubmitPremise(
      { payload: withNarrator({ key: "address", value: "multi_pov" }), merge_cards: true },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });
});

describe("大纲契约 backfill", () => {
  it("从多表聚合重建缺失的 outline-structure.json（书级，幂等跳过存量章 DTO）", async () => {
    const { ctx, root } = createProject();
    await submitValidOutline(ctx);

    // 模拟存量项目：删掉 submit 落的 json（DB 多表数据仍在）
    const jsonPath = join(root, "outline", "outline-structure.json");
    expect(existsSync(jsonPath)).toBe(true);
    rmSync(jsonPath);

    await backfillOutlineArtifacts(ctx);

    expect(existsSync(jsonPath)).toBe(true);
    const payload = JSON.parse(readFileSync(jsonPath, "utf-8")) as Record<string, any>;

    // 引擎 5 字段从 facts(subject='全书') 重建
    expect(payload.central_dramatic_question).toContain("林晚能否在宗门覆灭前");
    expect(payload.protagonist_core_desire).toContain("重铸断剑");
    expect(payload.stakes_progression).toContain("卷1失去同门信任");

    // 故事线按 priority 排序，可选字段按存在性带出
    expect(payload.storylines.map((s: any) => s.id)).toEqual(["SL-main", "SL-growth", "SL-rival"]);
    expect(payload.storylines[0].planned_payoff_chapter).toBe(60);
    expect(payload.storylines[1].planned_payoff_chapter).toBeUndefined();

    // 伏笔注册表（ORDER BY id）
    expect(payload.foreshadowing_registry.map((f: any) => f.id)).toEqual([
      "F-SWORD-CORE",
      "F-TRAITOR",
      "S-HERB",
    ]);
    expect(payload.foreshadowing_registry.find((f: any) => f.id === "F-TRAITOR").theme_link).toContain(
      "内奸身份",
    );

    // 卷/arc：标题 DB 无 → 合成「第 N 卷」、dilemma_milestone 省略、arc 全字段保真
    expect(payload.volumes).toHaveLength(1);
    expect(payload.volumes[0].volume_no).toBe(1);
    expect(payload.volumes[0].title).toBe("第 1 卷");
    expect(payload.volumes[0].dilemma_milestone).toBeUndefined();
    expect(payload.volumes[0].arc_list.map((a: any) => a.arc_id)).toEqual(["V01-A01", "V01-A02"]);
    expect(payload.volumes[0].arc_list[0].payoff_beats).toEqual(["face_slap", "level_up"]);
    expect(payload.volumes[0].arc_list[1].core_question).toContain("取出剑芯玉符");
  });

  it("已存在 outline-structure.json 时不覆盖（幂等）", async () => {
    const { ctx, root } = createProject();
    await submitValidOutline(ctx);

    const jsonPath = join(root, "outline", "outline-structure.json");
    writeFileSync(jsonPath, '{"sentinel":true}\n');
    await backfillOutlineArtifacts(ctx);

    expect(JSON.parse(readFileSync(jsonPath, "utf-8"))).toEqual({ sentinel: true });
  });

  it("无 arc_meta（未提交大纲）时不写文件", async () => {
    const { ctx, root } = createProject();
    await backfillOutlineArtifacts(ctx);
    expect(existsSync(join(root, "outline", "outline-structure.json"))).toBe(false);
  });
});

describe("novel_submit_chapter_outline", () => {
  it("渲染章纲文件（首行 App 锚点）并写故事线聚焦与伏笔计划", async () => {
    const { ctx, root, db } = createProject();
    await submitValidOutline(ctx);

    const result = (await novelSubmitChapterOutline(
      { payload: loadFixture("chapter-outline-v5-valid-batch.json") },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.chapters).toEqual([1, 2]);

    const ch1 = readFileSync(join(root, "outline", "vol-01", "ch-001.md"), "utf-8");
    expect(ch1.split("\n")[0]).toBe("# 第1章 血参不见了");
    expect(ch1).toContain("## 本章定位");
    expect(ch1).toContain("- 视角人物: 林晚");
    expect(ch1).toContain("- 出场角色: 林晚、赵伯");
    expect(ch1).toContain("## 场景骨架");
    // 第1章 fixture 未标 payoff_beat：渲染不出现「本章爽点」行
    expect(ch1).not.toContain("- 本章爽点:");

    // 第2章 fixture 标了 payoff_beat=reveal：渲染出中文标签 + 英文枚举，喂给写手
    const ch2 = readFileSync(join(root, "outline", "vol-01", "ch-002.md"), "utf-8");
    expect(ch2).toContain("- 本章爽点: 真相揭示（reveal）");

    const focus = db
      .prepare(
        "SELECT storyline_id FROM chapter_storyline_focus WHERE novel_id = ? AND chapter = 2 ORDER BY storyline_id",
      )
      .all("novel-test") as Array<{ storyline_id: string }>;
    expect(focus.map((f) => f.storyline_id)).toEqual(["SL-growth", "SL-main"]);

    const planned = db
      .prepare(
        "SELECT foreshadowing_id, action FROM foreshadowing_actions_log WHERE novel_id = ? AND status = 'planned' ORDER BY chapter",
      )
      .all("novel-test") as Array<{ foreshadowing_id: string; action: string }>;
    expect(planned).toEqual([
      { foreshadowing_id: "S-HERB", action: "plant" },
      { foreshadowing_id: "F-SWORD-CORE", action: "plant" },
    ]);
  });

  // 开局留存门控按「完整开局 arc」判（已落盘 ∪ 本批），兼容 /plan 窗口化分批提交
  const openingBase = () =>
    (loadFixture("chapter-outline-v5-valid-batch.json") as Record<string, unknown>[])[0];
  const mkCh = (chapter: number, beat?: string): Record<string, unknown> => {
    const c = JSON.parse(JSON.stringify(openingBase())) as Record<string, unknown>;
    c.chapter = chapter;
    c.foreshadowing_touch = [];
    if (beat) c.payoff_beat = beat;
    else delete c.payoff_beat;
    return c;
  };

  it("黄金三章（ch1-3）齐全且 payoff_beat 全空 → 阻断（ok:false，开局 payoff_beat 错误）", async () => {
    const { ctx } = createProject();
    await submitValidOutline(ctx);
    const result = (await novelSubmitChapterOutline(
      { payload: [mkCh(1), mkCh(2), mkCh(3)] },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.errors)).toContain("开局 payoff_beat");
  });

  it("续跑补章：ch1-2 已落盘(ch2=reveal)、本批只补 ch3 无爽点 → 合并后不误判阻断（P1）", async () => {
    const { ctx } = createProject();
    await submitValidOutline(ctx);
    // 先落盘 ch1(空)/ch2(reveal)；ch3 未规划 → 黄金三章未齐 → defer 不阻断
    const first = (await novelSubmitChapterOutline(
      { payload: loadFixture("chapter-outline-v5-valid-batch.json") },
      ctx,
    )) as Record<string, unknown>;
    expect(first.ok).toBe(true);
    // 续跑只补 ch3（无爽点）；合并落盘 ch1-2(ch2 有 reveal) → 黄金三章齐且有 1 爽点 → 不误判
    const result = (await novelSubmitChapterOutline({ payload: [mkCh(3)] }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(true);
  });

  it("跨窗口死区：批1(ch1 有爽点/ch2-4 空) + 批2(ch5-8 空，单批≤5) → 合并 ch2-8 死区被抓 WARN（P1）", async () => {
    const { ctx } = createProject();
    await submitValidOutline(ctx);
    const b1 = (await novelSubmitChapterOutline(
      { payload: [mkCh(1, "level_up"), mkCh(2), mkCh(3), mkCh(4)] },
      ctx,
    )) as Record<string, unknown>;
    expect(b1.ok).toBe(true);
    expect(JSON.stringify(b1.warnings)).not.toContain("死区"); // ch2-4=3 连续，单批不告警
    // 批2 ch5-8 单批仅 4 连续空（≤5），但合并落盘 ch1-4 后 ch2-8=7 连续 >5
    const b2 = (await novelSubmitChapterOutline(
      { payload: [mkCh(5), mkCh(6), mkCh(7), mkCh(8)] },
      ctx,
    )) as Record<string, unknown>;
    expect(b2.ok).toBe(true);
    expect(JSON.stringify(b2.warnings)).toContain("死区");
  });

  it("章号未被任何 arc 覆盖时报错", async () => {
    const { ctx } = createProject();
    // 未提交书级大纲 → 无 arc 覆盖
    const result = (await novelSubmitChapterOutline(
      { payload: loadFixture("chapter-outline-v5-valid-batch.json") },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("散文含机器 token（positioning 写 face_slap）→ 阻断并返洁净门 hint", async () => {
    const { ctx } = createProject();
    await submitValidOutline(ctx);
    const dirty = JSON.parse(JSON.stringify(openingBase())) as Record<string, unknown>;
    dirty.positioning = "arc 闭合章，face_slap + reveal 双 payoff 兑现";
    const result = (await novelSubmitChapterOutline(
      { payload: [dirty] },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.errors)).toContain("机器 token");
  });

  it("散文含破折号 —— → 阻断", async () => {
    const { ctx } = createProject();
    await submitValidOutline(ctx);
    const dirty = JSON.parse(JSON.stringify(openingBase())) as Record<string, unknown>;
    (dirty.beats as string[])[0] = "苏见进阁——陆昭已在";
    const result = (await novelSubmitChapterOutline(
      { payload: [dirty] },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.errors)).toContain("——");
  });

  // 章末钩节奏门（checkHookCadence 接线）：章号平移到 5-8（避开黄金三章 ch1-3，
  // 否则触发开局 payoff_beat 门控 ERROR、与本组用例语义无关）
  const mkHookCh = (chapter: number, end_hook?: string): Record<string, unknown> => ({
    chapter,
    title: `第${chapter}章`,
    positioning: "剧情中段推进章节",
    beats: ["入场压力", "升级", "收尾"],
    storyline_focus: ["SL-main"],
    characters: [{ character_uid: CHAR_UID["林晚"], name: "林晚" }],
    pov_character: { character_uid: CHAR_UID["林晚"], name: "林晚" },
    ...(end_hook ? { end_hook } : {}),
  });

  it("checkHookCadence 接线：本批 3 连显式 none → warnings 含成片死区告警", async () => {
    const { ctx } = createProject();
    await submitValidOutline(ctx);
    const result = (await novelSubmitChapterOutline(
      { payload: [mkHookCh(5, "none"), mkHookCh(6, "none"), mkHookCh(7, "none")] },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true); // WARN 不阻断
    expect((result.warnings as string[]).some((w) => w.includes("连续 3 章"))).toBe(true);
  });

  it("checkHookCadence 跨批窗口：先落盘 ch5-6 显式 none，再单提 ch7=none → 合并出 3 连告警", async () => {
    const { ctx } = createProject();
    await submitValidOutline(ctx);
    await novelSubmitChapterOutline(
      { payload: [mkHookCh(5, "none"), mkHookCh(6, "none")] },
      ctx,
    );
    const b2 = (await novelSubmitChapterOutline({ payload: [mkHookCh(7, "none")] }, ctx)) as Record<
      string,
      unknown
    >;
    expect((b2.warnings as string[]).some((w) => w.includes("连续 3 章"))).toBe(true);
  });

  it("checkHookCadence 存量兼容：落盘章无 end_hook 字段（老数据）邻接本批 → 不误报连续死区", async () => {
    const { ctx } = createProject();
    await submitValidOutline(ctx);
    await novelSubmitChapterOutline({ payload: [mkHookCh(5), mkHookCh(6)] }, ctx); // 模拟老数据
    const b2 = (await novelSubmitChapterOutline(
      { payload: [mkHookCh(7, "none"), mkHookCh(8, "none")] },
      ctx,
    )) as Record<string, unknown>;
    expect((b2.warnings as string[]).filter((w) => w.includes("连续")).length).toBe(0);
  });

  it("checkHookCadence 跨卷合并窗口：卷1末章落盘 none + 卷2前两章本批 none → 合并出跨卷 3 连告警", async () => {
    const { ctx, root } = createProject();
    const book = await submitTwoVolumeOutline(ctx);
    expect(book.ok).toBe(true);

    // 批1：提交卷1末章（第12章，属 V01-A01=1-12）end_hook=none，落盘到 outline/vol-01/ch-012.json
    const b1 = (await novelSubmitChapterOutline(
      { payload: [mkHookCh(12, "none")] },
      ctx,
    )) as Record<string, unknown>;
    expect(b1.ok).toBe(true);
    expect(existsSync(join(root, "outline", "vol-01", "ch-012.json"))).toBe(true);

    // 批2：提交卷2前两章（第13-14章，属 V02-A01=13-24）均 end_hook=none——本批自身只 2 连，
    // 须靠 handler 用 chapterArcIndex 跨卷读到 vol-01/ch-012.json 才能拼出 12-14 三连
    const b2 = (await novelSubmitChapterOutline(
      { payload: [mkHookCh(13, "none"), mkHookCh(14, "none")] },
      ctx,
    )) as Record<string, unknown>;
    expect(b2.ok).toBe(true);
    expect((b2.warnings as string[]).some((w) => w.includes("连续 3 章"))).toBe(true);
  });

  // 网格对标尺（issue #428）：benchmark_note 独立字段触发/不触发
  it("benchmark_note：样本不足（<20章）时不追加该字段", async () => {
    const { ctx } = createProject();
    await submitValidOutline(ctx);
    const result = (await novelSubmitChapterOutline(
      { payload: [mkHookCh(5, "danger"), mkHookCh(6, "danger")] },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.benchmark_note).toBeUndefined();
  });

  it("benchmark_note：达到最小样本量(24章覆盖全书两个 arc)时追加独立字段，不混进 warnings", async () => {
    const { ctx } = createProject();
    await submitValidOutline(ctx);
    const payload: Record<string, unknown>[] = [];
    for (let c = 1; c <= 24; c += 1) {
      const beat = c === 1 ? "level_up" : c % 4 === 0 ? "reveal" : undefined;
      const hook = c % 3 === 0 ? "none" : "danger";
      payload.push({ ...mkHookCh(c, hook), ...(beat ? { payoff_beat: beat } : {}) });
    }
    const result = (await novelSubmitChapterOutline({ payload }, ctx)) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.chapters).toHaveLength(24);
    expect(typeof result.benchmark_note).toBe("string");
    expect(result.benchmark_note as string).toContain("仅供参考，不影响提交");
    // 独立字段，不混进既有 warnings 数组
    expect((result.warnings as string[]).includes(result.benchmark_note as string)).toBe(false);
  });

});

describe("novel_commit_chapter", () => {
  it("字数守卫：收尾时低于目标 70% → 返回 word_count_warning 并在 message 标注（不阻断）", async () => {
    const { ctx, root } = createProject();
    for (const n of ["林晚", "执事", "沈决", "赵伯"]) writeCharacter(root, n);
    await submitValidOutline(ctx);
    // 默认测试正文 ~843 纯文字，远低于 3000 目标的 70%
    writeManuscript(root, 2);

    const result = (await novelCommitChapter(
      loadFixture("commit-chapter-v5-valid.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.word_count_warning).toMatchObject({ target: 3000 });
    expect(result.message as string).toContain("低于字数目标");
  });

  it("字数守卫：收尾权威字数按可见正文计，chapter_metadata 注释不计入", async () => {
    const { ctx, root } = createProject();
    for (const n of ["林晚", "执事", "沈决", "赵伯"]) writeCharacter(root, n);
    await submitValidOutline(ctx);
    const metadata = `<!-- chapter_metadata: {"note": "${"备注".repeat(200)}"} -->`;
    writeManuscript(root, 2, `# 第2章\n\n${"字".repeat(900)}\n\n${metadata}\n`);

    const result = (await novelCommitChapter(
      loadFixture("commit-chapter-v5-valid.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.word_count).toBe(903);
    expect((result.word_count_warning as { actual: number }).actual).toBe(903);
  });

  it("机械补全字数与片段、登记伏笔动作、写 receipt", async () => {
    const { ctx, root, db } = createProject();
    for (const n of ["林晚", "执事", "沈决", "赵伯"]) writeCharacter(root, n);
    await submitValidOutline(ctx);
    writeManuscript(root, 2);

    const result = (await novelCommitChapter(
      loadFixture("commit-chapter-v5-valid.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.word_count).toBeGreaterThan(100);

    const row = db
      .prepare("SELECT * FROM chapter_summaries WHERE novel_id = ? AND chapter = 2")
      .get("novel-test") as Record<string, unknown>;
    expect(row.anchor_core).toContain("被放逐到绝路");
    expect(row.opening_snippet).toBeTruthy();
    expect(row.ending_snippet).toBeTruthy();

    const actions = db
      .prepare(
        "SELECT action, status FROM foreshadowing_actions_log WHERE novel_id = ? AND foreshadowing_id = 'F-SWORD-CORE' AND chapter = 2",
      )
      .all("novel-test") as Array<{ action: string; status: string }>;
    expect(actions).toEqual([{ action: "plant", status: "realized" }]);

    expect(existsSync(join(root, ".narracat", "receipts", "ch-002.json"))).toBe(true);
  });

  it("正文文件缺失时拒绝提交", async () => {
    const { ctx } = createProject();
    await submitValidOutline(ctx);

    const result = (await novelCommitChapter(
      loadFixture("commit-chapter-v5-valid.json"),
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("缺 anchor 时被 ajv 拒绝", async () => {
    const { ctx, root } = createProject();
    await submitValidOutline(ctx);
    writeManuscript(root, 2);

    const result = (await novelCommitChapter(
      loadFixture("commit-chapter-v5-invalid-missing-anchor.json"),
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("已有更早兑现 plant 时本次 plant 矫正为 develop", async () => {
    const { ctx, root, db } = createProject();
    for (const n of ["林晚", "执事", "沈决", "赵伯"]) writeCharacter(root, n);
    await submitValidOutline(ctx);
    writeManuscript(root, 2);
    db.prepare(
      `INSERT INTO foreshadowing_actions_log (novel_id, chapter, foreshadowing_id, action, status)
       VALUES ('novel-test', 1, 'F-SWORD-CORE', 'plant', 'realized')`,
    ).run();

    const result = (await novelCommitChapter(
      loadFixture("commit-chapter-v5-valid.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.lifecycle_guards).toMatchObject([
      { guard: "duplicate_foreshadowing_plant_coerced", coerced_to: "develop" },
    ]);
    const actions = db
      .prepare(
        "SELECT action FROM foreshadowing_actions_log WHERE novel_id = ? AND foreshadowing_id = 'F-SWORD-CORE' AND chapter = 2",
      )
      .all("novel-test") as Array<{ action: string }>;
    expect(actions).toEqual([{ action: "develop" }]);
  });

  it("出场角色未建档（缺 character_uid）时拒绝提交", async () => {
    const { ctx, root } = createProject();
    writeCharacter(root, "林晚"); // 仅建林晚，fixture 其余角色无 character_identity
    await submitValidOutline(ctx);
    writeManuscript(root, 2);
    const result = (await novelCommitChapter(
      loadFixture("commit-chapter-v5-valid.json"),
      ctx,
    )) as Record<string, unknown>;
    // 未建档角色是常态（新角色随剧情登场，建档是另一条流程），不该拖累整章收尾：
    // 与同文件 checkChapterWordCount 一致走「finding-only，只标不阻断」。
    expect(result.ok).toBe(true);
    expect(result.skipped_characters).toEqual(
      expect.arrayContaining([expect.stringContaining("赵伯")]),
    );
    // 已建档的那个照常入库，被跳过的不计入
    expect((result.checklist as Record<string, unknown>).characters_appeared).toBe(1);
    expect(String(result.message)).toContain("未建档");
  });
});

describe("novel_submit_extraction", () => {
  it("relationship 一端未建档时跳过该条并点名，其余事实照常入库（不再整单驳回）", async () => {
    const { ctx, root } = createProject();
    writeCharacter(root, "林晚"); // 赵伯无档案
    const result = (await novelSubmitExtraction(
      {
        chapter: 1,
        facts: [{ subject: "林晚", predicate: "status", object: "肩上有伤", change_type: "new" }],
        relationship_updates: [{ a: "赵伯", b: "林晚", state: "愧疚照拂" }],
      },
      ctx,
    )) as Record<string, unknown>;
    // 整单驳回换来的唯一结果是 agent 剔除后重发整份清单——白跑一轮，还诱发丢字段。
    expect(result.ok).toBe(true);
    expect(result.facts_stored).toBe(1);
    // 被跳过的关系必须点名，否则就成了静默丢数据
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("赵伯")]),
    );
    expect(result.relationships_updated).toBe(0);
  });

  it("relationship 两端都已建档时照常折算入库（跳过逻辑不误伤正常关系）", async () => {
    const { ctx, root } = createProject();
    writeCharacter(root, "林晚");
    writeCharacter(root, "赵伯");
    const result = (await novelSubmitExtraction(
      { chapter: 1, facts: [], relationship_updates: [{ a: "赵伯", b: "林晚", state: "愧疚照拂" }] },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.facts_stored).toBe(1);
    expect(result.relationships_updated).toBe(1);
  });

  it("受控谓词入库 + 别名归一 + relationship 字典序归一", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚", "晚晚、小晚");
    writeCharacter(root, "赵伯");

    const result = (await novelSubmitExtraction(
      {
        chapter: 2,
        facts: [
          {
            subject: "晚晚",
            predicate: "injury",
            object: "右掌被断剑割伤",
            change_type: "new",
          },
          {
            subject: "林晚",
            predicate: "x-bloodline",
            object: "血液能引动断剑共鸣",
            change_type: "new",
          },
        ],
        relationship_updates: [{ a: "赵伯", b: "林晚", state: "愧疚中暗暗照拂" }],
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.facts_stored).toBe(3);
    const warnings = result.warnings as string[];
    expect(warnings.some((w) => w.includes("x-bloodline"))).toBe(true);

    const injury = db
      .prepare(
        "SELECT subject FROM facts WHERE novel_id = ? AND predicate = 'injury'",
      )
      .get("novel-test") as { subject: string };
    expect(injury.subject).toBe("林晚");

    const rel = db
      .prepare(
        "SELECT subject, object FROM facts WHERE novel_id = ? AND predicate = 'relationship'",
      )
      .get("novel-test") as { subject: string; object: string };
    expect(rel.subject).toBe("林晚|赵伯");
    expect(rel.object).toBe("愧疚中暗暗照拂");
  });

  it("update 失效旧值并立新值（invalidated_at_chapter 单一记账）", async () => {
    const { ctx, db } = createProject();

    await novelSubmitExtraction(
      {
        chapter: 1,
        facts: [
          { subject: "林晚", predicate: "location", object: "杂役峰药圃", change_type: "new" },
        ],
      },
      ctx,
    );
    const result = (await novelSubmitExtraction(
      {
        chapter: 2,
        facts: [
          { subject: "林晚", predicate: "location", object: "剑冢偏院", change_type: "update" },
        ],
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.facts_invalidated).toBe(1);

    const rows = db
      .prepare(
        "SELECT object, invalidated_at_chapter FROM facts WHERE novel_id = ? AND predicate = 'location' ORDER BY from_chapter",
      )
      .all("novel-test") as Array<{ object: string; invalidated_at_chapter: number | null }>;
    expect(rows).toEqual([
      { object: "杂役峰药圃", invalidated_at_chapter: 2 },
      { object: "剑冢偏院", invalidated_at_chapter: null },
    ]);
  });

  it("词表外谓词被 ajv 拒绝", async () => {
    const { ctx } = createProject();
    const result = (await novelSubmitExtraction(
      loadFixture("memory-extraction-v5-invalid-predicate.json"),
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("重构后 submit 行为零变化：facts 入库且不写暂存表", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚");
    const result = (await novelSubmitExtraction(
      {
        chapter: 3,
        facts: [
          { subject: "林晚", predicate: "location", object: "剑冢", change_type: "new" },
        ],
      },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.facts_stored).toBe(1);
    const factCount = db
      .prepare("SELECT COUNT(*) AS n FROM facts WHERE novel_id = ?")
      .get("novel-test") as { n: number };
    expect(factCount.n).toBe(1);
    const stageCount = db
      .prepare("SELECT COUNT(*) AS n FROM extraction_stage WHERE novel_id = ?")
      .get("novel-test") as { n: number };
    expect(stageCount.n).toBe(0);
  });
});

function factCount(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM facts WHERE novel_id = ?").get("novel-test") as {
      n: number;
    }
  ).n;
}

function stageCount(db: Database.Database, chapter?: number, runId?: number): number {
  let sql = "SELECT COUNT(*) AS n FROM extraction_stage WHERE novel_id = ?";
  const params: unknown[] = ["novel-test"];
  if (chapter !== undefined) {
    sql += " AND chapter = ?";
    params.push(chapter);
  }
  if (runId !== undefined) {
    sql += " AND run_id = ?";
    params.push(runId);
  }
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

describe("novel_stage_extraction", () => {
  it("校验通过后写入 extraction_stage，不写 facts 表", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚");
    const result = (await novelStageExtraction(
      {
        chapter: 1,
        run_id: 1,
        facts: [{ subject: "林晚", predicate: "location", object: "剑冢", change_type: "new" }],
      },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.staged).toBe(1);
    expect(stageCount(db, 1, 1)).toBe(1);
    expect(factCount(db)).toBe(0);
  });

  it("run_id 违 minimum/maximum 返回错误，不写任何暂存行", async () => {
    const { ctx, db } = createProject();
    const result = (await novelStageExtraction(
      { chapter: 1, run_id: 0, facts: [] },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(stageCount(db)).toBe(0);
  });

  it("同一 run_id 重复暂存：upsert 覆盖、仅一行、保留最新（重试/恢复幂等）", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚");
    await novelStageExtraction(
      { chapter: 5, run_id: 1, facts: [{ subject: "林晚", predicate: "location", object: "旧地", change_type: "new" }] },
      ctx,
    );
    await novelStageExtraction(
      { chapter: 5, run_id: 1, facts: [{ subject: "林晚", predicate: "location", object: "新地", change_type: "new" }] },
      ctx,
    );
    expect(stageCount(db, 5, 1)).toBe(1); // 未留陈旧行
    await novelCommitExtractionUnion({ chapter: 5 }, ctx);
    const objs = (
      db
        .prepare("SELECT object FROM facts WHERE novel_id = ? AND predicate = 'location'")
        .all("novel-test") as Array<{ object: string }>
    ).map((r) => r.object);
    expect(objs).toContain("新地");
    expect(objs).not.toContain("旧地"); // 旧行被 upsert 覆盖，不会混入并集
  });
});

describe("novel_commit_extraction_union", () => {
  it("全等去重：跨轮同义条目只落一条", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚");
    const fact = { subject: "林晚", predicate: "location", object: "剑冢", change_type: "new" as const };
    for (const run_id of [1, 2, 3]) {
      await novelStageExtraction({ chapter: 1, run_id, facts: [fact] }, ctx);
    }
    const result = (await novelCommitExtractionUnion({ chapter: 1 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(true);
    expect(result.staged_runs).toBe(3);
    expect(result.facts_committed).toBe(1);
    expect(result.facts_deduped).toBe(2);
    expect(factCount(db)).toBe(1);
    expect(stageCount(db, 1)).toBe(0);
    const sources = (
      db.prepare("SELECT source FROM facts WHERE novel_id = ?").all("novel-test") as Array<{
        source: string;
      }>
    ).map((r) => r.source);
    expect(sources).toEqual(["extracted"]); // 抽取链路落库须显式 source='extracted'
  });

  it("并集覆盖各轮独有事实", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚");
    const A = { subject: "林晚", predicate: "location", object: "剑冢", change_type: "new" as const };
    const B = { subject: "林晚", predicate: "injury", object: "右掌割伤", change_type: "new" as const };
    const C = { subject: "林晚", predicate: "possession", object: "断剑", change_type: "new" as const };
    await novelStageExtraction({ chapter: 1, run_id: 1, facts: [A] }, ctx);
    await novelStageExtraction({ chapter: 1, run_id: 2, facts: [B] }, ctx);
    await novelStageExtraction({ chapter: 1, run_id: 3, facts: [A, B, C] }, ctx);
    const result = (await novelCommitExtractionUnion({ chapter: 1 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.facts_committed).toBe(3);
    // 总候选 5 条（1+1+3），并集 3 条 → 去重 2
    expect(result.facts_deduped).toBe(2);
    const objects = (
      db
        .prepare("SELECT object FROM facts WHERE novel_id = ? ORDER BY predicate")
        .all("novel-test") as Array<{ object: string }>
    ).map((r) => r.object);
    expect(objects.sort()).toEqual(["右掌割伤", "剑冢", "断剑"].sort());
  });

  it("change_type 冲突取更强信号 invalidate > update > new", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚");
    // 先有一条旧 location（commit-union 的 invalidate 才有命中目标）
    await novelSubmitExtraction(
      { chapter: 1, facts: [{ subject: "林晚", predicate: "location", object: "杂役峰", change_type: "new" }] },
      ctx,
    );
    const tri = { subject: "林晚", predicate: "location", object: "杂役峰" };
    await novelStageExtraction({ chapter: 2, run_id: 1, facts: [{ ...tri, change_type: "new" }] }, ctx);
    await novelStageExtraction({ chapter: 2, run_id: 2, facts: [{ ...tri, change_type: "update" }] }, ctx);
    await novelStageExtraction({ chapter: 2, run_id: 3, facts: [{ ...tri, change_type: "invalidate" }] }, ctx);
    const result = (await novelCommitExtractionUnion({ chapter: 2 }, ctx)) as Record<
      string,
      unknown
    >;
    // 取 invalidate：旧事实被失效、不新增
    expect(result.facts_invalidated).toBe(1);
    expect(result.facts_committed).toBe(0);
    const row = db
      .prepare(
        "SELECT invalidated_at_chapter FROM facts WHERE novel_id = ? AND predicate = 'location'",
      )
      .get("novel-test") as { invalidated_at_chapter: number | null };
    expect(row.invalidated_at_chapter).toBe(2);
  });

  it("暂存清空：同章第二次 commit 返回 staged_runs=0 / facts_committed=0（幂等）", async () => {
    const { ctx, root } = createProject();
    writeCharacter(root, "林晚");
    await novelStageExtraction(
      { chapter: 1, run_id: 1, facts: [{ subject: "林晚", predicate: "location", object: "剑冢", change_type: "new" }] },
      ctx,
    );
    await novelCommitExtractionUnion({ chapter: 1 }, ctx);
    const second = (await novelCommitExtractionUnion({ chapter: 1 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(second.ok).toBe(true);
    expect(second.staged_runs).toBe(0);
    expect(second.facts_committed).toBe(0);
  });

  it("stage 不污染正式 facts：commit 前 facts 表空，commit 后非空", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚");
    for (const run_id of [1, 2, 3]) {
      await novelStageExtraction(
        { chapter: 1, run_id, facts: [{ subject: "林晚", predicate: "location", object: "剑冢", change_type: "new" }] },
        ctx,
      );
    }
    expect(factCount(db)).toBe(0);
    await novelCommitExtractionUnion({ chapter: 1 }, ctx);
    expect(factCount(db)).toBeGreaterThan(0);
  });

  it("不同角色对共享 A 端 + 同关系态：两条 relationship 事实都保留，不被去重误并", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚");
    writeCharacter(root, "赵伯");
    writeCharacter(root, "沈决");
    // 林晚 字典序最小 → 两对的 subject_character_uid 同为林晚 uid、object 同为"战友"；
    // 若去重 key 用 subject_character_uid 会碰撞丢一条，用完整 subject（"林晚|赵伯" vs "林晚|沈决"）才区分两端
    await novelStageExtraction(
      {
        chapter: 1,
        run_id: 1,
        facts: [],
        relationship_updates: [
          { a: "林晚", b: "赵伯", state: "战友" },
          { a: "林晚", b: "沈决", state: "战友" },
        ],
      },
      ctx,
    );
    const result = (await novelCommitExtractionUnion({ chapter: 1 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(true);
    expect(result.facts_committed).toBe(2);
    expect(result.facts_deduped).toBe(0);
    const subjects = (
      db
        .prepare(
          "SELECT subject FROM facts WHERE novel_id = ? AND predicate = 'relationship' ORDER BY subject",
        )
        .all("novel-test") as Array<{ subject: string }>
    ).map((r) => r.subject);
    expect(subjects).toEqual(["林晚|沈决", "林晚|赵伯"]);
  });

  it("无暂存时 commit 返回 staged_runs=0 并给出警告（供写循环判定抽取失败），不写 facts", async () => {
    const { ctx, db } = createProject();
    const result = (await novelCommitExtractionUnion({ chapter: 7 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(true);
    expect(result.staged_runs).toBe(0);
    expect(result.facts_committed).toBe(0);
    expect(result.facts_invalidated).toBe(0);
    expect(result.facts_deduped).toBe(0);
    // 关键：0 暂存必须给出可被写循环识别的警告，而非静默成功
    expect((result.warnings as string[]).some((w) => w.includes("无任何暂存事实"))).toBe(true);
    expect(factCount(db)).toBe(0);
  });
});

describe("审校契约 backfill", () => {
  it("DB 行带指纹、报告文件缺失 → 重灌的 JSON 含同值指纹", async () => {
    const { ctx, root, db } = createProject();
    writeManuscript(root, 2);
    await novelSubmitReview({ chapter: 2, issues: [] }, ctx);
    const sha = (
      db
        .prepare(
          "SELECT reviewed_manuscript_sha256 AS sha FROM chapter_reviews WHERE novel_id = ? AND chapter = 2",
        )
        .get("novel-test") as { sha: string }
    ).sha;
    expect(sha).toBeTruthy();

    const reportPath = join(root, "reviews", "ch-002-review.json");
    rmSync(reportPath);

    await backfillReviewArtifacts(ctx);

    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as Record<string, unknown>;
    expect(report.reviewed_manuscript_sha256).toBe(sha);
  });

  it("老库无指纹行 → 重灌的 JSON 不带该字段（不编造指纹）", async () => {
    const { ctx, root, db } = createProject();
    db.prepare(
      `INSERT INTO chapter_reviews (novel_id, chapter, verdict, issues_json, reviewed_manuscript_sha256)
       VALUES ('novel-test', 3, 'pass', '[]', NULL)`,
    ).run();

    await backfillReviewArtifacts(ctx);

    const report = JSON.parse(
      readFileSync(join(root, "reviews", "ch-003-review.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(report.verdict).toBe("pass");
    expect("reviewed_manuscript_sha256" in report).toBe(false);
  });
});

describe("记忆写入门：审校新鲜度前置", () => {
  /** 建正文 + 提交 pass 审校，使指纹绑定当前正文 */
  async function passReview(ctx: ToolContext, root: string, chapter: number): Promise<void> {
    writeManuscript(root, chapter);
    await novelSubmitReview({ chapter, issues: [] }, ctx);
  }

  const EXTRACTION_ARGS = {
    chapter: 2,
    facts: [{ subject: "林晚", predicate: "location", object: "剑冢偏院", change_type: "new" }],
  };

  function reviewFreshnessRejected(result: Record<string, unknown>): boolean {
    if (result.ok !== false) return false;
    const errors = result.errors as Array<{ field: string }>;
    return errors.some((e) => e.field === "review_freshness");
  }

  it("novel_commit_chapter：审校 PASS 后正文被篡改 → 拒绝", async () => {
    const { ctx, root } = createProject();
    for (const n of ["林晚", "执事", "沈决", "赵伯"]) writeCharacter(root, n);
    await submitValidOutline(ctx);
    await passReview(ctx, root, 2);
    writeManuscript(root, 2, `# 第2章\n\n${"改".repeat(2500)}\n`); // 审校后篡改

    const result = (await novelCommitChapter(
      loadFixture("commit-chapter-v5-valid.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(reviewFreshnessRejected(result)).toBe(true);
  });

  it("novel_commit_chapter：审校 PASS 且正文未改 → 放行", async () => {
    const { ctx, root } = createProject();
    for (const n of ["林晚", "执事", "沈决", "赵伯"]) writeCharacter(root, n);
    await submitValidOutline(ctx);
    await passReview(ctx, root, 2);

    const result = (await novelCommitChapter(
      loadFixture("commit-chapter-v5-valid.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
  });

  it("novel_submit_extraction：审校 PASS 后正文被篡改 → 拒绝", async () => {
    const { ctx, root } = createProject();
    writeCharacter(root, "林晚");
    await passReview(ctx, root, 2);
    writeManuscript(root, 2, `# 第2章\n\n${"改".repeat(2500)}\n`);

    const result = (await novelSubmitExtraction(EXTRACTION_ARGS, ctx)) as Record<string, unknown>;

    expect(reviewFreshnessRejected(result)).toBe(true);
  });

  it("novel_commit_extraction_union：审校 PASS 后正文被篡改 → 拒绝", async () => {
    const { ctx, root } = createProject();
    writeCharacter(root, "林晚");
    await passReview(ctx, root, 2);
    await novelStageExtraction({ ...EXTRACTION_ARGS, run_id: 1 }, ctx);
    writeManuscript(root, 2, `# 第2章\n\n${"改".repeat(2500)}\n`);

    const result = (await novelCommitExtractionUnion({ chapter: 2 }, ctx)) as Record<
      string,
      unknown
    >;

    expect(reviewFreshnessRejected(result)).toBe(true);
  });

  it("novel_stage_extraction 不设门：暂存不出现在消费面，篡改后仍可暂存", async () => {
    const { ctx, root } = createProject();
    writeCharacter(root, "林晚");
    await passReview(ctx, root, 2);
    writeManuscript(root, 2, `# 第2章\n\n${"改".repeat(2500)}\n`);

    const result = (await novelStageExtraction({ ...EXTRACTION_ARGS, run_id: 1 }, ctx)) as Record<
      string,
      unknown
    >;

    expect(result.ok).toBe(true);
  });

  it("无审校记录 → 放行（回滚后重建链路不被自己的门锁死）", async () => {
    const { ctx, root } = createProject();
    writeCharacter(root, "林晚");
    writeManuscript(root, 2, `# 第2章\n\n${"字".repeat(2500)}\n`); // 无任何审校

    const result = (await novelSubmitExtraction(EXTRACTION_ARGS, ctx)) as Record<string, unknown>;

    expect(result.ok).toBe(true);
  });

  it("回滚清审校后：DB 行与报告文件均消失，重新提取放行", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚");
    await passReview(ctx, root, 2);
    expect(existsSync(join(root, "reviews", "ch-002-review.json"))).toBe(true);

    await novelRollbackChapter({ chapter: 2 }, ctx);

    const reviews = db
      .prepare("SELECT COUNT(*) AS c FROM chapter_reviews WHERE novel_id = ? AND chapter >= 2")
      .get("novel-test") as { c: number };
    expect(reviews.c).toBe(0);
    expect(existsSync(join(root, "reviews", "ch-002-review.json"))).toBe(false);

    // 作者手改正文后重抽：无审校记录，门放行
    writeManuscript(root, 2, `# 第2章\n\n${"作者改过的正文".repeat(300)}\n`);
    const result = (await novelSubmitExtraction(EXTRACTION_ARGS, ctx)) as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });
});

describe("记忆入口合同门", () => {
  const SHORT_STAGING_BODY = `# 第2章\n\n${"字".repeat(100)}。\n`; // 远低于默认下限 2400

  function writeStaging(root: string, chapter: number, content: string): void {
    mkdirSync(join(root, ".narracat", "staging"), { recursive: true });
    writeFileSync(stagingManuscriptPath(root, chapter), content, "utf-8");
  }

  function contractRejected(result: Record<string, unknown>): boolean {
    if (result.ok !== false) return false;
    const errors = result.errors as Array<{ field: string }>;
    return errors.some((e) => e.field === "manuscript_contract");
  }

  it("staging 字数不足时 novel_commit_chapter / novel_submit_extraction / novel_commit_extraction_union 均拒绝", async () => {
    const { ctx, root } = createProject();
    for (const n of ["林晚", "执事", "沈决", "赵伯"]) writeCharacter(root, n);
    await submitValidOutline(ctx);
    writeStaging(root, 2, SHORT_STAGING_BODY);

    const commitResult = (await novelCommitChapter(
      loadFixture("commit-chapter-v5-valid.json"),
      ctx,
    )) as Record<string, unknown>;
    expect(contractRejected(commitResult)).toBe(true);

    const extractionResult = (await novelSubmitExtraction(
      { chapter: 2, facts: [] },
      ctx,
    )) as Record<string, unknown>;
    expect(contractRejected(extractionResult)).toBe(true);

    const unionResult = (await novelCommitExtractionUnion({ chapter: 2 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(contractRejected(unionResult)).toBe(true);
  });

  it("无 staging 时三入口不因合同报错（老书回归）", async () => {
    const { ctx, root } = createProject();
    for (const n of ["林晚", "执事", "沈决", "赵伯"]) writeCharacter(root, n);
    await submitValidOutline(ctx);
    writeManuscript(root, 2); // 直接写正式路径，无 staging

    const commitResult = (await novelCommitChapter(
      loadFixture("commit-chapter-v5-valid.json"),
      ctx,
    )) as Record<string, unknown>;
    expect(commitResult.ok).toBe(true);

    const extractionResult = (await novelSubmitExtraction(
      { chapter: 3, facts: [{ subject: "林晚", predicate: "location", object: "剑冢", change_type: "new" }] },
      ctx,
    )) as Record<string, unknown>;
    expect(extractionResult.ok).toBe(true);

    await novelStageExtraction(
      { chapter: 4, run_id: 1, facts: [{ subject: "林晚", predicate: "location", object: "剑冢", change_type: "new" }] },
      ctx,
    );
    const unionResult = (await novelCommitExtractionUnion({ chapter: 4 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(unionResult.ok).toBe(true);
  });
});

describe("novel_submit_review", () => {
  it("blocker → fail，落结构化 JSON 契约 + 入库", async () => {
    const { ctx, root, db } = createProject();

    const result = (await novelSubmitReview(
      loadFixture("review-report-v5-valid-fail-blocker.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.verdict).toBe("fail");

    const report = JSON.parse(
      readFileSync(join(root, "reviews", "ch-002-review.json"), "utf-8"),
    ) as { chapter: number; verdict: string; issues: Array<{ severity: string }> };
    expect(report.chapter).toBe(2);
    expect(report.verdict).toBe("fail");
    expect(report.issues.some((i) => i.severity === "blocker")).toBe(true);

    const row = db
      .prepare("SELECT verdict FROM chapter_reviews WHERE novel_id = ? AND chapter = 2")
      .get("novel-test") as { verdict: string };
    expect(row.verdict).toBe("fail");
  });

  it("空 issues → pass，JSON 契约 verdict=pass、issues 为空", async () => {
    const { ctx, root } = createProject();

    const result = (await novelSubmitReview(
      loadFixture("review-report-v5-valid-pass.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.verdict).toBe("pass");
    const report = JSON.parse(
      readFileSync(join(root, "reviews", "ch-002-review.json"), "utf-8"),
    ) as { verdict: string; issues: unknown[] };
    expect(report.verdict).toBe("pass");
    expect(report.issues).toHaveLength(0);
  });

  it("缺 fix_hint 被 ajv 拒绝", async () => {
    const { ctx } = createProject();
    const result = (await novelSubmitReview(
      loadFixture("review-report-v5-invalid-missing-fix-hint.json"),
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("字数守卫：成稿低于目标 70% → 报告顶层落 word_count_warning（不混入 issues，verdict 不受影响）", async () => {
    const { ctx, root } = createProject();
    // 1800 纯文字 + 标题 3 字 = 1803 / 3000 = 60.1% < 70%
    writeManuscript(root, 2, `# 第2章\n\n${"字".repeat(1800)}\n`);

    const result = (await novelSubmitReview(
      loadFixture("review-report-v5-valid-pass.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.verdict).toBe("pass");
    expect(result.word_count).toBe(1803);
    expect(result.word_count_warning).toMatchObject({ actual: 1803, target: 3000 });

    const report = JSON.parse(
      readFileSync(join(root, "reviews", "ch-002-review.json"), "utf-8"),
    ) as { verdict: string; issues: unknown[]; word_count: number; word_count_warning: { actual: number; target: number } };
    expect(report.verdict).toBe("pass");
    // 机械度量不是「存疑」判断：issues 保持纯 continuity-editor 产出
    expect(report.issues).toHaveLength(0);
    expect(report.word_count).toBe(1803);
    expect(report.word_count_warning).toMatchObject({ actual: 1803, target: 3000 });
    expect(result.message as string).toContain("字数缺口");
  });

  it("字数守卫：chapter_metadata 注释不计入正文——元数据把总数抬过阈值也照样告警", async () => {
    const { ctx, root } = createProject();
    // 可见正文 1900+3 字（63.4% < 70%），元数据注释含大量可数文字把全文总数抬到 ≥2100
    const metadata = `<!-- chapter_metadata: {"planned_state_changes": "${"备注".repeat(200)}"} -->`;
    writeManuscript(root, 2, `# 第2章\n\n${"字".repeat(1900)}\n\n${metadata}\n`);

    const result = (await novelSubmitReview(
      loadFixture("review-report-v5-valid-pass.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.word_count).toBe(1903);
    expect(result.word_count_warning).toMatchObject({ actual: 1903, target: 3000 });
  });

  it("字数守卫：达标成稿无 warning，报告仍落实际字数", async () => {
    const { ctx, root } = createProject();
    writeManuscript(root, 2, `# 第2章\n\n${"字".repeat(2500)}\n`);

    const result = (await novelSubmitReview(
      loadFixture("review-report-v5-valid-pass.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.word_count).toBe(2503);
    expect(result.word_count_warning).toBeUndefined();
    const report = JSON.parse(
      readFileSync(join(root, "reviews", "ch-002-review.json"), "utf-8"),
    ) as { issues: unknown[]; word_count: number; word_count_warning?: unknown };
    expect(report.issues).toHaveLength(0);
    expect(report.word_count).toBe(2503);
    expect(report.word_count_warning).toBeUndefined();
  });

  it("字数守卫：正文缺失时静默跳过（不给审校提交新增失败模式）", async () => {
    const { ctx } = createProject();
    const result = (await novelSubmitReview(
      loadFixture("review-report-v5-valid-pass.json"),
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.word_count).toBeUndefined();
    expect(result.word_count_warning).toBeUndefined();
  });

  it("提交审校时落正文指纹：report JSON 与 chapter_reviews 均为当前正文 SHA-256", async () => {
    const { ctx, root, db } = createProject();
    const content = `# 第2章\n\n${"字".repeat(2500)}\n`;
    writeManuscript(root, 2, content);
    const expectedHash = createHash("sha256").update(content, "utf8").digest("hex");

    const result = (await novelSubmitReview(
      loadFixture("review-report-v5-valid-pass.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    const report = JSON.parse(
      readFileSync(join(root, "reviews", "ch-002-review.json"), "utf-8"),
    ) as { reviewed_manuscript_sha256?: string };
    expect(report.reviewed_manuscript_sha256).toBe(expectedHash);

    const row = db
      .prepare(
        "SELECT reviewed_manuscript_sha256 FROM chapter_reviews WHERE novel_id = ? AND chapter = 2",
      )
      .get("novel-test") as { reviewed_manuscript_sha256: string };
    expect(row.reviewed_manuscript_sha256).toBe(expectedHash);
  });

  it("正文缺失时不落指纹（report 无字段、DB 列为 NULL），提交不报错", async () => {
    const { ctx, root, db } = createProject();

    const result = (await novelSubmitReview(
      loadFixture("review-report-v5-valid-pass.json"),
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    const report = JSON.parse(
      readFileSync(join(root, "reviews", "ch-002-review.json"), "utf-8"),
    ) as { reviewed_manuscript_sha256?: string };
    expect(report.reviewed_manuscript_sha256).toBeUndefined();

    const row = db
      .prepare(
        "SELECT reviewed_manuscript_sha256 FROM chapter_reviews WHERE novel_id = ? AND chapter = 2",
      )
      .get("novel-test") as { reviewed_manuscript_sha256: string | null };
    expect(row.reviewed_manuscript_sha256).toBeNull();
  });
});

describe("novel_consolidate", () => {
  it("upsert 温层摘要并机械刷新区间内角色卡", async () => {
    const { ctx, root, db } = createProject();
    await submitValidOutline(ctx);
    const linwanUid = "11111111-1111-4111-8111-111111111111";
    writeFileSync(
      join(root, "bible", "characters", "林晚.md"),
      `<!-- character_identity: {"character_uid":"${linwanUid}","name":"林晚"} -->\n# 林晚\n`,
    );
    db.prepare(
      `INSERT INTO chapter_summaries (id, novel_id, chapter, summary, characters, events)
       VALUES ('s1', 'novel-test', 1, '第1章摘要', ?, '[]')`,
    ).run(JSON.stringify([{ character_uid: linwanUid, name: "林晚" }]));
    await novelSubmitExtraction(
      {
        chapter: 1,
        facts: [
          { subject: "林晚", predicate: "status", object: "被逐出药圃", change_type: "new" },
        ],
      },
      ctx,
    );

    const summary = "林晚在药圃失窃案中被当众搜出参须，赵伯作保失败。".repeat(8);
    const result = (await novelConsolidate(
      { scope: "arc", scope_id: "V01-A01", summary },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.chapter_start).toBe(1);
    expect(result.chapter_end).toBe(12);
    expect(result.character_cards_refreshed).toEqual(["林晚"]);

    const card = db
      .prepare("SELECT card_json FROM character_cards WHERE novel_id = ? AND character_uid = ?")
      .get("novel-test", linwanUid) as { card_json: string };
    expect(JSON.parse(card.card_json)).toMatchObject({ status: "被逐出药圃" });
  });

  it("scope_id 不存在时给出可用 arc 清单 hint", async () => {
    const { ctx } = createProject();
    const result = (await novelConsolidate(
      { scope: "arc", scope_id: "V09-A99", summary: "x".repeat(200) },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });
});

describe("novel_register_foreshadowing", () => {
  it("补登伏笔；重复登记保留既有埋设章号", async () => {
    const { ctx, db } = createProject();

    const first = (await novelRegisterForeshadowing(
      {
        id: "F-CELLAR",
        type: "medium",
        description: "地窖入口",
        planted_chapter: 1,
        target_reveal: "8",
      },
      ctx,
    )) as Record<string, unknown>;
    expect(first.ok).toBe(true);

    const second = (await novelRegisterForeshadowing(
      {
        id: "F-CELLAR",
        type: "medium",
        description: "地窖入口被再次提到",
        planted_chapter: 5,
        target_reveal: "vol-02",
      },
      ctx,
    )) as Record<string, unknown>;

    expect(second.lifecycle_guard).toMatchObject({
      guard: "existing_foreshadowing_register_preserved",
      existing_planted_chapter: 1,
    });
    const row = db
      .prepare("SELECT planted_chapter, target_reveal FROM foreshadowing_registry WHERE id = 'F-CELLAR'")
      .get() as { planted_chapter: number; target_reveal: string };
    expect(row.planted_chapter).toBe(1);
    expect(row.target_reveal).toBe("vol-02");
  });
});

describe("novel_rollback_chapter", () => {
  it("删除该章及之后的记忆并恢复被失效的旧事实", async () => {
    const { ctx, root, db } = createProject();
    await submitValidOutline(ctx);
    writeManuscript(root, 2);
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
    await novelStageExtraction(
      {
        chapter: 2,
        run_id: 1,
        facts: [
          { subject: "林晚", predicate: "location", object: "剑冢偏院", change_type: "new" },
        ],
      },
      ctx,
    );
    await novelCommitChapter(loadFixture("commit-chapter-v5-valid.json"), ctx);
    await novelSubmitReview(loadFixture("review-report-v5-valid-pass.json"), ctx);

    expect(stageCount(db, 2)).toBe(1);

    const result = (await novelRollbackChapter({ chapter: 2 }, ctx)) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.restored_facts).toBe(1);

    expect(stageCount(db, 2)).toBe(0);

    const summaries = db
      .prepare("SELECT COUNT(*) AS c FROM chapter_summaries WHERE novel_id = ? AND chapter >= 2")
      .get("novel-test") as { c: number };
    expect(summaries.c).toBe(0);

    const location = db
      .prepare(
        "SELECT object, invalidated_at_chapter FROM facts WHERE novel_id = ? AND predicate = 'location'",
      )
      .all("novel-test") as Array<{ object: string; invalidated_at_chapter: number | null }>;
    expect(location).toEqual([{ object: "杂役峰药圃", invalidated_at_chapter: null }]);

    const reviews = db
      .prepare("SELECT COUNT(*) AS c FROM chapter_reviews WHERE novel_id = ? AND chapter >= 2")
      .get("novel-test") as { c: number };
    expect(reviews.c).toBe(0);

    expect(existsSync(join(root, ".narracat", "receipts", "ch-002.json"))).toBe(false);
    expect(existsSync(join(root, "reviews", "ch-002-review.json"))).toBe(false);
  });
});

describe("foreshadowing lifecycle audit（维护者诊断）", () => {
  it("报告重复 plant 动作与注册表埋设章冲突", () => {
    const { db } = createProject();
    db.prepare(
      `INSERT INTO foreshadowing_registry (novel_id, id, type, description, planted_chapter, target_reveal)
       VALUES ('novel-test', 'F-CELLAR', 'medium', '地窖入口', 5, '9')`,
    ).run();
    db.prepare(
      `INSERT INTO foreshadowing_actions_log (novel_id, chapter, foreshadowing_id, action, status)
       VALUES ('novel-test', 1, 'F-CELLAR', 'plant', 'realized')`,
    ).run();
    db.prepare(
      `INSERT INTO foreshadowing_actions_log (novel_id, chapter, foreshadowing_id, action, status)
       VALUES ('novel-test', 5, 'F-CELLAR', 'plant', 'realized')`,
    ).run();

    const report = auditForeshadowingLifecycle(db, "novel-test", {
      foreshadowingIds: ["F-CELLAR"],
    });

    expect(report.summary.duplicate_plant_actions).toBe(1);
    expect(report.summary.registry_planted_chapter_conflicts).toBe(1);

    const formatted = formatForeshadowingLifecycleAuditReport(report);
    expect(formatted).toContain("F-CELLAR");
    expect(formatted).toContain("chapters=1, 5");
  });
});

describe("novel_submit_dialogue_samples", () => {
  it("合法 samples 落库 + 别名归一到 character_uid", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚", "晚晚、小晚");

    const result = (await novelSubmitDialogueSamples(
      {
        chapter: 3,
        samples: [
          { character: "晚晚", dialogue_text: "你究竟是谁？", dialogue_type: "dialogue", emotion: "警惕" },
          { character: "林晚", dialogue_text: "这把剑认得我。", dialogue_type: "thought", position_in_chapter: 12 },
        ],
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.samples_stored).toBe(2);

    const rows = db
      .prepare(
        "SELECT character, character_uid, dialogue_text, dialogue_type FROM character_dialogue_samples WHERE novel_id = ? ORDER BY dialogue_text",
      )
      .all("novel-test") as Array<{
      character: string;
      character_uid: string;
      dialogue_text: string;
      dialogue_type: string;
    }>;
    expect(rows).toHaveLength(2);
    const aliasSample = rows.find((r) => r.dialogue_text === "你究竟是谁？")!;
    // 别名「晚晚」归一到「林晚」的 uid，character 列存归一后的显示名
    expect(aliasSample.character_uid).toBe(CHAR_UID["林晚"]);
    expect(aliasSample.character).toBe("林晚");
  });

  it("未解析到 character_uid 的样本计入 warnings 并跳过", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚");

    const result = (await novelSubmitDialogueSamples(
      {
        chapter: 3,
        samples: [
          { character: "林晚", dialogue_text: "我在。", dialogue_type: "dialogue" },
          { character: "神秘人", dialogue_text: "我们又见面了。", dialogue_type: "dialogue" },
        ],
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.samples_stored).toBe(1);
    const warnings = result.warnings as string[];
    expect(warnings.some((w) => w.includes("神秘人"))).toBe(true);

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM character_dialogue_samples WHERE novel_id = ?")
      .get("novel-test") as { c: number };
    expect(count.c).toBe(1);
  });

  it("非法 dialogue_type（不在枚举）返回 errors", async () => {
    const { ctx, root } = createProject();
    writeCharacter(root, "林晚");

    const result = (await novelSubmitDialogueSamples(
      {
        chapter: 3,
        samples: [{ character: "林晚", dialogue_text: "嗯。", dialogue_type: "screaming" }],
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    const errors = result.errors as Array<{ field: string }>;
    expect(errors.length).toBeGreaterThan(0);
  });

  it("同章同角色同台词重复提交 UNIQUE 去重，第二次 samples_stored=0", async () => {
    const { ctx, root, db } = createProject();
    writeCharacter(root, "林晚");
    const args = {
      chapter: 3,
      samples: [{ character: "林晚", dialogue_text: "我在。", dialogue_type: "dialogue" }],
    };

    const first = (await novelSubmitDialogueSamples(args, ctx)) as Record<string, unknown>;
    expect(first.samples_stored).toBe(1);
    const second = (await novelSubmitDialogueSamples(args, ctx)) as Record<string, unknown>;
    expect(second.ok).toBe(true);
    expect(second.samples_stored).toBe(0);

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM character_dialogue_samples WHERE novel_id = ?")
      .get("novel-test") as { c: number };
    expect(count.c).toBe(1);
  });
});

describe("validateOutlineBookPayload（书级段校验器）", () => {
  it("volumes 非必填：书级字段齐全即通过", () => {
    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const { volumes: _volumes, ...book } = base;
    expect(validateOutlineBookPayload(book).valid).toBe(true);
  });

  it("书级必填字段缺失仍拒绝", () => {
    const base = loadFixture<Record<string, unknown>>("outline-v5-valid-book.json");
    const { volumes: _volumes, storylines: _sl, ...missing } = base;
    expect(validateOutlineBookPayload(missing).valid).toBe(false);
  });
});

describe("novel_submit_chapter_outline · state_changes 计划表镜像（A4×D2 片3）", () => {
  const LIN_UID = "11111111-1111-4111-8111-111111111111";
  const VOCAB_JSON = {
    dimensions: [
      {
        key: "cultivation_level",
        predicate: "ability",
        display_name: "境界",
        cardinality: "one",
        value_type: "enum",
        values: ["练气", "筑基", "金丹"],
      },
      { key: "inventory", predicate: "possession", display_name: "持有物", cardinality: "many", value_type: "free" },
    ],
  };

  function withVocab(root: string): void {
    writeFileSync(join(root, "bible", "state-vocabulary.json"), JSON.stringify(VOCAB_JSON));
  }

  function batchWithChanges(changes: unknown[]): unknown {
    const batch = loadFixture<Array<Record<string, unknown>>>("chapter-outline-v5-valid-batch.json");
    batch[0].state_changes = changes;
    return batch;
  }

  const SET_LEVEL = {
    character: { character_uid: LIN_UID, name: "林晚" },
    dimension: "cultivation_level",
    value: "筑基",
    reason: "自证清白后突破",
  };

  it("首提镜像：planned 行入库（one 维度 operation 缺省落 set）+ md 渲染状态变更节", async () => {
    const { ctx, root, db } = createProject();
    withVocab(root);
    await submitValidOutline(ctx);

    const result = (await novelSubmitChapterOutline({ payload: batchWithChanges([SET_LEVEL]) }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(true);

    const rows = db
      .prepare(
        "SELECT chapter, character_uid, character_name, dimension, operation, value, reason, status FROM planned_state_changes WHERE novel_id = 'novel-test'",
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        chapter: 1,
        character_uid: LIN_UID,
        character_name: "林晚",
        dimension: "cultivation_level",
        operation: "set",
        value: "筑基",
        reason: "自证清白后突破",
        status: "planned",
      },
    ]);

    const ch1 = readFileSync(join(root, "outline", "vol-01", "ch-001.md"), "utf-8");
    expect(ch1).toContain("## 本章状态变更");
    expect(ch1).toContain("- 林晚: cultivation_level 变为「筑基」（自证清白后突破）");
  });

  it("重提交换集：planned 被新集替换；已处置行保留且同键不复活", async () => {
    const { ctx, root, db } = createProject();
    withVocab(root);
    await submitValidOutline(ctx);

    const first = (await novelSubmitChapterOutline({ payload: batchWithChanges([SET_LEVEL]) }, ctx)) as Record<
      string,
      unknown
    >;
    expect(first.ok).toBe(true);
    // 模拟已兑现处置
    db.prepare("UPDATE planned_state_changes SET status = 'delivered' WHERE novel_id = 'novel-test'").run();

    const ADD_ITEM = {
      character: { character_uid: LIN_UID, name: "林晚" },
      dimension: "inventory",
      operation: "add",
      value: "断剑",
    };
    // 新集 = 同键旧条目（已 delivered）+ 新条目
    const second = (await novelSubmitChapterOutline(
      { payload: batchWithChanges([SET_LEVEL, ADD_ITEM]) },
      ctx,
    )) as Record<string, unknown>;
    expect(second.ok).toBe(true);

    const rows = db
      .prepare(
        "SELECT dimension, operation, value, status FROM planned_state_changes WHERE novel_id = 'novel-test' ORDER BY dimension",
      )
      .all() as Array<Record<string, unknown>>;
    // delivered 历史账保留、同键不复活成新 planned；新条目正常入账
    expect(rows).toEqual([
      { dimension: "cultivation_level", operation: "set", value: "筑基", status: "delivered" },
      { dimension: "inventory", operation: "add", value: "断剑", status: "planned" },
    ]);
  });

  it("空数组合法：清空该章 planned 行", async () => {
    const { ctx, root, db } = createProject();
    withVocab(root);
    await submitValidOutline(ctx);
    await novelSubmitChapterOutline({ payload: batchWithChanges([SET_LEVEL]) }, ctx);
    const cleared = (await novelSubmitChapterOutline({ payload: batchWithChanges([]) }, ctx)) as Record<
      string,
      unknown
    >;
    expect(cleared.ok).toBe(true);
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM planned_state_changes WHERE novel_id = 'novel-test'")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("无词表带 state_changes → 整批拒绝（fail-loud）", async () => {
    const { ctx } = createProject();
    await submitValidOutline(ctx);
    const result = (await novelSubmitChapterOutline({ payload: batchWithChanges([SET_LEVEL]) }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.errors)).toContain("词表");
  });

  it("enum 值域外 → 拒绝并引导扩词表或纠值", async () => {
    const { ctx, root } = createProject();
    withVocab(root);
    await submitValidOutline(ctx);
    const result = (await novelSubmitChapterOutline(
      { payload: batchWithChanges([{ ...SET_LEVEL, value: "元婴" }]) },
      ctx,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.errors)).toContain("值域");
  });
});
