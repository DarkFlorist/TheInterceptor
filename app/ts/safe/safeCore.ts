import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { SafeTx } from '../types/personal-message-definitions.js'
import type { SafeOwnerSignature, SafeTransactionSigningRequest, SafeTransactionStack } from '../types/safeTypes.js'
import type { EthereumAddress, EthereumBlockTag } from '../types/wire-types.js'
import type { Abi, Hex } from '../utils/ethereumPrimitives.js'
import { decodeFunctionOutput, encodeFunctionCall } from '../utils/abiRuntime.js'
import { addressString, bytes32String, dataStringWith0xStart, stringToUint8Array } from '../utils/bigint.js'
import { ensureHex } from '../utils/ethereumBytes.js'
import { recoverAddress } from '../utils/ethereumPrimitives.js'
import { getSafeTxHash } from '../utils/eip712.js'
import { createTaggedError, isTaggedError } from '../utils/caughtErrors.js'

const SUPPORTED_SAFE_VERSIONS = ['1.3.0', '1.4.0', '1.4.1'] as const

export const SAFE_TRANSACTION_CORE_FIELDS = [
	{ name: 'to', type: 'address' },
	{ name: 'value', type: 'uint256' },
	{ name: 'data', type: 'bytes' },
	{ name: 'operation', type: 'uint8' },
	{ name: 'safeTxGas', type: 'uint256' },
	{ name: 'baseGas', type: 'uint256' },
	{ name: 'gasPrice', type: 'uint256' },
	{ name: 'gasToken', type: 'address' },
	{ name: 'refundReceiver', type: 'address' },
] as const

const SAFE_TX_TYPES = {
	SafeTx: [
		...SAFE_TRANSACTION_CORE_FIELDS,
		{ name: 'nonce', type: 'uint256' },
	],
	EIP712Domain: [
		{ name: 'chainId', type: 'uint256' },
		{ name: 'verifyingContract', type: 'address' },
	],
} as const

export const SAFE_ABI = [
	{
		type: 'function',
		name: 'VERSION',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'string' }],
	},
	{
		type: 'function',
		name: 'nonce',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'getOwners',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'address[]' }],
	},
	{
		type: 'function',
		name: 'getThreshold',
		stateMutability: 'view',
		inputs: [],
		outputs: [{ name: '', type: 'uint256' }],
	},
	{
		type: 'function',
		name: 'getTransactionHash',
		stateMutability: 'view',
		inputs: [
			...SAFE_TRANSACTION_CORE_FIELDS,
			{ name: '_nonce', type: 'uint256' },
		],
		outputs: [{ name: '', type: 'bytes32' }],
	},
] as const satisfies Abi

const callSafe = async (
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	input: Hex,
	blockTag: EthereumBlockTag,
) => await ethereum.call({
		to: safeAddress,
		input: stringToUint8Array(input),
	}, blockTag, undefined)

export type SafeContractState = {
	readonly version: string
	readonly nonce: bigint
	readonly owners: readonly bigint[]
	readonly threshold: bigint
}

export type SafeContractSnapshot = {
	readonly blockNumber: bigint
	readonly state: SafeContractState
}

export type SafeOwnerValidator = {
	readonly assertEoaOwner: (owner: EthereumAddress) => Promise<void>
	readonly validateSignature: (
		safeTxHash: bigint,
		signature: string,
		expectedSafeSigner?: EthereumAddress,
	) => Promise<SafeOwnerSignature>
}

function createSafeOwnerValidationFailure(message: string) {
	return createTaggedError(message, 'safeOwnerValidationFailure')
}

export function isSafeOwnerValidationFailure(error: unknown) {
	return isTaggedError(error, 'safeOwnerValidationFailure')
}

function canonicalSafeOwners(owners: readonly bigint[]) {
	return [...owners].sort((first, second) => first < second ? -1 : first > second ? 1 : 0)
}

