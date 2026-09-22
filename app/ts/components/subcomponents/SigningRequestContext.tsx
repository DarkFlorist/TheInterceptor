import { SigningCopyValue } from './SigningCopyValue.js'
import type { PopupPendingTransactionOrSignableMessage } from '../../types/accessRequest.js'
import { signingWalletDescription } from '../../signing/backend.js'
import { addressString } from '../../utils/bigint.js'
import { CHAIN_NAMES } from '../../utils/chainNames.js'

/** Keep request identity visible even when a message card collapses its advanced details. */
export function SigningRequestContext({ pending }: { pending: PopupPendingTransactionOrSignableMessage }) {
	const chainId = pending.signingChainId ?? (pending.transactionOrMessageCreationStatus !== 'Simulated' ? undefined : pending.type === 'SignableMessage' ? pending.visualizedPersonalSignRequest.rpcNetwork.chainId : pending.popupVisualisation.statusCode === 'success' ? pending.popupVisualisation.data.simulationState.rpcNetwork.chainId : undefined)
	const wallet = pending.signingWalletBinding
	return <section class = 'signing-request-context'>
		<strong>{ pending.simulationMode ? 'Simulation mode · No real signature or broadcast' : 'Signing mode · Real signature' }</strong>
		<dl class = 'signing-grid'>
			<div><dt>Originating website</dt><dd>{ pending.website.websiteOrigin }</dd></div>
			<div><dt>Acting address</dt><dd><SigningCopyValue value = { addressString(pending.activeAddress) } label = 'acting address'/></dd></div>
			{ chainId === undefined ? undefined : <div><dt>Network</dt><dd>{ CHAIN_NAMES.get(chainId.toString()) ?? 'Custom network' } · Chain { chainId.toString() }</dd></div> }
			{ wallet === undefined ? undefined : <><div><dt>Signing wallet</dt><dd>{ signingWalletDescription(wallet) }</dd></div>{ wallet.wallet.address === pending.activeAddress ? undefined : <div><dt>Signing account</dt><dd><SigningCopyValue value = { addressString(wallet.wallet.address) } label = 'signing account'/></dd></div> }</> }
			{ pending.type !== 'Transaction' || pending.safeExecutionSignerAddress === undefined ? undefined : <div><dt>Execution account</dt><dd><SigningCopyValue value = { addressString(pending.safeExecutionSignerAddress) } label = 'execution account'/></dd></div> }
		</dl>
	</section>
}
