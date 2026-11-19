import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { getSimulationModeSafeAccount } from '../safe/safeExecutionRouting.js'
import { reportLocalRecovery } from '../utils/errors.js'
import { getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'

// Whether the simulation runs the transactions an account sends through its Gnosis Safe on the client's chain. A single transaction checks it together with isSafeExecutableRequestFromActiveAddress; a wallet_sendCalls batch decides it once for its account when it is admitted and then runs each call the Safe can make through execTransaction through the Safe (getTransactionBatchCallGasPayment). The shared Safe layer decides (getSimulationModeSafeAccount); this neutral background module reads the chain's address book entries and records a configured Safe that falls back to the ordinary simulation, so neither confirmation flow depends on the other's modules and the Safe layer writes no diagnostics.
export async function isSimulationModeSafeAccount(ethereum: EthereumClientService, account: bigint) {
	const decision = await getSimulationModeSafeAccount(ethereum, await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereum.getChainId()), account)
	if (decision.kind === 'unsupportedSafe') {
		await reportLocalRecovery(decision.validationFailure, {
			code: 'simulated_safe_execution_unavailable',
			message: 'Simulating the Gnosis Safe\'s transaction as an ordinary transaction.',
			details: decision.validationFailure instanceof Error ? decision.validationFailure.stack : undefined,
		})
	}
	return decision.kind === 'safe'
}
