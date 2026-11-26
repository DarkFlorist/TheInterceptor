import * as funtypes from 'funtypes'
import { JsonValue } from '../types/gnosisSafeApps.js'
import { addressString } from '../utils/bigint.js'
import { requestGnosisSafeAppsGateway, gnosisSafeAppsServiceError } from './gnosisSafeAppsGateway.js'

const GnosisSafeTransactionDetails = funtypes.ReadonlyObject({
	safeAddress: funtypes.String,
	txId: funtypes.String,
	txStatus: funtypes.String,
	txInfo: funtypes.ReadonlyObject({ type: funtypes.String }),
	detailedExecutionInfo: funtypes.ReadonlyObject({ type: funtypes.Literal('MULTISIG'), safeTxHash: funtypes.String }),
})

export async function fetchGnosisSafeAppsTransaction(chainId: bigint, safeAddress: bigint, safeTxHash: string) {
	const address = addressString(safeAddress)
	const transactionId = `multisig_${ address }_${ safeTxHash }`
	const result = await requestGnosisSafeAppsGateway(`chains/${ chainId.toString() }/transactions/${ transactionId }`, 'transaction', undefined, true)
	if (result === undefined) throw gnosisSafeAppsServiceError('Gnosis Safe transaction not found for the selected Gnosis Safe and network. Use a Gnosis Safe transaction hash; local drafts and transactions not yet indexed by the Gnosis Safe service are unavailable.')
	const details = GnosisSafeTransactionDetails.safeParse(result)
	if (!details.success
		|| details.value.safeAddress.toLowerCase() !== address.toLowerCase()
		|| details.value.txId.toLowerCase() !== transactionId.toLowerCase()
		|| details.value.detailedExecutionInfo.safeTxHash.toLowerCase() !== safeTxHash) {
		throw gnosisSafeAppsServiceError('The Gnosis Safe transaction service returned invalid or mismatched transaction details.')
	}
	// Preserve the gateway's transaction data, confirmations and optional SDK fields after checking the requested identity.
	return JsonValue.parse(result)
}
