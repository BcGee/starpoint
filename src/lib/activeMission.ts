// active_mission (스텝업 미션 등) 로직.
//
// 클라 동작 (SWF 디컴파일로 확정):
//  - progress 는 클라가 로컬 계산한다 (퀘스트 클리어/캐릭터 편성 등 클라가 판정). progress push API 없음.
//  - 클라는 /load 의 `active_mission_list` 로 미션 목록 + 수령상태를 받는다.
//    스키마: Option<Array<{ mission_id:Int, progress_value:Int, stages:Option<Array<{stage:Int, received:Bool}>> }>>
//  - 수령 시 `active_mission/receive` 에 [{mission_id, stages:[stage...]}] 를 보낸다 → 서버가 보상 지급 + received 기록.
//  - `active_mission/receive_incentive` 는 현금 이벤트(real_incentive)용 — 이 서버에선 무관.
//
// 서버 정책 (실플레이): progress 는 플레이어 DB 상태로 실제 계산한다(computeStepUpProgress).
//  뉴비는 미션을 실제로 깨야 progress≥target 이 되어 클라가 완료(수령 가능)로 판정한다.
//  stages 는 각 스테이지를 넣되 DB 에 수령 기록이 있으면 true, 없으면 false.
//  실제 수령은 receive 에서 isActiveMissionCompletedSync 로 검증해 미완료 미션 수령을 막는다
//  (players_active_missions_stages.status=received 로 재수령도 차단).

import * as path from "path"
import { Reward, RewardType } from "./types"
import { getServerDate } from "../utils"

// active_mission.json 의 미션 보상 항목.
interface ActiveMissionReward {
    kind: string
    id?: number
    amount: number
}

// active_mission.json 의 미션 정의.
interface ActiveMissionDef {
    eventId: string
    order?: number
    category?: string
    pattern: string
    description?: string
    stage: number
    target: number
    startDate: string | null
    endDate: string | null
    rewardsByStage: Record<string, ActiveMissionReward[]>
}

// active_mission.json 의 이벤트 정의.
interface ActiveMissionEvent {
    key?: string
    startDate: string | null
    endDate: string | null
}

interface ActiveMissionData {
    events: Record<string, ActiveMissionEvent>
    missions: Record<string, ActiveMissionDef>
}

// assets/active_mission.json 을 런타임 require (tsc 타입그래프에 큰 JSON 을 안 넣기 위해; mission.ts 와 동일 패턴).
// 컴파일 후 out/lib → ../../assets.
const activeMissionData = require(path.join(__dirname, "..", "..", "assets", "active_mission.json")) as ActiveMissionData

// "YYYY-MM-DD HH:MM:SS" (UTC) → epoch ms, null 이면 null.
function parseMasterDate(s: string | null): number | null {
    if (!s)
        return null
    const t = Date.parse(s.replace(" ", "T") + "Z")
    return isNaN(t) ? null : t
}

// 주어진 서버시간에 활성인 이벤트 id 집합.
function activeEventIds(nowMs: number): Set<string> {
    const ids = new Set<string>()
    for (const [eid, ev] of Object.entries(activeMissionData.events)) {
        const start = parseMasterDate(ev.startDate)
        const end = parseMasterDate(ev.endDate)
        if (start !== null && nowMs < start)
            continue
        if (end !== null && nowMs > end)
            continue
        // real_incentive (현금 이벤트) 는 서버 무관 — key 로 제외.
        if (ev.key === "real_incentive_mission_event")
            continue
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
        if (!events.has(def.eventId))
            continue
        // 미션 자체의 기간도 체크.
        const start = parseMasterDate(def.startDate)
        const end = parseMasterDate(def.endDate)
        if (start !== null && nowMs < start)
            continue
        if (end !== null && nowMs > end)
            continue
        const nid = Number(mid)
        if (isNaN(nid))
            continue
        out.push({ missionId: nid, def })
    }
    return out
}

