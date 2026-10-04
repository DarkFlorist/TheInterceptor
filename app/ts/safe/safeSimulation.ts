import type { StateOverrides } from '../types/ethSimulate-types.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { encodeFunctionCall } from '../utils/abiRuntime.js'
import { addressString, dataStringWith0xStart, stringToUint8Array } from '../utils/bigint.js'
import { getGnosisSafeProxyProxy } from '../utils/ethereumByteCodes.js'
import { createSafeValidationError } from './safeErrors.js'
import { validateSafeDelegateCode } from './safeDelegateCalls.js'

import { DEFAULT_BLOCK_MANIPULATION } from '../config/defaults.js'
import type { InterceptorTransactionStack, PreSimulationTransaction, SimulationStateInput, WebsiteCreatedEthereumTransaction } from '../types/visualizer-types.js'
import type { EthereumSendableSignedTransaction } from '../types/wire-types.js'
import type { SafeTransactionSigningRequest } from '../types/safeTypes.js'
import { getSignedTransactionForSimulation } from '../simulation/services/simulationTransactionSigning.js'
import { getOperationsForActiveStackContext, getSafeStackContext } from '../utils/activeStackContext.js'

export const ORIGINAL_GNOSIS_SAFE = 0x0000000000000000000000000000000000920515n
export const SAFE_DELEGATE_EXECUTE_ABI = [{ type: 'function', name: 'delegateCallExecute', stateMutability: 'payable', inputs: [{ name: 'target', type: 'address' }, { name: 'callData', type: 'bytes' }], outputs: [{ name: 'returnData', type: 'bytes' }] }] as const

export function createSafeSigningSimulationInput(
	transactionStack: InterceptorTransactionStack,
	safeSigningRequest: SafeTransactionSigningRequest,
): SimulationStateInput {
	const requiredChainId = safeSigningRequest.safeTx.domain.chainId
	if (requiredChainId === undefined) throw new Error('Gnosis Safe optimistic simulation requires an EIP-712 chain ID.')
	const transactions = getOperationsForActiveStackContext(transactionStack, getSafeStackContext(safeSigningRequest.safeAddress, requiredChainId)).flatMap((operation) => {
		if (operation.type !== 'Transaction') return []
		const transaction = operation.preSimulationTransaction
		const storedSafeTransaction = transaction.safeTransaction
		if (storedSafeTransaction === undefined) return []
		if (storedSafeTransaction.safeTx.message.nonce >= safeSigningRequest.safeTx.message.nonce) return []
		return [transaction]
	})
	if (transactions.length === 0) return []
	return [{
		stateOverrides: {},
		transactions,
		signedMessages: [],
		blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
		simulateWithZeroBaseFee: true,
	}]
}

function createSafeExecutionSimulationTransaction(
	transactionToSimulate: WebsiteCreatedEthereumTransaction,
	safeSigningRequest: SafeTransactionSigningRequest,
): EthereumSendableSignedTransaction {
	const transaction = getSignedTransactionForSimulation(transactionToSimulate)
	if (transaction.type !== '1559') {
		throw new Error('Gnosis Safe optimistic simulation requires an EIP-1559 transaction.')
	}
	return {
		type: '1559',
		from: safeSigningRequest.safeAddress,
		chainId: transaction.chainId,
		nonce: transaction.nonce,
		maxFeePerGas: 0n,
		maxPriorityFeePerGas: 0n,
		gas: safeSigningRequest.executionGasLimit ?? transaction.gas,
		to: safeSigningRequest.safeTx.message.operation === 1n ? safeSigningRequest.safeAddress : safeSigningRequest.safeTx.message.to,
		value: safeSigningRequest.safeTx.message.value,
		input: safeSigningRequest.safeTx.message.operation === 1n
			? stringToUint8Array(encodeFunctionCall(SAFE_DELEGATE_EXECUTE_ABI, 'delegateCallExecute', [addressString(safeSigningRequest.safeTx.message.to), dataStringWith0xStart(safeSigningRequest.safeTx.message.data)]))
			: safeSigningRequest.safeTx.message.data,
		accessList: [],
		r: 0n,
		s: 0n,
		yParity: 'even',
		hash: safeSigningRequest.safeTxHash,
	}
}