export function assertSafeContractStateUnchanged(reviewedState: SafeContractState, currentState: SafeContractState) {
	if (reviewedState.version !== currentState.version) {
		throw new Error(`The Gnosis Safe version changed from ${ reviewedState.version } to ${ currentState.version } after this confirmation opened.`)
	}
	if (reviewedState.nonce !== currentState.nonce) {
		throw new Error(`The Gnosis Safe nonce changed from ${ reviewedState.nonce.toString() } to ${ currentState.nonce.toString() } after this confirmation opened.`)
	}
	if (reviewedState.threshold !== currentState.threshold) {
		throw new Error(`The Gnosis Safe threshold changed from ${ reviewedState.threshold.toString() } to ${ currentState.threshold.toString() } after this confirmation opened.`)
	}
	const reviewedOwners = canonicalSafeOwners(reviewedState.owners)
	const currentOwners = canonicalSafeOwners(currentState.owners)
	if (reviewedOwners.length !== currentOwners.length || reviewedOwners.some((owner, index) => owner !== currentOwners[index])) {
		throw new Error('The Gnosis Safe owner set changed after this confirmation opened.')
	}
}

async function getSafeContractStateAtBlock(ethereum: EthereumClientService, safeAddress: EthereumAddress, blockNumber: bigint): Promise<SafeContractState> {
	const code = await ethereum.getCode(safeAddress, blockNumber, undefined)
	if (code.length === 0) throw new Error('The Gnosis Safe address does not contain a deployed contract on the selected chain.')
	const [versionResult, nonceResult, ownersResult, thresholdResult] = await Promise.all([
		callSafe(ethereum, safeAddress, encodeFunctionCall(SAFE_ABI, 'VERSION', []), blockNumber),
		callSafe(ethereum, safeAddress, encodeFunctionCall(SAFE_ABI, 'nonce', []), blockNumber),
		callSafe(ethereum, safeAddress, encodeFunctionCall(SAFE_ABI, 'getOwners', []), blockNumber),
		callSafe(ethereum, safeAddress, encodeFunctionCall(SAFE_ABI, 'getThreshold', []), blockNumber),
	])
	const version = decodeFunctionOutput(SAFE_ABI, 'VERSION', versionResult)
	const nonce = decodeFunctionOutput(SAFE_ABI, 'nonce', nonceResult)
	const owners = decodeFunctionOutput(SAFE_ABI, 'getOwners', ownersResult)
	const threshold = decodeFunctionOutput(SAFE_ABI, 'getThreshold', thresholdResult)
	if (!SUPPORTED_SAFE_VERSIONS.some((supportedVersion) => supportedVersion === version)) {
		throw new Error(`Gnosis Safe version ${ version } is not supported. Supported versions: ${ SUPPORTED_SAFE_VERSIONS.join(', ') }.`)
	}
	return { version, nonce, owners: owners.map((owner) => BigInt(owner)), threshold }
}

export async function getSafeContractState(ethereum: EthereumClientService, safeAddress: EthereumAddress): Promise<SafeContractState> {
	return (await getSafeContractSnapshot(ethereum, safeAddress)).state
}

export async function getSafeContractSnapshot(ethereum: EthereumClientService, safeAddress: EthereumAddress): Promise<SafeContractSnapshot> {
	const blockNumber = await ethereum.getBlockNumber(undefined)
	return { blockNumber, state: await getSafeContractStateAtBlock(ethereum, safeAddress, blockNumber) }
}

