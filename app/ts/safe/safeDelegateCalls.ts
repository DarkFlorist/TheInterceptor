import { decodeSafeMessageApproval, SAFE_SIGN_MESSAGE_LIB } from './safeMessageApproval.js'
export { SAFE_SIGN_MESSAGE_LIB, SAFE_SIGN_MESSAGE_ABI } from './safeMessageApproval.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { SafeTx } from '../types/personal-message-definitions.js'
import { decodeCallDataLoose, encodeFunctionCall } from '../utils/abiRuntime.js'
import { addressString, dataStringWith0xStart, stringToUint8Array } from '../utils/bigint.js'
import { isAbiDataDecodeError, keccak256 } from '../utils/ethereumPrimitives.js'
import { createSafeValidationError } from './safeErrors.js'

// Canonical Safe deployments v1.4.1: safe-global/safe-deployments/src/assets/v1.4.1/{multi_send_call_only,sign_message_lib}.json.
export const SAFE_MULTI_SEND_CALL_ONLY = 0x9641d764fc13c8b624c04430c7356c1c7c8102e2n
const libraryCodeHashes = new Map([
	[SAFE_MULTI_SEND_CALL_ONLY, '0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939'],
	[SAFE_SIGN_MESSAGE_LIB, '0x525c754a46b79e05543a59bb61e8de3c9eee0d955a59352409cbe67ea1077528'],
])
export const SAFE_MULTI_SEND_ABI = [{ type: 'function', name: 'multiSend', stateMutability: 'payable', inputs: [{ name: 'transactions', type: 'bytes' }], outputs: [] }] as const
const invalid = (message: string) => createSafeValidationError(message, 'safe_contract_validation')
export type SafeBatchCall = { readonly to: bigint, readonly value: bigint, readonly data: Uint8Array }
const MAX_BATCH_CALLS = 100
const MAX_BATCH_BYTES = 100_000

export function encodeSafeBatch(calls: readonly SafeBatchCall[]) {
	if (calls.length < 2 || calls.length > MAX_BATCH_CALLS) throw invalid('A Safe batch must contain between 2 and 100 CALL transactions.')
	const packed = calls.map((call) => {
		if (call.to <= 0n || call.to >= 2n ** 160n || call.value < 0n || call.value >= 2n ** 256n) throw invalid('Invalid Safe batch destination or value.')
		return `00${ addressString(call.to).slice(2) }${ call.value.toString(16).padStart(64, '0') }${ call.data.length.toString(16).padStart(64, '0') }${ dataStringWith0xStart(call.data).slice(2) }`
	}).join('')
	if (packed.length / 2 > MAX_BATCH_BYTES) throw invalid('The Safe batch exceeds 100000 encoded bytes.')
	return stringToUint8Array(encodeFunctionCall(SAFE_MULTI_SEND_ABI, 'multiSend', [`0x${ packed }`]))
}

export function decodeSafeBatch(data: Uint8Array): readonly SafeBatchCall[] {
	const decoded = decodeSafeLibraryCall(SAFE_MULTI_SEND_ABI, data)
	const packed = decoded?.args[0]
	if (decoded?.name !== 'multiSend' || typeof packed !== 'string') throw invalid('Invalid Safe MultiSend calldata.')
	const bytes = stringToUint8Array(packed)
	if (bytes.length > MAX_BATCH_BYTES) throw invalid('The Safe batch exceeds 100000 encoded bytes.')
	const calls: SafeBatchCall[] = []
	let offset = 0
	while (offset < bytes.length) {
		if (bytes.length - offset < 85 || bytes[offset] !== 0) throw invalid('Safe batches support complete CALL entries only; nested delegate calls are forbidden.')
		const to = BigInt(dataStringWith0xStart(bytes.slice(offset + 1, offset + 21)))
		const value = BigInt(dataStringWith0xStart(bytes.slice(offset + 21, offset + 53)))
		const length = BigInt(dataStringWith0xStart(bytes.slice(offset + 53, offset + 85)))
		if (length > BigInt(bytes.length - offset - 85)) throw invalid('Truncated Safe batch calldata.')
		calls.push({ to, value, data: bytes.slice(offset + 85, offset + 85 + Number(length)) })
		offset += 85 + Number(length)
		if (calls.length > MAX_BATCH_CALLS) throw invalid('A Safe batch exceeds 100 CALL transactions.')
	}
	const canonical = encodeSafeBatch(calls)
	if (dataStringWith0xStart(canonical) !== dataStringWith0xStart(data)) throw invalid('Safe batch calldata must use canonical ABI encoding.')
	return calls
}

export function assertSafeDelegateCall(safeTx: SafeTx) {
	if (safeTx.message.operation !== 1n || safeTx.message.value !== 0n) throw invalid('Safe delegate proposals require DELEGATECALL with zero outer value.')
	if (safeTx.message.to === SAFE_MULTI_SEND_CALL_ONLY) {
		decodeSafeBatch(safeTx.message.data)
		return
	}
	if (decodeSafeMessageApproval(safeTx.message) !== undefined) return
	throw invalid('DELEGATECALL is supported only for verified Safe MultiSendCallOnly and SignMessageLib proposals.')
}

export async function validateSafeDelegateCode(ethereum: EthereumClientService, safeTx: SafeTx, blockNumber: bigint) {
	if (safeTx.message.operation === 0n) return
	assertSafeDelegateCall(safeTx)
	const code = await ethereum.getCode(safeTx.message.to, blockNumber, undefined)
	if (keccak256(code) !== libraryCodeHashes.get(safeTx.message.to)) throw invalid('The required Safe library is missing or has unexpected bytecode on this chain.')
}

function decodeSafeLibraryCall(abi: typeof SAFE_MULTI_SEND_ABI, data: Uint8Array) {
	try { return decodeCallDataLoose(abi, dataStringWith0xStart(data)) } catch (error) {
		if (!isAbiDataDecodeError(error)) throw error
		throw invalid('Safe library calldata must use complete canonical ABI encoding.')
	}
}
