import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { DEFAULT_BLOCK_MANIPULATION } from '../../app/ts/config/defaults.js'
import { createSafeTx } from '../../app/ts/safe/safeCore.js'
import { reconcileSafeTransactionStack, reconcileSafeTransactionState } from '../../app/ts/safe/safeStack.js'
import { mockSignTransaction } from '../../app/ts/simulation/services/simulationTransactionSigning.js'
import type { InterceptorTransactionStack, PreSimulationTransaction } from '../../app/ts/types/visualizer-types.js'
import { getOperationsForActiveStackContext, getSafeStackContext, SIMULATION_STACK_CONTEXT } from '../../app/ts/utils/activeStackContext.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'

const chainId = 1n
const safeAddress = 0x1111111111111111111111111111111111111111n
const destination = 0x2222222222222222222222222222222222222222n

function stackTransaction(transactionIdentifier: bigint, requiredChainId: bigint, verifyingSafeAddress?: bigint): PreSimulationTransaction {
	const transactionRequest = { from: safeAddress, to: destination, value: 0n, input: new Uint8Array() }
	const safeTx = verifyingSafeAddress === undefined
		? undefined
		: createSafeTx(requiredChainId, verifyingSafeAddress, transactionRequest, transactionIdentifier)
	return {
		signedTransaction: mockSignTransaction({
			type: '1559',
			...transactionRequest,
			nonce: transactionIdentifier,
			gas: 21_000n,
			chainId: requiredChainId,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
		}),
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: 'Example' },
		created: new Date('2026-07-31T00:00:00.000Z'),
		originalRequestParameters: { method: 'eth_sendTransaction', params: [transactionRequest] },
		transactionIdentifier,
		simulationOptions: { requiredChainId },
		...(safeTx === undefined ? {} : {
			safeTransaction: {
				safeTx,
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				created: new Date('2026-07-31T00:00:00.000Z'),
				websiteOrigin: 'https://example.com',
				transactionIdentifier,
				signatures: [],
			},
		}),
	}
}

function transaction(nonce: bigint) {
	const safeTx = createSafeTx(chainId, safeAddress, { to: destination, value: nonce, input: new Uint8Array() }, nonce)
	return {
		safeTx,
		safeTxHash: BigInt(getSafeTxHash(safeTx)),
		created: new Date('2026-07-31T00:00:00.000Z'),
		websiteOrigin: 'https://example.com',
		transactionIdentifier: nonce + 100n,
		signatures: [],
	}
}

const stack = {
	chainId,
	safeAddress,
	safeVersion: '1.4.1',
	baseNonce: 4n,
	threshold: 2n,
	transactions: [transaction(4n), transaction(5n), transaction(6n)],
}

describe('Gnosis Safe stack reconciliation', () => {
	test('selects simulation and active Safe operations from one shared context rule', () => {
		const ordinaryTransaction = stackTransaction(1n, chainId)
		const activeSafeTransaction = stackTransaction(2n, chainId, safeAddress)
		const otherSafeTransaction = stackTransaction(3n, chainId, safeAddress + 1n)
		const otherChainTransaction = stackTransaction(4n, chainId + 1n, safeAddress)
		const interceptorStack: InterceptorTransactionStack = { operations: [
			{ type: 'Transaction', preSimulationTransaction: ordinaryTransaction },
			{ type: 'TimeManipulation', blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION },
			{ type: 'Transaction', preSimulationTransaction: activeSafeTransaction },
			{ type: 'Transaction', preSimulationTransaction: otherSafeTransaction },
			{ type: 'Transaction', preSimulationTransaction: otherChainTransaction },
		] }

		assert.deepEqual(
			getOperationsForActiveStackContext(interceptorStack, SIMULATION_STACK_CONTEXT),
			interceptorStack.operations.slice(0, 2),
		)
		assert.deepEqual(
			getOperationsForActiveStackContext(interceptorStack, getSafeStackContext(safeAddress, chainId)),
			[interceptorStack.operations[2]],
		)
		assert.deepEqual(
			getOperationsForActiveStackContext(interceptorStack, getSafeStackContext(undefined, chainId)),
			[],
		)
	})

	test('drops only the prefix whose nonces already executed', () => {
		const reconciled = reconcileSafeTransactionStack(stack, 6n)

		assert.equal(reconciled.baseNonce, 6n)
		assert.deepEqual(reconciled.transactions.map(({ safeTx }) => safeTx.message.nonce), [6n])
	})

	test('returns an empty current stack when every transaction executed', () => {
		const reconciled = reconcileSafeTransactionStack(stack, 7n)

		assert.equal(reconciled.baseNonce, 7n)
		assert.deepEqual(reconciled.transactions, [])
	})

	test('rejects nonces outside the stack range', () => {
		assert.throws(() => reconcileSafeTransactionStack(stack, 3n), /precedes this stack's base nonce/u)
		assert.throws(() => reconcileSafeTransactionStack(stack, 8n), /beyond this stack's final nonce/u)
	})
})

const stateToReconcile = {
	safeTransactionStacks: [stack],
	interceptorTransactionStack: { operations: [
		{ type: 'Transaction' as const, preSimulationTransaction: stackTransaction(1n, chainId) },
		...stack.transactions.map((safeTransaction) => ({ type: 'Transaction' as const, preSimulationTransaction: { ...stackTransaction(safeTransaction.transactionIdentifier, chainId), safeTransaction } })),
	] },
}

describe('Gnosis Safe state reconciliation result', () => {
	test.each([['no matching Safe', safeAddress + 1n, chainId], ['no matching chain', safeAddress, chainId + 1n], ['no executed transactions', safeAddress, chainId]] as const)('reports no removed operations with %s', (_description, selectedSafe, selectedChain) => {
		const result = reconcileSafeTransactionState(stateToReconcile, selectedChain, selectedSafe, stack.baseNonce)
		assert.equal(result.removedExecutedOperations, false)
		assert.deepEqual(result.state, stateToReconcile)
	})

	test.each([5n, 7n])('reports removed operations explicitly and updates both stacks at nonce %s', (currentNonce) => {
		const result = reconcileSafeTransactionState(stateToReconcile, chainId, safeAddress, currentNonce)
		const remaining = stack.transactions.filter(({ safeTx }) => safeTx.message.nonce >= currentNonce)
		assert.equal(result.removedExecutedOperations, true)
		assert.deepEqual(result.state.safeTransactionStacks, remaining.length === 0 ? [] : [{ ...stack, baseNonce: currentNonce, transactions: remaining }])
		assert.deepEqual(result.state.interceptorTransactionStack.operations.flatMap((operation) => operation.type === 'Transaction' ? [operation.preSimulationTransaction.transactionIdentifier] : []), [1n, ...remaining.map(({ transactionIdentifier }) => transactionIdentifier)])
		assert.deepEqual(stateToReconcile.safeTransactionStacks[0]?.transactions.map(({ safeTx }) => safeTx.message.nonce), [4n, 5n, 6n])
		assert.equal(stateToReconcile.interceptorTransactionStack.operations.length, 4)
	})

	test('rejects invalid nonces instead of returning a removal flag', () => {
		assert.throws(() => reconcileSafeTransactionState(stateToReconcile, chainId, safeAddress, 3n), /precedes/u)
		assert.throws(() => reconcileSafeTransactionState(stateToReconcile, chainId, safeAddress, 8n), /beyond/u)
	})
})
