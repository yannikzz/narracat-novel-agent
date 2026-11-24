/**
 * 角色状态卡折叠 SSOT（原 writers/readers 双副本收敛于此）
 *
 * 有词表 → v2 维度卡：one 维度取值域内最新有效值 / many 维度全收 / 归不进的落 extras；
 * 无词表 → v1 扁平卡（每谓词最新值），存量书零回归。
 * card_json 存 FoldedCard 原样；进包/进聊天用 renderCardHumanMap 渲染人读键值。
 */
import { FACT_VALID_AT_SQL, FACT_LATEST_ORDER_SQL } from "./fact-temporal.js";
import { loadStateVocabulary, attributeFact } from "./state-dimensions.js";
export function isFoldedCardV2(card) {
    return typeof card === "object" && card !== null && card._v === 2;
}
/**
 * 判卡是否「空」（无任何折叠内容）。v2 卡恒带 `_v`/`dimensions`/`extras` 三个顶层键，
 * 不能像 v1 那样按 `Object.keys(card).length === 0` 判空——须按 dimensions/extras 是否有内容判断，
 * 否则「无任何事实的角色」会被误判为非空卡（漏删陈旧卡 / 误吞回落存量卡的机会）。
 */
export function isEmptyFoldedCard(card) {
    if (isFoldedCardV2(card)) {
        return Object.keys(card.dimensions).length === 0 && Object.keys(card.extras).length === 0;
    }
    return Object.keys(card).length === 0;
}
export function foldCharacterCard(ctx, characterUid, asOfChapter) {
    const rows = ctx.db
        .prepare(`SELECT predicate, object, COALESCE(event_chapter, from_chapter) AS chapter FROM facts
       WHERE novel_id = ? AND subject_character_uid = ? AND subject_character_b_uid IS NULL
         AND ${FACT_VALID_AT_SQL}
       ORDER BY predicate ASC, ${FACT_LATEST_ORDER_SQL}`)
        .all(ctx.novelId, characterUid, asOfChapter, asOfChapter);
    return foldFactRows(rows, loadStateVocabulary(ctx.projectRoot));
}
/**
 * 折叠核心：rows 须已按 `predicate ASC, FACT_LATEST_ORDER_SQL` 排好（同谓词内最新优先）。
 * 调用方自带 rows 是为了让各读口按自己的过滤（如聊天秘密滤网）取行，折叠规则只此一份。
 */
