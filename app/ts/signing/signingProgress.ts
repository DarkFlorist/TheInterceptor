import type { DirectSigningRecord } from '../types/directSigning.js'

export type SigningProgress = Readonly<{ current: number, status: 'active' | 'complete' | 'cancelled' }>

/** Terminal states are explicit rather than sentinel indices outside the rendered steps. A refused signature keeps its last step active because the website has not received it. */
export function directSigningProgress(phase: DirectSigningRecord['phase'], isTransaction: boolean, signatureRefused = false): SigningProgress {
	switch (phase) {
		case 'review': return { current: 0, status: 'active' }
		case 'approved': return { current: 1, status: 'active' }
		case 'signed': return { current: 2, status: isTransaction || signatureRefused ? 'active' : 'complete' }
		case 'submitting': return { current: 2, status: 'active' }
		case 'submitted':
		case 'confirmed': return { current: 2, status: signatureRefused ? 'active' : 'complete' }
		case 'cancelled': return { current: 0, status: 'cancelled' }
	}
}

/** The phases in which Interceptor resolves the website request with the device's signature: a signed message, or a broadcast transaction's hash. */
export function isSignatureReadyForApplication(record: Pick<DirectSigningRecord, 'phase' | 'input'>) {
	return record.input.method === 'eth_sendTransaction'
		? record.phase === 'submitted' || record.phase === 'confirmed'
		: record.phase === 'signed'
}

export type DirectSigningCompletion = Readonly<{
	/** The request needs nothing more from the user, so the page offers to return to the application. */
	complete: boolean
	title: string | undefined
	refusal: Readonly<{ heading: string, reason: string, recovery: string, canCancel: boolean }> | undefined
}>

/** What the signing page shows once the device has produced a signature, given the reason Interceptor refused to return it to the website, if any. */
export function getDirectSigningCompletion(record: Pick<DirectSigningRecord, 'phase' | 'input' | 'executionSucceeded'>, signatureRefusalReason: string | undefined): DirectSigningCompletion {
	const isTransaction = record.input.method === 'eth_sendTransaction'
	if (signatureRefusalReason !== undefined && isSignatureReadyForApplication(record)) {
		return {
			complete: false,
			title: 'Signature not returned to application',
			refusal: isTransaction
				? { heading: 'Transaction broadcast · Hash not returned to application', reason: signatureRefusalReason, recovery: 'The transaction was already broadcast, so keep its hash. Reject the request in the Interceptor confirmation window, then check the transaction in the application.', canCancel: false }
				: { heading: 'Signature verified · Not returned to application', reason: signatureRefusalReason, recovery: 'Cancel this request to reject it in the application, then create a new request from the application.', canCancel: true },
		}
	}
	const title = record.phase === 'cancelled' ? 'Request cancelled'
		: record.phase === 'confirmed' ? record.executionSucceeded ? 'Transaction confirmed' : 'Transaction reverted'
		: record.phase === 'submitted' ? 'Transaction submitted'
		: record.phase === 'submitting' ? 'Checking transaction submission'
		: record.phase === 'signed' ? isTransaction ? 'Ready to broadcast' : 'Message signature verified'
		: undefined
	return { complete: record.phase === 'confirmed' || record.phase === 'signed' && !isTransaction, title, refusal: undefined }
}
