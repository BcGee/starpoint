// Bridges single_battle_quest/finish → players_mission_progress accumulation + reward grant.
//
// Called once per accomplished battle. For every active event mission advanced by this battle
// (per battleProgressDelta, using the cleared quest's category + finish statistics), increments
// the player's stored progress. When a mission crosses its target for the first time, its
// rewards are granted as MAIL (collect_item_event missions have NO client receive API — reward
// delivery is server-driven; mail is the standard WF delivery channel). reward_sent flag makes
// it idempotent (never granted twice).

import * as path from "path"
import {
    incrementPlayerMissionProgressSync,
    getPlayerMissionProgressByIdsSync,
    setPlayerMissionProgressSync,
    isMissionRewardSentSync,
    markMissionRewardSentSync,
    insertPlayerMailSync,
} from "../data/wdfpData"
import { battleProgressDelta, FinishStatistics, MissionDefLite } from "./battleMissionProgress"
import { RewardType } from "./types"

// Aggregate missions ("제N탄 미션을 모두 클리어" / "미션을 전부 클리어") are completed not by a
// battle but when their SIBLING missions are all done. They carry no subCondition/questKind.
function isAggregateMission(def: MissionDefLite): boolean {
    const d = def.desc || ""
    return d.includes("미션을 모두 클리어") || d.includes("미션을 전부 클리어")
}
// "미션을 전부 클리어" = the whole-event roll-up (depends on the per-stage aggregates), vs
// "제N탄 미션을 모두 클리어" = the per-stage aggregate (depends on that stage's normal missions).
function isEventWideAggregate(def: MissionDefLite): boolean {
    return (def.desc || "").includes("전부 클리어")
}

const missionsData = require(path.join(__dirname, "..", "..", "assets", "mission.json"))
const eventMissions = (missionsData.eventMissions || {}) as Record<string, Record<string, MissionDefLite>>
// mission_id → { stage → [ {kind, id?, amount, rawKind?} ] }
const eventMissionRewards = (missionsData.eventMissionRewards || {}) as Record<string, Record<string, MissionReward[]>>

interface MissionReward { kind: string, id?: number, amount: number, rawKind?: string }

const MISSION_REWARD_REASON_ID = 91001 // distinct reason id for mission-completion mails

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

// Maps a parsed mission-reward kind → server RewardType. Unknown kinds return null (skip + log).
function rewardKindToType(kind: string): number | null {
    switch (kind) {
        case "item": return RewardType.ITEM
        case "equipment": return RewardType.EQUIPMENT
        case "stone": return RewardType.BEADS       // 성도석 = free beads
        case "mana": return RewardType.MANA
        case "pooled_exp": return RewardType.EXP
        default: return null                          // unknown (rare kind 2/4) — do NOT grant
    }
}

// Sends a mission's rewards as a single mail. Idempotent per (player, missionPattern).
function grantMissionRewards(playerId: number, missionPattern: string, missionId: number, stage: number, desc: string): void {
    if (isMissionRewardSentSync(playerId, missionPattern)) return
    const stageRewards = eventMissionRewards[String(missionId)]
    // reward keys are stages; fall back to stage "1" then first available
    const rewards: MissionReward[] = (stageRewards && (stageRewards[String(stage)] || stageRewards["1"] || Object.values(stageRewards)[0])) || []

    const attachments: { rewardType: number, rewardId: number | null, number: number }[] = []
    for (const r of rewards) {
        const rt = rewardKindToType(r.kind)
        if (rt === null) {
            console.log("[MISSION/reward] skip unknown kind '" + (r.rawKind ?? r.kind) + "' amt=" + r.amount + " mission=" + missionPattern)
            continue
        }
        const needsId = rt === RewardType.ITEM || rt === RewardType.EQUIPMENT || rt === RewardType.CHARACTER
        attachments.push({ rewardType: rt, rewardId: needsId ? (r.id ?? null) : null, number: r.amount })
    }

    // Always mark sent (even if attachments empty) so we don't re-check every battle.
    markMissionRewardSentSync(playerId, missionPattern)
    if (attachments.length === 0) return

    const now = new Date()
    insertPlayerMailSync(playerId, {
        reasonId: MISSION_REWARD_REASON_ID,
        subject: "미션 보상",
        description: desc || "미션 달성 보상",
        createTime: now,
        receiveTime: null,
        rewardPeriodLimited: false,
        rewardLimitTime: null,
        received: false,
        attachments,
    })
    console.log("[MISSION/reward] granted " + attachments.length + " reward(s) via mail for " + missionPattern)
}

/**
 * Re-evaluates the aggregate missions of an event ("제N탄 모두 클리어" / "미션 전부 클리어").
 * Called after normal-mission progress changes. Completes an aggregate (sets progress=target
 * + grants reward) when its dependencies are all complete:
 *   - per-stage aggregate  → all NON-aggregate missions of the SAME stage reached target
 *   - event-wide aggregate → all per-stage aggregates completed
 * Idempotent via reward_sent. Does two passes so a stage aggregate completing can immediately
 * satisfy the event-wide one.
 */
