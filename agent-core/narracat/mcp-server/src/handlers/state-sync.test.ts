import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import Database from "better-sqlite3";
import { initSchema } from "../migrate.js";
import type { ToolContext } from "../types.js";
import {
  novelSyncStructure,
  novelUpdateProgress,
  novelRestoreProgress,
  novelCheckpoint,
  revertProgressToChapter,
  countWords,
  resolveWorkingManuscript,
  stagingManuscriptPath,
  checkManuscriptContract,
  novelCheckManuscriptContract,
  normalizeAsciiQuotesInChinese,
  normalizeCornerQuotesWhenSoleForm,
} from "./state-sync.js";
import { novelSubmitReview } from "./writers.js";

const BASE_STATE = [
  "progress:",
  "  last_completed_chapter: 0",
  "  completed_chapters: []",
  "  in_progress_chapter: null",
  "  total_chapters_planned: 0",
  "  chapters_outlined: []",
  "word_count:",
  "  total: 0",
  "  by_chapter: {}",
  "quality:",
  "  pending_reviews: []",
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

async function createProjectFixture(stateContent: string = BASE_STATE): Promise<{
  ctx: ToolContext;
  root: string;
  statePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "narracat-state-sync-"));
  await mkdir(join(root, ".narracat"), { recursive: true });
  const statePath = join(root, ".narracat", "state.yaml");
  await writeFile(statePath, stateContent, "utf-8");

  return {
    ctx: {
      novelId: "novel-test",
      db: null as unknown as ToolContext["db"],
      projectRoot: root,
    },
    root,
    statePath,
  };
}

function validArgs(): Record<string, unknown> {
  return {
    total_volumes: 2,
    total_chapters_planned: 5,
    chapter_to_volume: { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2 },
  };
}

