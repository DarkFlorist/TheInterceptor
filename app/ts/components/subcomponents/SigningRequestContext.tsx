import type { PopupPendingTransactionOrSignableMessage } from '../../types/accessRequest.js'
import { signingWalletDescription } from '../../signing/backend.js'
import { addressString } from '../../utils/bigint.js'
import { CHAIN_NAMES } from '../../utils/chainNames.js'

/** Keep request identity visible even when a message card collapses its advanced details. */
export function SigningRequestContext({ pending }: { pending: PopupPendingTransactionOrSignableMessage }) {
	const chainId = pending.signingChainId ?? (pending.transactionOrMessageCreationStatus !== 'Simulated' ? undefined : pending.type === 'SignableMessage' ? pending.visualizedPersonalSignRequest.rpcNetwork.chainId : pending.popupVisualisation.statusCode === 'success' ? pending.popupVisualisation.data.simulationState.rpcNetwork.chainId : undefined)
	const wallet = pending.signingWalletBinding
	return <section class = 'card' style = 'color: var(--text-color); padding: 12px; margin-bottom: 12px; font-size: 13px; overflow-wrap: anywhere;'>
		<strong style = 'color: inherit;'>{ pending.simulationMode ? 'Simulation mode · No real signature or broadcast' : 'Signing mode · Real signature' }</strong>
		<p>Website: { pending.website.websiteOrigin }</p>
		<p>Acting address: { addressString(pending.activeAddress) }</p>
		{ chainId === undefined ? undefined : <p>Network: { CHAIN_NAMES.get(chainId.toString()) ?? 'Custom network' } · Chain { chainId.toString() }</p> }
		{ wallet === undefined ? undefined : <><p>Signing wallet: { signingWalletDescription(wallet) }</p>{ wallet.wallet.address === pending.activeAddress ? undefined : <p>Signing account: { addressString(wallet.wallet.address) }</p> }</> }
		{ pending.type !== 'Transaction' || pending.safeExecutionSignerAddress === undefined ? undefined : <p>Execution account: { addressString(pending.safeExecutionSignerAddress) }</p> }
	</section>
}