// converter reward({kind,id,amount}) → 서버 Reward.
// 성도석은 무료(BEADS→free_vmoney)로 지급 (스텝업 보상은 무료 성도석).
export function activeMissionRewardToReward(r: ActiveMissionReward): Reward | null {
    switch (r.kind) {
        case "stone":
            return { type: RewardType.BEADS, count: r.amount } as Reward
        case "mana":
            return { type: RewardType.MANA, count: r.amount } as Reward
        case "pooled_exp":
            return { type: RewardType.EXP, count: r.amount } as Reward
        case "item":
            if (r.id === undefined)
                return null
            return { type: RewardType.ITEM, id: r.id, count: r.amount } as Reward
        case "equipment":
            if (r.id === undefined)
                return null
            return { type: RewardType.EQUIPMENT, id: r.id, count: r.amount } as Reward
        case "character":
            if (r.id === undefined)
                return null
            return { type: RewardType.CHARACTER, id: r.id } as Reward
        default:
            return null
    }
}

// 특정 미션의 특정 스테이지 보상(Reward[]) 반환. 없으면 빈 배열.
export function getActiveMissionStageRewardsSync(missionId: number, stage: number): Reward[] {
    const def = activeMissionData.missions[String(missionId)]
    if (!def)
        return []
    const rewards = def.rewardsByStage[String(stage)]
    if (!rewards)
        return []
    const out: Reward[] = []
    for (const r of rewards) {
        const conv = activeMissionRewardToReward(r)
        if (conv !== null)
            out.push(conv)
    }
    return out
}

// 미션이 실제로 완료 상태인지(수령 가능) 검증. receive 에서 target 미달 미션의
// 무단 수령을 막는다 — 클라 완료판정과 동일하게 target_progress <= 계산된 progress.
// all_active_mission_list 와 같은 소스(computeStepUpProgress + all_clear 2-pass)를 쓴다.
export function isActiveMissionCompletedSync(playerId: number, missionId: number): boolean {
    const list = serializeAllActiveMissionList(playerId)
    const entry = list.get(missionId)
    if (!entry)
        return false
    const def = activeMissionData.missions[String(missionId)]
    if (!def)
        return false
    const target = typeof def.target === "number" ? def.target : 1
    return entry.progress >= target
}

// 미션의 모든 스테이지 키 (정렬).
export function getActiveMissionStagesSync(missionId: number): number[] {
    const def = activeMissionData.missions[String(missionId)]
    if (!def)
        return []
    return Object.keys(def.rewardsByStage).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b)
}

