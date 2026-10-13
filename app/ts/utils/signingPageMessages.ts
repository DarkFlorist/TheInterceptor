import { SigningPageRequest, type DirectSigningRequest } from '../types/directSigning.js'
import { signingPageReplyCodecs, type SigningWalletsSuccess, type SigningMutationSuccess, type SigningRecordSuccess } from '../types/signingPageReply.js'

export function sendSigningPageRequest(request: Extract<SigningPageRequest, { method: 'signing_wallets' }>): Promise<SigningWalletsSuccess>
export function sendSigningPageRequest(request: Extract<SigningPageRequest, { method: 'signing_saveWallet' | 'signing_setSafeAccounts' }>): Promise<SigningMutationSuccess>
export function sendSigningPageRequest(request: DirectSigningRequest): Promise<SigningRecordSuccess>
export async function sendSigningPageRequest(request: SigningPageRequest) {
	const response: unknown = await browser.runtime.sendMessage(SigningPageRequest.serialize(request))
	if (response === undefined || response === null) throw new Error('Interceptor did not answer the signing request')
	const reply = signingPageReplyCodecs[request.method].parse(response)
	if (!reply.ok) throw new Error(reply.message)
	return reply
}
