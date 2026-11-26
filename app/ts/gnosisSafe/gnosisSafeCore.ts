import { assertGnosisSafeDelegateCall, validateGnosisSafeDelegateCode } from './gnosisSafeDelegateCalls.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { GnosisSafeTx } from '../types/personal-message-definitions.js'
import type { GnosisSafeOwnerSignature, GnosisSafeTransactionSigningRequest, GnosisSafeTransactionStack } from '../types/gnosisSafeTypes.js'
import type { EthereumAddress, EthereumBlockTag } from '../types/wire-types.js'
import type { Abi, Hex } from '../utils/ethereumPrimitives.js'
import { decodeFunctionOutput, encodeFunctionCall } from '../utils/abiRuntime.js'
import { addressString, bytes32String, checksummedAddress, dataStringWith0xStart, stringToUint8Array } from '../utils/bigint.js'
import { ensureHex } from '../utils/ethereumBytes.js'
import { isAbiDataDecodeError, recoverAddress } from '../utils/ethereumPrimitives.js'
import { getMessageAndDomainHash, getGnosisSafeTxHash } from '../utils/eip712.js'
import { EIP712Message } from '../types/eip721.js'
import { getErrorMessage } from '../utils/caughtErrors.js'
import { isExecutionRevert } from '../utils/errors.js'
import { createGnosisSafeValidationError, hasGnosisSafeValidationErrorCode } from './gnosisSafeErrors.js'

const SUPPORTED_GNOSIS_SAFE_VERSIONS = ['1.3.0', '1.4.0', '1.4.1'] as const

export const GNOSIS_SAFE_TRANSACTION_CORE_FIELDS = [
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

const GNOSIS_SAFE_TX_TYPES = {
	SafeTx: [
		...GNOSIS_SAFE_TRANSACTION_CORE_FIELDS,
		{ name: 'nonce', type: 'uint256' },
	],
	EIP712Domain: [
		{ name: 'chainId', type: 'uint256' },
		{ name: 'verifyingContract', type: 'address' },
	],
} as const

export const GNOSIS_SAFE_ABI = [
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
			...GNOSIS_SAFE_TRANSACTION_CORE_FIELDS,
			{ name: '_nonce', type: 'uint256' },
		],
		outputs: [{ name: '', type: 'bytes32' }],
	},
] as const satisfies Abi

const callGnosisSafe = async (
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	input: Hex,
	blockTag: EthereumBlockTag,
) => await ethereum.call({
		to: safeAddress,
		input: stringToUint8Array(input),
	}, blockTag, undefined)

export type GnosisSafeContractState = {
	readonly version: string
	readonly nonce: bigint
	readonly owners: readonly bigint[]
	readonly threshold: bigint
}

export type GnosisSafeContractSnapshot = {
	readonly blockNumber: bigint
	readonly state: GnosisSafeContractState
}

export type GnosisSafeOwnerValidator = {
	readonly assertEoaOwner: (owner: EthereumAddress) => Promise<void>
	readonly validateSignature: (
		safeTxHash: bigint,
		signature: string,
		expectedSafeSigner?: EthereumAddress,
	) => Promise<GnosisSafeOwnerSignature>
}

export type ValidatedGnosisSafeEoaOwner = {
	readonly snapshot: GnosisSafeContractSnapshot
	readonly ownerValidator: GnosisSafeOwnerValidator
}

export function createGnosisSafeOwnerValidationFailure(message: string) {
	return createGnosisSafeValidationError(message, 'safe_owner_validation')
}

export function isGnosisSafeOwnerValidationFailure(error: unknown) {
	return hasGnosisSafeValidationErrorCode(error, 'safe_owner_validation')
}

export function createGnosisSafeContractValidationFailure(message: string) {
	return createGnosisSafeValidationError(message, 'safe_contract_validation')
}

export function isGnosisSafeContractValidationFailure(error: unknown) {
	return hasGnosisSafeValidationErrorCode(error, 'safe_contract_validation')
}

function canonicalGnosisSafeOwners(owners: readonly bigint[]) {
	return [...owners].sort((first, second) => first < second ? -1 : first > second ? 1 : 0)
}

