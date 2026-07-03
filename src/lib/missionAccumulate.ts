// Bridges single_battle_quest/finish → players_mission_progress accumulation.
//
// Called once per accomplished battle. For every event mission that is (a) currently
// active by server time and (b) classifiable as advanced by this battle, it increments
// the player's stored progress. Home/UI missions are NOT handled here (client pushes
// those via update_mission_progress); this is battle missions only.
//
// It also logs the raw finish statistics so the exact client_checks shape can be
// confirmed against live traffic and the per-pattern mapping tightened later.

import * as path from "path"
import { incrementPlayerMissionProgressSync } from "../data/wdfpData"
import { battleProgressDelta, classifyBattleMission, FinishStatistics, MissionDefLite } from "./battleMissionProgress"

const missionsData = require(path.join(__dirname, "..", "..", "assets", "mission.json"))
const eventMissions = (missionsData.eventMissions || {}) as Record<string, Record<string, MissionDefLite>>

function parseMasterDate(s: string | null): number | null {
    if (!s) return null
    const t = Date.parse(s.replace(" ", "T") + "Z")
    return isNaN(t) ? null : t
}

function isActive(def: MissionDefLite, nowMs: number): boolean {
    const start = parseMasterDate(def.startDate)
    const end = parseMasterDate(def.endDate)
    if (start !== null && nowMs < start) return false
    if (end !== null && nowMs > end) return false
    return true
}

// Feature flag: when false, the finish hook only LOGS the statistics (to capture the
// real client_checks / quest linkage from live traffic) WITHOUT advancing any mission —
// avoids showing wrong progress from an unverified quest→mission mapping. Flip to true
// only after the per-quest mission trigger is confirmed against captured [BATTLE/stats].
const ACCUMULATE_ENABLED = false

/**
 * Accumulate battle-mission progress for all active event missions after a battle clear.
 *
 * @param playerId  player whose progress to advance
 * @param stats     the finish request's statistics object (raw; may carry extra fields)
 * @param nowMs     current server time (ms)
 * @param questId   the cleared quest id (for logging the quest→mission linkage)
 * @param category  the cleared quest category
 * @returns number of mission rows advanced (for logging)
 */
export function accumulateBattleMissions(
    playerId: number,
    stats: FinishStatistics,
    nowMs: number,
    questId?: number,
    category?: number
): number {
    // Always log the raw finish stats + quest ids. This is the ground-truth capture that
    // lets us confirm exactly which client_checks / quest a mission is tied to before we
    // trust any accumulation rule. (mitm logs responses only; this logs the server view.)
    try {
        console.log("[BATTLE/stats] " + JSON.stringify({
            quest_id: questId,
            category: category,
            clear_phase: stats.clear_phase,
            max_skill_chain_count: stats.max_skill_chain_count,
            max_combo_count: stats.max_combo_count,
            client_checks: stats.client_checks
        }))
    } catch { /* ignore */ }

    if (!ACCUMULATE_ENABLED) return 0

    let advanced = 0
    for (const [eventId, table] of Object.entries(eventMissions)) {
        for (const [id, def] of Object.entries(table)) {
            if (!isActive(def, nowMs)) continue
            const kind = classifyBattleMission(def)
            if (kind.kind === "aggregate" || kind.kind === "unknown") continue
            const delta = battleProgressDelta(def, stats)
            if (delta <= 0) continue
            incrementPlayerMissionProgressSync(playerId, {
                missionPattern: def.pattern,
                missionId: Number(id),
                category: def.category ?? 4,
                eventId: Number(eventId),
                stage: def.stage ?? 1,
                delta
            })
            advanced++
        }
    }
    if (advanced > 0) console.log("[BATTLE/mission] advanced " + advanced + " battle-mission rows for player " + playerId)
    return advanced
}