export function getActiveMissionAssets(): ActiveMissionData {
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
// 정책 (실플레이): progress 는 플레이어 DB 상태로 실제 계산한다(computeStepUpProgress + all_clear 2-pass).
//  뉴비는 미션을 깨야 progress≥target 이 되어 완료로 표시된다. stages 는 각 스테이지를 넣되
//  DB 에 수령 기록이 있으면 true, 없으면 false.
//
// ★ msgpack int-key 인코딩 (핵심): 클라는 all_active_mission_list 를 Map<missionId(int), ...>,
//   그 안의 stages 를 Map<stageId(int), bool> 로 기대하고 int key 로 조회한다
//   (SWF: clearedStages.h[int(key)]). JS 객체 {"1":true} 는 msgpack 에서 STRING key 로
//   인코딩돼 클라의 int-key 조회가 빗나가 → 수령완료(clearedStages==2) 판정 실패 → 받아도
//   회색처리 안 됨. JS Map 을 쓰면 msgpackr 가 int key 로 인코딩(0x81 0x01 ...)하므로
//   반드시 Map 으로 반환한다. (미션 "표시"는 값 순회만 해서 string key 여도 됐지만,
//   stages 는 특정 key 조회가 필수라 이 버그가 드러났다.)
export function serializeAllActiveMissionList(
    playerId: number
): Map<number, { progress: number, stages: Map<number, boolean>, ingame_status: number }> {
    // 순환 import 방지: wdfpData 를 지연 require.
    const {
        getPlayerActiveMissionsSync,
        getPlayerQuestProgressSync,
        getPlayerCharactersSync,
        getPlayerEquipmentListSync,
        getPlayerPartyGroupListSync,
    } = require("../data/wdfpData")
    const { computeStepUpProgress, isStepUpAllClear } = require("./activeMissionProgress")
    const dbState = getPlayerActiveMissionsSync(playerId) // { [missionId]: { progress, stages: {stageId: received} } }
    // 플레이어 상태를 한 번만 조회해 progress 계산에 재사용.
    const questProgress = getPlayerQuestProgressSync(playerId)
    const charsRaw = getPlayerCharactersSync(playerId)
    const characters: Record<string, { evolutionLevel: number, overLimitStep: number, exp: number }> = {}
    let bondTokenCount = 0
    for (const [id, c] of Object.entries(charsRaw) as [string, any][]) {
        characters[id] = {
            evolutionLevel: c.evolutionLevel ?? 0,
            overLimitStep: c.overLimitStep ?? 0,
            exp: c.exp ?? 0,
        }
        // bond token 은 캐릭터 생성 시 status=0(미획득) 기본행이 깔린다. 실제 "획득"은 status>0 뿐.
        const bt = c.bondTokenList || c.bondTokenStatusList || []
        if (Array.isArray(bt))
            bondTokenCount += bt.filter((t: any) => (t?.status ?? 0) > 0).length
    }
    const equipRaw = getPlayerEquipmentListSync(playerId)
    const equipment: Record<string, { level: number, enhancementLevel: number }> = {}
    for (const [id, e] of Object.entries(equipRaw) as [string, any][]) {
        equipment[id] = { level: e.level ?? 0, enhancementLevel: e.enhancementLevel ?? 0 }
    }
    // 파티: 모든 파티그룹의 모든 파티에서 unison/장비 편성 여부 필요.
    const parties: { unisonCharacterIds: (number | null)[], equipmentIds: (number | null)[] }[] = []
    const groups = getPlayerPartyGroupListSync(playerId)
    for (const g of Object.values(groups) as any[]) {
        const list = g.list || {}
        for (const p of Object.values(list) as any[]) {
            parties.push({
                unisonCharacterIds: p.unisonCharacterIds || [],
                equipmentIds: p.equipmentIds || [],
            })
        }
    }
    const ctx = { questProgress, characters, equipment, parties, bondTokenCount }
    // 1-pass: all_clear 를 제외한 미션의 실제 progress 계산.
    const defs = getActiveMissionDefsSync()
    // 스텝(=stage)별 [완료수, 전체수] 집계 — all_clear 의 progress 로 쓴다.
    const stageDone: Record<number, number> = {}
    const stageTotal: Record<number, number> = {}
    const computed = new Map<number, { def: ActiveMissionDef, progress: number, stageKeys: number[] }>()
    for (const { missionId, def } of defs) {
        const stageKeys = Object.keys(def.rewardsByStage).map(Number).filter(n => !isNaN(n))
        if (stageKeys.length === 0)
            stageKeys.push(1)
        if (isStepUpAllClear(def.pattern)) {
            computed.set(missionId, { def, progress: -1, stageKeys }) // 2-pass 에서 채움
            continue
        }
        const progress = computeStepUpProgress(def.pattern, ctx)
        computed.set(missionId, { def, progress, stageKeys })
        // 스텝(정수 stage) 집계 — all_clear 는 같은 스텝의 "다른 미션들" 완료수가 target.
        const st = def.stage
        stageTotal[st] = (stageTotal[st] || 0) + 1
        if (def.target > 0 && progress >= def.target)
            stageDone[st] = (stageDone[st] || 0) + 1
    }
    // 2-pass: all_clear progress = 같은 스텝에서 완료된 (all_clear 제외) 미션 수.
    for (const [, entry] of computed) {
        if (isStepUpAllClear(entry.def.pattern)) {
            entry.progress = stageDone[entry.def.stage] || 0
        }
    }
    const out = new Map<number, { progress: number, stages: Map<number, boolean>, ingame_status: number }>()
    for (const [missionId, entry] of computed) {
        const dbEntry = dbState[String(missionId)]
        const dbStages = (dbEntry && !Array.isArray(dbEntry.stages)) ? dbEntry.stages : {}
        // stages Map(int key): 각 스테이지 -> 수령여부. DB 수령 기록(true)이면 true, 아니면 false.
        const stages = new Map<number, boolean>()
        for (const stage of entry.stageKeys.sort((a, b) => a - b)) {
            stages.set(stage, dbStages[String(stage)] === true)
        }
        out.set(missionId, {
            // 서버가 플레이어 DB 상태로 계산한 실제 progress. 클라 완료판정 = target_progress <= progress.
            progress: entry.progress,
            stages,
            ingame_status: 0,
        })
    }
    return out
}