export function assertGnosisSafeContractStateUnchanged(reviewedState: GnosisSafeContractState, currentState: GnosisSafeContractState) {
	if (reviewedState.version !== currentState.version) {
		throw createGnosisSafeContractValidationFailure(`The Gnosis Safe version changed from ${ reviewedState.version } to ${ currentState.version } after this confirmation opened.`)
	}
	if (reviewedState.nonce !== currentState.nonce) {
		throw createGnosisSafeContractValidationFailure(`The Gnosis Safe nonce changed from ${ reviewedState.nonce.toString() } to ${ currentState.nonce.toString() } after this confirmation opened.`)
	}
	if (reviewedState.threshold !== currentState.threshold) {
		throw createGnosisSafeContractValidationFailure(`The Gnosis Safe threshold changed from ${ reviewedState.threshold.toString() } to ${ currentState.threshold.toString() } after this confirmation opened.`)
	}
	const reviewedOwners = canonicalGnosisSafeOwners(reviewedState.owners)
	const currentOwners = canonicalGnosisSafeOwners(currentState.owners)
	if (reviewedOwners.length !== currentOwners.length || reviewedOwners.some((owner, index) => owner !== currentOwners[index])) {
		throw createGnosisSafeContractValidationFailure('The Gnosis Safe owner set changed after this confirmation opened.')
	}
}

// The one read of a Gnosis Safe's owners and threshold, for every path that needs them. The calls and their decoding are separate so a caller can run them with its other reads and still decode in its own order.
const gnosisSafeOwnershipCalldata = (): readonly [Hex, Hex] => [encodeFunctionCall(GNOSIS_SAFE_ABI, 'getOwners', []), encodeFunctionCall(GNOSIS_SAFE_ABI, 'getThreshold', [])]

const callGnosisSafeOwnership = async (ethereum: EthereumClientService, safeAddress: EthereumAddress, blockNumber: bigint) => {
	const [owners, threshold] = gnosisSafeOwnershipCalldata()
	return await Promise.all([callGnosisSafe(ethereum, safeAddress, owners, blockNumber), callGnosisSafe(ethereum, safeAddress, threshold, blockNumber)])
}

const decodeGnosisSafeOwnership = ([ownersResult, thresholdResult]: Awaited<ReturnType<typeof callGnosisSafeOwnership>>) => ({
	owners: decodeFunctionOutput(GNOSIS_SAFE_ABI, 'getOwners', ownersResult).map((owner) => BigInt(owner)),
	threshold: decodeFunctionOutput(GNOSIS_SAFE_ABI, 'getThreshold', thresholdResult),
})

export async function getGnosisSafeContractStateAtBlock(ethereum: EthereumClientService, safeAddress: EthereumAddress, blockNumber: bigint, readMany = (inputs: readonly Hex[]) => Promise.all(inputs.map((input) => callGnosisSafe(ethereum, safeAddress, input, blockNumber)))): Promise<GnosisSafeContractState> {
	const code = await ethereum.getCode(safeAddress, blockNumber, undefined)
	if (code.length === 0) throw createGnosisSafeContractValidationFailure('The Gnosis Safe address does not contain a deployed contract on the selected chain.')
	const [versionResult, nonceResult, ownersResult, thresholdResult, ...extraResults] = await readMany([
		encodeFunctionCall(GNOSIS_SAFE_ABI, 'VERSION', []),
		encodeFunctionCall(GNOSIS_SAFE_ABI, 'nonce', []),
		...gnosisSafeOwnershipCalldata(),
	])
	if (versionResult === undefined || nonceResult === undefined || ownersResult === undefined || thresholdResult === undefined || extraResults.length !== 0) throw new Error('Invalid Gnosis Safe metadata batch response length.')
	const version = decodeFunctionOutput(GNOSIS_SAFE_ABI, 'VERSION', versionResult)
	const nonce = decodeFunctionOutput(GNOSIS_SAFE_ABI, 'nonce', nonceResult)
	const { owners, threshold } = decodeGnosisSafeOwnership([ownersResult, thresholdResult])
	if (!SUPPORTED_GNOSIS_SAFE_VERSIONS.some((supportedVersion) => supportedVersion === version)) {
		throw createGnosisSafeContractValidationFailure(`Gnosis Safe version ${ version } is not supported. Supported versions: ${ SUPPORTED_GNOSIS_SAFE_VERSIONS.join(', ') }.`)
	}
	return { version, nonce, owners, threshold }
}

export async function getGnosisSafeContractState(ethereum: EthereumClientService, safeAddress: EthereumAddress): Promise<GnosisSafeContractState> {
	return (await getGnosisSafeContractSnapshot(ethereum, safeAddress)).state
}

