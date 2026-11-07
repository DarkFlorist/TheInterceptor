import type { VisualizedPersonalSignRequest } from '../types/personal-message-definitions.js'
import type { SignedMessageTransaction } from '../types/visualizer-types.js'

// How a signature imported from an export file is shown. Which operations are imported, and the `importedFromExport` marker set on every imported message, are decided by admitImportedSimulationStackOperations (importedSimulationStack.ts); this module only reads that marker. The export file schema has no such marker (see SignedMessageTransaction.importedFromExport).

export const IMPORTED_SIGNATURE_QUARANTINE_REASON = 'This signature was imported from a simulation stack export, so the Interceptor did not see which account was active when it was requested and cannot check that it is for your active address.'

// The account check of every message type compares against `activeAddress` / `fakeSignedFor`, which an imported message only claims, so an imported signature is always flagged rather than passing on the export file's word.
export function flagImportedSignature(signedMessageTransaction: SignedMessageTransaction, visualizedPersonalSignRequest: VisualizedPersonalSignRequest): VisualizedPersonalSignRequest {
	if (signedMessageTransaction.importedFromExport !== true) return visualizedPersonalSignRequest
	return { ...visualizedPersonalSignRequest, quarantine: true, quarantineReasons: [IMPORTED_SIGNATURE_QUARANTINE_REASON, ...visualizedPersonalSignRequest.quarantineReasons] }
}