export function createSafeOwnerValidator(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	snapshot: SafeContractSnapshot,
): SafeOwnerValidator {
	const safeOwners = new Set(snapshot.state.owners)
	const eoaValidationByOwner = new Map<EthereumAddress, Promise<void>>()
	const assertEoaOwner = async (owner: EthereumAddress) => {
		if (!safeOwners.has(owner)) {
			throw createSafeOwnerValidationFailure(`${ addressString(owner) } is not an owner of Gnosis Safe ${ addressString(safeAddress) }.`)
		}
		let validation = eoaValidationByOwner.get(owner)
		if (validation === undefined) {
			validation = (async () => {
				const ownerCode = await ethereum.getCode(owner, snapshot.blockNumber, undefined)
				if (ownerCode.length > 0) {
					throw createSafeOwnerValidationFailure(`${ addressString(owner) } is a contract owner. This Gnosis Safe workflow currently supports EOA owners only.`)
				}
			})()
			eoaValidationByOwner.set(owner, validation)
		}
		await validation
	}
	const validateSignature = async (
		safeTxHash: bigint,
		signature: string,
		expectedSafeSigner?: EthereumAddress,
	): Promise<SafeOwnerSignature> => {
		const normalizedSignature = normalizeSafeSignature(signature)
		const signer = await recoverNormalizedSafeSignatureOwner(safeTxHash, normalizedSignature)
		if (expectedSafeSigner !== undefined && signer !== expectedSafeSigner) {
			throw new Error(`The wallet signature was created by ${ addressString(signer) }, not the expected wallet-selected Gnosis Safe owner ${ addressString(expectedSafeSigner) }.`)
		}
		await assertEoaOwner(signer)
		return { signer, signature: normalizedSignature }
	}
	return { assertEoaOwner, validateSignature }
}

export function assertUniqueSafeTransactionStacks(stacks: readonly SafeTransactionStack[]) {
	const stackKeys = stacks.map((stack) => `${ stack.chainId.toString() }:${ addressString(stack.safeAddress) }`)
	if (new Set(stackKeys).size !== stackKeys.length) throw new Error('The Gnosis Safe stack export contains duplicate entries for the same Gnosis Safe and chain.')
}

export function assertInterceptorSafeTransactionPolicy(safeTx: SafeTx) {
	if (safeTx.message.operation !== 0n) {
		throw new Error('Interceptor Gnosis Safe stacks support CALL operations only. DELEGATECALL transactions cannot be signed.')
	}
	if (
		safeTx.message.safeTxGas !== 0n
		|| safeTx.message.baseGas !== 0n
		|| safeTx.message.gasPrice !== 0n
		|| safeTx.message.gasToken !== 0n
		|| safeTx.message.refundReceiver !== 0n
	) {
		throw new Error('Interceptor Gnosis Safe stacks require zero gas reimbursement fields.')
	}
}

export function createSafeTx(chainId: bigint, safeAddress: EthereumAddress, transaction: {
	readonly to: EthereumAddress
	readonly value: bigint
	readonly input: Uint8Array
}, nonce: bigint): SafeTx {
	return createSafeTxFromMessage(chainId, safeAddress, {
		to: transaction.to,
		value: transaction.value,
		data: transaction.input,
		operation: 0n,
		safeTxGas: 0n,
		baseGas: 0n,
		gasPrice: 0n,
		gasToken: 0n,
		refundReceiver: 0n,
		nonce,
	})
}

export function createSafeTxFromMessage(chainId: bigint, safeAddress: EthereumAddress, message: SafeTx['message']): SafeTx {
	return {
		types: SAFE_TX_TYPES,
		primaryType: 'SafeTx',
		domain: { chainId, verifyingContract: safeAddress },
		message,
	}
}

async function getSafeTransactionHashFromContract(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeTx: SafeTx,
	blockNumber: bigint,
) {
	const contractHashResult = await callSafe(ethereum, safeAddress, encodeFunctionCall(SAFE_ABI, 'getTransactionHash', [
		addressString(safeTx.message.to),
		safeTx.message.value,
		dataStringWith0xStart(safeTx.message.data),
		safeTx.message.operation,
		safeTx.message.safeTxGas,
		safeTx.message.baseGas,
		safeTx.message.gasPrice,
		addressString(safeTx.message.gasToken),
		addressString(safeTx.message.refundReceiver),
		safeTx.message.nonce,
	]), blockNumber)
	return BigInt(decodeFunctionOutput(SAFE_ABI, 'getTransactionHash', contractHashResult))
}

