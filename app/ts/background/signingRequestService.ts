import { SigningPageRequest } from '../types/directSigning.js'
import { isSigningPageMethod, SigningPageReply } from '../types/signingPageReply.js'
import type { PopupMessage } from '../types/interceptor-messages.js'
import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { advanceDirectSigning, getDirectSigningReview, getSignatureRefusalReason } from './signingRequestLifecycle.js'
import { authorizeDirectSigningDevice } from './directSigning.js'
import { isSigningOperationError } from '../signing/signingOperationError.js'
import { getSigningWalletBindingsReply, getSigningWallets, saveSigningWallet } from './signingWalletHandlers.js'
import { setSafeSigningAccounts } from './safeSigningAccountHandler.js'
import { resolvePendingRequestInstance, updateConfirmTransactionView } from './windows/confirmTransaction.js'

// Popup and signing-page messages share one runtime channel, so no method may belong to both protocols; this fails to compile if one does.
const popupAndSigningMethodsAreDisjoint: [Extract<PopupMessage['method'], SigningPageRequest['method']>] extends [never] ? true : never = true

/** Route only inside the extension-page sender boundary; signing does not enter popup lifecycle dispatch. A message is a signing-page message only when its method is one of the signing service's methods; anything else goes to the popup handler. */
export function isSigningPageMessage(message: unknown) {
	return popupAndSigningMethodsAreDisjoint && typeof message === 'object' && message !== null && 'method' in message && typeof message.method === 'string' && isSigningPageMethod(message.method)
}

export async function dispatchSigningPageRequest(request: SigningPageRequest, services: SimulationServices, connections: WebsiteTabConnections): Promise<SigningPageReply> {
	switch (request.method) {
		case 'signing_walletBindings': return await getSigningWalletBindingsReply()
		case 'signing_wallets': return await getSigningWallets()
		case 'signing_saveWallet': return await saveSigningWallet(request)
		case 'signing_setSafeAccounts': return await setSafeSigningAccounts(request, services.ethereum)
		// A device grant carries no reply enrichment: its mode check must stay the last step before the reply.
		case 'signing_authorizeDevice': return await authorizeDirectSigningDevice(request).catch((error: unknown) => {
			if (!isSigningOperationError(error)) throw error
			return { ok: false as const, message: error.message }
		})
		default: {
			const outcome = await advanceDirectSigning(request, services.ethereum, services.tokenPriceService)
			if (outcome.refreshConfirmation) await updateConfirmTransactionView(services.ethereum, services.tokenPriceService)
			if (outcome.confirmation !== undefined) await resolvePendingRequestInstance(services.ethereum, services.tokenPriceService, connections, outcome.confirmation.confirmation, outcome.confirmation.requestInstance)
			if (!outcome.reply.ok) return outcome.reply
			// Obtaining a signature does not mean the website received it: resolving can refuse it and leave the website request pending with a signer error. That stored error, rather than the resolver's return value, is the record of the refusal, so a reloaded signing page reports it as well.
			const [signatureRefusalReason, review] = await Promise.all([getSignatureRefusalReason(outcome.reply.record), getDirectSigningReview(outcome.reply.record)])
			return { ...outcome.reply, ...signatureRefusalReason === undefined ? {} : { signatureRefusalReason }, ...review === undefined ? {} : { review } }
		}
	}
}

export async function signingPageMessageHandler(message: unknown, services: SimulationServices, connections: WebsiteTabConnections) {
	const request = SigningPageRequest.safeParse(message)
	if (!request.success) return SigningPageReply.serialize({ ok: false, message: 'Invalid signing-page request' })
	return SigningPageReply.serialize(await dispatchSigningPageRequest(request.value, services, connections))
}
