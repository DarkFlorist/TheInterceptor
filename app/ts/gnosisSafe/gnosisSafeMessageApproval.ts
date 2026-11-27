import type { GnosisSafeMessageReview } from '../types/gnosisSafeReview.js'
import type { GnosisSafeTx } from '../types/personal-message-definitions.js'
import { decodeCallDataLoose, encodeFunctionCall } from '../utils/abiRuntime.js'
import { dataStringWith0xStart, stringToUint8Array } from '../utils/bigint.js'
import { isAbiDataDecodeError } from '../utils/ethereumPrimitives.js'
import { getGnosisSafeMessageDigest } from './gnosisSafeMessageData.js'

export const GNOSIS_SAFE_SIGN_MESSAGE_LIB = 0xd53cd0ab83d845ac265be939c57f53ad838012c9n
// Gnosis Safe v1.4.1 exposes signMessage(bytes), selector 0x85a5affe; a 32-byte digest still uses dynamic bytes encoding: https://github.com/safe-global/safe-smart-account/blob/v1.4.1/contracts/libraries/SignMessageLib.sol
export const GNOSIS_SAFE_SIGN_MESSAGE_ABI = [{ type: 'function', name: 'signMessage', stateMutability: 'nonpayable', inputs: [{ name: 'message', type: 'bytes' }], outputs: [] }] as const

type GnosisSafeMessageApproval = Pick<GnosisSafeTx['message'], 'to' | 'operation' | 'value' | 'data'>

const encodeDigest = (digest: string) => encodeFunctionCall(GNOSIS_SAFE_SIGN_MESSAGE_ABI, 'signMessage', [stringToUint8Array(digest)])

export function buildGnosisSafeMessageApproval(review: GnosisSafeMessageReview): GnosisSafeMessageApproval {
	return { to: GNOSIS_SAFE_SIGN_MESSAGE_LIB, operation: 1n, value: 0n, data: stringToUint8Array(encodeDigest(getGnosisSafeMessageDigest(review.text, review.isTypedData))) }
}

// A recognized approval has a canonical 32-byte digest argument and executes in the Gnosis Safe's storage context.
export function decodeGnosisSafeMessageApproval(transaction: GnosisSafeMessageApproval): string | undefined {
	if (transaction.to !== GNOSIS_SAFE_SIGN_MESSAGE_LIB || transaction.operation !== 1n || transaction.value !== 0n) return undefined
	const data = dataStringWith0xStart(transaction.data)
	try {
		const decoded = decodeCallDataLoose(GNOSIS_SAFE_SIGN_MESSAGE_ABI, data)
		const digest = decoded?.args[0]
		return decoded?.name === 'signMessage' && typeof digest === 'string' && /^0x[0-9a-f]{64}$/i.test(digest) && encodeDigest(digest) === data ? digest : undefined
	} catch (error) {
		if (!isAbiDataDecodeError(error)) throw error
		return undefined
	}
}

export function matchesGnosisSafeMessageApproval(transaction: GnosisSafeMessageApproval, review: GnosisSafeMessageReview): boolean {
	const digest = decodeGnosisSafeMessageApproval(transaction)
	return digest !== undefined && digest === getGnosisSafeMessageDigest(review.text, review.isTypedData)
}
