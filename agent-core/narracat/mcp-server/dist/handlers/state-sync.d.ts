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
import type { ToolContext, ToolErrorItem } from "../types.js";
/**
 * 正文字数口径（纯文字）：只数文字（汉字 / 字母 / 数字），剔除空白、标点、符号。
 * 用户设的「每章字数」按纯文字计，state.yaml / chapter_summaries 的权威字数与之同口径。
 * 必须与 App 侧 `src/lib/word-count.ts` 的 countBodyChars 保持一致（两处独立 build，改一处须同步）。
 */
export declare function countWords(text: string): number;
/** 剥离 chapter_metadata 注释后的可见正文：字数与片段一律按它计，元数据文本不算正文 */
export declare function visibleBodyText(content: string): string;
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
export declare function extractManuscriptSnippets(rawContent: string, options?: {
    openingChars?: number;
    endingChars?: number;
}): ManuscriptSnippets;
/** 章号 → 三位文件段（如 5 → "005"） */
export declare function chapterFileSegment(chapter: number): string;
/** 卷号 → 两位目录段（如 1 → "vol-01"） */
export declare function volumeDirSegment(volume: number): string;
export interface ManuscriptEntry {
    chapter: number;
    volume: number;
    path: string;
}
/** 扫描 manuscript/vol-VV/ch-NNN.md，返回全部章节文件 */
export declare function scanManuscripts(projectRoot: string): Promise<ManuscriptEntry[]>;
/** 定位指定章的 manuscript 文件 */
export declare function findManuscript(projectRoot: string, chapter: number): Promise<ManuscriptEntry | null>;
/** 本章待验收正文（staging）绝对路径 */
export declare function stagingManuscriptPath(projectRoot: string, chapter: number): string;
export interface WorkingManuscript {
    path: string;
    source: "staging" | "manuscript";
}
/**
 * 工作正文解析：staging 存在 → staging（未验收草稿优先）；否则正式路径。
 * 用于「正在写的这一章」（指纹门 / 洁净扫描 / 本章入库读取）。
 * 定稿类消费（前章结尾摘录、样章取样、全书字数）不得用本函数——那边只认 manuscript/。
 */
export declare function resolveWorkingManuscript(projectRoot: string, chapter: number): Promise<WorkingManuscript | null>;
/**
 * 正文机械合同：仅当该章存在 staging 时生效（写作链产出必须过合同；
 * 无 staging = 作者手改 / 存量老书链路，一律免检返回 null）。
 * 硬项进 errors（拒绝提交），软项进 warnings（只提醒）。
 */
export declare function checkManuscriptContract(ctx: ToolContext, chapter: number): Promise<{
    errors: ToolErrorItem[];
    warnings: string[];
} | null>;
/**
 * ASCII 引号机械归一：仅处理「同一行内成对出现、且该行含汉字」的 ASCII 双引号，
 * 按开/闭交替替换为中文弯引号。奇数个引号的行不动（宁可留给软警告，不做歧义猜测）。
 */
export declare function normalizeAsciiQuotesInChinese(text: string): string;
/**
 * 直角引号归一：仅当整篇「一个弯引号都没有、却有直角引号」时——那说明写手整章换用了另一套
 * 引号体系（对白职责整体落在直角引号上），按弯引号统一（真人网文对照 14/14 用弯引号）。
 * 弯直混用时一律不动：混用章里的直角引号多半在标术语与专名（异能名、社团名），
 * 无条件替换会把专名标记读成对白。写手 prompt 早已要求用弯引号却仍漂形态，故下沉为机械兜底。
 */
export declare function normalizeCornerQuotesWhenSoleForm(text: string): string;
/**
 * novel_check_manuscript_contract：/write 写手完成后立即预检本章 staging 正文。
 * 先做引号机械归一（ASCII 成对交替 + 整篇独用直角引号时按弯引号统一；
 * 有变化才写回；此时正文尚未进审校，指纹链不受影响），
 * 再跑机械合同。无 staging 一律放行（作者手改 / 存量老书链路不受门）。
 * 归一只在本 handler 做——writers 记忆入口与 update_progress 共用的
 * checkManuscriptContract 保持纯读，账房门不写文件。
 */
export declare function novelCheckManuscriptContract(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
/**
 * 校验后整体写入 state.yaml.structure（read-modify-write，其余节原样保留）。
 * novel_sync_structure 工具与 novel_submit_outline 入库链共用本函数。
 */
export declare function writeStructureToState(projectRoot: string, totalVolumes: number, totalChaptersPlanned: number, chapterToVolume: Map<number, number>): Promise<{
    ok: true;
} | {
    ok: false;
    message: string;
}>;
export declare function novelSyncStructure(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
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
export declare function checkReviewFreshness(ctx: ToolContext, chapter: number, requireReview: boolean): Promise<ToolErrorItem[] | null>;
export declare function novelUpdateProgress(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
/**
 * 作者手改正文后的记忆同步链路专用：恢复章节完成进度，不做审校新鲜度校验。
 * 作者自己改的稿不要求机器复审——但豁免只对持有本工具的命令成立，写作链拿不到它。
 */
export declare function novelRestoreProgress(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
export declare function novelCheckpoint(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
export declare function readCompletedChapters(projectRoot: string): Promise<{
    ok: true;
    chapters: number[];
} | {
    ok: false;
    error: string;
}>;
export declare function revertProgressToChapter(projectRoot: string, chapter: number): Promise<{
    ok: true;
    completed_chapters: number[];
    word_count_total: number;
} | {
    ok: false;
    error: string;
}>;
