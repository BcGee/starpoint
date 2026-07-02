// active_mission (스텝업 미션) 라우트.
//
// 클라 요청 (SWF 확정):
//  POST /active_mission/receive           body: { active_mission_list: [{mission_id, stages:[stage...]}], viewer_id, api_count }
//    (클라 콜사이트: startUserRequest 로 [{mission_id, stages}] 배열 전송)
//  POST /active_mission/receive_incentive body: { mission_id, viewer_id }  ← 현금 이벤트(real_incentive)용. 이 서버 무관 → 빈 응답.
//
// 서버는 요청받은 스테이지들의 보상을 지급하고, players_active_missions_stages 에 received 로 기록해 재수령을 막는다.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { getSession, getAccountPlayers, upsertPlayerActiveMissionStageReceivedSync } from "../../data/wdfpData"
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
        const allRewards: Reward[] = []
        for (const entry of entries) {
            const missionId = Number(entry.mission_id)
            if (isNaN(missionId)) continue
            const stages = Array.isArray(entry.stages) ? entry.stages : []
            for (const stageRaw of stages) {
                const stage = Number(stageRaw)
                if (isNaN(stage)) continue
                // 이미 수령했으면 스킵 (upsert 가 false 반환 시).
                const newlyReceived = upsertPlayerActiveMissionStageReceivedSync(playerId, missionId, stage)
                if (!newlyReceived) continue
                const rewards = getActiveMissionStageRewardsSync(missionId, stage)
                for (const r of rewards) allRewards.push(r)
            }
        }

        const rewardResult = allRewards.length > 0 ? givePlayerRewardsSync(playerId, allRewards) : null

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {
                "user_info": rewardResult?.user_info ?? {},
                "character_list": rewardResult?.character_list ?? [],
                "item_list": rewardResult?.items ?? {},
                "equipment_list": rewardResult?.equipment_list ?? [],
                "joined_character_id_list": rewardResult?.joined_character_id_list ?? [],
                "mail_arrived": false
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
