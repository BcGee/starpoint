import { randomInt } from "crypto"
import { FastifyRequest } from "fastify"

// Server time is stored as an ANCHOR, not a frozen instant, so the clock KEEPS TICKING
// from the pinned date. `anchorServerMs` = the in-game epoch (ms) we pinned to, and
// `anchorRealMs` = the real wall-clock (ms) at the moment we pinned it. The current
// server time is then `anchorServerMs + (Date.now() - anchorRealMs)` — i.e. the pinned
// date plus however much real time has elapsed since. This makes time-based mechanics
// (stamina natural recovery, daily reset, event windows) actually progress in real time
// instead of being frozen. When no anchor is set, we fall back to the real clock.
let anchorServerMs: number | null = null;
let anchorRealMs: number = Date.now();

/**
 * Returns the current server time as a unix epoch (seconds), ticking from the anchor.
 *
 * @param date An optional date; if provided, returns THAT date's epoch (unchanged behaviour
 *             for callers that pass a specific stored timestamp, e.g. stamina_heal_time).
 * @returns The unix epoch in seconds.
 */
export function getServerTime(
    date?: Date
): number {
    if (date !== undefined) return Math.floor(date.getTime() / 1000)
    return Math.floor(getServerDate().getTime() / 1000)
}

/**
 * Gets the current server time as a Date, ticking from the anchor.
 *
 * @returns The current server time as a date.
 */
export function getServerDate(): Date {
    if (anchorServerMs === null) return new Date()
    return new Date(anchorServerMs + (Date.now() - anchorRealMs))
}

/**
 * Pins the server clock. Passing a Date sets the anchor to that in-game moment and starts
 * the clock ticking from now; passing null reverts to the real wall clock.
 */
export function setServerTime(date: Date | null) {
    if (date === null) {
        anchorServerMs = null
    } else {
        anchorServerMs = date.getTime()
        anchorRealMs = Date.now()
    }
}

/**
 * Converts a server time value (unix epoch in seconds) into a Date.
 * 
 * @param serverTime The unix epoch value.
 * @returns The date.
 */
export function getDateFromServerTime(serverTime: number): Date {
    return new Date(serverTime * 1000)
}

/**
 * Generates an IdpAlias to identify a particular device.
 * 
 * @param appId 
 * @param idpId 
 * @param serialNo 
 * @returns The generated IdpAlias
 */
export function generateIdpAlias(
    appId: string,
    deviceId: string,
    serialNo: string
): string {
    return `${appId}:${deviceId}:${serialNo}`
}

/**
 * Generates a random viewer ID using the crypto library.
 * 
 * @returns A number between 100,000,000 and 999,999,999
 */
export function generateViewerId(): number {
    return randomInt(100000000, 999999999)
}

export interface DataHeaders {
    force_update?: boolean
    asset_update?: boolean
    short_udid?: number
    viewer_id?: number
    servertime?: number
    result_code?: number
    udid?: string
}

/**
 * Generates a default data headers object, which is used in communication with the client.
 * 
 * @param customValues A partial DataHeaders object with custom fields to replace the default ones.
 * @returns A DataHeaders object.
 */
export function generateDataHeaders(
    customValues: Partial<DataHeaders> = {},
    fields: (keyof DataHeaders)[] = ['force_update', 'asset_update', 'short_udid', 'viewer_id', 'servertime', 'result_code'],
): Record<string, any> {
    const defaultHeaders: DataHeaders = {
        force_update: false,
        asset_update: false,
        short_udid: 0,
        viewer_id: 0,
        servertime: getServerTime(), //1651514014,//getServerTime(),
        result_code: 1
    }
    const headers: Record<string, any> = {}

    for (const field of fields) {
        const customValue = customValues[field]
        const defaultValue = defaultHeaders[field]
        headers[field] = customValue === undefined ? defaultValue : customValue
    }

    return headers
}

export enum Platform {
    ANDROID,
    IOS
}

export function getRequestPlatformSync(
    request: FastifyRequest
): Platform {
    // check user agent
    if ((request.headers["user-agent"] || '').includes('iOS;'))
        return Platform.IOS;

    // check requestedby header
    if ((request.headers["requestedby"] || '') === 'ios')
        return Platform.IOS;

    return Platform.ANDROID
}