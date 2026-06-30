// Handles the player's own profile information screen.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccountPlayers, getPlayerCharactersSync, getPlayerPartyGroupListSync, getPlayerSync, getSession } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";
import { serializePartyGroupList } from "../../data/utils";

interface GetMyProfileBody {
    viewer_id: number
}

// Upper bounds captured from the live server. These are display-only caps; the
// client uses them to render "owned / max" counters and does not gate progression
// on them.
const maxOwnedCharacterCount = 454
const maxOpenedManaBoardSecondCount = 397
const maxOwnedDegreeCount = 1282

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/get_my_profile", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetMyProfileBody

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

        // get player
        const playerIds = await getAccountPlayers(viewerIdSession.accountId)
        const playerId = playerIds[0]
        const player = !isNaN(playerId) ? getPlayerSync(playerId) : null

        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // count the characters that the player actually owns
        const ownedCharacterCount = Object.keys(getPlayerCharactersSync(playerId)).length

        // serialize the player's party groups so they can be displayed on the profile
        const partyGroupList = serializePartyGroupList(getPlayerPartyGroupListSync(playerId))
        const userPartyGroupList: Object[] = []
        for (const [groupId, group] of Object.entries(partyGroupList)) {
            const partyList: Object[] = []
            for (const [partyId, party] of Object.entries(group.list)) {
                partyList.push({
                    "party_id": Number(partyId),
                    "party_group_id": Number(groupId),
                    "party_name": party.name,
                    "character_ids": party.character_ids,
                    "unison_character_ids": party.unison_character_ids,
                    "equipment_ids": party.equipment_ids,
                    "ability_soul_ids": party.ability_soul_ids,
                    "options": party.options,
                    "party_edited": party.edited
                })
            }
            userPartyGroupList.push({
                "party_group_id": Number(groupId),
                "party_group_color_id": group.color_id,
                "party_list": partyList
            })
        }

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "profile_info": {
                    "owned_character_count": ownedCharacterCount,
                    "max_owned_character_count": maxOwnedCharacterCount,
                    "opened_mana_board_second_count": 0,
                    "max_opened_mana_board_second_count": maxOpenedManaBoardSecondCount,
                    "owned_degree_count": 0,
                    "max_owned_degree_count": maxOwnedDegreeCount
                },
                "profile_settings": {
                    "show_owned_character_count": true,
                    "show_opened_mana_board_second_count": true,
                    "show_owned_degree_count": true
                },
                "user_party_group_list": userPartyGroupList
            }
        })
    })
}

export default routes;
