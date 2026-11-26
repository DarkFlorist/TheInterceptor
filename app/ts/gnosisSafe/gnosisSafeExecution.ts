import type { GnosisSafeContractState } from './gnosisSafeCore.js'
import { assertInterceptorGnosisSafeTransactionPolicy, createGnosisSafeContractValidationFailure, createGnosisSafeTxFromMessage, recoverGnosisSafeSignatureOwner, GNOSIS_SAFE_TRANSACTION_CORE_FIELDS } from './gnosisSafeCore.js'
import type { Hex } from '../utils/ethereumPrimitives.js'
import { bytesFromHex, bytesToHex, ensureHex } from '../utils/ethereumBytes.js'
import { decodeFunctionDataStrict, encodeFunctionCall } from '../utils/abiRuntime.js'
import { getGnosisSafeTxHash } from '../utils/eip712.js'

const GNOSIS_SAFE_SIGNATURE_BYTES = 65

export const GNOSIS_SAFE_EXECUTION_ABI = [{
	type: 'function',
	name: 'execTransaction',
	stateMutability: 'payable',
	inputs: [
		...GNOSIS_SAFE_TRANSACTION_CORE_FIELDS,
		{ name: 'signatures', type: 'bytes' },
	],
	outputs: [{ name: 'success', type: 'bool' }],
}] as const

export function prevalidatedGnosisSafeSignature(signer: bigint): Hex {
	return `0x${ signer.toString(16).padStart(64, '0') }${ '0'.repeat(64) }01`
}

function parseGnosisSafeExecutionArguments(args: readonly unknown[]) {
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
	) throw createGnosisSafeContractValidationFailure('The Gnosis Safe execution calldata is malformed.')
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

export function decodeGnosisSafeExecution(chainId: bigint, safeAddress: bigint, nonce: bigint, input: Uint8Array) {
	const decoded = decodeFunctionDataStrict(GNOSIS_SAFE_EXECUTION_ABI, bytesToHex(input))
	const execution = parseGnosisSafeExecutionArguments(decoded.args)
	const safeTx = createGnosisSafeTxFromMessage(chainId, safeAddress, {
		to: BigInt(execution.to),
		value: execution.value,
		data: bytesFromHex(execution.data),
		operation: execution.operation,
		safeTxGas: execution.safeTxGas,
		baseGas: execution.baseGas,
		gasPrice: execution.gasPrice,
		gasToken: BigInt(execution.gasToken),
		refundReceiver: BigInt(execution.refundReceiver),
		nonce,
	})
	return { execution, safeTx }
}

export async function completeGnosisSafeExecutionWithConfiguredSigner(
	chainId: bigint,
	safeAddress: bigint,
	configuredSigner: bigint,
	safeState: GnosisSafeContractState,
	input: Uint8Array,
) {
	const { execution, safeTx } = decodeGnosisSafeExecution(chainId, safeAddress, safeState.nonce, input)
	const signatures = bytesFromHex(execution.signatures)
	if (signatures.length % GNOSIS_SAFE_SIGNATURE_BYTES !== 0) {
		throw createGnosisSafeContractValidationFailure('The incomplete Gnosis Safe execution contains a malformed signature payload.')
	}
	const signatureCount = BigInt(signatures.length / GNOSIS_SAFE_SIGNATURE_BYTES)
	if (signatureCount >= safeState.threshold) return input
	if (signatureCount + 1n < safeState.threshold) {
		throw createGnosisSafeContractValidationFailure(`This Gnosis Safe execution has ${ signatureCount.toString() } signature(s), and the wallet-selected Gnosis Safe owner cannot satisfy its ${ safeState.threshold.toString() }-signature threshold.`)
	}
	if (!safeState.owners.includes(configuredSigner)) {
		throw createGnosisSafeContractValidationFailure('The account selected in your wallet is no longer an owner of this Gnosis Safe.')
	}
	assertInterceptorGnosisSafeTransactionPolicy(safeTx)
	const safeTxHash = BigInt(getGnosisSafeTxHash(safeTx))
	const existingSignatures = await Promise.all(Array.from(
		{ length: Number(signatureCount) },
		async (_, index) => {
			const signatureBytes = signatures.slice(index * GNOSIS_SAFE_SIGNATURE_BYTES, (index + 1) * GNOSIS_SAFE_SIGNATURE_BYTES)
			const recoveryByte = signatureBytes[GNOSIS_SAFE_SIGNATURE_BYTES - 1]
			if (recoveryByte !== 27 && recoveryByte !== 28) return undefined
			const signature = bytesToHex(signatureBytes)
			return {
				signer: await recoverGnosisSafeSignatureOwner(safeTxHash, signature),
				signature,
			}
		},
	))
	const supportedSignatures = existingSignatures.filter((signature) => signature !== undefined)
	if (supportedSignatures.length !== existingSignatures.length) {
		throw createGnosisSafeContractValidationFailure('The incomplete Gnosis Safe execution contains a signature format that Interceptor cannot validate and complete safely.')
	}
	if (new Set(supportedSignatures.map(({ signer }) => signer)).size !== supportedSignatures.length) {
		throw createGnosisSafeContractValidationFailure('The Gnosis Safe execution contains duplicate owner signatures.')
	}
	if (supportedSignatures.some(({ signer }) => signer === configuredSigner)) {
		throw createGnosisSafeContractValidationFailure('The wallet-selected Gnosis Safe owner already signed this execution, but the signature threshold is not satisfied.')
	}
	for (const { signer } of supportedSignatures) {
		if (!safeState.owners.includes(signer)) throw createGnosisSafeContractValidationFailure('The Gnosis Safe execution contains a signature from an address that is not a current owner.')
	}
	const completedSignatures = [
		...supportedSignatures,
		{ signer: configuredSigner, signature: prevalidatedGnosisSafeSignature(configuredSigner) },
	]
		.sort((left, right) => left.signer < right.signer ? -1 : left.signer > right.signer ? 1 : 0)
		.map(({ signature }) => signature.slice(2))
		.join('')
	return bytesFromHex(encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [
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
