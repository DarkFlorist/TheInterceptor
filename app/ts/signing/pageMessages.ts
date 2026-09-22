import { SigningPageRequest } from '../types/directSigning.js'
import * as funtypes from 'funtypes'

const SigningPageReply = funtypes.ReadonlyObject({ ok: funtypes.Boolean }).And(funtypes.ReadonlyPartial({ message: funtypes.String, record: funtypes.Unknown, bindings: funtypes.Unknown, tabs: funtypes.Unknown }))

export async function sendSigningPageRequest(request: SigningPageRequest) {
	const reply = SigningPageReply.parse(await browser.runtime.sendMessage(SigningPageRequest.serialize(request)))
	if (!reply.ok) throw new Error(reply.message ?? 'Interceptor did not answer the signing request')
	return reply
}
