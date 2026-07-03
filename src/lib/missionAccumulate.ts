// Bridges single_battle_quest/finish → players_mission_progress accumulation.
//
// Called once per accomplished battle. For every event mission that is (a) currently
// active by server time and (b) advanced by this battle (per battleProgressDelta, using
// the cleared quest's category + finish statistics), it increments the player's stored
// progress. Home/UI missions are handled separately (client push). Battle missions are
// server-accumulated here — confirmed necessary: the client never pushes them.
//
// Also logs the raw finish statistics ([BATTLE/stats]) for ongoing verification.

import * as path from "path"
import { incrementPlayerMissionProgressSync } from "../data/wdfpData"
import { battleProgressDelta, FinishStatistics, MissionDefLite } from "./battleMissionProgress"

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

/**
 * Accumulate battle-mission progress for all active event missions after a battle clear.
 *
 * @param playerId         player whose progress to advance
 * @param stats            the finish request's statistics object (raw; may carry extra fields)
 * @param nowMs            current server time (ms)
 * @param clearedQuestId   the cleared quest id (for logging)
 * @param clearedCategory  the cleared quest's QuestCategory (drives questKind matching)
 * @returns number of mission rows advanced (for logging)
 */
export function accumulateBattleMissions(
    playerId: number,
    stats: FinishStatistics,
    nowMs: number,
    clearedQuestId?: number,
    clearedCategory?: number
): number {
    // Ground-truth log of what the client actually sent (kept for ongoing verification).
    try {
        const zones = Array.isArray(stats.zones) ? stats.zones : []
        const killSum = zones.reduce((a, z) => a + (typeof z.enemy_kill_count === "number" ? z.enemy_kill_count : 0), 0)
        console.log("[BATTLE/stats] " + JSON.stringify({
            quest_id: clearedQuestId,
            category: clearedCategory,
            clear_phase: stats.clear_phase,
            max_skill_chain_count: stats.max_skill_chain_count,
            max_combo_count: stats.max_combo_count,
            enemy_kill_total: killSum,
            client_checks: stats.client_checks
        }))
    } catch { /* ignore */ }

    if (typeof clearedCategory !== "number") return 0

    let advanced = 0
    const advancedDetail: string[] = []
    for (const [eventId, table] of Object.entries(eventMissions)) {
        for (const [id, def] of Object.entries(table)) {
            if (!isActive(def, nowMs)) continue
            const delta = battleProgressDelta(def, stats, clearedCategory)
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
            advancedDetail.push(def.pattern + "+" + delta)
        }
    }
    if (advanced > 0) console.log("[BATTLE/mission] advanced " + advanced + " rows: " + advancedDetail.slice(0, 20).join(", "))
    return advanced
}