export async function validateSafeTransactionForSigning(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeSignerAddress: EthereumAddress,
	safeTx: SafeTx,
	expectedSafeVersion?: string,
) {
	const blockNumber = await ethereum.getBlockNumber(undefined)
	return await validateSafeTransactionForSigningAtBlock(ethereum, safeAddress, safeSignerAddress, safeTx, blockNumber, expectedSafeVersion)
}

async function validateSafeTransactionForSigningAtBlock(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeSignerAddress: EthereumAddress,
	safeTx: SafeTx,
	blockNumber: bigint,
	expectedSafeVersion?: string,
) {
	const context = await validateSafeTransactionStateAtBlock(ethereum, safeAddress, safeTx, blockNumber, expectedSafeVersion)
	await context.ownerValidator.assertEoaOwner(safeSignerAddress)
	return await validateSafeTransactionHashAtBlock(ethereum, safeAddress, safeTx, blockNumber, context)
}

async function validateSafeTransactionForReviewAtBlock(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeTx: SafeTx,
	blockNumber: bigint,
	expectedSafeVersion?: string,
) {
	const context = await validateSafeTransactionStateAtBlock(ethereum, safeAddress, safeTx, blockNumber, expectedSafeVersion)
	return await validateSafeTransactionHashAtBlock(ethereum, safeAddress, safeTx, blockNumber, context)
}

async function validateSafeTransactionStateAtBlock(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeTx: SafeTx,
	blockNumber: bigint,
	expectedSafeVersion?: string,
) {
	const chainId = ethereum.getChainId()
	if (chainId === 0n) throw new Error('Gnosis Safe transactions require a chain ID.')
	if (safeTx.domain.chainId !== chainId) throw new Error('The Gnosis Safe transaction chain ID does not match the selected chain.')
	if (safeTx.domain.verifyingContract !== safeAddress) throw new Error('The Gnosis Safe transaction verifying contract does not match the active Gnosis Safe.')
	assertInterceptorSafeTransactionPolicy(safeTx)
	const state = await getSafeContractStateAtBlock(ethereum, safeAddress, blockNumber)
	if (expectedSafeVersion !== undefined && state.version !== expectedSafeVersion) {
		throw new Error(`The Gnosis Safe version is now ${ state.version }, but the address-book entry records ${ expectedSafeVersion }.`)
	}
	if (safeTx.message.nonce < state.nonce) {
		throw new Error(`The Gnosis Safe transaction nonce ${ safeTx.message.nonce.toString() } is older than the current nonce ${ state.nonce.toString() }.`)
	}
	const ownerValidator = createSafeOwnerValidator(ethereum, safeAddress, { blockNumber, state })
	return { safeState: state, ownerValidator }
}

async function validateSafeTransactionHashAtBlock(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeTx: SafeTx,
	blockNumber: bigint,
	context: { readonly safeState: SafeContractState, readonly ownerValidator: SafeOwnerValidator },
) {
	const localHash = BigInt(getSafeTxHash(safeTx))
	const contractHash = await getSafeTransactionHashFromContract(ethereum, safeAddress, safeTx, blockNumber)
	if (localHash !== contractHash) throw new Error('The locally computed Gnosis Safe transaction hash does not match the Gnosis Safe contract.')
	return { safeTxHash: localHash, ...context }
}

