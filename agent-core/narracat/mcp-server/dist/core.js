/**
 * NovelMemory 核心入口（进程中立）：工具路由表 + 上下文构造 + 统一调用信封。
 * 两个壳消费它：MCP stdio 壳（index.ts，SDK 路径/App 直调路径）与 App utilityProcess worker
 * （pi 路径）。本模块及其静态 import 链不得在加载期触碰 better-sqlite3 二进制（驱动经
 * openDatabase 第三参注入或懒加载），否则 Electron 侧 import 即炸。
 */
import { loadConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { backfillVectors } from "./utils/vec.js";
import * as readers from "./handlers/readers.js";
import * as stateSync from "./handlers/state-sync.js";
import * as styleReference from "./handlers/style-reference.js";
import * as writers from "./handlers/writers.js";
import * as identity from "./handlers/identity.js";
import * as candidates from "./handlers/candidates.js";
import * as conflictDetector from "./handlers/conflict-detector.js";
import * as gridBenchmark from "./handlers/grid-benchmark.js";
import * as characterEntity from "./handlers/character-entity.js";
import * as plannedState from "./handlers/planned-state.js";
import * as styleAnchor from "./handlers/style-anchor.js";
export { TOOL_DEFINITIONS } from "./tools.js";
// 路由表：工具名 → 处理函数
export const TOOL_HANDLERS = {
    // 读工具 (23)
    novel_query: readers.novelQuery,
    novel_chapter_summary: readers.novelChapterSummary,
    novel_character_state: readers.novelCharacterState,
    novel_character_statuses: readers.novelCharacterStatuses,
    novel_relationship: readers.novelRelationship,
    novel_foreshadowing_status: readers.novelForeshadowingStatus,
    novel_foreshadowing_density: readers.novelForeshadowingDensity,
    novel_get_arc: readers.novelGetArc,
    novel_check_prose_hygiene: readers.novelCheckProseHygiene,
    novel_get_review: readers.novelGetReview,
    novel_failed_reviews: readers.novelFailedReviews,
    novel_get_structure_budget: readers.novelGetStructureBudget,
    novel_writing_context: readers.novelWritingContext,
    novel_build_writing_context_pack: readers.novelBuildWritingContextPack,
    novel_query_style_reference: styleReference.novelQueryStyleReference,
    novel_list_candidate_characters: candidates.novelListCandidateCharacters,
    novel_extraction_scaffold: readers.novelExtractionScaffold,
    novel_get_character_dialogue_samples: readers.novelGetCharacterDialogueSamples,
    novel_list_structure_cards: readers.novelListStructureCards,
    novel_detect_conflicts: conflictDetector.novelDetectConflicts,
    novel_get_grid_benchmark: gridBenchmark.novelGetGridBenchmark,
    novel_get_arc_velocity_target: gridBenchmark.novelGetArcVelocityTarget,
    novel_list_style_anchors: styleAnchor.novelListStyleAnchors,
    // 写工具 (21) —— 每个 agent 只持有自己产物的提交工具
    novel_commit_chapter: writers.novelCommitChapter,
    novel_submit_extraction: writers.novelSubmitExtraction,
    novel_stage_extraction: writers.novelStageExtraction,
    novel_commit_extraction_union: writers.novelCommitExtractionUnion,
    novel_consolidate: writers.novelConsolidate,
    novel_submit_review: writers.novelSubmitReview,
    novel_submit_premise: writers.novelSubmitPremise,
    novel_submit_outline: writers.novelSubmitOutline,
    novel_submit_chapter_outline: writers.novelSubmitChapterOutline,
    novel_register_foreshadowing: writers.novelRegisterForeshadowing,
    novel_update_outline_book_field: writers.novelUpdateOutlineBookField,
    novel_rollback_chapter: writers.novelRollbackChapter,
    novel_register_candidate_character: candidates.novelRegisterCandidateCharacter,
    novel_submit_dialogue_samples: writers.novelSubmitDialogueSamples,
    novel_submit_state_vocabulary: characterEntity.novelSubmitStateVocabulary,
    novel_submit_character_entity: characterEntity.novelSubmitCharacterEntity,
    novel_submit_authored_state: characterEntity.novelSubmitAuthoredState,
    novel_check_state_delivery: plannedState.novelCheckStateDelivery,
    novel_resolve_planned_state: plannedState.novelResolvePlannedState,
    novel_update_chapter_state_changes: plannedState.novelUpdateChapterStateChanges,
    novel_submit_style_anchor: styleAnchor.novelSubmitStyleAnchor,
    // 状态工具 (6) —— 写 state.yaml / staging 正文，不写记忆库
    novel_sync_structure: stateSync.novelSyncStructure,
    novel_update_progress: stateSync.novelUpdateProgress,
    novel_restore_progress: stateSync.novelRestoreProgress,
    novel_reconcile_progress: stateSync.novelReconcileProgress,
    novel_checkpoint: stateSync.novelCheckpoint,
    novel_check_manuscript_contract: stateSync.novelCheckManuscriptContract,
    // 身份工具 (1) —— 确定性铸造 canonical 主键，不入库
    novel_mint_character_uid: identity.novelMintCharacterUid,
    // 造包中心工具 (2) —— App 造包中心专用；agent 不得调用
    novel_pack_authoring_vocab: readers.novelPackAuthoringVocab,
    novel_pack_authoring_preview: readers.novelPackAuthoringPreview,
};
/**
 * 统一错误码体系
 * 所有结构化错误响应均附带 error_code 供日志分析和故障排查
 */
export const ERROR_CODES = {
    UNKNOWN_TOOL: "ERR_TOOL_001",
    CONFIG_LOAD_FAIL: "ERR_DB_001",
    HANDLER_ERROR: "ERR_TOOL_002",
    STARTUP_FAIL: "ERR_DB_002",
};
/** 读配置 + 打开数据库，组装工具上下文（原 index.ts buildToolContext 的参数化版）。 */
export async function createToolContext(options = {}) {
    const config = await loadConfig(options.configPath);
    const db = openDatabase(config.dbPath, config.novelId, options.sqliteDriver);
    return {
        novelId: config.novelId,
        db,
        projectRoot: config.projectRoot,
        estimatedTotalChapters: config.estimatedTotalChapters,
        wordsPerChapter: config.wordsPerChapter,
        styleProfile: config.styleProfile,
        styleAnchorAutoFallback: config.styleAnchorAutoFallback,
        genre: config.genre,
        voltageBestofPresentInConfig: config.voltageBestofPresentInConfig,
        secretFilter: options.secretFilter ?? process.env.NARRACAT_CHAT_SECRET_FILTER === "1",
    };
}
const defaultLog = (line) => console.error(line);
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 统一调用信封：未知工具 / 配置加载失败 / 处理器异常 / 成功四分支，与原 index.ts CallTool handler 逐分支对齐（含结构化日志字段）。 */
export async function runTool(name, args, getContext, log = defaultLog) {
    const start = performance.now();
    const finish = (fields) => {
        log(JSON.stringify({
            event: "tool_call",
            tool: name,
            duration_ms: Math.round(performance.now() - start),
            ...fields,
            timestamp: new Date().toISOString(),
        }));
    };
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
        finish({ success: false, error_code: ERROR_CODES.UNKNOWN_TOOL });
        return {
            isError: true,
            text: JSON.stringify({ status: "error", tool: name, error_code: ERROR_CODES.UNKNOWN_TOOL, message: `未知工具: ${name}` }),
        };
    }
    let ctx;
    try {
        ctx = await getContext();
    }
    catch (error) {
        finish({ success: false, error_code: ERROR_CODES.CONFIG_LOAD_FAIL });
        return {
            isError: true,
            text: JSON.stringify({
                status: "error",
                tool: name,
                error_code: ERROR_CODES.CONFIG_LOAD_FAIL,
                message: `配置加载失败: ${errorMessage(error)}`,
            }),
        };
    }
    try {
        const result = await handler(args, ctx);
        const validationFailed = typeof result === "object" && result !== null && result.ok === false;
        finish({ success: true, validation_error: validationFailed || undefined });
        return { isError: false, text: JSON.stringify(result, null, 2) };
    }
    catch (error) {
        finish({ success: false, error_code: ERROR_CODES.HANDLER_ERROR, error_message: errorMessage(error) });
        return {
            isError: true,
            text: JSON.stringify({
                status: "error",
                tool: name,
                error_code: ERROR_CODES.HANDLER_ERROR,
                message: `工具执行失败: ${errorMessage(error)}`,
            }),
        };
    }
}
/** 惰性上下文 runner：首调构建 ToolContext 并 memoize，失败不缓存（下次重试，对齐原 index.ts toolContext 变量语义）。 */
export function createLazyToolRunner(options) {
    const log = options.log ?? defaultLog;
    let contextPromise = null;
    function getContext() {
        if (!contextPromise) {
            contextPromise = options.createContext().catch((error) => {
                contextPromise = null;
                throw error;
            });
        }
        return contextPromise;
    }
    return {
        getContext,
        runTool: (name, args) => runTool(name, args, getContext, log),
    };
}
/** 启动期契约 backfill：三个文件契约逐个 try/catch（原 index.ts main() 语义），向量 backfill 后台跑不 await。 */
export async function runStartupBackfills(ctx, log = defaultLog) {
    const steps = [
        ["审校契约", writers.backfillReviewArtifacts],
        ["大纲契约", writers.backfillOutlineArtifacts],
        ["立项卡契约", writers.backfillPremiseArtifacts],
    ];
    for (const [label, step] of steps) {
        try {
            await step(ctx);
        }
        catch (error) {
            log(`[NovelMemory] ${label} backfill 跳过: ${errorMessage(error)}`);
        }
    }
    void backfillVectors(ctx.db, ctx.novelId).catch((error) => {
        log(`[NovelMemory] 向量 backfill 跳过: ${errorMessage(error)}`);
    });
}
