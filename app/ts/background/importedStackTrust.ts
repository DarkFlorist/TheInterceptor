import type { VisualizedPersonalSignRequest } from '../types/personal-message-definitions.js'
import type { InterceptorStackOperation, SignedMessageTransaction } from '../types/visualizer-types.js'
import { assertNever, modifyObject } from '../utils/typescript.js'

// The trust policy for simulation stacks imported from an export file. This extension never saw how an imported operation was requested, so nothing the file claims about that is trusted. All of the policy lives here: what an imported operation keeps and loses (toImportedStackOperation), what the `importedFromExport` marker on a SignedMessageTransaction means and that export files never carry it (withoutImportMarker), and how an imported signature is flagged (flagImportedSignature).

export const IMPORTED_SIGNATURE_QUARANTINE_REASON = 'This signature was imported from a simulation stack export, so the Interceptor did not see which account was active when it was requested and cannot check that it is for your active address.'

// Applied by importSimulationStack to the operations of an export file only; operations already in the stack keep what this extension recorded for them.
export function toImportedStackOperation(operation: InterceptorStackOperation): InterceptorStackOperation {
	switch (operation.type) {
		// A message's active address and simulation signer cannot be re-derived from the message (for a Safe, an owner rather than the Safe signs), so they are kept for the simulation but the message is marked, and flagImportedSignature then flags it instead of trusting its account check. Its `safeMessageReview` stays, because a Safe message is only shown with its review when the review text hashes to the digest it signs.
		case 'Message': return modifyObject(operation, { signedMessageTransaction: modifyObject(operation.signedMessageTransaction, { importedFromExport: true }) })
		// Only Safe proposals, which cannot be imported this way, set `simulationOptions`. A claimed `requiredChainId` decides on which chain the transaction is simulated at all, and a claimed zero base fee lets a contract detect the simulation (`block.basefee == 0`) and behave differently in it, so both are dropped.
		case 'Transaction': {
			const { simulationOptions: _unobservedSimulationOptions, ...preSimulationTransaction } = operation.preSimulationTransaction
			return modifyObject(operation, { preSimulationTransaction })
		}
		case 'TimeManipulation': return operation
		default: return assertNever(operation)
	}
}

// The marker is this extension's own note about where a message in its stack came from, not part of the message, so export files leave it out; whoever imports the file marks every message again.
export function withoutImportMarker(signedMessageTransaction: SignedMessageTransaction): SignedMessageTransaction {
	const { importedFromExport: _importMarker, ...exportedSignedMessageTransaction } = signedMessageTransaction
	return exportedSignedMessageTransaction
}

// The account check of every message type compares against `activeAddress` / `fakeSignedFor`, which an imported message only claims, so an imported signature is always flagged rather than passing on the export file's word.
export function flagImportedSignature(signedMessageTransaction: SignedMessageTransaction, visualizedPersonalSignRequest: VisualizedPersonalSignRequest): VisualizedPersonalSignRequest {
	if (signedMessageTransaction.importedFromExport !== true) return visualizedPersonalSignRequest
	return { ...visualizedPersonalSignRequest, quarantine: true, quarantineReasons: [IMPORTED_SIGNATURE_QUARANTINE_REASON, ...visualizedPersonalSignRequest.quarantineReasons] }
}