describe("novel_sync_structure", () => {
  it("writes the structure section and preserves the other state sections", async () => {
    const { ctx, statePath } = await createProjectFixture();

    const result = (await novelSyncStructure(validArgs(), ctx)) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(result["mapped_chapters"]).toBe(5);

    const state = parse(await readFile(statePath, "utf-8"));
    expect(state.structure.total_volumes).toBe(2);
    expect(state.structure.total_chapters_planned).toBe(5);
    expect(state.structure.chapter_to_volume).toEqual({ 1: 1, 2: 1, 3: 1, 4: 2, 5: 2 });
    expect(state.progress.chapters_outlined).toEqual([]);
    expect(state.checkpoint.last_command).toBeNull();
    expect(state.quality.pending_reviews).toEqual([]);
  });

  it("emits a block map that round-trips through programmatic yaml parsing", async () => {
    const { ctx, statePath } = await createProjectFixture();

    await novelSyncStructure(validArgs(), ctx);

    const raw = await readFile(statePath, "utf-8");
    expect(raw).not.toContain("chapter_to_volume: {");
    expect(parse(raw).structure.chapter_to_volume[3]).toBe(1);
  });

  it("rejects a truncated map that misses planned chapters without writing", async () => {
    const { ctx, statePath } = await createProjectFixture();
    const before = await readFile(statePath, "utf-8");

    const result = (await novelSyncStructure(
      { ...validArgs(), chapter_to_volume: { 1: 1, 2: 1, 3: 1, 4: 2 } },
      ctx,
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    const errors = result["errors"] as Array<Record<string, unknown>>;
    expect(errors.some((error) => error["field"] === "chapter_to_volume")).toBe(true);
    expect(await readFile(statePath, "utf-8")).toBe(before);
  });

  it("rejects chapter keys beyond the declared total", async () => {
    const { ctx } = await createProjectFixture();

    const result = (await novelSyncStructure(
      { ...validArgs(), total_chapters_planned: 4 },
      ctx,
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
  });

  it("rejects volume values outside 1..total_volumes", async () => {
    const { ctx } = await createProjectFixture();

    const result = (await novelSyncStructure(
      { ...validArgs(), chapter_to_volume: { 1: 1, 2: 1, 3: 1, 4: 2, 5: 3 } },
      ctx,
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
  });

  it("rejects declared volumes that own no chapters", async () => {
    const { ctx } = await createProjectFixture();

    const result = (await novelSyncStructure(
      { ...validArgs(), total_volumes: 3 },
      ctx,
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    const errors = result["errors"] as Array<Record<string, unknown>>;
    expect(errors.some((error) => error["field"] === "total_volumes")).toBe(true);
  });

  it("rejects non-monotonic chapter-to-volume assignment", async () => {
    const { ctx } = await createProjectFixture();

    const result = (await novelSyncStructure(
      { ...validArgs(), chapter_to_volume: { 1: 1, 2: 2, 3: 1, 4: 2, 5: 2 } },
      ctx,
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
  });

  it("rejects non-integer scalar inputs with field-level errors", async () => {
    const { ctx } = await createProjectFixture();

    const result = (await novelSyncStructure(
      { total_volumes: "2", total_chapters_planned: 0, chapter_to_volume: [] },
      ctx,
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    const errors = result["errors"] as Array<Record<string, unknown>>;
    expect(errors.map((error) => error["field"])).toEqual(
      expect.arrayContaining(["total_volumes", "total_chapters_planned", "chapter_to_volume"]),
    );
  });

  it("returns an error when state.yaml is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "narracat-state-sync-missing-"));
    const ctx: ToolContext = {
      novelId: "novel-test",
      db: null as unknown as ToolContext["db"],
      projectRoot: root,
    };

    const result = (await novelSyncStructure(validArgs(), ctx)) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    const errors = result["errors"] as Array<Record<string, unknown>>;
    expect(String(errors[0]["hint"])).toContain("state.yaml");
  });
});

interface UpdateProgressFixture {
  ctx: ToolContext;
  root: string;
  statePath: string;
  db: Database.Database;
}

/** novel_update_progress 硬门需要真实 db（chapter_reviews 表），独立于 novel_sync_structure/novel_checkpoint 用的 createProjectFixture */
function createProject(stateContent: string = BASE_STATE): UpdateProgressFixture {
  const root = mkdtempSync(join(tmpdir(), "narracat-state-sync-progress-"));
  mkdirSync(join(root, ".narracat"), { recursive: true });
  mkdirSync(join(root, "manuscript", "vol-01"), { recursive: true });
  const statePath = join(root, ".narracat", "state.yaml");
  writeFileSync(statePath, stateContent, "utf-8");

  const db = new Database(":memory:");
  initSchema(db);

  return {
    root,
    statePath,
    db,
    ctx: {
      novelId: "novel-test",
      db,
      projectRoot: root,
    },
  };
}

function writeManuscript(root: string, chapter: number, content?: string): void {
  const padded = String(chapter).padStart(3, "0");
  writeFileSync(
    join(root, "manuscript", "vol-01", `ch-${padded}.md`),
    content ?? `# 第${chapter}章\n\n${"字".repeat(2500)}\n`,
    "utf-8",
  );
}

/** 建正文 + 提交 pass 审校，使 update_progress 硬门放行 */
async function passReview(
  ctx: ToolContext,
  root: string,
  chapter: number,
  content?: string,
): Promise<string> {
  const body = content ?? `# 第${chapter}章\n\n${"字".repeat(2500)}\n`;
  writeManuscript(root, chapter, body);
  await novelSubmitReview({ chapter, issues: [] }, ctx);
  return body;
}

describe("novel_update_progress", () => {
  it("merges completed chapters, recounts words from files, clears checkpoint", async () => {
    const { ctx, root, statePath } = createProject(
      BASE_STATE.replace("  completed_chapters: []", "  completed_chapters: [1]").replace(
        "  last_command: null",
        '  last_command: "write 2"',
      ),
    );
    writeManuscript(root, 1, "第一章正文内容五千字略。");
    await passReview(ctx, root, 2, "第二章正文内容。");

    const result = (await novelUpdateProgress({ chapter: 2 }, ctx)) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(result["completed_chapters"]).toEqual([1, 2]);
    expect(result["last_completed_chapter"]).toBe(2);
    expect(result["word_count_total"]).toBe(
      countWords("第一章正文内容五千字略。") + countWords("第二章正文内容。"),
    );

    const state = parse(await readFile(statePath, "utf-8"));
    expect(state.progress.completed_chapters).toEqual([1, 2]);
    expect(state.progress.in_progress_chapter).toBeNull();
    expect(state.checkpoint.last_command).toBeNull();
    expect(state.checkpoint.last_step).toBeNull();
  });

  it("is idempotent for repeated commits of the same chapter", async () => {
    const { ctx, root } = createProject();
    await passReview(ctx, root, 3);

    await novelUpdateProgress({ chapter: 3 }, ctx);
    const result = (await novelUpdateProgress({ chapter: 3 }, ctx)) as Record<string, unknown>;

    expect(result["completed_chapters"]).toEqual([3]);
  });

  it("rejects a non-integer chapter", async () => {
    const { ctx } = await createProjectFixture();
    const result = (await novelUpdateProgress({ chapter: "two" }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result["ok"]).toBe(false);
  });

  it("硬门：正文在审校 PASS 后被修改 → 拒绝并要求重新审校", async () => {
    const { ctx, root } = createProject();
    await passReview(ctx, root, 2);
    writeManuscript(root, 2, `# 第2章\n\n${"改".repeat(2500)}\n`); // 审校后篡改

    const result = (await novelUpdateProgress({ chapter: 2 }, ctx)) as Record<string, unknown>;

    expect(result.ok).toBe(false);
    const errors = result.errors as Array<{ field: string; hint: string }>;
    expect(errors[0].field).toBe("review_freshness");
    expect(errors[0].hint).toContain("重新审校");
  });

  it("硬门：最新审校为 fail → 拒绝", async () => {
    const { ctx, root } = createProject();
    writeManuscript(root, 2, `# 第2章\n\n${"字".repeat(2500)}\n`);
    await novelSubmitReview(
      { chapter: 2, issues: [{ severity: "blocker", where: "第一段", what: "测试用阻断项", fix_hint: "无" }] },
      ctx,
    );

    const result = (await novelUpdateProgress({ chapter: 2 }, ctx)) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("硬门：无审校记录 → 拒绝", async () => {
    const { ctx, root } = createProject();
    writeManuscript(root, 2, `# 第2章\n\n${"字".repeat(2500)}\n`);

    const result = (await novelUpdateProgress({ chapter: 2 }, ctx)) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("硬门：审校记录无指纹（老库升级行）→ 拒绝并提示重新审校", async () => {
    const { ctx, root, db } = createProject();
    await passReview(ctx, root, 2);
    db.prepare(
      "UPDATE chapter_reviews SET reviewed_manuscript_sha256 = NULL WHERE novel_id = ? AND chapter = 2",
    ).run("novel-test");

    const result = (await novelUpdateProgress({ chapter: 2 }, ctx)) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });

  it("硬门：正文未改动，PASS 指纹一致 → 放行", async () => {
    const { ctx, root } = createProject();
    await passReview(ctx, root, 2);

    const result = (await novelUpdateProgress({ chapter: 2 }, ctx)) as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });

  it("硬门无豁免参数：传 author_edited=true 也照样走门被拒", async () => {
    const { ctx, root } = createProject();
    writeManuscript(root, 2, `# 第2章\n\n${"字".repeat(2500)}\n`); // 无任何审校

    const result = (await novelUpdateProgress({ chapter: 2, author_edited: true }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(false);
    const errors = result.errors as Array<{ field: string }>;
    expect(errors[0].field).toBe("review_freshness");
  });

  it("硬门：审校 PASS → 修改 → 重新审校 PASS → 新指纹放行", async () => {
    const { ctx, root } = createProject();
    await passReview(ctx, root, 2);
    await passReview(ctx, root, 2, `# 第2章\n\n${"新".repeat(2500)}\n`); // 改后复审重绑指纹

    const result = (await novelUpdateProgress({ chapter: 2 }, ctx)) as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });
});

describe("novel_update_progress promote", () => {
  /** BASE_STATE 变体：chapter_to_volume 显式映射到指定卷号（默认卷1，与 createProject 预建的 vol-01 对齐） */
  function stateWithChapterVolume(chapter: number, volume = 1): string {
    return BASE_STATE.replace("  chapter_to_volume: {}", `  chapter_to_volume: { ${chapter}: ${volume} }`);
  }

  function writeStaging(root: string, chapter: number, content?: string): string {
    mkdirSync(join(root, ".narracat", "staging"), { recursive: true });
    const body = content ?? `# 第${chapter}章\n\n${"字".repeat(2500)}。\n`;
    writeFileSync(stagingManuscriptPath(root, chapter), body, "utf-8");
    return body;
  }

  /** 建 staging 正文 + 提交 pass 审校（指纹绑定 staging 内容），供 update_progress 硬门放行 */
  async function passReviewStaging(
    ctx: ToolContext,
    root: string,
    chapter: number,
    content?: string,
  ): Promise<string> {
    const body = writeStaging(root, chapter, content);
    await novelSubmitReview({ chapter, issues: [] }, ctx);
    return body;
  }

  it("staging 存在且门全过 → rename 进正式路径、staging 与 brief 消失、进度字数含本章", async () => {
    const { ctx, root, statePath } = createProject(stateWithChapterVolume(4, 1));
    const body = await passReviewStaging(ctx, root, 4);
    writeFileSync(join(root, ".narracat", "staging", "ch-004.brief.md"), "# 任务书\n", "utf-8");
    writeFileSync(join(root, ".narracat", "staging", ".brief-lint-warned-ch-004"), "", "utf-8");

    const result = (await novelUpdateProgress({ chapter: 4 }, ctx)) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(existsSync(stagingManuscriptPath(root, 4))).toBe(false);
    expect(existsSync(join(root, ".narracat", "staging", "ch-004.brief.md"))).toBe(false);
    expect(existsSync(join(root, ".narracat", "staging", ".brief-lint-warned-ch-004"))).toBe(false);
    expect(existsSync(join(root, "manuscript", "vol-01", "ch-004.md"))).toBe(true);
    expect(result["word_count_total"]).toBe(countWords(body));

    const state = parse(await readFile(statePath, "utf-8"));
    expect(state.progress.completed_chapters).toEqual([4]);
  });

  it("合同不过（字数不足）→ 返回 errors、不 promote、state.yaml 未写（原子性）", async () => {
    const { ctx, root, statePath } = createProject(stateWithChapterVolume(4, 1));
    const before = await readFile(statePath, "utf-8");
    writeStaging(root, 4, `# 第4章\n\n${"字".repeat(100)}。\n`); // 远低于默认下限 2400

    const result = (await novelUpdateProgress({ chapter: 4 }, ctx)) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    const errors = result["errors"] as Array<{ field: string }>;
    expect(errors.some((e) => e.field === "manuscript_contract")).toBe(true);
    expect(existsSync(stagingManuscriptPath(root, 4))).toBe(true); // 未 promote
    expect(await readFile(statePath, "utf-8")).toBe(before); // state.yaml 未写
  });

  it("卷号缺失（structure.chapter_to_volume 无该章）→ 报错终止、staging 原地保留", async () => {
    const { ctx, root, statePath } = createProject(); // BASE_STATE：chapter_to_volume 为空映射
    const before = await readFile(statePath, "utf-8");
    await passReviewStaging(ctx, root, 4);

    const result = (await novelUpdateProgress({ chapter: 4 }, ctx)) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    const errors = result["errors"] as Array<{ field: string }>;
    expect(errors.some((e) => e.field === "structure.chapter_to_volume")).toBe(true);
    expect(existsSync(stagingManuscriptPath(root, 4))).toBe(true); // 原地保留
    expect(await readFile(statePath, "utf-8")).toBe(before); // 未写 state.yaml
  });

  it("无 staging（老书 / 作者链路）→ promote 跳过，其余行为与现状一致", async () => {
    const { ctx, root, statePath } = createProject(stateWithChapterVolume(2, 1));
    await passReview(ctx, root, 2); // 直接写正式路径，无 staging

    const result = (await novelUpdateProgress({ chapter: 2 }, ctx)) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(existsSync(join(root, "manuscript", "vol-01", "ch-002.md"))).toBe(true);
    const state = parse(await readFile(statePath, "utf-8"));
    expect(state.progress.completed_chapters).toEqual([2]);
  });

  it("刀1回归：staging 上审校 pass（指纹=staging 内容）→ promote 后 rename 不改内容，指纹仍匹配", async () => {
    const { ctx, root } = createProject(stateWithChapterVolume(4, 1));
    const body = await passReviewStaging(ctx, root, 4);

    const result = (await novelUpdateProgress({ chapter: 4 }, ctx)) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    const promotedContent = await readFile(join(root, "manuscript", "vol-01", "ch-004.md"), "utf-8");
    expect(promotedContent).toBe(body); // rename 不改字节，指纹（对该内容重算）仍会匹配
  });
});

describe("novel_restore_progress", () => {
  it("无任何审校记录也放行，并恢复完成进度与字数", async () => {
    const { ctx, root, statePath } = createProject();
    writeManuscript(root, 2, "作者手改后的第二章正文。"); // 无任何审校

    const result = (await novelRestoreProgress({ chapter: 2 }, ctx)) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result["completed_chapters"]).toEqual([2]);
    expect(result["word_count_total"]).toBe(countWords("作者手改后的第二章正文。"));
    expect(String(result["message"])).toContain("进度已恢复");

    const state = parse(await readFile(statePath, "utf-8"));
    expect(state.progress.completed_chapters).toEqual([2]);
    expect(state.progress.last_completed_chapter).toBe(2);
    expect(state.checkpoint.last_command).toBeNull();
  });

  it("审校 PASS 后正文被作者改过也放行（不做新鲜度校验）", async () => {
    const { ctx, root } = createProject();
    await passReview(ctx, root, 2);
    writeManuscript(root, 2, `# 第2章\n\n${"改".repeat(2500)}\n`); // 审校后作者手改

    const result = (await novelRestoreProgress({ chapter: 2 }, ctx)) as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });

  it("拒绝非正整数章号", async () => {
    const { ctx } = createProject();
    const result = (await novelRestoreProgress({ chapter: 0 }, ctx)) as Record<string, unknown>;
    expect(result.ok).toBe(false);
  });
});

// 写第 3 章中断（断点 write 3、第 3 章未完成）后，作者又去改写 / 同步别的章：它们收尾时不能把
// 写章中断记录一并清掉，否则作品页找不回「继续写第 3 章」。写章自己完成第 3 章时照常清。
describe("写章中断记录不被别的章的收尾清掉", () => {
  const INTERRUPTED_AT_3 = BASE_STATE.replace("  completed_chapters: []", "  completed_chapters: [1, 2]")
    .replace("  last_completed_chapter: 0", "  last_completed_chapter: 2")
    .replace("  last_command: null\n  last_step: null", "  last_command: write 3\n  last_step: 3");

  it("改写第 1 章收尾（novel_update_progress）保留写第 3 章的中断记录", async () => {
    const { ctx, root, statePath } = createProject(INTERRUPTED_AT_3);
    await passReview(ctx, root, 1, "改写后的第一章正文。");

    const result = (await novelUpdateProgress({ chapter: 1 }, ctx)) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    const state = parse(await readFile(statePath, "utf-8"));
    expect(state.progress.completed_chapters).toEqual([1, 2]);
    expect(state.checkpoint.last_command).toBe("write 3");
    expect(state.checkpoint.last_step).toBe(3);
  });

  it("同步最后一章记忆（区间回滚第 2 章 + novel_restore_progress）保留写第 3 章的中断记录", async () => {
    const { ctx, root, statePath } = createProject(INTERRUPTED_AT_3);
    writeManuscript(root, 2, "作者手改后的第二章正文。");

    const reverted = await revertProgressToChapter(root, 2);
    expect(reverted.ok).toBe(true);
    let state = parse(await readFile(statePath, "utf-8"));
    expect(state.checkpoint.last_command).toBe("write 3");

    const result = (await novelRestoreProgress({ chapter: 2 }, ctx)) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    state = parse(await readFile(statePath, "utf-8"));
    expect(state.progress.completed_chapters).toEqual([1, 2]);
    expect(state.checkpoint.last_command).toBe("write 3");
    expect(state.checkpoint.last_step).toBe(3);
  });

  it("写章自己完成第 3 章时照常清掉中断记录", async () => {
    const { ctx, root, statePath } = createProject(INTERRUPTED_AT_3);
    await passReview(ctx, root, 3, "第三章正文。");

    const result = (await novelUpdateProgress({ chapter: 3 }, ctx)) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    const state = parse(await readFile(statePath, "utf-8"));
    expect(state.progress.completed_chapters).toEqual([1, 2, 3]);
    expect(state.checkpoint.last_command).toBeNull();
    expect(state.checkpoint.last_step).toBeNull();
  });

  it("不是写章中断的记录（如 rewrite 1）收尾时照常清", async () => {
    const { ctx, root, statePath } = createProject(
      INTERRUPTED_AT_3.replace("  last_command: write 3", "  last_command: rewrite 1"),
    );
    await passReview(ctx, root, 1, "改写后的第一章正文。");

    await novelUpdateProgress({ chapter: 1 }, ctx);

    const state = parse(await readFile(statePath, "utf-8"));
    expect(state.checkpoint.last_command).toBeNull();
  });
});

describe("novel_checkpoint", () => {
  it("writes last_command with chapter suffix and the current step", async () => {
    const { ctx, statePath } = await createProjectFixture();

    const result = (await novelCheckpoint(
      { command: "write", step: 4, chapter: 12 },
      ctx,
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(result["last_command"]).toBe("write 12");

    const state = parse(await readFile(statePath, "utf-8"));
    expect(state.checkpoint.last_command).toBe("write 12");
    expect(state.checkpoint.last_step).toBe(4);
    expect(state.checkpoint.timestamp).toBeTruthy();
  });

  it("omits the chapter suffix when chapter is not provided", async () => {
    const { ctx, statePath } = await createProjectFixture();

    await novelCheckpoint({ command: "plan", step: 2 }, ctx);

    const state = parse(await readFile(statePath, "utf-8"));
    expect(state.checkpoint.last_command).toBe("plan");
  });

  // 写章中断后作品页只靠 last_command="write N" 认出可恢复的中断章（引擎从不写 in_progress_chapter），
  // 中途跑一次设定 / 大纲等别的命令若覆盖掉它，作品页就丢了「继续写第 N 章」。
  const INTERRUPTED_WRITE_STATE = BASE_STATE.replace(
    "  completed_chapters: []",
    "  completed_chapters: [1, 2]",
  ).replace("  last_command: null\n  last_step: null", "  last_command: write 3\n  last_step: 3");

  it("已有未完成的写章断点时，别的命令不覆盖它", async () => {
    const { ctx, statePath } = await createProjectFixture(INTERRUPTED_WRITE_STATE);

    for (const step of [3, 4, 5, 6]) {
      const result = (await novelCheckpoint({ command: "world", step }, ctx)) as Record<string, unknown>;
      expect(result["ok"]).toBe(true);
      expect(result["preserved_write_checkpoint"]).toBe(true);
      expect(result["last_command"]).toBe("write 3");
    }
    await novelCheckpoint({ command: "plan", step: 2 }, ctx);

    const state = parse(await readFile(statePath, "utf-8"));
    expect(state.checkpoint.last_command).toBe("write 3");
    expect(state.checkpoint.last_step).toBe(3);
  });

  it("写章自己的断点照常推进；写另一章也照常覆盖", async () => {
    const { ctx, statePath } = await createProjectFixture(INTERRUPTED_WRITE_STATE);

    await novelCheckpoint({ command: "write", step: 4, chapter: 3 }, ctx);
    let state = parse(await readFile(statePath, "utf-8"));
    expect(state.checkpoint.last_command).toBe("write 3");
    expect(state.checkpoint.last_step).toBe(4);

    await novelCheckpoint({ command: "write", step: 1, chapter: 4 }, ctx);
    state = parse(await readFile(statePath, "utf-8"));
    expect(state.checkpoint.last_command).toBe("write 4");
  });

  it("写章断点对应的章已完成（残留断点）时，别的命令照常覆盖", async () => {
    const { ctx, statePath } = await createProjectFixture(
      INTERRUPTED_WRITE_STATE.replace("  completed_chapters: [1, 2]", "  completed_chapters: [1, 2, 3]"),
    );

    const result = (await novelCheckpoint({ command: "world", step: 3 }, ctx)) as Record<string, unknown>;

    expect(result["preserved_write_checkpoint"]).toBeUndefined();
    const state = parse(await readFile(statePath, "utf-8"));
    expect(state.checkpoint.last_command).toBe("world");
  });

  it("rejects an empty command", async () => {
    const { ctx } = await createProjectFixture();
    const result = (await novelCheckpoint({ command: " ", step: 1 }, ctx)) as Record<
      string,
      unknown
    >;
    expect(result["ok"]).toBe(false);
  });
});

describe("countWords 纯文字口径", () => {
  it("只数文字，剔除标点", () => {
    // 10 个文字 + 4 个标点（，。，！）→ 10
    expect(countWords("你好，世界。今天，天气真好！")).toBe(10);
  });

  it("剔除空白（含全角空格与换行）", () => {
    // 第一行(3) 第二行(3) 末尾(2) = 8
    expect(countWords("第一行\n第二行　末尾 ")).toBe(8);
  });

  it("保留中英文数字，剔除符号与标点", () => {
    expect(countWords("# 雨夜 abc～2024！")).toBe(9);
  });

  it("纯标点 / 空串计 0", () => {
    expect(countWords("，。！？……——")).toBe(0);
    expect(countWords("")).toBe(0);
  });
});

describe("resolveWorkingManuscript", () => {
  it("staging 存在时返回 staging 路径", async () => {
    const { root } = await createProjectFixture();
    await mkdir(join(root, ".narracat", "staging"), { recursive: true });
    await mkdir(join(root, "manuscript", "vol-01"), { recursive: true });
    await writeFile(join(root, ".narracat", "staging", "ch-004.md"), "# 第4章（草稿）\n", "utf-8");
    await writeFile(join(root, "manuscript", "vol-01", "ch-004.md"), "# 第4章（定稿）\n", "utf-8");

    const resolved = await resolveWorkingManuscript(root, 4);

    expect(resolved).toEqual({ path: stagingManuscriptPath(root, 4), source: "staging" });
  });

  it("无 staging 时落回正式路径", async () => {
    const { root } = await createProjectFixture();
    await mkdir(join(root, "manuscript", "vol-01"), { recursive: true });
    await writeFile(join(root, "manuscript", "vol-01", "ch-004.md"), "# 第4章\n", "utf-8");

    const resolved = await resolveWorkingManuscript(root, 4);

    expect(resolved?.source).toBe("manuscript");
    expect(resolved?.path.endsWith("manuscript/vol-01/ch-004.md")).toBe(true);
  });

  it("两处都没有时返回 null", async () => {
    const { root } = await createProjectFixture();

    expect(await resolveWorkingManuscript(root, 99)).toBeNull();
  });
});

// ============================================================
// checkManuscriptContract / novelCheckManuscriptContract / normalizeAsciiQuotesInChinese
// ============================================================

const CONTRACT_CHAPTER = 4;

/** 写好 staging 正文并返回带 wordsPerChapter=3000（区间 2400-3600）的 ctx */
async function fixtureWithStaging(
  content: string,
  chapter: number = CONTRACT_CHAPTER,
): Promise<{ ctx: ToolContext; root: string }> {
  const { ctx, root } = await createProjectFixture();
  await mkdir(join(root, ".narracat", "staging"), { recursive: true });
  await writeFile(stagingManuscriptPath(root, chapter), content, "utf-8");
  return { ctx: { ...ctx, wordsPerChapter: 3000 }, root };
}

/** 目标字数区间内、干净通过全部检查项的一段正文（供单项测试隔离其他检查项） */
function cleanBody(chars = 3000): string {
  return `${"字".repeat(chars)}。`;
}

describe("checkManuscriptContract", () => {
  it("无 staging 返回 null（免检）", async () => {
    const { ctx } = await createProjectFixture();

    const result = await checkManuscriptContract({ ...ctx, wordsPerChapter: 3000 }, CONTRACT_CHAPTER);

    expect(result).toBeNull();
  });

  it("空文件 → errors 含 可见正文非空", async () => {
    const { ctx } = await fixtureWithStaging("");

    const result = await checkManuscriptContract(ctx, CONTRACT_CHAPTER);

    expect(result).not.toBeNull();
    expect(result?.errors.some((e) => e.expected.includes("可见正文非空"))).toBe(true);
  });

  it("可见字数 2399（< 下限 2400）→ errors 含 字数下限", async () => {
    const { ctx } = await fixtureWithStaging(cleanBody(2399));

    const result = await checkManuscriptContract(ctx, CONTRACT_CHAPTER);

    expect(result?.errors.some((e) => e.expected.includes("字数下限"))).toBe(true);
  });

  it("正文含 ``` 围栏行 → errors", async () => {
    const { ctx } = await fixtureWithStaging(`\`\`\`\n${cleanBody()}`);

    const result = await checkManuscriptContract(ctx, CONTRACT_CHAPTER);

    expect(result?.errors.some((e) => e.actual.includes("围栏"))).toBe(true);
  });

  it("首行 --- → errors（YAML 头）", async () => {
    const { ctx } = await fixtureWithStaging(`---\n${cleanBody()}`);

    const result = await checkManuscriptContract(ctx, CONTRACT_CHAPTER);

    expect(result?.errors.some((e) => e.actual.includes("---"))).toBe(true);
  });

  it("首个非空行「好的，以下是第4章」→ errors（说明性前言）", async () => {
    const { ctx } = await fixtureWithStaging(`好的，以下是第4章正文：\n${cleanBody()}`);

    const result = await checkManuscriptContract(ctx, CONTRACT_CHAPTER);

    expect(result?.errors.some((e) => e.expected.includes("说明性前言") || e.hint.includes("说明"))).toBe(
      true,
    );
  });

  it("首行「我将剑收回鞘中」不报前言错误（第一人称小说开篇不得被误杀，硬门 fail-open）", async () => {
    const { ctx } = await fixtureWithStaging(`我将剑收回鞘中，转身走进夜色。\n${cleanBody()}`);

    const result = await checkManuscriptContract(ctx, CONTRACT_CHAPTER);

    expect(result?.errors.some((e) => e.expected.includes("说明性前言"))).toBe(false);
  });

  it("首行「# 第5章 xxx」但目标章 4 → errors（章号不符）", async () => {
    const { ctx } = await fixtureWithStaging(`# 第5章 惊变\n${cleanBody()}`);

    const result = await checkManuscriptContract(ctx, CONTRACT_CHAPTER);

    expect(result?.errors.some((e) => e.actual.includes("第 5 章"))).toBe(true);
  });

  it("无标题行直接正文 → 不判章号（干净通过）", async () => {
    const { ctx } = await fixtureWithStaging(cleanBody());

    const result = await checkManuscriptContract(ctx, CONTRACT_CHAPTER);

    expect(result?.errors).toEqual([]);
    expect(result?.warnings).toEqual([]);
  });

  it("末字符为逗号 → errors（截断）", async () => {
    const { ctx } = await fixtureWithStaging(`${"字".repeat(2500)}，`);

    const result = await checkManuscriptContract(ctx, CONTRACT_CHAPTER);

    expect(result?.errors.some((e) => e.expected.includes("完整句"))).toBe(true);
  });

  it.each(["。", "」", "？"])("末字符为 %s → 通过（无截断 error）", async (terminal) => {
    const { ctx } = await fixtureWithStaging(`${"字".repeat(2500)}${terminal}`);

    const result = await checkManuscriptContract(ctx, CONTRACT_CHAPTER);

    expect(result?.errors).toEqual([]);
  });

  it("字数 3700（> 上限 3600）→ errors 空、warnings 提示超上限", async () => {
    const { ctx } = await fixtureWithStaging(cleanBody(3700));

    const result = await checkManuscriptContract(ctx, CONTRACT_CHAPTER);

    expect(result?.errors).toEqual([]);
    expect(result?.warnings.some((w) => w.includes("超出目标上限"))).toBe(true);
  });

  it("ASCII 引号包中文 → warnings", async () => {
    const { ctx } = await fixtureWithStaging(`"你好"${cleanBody()}`);

    const result = await checkManuscriptContract(ctx, CONTRACT_CHAPTER);

    expect(result?.errors).toEqual([]);
    expect(result?.warnings.some((w) => w.includes("引号"))).toBe(true);
  });
});

describe("normalizeAsciiQuotesInChinese", () => {
  it("成对 ASCII 引号包中文 → 替换为弯引号", () => {
    expect(normalizeAsciiQuotesInChinese('他说"你好"。')).toBe("他说“你好”。");
  });

  it("同一行两对 ASCII 引号交替开闭", () => {
    expect(normalizeAsciiQuotesInChinese('"甲"和"乙"')).toBe("“甲”和“乙”");
  });

  it("奇数个引号的行不动", () => {
    const line = '他说"你好啊。';
    expect(normalizeAsciiQuotesInChinese(line)).toBe(line);
  });

  it("纯英文行不动（无汉字）", () => {
    const line = 'He said "hello".';
    expect(normalizeAsciiQuotesInChinese(line)).toBe(line);
  });

  it("已是弯引号的文本幂等", () => {
    const text = "他说“你好”。";
    expect(normalizeAsciiQuotesInChinese(text)).toBe(text);
  });
});

describe("normalizeCornerQuotesWhenSoleForm", () => {
  it("整章只有直角引号（零弯引号）→ 按弯引号统一", () => {
    // 真机现象：写手整章把对白落在直角引号上（任务书里满屏「」的习惯被带进正文），
    // 同一本书四章漂出弯 / 半角 / 直角三种形态。写手 prompt 早已写明用弯引号却没生效，
    // 故下沉为机械兜底。真人网文对照 14/14 用弯引号。
    const text = "「招。」\n他往里让了让。\n「坐。喝水吗？」";
    expect(normalizeCornerQuotesWhenSoleForm(text)).toBe("“招。”\n他往里让了让。\n“坐。喝水吗？”");
  });

  it("嵌套直角引号一并降为中文单弯引号", () => {
    expect(normalizeCornerQuotesWhenSoleForm("「他说『不行』。」")).toBe("“他说‘不行’。”");
  });

  it("弯直混用时直角引号一律不动（那是术语/专名标记，不是对白）", () => {
    // 「概率偏移」这类异能名、社团名在混用章里承担专名职责，替换会被读成对白
    const text = "“招。”\n他的能力是「概率偏移」。";
    expect(normalizeCornerQuotesWhenSoleForm(text)).toBe(text);
  });

  it("无直角引号 / 无汉字时原样返回", () => {
    expect(normalizeCornerQuotesWhenSoleForm("他说“你好”。")).toBe("他说“你好”。");
    expect(normalizeCornerQuotesWhenSoleForm("plain ascii")).toBe("plain ascii");
  });

  it("幂等：归一后再跑一次不变", () => {
    const once = normalizeCornerQuotesWhenSoleForm("「招。」");
    expect(normalizeCornerQuotesWhenSoleForm(once)).toBe(once);
  });
});

describe("novelCheckManuscriptContract", () => {
  it("拒绝非正整数章号", async () => {
    const { ctx } = await createProjectFixture();

    const result = (await novelCheckManuscriptContract(
      { chapter: 0 },
      ctx,
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
  });

  it("无 staging → ok:true, staging:false, 免检提示", async () => {
    const { ctx } = await createProjectFixture();

    const result = (await novelCheckManuscriptContract(
      { chapter: CONTRACT_CHAPTER },
      ctx,
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(result["staging"]).toBe(false);
    expect(String(result["message"])).toContain("免检");
  });

  it("有 staging 且干净通过 → ok:true, staging:true, errors 空", async () => {
    const { ctx } = await fixtureWithStaging(cleanBody());

    const result = (await novelCheckManuscriptContract(
      { chapter: CONTRACT_CHAPTER },
      ctx,
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(true);
    expect(result["staging"]).toBe(true);
    expect(result["errors"]).toEqual([]);
  });

  it("有 staging 且违反硬项 → ok:false, errors 非空", async () => {
    const { ctx } = await fixtureWithStaging("");

    const result = (await novelCheckManuscriptContract(
      { chapter: CONTRACT_CHAPTER },
      ctx,
    )) as Record<string, unknown>;

    expect(result["ok"]).toBe(false);
    expect((result["errors"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("ASCII 引号包中文 → 预检前先机械归一并写回 staging 文件", async () => {
    const { ctx, root } = await fixtureWithStaging(`"你好"${cleanBody()}`);

    const result = (await novelCheckManuscriptContract(
      { chapter: CONTRACT_CHAPTER },
      ctx,
    )) as Record<string, unknown>;

    expect(result["normalized"]).toBe(true);
    const written = await readFile(stagingManuscriptPath(root, CONTRACT_CHAPTER), "utf-8");
    expect(written).toContain("“你好”");
    expect(written).not.toContain('"你好"');
  });

  it("无需归一时 normalized:false 且文件字节不变", async () => {
    const { ctx, root } = await fixtureWithStaging(cleanBody());
    const before = await readFile(stagingManuscriptPath(root, CONTRACT_CHAPTER), "utf-8");

    const result = (await novelCheckManuscriptContract(
      { chapter: CONTRACT_CHAPTER },
      ctx,
    )) as Record<string, unknown>;

    expect(result["normalized"]).toBe(false);
    const after = await readFile(stagingManuscriptPath(root, CONTRACT_CHAPTER), "utf-8");
    expect(after).toBe(before);
  });
});
