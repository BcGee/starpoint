// active_mission (스텝업 미션) 라우트.
//
// 클라 요청 (SWF 확정):
//  POST /active_mission/receive           body: { active_mission_list: [{mission_id, stages:[stage...]}], viewer_id, api_count }
//    (클라 콜사이트: startUserRequest 로 [{mission_id, stages}] 배열 전송)
//  POST /active_mission/receive_incentive body: { mission_id, viewer_id }  ← 현금 이벤트(real_incentive)용. 이 서버 무관 → 빈 응답.
//
// 서버는 요청받은 스테이지들의 보상을 지급하고, players_active_missions_stages 에 received 로 기록해 재수령을 막는다.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { getSession, getAccountPlayers, upsertPlayerActiveMissionStageReceivedSync, getPlayerSync } from "../../data/wdfpData"
import { generateDataHeaders } from "../../utils"
import { getActiveMissionStageRewardsSync } from "../../lib/activeMission"
import { givePlayerRewardsSync } from "../../lib/quest"
import { Reward } from "../../lib/types"

interface ReceiveMissionEntry {
    mission_id: number
    stages: number[]
}

interface ReceiveBody {
    api_count: number
    viewer_id: number
    // 클라는 [{mission_id, stages}] 배열을 보낸다. 필드명이 래핑될 수 있어 여러 형태를 허용.
    active_mission_list?: ReceiveMissionEntry[]
    mission_list?: ReceiveMissionEntry[]
    list?: ReceiveMissionEntry[]
}

interface ReceiveIncentiveBody {
    api_count: number
    viewer_id: number
    mission_id: number
}

async function resolvePlayerId(viewerId: number): Promise<number | null> {
    if (!viewerId || isNaN(viewerId)) return null
    const session = await getSession(viewerId.toString())
    if (!session) return null
    const playerIds = await getAccountPlayers(session.accountId)
    const playerId = playerIds[0]
    return isNaN(playerId) ? null : playerId
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/receive", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBody
        const viewerId = body.viewer_id
        const playerId = await resolvePlayerId(viewerId)
        if (playerId === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const entries: ReceiveMissionEntry[] = body.active_mission_list ?? body.mission_list ?? body.list ?? []

        // 요청된 모든 미션/스테이지 보상을 모아서 지급하고, received 기록.
        // 동시에 응답용 active_mission_list 를 구성한다(클라가 이걸 읽어 로컬 clearedStages 를
        // 즉시 갱신 → 받는 즉시 회색 처리). 형식: [{mission_id, progress_value, stages:[{stage, received:true}]}]
        const allRewards: Reward[] = []
        const responseMissions: {
            mission_id: number
            progress_value: number
            stages: { stage: number, received: boolean }[]
        }[] = []
        for (const entry of entries) {
            const missionId = Number(entry.mission_id)
            if (isNaN(missionId)) continue
            const stages = Array.isArray(entry.stages) ? entry.stages : []
            const receivedStages: { stage: number, received: boolean }[] = []
            for (const stageRaw of stages) {
                const stage = Number(stageRaw)
                if (isNaN(stage)) continue
                // 이미 수령했으면 스킵 (upsert 가 false 반환 시).
                const newlyReceived = upsertPlayerActiveMissionStageReceivedSync(playerId, missionId, stage)
                if (!newlyReceived) continue
                const rewards = getActiveMissionStageRewardsSync(missionId, stage)
                for (const r of rewards) allRewards.push(r)
                receivedStages.push({ stage, received: true })
            }
            if (receivedStages.length > 0) {
                responseMissions.push({
                    mission_id: missionId,
                    progress_value: 999999,
                    stages: receivedStages,
                })
            }
        }

        // 보상 지급 (DB 반영). givePlayerRewardsSync 는 증분 처리 후 player 를 업데이트한다.
        const rewardResult = allRewards.length > 0 ? givePlayerRewardsSync(playerId, allRewards) : null

        // 클라(SWF)는 receive 응답을 applyCommonResponse 로 처리한다:
        //  - data.active_mission_list → 로컬 clearedStages 갱신(즉시 회색)
        //  - data.user_info → applyCommonResponseUserInfo 로 재화(마나/경험치/성도석) 즉시 화면 갱신
        // user_info 는 지급 후 player 의 절대값을 담아야 한다(클라가 덮어씀, 증분 아님).
        // 이게 없으면 재화가 DB엔 들어가도 화면엔 재접속 전까지 반영 안 됨.
        let userInfo: Record<string, number> = {}
        if (rewardResult !== null) {
            const p = getPlayerSync(playerId)
            if (p !== null) {
                userInfo = {
                    "free_mana": p.freeMana,
                    "paid_mana": p.paidMana,
                    "free_vmoney": p.freeVmoney,
                    "vmoney": p.vmoney,
                    "exp_pool": p.expPool,
                    "star_crumb": p.starCrumb,
                    "bond_token": p.bondToken,
                }
            }
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "active_mission_list": responseMissions,
                "user_info": userInfo
            }
        })
    })

    fastify.post("/receive_incentive", async (request: FastifyRequest, reply: FastifyReply) => {
        // real_incentive (현금 이벤트) — 이 서버에선 미지원. 클라가 안 터지게 빈 응답만.
        const body = request.body as ReceiveIncentiveBody
        const viewerId = body.viewer_id
        const playerId = await resolvePlayerId(viewerId)
        if (playerId === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": {},
                "mail_arrived": false
            }
        })
    })
}

export default routes
