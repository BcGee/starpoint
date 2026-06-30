// Handles the player mailbox: listing mails, and receiving their attached rewards.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccountPlayers, getPlayerMailSync, getPlayerMailCountSync, getPlayerMailsSync, getPlayerSync, getSession, insertPlayerMailSync, playerHasMailForDayKeySync, setPlayerMailReceivedSync } from "../../data/wdfpData";
import { generateDataHeaders, getServerTime, getServerDate } from "../../utils";
import { clientSerializeDate } from "../../data/utils";
import { givePlayerRewardsSync } from "../../lib/quest";
import { CharacterReward, CurrencyReward, EquipmentItemReward, Reward, RewardType } from "../../lib/types";
import { PlayerMail, PlayerMailAttachment } from "../../data/types";

// Daily login bonus: 1500 beads (one 10-pull's worth), delivered as a real mail.
// reason_id 1 marks the daily-bonus mail type; the mail's description stores the
// server-time day key so issuance is idempotent (one per server-time day, and
// persisted in the DB so it survives restarts — unlike the old in-memory marker).
const DAILY_BEADS = 1500
const DAILY_BONUS_REASON_ID = 1

// Returns the server-time day key (UTC date) used to deduplicate daily mail.
function serverDayKey(): string {
    return getServerDate().toISOString().slice(0, 10)
}

// Ensures the player has today's daily-bonus mail in their inbox. Idempotent:
// if a mail with this day's key already exists, nothing happens. Returns nothing;
// the mail is then surfaced/claimed through the normal mailbox flow.
function ensureDailyBonusMail(playerId: number) {
    const dayKey = serverDayKey()
    if (playerHasMailForDayKeySync(playerId, DAILY_BONUS_REASON_ID, dayKey)) return

    const now = getServerDate()
    insertPlayerMailSync(playerId, {
        reasonId: DAILY_BONUS_REASON_ID,
        subject: "데일리 보너스",
        description: dayKey, // day key used for idempotency
        createTime: now,
        receiveTime: null,
        rewardPeriodLimited: false,
        rewardLimitTime: null,
        received: false,
        attachments: [
            { rewardType: RewardType.BEADS, rewardId: null, number: DAILY_BEADS }
        ]
    })
}

interface IndexBody {
    api_count: number,
    viewer_id: number,
    app_secret: string,
    current_page: number,
    app_admin: string
}

interface ReceiveBody {
    mail_id: number,
    api_count: number,
    viewer_id: number
}

interface ReceiveAllBody {
    api_count: number,
    mail_ids: number[],
    viewer_id: number
}

// The client's mail attachment tuple uses a "type" field that does NOT match the
// internal RewardType enum ordering. These constants map our stored RewardType
// onto the client-facing mail attachment `type` values observed in captured traffic
// (type 1 = character, 4 = mana, 5 = equipment, 6 = item).
const ClientMailType = {
    CHARACTER: 1,
    EQUIPMENT: 5,
    ITEM: 6,
    MANA: 4,
    BEADS: 3,
    EXP: 7
} as const

function clientMailTypeForReward(rewardType: number): number {
    switch (rewardType) {
        case RewardType.CHARACTER: return ClientMailType.CHARACTER
        case RewardType.EQUIPMENT: return ClientMailType.EQUIPMENT
        case RewardType.ITEM: return ClientMailType.ITEM
        case RewardType.MANA: return ClientMailType.MANA
        case RewardType.BEADS: return ClientMailType.BEADS
        case RewardType.EXP: return ClientMailType.EXP
        default: return ClientMailType.ITEM
    }
}

// Serializes a mail's attachment into the (type, type_id, number) tuple the client
// renders in the mailbox list.
function serializeMailAttachment(attachment: PlayerMailAttachment) {
    return {
        "type": clientMailTypeForReward(attachment.rewardType),
        "type_id": attachment.rewardId,
        "number": attachment.number
    }
}

// Serializes a PlayerMail into the client representation shown in the mailbox.
function serializeMail(mail: PlayerMail) {
    // The mailbox list represents a mail's primary attachment inline.
    const primary = mail.attachments[0]
    return {
        "id": mail.id,
        "reason_id": mail.reasonId,
        "subject": mail.subject,
        "description": mail.description,
        "type": primary ? clientMailTypeForReward(primary.rewardType) : 0,
        "type_id": primary ? primary.rewardId : null,
        "number": primary ? primary.number : 0,
        "create_time": clientSerializeDate(mail.createTime),
        "receive_time": mail.receiveTime === null ? null : clientSerializeDate(mail.receiveTime),
        "reward_period_limited": mail.rewardPeriodLimited,
        "reward_limit_time": mail.rewardLimitTime === null ? null : clientSerializeDate(mail.rewardLimitTime)
    }
}