export function foldFactRows(rows, vocab) {
    if (!vocab) {
        const card = {};
        for (const row of rows) {
            if (!(row.predicate in card))
                card[row.predicate] = row.object;
        }
        return card;
    }
    const card = { _v: 2, dimensions: {}, extras: {}, extrasChapter: {} };
    for (const row of rows) {
        const dim = attributeFact(vocab, row.predicate, row.object);
        if (!dim) {
            (card.extras[row.predicate] ??= []).push(row.object);
            const prevChapter = card.extrasChapter[row.predicate];
            if (prevChapter === undefined || row.chapter > prevChapter) {
                card.extrasChapter[row.predicate] = row.chapter;
            }
            continue;
        }
        if (dim.cardinality === "one") {
            const existing = card.dimensions[dim.key];
            // 槽形冲突防御：同 key 已被 many 维度占过（槽上无 value 字段，只有 values 数组）——
            // 入口校验（checkStateVocabularySemantics）已挡撞 key 词表，此处仅兜底存量/异常数据，
            // 跳过该行而非抛 TypeError（PR#452评审P2-C）
            if (existing && !("value" in existing))
                continue;
            // 行序已是最新优先：首个命中即当前值
            if (!existing) {
                card.dimensions[dim.key] = { display_name: dim.display_name, predicate: dim.predicate, value: row.object };
            }
        }
        else {
            const existing = card.dimensions[dim.key];
            // 槽形冲突防御：同 key 已被 one 维度占过（槽上无 values 数组）——同上，跳过不抛
            if (existing && !Array.isArray(existing.values))
                continue;
            const slot = (card.dimensions[dim.key] ??= { display_name: dim.display_name, predicate: dim.predicate, values: [] });
            if (!slot.values.includes(row.object))
                slot.values.push(row.object);
        }
    }
    return card;
}
/** 去空白/标点/符号后比较用的归一化（SSOT：语义检索冗余剔除 readers.ts 复用同一实现，两处正则不得漂移） */
export const normalizeExtraValue = (s) => s.replace(/[\s\p{P}\p{S}]/gu, "");
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
export function dedupeCardExtras(extras, recency) {
    const predicates = Object.keys(extras);
    const norms = new Map();
    for (const predicate of predicates) {
        norms.set(predicate, normalizeExtraValue(extras[predicate].join("、")));
    }
    const discarded = new Set();
    // 1. norm 完全相等的谓词分组，每组只留字典序最小的名字
    const byNorm = new Map();
    for (const predicate of predicates) {
        const norm = norms.get(predicate);
        const group = byNorm.get(norm);
        if (group)
            group.push(predicate);
        else
            byNorm.set(norm, [predicate]);
    }
    for (const group of byNorm.values()) {
        if (group.length <= 1)
            continue;
        const sorted = [...group].sort();
        for (const predicate of sorted.slice(1))
            discarded.add(predicate);
    }
    // 2. 剩余谓词两两比较：norm 是另一条 norm 的子串（且不相等）→ 丢弃信息量小的一方
    const survivors = predicates.filter((predicate) => !discarded.has(predicate));
    for (const a of survivors) {
        const normA = norms.get(a);
        for (const b of survivors) {
            if (a === b)
                continue;
            const normB = norms.get(b);
            if (normA === normB)
                continue; // 已在上一步按相等规则处理
            if (normB.includes(normA)) {
                discarded.add(a);
                break;
            }
        }
    }
    let kept = predicates.filter((predicate) => !discarded.has(predicate));
    // 3. 超过 8 条：有 recency 按章号降序（新者优先）保留 8 个，无 recency 保留最后 8 个（旧行为）
    if (kept.length > 8) {
        if (recency) {
            const ranked = kept.map((predicate, idx) => ({
                predicate,
                idx,
                chapter: recency[predicate] ?? -Infinity,
            }));
            ranked.sort((a, b) => b.chapter - a.chapter || a.idx - b.idx);
            const selected = new Set(ranked.slice(0, 8).map((r) => r.predicate));
            kept = kept.filter((predicate) => selected.has(predicate)); // 保留原相对顺序
        }
        else {
            kept = kept.slice(kept.length - 8);
        }
    }
    const result = {};
    for (const predicate of kept)
        result[predicate] = extras[predicate];
    return result;
}
export function renderCardHumanMap(card) {
    if (!isFoldedCardV2(card))
        return { ...card };
    const flat = {};
    for (const slot of Object.values(card.dimensions)) {
        flat[slot.display_name] = slot.value ?? (slot.values ?? []).join("、");
    }
    for (const [predicate, values] of Object.entries(dedupeCardExtras(card.extras, card.extrasChapter))) {
        flat[predicate] = values.join("、");
    }
    return flat;
}
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
export function readPredicateFromCard(card, predicate, vocab) {
    if (!isFoldedCardV2(card)) {
        const value = card[predicate];
        const trimmed = typeof value === "string" ? value.trim() : "";
        return trimmed || null;
    }
    const extraValues = card.extras[predicate];
    if (extraValues && extraValues.length > 0) {
        const joined = extraValues.join("、").trim();
        if (joined)
            return joined;
    }
    const bySlotPredicate = Object.values(card.dimensions).find((slot) => slot.predicate === predicate);
    if (bySlotPredicate) {
        const value = bySlotPredicate.value ?? (bySlotPredicate.values ?? []).join("、");
        const trimmed = value.trim();
        if (trimmed)
            return trimmed;
    }
    // 回退路径：仅服务无 predicate 字段的旧 v2 历史卡——按「当前」词表反查 display_name，
    // 再用该 display_name 去匹配卡内槽的 display_name（旧卡落库时刻的显示名）；
    // 词表若已改名，两个 display_name 对不上，查不到属已知限制，不抛错优雅返回 null
    const dim = vocab?.dimensions.find((d) => d.predicate === predicate);
    if (dim) {
        const legacySlot = Object.values(card.dimensions).find((slot) => slot.predicate === undefined && slot.display_name === dim.display_name);
        if (legacySlot) {
            const value = legacySlot.value ?? (legacySlot.values ?? []).join("、");
            const trimmed = value.trim();
            if (trimmed)
                return trimmed;
        }
    }
    return null;
}
