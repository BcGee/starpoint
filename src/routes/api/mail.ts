// Handles the player mailbox: listing mails, and receiving their attached rewards.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccountPlayers, getPlayerMailSync, getPlayerMailCountSync, getPlayerMailsSync, getPlayerSync, getSession, insertPlayerMailSync, playerHasMailForDayKeySync, setPlayerMailReceivedSync } from "../../data/wdfpData";
import { generateDataHeaders, getServerTime, getServerDate } from "../../utils";
import { clientSerializeDate } from "../../data/utils";
import { givePlayerRewardsSync } from "../../lib/quest";
import { CharacterReward, CurrencyReward, EquipmentItemReward, Reward, RewardType } from "../../lib/types";
import { PlayerMail, PlayerMailAttachment } from "../../data/types";

// Daily login bonus: 1500 PAID beads (유료 성도석), delivered as a real mail.
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
            { rewardType: RewardType.PAID_BEADS, rewardId: null, number: DAILY_BEADS }
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

// The client's mail attachment "type" field is a MailType int (verified from the SWF
// mail type→MailKind converter). Mapping:
//   1=Item(needs type_id) 3=PaidVirtualMoney(유료 성도석) 4=FreeVirtualMoney(무료 성도석)
//   5=Character(needs type_id) 6=Equipment(needs type_id) 7=StarCrumb 8=FreeMana
//   9=PooledExperience 10=BondToken 11=BossBoostPoint 12=BoostPoint
// For type 3/4/7/8/9/... (currency-like) the client REQUIRES type_id to be null
// (Option.None) — sending a type_id there throws MailTypeId error on the client.
const ClientMailType = {
    CHARACTER: 5,
    EQUIPMENT: 6,
    ITEM: 1,
    MANA: 8,           // FreeMana
    PAID_BEADS: 3,     // PaidVirtualMoney (유료 성도석)
    BEADS: 4,          // FreeVirtualMoney (무료 성도석)
    EXP: 9             // PooledExperience
} as const

function clientMailTypeForReward(rewardType: number): number {
    switch (rewardType) {
        case RewardType.CHARACTER: return ClientMailType.CHARACTER
        case RewardType.EQUIPMENT: return ClientMailType.EQUIPMENT
        case RewardType.ITEM: return ClientMailType.ITEM
        case RewardType.MANA: return ClientMailType.MANA
        case RewardType.PAID_BEADS: return ClientMailType.PAID_BEADS
        case RewardType.BEADS: return ClientMailType.BEADS
        case RewardType.EXP: return ClientMailType.EXP
        default: return ClientMailType.ITEM
    }
}

// Currency-like mail types must send type_id = null (client throws if a type_id is
// present for these). Only Item/Character/Equipment/Degree/... carry a type_id.
function clientMailTypeNeedsTypeId(clientType: number): boolean {
    return clientType === ClientMailType.ITEM
        || clientType === ClientMailType.CHARACTER
        || clientType === ClientMailType.EQUIPMENT
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

// Sentinel value for an unreceived mail's receive_time.
//
// The client (worldflipper_android_release.swf) decides whether a mail is already
// received purely from receive_time, via:
//   hasReceived() = get_receiveDate().index == 0        // Some(...) => received
//   get_receiveDate(): isEmpty(receive_time) ? None : Some(parse(receive_time))
//   isEmpty(s) = (s == "0000-00-00 00:00:00")           // the zero sentinel
// So an UNRECEIVED mail must carry receive_time == "0000-00-00 00:00:00":
//   - it is a non-null String  -> no c8702 (the field is JapanStandardTimeString,
//     NOT Option<>, so null crashes the msgpack decode)
//   - isEmpty() is true         -> get_receiveDate() = None -> shown as unreceived
// Sending create_time (a real date) here was the bug that made every mail show as
// "already received". Only a genuinely received mail should carry its real timestamp.
const MAIL_RECEIVE_TIME_UNSET = "0000-00-00 00:00:00"

// Serializes a PlayerMail into the client representation shown in the mailbox.
//
// Field nullability MUST match the client's TypePacker schema for
// `pinball.remote.mail.Mail` (verified by decompiling the SWF, resolveMap662):
//   - type_id           : Option<MailTypeId>  (nullable)
//   - reward_limit_time  : Option<JapanStandardTimeString> (nullable)
//   - subject/description: Option<String>      (nullable)
//   - receive_time       : JapanStandardTimeString  (NOT Option — never null; use the
//                          zero sentinel above for unreceived mail)
//   - type/reason_id/number/id : Int  (NOT nullable)
function serializeMail(mail: PlayerMail) {
    // The mailbox list represents a mail's primary attachment inline.
    const primary = mail.attachments[0]
    const clientType = primary ? clientMailTypeForReward(primary.rewardType) : 0
    // Only Item/Character/Equipment-type mail carries a type_id; currency-like types
    // (paid/free 성도석, mana, exp, ...) MUST send null or the client throws a
    // MailTypeId error while decoding the mail type→MailKind conversion.
    const typeId = (primary && clientMailTypeNeedsTypeId(clientType)) ? primary.rewardId : null
    return {
        "id": mail.id,
        "reason_id": mail.reasonId,
        "subject": mail.subject,
        "description": mail.description,
        "type": clientType,
        "type_id": typeId,
        "number": primary ? primary.number : 0,
        "create_time": clientSerializeDate(mail.createTime),
        // Unreceived -> zero sentinel (client reads this as "not received"); received
        // -> the real receive timestamp. Never null (would trigger c8702).
        "receive_time": mail.receiveTime === null ? MAIL_RECEIVE_TIME_UNSET : clientSerializeDate(mail.receiveTime),
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
            case RewardType.PAID_BEADS:
                rewards.push({ name: "", type: RewardType.PAID_BEADS, count: attachment.number } as CurrencyReward)
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
                    "vmoney": player.vmoney + (rewardResult?.user_info.vmoney ?? 0),
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
                    "vmoney": player.vmoney + (rewardResult?.user_info.vmoney ?? 0),
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
