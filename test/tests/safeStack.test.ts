import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { createSafeTx } from '../../app/ts/safe/safeCore.js'
import { reconcileSafeTransactionStack } from '../../app/ts/safe/safeStack.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'

const chainId = 1n
const safeAddress = 0x1111111111111111111111111111111111111111n
const destination = 0x2222222222222222222222222222222222222222n

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
