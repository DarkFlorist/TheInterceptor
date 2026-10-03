import { isSigningOperationError } from '../signing/signingOperationError.js'
import { isInvalidSigningResponse } from '../signing/exactPayload.js'
import type { SigningPageReply } from '../types/signingPageReply.js'
import type { DirectSigningRequest } from '../types/directSigning.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { updateDirectSigning, refreshDirectSigningReview } from './directSigning.js'
import { resolvePendingTransactionOrMessage, updateConfirmTransactionView } from './windows/confirmTransaction.js'

export async function directSigningPageHandler(request: DirectSigningRequest, ethereum: EthereumClientService, prices: TokenPriceService, connections: WebsiteTabConnections): Promise<SigningPageReply> {
	try {
		const record = await updateDirectSigning(request, async (edited) => await refreshDirectSigningReview(edited, ethereum, prices))
		if (request.method === 'signing_editFees') {
			await updateConfirmTransactionView(ethereum, prices)
		}
		if (record.phase === 'cancelled') {
			await resolvePendingTransactionOrMessage(ethereum, prices, connections, { method: 'popup_confirmDialog', data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier: record.request } })
		} else if (record.input.method === 'eth_sendTransaction' ? ['submitted', 'confirmed'].includes(record.phase) : record.phase === 'signed') {
			await resolvePendingTransactionOrMessage(ethereum, prices, connections, { method: 'popup_confirmDialog', data: { action: 'signerIncluded', uniqueRequestIdentifier: record.request, signerReply: record.input.method === 'eth_sendTransaction' ? record.transactionHash : record.result } })
		}
		return { ok: true, record: record }
	} catch (error) {
		if (!isSigningOperationError(error) && !isInvalidSigningResponse(error)) throw error
		return { ok: false, message: error.message }
	}
}