export async function getGnosisSafeContractSnapshot(ethereum: EthereumClientService, safeAddress: EthereumAddress): Promise<GnosisSafeContractSnapshot> {
	const blockNumber = await ethereum.getBlockNumber(undefined)
	return { blockNumber, state: await getGnosisSafeContractStateAtBlock(ethereum, safeAddress, blockNumber) }
}

// A page's GnosisSafeTx is simulated as the address it names, which runs code as that address and spends its real balance, so the address must be a Gnosis Safe the user can sign for. Owners are read from the chain, never the stack, so code a page put on the stack cannot answer. The active address counts as signer when it is the named Gnosis Safe, because the user chose that Gnosis Safe and its signer was validated when configured. A contract built to answer still passes, but it then runs as itself, so only its own balance and logs can appear.
export async function assertGnosisSafeTxPreviewAllowed(ethereum: EthereumClientService, safeAddress: EthereumAddress, activeAddress: EthereumAddress, messageChainId: bigint | undefined) {
	if (messageChainId !== undefined && messageChainId !== ethereum.getChainId()) throw createGnosisSafeContractValidationFailure(`No outcome is simulated: this message is for chain ${ messageChainId.toString() }, not the selected network.`)
	const notSafeMessage = `No outcome is simulated: ${ checksummedAddress(safeAddress) } is not a Gnosis Safe on this network, so nothing could execute this message there.`
	// Unlike getGnosisSafeContractStateAtBlock, no VERSION or code is read: 1.1.1 and 1.5.0 Gnosis Safe wallets are in use and the preview only simulates, and an address without code fails the decode below.
	const ownership = await callGnosisSafeOwnership(ethereum, safeAddress, await ethereum.getBlockNumber(undefined)).then(decodeGnosisSafeOwnership).catch((error: unknown) => {
		if (isAbiDataDecodeError(error) || isExecutionRevert(error)) throw createGnosisSafeContractValidationFailure(notSafeMessage)
		throw error
	})
	// A Gnosis Safe's setup and owner changes keep its threshold between 1 and its owner count, so a reply outside that is not from a Gnosis Safe.
	if (ownership.threshold === 0n || ownership.threshold > BigInt(ownership.owners.length)) throw createGnosisSafeContractValidationFailure(notSafeMessage)
	if (activeAddress !== safeAddress && !ownership.owners.includes(activeAddress)) throw createGnosisSafeOwnerValidationFailure(`No outcome is simulated: ${ checksummedAddress(activeAddress) } is not an owner of Gnosis Safe ${ checksummedAddress(safeAddress) }, so its signature could not execute this message.`)
}

