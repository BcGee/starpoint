import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession, getAccountPlayers, getPlayerPartyGroupListSync } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";

// carnival_event (카니발 이벤트 = 하니와 등) 라우트.
//
// 클라 요청 (SWF 확정):
//   POST /carnival_event/index      { event_id, viewer_id }
//   POST /carnival_event/get_party  { viewer_id }
//
// 클라 successHandler 스키마 (carnival_event/index + get_party) — SWF 디컴파일로 확정
// (CarnivalEventIndexRealRemote.successHandler / applyCarnivalEventGetParty):
//   data.records: Array<{ best_score:Float?, folder_id:Int, previous_character_ids:[Int?],
//                         previous_score:Float?, previous_unison_character_ids:[Int?] }>
//   data.user_party_group_list: Array<{ party_group_id:Int, party_group_color_id:Int,
//     party_list: Array<{
//        ability_soul_ids:[Int?], character_ids:[Int?], equipment_ids:[Int?], unison_character_ids:[Int?],
//        party_id:Int, party_name:String, party_edited:Bool,      ← ★ party_* 접두사 + party_id 필수
//        options:{allow_other_players_to_heal_me:Bool} }> }>
// ⚠️ 함정(확정): carnival 의 party_list 원소는 /load 와 필드명이 다르다.
//   /load(맵형) = name / edited (party_id 없음).  carnival(배열형) = party_name / party_edited / party_id.
//   서버가 /load 필드명(name/edited, party_id 누락)으로 보내면 클라 validator 가
//   8702(party_name)/8703(party_edited)/8700(party_id) 를 던지고 응답 디코드에 실패 → 크래시 → 재로그인.
//   (그래서 라우트는 200 인데도 하니와 진입 시 재접속 루프였음.)
//   신규/미플레이 상태면 records 는 빈 배열이면 됨(클라가 iterator 로 순회, 빈 배열 OK).

async function resolvePlayerId(viewerId: number): Promise<number | null> {
    if (!viewerId || isNaN(viewerId)) return null
    const session = await getSession(viewerId.toString())
    if (!session) return null
    const playerIds = await getAccountPlayers(session.accountId)
    const playerId = playerIds[0]
    return isNaN(playerId) ? null : playerId
}

// 플레이어 파티그룹을 carnival 스키마(배열 + party_group_id, party_list 원소는 party_* 필드)로 변환.
function serializeCarnivalPartyGroups(playerId: number) {
    const groups = getPlayerPartyGroupListSync(playerId) // Record<groupId, {list, colorId}>
    const out: Array<{
        party_group_id: number
        party_group_color_id: number
        party_list: Array<Record<string, unknown>>
    }> = []
    for (const [groupId, group] of Object.entries(groups)) {
        const partyList: Array<Record<string, unknown>> = []
        // group.list 는 Record<slot, party> — slot 이 곧 party_id.
        for (const [slot, party] of Object.entries(group.list)) {
            partyList.push({
                "ability_soul_ids": party.abilitySoulIds,
                "character_ids": party.characterIds,
                "equipment_ids": party.equipmentIds,
                "unison_character_ids": party.unisonCharacterIds,
                // ★ carnival 은 party_* 접두사 + party_id (클라 validator 필수 필드)
                "party_id": Number(slot),
                "party_name": party.name,
                "party_edited": party.edited,
                "options": {
                    "allow_other_players_to_heal_me": party.options.allowOtherPlayersToHealMe
                }
            })
        }
        out.push({
            party_group_id: Number(groupId),
            party_group_color_id: group.colorId,
            party_list: partyList
        })
    }
    return out
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/index", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { event_id: number, viewer_id: number, api_count: number }
        const playerId = await resolvePlayerId(body.viewer_id)
        if (playerId === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: body.viewer_id }),
            "data": {
                "records": [],
                "user_party_group_list": serializeCarnivalPartyGroups(playerId)
            }
        })
    })

    fastify.post("/get_party", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { viewer_id: number, api_count: number }
        const playerId = await resolvePlayerId(body.viewer_id)
        if (playerId === null) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Invalid viewer id."
        })

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({ viewer_id: body.viewer_id }),
            "data": {
                "user_party_group_list": serializeCarnivalPartyGroups(playerId)
            }
        })
    })
}

export default routes
