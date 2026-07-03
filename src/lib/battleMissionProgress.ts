// Battle-mission progress accumulation (STAGE 2).
//
// CLIENT CONTRACT (confirmed by SWF decompile of World Flipper 0.0.81):
//   - The mission-detail screen (CollectItemEventMissionScene.remoteInput / applyMissionProgress)
//     displays the server's get_mission_progress `progress_value` VERBATIM — there is
//     NO client-side progress calculation for the number shown. So the server owns the
//     progress number.
//   - The client pushes progress via update_mission_progress ONLY for 5 home/UI missions
//     (MissionCounterLogic: character_detail_zoom / dot_sp_motion / home_tap_town /
//     home_change_voice / twitter_check). Battle missions are NEVER pushed there.
//   - Battle stats DO reach the server: single_battle_quest/finish request body carries
//     `statistics` = { max_power, max_skill_chain_count, max_combo_count, clear_phase,
//     zones, party, client_checks }. `client_checks` = array of cleared client-check ids
//     (MissionClientCheckManager.getClearedIds — special conditions like debuff/boss-cutin).
//   => Therefore battle mission progress MUST be accumulated server-side at finish.
//
// This module maps a finished battle to the event missions it should advance, using the
// mission master data (pattern/desc) + the finish statistics. It is deliberately
// CONSERVATIVE: it only advances missions whose completion condition is satisfiable from
// finish data we actually have (a clear happened, skill-chain/combo thresholds, clear_phase).
// Missions whose exact trigger we cannot yet verify from real captured traffic are advanced
// by the generic "battle clear" rule (+1 per clear / +killCount for kill-count missions),
// which matches the in-game description "(배틀 클리어시 가산)" for the kill-count missions.
//
// The finish handler also logs the raw statistics ([BATTLE/stats]) so the exact
// client_checks shape can be confirmed against live traffic and this mapping tightened.

export interface FinishStatistics {
    clear_phase?: number
    max_skill_chain_count?: number
    max_combo_count?: number
    max_power?: number
    client_checks?: number[]
    zones?: unknown[]
    party?: unknown
}

export interface MissionDefLite {
    category: number
    eventId?: number
    stage?: number
    pattern: string
    desc: string
    target: number
    startDate: string | null
    endDate: string | null
}

// Classifies a mission by its (Korean) description into a battle-trigger kind.
// These descriptions come straight from the CDN master data.
export type BattleMissionKind =
    | { kind: "clear" }               // "협력 배틀을 클리어", "미궁 클리어", generic clear → +1 per clear
    | { kind: "kill" }                // "적 토벌 수 (배틀 클리어시 가산)" → +N (N from statistics or +target-fraction)
    | { kind: "skill_chain", need: number }  // "N 스킬 체인을 발동해 배틀 클리어" → +1 if max_skill_chain_count >= N
    | { kind: "combo", need: number }        // combo-count clear → +1 if max_combo_count >= N
    | { kind: "aggregate" }           // "제N탄 미션을 모두 클리어" / "미션을 전부 클리어" → handled by aggregate pass, skip here
    | { kind: "unknown" }             // not confidently classifiable → skip (do not guess)

// Extracts a leading integer from a description (e.g. "4 스킬 체인..." → 4, "6 스킬..." → 6).
function leadingInt(desc: string): number | null {
    const m = desc.match(/(\d+)/)
    return m ? parseInt(m[1], 10) : null
}

export function classifyBattleMission(def: MissionDefLite): BattleMissionKind {
    const d = def.desc || ""
    // aggregate missions ("제N탄 미션을 모두 클리어", "미션을 전부 클리어") — depend on other
    // missions being complete, resolved in a separate aggregate pass, not per-battle.
    if (d.includes("미션을 모두 클리어") || d.includes("미션을 전부 클리어")) return { kind: "aggregate" }
    // skill chain: "4 스킬 체인을 발동해서 배틀을 클리어" / "6 스킬 체인을 발동해 배틀 클리어"
    if (d.includes("스킬 체인") || d.includes("스킬체인")) {
        const n = leadingInt(d)
        if (n !== null) return { kind: "skill_chain", need: n }
    }
    // combo: "N 콤보..." clear-type
    if (d.includes("콤보")) {
        const n = leadingInt(d)
        if (n !== null) return { kind: "combo", need: n }
    }
    // kill count: "적 토벌 수 ... (배틀 클리어시 가산)"
    if (d.includes("토벌")) return { kind: "kill" }
    // generic clear: "협력 배틀을 클리어", "흔들리는 미궁을 클리어", "배틀을 클리어" 등
    if (d.includes("클리어")) return { kind: "clear" }
    return { kind: "unknown" }
}

// Given a finished battle's stats, returns the progress DELTA to add for a mission.
// Returns 0 when the battle does not satisfy the mission's condition (progress unchanged).
export function battleProgressDelta(
    def: MissionDefLite,
    stats: FinishStatistics
): number {
    const kind = classifyBattleMission(def)
    switch (kind.kind) {
        case "clear":
            return 1
        case "kill": {
            // "배틀 클리어시 가산": the game adds a fixed kill count per clear. We don't get an
            // exact enemy-kill count in finish stats, so use clear_phase (phases cleared) as a
            // proxy floor of 1 — every clear advances kill-count missions by at least the phases
            // cleared. This matches the "가산" (accumulate per clear) semantics.
            const phases = typeof stats.clear_phase === "number" && stats.clear_phase > 0 ? stats.clear_phase : 1
            return phases
        }
        case "skill_chain":
            return (typeof stats.max_skill_chain_count === "number" && stats.max_skill_chain_count >= kind.need) ? 1 : 0
        case "combo":
            return (typeof stats.max_combo_count === "number" && stats.max_combo_count >= kind.need) ? 1 : 0
        case "aggregate":
        case "unknown":
        default:
            return 0
    }
}
