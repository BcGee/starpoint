// Battle-mission progress accumulation (STAGE 2) — CONFIRMED against live [BATTLE/stats].
//
// CLIENT CONTRACT (SWF decompile + live traffic capture, 2026-07-03):
//   - Mission screen shows the server's get_mission_progress `progress_value` VERBATIM
//     (CollectItemEventMissionScene). Server owns the number.
//   - Client pushes update_mission_progress ONLY for 5 home/UI missions (MissionCounterLogic).
//     Battle missions are NEVER pushed. mitm confirmed 0 battle pushes.
//   - Battle stats reach the server ONLY via single_battle_quest/finish `statistics`:
//     { max_skill_chain_count, max_combo_count, clear_phase, zones:[...], party, client_checks }.
//   - client_checks is EMPTY for normal quests (미궁/story) — it is NOT the campaign-mission
//     channel. So the server must classify+accumulate from statistics itself.
//   => Server-side accumulation at finish is REQUIRED (confirmed, not guessed).
//
// MISSION CLASSIFICATION (collect_item_event_mission columns, decoded from data + live):
//   questKind ([8]): required content type
//     12 = 흔들리는 미궁  (server QuestCategory.DAILY_EXP_MANA_EVENT = 14; live quest_id 1001)
//     7  = 붕괴역, 2/5/10 = 협력 배틀 (MULTI — no single-player server equivalent → skip)
//     null = any battle (then subCondition decides which stat to count)
//   subCondition ([5]): battle-stat counter kind when questKind is null
//     0=weak_point_attack 1=power_flip 2=dash 4=skill 5=fever 7=enemy_kill  (all "배틀 클리어시 가산")
//     null = not a per-stat counter → fall back to desc (skill-chain N clear / aggregate / 협력)
//
// The zones[] array (one per battle zone) carries the raw counters; we SUM across zones.

export interface FinishZone {
    enemy_kill_count?: number
    zako_kill_count?: number
    boss_kill_count?: number
    use_dash_count?: number
    use_skill_count?: number
    use_power_flip_count?: number
    fever_count?: number
    weak_point_attack_count?: number
    [k: string]: unknown
}

export interface FinishStatistics {
    clear_phase?: number
    max_skill_chain_count?: number
    max_combo_count?: number
    max_power?: number
    client_checks?: number[]
    zones?: FinishZone[]
    party?: unknown
}

export interface MissionDefLite {
    category: number
    eventId?: number
    stage?: number
    pattern: string
    desc: string
    target: number
    subCondition?: number | null
    questKind?: number | null
    questKindTarget?: number | null
    startDate: string | null
    endDate: string | null
}

// Server QuestCategory values (src/lib/types.ts enum order).
const CATEGORY_DAILY_EXP_MANA_EVENT = 14   // 흔들리는 미궁 (live-confirmed quest_id 1001, category 14)

// questKind ([8]) → server quest category that satisfies it. Only single-player-reachable
// content is mapped; co-op (2/5/10) and any unmapped kind → not satisfiable here (skip).
const QUEST_KIND_TO_CATEGORY: Record<number, number> = {
    12: CATEGORY_DAILY_EXP_MANA_EVENT, // 흔들리는 미궁
}

// subCondition ([5]) → summed zones[] counter field.
function subConditionStat(sub: number, zones: FinishZone[]): number {
    const sum = (key: keyof FinishZone) => zones.reduce((a, z) => a + (typeof z[key] === "number" ? (z[key] as number) : 0), 0)
    switch (sub) {
        case 0: return sum("weak_point_attack_count")
        case 1: return sum("use_power_flip_count")
        case 2: return sum("use_dash_count")
        case 4: return sum("use_skill_count")
        case 5: return sum("fever_count")
        case 7: return sum("enemy_kill_count")
        default: return 0
    }
}

// Extracts a leading integer from a description (e.g. "4 스킬 체인..." → 4).
function leadingInt(desc: string): number | null {
    const m = desc.match(/(\d+)/)
    return m ? parseInt(m[1], 10) : null
}

// Returns the progress DELTA to add for a mission given a finished battle.
// clearedCategory = the QuestCategory of the quest that was just cleared.
// Returns 0 when this battle does not advance the mission.
export function battleProgressDelta(
    def: MissionDefLite,
    stats: FinishStatistics,
    clearedCategory: number
): number {
    const zones = Array.isArray(stats.zones) ? stats.zones : []
    const desc = def.desc || ""

    // Aggregate missions ("제N탄 미션 모두 클리어" / "미션을 전부 클리어") are resolved by a
    // separate pass over sibling completion, never per-battle.
    if (desc.includes("미션을 모두 클리어") || desc.includes("미션을 전부 클리어")) return 0

    // 1) questKind ([8]) set → requires a specific content type. Advance +1 only when the
    //    cleared quest's category matches. Co-op / unmapped kinds are not satisfiable → 0.
    if (typeof def.questKind === "number") {
        const requiredCat = QUEST_KIND_TO_CATEGORY[def.questKind]
        if (requiredCat === undefined) return 0            // co-op / unsupported content
        return clearedCategory === requiredCat ? 1 : 0
    }

    // 2) subCondition ([5]) set → per-battle stat counter ("배틀 클리어시 가산"), any battle.
    if (typeof def.subCondition === "number") {
        return subConditionStat(def.subCondition, zones)
    }

    // 3) Neither set → desc-based.
    //    skill-chain clear: "N 스킬 체인을 발동해 배틀 클리어" → +1 if max_skill_chain_count >= N
    if (desc.includes("스킬 체인") || desc.includes("스킬체인")) {
        const n = leadingInt(desc)
        if (n !== null) return (typeof stats.max_skill_chain_count === "number" && stats.max_skill_chain_count >= n) ? 1 : 0
        return 0
    }
    //    combo clear
    if (desc.includes("콤보")) {
        const n = leadingInt(desc)
        if (n !== null) return (typeof stats.max_combo_count === "number" && stats.max_combo_count >= n) ? 1 : 0
        return 0
    }
    //    co-op battle clear ("협력 배틀") — MULTI, no single-player equivalent → skip.
    if (desc.includes("협력")) return 0
    //    generic single-battle clear ("싱글 배틀을 클리어") → +1 per any clear.
    if (desc.includes("싱글 배틀") ) return 1

    // Unknown / not battle-driven (item collection etc.) → don't touch.
    return 0
}
