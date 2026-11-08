// Which confirmation run is current. These rules only read the runs they are given, so this module depends on no simulation or storage code and the modules that store a visualisation can share it.
import type { ConfirmationRunId, PendingTransaction } from '../types/accessRequest.js'
import { stringifyJSONWithBigInts } from '../utils/bigint.js'

export type ConfirmationRunVisualisation = { readonly data: { readonly confirmationRunId: ConfirmationRunId } }

// The one rule for whether a confirmation visualisation may be stored over the stored one. A new run, stored with the transaction it prepared, replaces the stored visualisation unless that came from a later run of the same background lifetime; a visualisation stored by another lifetime, before a restart or without a run id, never blocks a new run. A re-visualisation of a stored run's results, stored without a transaction, needs that very run to still be stored, so the visualisation stays paired with the transaction the run prepared. It answers which confirmation run is current, unlike the fingerprints in popupSimulationFingerprint.ts, which tell whether the inputs of the popup's own simulation changed.
export function isConfirmationVisualisationCurrent(stored: ConfirmationRunVisualisation | undefined, candidate: ConfirmationRunVisualisation, candidateKind: 'new run' | 're-visualised run') {
	if (stored === undefined) return candidateKind === 'new run'
	const storedRun = stored.data.confirmationRunId
	const candidateRun = candidate.data.confirmationRunId
	const sameLifetime = candidateRun.lifetime === storedRun.lifetime
	if (candidateKind === 're-visualised run') return sameLifetime && candidateRun.sequence === storedRun.sequence
	return !sameLifetime || candidateRun.sequence >= storedRun.sequence
}

// What a new run prepares the transaction from. A run whose inputs changed while it ran, for example through a gas limit edit or a Gnosis Safe signer change, describes a transaction that is no longer stored, so it is not current whatever its run id.
export const getConfirmationRunInputs = (pendingTransaction: PendingTransaction) => stringifyJSONWithBigInts([pendingTransaction.originalRequestParameters, pendingTransaction.activeAddress, pendingTransaction.safeTransaction])