export function createSafeExecutionPreSimulationTransaction(
	transactionToSimulate: WebsiteCreatedEthereumTransaction,
	safeSigningRequest: SafeTransactionSigningRequest,
): PreSimulationTransaction {
	const requiredChainId = safeSigningRequest.safeTx.domain.chainId
	if (requiredChainId === undefined) throw new Error('Gnosis Safe optimistic simulation requires an EIP-712 chain ID.')
	const signedTransaction = createSafeExecutionSimulationTransaction(transactionToSimulate, safeSigningRequest)
	return {
		signedTransaction,
		website: transactionToSimulate.website,
		created: transactionToSimulate.created,
		originalRequestParameters: transactionToSimulate.originalRequestParameters,
		transactionIdentifier: transactionToSimulate.transactionIdentifier,
		simulationOptions: {
			requiredChainId,
			simulateWithZeroBaseFee: true,
		},
		safeTransaction: {
			safeTx: safeSigningRequest.safeTx,
			safeTxHash: safeSigningRequest.safeTxHash,
			created: transactionToSimulate.created,
			websiteOrigin: transactionToSimulate.website.websiteOrigin,
			transactionIdentifier: transactionToSimulate.transactionIdentifier,
			signatures: [],
		},
	}
}

// Shared proxy redirection; callers supply code from their own state view (pinned chain state or the simulated stack).
export function prepareSafeDelegateStateOverrides(safeAddress: bigint, code: Uint8Array, overrides: StateOverrides = {}): StateOverrides {
	return {
		...overrides,
		[addressString(safeAddress)]: { ...overrides[addressString(safeAddress)], code: getGnosisSafeProxyProxy() },
		[addressString(ORIGINAL_GNOSIS_SAFE)]: { ...overrides[addressString(ORIGINAL_GNOSIS_SAFE)], code },
	}
}

export async function prepareSafeDelegateSimulationInput(input: SimulationStateInput, ethereum: EthereumClientService, blockNumber: bigint): Promise<SimulationStateInput> {
	const delegates = input.flatMap((block) => block.transactions.flatMap((transaction) => transaction.safeTransaction?.safeTx.message.operation === 1n ? [transaction.safeTransaction.safeTx] : []))
	if (delegates.length === 0) return input
	const safes = new Set(delegates.map((transaction) => transaction.domain.verifyingContract))
	if (safes.size !== 1) throw createSafeValidationError('Safe delegate simulation requires one active Safe per stack.', 'safe_contract_validation')
	const safeAddress = delegates[0]?.domain.verifyingContract
	if (safeAddress === undefined) return input
	for (const transaction of delegates) await validateSafeDelegateCode(ethereum, transaction, blockNumber)
	for (const block of input) for (const transaction of block.transactions) {
		const safeTx = transaction.safeTransaction?.safeTx
		if (safeTx?.message.operation !== 1n) continue
		const simulated = transaction.signedTransaction
		const expectedInput = encodeFunctionCall(SAFE_DELEGATE_EXECUTE_ABI, 'delegateCallExecute', [addressString(safeTx.message.to), dataStringWith0xStart(safeTx.message.data)])
		if (simulated.from !== safeAddress || simulated.to !== safeAddress || simulated.value !== 0n || dataStringWith0xStart(simulated.input) !== expectedInput) throw createSafeValidationError('The Safe delegate simulation does not match its proposal.', 'safe_contract_validation')
	}
	const code = await ethereum.getCode(safeAddress, blockNumber, undefined)
	if (code.length === 0) throw createSafeValidationError('The Safe proxy code is unavailable for batch simulation.', 'safe_contract_validation')
	return input.map((block) => ({ ...block, stateOverrides: prepareSafeDelegateStateOverrides(safeAddress, code, block.stateOverrides) }))
}
