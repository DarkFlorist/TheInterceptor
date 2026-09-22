import * as funtypes from 'funtypes'
import { JsonValue } from '../types/safeApps.js'
import { addressString } from '../utils/bigint.js'
import { requestSafeAppsGateway, safeAppsServiceError } from './safeAppsGateway.js'

const SafeTransactionDetails = funtypes.ReadonlyObject({
	safeAddress: funtypes.String,
	txId: funtypes.String,
	txStatus: funtypes.String,
	txInfo: funtypes.ReadonlyObject({ type: funtypes.String }),
	detailedExecutionInfo: funtypes.ReadonlyObject({ type: funtypes.Literal('MULTISIG'), safeTxHash: funtypes.String }),
})

export async function fetchSafeAppsTransaction(chainId: bigint, safeAddress: bigint, safeTxHash: string) {
	const address = addressString(safeAddress)
	const transactionId = `multisig_${ address }_${ safeTxHash }`
	const result = await requestSafeAppsGateway(`chains/${ chainId.toString() }/transactions/${ transactionId }`, 'transaction', undefined, true)
	if (result === undefined) throw safeAppsServiceError('Safe transaction not found for the selected Safe and network. Use a Safe transaction hash; local drafts and transactions not yet indexed by the Safe service are unavailable.')
	const details = SafeTransactionDetails.safeParse(result)
	if (!details.success
		|| details.value.safeAddress.toLowerCase() !== address.toLowerCase()
		|| details.value.txId.toLowerCase() !== transactionId.toLowerCase()
		|| details.value.detailedExecutionInfo.safeTxHash.toLowerCase() !== safeTxHash) {
		throw safeAppsServiceError('The Safe transaction service returned invalid or mismatched transaction details.')
	}
	// Preserve the gateway's transaction data, confirmations and optional SDK fields after checking the requested identity.
	return JsonValue.parse(result)
}
