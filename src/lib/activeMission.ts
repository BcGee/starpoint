// active_mission (스텝업 미션 등) 로직.
//
// 클라 동작 (SWF 디컴파일로 확정):
//  - progress 는 클라가 로컬 계산한다 (퀘스트 클리어/캐릭터 편성 등 클라가 판정). progress push API 없음.
//  - 클라는 /load 의 `active_mission_list` 로 미션 목록 + 수령상태를 받는다.
//    스키마: Option<Array<{ mission_id:Int, progress_value:Int, stages:Option<Array<{stage:Int, received:Bool}>> }>>
//  - 수령 시 `active_mission/receive` 에 [{mission_id, stages:[stage...]}] 를 보낸다 → 서버가 보상 지급 + received 기록.
//  - `active_mission/receive_incentive` 는 현금 이벤트(real_incentive)용 — 이 서버에선 무관.
//
// 서버 정책: blanc 계정은 고랭크/무한재화라 스텝업 미션은 전부 클리어(수령 가능) 상태로 노출한다.
//  progress_value 는 미션 target 을 채운 값으로, stages 는 (아직 수령 안 한 것은 received=false)로 준다.
//  실제 수령은 receive 에서 처리하여 재수령을 막는다 (players_active_missions_stages.status=received).

import * as path from "path"
import { RewardType, Reward, EquipmentItemReward, CharacterReward, CurrencyReward } from "./types"
import { getServerDate } from "../utils"

// assets/active_mission.json 을 런타임 require (tsc 타입그래프에 큰 JSON 을 안 넣기 위해; mission.ts 와 동일 패턴).
// 컴파일 후 out/lib → ../../assets.
const activeMissionData = require(path.join(__dirname, "..", "..", "assets", "active_mission.json")) as ActiveMissionAssets

interface ActiveMissionReward {
    kind: "stone" | "item" | "equipment" | "character" | "mana" | "pooled_exp"
    id?: number
    amount: number
}

interface ActiveMissionDef {
    eventId: string
    order: number
    category: string
    pattern: string
    description: string
    stage: number
    startDate: string | null
    endDate: string | null
    rewardsByStage: Record<string, ActiveMissionReward[]>
}

interface ActiveMissionEventDef {
    key: string
    name: string
    stageCount: number | null
    startDate: string | null
    endDate: string | null
}

interface ActiveMissionAssets {
    events: Record<string, ActiveMissionEventDef>
    missions: Record<string, ActiveMissionDef>
}

// "YYYY-MM-DD HH:MM:SS" (UTC) → epoch ms, null 이면 null.
function parseMasterDate(s: string | null): number | null {
    if (!s) return null
    const t = Date.parse(s.replace(" ", "T") + "Z")
    return isNaN(t) ? null : t
}

// 주어진 서버시간에 활성인 이벤트 id 집합.
function activeEventIds(nowMs: number): Set<string> {
    const ids = new Set<string>()
    for (const [eid, ev] of Object.entries(activeMissionData.events)) {
        const start = parseMasterDate(ev.startDate)
        const end = parseMasterDate(ev.endDate)
        if (start !== null && nowMs < start) continue
        if (end !== null && nowMs > end) continue
        // real_incentive (현금 이벤트) 는 서버 무관 — key 로 제외.
        if (ev.key === "real_incentive_mission_event") continue
        ids.add(eid)
    }
    return ids
}

// 현재 활성인 미션 정의 목록 (서버시간 기준).
export function getActiveMissionDefsSync(): { missionId: number, def: ActiveMissionDef }[] {
    const nowMs = getServerDate().getTime()
    const events = activeEventIds(nowMs)
    const out: { missionId: number, def: ActiveMissionDef }[] = []
    for (const [mid, def] of Object.entries(activeMissionData.missions)) {
        if (!events.has(def.eventId)) continue
        // 미션 자체의 기간도 체크.
        const start = parseMasterDate(def.startDate)
        const end = parseMasterDate(def.endDate)
        if (start !== null && nowMs < start) continue
        if (end !== null && nowMs > end) continue
        const nid = Number(mid)
        if (isNaN(nid)) continue
        out.push({ missionId: nid, def })
    }
    return out
}

// converter reward({kind,id,amount}) → 서버 Reward.
// 성도석은 무료(BEADS→free_vmoney)로 지급 (스텝업 보상은 무료 성도석).
export function activeMissionRewardToReward(r: ActiveMissionReward): Reward | null {
    switch (r.kind) {
        case "stone":
            return { type: RewardType.BEADS, count: r.amount } as CurrencyReward
        case "mana":
            return { type: RewardType.MANA, count: r.amount } as CurrencyReward
        case "pooled_exp":
            return { type: RewardType.EXP, count: r.amount } as CurrencyReward
        case "item":
            if (r.id === undefined) return null
            return { type: RewardType.ITEM, id: r.id, count: r.amount } as EquipmentItemReward
        case "equipment":
            if (r.id === undefined) return null
            return { type: RewardType.EQUIPMENT, id: r.id, count: r.amount } as EquipmentItemReward
        case "character":
            if (r.id === undefined) return null
            return { type: RewardType.CHARACTER, id: r.id } as CharacterReward
        default:
            return null
    }
}

