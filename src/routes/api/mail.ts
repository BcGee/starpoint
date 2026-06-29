// Handles mail.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccountPlayers, getPlayerSync, getSession, updatePlayerSync } from "../../data/wdfpData";
import { generateDataHeaders, getServerTime } from "../../utils";

interface IndexBody {
    api_count: number,
    viewer_id: number,
    app_secret: string,
    current_page: number,
    app_admin: string
}

interface ReceiveBody {
    viewer_id: number,
    mail_ids: number[]
}

interface ReceiveAllBody {
    viewer_id: number
}

const DAILY_BEADS = 1500  // 10연 분량

// Simple in-memory mail state per player
const claimedMails: Map<number, Set<number>> = new Map()

function getMailId(): number {
    // Use server time (day granularity) as mail ID so it changes when time advances
    return Math.floor(getServerTime() / 86400)
}

function hasClaimedToday(playerId: number): boolean {
    const claimed = claimedMails.get(playerId)
    if (!claimed) return false
    return claimed.has(getMailId())
}

function markClaimed(playerId: number) {
    let claimed = claimedMails.get(playerId)
    if (!claimed) {
        claimed = new Set()
        claimedMails.set(playerId, claimed)
    }
    claimed.add(getMailId())
}

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/index", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as IndexBody

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
        if (isNaN(playerId)) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        const mailId = getMailId()
        const alreadyClaimed = hasClaimedToday(playerId)

        const mail = alreadyClaimed ? [] : [
            {
                "id": mailId,
                "title": "데일리 보너스",
                "detail": `성도석 ${DAILY_BEADS}개가 도착했습니다!`,
                "create_time": getServerTime() - 3600,
                "expire_time": getServerTime() + 86400,
                "is_receive": false,
                "item_list": [
                    {
                        "type": 3,  // BEADS type
                        "id": 0,
                        "count": DAILY_BEADS
                    }
                ]
            }
        ]

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "mail": mail,
                "total_count": mail.length
            }
        })
    })

    fastify.post("/receive_all", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveAllBody

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
        const player = isNaN(playerId) ? null : getPlayerSync(playerId)
        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // check if already claimed
        if (hasClaimedToday(playerId)) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({
                    viewer_id: viewerId
                }),
                "data": {
                    "received_mail_ids": [],
                    "user_info": {
                        "free_vmoney": player.freeVmoney
                    },
                    "item_list": {},
                    "character_list": [],
                    "equipment_list": []
                }
            })
        }

        // give beads
        const newFreeVmoney = player.freeVmoney + DAILY_BEADS
        updatePlayerSync({
            id: playerId,
            freeVmoney: newFreeVmoney
        })
        markClaimed(playerId)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "received_mail_ids": [getMailId()],
                "user_info": {
                    "free_vmoney": newFreeVmoney
                },
                "item_list": {},
                "character_list": [],
                "equipment_list": []
            }
        })
    })

    fastify.post("/receive", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBody

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
        const player = isNaN(playerId) ? null : getPlayerSync(playerId)
        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No player bound to account."
        })

        // check if already claimed
        if (hasClaimedToday(playerId)) {
            reply.header("content-type", "application/x-msgpack")
            return reply.status(200).send({
                "data_headers": generateDataHeaders({
                    viewer_id: viewerId
                }),
                "data": {
                    "received_mail_ids": [],
                    "user_info": {
                        "free_vmoney": player.freeVmoney
                    },
                    "item_list": {},
                    "character_list": [],
                    "equipment_list": []
                }
            })
        }

        // give beads
        const newFreeVmoney = player.freeVmoney + DAILY_BEADS
        updatePlayerSync({
            id: playerId,
            freeVmoney: newFreeVmoney
        })
        markClaimed(playerId)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "received_mail_ids": [getMailId()],
                "user_info": {
                    "free_vmoney": newFreeVmoney
                },
                "item_list": {},
                "character_list": [],
                "equipment_list": []
            }
        })
    })
}

export default routes;
