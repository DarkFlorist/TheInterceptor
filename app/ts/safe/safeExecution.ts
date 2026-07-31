import type { SafeContractState } from './safeCore.js'
import { assertInterceptorSafeTransactionPolicy, createSafeTxFromMessage, recoverSafeSignatureOwner, SAFE_TRANSACTION_CORE_FIELDS } from './safeCore.js'
import type { Hex } from '../utils/ethereumPrimitives.js'
import { bytesFromHex, bytesToHex, ensureHex } from '../utils/ethereumBytes.js'
import { decodeFunctionDataStrict, encodeFunctionCall } from '../utils/abiRuntime.js'
import { getSafeTxHash } from '../utils/eip712.js'

const SAFE_SIGNATURE_BYTES = 65

export const SAFE_EXECUTION_ABI = [{
	type: 'function',
	name: 'execTransaction',
	stateMutability: 'payable',
	inputs: [
		...SAFE_TRANSACTION_CORE_FIELDS,
		{ name: 'signatures', type: 'bytes' },
	],
	outputs: [{ name: 'success', type: 'bool' }],
}] as const

function prevalidatedSafeSignature(signer: bigint): Hex {
	return `0x${ signer.toString(16).padStart(64, '0') }${ '0'.repeat(64) }01`
}

function parseSafeExecutionArguments(args: readonly unknown[]) {
	const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures] = args
	if (
		typeof to !== 'string'
		|| typeof value !== 'bigint'
		|| typeof data !== 'string'
		|| typeof operation !== 'bigint'
		|| typeof safeTxGas !== 'bigint'
		|| typeof baseGas !== 'bigint'
		|| typeof gasPrice !== 'bigint'
		|| typeof gasToken !== 'string'
		|| typeof refundReceiver !== 'string'
		|| typeof signatures !== 'string'
	) throw new Error('The Gnosis Safe execution calldata is malformed.')
	return {
		to: ensureHex(to, 'Gnosis Safe execution destination'),
		value,
		data: ensureHex(data, 'Gnosis Safe execution data'),
		operation,
		safeTxGas,
		baseGas,
		gasPrice,
		gasToken: ensureHex(gasToken, 'Gnosis Safe execution gas token'),
		refundReceiver: ensureHex(refundReceiver, 'Gnosis Safe execution refund receiver'),
		signatures: ensureHex(signatures, 'Gnosis Safe execution signatures'),
	}
}

export async function completeSafeExecutionWithConfiguredSigner(
	chainId: bigint,
	safeAddress: bigint,
	configuredSigner: bigint,
	safeState: SafeContractState,
	input: Uint8Array,
) {
	const decoded = decodeFunctionDataStrict(SAFE_EXECUTION_ABI, bytesToHex(input))
	const execution = parseSafeExecutionArguments(decoded.args)
	const signatures = bytesFromHex(execution.signatures)
	if (signatures.length % SAFE_SIGNATURE_BYTES !== 0) {
		throw new Error('The incomplete Gnosis Safe execution contains a malformed signature payload.')
	}
	const signatureCount = BigInt(signatures.length / SAFE_SIGNATURE_BYTES)
	if (signatureCount >= safeState.threshold) return input
	if (signatureCount + 1n < safeState.threshold) {
		throw new Error(`This Gnosis Safe execution has ${ signatureCount.toString() } signature(s), and the configured signer cannot satisfy its ${ safeState.threshold.toString() }-signature threshold.`)
	}
	if (!safeState.owners.includes(configuredSigner)) {
		throw new Error('The configured Gnosis Safe signer is no longer an owner of this Gnosis Safe.')
	}
	const safeTx = createSafeTxFromMessage(chainId, safeAddress, {
			to: BigInt(execution.to),
			value: execution.value,
			data: bytesFromHex(execution.data),
			operation: execution.operation,
			safeTxGas: execution.safeTxGas,
			baseGas: execution.baseGas,
			gasPrice: execution.gasPrice,
			gasToken: BigInt(execution.gasToken),
			refundReceiver: BigInt(execution.refundReceiver),
			nonce: safeState.nonce,
	})
	assertInterceptorSafeTransactionPolicy(safeTx)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const existingSignatures = await Promise.all(Array.from(
		{ length: Number(signatureCount) },
		async (_, index) => {
			const signatureBytes = signatures.slice(index * SAFE_SIGNATURE_BYTES, (index + 1) * SAFE_SIGNATURE_BYTES)
			const recoveryByte = signatureBytes[SAFE_SIGNATURE_BYTES - 1]
			if (recoveryByte !== 27 && recoveryByte !== 28) return undefined
			const signature = bytesToHex(signatureBytes)
			return {
				signer: await recoverSafeSignatureOwner(safeTxHash, signature),
				signature,
			}
		},
	))
	const supportedSignatures = existingSignatures.filter((signature) => signature !== undefined)
	if (supportedSignatures.length !== existingSignatures.length) {
		throw new Error('The incomplete Gnosis Safe execution contains a signature format that Interceptor cannot validate and complete safely.')
	}
	if (new Set(supportedSignatures.map(({ signer }) => signer)).size !== supportedSignatures.length) {
		throw new Error('The Gnosis Safe execution contains duplicate owner signatures.')
	}
	if (supportedSignatures.some(({ signer }) => signer === configuredSigner)) {
		throw new Error('The configured Gnosis Safe signer already signed this execution, but the signature threshold is not satisfied.')
	}
	for (const { signer } of supportedSignatures) {
		if (!safeState.owners.includes(signer)) throw new Error('The Gnosis Safe execution contains a signature from an address that is not a current owner.')
	}
	const completedSignatures = [
		...supportedSignatures,
		{ signer: configuredSigner, signature: prevalidatedSafeSignature(configuredSigner) },
	]
		.sort((left, right) => left.signer < right.signer ? -1 : left.signer > right.signer ? 1 : 0)
		.map(({ signature }) => signature.slice(2))
		.join('')
	return bytesFromHex(encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
		execution.to,
		execution.value,
		execution.data,
		execution.operation,
		execution.safeTxGas,
		execution.baseGas,
		execution.gasPrice,
		execution.gasToken,
		execution.refundReceiver,
		`0x${ completedSignatures }`,
	]))
}
