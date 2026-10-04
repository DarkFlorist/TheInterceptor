import { SigningPageRequest } from '../types/directSigning.js'
import { SigningPageReply } from '../types/signingPageReply.js'
import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { advanceDirectSigning } from './signingRequestLifecycle.js'
import { getSigningWallets, saveSigningWallet } from './signingWalletHandlers.js'
import { setSafeSigningAccounts } from './safeSigningAccountHandler.js'
import { resolvePendingTransactionOrMessage, updateConfirmTransactionView } from './windows/confirmTransaction.js'

/** Route only inside the extension-page sender boundary; signing does not enter popup lifecycle dispatch. */
export function isSigningPageMessage(message: unknown) {
	return typeof message === 'object' && message !== null && 'method' in message && typeof message.method === 'string' && message.method.startsWith('signing_')
}

export async function dispatchSigningPageRequest(request: SigningPageRequest, services: SimulationServices, connections: WebsiteTabConnections): Promise<SigningPageReply> {
	switch (request.method) {
		case 'signing_wallets': return await getSigningWallets()
		case 'signing_saveWallet': return await saveSigningWallet(request)
		case 'signing_setSafeAccounts': return await setSafeSigningAccounts(request, services.ethereum)
		default: {
			const outcome = await advanceDirectSigning(request, services.ethereum, services.tokenPriceService)
			if (outcome.refreshConfirmation) await updateConfirmTransactionView(services.ethereum, services.tokenPriceService)
			if (outcome.confirmation !== undefined) await resolvePendingTransactionOrMessage(services.ethereum, services.tokenPriceService, connections, outcome.confirmation)
			return outcome.reply
		}
	}
}

export async function signingPageMessageHandler(message: unknown, services: SimulationServices, connections: WebsiteTabConnections) {
	const request = SigningPageRequest.safeParse(message)
	if (!request.success) return SigningPageReply.serialize({ ok: false, message: 'Invalid signing-page request' })
	return SigningPageReply.serialize(await dispatchSigningPageRequest(request.value, services, connections))
}
