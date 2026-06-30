// Handles login/premium bonus display acknowledgement.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";

interface ShownBody {
    api_count: number,
    viewer_id: number
}

const routes = async (fastify: FastifyInstance) => {
    // Acknowledges that the client has shown the player any pending bonus popups.
    // Starpoint awards all login bonuses up-front, so there is nothing pending and
    // the captured response is an empty array.
    fastify.post("/shown", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as ShownBody

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

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            "data_headers": generateDataHeaders({
                viewer_id: viewerId
            }),
            "data": []
        })
    })
}

export default routes;