// Converts a mail's stored attachments into Reward objects that givePlayerRewardsSync
// understands.
function attachmentsToRewards(attachments: PlayerMailAttachment[]): Reward[] {
    const rewards: Reward[] = []
    for (const attachment of attachments) {
        switch (attachment.rewardType) {
            case RewardType.ITEM:
                rewards.push({ name: "", type: RewardType.ITEM, id: attachment.rewardId ?? 0, count: attachment.number } as EquipmentItemReward)
                break;
            case RewardType.EQUIPMENT:
                rewards.push({ name: "", type: RewardType.EQUIPMENT, id: attachment.rewardId ?? 0, count: attachment.number } as EquipmentItemReward)
                break;
            case RewardType.CHARACTER:
                // award one entry per `number`, since characters are granted individually
                for (let i = 0; i < Math.max(1, attachment.number); i++) {
                    rewards.push({ name: "", type: RewardType.CHARACTER, id: attachment.rewardId ?? 0 } as CharacterReward)
                }
                break;
            case RewardType.MANA:
                rewards.push({ name: "", type: RewardType.MANA, count: attachment.number } as CurrencyReward)
                break;
            case RewardType.BEADS:
                rewards.push({ name: "", type: RewardType.BEADS, count: attachment.number } as CurrencyReward)
                break;
            case RewardType.EXP:
                rewards.push({ name: "", type: RewardType.EXP, count: attachment.number } as CurrencyReward)
                break;
        }
    }
    return rewards
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
            "message": "No players bound to account."
        })

        // ensure today's daily login bonus is present, then read the mailbox
        ensureDailyBonusMail(playerId)
        const finalMails = getPlayerMailsSync(playerId)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "mail": finalMails.map(serializeMail),
                "total_count": finalMails.length
            }
        })
    })

    // Receives a single mail's attachments: grants the rewards and marks the mail
    // as received so it no longer appears in the mailbox.
    fastify.post("/receive", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ReceiveBody

        const viewerId = body.viewer_id
        const mailId = body.mail_id
        if (!viewerId || isNaN(viewerId) || mailId === undefined || isNaN(mailId)) return reply.status(400).send({
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

        // fetch the mail
        ensureDailyBonusMail(playerId)
        const mail = getPlayerMailSync(playerId, mailId)
        if (mail === null || mail.received) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Mail not found or already received."
        })

        // grant the rewards
        const rewardResult = givePlayerRewardsSync(playerId, attachmentsToRewards(mail.attachments))

        // mark the mail as received
        setPlayerMailReceivedSync(playerId, mailId)

        const remainingCount = getPlayerMailCountSync(playerId)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "free_mana": player.freeMana + (rewardResult?.user_info.free_mana ?? 0),
                    "free_vmoney": player.freeVmoney + (rewardResult?.user_info.free_vmoney ?? 0),
                    "exp_pool": player.expPool + (rewardResult?.user_info.exp_pool ?? 0),
                    "exp_pooled_time": getServerTime(player.expPooledTime)
                },
                "character_list": rewardResult?.character_list ?? [],
                "equipment_list": rewardResult?.equipment_list ?? [],
                "item_list": rewardResult?.items ?? {},
                "dispose_expired_mail": false,
                "auto_sale_expired_mail": false,
                "total_count": remainingCount,
                "mail_arrived": false
            }
        })
    })

    // Receives a batch of mails. Grants the attachments of each requested mail that
    // is present and unreceived, then marks them as received.
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
        const player = !isNaN(playerId) ? getPlayerSync(playerId) : null
        if (player === null) return reply.status(500).send({
            "error": "Internal Server Error",
            "message": "No players bound to account."
        })

        // ensure today's daily bonus is present so "receive all" includes it
        ensureDailyBonusMail(playerId)

        // if the client sent explicit ids, use them; otherwise claim every
        // unreceived mail in the box (the "receive all" button sends no ids).
        const requestedIds = Array.isArray(body.mail_ids) && body.mail_ids.length > 0
            ? body.mail_ids
            : getPlayerMailsSync(playerId).map(m => m.id)

        // collect all attachments across the requested mails, skipping any that are
        // missing or already received
        const allAttachments: PlayerMailAttachment[] = []
        const processedIds: number[] = []
        let alreadyCount = 0
        for (const mailId of requestedIds) {
            const mail = getPlayerMailSync(playerId, mailId)
            if (mail === null || mail.received) {
                alreadyCount += 1
                continue
            }
            allAttachments.push(...mail.attachments)
            setPlayerMailReceivedSync(playerId, mailId)
            processedIds.push(mailId)
        }

        // grant all collected rewards in one pass
        const rewardResult = givePlayerRewardsSync(playerId, attachmentsToRewards(allAttachments))

        const remainingCount = getPlayerMailCountSync(playerId)

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": {
                "user_info": {
                    "free_mana": player.freeMana + (rewardResult?.user_info.free_mana ?? 0),
                    "free_vmoney": player.freeVmoney + (rewardResult?.user_info.free_vmoney ?? 0),
                    "exp_pool": player.expPool + (rewardResult?.user_info.exp_pool ?? 0),
                    "exp_pooled_time": getServerTime(player.expPooledTime)
                },
                "character_list": rewardResult?.character_list ?? [],
                "equipment_list": rewardResult?.equipment_list ?? [],
                "item_list": rewardResult?.items ?? {},
                "mail_ids": processedIds,
                "deleted_mail_count": 0,
                "already_mail_count": alreadyCount,
                "outdated_mail_count": 0,
                "dispose_expired_mail_count": 0,
                "auto_sale_expired_mail_count": 0,
                "max_overed_mail_count": 0,
                "total_count": remainingCount,
                "mail_arrived": false
            }
        })
    })
}

export default routes;
