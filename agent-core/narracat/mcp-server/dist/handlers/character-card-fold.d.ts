/**
 * 角色状态卡折叠 SSOT（原 writers/readers 双副本收敛于此）
 *
 * 有词表 → v2 维度卡：one 维度取值域内最新有效值 / many 维度全收 / 归不进的落 extras；
 * 无词表 → v1 扁平卡（每谓词最新值），存量书零回归。
 * card_json 存 FoldedCard 原样；进包/进聊天用 renderCardHumanMap 渲染人读键值。
 */
import type { ToolContext } from "../types.js";
import { type StateVocabulary } from "./state-dimensions.js";
export interface FoldedCardV2 {
    _v: 2;
    dimensions: Record<string, {
        display_name: string;
        predicate?: string;
        value?: string;
        values?: string[];
    }>;
    extras: Record<string, string[]>;
    /**
     * 每个 extras 谓词对应的最新事实章号（PR#502 人审 R1 修复：dedupeCardExtras 的截断步骤要
     * 按「哪条最新」而非字典序插入序丢弃，否则新鲜事实可能被早早提交的琐碎观察挤掉）。
     * 只有 v2（有词表）折叠会填；v1 扁平卡无此字段。旧存量卡（本字段落库前折叠）读到时缺失，
     * dedupeCardExtras 回退按原有次序截断，读取侧须容错 undefined。
     */
    extrasChapter?: Record<string, number>;
}
export type FoldedCard = Record<string, string> | FoldedCardV2;
export declare function isFoldedCardV2(card: FoldedCard): card is FoldedCardV2;
/**
 * 判卡是否「空」（无任何折叠内容）。v2 卡恒带 `_v`/`dimensions`/`extras` 三个顶层键，
 * 不能像 v1 那样按 `Object.keys(card).length === 0` 判空——须按 dimensions/extras 是否有内容判断，
 * 否则「无任何事实的角色」会被误判为非空卡（漏删陈旧卡 / 误吞回落存量卡的机会）。
 */
export declare function isEmptyFoldedCard(card: FoldedCard): boolean;
export declare function foldCharacterCard(ctx: ToolContext, characterUid: string, asOfChapter: number): FoldedCard;
export interface FoldFactRow {
    predicate: string;
    object: string;
    /** event 轴章号（COALESCE(event_chapter, from_chapter)） */
    chapter: number;
}
/**
 * 折叠核心：rows 须已按 `predicate ASC, FACT_LATEST_ORDER_SQL` 排好（同谓词内最新优先）。
 * 调用方自带 rows 是为了让各读口按自己的过滤（如聊天秘密滤网）取行，折叠规则只此一份。
 */
export declare function foldFactRows(rows: FoldFactRow[], vocab: StateVocabulary | null): FoldedCard;
/** 去空白/标点/符号后比较用的归一化（SSOT：语义检索冗余剔除 readers.ts 复用同一实现，两处正则不得漂移） */
export declare const normalizeExtraValue: (s: string) => string;
/**
 * extras 只装词表外谓词（x- 前缀等），真机实锤同一事实常被拆成多个近义谓词各写一遍
 * （如 x-habit / x-observation / x-superstition 三次复述同一件事）重复进包，白白挤占预算。
 * 去重规则（spec §4.1 P3）：
 *   1. norm 完全相等 → 只留谓词名字典序最小的一条；
 *   2. norm 不等但互为子串关系 → 丢弃信息量小（norm 是另一条子串）的那条，留信息量大的；
 *   3. 去重后仍 > 8 条 → 有 recency（谓词→最新事实章号）时按章号降序保留最新 8 个
 *      （同章号保持原相对顺序）；无 recency 时维持向后兼容的旧行为——按传入 map 的插入顺序
 *      保留最后 8 条。PR#502 人审 R1：insertion 顺序 = facts SQL 的 predicate ASC 字典序，
 *      与「新鲜度」无关，字典序靠前的谓词即使事实更新也会被误当「旧的」丢弃；
 *      有 recency 时改按真实章号判新旧，避免丢最新事实。
 */
export declare function dedupeCardExtras(extras: Record<string, string[]>, recency?: Record<string, number>): Record<string, string[]>;
export declare function renderCardHumanMap(card: FoldedCard): Record<string, string>;
/**
 * 按原始谓词从折叠卡（v1/v2 皆可）读值：v1 直接查扁平键；v2 归维度后原谓词键会被替换成
 * display_name，故优先按维度槽内自带的 `predicate` 字段直查（折叠时从命中的词表维度带入，
 * 与「当前」词表无关，历史卡按落库时刻的谓词永久可查）；槽无 `predicate`（词表改版前折叠的
 * 旧 v2 历史卡）再回退按「当前」词表反查 display_name——词表显示名或谓词归属一旦改过，
 * 旧卡走此回退路径可能查不到，属已知限制，优雅返回 null 不抛。
 * extras 区（归不进词表的谓词原样落 extras）始终按原谓词直查。
 * 存量回落读取（如 readCharacterStatus 回落 character_cards）须经此函数，不能裸读顶层字段，
 * 否则 v2 卡下永远读不到（该谓词已被折叠进 dimensions，不再是顶层键）。
 */
export declare function readPredicateFromCard(card: FoldedCard, predicate: string, vocab: StateVocabulary | null): string | null;