export function createGnosisSafeOwnerValidator(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	snapshot: GnosisSafeContractSnapshot,
): GnosisSafeOwnerValidator {
	const safeOwners = new Set(snapshot.state.owners)
	const eoaValidationByOwner = new Map<EthereumAddress, Promise<void>>()
	const assertEoaOwner = async (owner: EthereumAddress) => {
		if (!safeOwners.has(owner)) {
			throw createGnosisSafeOwnerValidationFailure(`${ addressString(owner) } is not an owner of Gnosis Safe ${ addressString(safeAddress) }.`)
		}
		let validation = eoaValidationByOwner.get(owner)
		if (validation === undefined) {
			validation = (async () => {
				const ownerCode = await ethereum.getCode(owner, snapshot.blockNumber, undefined)
				if (ownerCode.length > 0) {
					throw createGnosisSafeOwnerValidationFailure(`${ addressString(owner) } is a contract owner. This Gnosis Safe workflow currently supports EOA owners only.`)
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
	): Promise<GnosisSafeOwnerSignature> => {
		let normalizedSignature: Hex
		let signer: EthereumAddress
		try {
			normalizedSignature = normalizeGnosisSafeSignature(signature)
			signer = await recoverNormalizedGnosisSafeSignatureOwner(safeTxHash, normalizedSignature)
		} catch (error) {
			throw createGnosisSafeOwnerValidationFailure(getErrorMessage(error) ?? 'The signer returned an invalid Gnosis Safe owner signature.')
		}
		if (expectedSafeSigner !== undefined && signer !== expectedSafeSigner) {
			throw createGnosisSafeOwnerValidationFailure(`The wallet signature was created by ${ addressString(signer) }, not the expected wallet-selected Gnosis Safe owner ${ addressString(expectedSafeSigner) }.`)
		}
		await assertEoaOwner(signer)
		return { signer, signature: normalizedSignature }
	}
	return { assertEoaOwner, validateSignature }
}

async function validateGnosisSafeOwnerIsEoaAtBlock(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	owner: EthereumAddress,
	blockNumber: bigint,
): Promise<ValidatedGnosisSafeEoaOwner> {
	const snapshot = { blockNumber, state: await getGnosisSafeContractStateAtBlock(ethereum, safeAddress, blockNumber) }
	const ownerValidator = createGnosisSafeOwnerValidator(ethereum, safeAddress, snapshot)
	await ownerValidator.assertEoaOwner(owner)
	return { snapshot, ownerValidator }
}

export async function validateGnosisSafeOwnerIsEoa(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	owner: EthereumAddress,
): Promise<ValidatedGnosisSafeEoaOwner> {
	return await validateGnosisSafeOwnerIsEoaAtBlock(ethereum, safeAddress, owner, await ethereum.getBlockNumber(undefined))
}

export function assertUniqueGnosisSafeTransactionStacks(stacks: readonly GnosisSafeTransactionStack[]) {
	const stackKeys = stacks.map((stack) => `${ stack.chainId.toString() }:${ addressString(stack.safeAddress) }`)
	if (new Set(stackKeys).size !== stackKeys.length) throw new Error('The Gnosis Safe stack export contains duplicate entries for the same Gnosis Safe and chain.')
}

export function assertInterceptorGnosisSafeTransactionPolicy(safeTx: GnosisSafeTx) {
	if (safeTx.message.operation !== 0n) {
		assertGnosisSafeDelegateCall(safeTx)
	}
	if (
		safeTx.message.safeTxGas !== 0n
		|| safeTx.message.baseGas !== 0n
		|| safeTx.message.gasPrice !== 0n
		|| safeTx.message.gasToken !== 0n
		|| safeTx.message.refundReceiver !== 0n
	) {
		throw createGnosisSafeContractValidationFailure('Interceptor Gnosis Safe stacks require zero gas reimbursement fields.')
	}
}

export function createGnosisSafeTx(chainId: bigint, safeAddress: EthereumAddress, transaction: {
	readonly to: EthereumAddress
	readonly value: bigint
	readonly input: Uint8Array
	readonly operation?: bigint
}, nonce: bigint): GnosisSafeTx {
	return createGnosisSafeTxFromMessage(chainId, safeAddress, {
		to: transaction.to,
		value: transaction.value,
		data: transaction.input,
		operation: transaction.operation ?? 0n,
		safeTxGas: 0n,
		baseGas: 0n,
		gasPrice: 0n,
		gasToken: 0n,
		refundReceiver: 0n,
		nonce,
	})
}

export function createGnosisSafeTxFromMessage(chainId: bigint, safeAddress: EthereumAddress, message: GnosisSafeTx['message']): GnosisSafeTx {
	return {
		types: GNOSIS_SAFE_TX_TYPES,
		primaryType: 'SafeTx',
		domain: { chainId, verifyingContract: safeAddress },
		message,
	}
}

async function getGnosisSafeTransactionHashFromContract(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeTx: GnosisSafeTx,
	blockNumber: bigint,
) {
	const contractHashResult = await callGnosisSafe(ethereum, safeAddress, encodeFunctionCall(GNOSIS_SAFE_ABI, 'getTransactionHash', [
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
	return BigInt(decodeFunctionOutput(GNOSIS_SAFE_ABI, 'getTransactionHash', contractHashResult))
}

export async function validateGnosisSafeTransactionForSigning(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeSignerAddress: EthereumAddress,
	safeTx: GnosisSafeTx,
	expectedSafeVersion?: string,
) {
	const blockNumber = await ethereum.getBlockNumber(undefined)
	return await validateGnosisSafeTransactionForSigningAtBlock(ethereum, safeAddress, safeSignerAddress, safeTx, blockNumber, expectedSafeVersion)
}

async function validateGnosisSafeTransactionForSigningAtBlock(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeSignerAddress: EthereumAddress,
	safeTx: GnosisSafeTx,
	blockNumber: bigint,
	expectedSafeVersion?: string,
) {
	assertGnosisSafeTransactionContext(ethereum, safeAddress, safeTx)
	await validateGnosisSafeDelegateCode(ethereum, safeTx, blockNumber)
	const { snapshot, ownerValidator } = await validateGnosisSafeOwnerIsEoaAtBlock(ethereum, safeAddress, safeSignerAddress, blockNumber)
	const context = validateGnosisSafeTransactionState(snapshot.state, safeTx, ownerValidator, expectedSafeVersion)
	return await validateGnosisSafeTransactionHashAtBlock(ethereum, safeAddress, safeTx, blockNumber, context)
}

async function validateGnosisSafeTransactionForReviewAtBlock(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeTx: GnosisSafeTx,
	blockNumber: bigint,
	expectedSafeVersion?: string,
) {
	assertGnosisSafeTransactionContext(ethereum, safeAddress, safeTx)
	await validateGnosisSafeDelegateCode(ethereum, safeTx, blockNumber)
	const state = await getGnosisSafeContractStateAtBlock(ethereum, safeAddress, blockNumber)
	const context = validateGnosisSafeTransactionState(state, safeTx, createGnosisSafeOwnerValidator(ethereum, safeAddress, { blockNumber, state }), expectedSafeVersion)
	return await validateGnosisSafeTransactionHashAtBlock(ethereum, safeAddress, safeTx, blockNumber, context)
}

function assertGnosisSafeTransactionContext(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeTx: GnosisSafeTx,
) {
	assertGnosisSafeDomainChainIsConnectedChain(safeTx.domain.chainId, ethereum.getChainId())
	if (safeTx.domain.verifyingContract !== safeAddress) throw createGnosisSafeContractValidationFailure('The Gnosis Safe transaction verifying contract does not match the active Gnosis Safe.')
	assertInterceptorGnosisSafeTransactionPolicy(safeTx)
}

// The single rule for which chain a GnosisSafeTx may be signed or stacked on: its EIP-712 domain fixes the chain it executes on, so that chain must be the connected one, and a connected chain without an ID (0n) never qualifies.
export function assertGnosisSafeDomainChainIsConnectedChain(domainChainId: bigint | undefined, connectedChainId: bigint) {
	if (connectedChainId === 0n) throw createGnosisSafeContractValidationFailure('Gnosis Safe transactions require a chain ID.')
	if (domainChainId === connectedChainId) return
	const preparedChain = domainChainId === undefined ? 'an unspecified chain' : `chain ${ domainChainId.toString() }`
	throw createGnosisSafeContractValidationFailure(`This Gnosis Safe transaction was prepared for ${ preparedChain }, but the connected network is chain ${ connectedChainId.toString() }. Prepare it again on the current network.`)
}

// Proposal-lifecycle guard for the steps (signing, signer refresh, stacking) that act on an already prepared proposal after the network may have changed.
export function assertGnosisSafeProposalChainMatchesConnectedNetwork(ethereum: EthereumClientService, safeTx: GnosisSafeTx) {
	assertGnosisSafeDomainChainIsConnectedChain(safeTx.domain.chainId, ethereum.getChainId())
}

function validateGnosisSafeTransactionState(
	state: GnosisSafeContractState,
	safeTx: GnosisSafeTx,
	ownerValidator: GnosisSafeOwnerValidator,
	expectedSafeVersion?: string,
) {
	if (expectedSafeVersion !== undefined && state.version !== expectedSafeVersion) {
		throw createGnosisSafeContractValidationFailure(`The Gnosis Safe version is now ${ state.version }, but the address-book entry records ${ expectedSafeVersion }.`)
	}
	if (safeTx.message.nonce < state.nonce) {
		throw createGnosisSafeContractValidationFailure(`The Gnosis Safe transaction nonce ${ safeTx.message.nonce.toString() } is older than the current nonce ${ state.nonce.toString() }.`)
	}
	return { safeState: state, ownerValidator }
}

async function validateGnosisSafeTransactionHashAtBlock(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeTx: GnosisSafeTx,
	blockNumber: bigint,
	context: { readonly safeState: GnosisSafeContractState, readonly ownerValidator: GnosisSafeOwnerValidator },
) {
	const localHash = BigInt(getGnosisSafeTxHash(safeTx))
	const contractHash = await getGnosisSafeTransactionHashFromContract(ethereum, safeAddress, safeTx, blockNumber)
	if (localHash !== contractHash) throw createGnosisSafeContractValidationFailure('The locally computed Gnosis Safe transaction hash does not match the Gnosis Safe contract.')
	return { safeTxHash: localHash, ...context }
}

async function createGnosisSafeTransactionRequest(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeSignerAddress: EthereumAddress | undefined,
	transaction: { readonly to: EthereumAddress, readonly value: bigint, readonly input: Uint8Array, readonly gas: bigint, readonly operation?: bigint },
	nonce: bigint,
	validateOwner: boolean,
): Promise<GnosisSafeTransactionSigningRequest> {
	const safeTx = createGnosisSafeTx(ethereum.getChainId(), safeAddress, transaction, nonce)
	const blockNumber = await ethereum.getBlockNumber(undefined)
	let validation: Awaited<ReturnType<typeof validateGnosisSafeTransactionForReviewAtBlock>>
	if (validateOwner) {
		if (safeSignerAddress === undefined) throw createGnosisSafeOwnerValidationFailure('A wallet-selected Gnosis Safe owner is required before signing.')
		validation = await validateGnosisSafeTransactionForSigningAtBlock(ethereum, safeAddress, safeSignerAddress, safeTx, blockNumber)
	} else {
		validation = await validateGnosisSafeTransactionForReviewAtBlock(ethereum, safeAddress, safeTx, blockNumber)
	}
	return {
		safeAddress,
		...(safeSignerAddress === undefined ? {} : { safeSignerAddress }),
		safeVersion: validation.safeState.version,
		threshold: validation.safeState.threshold,
		reviewedSafeState: validation.safeState,
		safeTxHash: validation.safeTxHash,
		safeTx,
		executionGasLimit: transaction.gas,
	}
}

export async function createGnosisSafeTransactionSigningRequest(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeSignerAddress: EthereumAddress,
	transaction: { readonly to: EthereumAddress, readonly value: bigint, readonly input: Uint8Array, readonly gas: bigint, readonly operation?: bigint },
	nonce: bigint,
): Promise<GnosisSafeTransactionSigningRequest> {
	return await createGnosisSafeTransactionRequest(ethereum, safeAddress, safeSignerAddress, transaction, nonce, true)
}

export async function createGnosisSafeTransactionReviewRequest(
	ethereum: EthereumClientService,
	safeAddress: EthereumAddress,
	safeSignerAddress: EthereumAddress | undefined,
	transaction: { readonly to: EthereumAddress, readonly value: bigint, readonly input: Uint8Array, readonly gas: bigint, readonly operation?: bigint },
	nonce: bigint,
): Promise<GnosisSafeTransactionSigningRequest> {
	return await createGnosisSafeTransactionRequest(ethereum, safeAddress, safeSignerAddress, transaction, nonce, false)
}

export function gnosisSafeTxToTypedDataJson(safeTx: GnosisSafeTx) {
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

// The one eth_signTypedData_v4 payload for a Gnosis Safe transaction: every signer-facing request and every displayed hash must come from here.
export function getGnosisSafeTxSignerFacingTypedData(safeTx: GnosisSafeTx): EIP712Message {
	return EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx))
}

// The domain and message hashes a hardware signer displays for the signer-facing payload. The signer address slot does not take part in hashing.
export function getGnosisSafeTxSigningHashes(safeTx: GnosisSafeTx) {
	return getMessageAndDomainHash({ method: 'eth_signTypedData_v4', params: [safeTx.domain.verifyingContract, getGnosisSafeTxSignerFacingTypedData(safeTx)] })
}

export function normalizeGnosisSafeSignature(signature: string): Hex {
	const hex = ensureHex(signature, 'Gnosis Safe owner signature')
	if (hex.length !== 132) throw new Error('Gnosis Safe owner signature must be exactly 65 bytes.')
	const recoveryByte = Number.parseInt(hex.slice(-2), 16)
	if (recoveryByte !== 0 && recoveryByte !== 1 && recoveryByte !== 27 && recoveryByte !== 28) {
		throw new Error('Gnosis Safe owner signature has an unsupported recovery byte.')
	}
	const normalizedRecoveryByte = recoveryByte < 27 ? recoveryByte + 27 : recoveryByte
	return ensureHex(`${ hex.slice(0, -2) }${ normalizedRecoveryByte.toString(16).padStart(2, '0') }`, 'normalized Gnosis Safe owner signature')
}

async function recoverNormalizedGnosisSafeSignatureOwner(safeTxHash: bigint, normalizedSignature: Hex): Promise<EthereumAddress> {
	return BigInt(await recoverAddress({ hash: ensureHex(bytes32String(safeTxHash), 'Gnosis Safe transaction hash'), signature: normalizedSignature }))
}

export async function recoverGnosisSafeSignatureOwner(safeTxHash: bigint, signature: string): Promise<EthereumAddress> {
	return await recoverNormalizedGnosisSafeSignatureOwner(safeTxHash, normalizeGnosisSafeSignature(signature))
}