function evaluateAggregateMissions(playerId: number, eventId: number, nowMs: number): void {
    const table = eventMissions[String(eventId)]
    if (!table) return

    const entries = Object.entries(table).map(([id, def]) => ({ id: Number(id), def }))
    const allIds = entries.map(e => e.id)
    const isDone = (id: number, def: MissionDefLite, prog: Record<number, { progress_value: number }>) => {
        const p = prog[id] ? prog[id].progress_value : 0
        return def.target > 0 && p >= def.target
    }

    // helper: complete an aggregate mission (persist progress=target + grant reward once)
    const complete = (id: number, def: MissionDefLite) => {
        setPlayerMissionProgressSync(playerId, {
            missionPattern: def.pattern, missionId: id, category: def.category ?? 4,
            eventId, stage: def.stage ?? 1, progressValue: def.target > 0 ? def.target : 1,
        })
        grantMissionRewards(playerId, def.pattern, id, def.stage ?? 1, def.desc)
    }

    // TWO passes: pass 1 completes per-stage aggregates, pass 2 the event-wide roll-up.
    for (let pass = 0; pass < 2; pass++) {
        const prog = getPlayerMissionProgressByIdsSync(playerId, allIds)
        for (const { id, def } of entries) {
            if (!isAggregateMission(def)) continue
            if (isDone(id, def, prog)) continue           // already complete
            if (isMissionRewardSentSync(playerId, def.pattern)) continue

            let deps: { id: number, def: MissionDefLite }[]
            if (isEventWideAggregate(def)) {
                // depends on every per-stage aggregate (the other aggregates)
                deps = entries.filter(e => e.id !== id && isAggregateMission(e.def) && !isEventWideAggregate(e.def))
            } else {
                // per-stage: depends on the same stage's NON-aggregate missions
                deps = entries.filter(e => e.id !== id && !isAggregateMission(e.def) && (e.def.stage ?? 1) === (def.stage ?? 1))
            }
            if (deps.length === 0) continue
            const allDepsDone = deps.every(d => isDone(d.id, d.def, prog))
            if (allDepsDone) complete(id, def)
        }
    }
}

/**
 * Accumulate battle-mission progress for all active event missions after a battle clear,
 * and grant rewards (as mail) for any mission that reaches its target.
 */
export function accumulateBattleMissions(
    playerId: number,
    stats: FinishStatistics,
    nowMs: number,
    clearedQuestId?: number,
    clearedCategory?: number
): number {
    try {
        const zones = Array.isArray(stats.zones) ? stats.zones : []
        const killSum = zones.reduce((a, z) => a + (typeof z.enemy_kill_count === "number" ? z.enemy_kill_count : 0), 0)
        console.log("[BATTLE/stats] " + JSON.stringify({
            quest_id: clearedQuestId, category: clearedCategory,
            clear_phase: stats.clear_phase, max_skill_chain_count: stats.max_skill_chain_count,
            max_combo_count: stats.max_combo_count, enemy_kill_total: killSum, client_checks: stats.client_checks
        }))
    } catch { /* ignore */ }

    if (typeof clearedCategory !== "number") return 0

    // Collect the missions advanced by this battle + their delta.
    const advancedList: { eventId: number, id: number, def: MissionDefLite, delta: number }[] = []
    for (const [eventId, table] of Object.entries(eventMissions)) {
        for (const [id, def] of Object.entries(table)) {
            if (!isActive(def, nowMs)) continue
            const delta = battleProgressDelta(def, stats, clearedCategory)
            if (delta <= 0) continue
            advancedList.push({ eventId: Number(eventId), id: Number(id), def, delta })
        }
    }
    if (advancedList.length === 0) return 0

    // Read pre-increment progress so we can detect target-crossing this battle.
    const before = getPlayerMissionProgressByIdsSync(playerId, advancedList.map(a => a.id))

    const detail: string[] = []
    for (const a of advancedList) {
        incrementPlayerMissionProgressSync(playerId, {
            missionPattern: a.def.pattern, missionId: a.id, category: a.def.category ?? 4,
            eventId: a.eventId, stage: a.def.stage ?? 1, delta: a.delta,
        })
        detail.push(a.def.pattern + "+" + a.delta)

        // completion check: crossed target this battle → grant rewards once
        const prev = before[a.id] ? before[a.id].progress_value : 0
        const nowVal = prev + a.delta
        if (a.def.target > 0 && nowVal >= a.def.target && prev < a.def.target) {
            grantMissionRewards(playerId, a.def.pattern, a.id, a.def.stage ?? 1, a.def.desc)
        }
    }

    // Re-evaluate aggregate missions ("제N탄 모두 클리어" / "미션 전부 클리어") for every event
    // whose normal missions advanced — a normal mission completing may finish its stage aggregate.
    const touchedEvents = [...new Set(advancedList.map(a => a.eventId))]
    for (const ev of touchedEvents) evaluateAggregateMissions(playerId, ev, nowMs)

    console.log("[BATTLE/mission] advanced " + advancedList.length + " rows: " + detail.slice(0, 20).join(", "))
    return advancedList.length
}