// 특정 미션의 특정 스테이지 보상(Reward[]) 반환. 없으면 빈 배열.
export function getActiveMissionStageRewardsSync(missionId: number, stage: number | string): Reward[] {
    const def = activeMissionData.missions[String(missionId)]
    if (!def) return []
    const rewards = def.rewardsByStage[String(stage)]
    if (!rewards) return []
    const out: Reward[] = []
    for (const r of rewards) {
        const conv = activeMissionRewardToReward(r)
        if (conv !== null) out.push(conv)
    }
    return out
}

// 미션의 모든 스테이지 키 (정렬).
export function getActiveMissionStagesSync(missionId: number): number[] {
    const def = activeMissionData.missions[String(missionId)]
    if (!def) return []
    return Object.keys(def.rewardsByStage).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b)
}

export function getActiveMissionAssets(): ActiveMissionAssets {
    return activeMissionData
}

// /load 용 all_active_mission_list 직렬화.
//
// 클라 스키마 (SWF /load 파서 확정): Map<missionId, {
//   progress: int,                    // 진행도. 클라 isCompleted = target_progress <= progress
//   stages: Option<Map<stageId, bool>>, // stageId -> 수령여부(true=수령됨, false=미수령)
//   ingame_status: Option<int>,
//   ingame_reward_id: ...(생략 가능)
// }>
// 클라는 stages 맵의 각 stageId 를 "클리어된 스테이지"로 보고, 값이 false(미수령)인 것만
// active_mission/receive 로 보낸다 (SWF: clearedStages[k]==1 → 미수령분 수집).
//
// 정책: blanc 계정은 고랭크/무한재화 + 스텝업은 서버가 progress 를 직접 관리해야만 동작하는
// 구조(클라에 progress push API 없음)라, 활성 미션을 전부 클리어 상태(progress≥target)로
// 노출한다. stages 는 각 스테이지를 넣되 DB 에 수령 기록이 있으면 true, 없으면 false.
//
// ★ msgpack int-key 인코딩 (핵심): 클라는 all_active_mission_list 를 Map<missionId(int), ...>,
//   그 안의 stages 를 Map<stageId(int), bool> 로 기대하고 int key 로 조회한다
//   (SWF: clearedStages.h[int(key)]). JS 객체 {"1":true} 는 msgpack 에서 STRING key 로
//   인코딩돼 클라의 int-key 조회가 빗나가 → 수령완료(clearedStages==2) 판정 실패 → 받아도
//   회색처리 안 됨. JS Map 을 쓰면 msgpackr 가 int key 로 인코딩(0x81 0x01 ...)하므로
//   반드시 Map 으로 반환한다. (미션 "표시"는 값 순회만 해서 string key 여도 됐지만,
//   stages 는 특정 key 조회가 필수라 이 버그가 드러났다.)
export function serializeAllActiveMissionList(playerId: number): Map<number, {
    progress: number
    stages: Map<number, boolean>
    ingame_status: number
}> {
    // 순환 import 방지: wdfpData 를 지연 require.
    const { getPlayerActiveMissionsSync } = require("../data/wdfpData") as typeof import("../data/wdfpData")
    const dbState = getPlayerActiveMissionsSync(playerId) // { [missionId]: { progress, stages: {stageId: received} } }

    const out = new Map<number, { progress: number; stages: Map<number, boolean>; ingame_status: number }>()
    for (const { missionId, def } of getActiveMissionDefsSync()) {
        const stageKeys = Object.keys(def.rewardsByStage).map(Number).filter(n => !isNaN(n))
        if (stageKeys.length === 0) stageKeys.push(1)

        const dbEntry = dbState[String(missionId)]
        const dbStages: Record<string, boolean> =
            (dbEntry && !Array.isArray(dbEntry.stages)) ? dbEntry.stages as Record<string, boolean> : {}

        // stages Map(int key): 각 스테이지 -> 수령여부. DB 수령 기록(true)이면 true, 아니면 false.
        const stages = new Map<number, boolean>()
        for (const stage of stageKeys.sort((a, b) => a - b)) {
            stages.set(stage, dbStages[String(stage)] === true)
        }

        out.set(missionId, {
            // 클라 완료판정은 target_progress <= progress. 미션별 target 은 다양(1/6/10 등)하고
            // 서버가 실제 진행을 추적하지 않으므로, 큰 값으로 줘서 모든 target 을 만족시켜
            // 전부 수령가능(클리어) 상태로 노출한다.
            progress: 999999,
            stages,
            ingame_status: 0,
        })
    }
    return out
}
