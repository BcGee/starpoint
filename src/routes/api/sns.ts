// Handles SNS (social networking service) integration data.

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/wdfpData";
import { generateDataHeaders } from "../../utils";

interface GetBody {
    viewer_id: number,
    sns_type: number
}

const routes = async (fastify: FastifyInstance) => {
    // Returns SNS-linked bonus/reward data. Starpoint has no SNS integration,
    // so the captured response is an empty array.
    fastify.post("/get", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GetBody

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
