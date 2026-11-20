import type { BackgroundPendingTransactionOrSignableMessage, PendingTransactionOrSignableMessage, ShownPendingTransactionOrSignableMessage } from '../../../app/ts/types/accessRequest.js'

declare const consumeBackground: (pending: BackgroundPendingTransactionOrSignableMessage) => void

export function checkShownConfirmation(shown: ShownPendingTransactionOrSignableMessage, stored: PendingTransactionOrSignableMessage) {
	const unguardedId = shown.reviewedResultId // expect-type-error
	consumeBackground(shown) // expect-type-error
	consumeBackground({ ...stored, source: 'background' }) // expect-type-error
	if (shown.source === 'background') {
		consumeBackground(shown)
		return shown.reviewedResultId
	}
	return unguardedId
}
