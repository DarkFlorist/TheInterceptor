import type { PendingTransactionOrSignableMessage, ResolutionInput } from '../types/accessRequest.js'
import { type UniqueRequestIdentifier, getUniqueRequestIdentifierString } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { updateOwnedPendingRequestField } from './storageVariables.js'

export type PendingResolutionIdentity =
	| { readonly type: 'Transaction', readonly identifier: bigint }
	| { readonly type: 'SignableMessage', readonly identifier: bigint }
export const getPendingResolutionIdentity = (request: PendingTransactionOrSignableMessage): PendingResolutionIdentity => ({ type: request.type, identifier: request.type === 'Transaction' ? request.transactionIdentifier : request.signedMessageTransaction.messageIdentifier })
type RecordedInput = { readonly input: ResolutionInput, readonly expectedIdentity?: PendingResolutionIdentity }

// Arrival order belongs to the input-log owner; claims only ask it to persist the prefix visible when an action arrived.
const recordedInputs = new Map<string, { readonly unwritten: readonly RecordedInput[], readonly writtenCount: number }>()
export const resetResolutionInputs = () => recordedInputs.clear()
export const getResolutionInputBookkeepingSize = () => recordedInputs.size

export const recordResolutionInput = (claim: string, input: ResolutionInput, expectedIdentity?: PendingResolutionIdentity) => {
	const recorded = recordedInputs.get(claim) ?? { unwritten: [], writtenCount: 0 }
	recordedInputs.set(claim, { ...recorded, unwritten: [...recorded.unwritten, { input, expectedIdentity }] })
}
export const forgetRecordedResolutionInputs = (claim: string) => recordedInputs.delete(claim)
// Logs an input on the stored request, unless it is already there unprocessed: a signer's same answer again, or a second decline (the first decline decides).
function withInputLogged(request: PendingTransactionOrSignableMessage, input: ResolutionInput): PendingTransactionOrSignableMessage {
	const logged = request.resolutionInputs ?? []
	if (input.kind === 'signerResult' && logged.some((entry) => entry.kind === 'signerResult' && entry.signerReply === input.signerReply)) return request
	if (input.kind === 'decline' && logged.some((entry) => entry.kind === 'decline')) return request
	return { ...request, resolutionInputs: [...logged, input] }
}
// Writes the request's recorded inputs, in order, up to the first targetCount recorded, each with one atomic update of the stored request.
async function writeRecordedInputs(uniqueRequestIdentifier: UniqueRequestIdentifier, targetCount: number) {
	const claim = getUniqueRequestIdentifierString(uniqueRequestIdentifier)
	for (;;) {
		const recorded = recordedInputs.get(claim)
		const [next] = recorded?.unwritten ?? []
		if (recorded === undefined || next === undefined || recorded.writtenCount >= targetCount) return
		await updateOwnedPendingRequestField(uniqueRequestIdentifier, 'resolutionInputs', async (request) => {
			// Lifecycle snapshots may outlive the old request. Reusing its page id never transfers its decline to the replacement.
			const identity = getPendingResolutionIdentity(request)
			if (next.expectedIdentity !== undefined && (identity.type !== next.expectedIdentity.type || identity.identifier !== next.expectedIdentity.identifier)) return request
			return withInputLogged(request, next.input)
		})
		const afterWrite = recordedInputs.get(claim)
		if (afterWrite === undefined) return
		recordedInputs.set(claim, { unwritten: afterWrite.unwritten.slice(1), writtenCount: afterWrite.writtenCount + 1 })
	}
}
// Serializes the writes of recorded inputs with reading a stored log for an action's arrival (withResolutionClaim). Its place in the lock order is defined in confirmationWindowLifecycle.ts.
const inputLogSemaphore = new Semaphore(1)
// Writes the inputs recorded so far, then runs then, in one turn of the input-log lock whose place is taken synchronously: inputs recorded after this call are written after then ran.
export function writeInputsRecordedSoFar<Result>(uniqueRequestIdentifier: UniqueRequestIdentifier, then: () => Promise<Result>) {
	const recorded = recordedInputs.get(getUniqueRequestIdentifierString(uniqueRequestIdentifier))
	const targetCount = recorded === undefined ? 0 : recorded.writtenCount + recorded.unwritten.length
	return inputLogSemaphore.execute(async () => {
		await writeRecordedInputs(uniqueRequestIdentifier, targetCount)
		return await then()
	})
}