async function createSafeTransactionRequest(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeSignerAddress: EthereumAddress,
	transaction: { readonly to: EthereumAddress, readonly value: bigint, readonly input: Uint8Array, readonly gas: bigint },
	nonce: bigint,
	validateOwner: boolean,
): Promise<SafeTransactionSigningRequest> {
	const safeTx = createSafeTx(ethereum.getChainId(), safeAddress, transaction, nonce)
	const blockNumber = await ethereum.getBlockNumber(undefined)
	const validation = validateOwner
		? await validateSafeTransactionForSigningAtBlock(ethereum, safeAddress, safeSignerAddress, safeTx, blockNumber)
		: await validateSafeTransactionForReviewAtBlock(ethereum, safeAddress, safeTx, blockNumber)
	return {
		safeAddress,
		safeSignerAddress,
		safeVersion: validation.safeState.version,
		threshold: validation.safeState.threshold,
		reviewedSafeState: validation.safeState,
		safeTxHash: validation.safeTxHash,
		safeTx,
		executionGasLimit: transaction.gas,
	}
}

export async function createSafeTransactionSigningRequest(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeSignerAddress: EthereumAddress,
	transaction: { readonly to: EthereumAddress, readonly value: bigint, readonly input: Uint8Array, readonly gas: bigint },
	nonce: bigint,
): Promise<SafeTransactionSigningRequest> {
	return await createSafeTransactionRequest(ethereum, safeAddress, safeSignerAddress, transaction, nonce, true)
}

export async function createSafeTransactionReviewRequest(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeSignerAddress: EthereumAddress,
	transaction: { readonly to: EthereumAddress, readonly value: bigint, readonly input: Uint8Array, readonly gas: bigint },
	nonce: bigint,
): Promise<SafeTransactionSigningRequest> {
	return await createSafeTransactionRequest(ethereum, safeAddress, safeSignerAddress, transaction, nonce, false)
}

export function safeTxToTypedDataJson(safeTx: SafeTx) {
	return JSON.stringify({
		types: safeTx.types,
		primaryType: safeTx.primaryType,
		domain: {
			chainId: safeTx.domain.chainId?.toString(),
			verifyingContract: addressString(safeTx.domain.verifyingContract),
		},
		message: {
			to: addressString(safeTx.message.to),
			value: safeTx.message.value.toString(),
			data: dataStringWith0xStart(safeTx.message.data),
			operation: safeTx.message.operation.toString(),
			safeTxGas: safeTx.message.safeTxGas.toString(),
			baseGas: safeTx.message.baseGas.toString(),
			gasPrice: safeTx.message.gasPrice.toString(),
			gasToken: addressString(safeTx.message.gasToken),
			refundReceiver: addressString(safeTx.message.refundReceiver),
			nonce: safeTx.message.nonce.toString(),
		},
	})
}

export function normalizeSafeSignature(signature: string): Hex {
	const hex = ensureHex(signature, 'Gnosis Safe owner signature')
	if (hex.length !== 132) throw new Error('Gnosis Safe owner signature must be exactly 65 bytes.')
	const recoveryByte = Number.parseInt(hex.slice(-2), 16)
	if (recoveryByte !== 0 && recoveryByte !== 1 && recoveryByte !== 27 && recoveryByte !== 28) {
		throw new Error('Gnosis Safe owner signature has an unsupported recovery byte.')
	}
	const normalizedRecoveryByte = recoveryByte < 27 ? recoveryByte + 27 : recoveryByte
	return ensureHex(`${ hex.slice(0, -2) }${ normalizedRecoveryByte.toString(16).padStart(2, '0') }`, 'normalized Gnosis Safe owner signature')
}

async function recoverNormalizedSafeSignatureOwner(safeTxHash: bigint, normalizedSignature: Hex): Promise<EthereumAddress> {
	return BigInt(await recoverAddress({ hash: ensureHex(bytes32String(safeTxHash), 'Gnosis Safe transaction hash'), signature: normalizedSignature }))
}

export async function recoverSafeSignatureOwner(safeTxHash: bigint, signature: string): Promise<EthereumAddress> {
	return await recoverNormalizedSafeSignatureOwner(safeTxHash, normalizeSafeSignature(signature))
}
