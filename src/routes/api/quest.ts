import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccountPlayers, getPlayerSingleQuestProgressSync, getSession, insertPlayerQuestProgressSync } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";

// quest 라우트.
//
// /unlock — 잠긴 퀘스트를 해금한다 (아이템 소비 해금 UI: QuestUnlockConfirmDialog).
//   클라 요청: { category, quest_id, viewer_id }
//   클라 처리(SWF QuestUnlockRealRemote): 응답 body 는 무시하고, 성공(200)이면
//     QuestUnlockRemoteInput.Unlocked(category, quest_id) 로 로컬에서 해당 퀘스트를 해금.
//   → 서버는 200 + 유효한 msgpack Object 면 충분. 여기선 quest_progress 에 해금 레코드를
//     남겨(finished=false, 진행 시작만) 재접속 후에도 열린 상태 유지.
//
//   ※ 원작은 해금에 아이템을 소비하지만(quest_unlock_confirm_dialog_shortage_message),
//     blanc 계정은 무한재화 지향이라 아이템 차감은 생략. 필요 시 추후 추가.

interface UnlockBody {
    category: number
    quest_id: number
    viewer_id: number
    api_count: number
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/unlock", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as UnlockBody

        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid request body."
        })

        const viewerIdSession = await getSession(viewerId.toString())
        if (!viewerIdSession) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        const playerIds = await getAccountPlayers(viewerIdSession.accountId)
        const playerId = playerIds[0]
        if (isNaN(playerId)) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        const category = Number(body.category)
        const questId = Number(body.quest_id)

        // 이미 진행기록이 없으면 해금 레코드 삽입 (finished=false: 열렸지만 아직 미클리어).
        // 클라는 quest_progress 에 해당 quest 가 존재(unlocked)하는지로 해금을 판정하므로,
        // 레코드만 있으면 잠금이 풀린 것으로 인식된다.
        if (!isNaN(category) && !isNaN(questId)) {
            const existing = getPlayerSingleQuestProgressSync(playerId, category, questId)
            if (existing === null) {
                insertPlayerQuestProgressSync(playerId, category, {
                    questId: questId,
                    finished: false,
                })
            }
        }

        // 클라 successHandler 는 응답 body 를 안 읽고 로컬에서 Unlocked 처리 → 빈 data 로 충분.
        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: viewerId }),
            "data": {}
        })
    })
}

export default routes
