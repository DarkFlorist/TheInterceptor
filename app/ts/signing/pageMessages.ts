import type { SigningPageRequest } from '../types/directSigning.js'
import { sendPopupMessageWithReply } from '../background/backgroundUtils.js'

function isSuccessfulReply<Reply extends { ok: boolean }>(reply: Reply): reply is Extract<Reply, { ok: true }> {
	return reply.ok
}

export async function sendSigningPageRequest<Request extends SigningPageRequest>(request: Request) {
	const reply = await sendPopupMessageWithReply(request)
	if (reply === undefined) throw new Error('Interceptor did not answer the signing request')
	if (!isSuccessfulReply(reply)) throw new Error('message' in reply ? String(reply.message) : 'Signing request failed')
	return reply
}
