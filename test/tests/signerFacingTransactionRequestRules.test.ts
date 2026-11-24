import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { OriginalSendRequestParameters } from '../../app/ts/types/JsonRpc-types.js'
import type { PendingTransactionSafeFlow } from '../../app/ts/types/accessRequest.js'
import { createSafeTx } from '../../app/ts/safe/safeCore.js'
import { getSignerNonce, isTransactionRequestForwardedToWallet } from '../../app/ts/utils/signerFacingTransactionRequest.js'

const sender = 0x1111111111111111111111111111111111111111n
const recipient = 0x2222222222222222222222222222222222222222n

type TransactionRequest = { readonly simulationMode: boolean, readonly originalRequestParameters: OriginalSendRequestParameters, readonly safeFlow: PendingTransactionSafeFlow }

// A created Safe proposal, the flow in which the wallet signs the SafeTx as typed data instead of this transaction.
const createdProposal: PendingTransactionSafeFlow = { kind: 'proposal', state: 'created', safeTransaction: {
	safeAddress: sender,
	safeSignerAddress: recipient,
	safeVersion: '1.4.1',
	threshold: 2n,
	reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [], threshold: 2n },
	safeTxHash: 1n,
	safeTx: createSafeTx(1n, sender, { to: recipient, value: 0n, input: new Uint8Array() }, 0n),
} }
const asSafeProposal = (request: TransactionRequest): TransactionRequest => ({ ...request, safeFlow: createdProposal })

function sendTransaction(simulationMode: boolean, nonce?: bigint): TransactionRequest {
	return {
		simulationMode,
		safeFlow: { kind: 'ordinary' },
		originalRequestParameters: {
			method: 'eth_sendTransaction',
			params: [{ from: sender, to: recipient, value: 0n, ...(nonce === undefined ? {} : { nonce }) }],
		},
	}
}

function sendRawTransaction(simulationMode: boolean): TransactionRequest {
	return {
		simulationMode,
		safeFlow: { kind: 'ordinary' },
		originalRequestParameters: { method: 'eth_sendRawTransaction', params: [new Uint8Array([2])] },
	}
}

describe('signer-facing transaction request rules', () => {
	test('forwards signing-mode requests to the wallet unless they are Safe proposals', () => {
		assert.equal(isTransactionRequestForwardedToWallet(sendTransaction(false)), true)
		assert.equal(isTransactionRequestForwardedToWallet(asSafeProposal(sendTransaction(false))), false)
		assert.equal(isTransactionRequestForwardedToWallet(sendTransaction(true)), false)
		assert.equal(isTransactionRequestForwardedToWallet(sendRawTransaction(false)), true)
	})

	test('lets the wallet select the nonce only when the website omitted it', () => {
		assert.deepEqual(getSignerNonce(sendTransaction(false)), { kind: 'wallet-selected' })
	})

	test('forwards the nonce the website requested unchanged', () => {
		assert.deepEqual(getSignerNonce(sendTransaction(false, 7n)), { kind: 'website-requested', nonce: 7n })
		assert.deepEqual(getSignerNonce(sendTransaction(false, 0n)), { kind: 'website-requested', nonce: 0n })
	})

	test('keeps the simulated nonce for requests the wallet does not sign as this transaction', () => {
		assert.deepEqual(getSignerNonce(sendTransaction(true, 7n)), { kind: 'simulated' })
		assert.deepEqual(getSignerNonce(sendTransaction(true)), { kind: 'simulated' })
		assert.deepEqual(getSignerNonce(asSafeProposal(sendTransaction(false, 7n))), { kind: 'simulated' })
		assert.deepEqual(getSignerNonce(sendRawTransaction(false)), { kind: 'simulated' })
	})
})
