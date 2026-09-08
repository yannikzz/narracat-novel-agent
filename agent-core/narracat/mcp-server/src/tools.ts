/**
 * NovelMemory MCP Server - 工具定义
 *
 * 共 52 个工具：22 个读工具 + 22 个写工具 + 5 个状态工具（写 state.yaml，不写记忆库）+
 * 1 个身份工具 + 2 个造包中心工具（App 造包中心专用，agent 不得调用）。
 * 写工具入口 ajv + 语义校验，失败统一返回
 * { ok: false, errors: [{field, expected, actual, hint}] }，按 hint 修正后重试。
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ============================================================
  // 读工具 (22)
  // ============================================================
  {
    name: "novel_query",
    description:
      "检索小说记忆，按查询形态自动分流（单点事实→全文+语义；全局弧线→卷/弧摘要；跨角色关系→多跳召回），按章节距离衰减排序。查询词宜短宜具体：人名、物件名、事件短语，或一句话问题",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "查询短语" },
        limit: { type: "integer", minimum: 1, description: "返回条数上限（默认 10）" },
      },
      required: ["query"],
    },
  },
  {
    name: "novel_chapter_summary",
    description: "查章节摘要：单章（chapter）、范围（from+to）或全部（无参数）",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "单章章号（与 from/to 互斥）" },
        from: { type: "integer", minimum: 1, description: "起始章号" },
        to: { type: "integer", minimum: 1, description: "结束章号" },
      },
      required: [],
    },
  },
  {
    name: "novel_character_state",
    description:
      "查角色截至某章的状态卡（按 character_uid）：受控谓词事实按最新值折叠，附完整有效事实清单",
    inputSchema: {
      type: "object",
      properties: {
        character_uid: {
          type: "string",
          description: "角色 character_uid（取自角色档案 character_identity）",
        },
        at_chapter: {
          type: "integer",
          minimum: 1,
          description: "截至章号（省略 = 最新已入库章）",
        },
      },
      required: ["character_uid"],
    },
  },
  {
    name: "novel_character_statuses",
    description:
      "批量查多个角色截至某章的当前状态（facts.status 折叠 + character_cards 兜底）。返回 statuses 只含有状态的 uid。供联系人列表等批量富化用",
    inputSchema: {
      type: "object",
      properties: {
        character_uids: {
          type: "array",
          items: { type: "string" },
          description: "角色 character_uid 列表（取自角色档案 character_identity）",
        },
        at_chapter: {
          type: "integer",
          minimum: 1,
          description: "截至章号（省略 = 最新已入库章）",
        },
      },
      required: ["character_uids"],
    },
  },
  {
    name: "novel_relationship",
    description: "查两个角色的关系当前状态与演变历史（按 character_uid，两序自动匹配）",
    inputSchema: {
      type: "object",
      properties: {
        character_a_uid: { type: "string", description: "角色 A 的 character_uid" },
        character_b_uid: { type: "string", description: "角色 B 的 character_uid" },
        at_chapter: {
          type: "integer",
          minimum: 1,
          description: "截至章号（省略 = 最新）",
        },
      },
      required: ["character_a_uid", "character_b_uid"],
    },
  },
  {
    name: "novel_foreshadowing_status",
    description:
      "查伏笔清单与状态。状态从动作日志最新动作机械导出：registered / planted / developing / revealed",
    inputSchema: {
      type: "object",
      properties: {
        active: {
          type: "boolean",
          description: "true = 只看未揭示的；false = 只看已揭示的；省略 = 全部",
        },
        chapter: { type: "integer", minimum: 1, description: "截至章号（省略 = 最新）" },
      },
      required: [],
    },
  },
  {
    name: "novel_foreshadowing_density",
    description:
      "查伏笔计划兑现度（chapter / arc_id / volume 三选一）：expected = 大纲计划数，actual = 正文兑现数",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "章号" },
        arc_id: { type: "string", description: "arc 标识，如 \"V01-A02\"" },
        volume: { type: "integer", minimum: 1, description: "卷号" },
      },
      required: [],
    },
  },
  {
    name: "novel_get_arc",
    description:
      "按 arc_id 或章号查 arc 元信息（区间、核心问题、不可逆变化、下一 arc 种子、爽点）与所在卷边界。章号无所属 arc 时 found=false",
    inputSchema: {
      type: "object",
      properties: {
        arc_id: { type: "string", description: "arc 标识，如 \"V01-A02\"（与 chapter 二选一）" },
        chapter: { type: "integer", minimum: 1, description: "章号，反查所属 arc" },
      },
      required: [],
    },
  },
  {
    name: "novel_check_prose_hygiene",
    description:
      "机械扫第 chapter 章正文的 AI 腔马脚，代码算不用 LLM。三条线：① 硬密度门（破折号密度 + 「不是X是Y」对仗密度/同段连排），超标进 errors[]+hint 供定点擦除自修正；② fingerprint_findings（洁净词库命中：万能副词、神态模板、动作套话、翻案腔、洞察路标、名词化等，带命中位置与改写方向）；③ shape_findings（句段形状：句长彼此过近、叙述被切碎、短段鼓点、主干来太晚、长定语堆叠、同构排比、开场重复、连词偏密，带段号定位）。后两条 finding-only 不影响 ok。只扫机械形状、不判文笔好坏；阈值贴真书密度留余量，只杀明显超标",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "被扫描的章节号" },
      },
      required: ["chapter"],
    },
  },
  {
    name: "novel_get_review",
    description: "查某章审校结论：{verdict: pass|fail, blockers, notes}。主会话据此路由修复",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "被审章节号" },
      },
      required: ["chapter"],
    },
  },
  {
    name: "novel_failed_reviews",
    description:
      "列出所有未过审（verdict=fail）的章节号清单，供 /status 等汇总未通过审校的章节",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "novel_get_structure_budget",
    description:
      "读 config 篇幅参数算结构预算表：tier、卷数带宽、arc 跨度、storyline 条数、伏笔预算、payoff_beats 下限。规划与校验共用同一公式",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "novel_get_grid_benchmark",
    description:
      "读本书已提交章纲的章末钩 none 率与爽点间隔，对照 59 部头部网文实测分布（按驱动特征桶：高频小爽/中大爽升级/攒糖引爆，样本不足或题材归位不上时回退全局分布）给一句中文读数。只读、只度量，不影响提交",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "novel_get_arc_velocity_target",
    description:
      "取本书 arc 层定速靶（阶段一排 arc 前的前馈）：按驱动特征桶给出主线连续休眠上限与开局推进占比下沿（蒸馏自 59 部头部网文逐章推进力分布），brief 是随包投递给架构师的人话靶。只读、只度量，不影响提交",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "novel_writing_context",
    description:
      "轻量写作上下文聚合（主会话对话用）：前 3 章 brief、角色状态卡、伏笔 due-list、本章故事线聚焦、所属 arc",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "目标章节号" },
      },
      required: ["chapter"],
    },
  },
  {
    name: "novel_build_writing_context_pack",
    description:
      "构建 WritingContextPack 并落盘 .narracat/context-packs/ch-NNN.json：细纲全文 + 风格指令 + 真人范例 + 热层/温层记忆 + 角色状态卡 + 伏笔 due-list + 故事线聚焦 + 语义检索。区块超预算硬截断；连贯性预警随包 warnings 喂写手，截断/降级诊断仅经工具返回值回主会话",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "即将撰写的章节号" },
      },
      required: ["chapter"],
    },
  },
  {
    name: "novel_query_style_reference",
    description:
      "按写作手法 × 情感氛围检索真人小说范例段落（含机制注解）。手法值域：对话设计、心理刻画、环境描写、动作细节、节奏控制、情感渲染、视角运用、悬念设置",
    inputSchema: {
      type: "object",
      properties: {
        technique: {
          type: "array",
          items: { type: "string" },
          description: "手法标签列表（至少 1 个）",
        },
        emotion: {
          type: "array",
          items: { type: "string" },
          description:
            "情感标签列表（可选，0-2 个）。值域：紧张、悲伤、愤怒、暧昧、幽默、温暖、释然、震撼",
        },
        limit: { type: "integer", minimum: 1, description: "返回条数上限（默认 3，最大 8）" },
      },
      required: ["technique"],
    },
  },

  {
    name: "novel_list_candidate_characters",
    description:
      "列候选角色池（ADR-0015 渐进生长：尚未建档、不强制完整设定的待出场角色）。省略 status = 只列待出场 candidate；status='promoted' 列已建档的；status='all' 列全部。importance='major' 只列重要候选（写完正文提醒用，ADR-0023）。供主会话识别「这名字是否已留过候选」、供 App 渲染候选池入口",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["candidate", "promoted", "all"],
          description: "candidate（待出场，默认）/ promoted（已建档）/ all（全部）",
        },
        importance: {
          type: "string",
          enum: ["minor", "major"],
          description:
            "重要度过滤（省略 = 全部）：major 只列重要候选（写完正文提醒只用这档）/ minor 只列次要候选",
        },
      },
      required: [],
    },
  },
  {
    name: "novel_extraction_scaffold",
    description:
      "抽取脚手架（memory-keeper 专用只读工具）：角色别名表 + 前文已知 facts 摘要 + 受控谓词 cheatsheet，帮助弱模型归一角色名、判断 change_type、选谓词。chapter 传当前抽取章号",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "当前抽取的章节号" },
      },
      required: ["chapter"],
    },
  },
  {
    name: "novel_detect_conflicts",
    description:
      "生成后时序 / 状态冲突检测（只读、只标不改）：扫描有效 facts，机械检出设定漂移（单值谓词多值并存）、死而复生（终结状态后仍有新事实）、关系矛盾，产出可读冲突报告供修订。chapter 省略=全书扫描，给定=聚焦该章引入的冲突",
    inputSchema: {
      type: "object",
      properties: {
        chapter: {
          type: "integer",
          minimum: 1,
          description: "聚焦该章引入的冲突（省略=全书扫描）",
        },
      },
      required: [],
    },
  },
  {
    name: "novel_get_character_dialogue_samples",
    description:
      "按 character_uid 取该角色的真实台词语料（声音支柱 A）：A2 说话风格卡的取料读路径。可按章范围 / dialogue_type 过滤，默认取 20 条，按 chapter / position 升序；total 反映全部匹配（截断前）",
    inputSchema: {
      type: "object",
      properties: {
        character_uid: {
          type: "string",
          description: "要查询台词的角色 character_uid（机器主键，见档案 character_identity）",
        },
        chapter_start: { type: "integer", minimum: 1, description: "起始章号（含，可选）" },
        chapter_end: { type: "integer", minimum: 1, description: "结束章号（含，可选）" },
        dialogue_type: {
          type: "string",
          enum: ["dialogue", "monologue", "thought", "action_narration"],
          description: "按台词类型过滤（可选）",
        },
        limit: { type: "integer", minimum: 1, description: "最多返回条数（可选，默认 20）" },
      },
      required: ["character_uid"],
    },
  },
  {
    name: "novel_list_structure_cards",
    description:
      "列出指定规划阶段可用的书级/章级结构手法卡（stage-1 书级 storylines/伏笔/arc、stage-2 章级细纲、stage-opening 全书开局），返回 id/path（绝对路径，供 Read 全文）/dimension/one_line/origin。规划前先调用本工具取清单，再逐张 Read 卡内容",
    inputSchema: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          enum: ["stage-1", "stage-2", "stage-opening"],
          description: "规划阶段：stage-1（书级）/ stage-2（章级）/ stage-opening（全书开局）",
        },
      },
      required: ["stage"],
    },
  },

  // ============================================================
  // 写工具 (22) —— 每个 agent 只持有自己产物的提交工具
  // ============================================================
  {
    name: "novel_commit_chapter",
    description:
      "章节收尾一次性提交（memory-keeper）：叙事摘要 + 锚点 + 关键事件 + 可继续写的戏 + 伏笔动作。字数、首尾片段由工具读正文机械补全，并写 receipt 文件",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "章节号" },
        summary: {
          type: "string",
          description: "200-500 字叙事摘要：具体动作、代价、未解压力，禁标签化",
        },
        anchor: {
          type: "object",
          description: "本章锚点",
          properties: {
            core_experience: { type: "string", description: "核心体验一句话" },
            heartbeat_moment: { type: "string", description: "最有戏的瞬间一句话" },
          },
          required: ["core_experience", "heartbeat_moment"],
        },
        key_events: {
          type: "array",
          items: { type: "string" },
          maxItems: 5,
          description: "关键事件，最多 5 条",
        },
        characters_appeared: {
          type: "array",
          items: { type: "string" },
          description: "本章出场角色名",
        },
        emotional_tone: { type: "string", description: "本章情绪基调短语" },
        continuation_hook: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 3,
          description: "1-3 条「可继续写的戏」：悬而未决的压力 / 未兑现的威胁或承诺",
        },
        foreshadowing_actions: {
          type: "array",
          description: "本章实际触达的伏笔动作",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "已注册的伏笔 id" },
              action: { type: "string", enum: ["plant", "develop", "reveal"] },
            },
            required: ["id", "action"],
          },
        },
        timeline_note: { type: "string", description: "本章时间跨度或时间点（可选）" },
      },
      required: [
        "chapter",
        "summary",
        "anchor",
        "key_events",
        "characters_appeared",
        "emotional_tone",
        "continuation_hook",
      ],
    },
  },
  {
    name: "novel_submit_extraction",
    description:
      "事实变更清单提交（memory-keeper）：受控谓词三元组 + 关系更新。工具做词表校验、别名归一与生效区间维护",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "来源章节号" },
        facts: {
          type: "array",
          description: "事实变更，每条 {subject, predicate, object, change_type, upsert_key?}",
          items: {
            type: "object",
            properties: {
              subject: { type: "string", description: "主体正式名称" },
              predicate: {
                type: "string",
                description:
                  "受控谓词：identity / location / possession / goal / injury / ability / status / secret / reputation / oath / debt / relationship；表外用 x- 前缀自拟中文短名（如 x-恐惧），后缀会原样展示给作者",
              },
              object: { type: "string", description: "值，一句话" },
              change_type: {
                type: "string",
                enum: ["new", "update", "invalidate"],
                description: "new=新事实 / update=替换旧值 / invalidate=仅失效",
              },
              upsert_key: { type: "string", description: "定位既有事实的 id（可选）" },
            },
            required: ["subject", "predicate", "object", "change_type"],
          },
        },
        relationship_updates: {
          type: "array",
          description: "关系变化，每条 {a, b, state}",
          items: {
            type: "object",
            properties: {
              a: { type: "string", description: "角色名" },
              b: { type: "string", description: "角色名" },
              state: { type: "string", description: "当前关系状态一句话" },
            },
            required: ["a", "b", "state"],
          },
        },
      },
      required: ["chapter", "facts"],
    },
  },
  {
    name: "novel_stage_extraction",
    description:
      "单轮抽取暂存（memory-keeper）：与 novel_submit_extraction 同构入参 + 同一套词表校验、别名归一、生效区间语义，但只把本轮已解析事实写入暂存，不进正式记忆、不建索引。多轮各调一次（带 run_id），最后由 novel_commit_extraction_union 取并集一次落库",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "来源章节号" },
        run_id: {
          type: "integer",
          minimum: 1,
          maximum: 9,
          description: "本轮抽取编号，任务 envelope 里给定，照传",
        },
        facts: {
          type: "array",
          description: "事实变更，每条 {subject, predicate, object, change_type, upsert_key?}",
          items: {
            type: "object",
            properties: {
              subject: { type: "string", description: "主体正式名称" },
              predicate: {
                type: "string",
                description:
                  "受控谓词：identity / location / possession / goal / injury / ability / status / secret / reputation / oath / debt / relationship；表外用 x- 前缀自拟中文短名（如 x-恐惧），后缀会原样展示给作者",
              },
              object: { type: "string", description: "值，一句话" },
              change_type: {
                type: "string",
                enum: ["new", "update", "invalidate"],
                description: "new=新事实 / update=替换旧值 / invalidate=仅失效",
              },
              upsert_key: { type: "string", description: "定位既有事实的 id（可选）" },
            },
            required: ["subject", "predicate", "object", "change_type"],
          },
        },
        relationship_updates: {
          type: "array",
          description: "关系变化，每条 {a, b, state}",
          items: {
            type: "object",
            properties: {
              a: { type: "string", description: "角色名" },
              b: { type: "string", description: "角色名" },
              state: { type: "string", description: "当前关系状态一句话" },
            },
            required: ["a", "b", "state"],
          },
        },
      },
      required: ["chapter", "run_id", "facts"],
    },
  },
  {
    name: "novel_commit_extraction_union",
    description:
      "多采样并集落库（主会话）：读该章所有暂存轮、按 (主体, 谓词, 值) 全等去重取并集（跨轮冲突取更强 change_type），走与 submit 同一段落库逻辑一次写入正式记忆，随后清空该章暂存。返回 staged_runs / facts_committed / facts_invalidated / facts_deduped",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "要落并集的章号" },
      },
      required: ["chapter"],
    },
  },
  {
    name: "novel_consolidate",
    description:
      "arc / 卷压缩摘要提交（memory-keeper，边界时调用）：upsert 温层摘要并机械刷新区间内出场角色的状态卡",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["arc", "volume"], description: "压缩范围" },
        scope_id: {
          type: "string",
          description: "arc_id（如 \"V01-A02\"）或卷标识（如 \"vol-01\"）",
        },
        summary: {
          type: "string",
          description: "叙事压缩摘要：arc 300-500 字 / volume 500-800 字，保留不可逆变化、代价与悬着的线",
        },
      },
      required: ["scope", "scope_id", "summary"],
    },
  },
  {
    name: "novel_submit_review",
    description:
      "审校结果提交（continuity-editor）：问题清单 {severity, where, what, fix_hint}。verdict 由代码算（有 blocker 即 fail），审校报告由工具机械渲染",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "被审章节号" },
        issues: {
          type: "array",
          description: "问题清单，无问题提交空数组",
          items: {
            type: "object",
            properties: {
              severity: {
                type: "string",
                enum: ["blocker", "note"],
                description: "blocker=确认的客观错误；note=存疑不影响结论",
              },
              where: { type: "string", description: "问题位置" },
              what: { type: "string", description: "错在哪，含证据" },
              fix_hint: { type: "string", description: "一句可执行的修法" },
            },
            required: ["severity", "where", "what", "fix_hint"],
          },
        },
      },
      required: ["chapter", "issues"],
    },
  },
  {
    name: "novel_submit_premise",
    description:
      "立项卡提交（setup 主会话 / 立项卡定点修订）：九卡 cards[]，每卡 fields 带确定度 certainty（canon/tentative/open，默认 canon）。入口 ajv 校验通过后入库，并机械渲染只读 premise.md + 落数据契约 premise-cards.json。第 9 留白声明由确定度自动汇总、不提交",
    inputSchema: {
      type: "object",
      properties: {
        payload: {
          type: "object",
          description:
            "PremiseCards 顶层对象（字段定义见 schemas/premise-cards.json）：{ cards: [{ card, fields: [{ key, value, certainty?, note? }] }] }。card 取 genre_contract / core_hook / golden_finger / protagonist_desire / antagonistic_force / central_dramatic_question / world_rules / narrator_voice；world_rules 每条 note 记「让谁和谁打起来」；narrator_voice 的 field.key 用英文 archetype/tone/pacing/ornamentation/digression/address/style_keywords/reference_inspiration/reference_example",
        },
        sync_engine_facts: {
          type: "boolean",
          description:
            "默认 false。为 true 时把与大纲重叠的四项立项卡内容同步到 subject='全书' facts（central_dramatic_question / protagonist_core_desire ← surface_want / protagonist_core_lack ← deep_need / antagonistic_force），并回灌已渲染的 outline-structure.json 与 master-outline.md 同名字段，使记忆与用户可见大纲一致。仅地基卡内容修订流程传 true；setup 全量立项与 App 信心标记不传（保持 facts 不变）。open/空值字段跳过、不覆盖既有 fact",
        },
        merge_cards: {
          type: "boolean",
          description:
            "默认 false（payload.cards 整体覆盖入库）。为 true 时按 card key 把 payload 提交的卡并入现有 cards_json、未提交的卡原样保留——定点修订只提交目标卡（完整 fields）时用，避免漏卡导致其余立项卡丢失。setup 全量立项与 App 信心标记不传",
        },
      },
      required: ["payload"],
    },
  },
  {
    name: "novel_submit_outline",
    description:
      "书级 + 卷级大纲提交（outline-architect）：引擎 5 字段 + storylines + 伏笔注册表 + 卷与 arc。入口 ajv + 结构预算核验，通过后入库并机械渲染 master-outline.md 与 vol-outline.md。支持两段制：scope=book 只提交书级骨架（卷结构渲染为待展开）；scope=volume 在书级确认后逐卷提交（每次只带本卷，其余卷保留，推荐——单次调用体量与卷数无关）；scope=volumes 整组提交卷级（本次集合即最终集合，用于整体重排）",
    inputSchema: {
      type: "object",
      properties: {
        phase: { type: "integer", enum: [1], description: "可省略；本工具只受理书级+卷级，章级细纲改用 novel_submit_chapter_outline" },
        scope: {
          type: "string",
          enum: ["full", "book", "volumes", "volume"],
          description:
            "提交形态（缺省 full）：full=书级+卷级一次提交；book=只提交书级骨架（payload 不含 volumes）；volume=逐卷提交（payload 只需 { volumes: [本卷] }，同号卷覆盖、新卷追加、其余卷保留，从不删卷）；volumes=整组提交卷级（payload { volumes: [全部卷] }，未列出的卷会被清理，仅用于整体重排）。卷级提交书级一律以库内为准",
        },
        payload: {
          type: "object",
          description:
            "OutlineStructure 顶层对象（字段定义见 schemas/outline-structure.json）：central_dramatic_question / protagonist_core_desire / protagonist_core_lack / antagonistic_force / stakes_progression / storylines / foreshadowing_registry / volumes（scope=book 时省略；scope=volume / volumes 时只需 volumes）",
        },
      },
      required: ["payload"],
    },
  },
  {
    name: "novel_submit_chapter_outline",
    description:
      "章级细纲批量提交（outline-architect，单批 ≤4 个 arc 的章）：入库 + 机械渲染 outline/vol-VV/ch-NNN.md + 写故事线聚焦与伏笔计划",
    inputSchema: {
      type: "object",
      properties: {
        payload: {
          type: "array",
          description:
            "章级细纲数组，每章 {chapter, title, positioning, beats[], must_deliver[]?, payoff_beat?, end_hook, storyline_focus[], characters[], pov_character, foreshadowing_touch[]?}；positioning/beats/must_deliver 用中文故事语言（不写字段名/英文枚举/编号/破折号）；pov_character 与 characters[] 用 CharacterReference {character_uid, name}（字段定义见 schemas/outline-structure.json $defs/chapter_outline）",
          items: { type: "object" },
        },
      },
      required: ["payload"],
    },
  },
  {
    name: "novel_register_foreshadowing",
    description: "伏笔单条补登：写入注册表，既有埋设章号保留不覆盖",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "伏笔唯一标识，大写字母开头，如 \"F-CELLAR-01\"" },
        type: {
          type: "string",
          enum: ["small", "medium", "major"],
          description: "small=arc 内兑现 / medium=本卷内兑现 / major=跨卷兑现",
        },
        description: { type: "string", description: "伏笔内容描述" },
        planted_chapter: { type: "integer", minimum: 1, description: "计划埋设章号" },
        target_reveal: {
          type: "string",
          description: "计划兑现锚点：章号字符串（如 \"120\"）或卷级粗锚点（如 \"vol-08\"）",
        },
        theme_link: { type: "string", description: "与中心戏剧问题的联系（可选）" },
      },
      required: ["id", "type", "description", "planted_chapter", "target_reveal"],
    },
  },
  {
    name: "novel_update_outline_book_field",
    description:
      "书级大纲定点机械更新（无 LLM 判断）：赌注递增曲线 / 故事线名称 / 伏笔描述三类，原子同步 DB 记忆、outline-structure.json 与 master-outline.md，带乐观锁。中心戏剧问题等立项卡映射字段不在此工具范围（走 novel_submit_premise）。",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["stakes_progression", "storyline_name", "foreshadowing_description"],
        },
        id: { type: "string", description: "storyline_name/foreshadowing_description 时的条目 id" },
        new_value: { type: "string", description: "新内容" },
        expected_old_value: { type: "string", description: "当前内容原文（乐观锁）" },
      },
      required: ["target", "new_value", "expected_old_value"],
    },
  },
  {
    name: "novel_rollback_chapter",
    description:
      "回滚章节记忆（重写场景）：删除该章及之后的摘要 / 事实 / 兑现动作 / 审校信号 / 温层摘要，恢复曾被失效的旧事实，重折叠角色卡",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "从该章开始回滚（含本章）" },
      },
      required: ["chapter"],
    },
  },

  {
    name: "novel_register_candidate_character",
    description:
      "登记候选角色（ADR-0015 渐进生长内容实例层）：plan/write 期引入未建档角色、作者选「留作候选」时入池，不强制完整设定、不打断创作流。name 必填；character_uid 可省略（工具自动铸 lowercase UUID v4），建档时复用同一 UID。重复 UID upsert；status='promoted' 表示该候选已转正式角色档案（建档后回写、从候选清单淡出）",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "候选角色显示名（必填）" },
        character_uid: {
          type: "string",
          description:
            "canonical 身份（lowercase UUID v4）。新候选可省略由工具铸造；建档时传既有 UID 复用同一身份",
        },
        note: {
          type: "string",
          description: "一句话备注：将来这角色是谁 / 做什么用（可选）",
        },
        proposed_chapter: {
          type: "integer",
          minimum: 1,
          description: "计划首次出场/被提及的章号（可选）",
        },
        source: {
          type: "string",
          enum: ["plan", "write", "manual"],
          description: "引入来源：plan（大纲规划）/ write（写作中）/ manual（作者手动），默认 write",
        },
        status: {
          type: "string",
          enum: ["candidate", "promoted"],
          description: "candidate（待出场，默认）/ promoted（已建档，建档后回写）",
        },
        importance: {
          type: "string",
          enum: ["minor", "major"],
          description:
            "重要度（ADR-0023）：minor（次要，进池静默、写完正文不提醒，默认）/ major（重要，写完正文提醒作者建档）。一次性龙套不登记本表、不传此参。省略 = 保留既有（promote 回写不清掉）/ 新行落 minor",
        },
        initial_relationships: {
          type: "array",
          description:
            "候选与已建档角色的初始关系草稿（可选）；转正建档时由 world 回写为正式关系。省略则保留既有草稿",
          items: {
            type: "object",
            required: ["other_character_uid", "state"],
            properties: {
              other_character_uid: {
                type: "string",
                description: "已建档角色的 character_uid（此候选将与其建立关系）",
              },
              state: {
                type: "string",
                description: "初始关系状态一句话，如「表面盟友，互相提防」",
              },
            },
          },
        },
      },
      required: ["name"],
    },
  },

  {
    name: "novel_submit_dialogue_samples",
    description:
      "角色台词语料提交（memory-keeper；声音支柱 A）：逐章提取的角色对白 / 独白 / 心理 / 动作旁白原文，工具做校验、别名归一到 character_uid 后落库。未归一到 uid 的样本计入 warnings 并跳过。逐字摘录、不改写不编造",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "来源章节号" },
        samples: {
          type: "array",
          description: "本章提取的台词样本列表，无台词可提交空数组",
          items: {
            type: "object",
            properties: {
              character: {
                type: "string",
                description: "角色显示名（提取时使用的名字，别名归一在工具入口完成）",
              },
              dialogue_text: {
                type: "string",
                description: "台词原文，逐字摘录不改写不编造，不超过 500 字符",
              },
              dialogue_type: {
                type: "string",
                enum: ["dialogue", "monologue", "thought", "action_narration"],
                description:
                  "dialogue=对话台词 / monologue=独白 / thought=心理活动 / action_narration=动作旁白",
              },
              context: { type: "string", description: "台词所处场景背景（可选）" },
              emotion: {
                type: "string",
                description: "台词当时的情绪（可选，如 angry / calm / sarcastic）",
              },
              position_in_chapter: {
                type: "integer",
                minimum: 0,
                description: "台词在章节中的大致位置（可选，段落序号）",
              },
            },
            required: ["character", "dialogue_text", "dialogue_type"],
          },
        },
      },
      required: ["chapter", "samples"],
    },
  },
  {
    name: "novel_submit_state_vocabulary",
    description:
      "本书状态词表提交（world-curator）：把受控谓词投影为作者视角的状态维度（显示名 + one/many + enum 值域梯子）。入口 ajv 校验通过后覆盖写 bible/state-vocabulary.json。角色卡折叠 / 实体初始状态 / 编辑 UI / 抽取 cheatsheet 共享此表。只声明本书需要的维度，不强凑",
    inputSchema: {
      type: "object",
      properties: {
        payload: {
          type: "object",
          description:
            "StateVocabulary 顶层对象（字段定义见 schemas/state-vocabulary.json）：{ dimensions: [{ key, predicate, display_name, cardinality, value_type, values? }] }。key 英文 snake_case 稳定标识；enum 维度必带 values 梯子（顺序即递进序），values 一律用中文（作品语言）——会原样进状态卡与写作上下文，英文机器名只允许出现在 key",
        },
      },
      required: ["payload"],
    },
  },
  {
    name: "novel_submit_character_entity",
    description:
      "角色结构化实体提交（world-curator）：身份字段（uid/名字/别名/性别/年龄）+ 初始状态（从状态词表维度取值）。入口 ajv + 词表值域校验，通过后写 bible/characters/<name>.json、机械同步 md 顶部身份注释与别名行、初始状态入 authored facts（生效章默认 0，候选转正传出场章）并刷新角色卡。重复提交幂等（同值跳过、单值维度换值旧账失效留审计）。渐进式纪律：建书期只提交主角/主反派/作者点名的核心角色，其余角色出场或转正时再补",
    inputSchema: {
      type: "object",
      properties: {
        payload: {
          type: "object",
          description:
            "CharacterEntity 顶层对象（字段定义见 schemas/character-entity.json）：{ character_uid?, name, aliases?, gender?, age?, effective_chapter?, initial_states?: [{ dimension, value, note? }] }。character_uid 省略由工具铸造；候选转正必须传既有 UID 复用身份",
        },
      },
      required: ["payload"],
    },
  },
  {
    name: "novel_submit_authored_state",
    description:
      "作者对角色结构化状态的直接修订（App 确定性直调，不进 agent 工具面）。payload 按 schemas/authored-state.json：action=set_current 钦定当前值（显式生效章）/ backfill 补录历史 / correct 纠错改历史（失效链审计）/ retract 作废记录 / endorse 把抽取记录背书为作者确认。",
    inputSchema: {
      type: "object",
      properties: {
        payload: { type: "object", description: "AuthoredState 对象，字段见 schemas/authored-state.json" },
      },
      required: ["payload"],
    },
  },
  {
    name: "novel_submit_style_anchor",
    description:
      "本书声音样章锚的标记与删除（App 确定性直调，不进 agent 工具面）：action=add 传 chapter+excerpt（80-400 字、须是该章正文原话、每本最多 3 段）/ remove 传 anchor_id。excerpt 存标记时的正文快照，正文事后改动不回溯。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove"], description: "add=标记 / remove=删除" },
        chapter: { type: "integer", minimum: 1, description: "add 必填：段落所在章号" },
        excerpt: { type: "string", description: "add 必填：段落原文（80-400 字）" },
        anchor_id: { type: "string", description: "remove 必填：要删除的样章 id" },
      },
      required: ["action"],
    },
  },
  {
    name: "novel_list_style_anchors",
    description:
      "列出本书已标记的声音样章（App 确定性直调，不进 agent 工具面）：按标记时间倒序返回 anchor_id / chapter / excerpt / created_at 与上限。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "novel_check_state_delivery",
    description:
      "计划状态变更兑现比对（主会话，write 收尾在 novel_commit_extraction_union 之后调用）：本章 planned 计划行逐条与已落库 facts 机械匹配（uid+维度谓词+值精确+章号，set/add 看本章生效事实、remove 看本章失效痕迹），命中自动落 delivered，未命中返回报告卡数据（软门只报告不阻断，处置权归作者）",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "本次完成写作的章号" },
      },
      required: ["chapter"],
    },
  },
  {
    name: "novel_resolve_planned_state",
    description:
      "计划状态变更处置落账（App 确定性直调，不进 agent 工具面）：兑现报告卡四动作之三态迁移——defer 移到后续章（原行留审计+目标章新行）/ cancel 取消 / acknowledge 已知悉不再报警 / mark_delivered 标记已兑现（配合作者补录）。只受理 status=planned 的行",
    inputSchema: {
      type: "object",
      properties: {
        payload: {
          type: "object",
          description: "{ id: 计划行 id, action: defer|cancel|acknowledge|mark_delivered, to_chapter?: defer 的目标章（须大于原计划章） }",
        },
      },
      required: ["payload"],
    },
  },
  {
    name: "novel_update_chapter_state_changes",
    description:
      "章纲计划状态变更整段替换（App 确定性直调，不进 agent 工具面）：作者在章纲卡编辑本章 state_changes——语义门与提交侧同规（维度∈词表/enum 值域/operation×cardinality），json+md+计划表由本工具协调写入（文件先行+失败补偿，镜像遵 #448 只清 planned 纪律），CAS 防并发",
    inputSchema: {
      type: "object",
      properties: {
        payload: {
          type: "object",
          description: "{ chapter, state_changes: 完整集合（≤8，空数组合法）, expected_state_changes: 读取时快照（CAS） }",
        },
      },
      required: ["payload"],
    },
  },

  // ============================================================
  // 状态工具 (5) —— 写 state.yaml / staging 正文，不写记忆库；LLM 对 state.yaml 零直写
  // ============================================================
  {
    name: "novel_sync_structure",
    description:
      "同步全书结构到 state.yaml structure 节：卷数 / 总章数 / 章到卷映射三者互证，任一不过整体拒写。本工具是 structure 节唯一写入通道",
    inputSchema: {
      type: "object",
      properties: {
        total_volumes: { type: "integer", minimum: 1, description: "全书总卷数" },
        total_chapters_planned: { type: "integer", minimum: 1, description: "全书规划总章数" },
        chapter_to_volume: {
          type: "object",
          description: "完整章到卷映射：键为章号（1..N 全覆盖），值为卷号（单调不减）",
          additionalProperties: { type: "integer" },
        },
      },
      required: ["total_volumes", "total_chapters_planned", "chapter_to_volume"],
    },
  },
  {
    name: "novel_update_progress",
    description:
      "章节收尾后更新进度：completed_chapters 去重排序、last_completed、字数读文件实算、清 checkpoint，整体安全写 state.yaml；默认校验最终正文与最后一次审校 PASS 的指纹一致，不一致拒绝",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "刚完成的章节号" },
      },
      required: ["chapter"],
    },
  },
  {
    name: "novel_restore_progress",
    description:
      "作者手改正文后的记忆同步链路专用：恢复章节完成进度（完成集合、字数、checkpoint 清理），不做审校新鲜度校验。仅 /sync-chapter-memory 持有",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "要恢复进度的章节号" },
      },
      required: ["chapter"],
    },
  },
  {
    name: "novel_checkpoint",
    description: "机械写 state.yaml checkpoint 节（last_command / last_step / timestamp）",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "当前命令名，如 \"write\"" },
        step: { type: "integer", description: "当前步骤编号" },
        chapter: { type: "integer", minimum: 1, description: "当前章节号（可选）" },
      },
      required: ["command", "step"],
    },
  },
  {
    name: "novel_check_manuscript_contract",
    description:
      "/write 写手完成后立即预检本章草稿的机械合同：非空/字数下限/无围栏/无前言/未截断为硬项，超上限/引号为软提醒；顺手把 ASCII 引号包中文机械归一为弯引号；无草稿一律放行",
    inputSchema: {
      type: "object",
      properties: {
        chapter: { type: "integer", minimum: 1, description: "要预检的章节号" },
      },
      required: ["chapter"],
    },
  },

  // ============================================================
  // 身份工具 (1) —— 确定性铸造 canonical 主键，不入库、无副作用
  // ============================================================
  {
    name: "novel_mint_character_uid",
    description:
      "为新角色铸造 canonical Character UID（lowercase UUID v4）。角色设定落盘前调用、写入 character_identity；update 既有角色不调用、保留原 UID",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },

  // ============================================================
  // 造包中心工具 (2) —— App 造包中心专用；agent 不得调用
  // ============================================================
  {
    name: "novel_pack_authoring_vocab",
    description:
      "造包中心受控词表与典型情境/声音清单：情感标签、写作手法标签、结构阶段、典型情境（用于 craft 选卡预览）、典型声音画像（用于 persona 选卡预览）。App 造包中心专用；agent 不得调用",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "novel_pack_authoring_preview",
    description:
      "造包中心卡片干跑预览（craft 场景竞争 / persona 声音匹配）：把草稿卡当作 user 来源候选注入真实候选池，逐个典型情境（craft）或典型声音画像（persona）跑一遍机械选卡，返回是否会被选中与理由。structure 卡装载预览由 App 本地映射，不经此工具。App 造包中心专用；agent 不得调用",
    inputSchema: {
      type: "object",
      properties: {
        card: {
          type: "object",
          description:
            "manifest 卡条目对象，type=persona|craft。persona 卡需 id/name/keywords[]；craft 卡需 id/triggers[]/emotion_tags[]/exclusions[]/priority",
        },
      },
      required: ["card"],
    },
  },
];
