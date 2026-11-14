import type { Settings } from '../types/interceptor-messages.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'
import type { TransactionGasPayment } from '../types/visualizer-types.js'
import { hasDelegateClearingPreference, withDelegateCleared } from '../utils/delegateClearingState.js'

// What a simulation previews, described by facts about the request. Callers only describe the preview; this module alone decides whether it may see the opt-in what-if state.
export type SimulationPreviewContext =
	// The simulated stack itself: the popup's view of it, its export, and the website reads and calls run on it.
	| { readonly kind: 'simulation-stack' }
	// A governance proposal's execution simulated on top of the stack, continuing a vote's preview.
	| { readonly kind: 'governance-execution-on-stack' }
	// The confirmation preview of a transaction a website asked to send; safeSigningRequest is whether it is a Gnosis Safe transaction the owners will sign.
	| { readonly kind: 'transaction-confirmation', readonly simulationMode: boolean, readonly safeSigningRequest: boolean }
	// The simulated state a website transaction's nonce, gas and balance are formed against, given who pays its gas.
	| { readonly kind: 'transaction-formation', readonly gasPayment: TransactionGasPayment }
	// A Gnosis Safe transaction (SafeTx) message the user is asked to sign.
	| { readonly kind: 'safe-transaction-signature' }

// 'what-if' previews the simulated stack, where nothing is signed; 'signing-or-execution' previews something that will be signed or executed on-chain.
type SimulationPreviewPurpose = 'what-if' | 'signing-or-execution'

// Fails closed: only the contexts listed here, where nothing previewed is signed or executed on-chain, get 'what-if'; anything else, including a context added later without a decision here, gets 'signing-or-execution'.
export function getSimulationPreviewPurpose(context: SimulationPreviewContext): SimulationPreviewPurpose {
	switch (context.kind) {
		case 'simulation-stack': return 'what-if'
		case 'governance-execution-on-stack': return 'what-if'
		// A Safe confirmation previews what the owners will sign, and a signing-mode confirmation what will be sent.
		case 'transaction-confirmation': return context.simulationMode && !context.safeSigningRequest ? 'what-if' : 'signing-or-execution'
		// An external executor executes the transaction on-chain; the sender and a simulated Safe executor run it on the simulated stack.
		case 'transaction-formation': return context.gasPayment === 'transaction-sender' || context.gasPayment === 'simulated-safe-executor' ? 'what-if' : 'signing-or-execution'
		default: return 'signing-or-execution'
	}
}

// The single boundary for the opt-in delegate-clearing state: it never reaches a signing-or-execution preview and applies only in simulation mode.
export function getSimulationOverridesForPreview(context: SimulationPreviewContext, settings: Settings): StateOverrides {
	if (getSimulationPreviewPurpose(context) === 'signing-or-execution' || !settings.simulationMode) return {}
	const address = hasDelegateClearingPreference(settings.delegateClearingPreferences, settings.activeSimulationAddress, settings.activeRpcNetwork.chainId)
		? settings.activeSimulationAddress : undefined
	return withDelegateCleared({}, address)
}
