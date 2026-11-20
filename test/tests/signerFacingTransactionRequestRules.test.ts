import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { OriginalSendRequestParameters } from '../../app/ts/types/JsonRpc-types.js'
import { getSignerNonce, isTransactionRequestForwardedToWallet } from '../../app/ts/utils/signerFacingTransactionRequest.js'

const sender = 0x1111111111111111111111111111111111111111n
const recipient = 0x2222222222222222222222222222222222222222n

type TransactionRequest = { readonly simulationMode: boolean, readonly originalRequestParameters: OriginalSendRequestParameters }

function sendTransaction(simulationMode: boolean, nonce?: bigint): TransactionRequest {
	return {
		simulationMode,
		originalRequestParameters: {
			method: 'eth_sendTransaction',
			params: [{ from: sender, to: recipient, value: 0n, ...(nonce === undefined ? {} : { nonce }) }],
		},
	}
}

function sendRawTransaction(simulationMode: boolean): TransactionRequest {
	return {
		simulationMode,
		originalRequestParameters: { method: 'eth_sendRawTransaction', params: [new Uint8Array([2])] },
	}
}

describe('signer-facing transaction request rules', () => {
	test('forwards signing-mode requests to the wallet unless they are Safe proposals', () => {
		assert.equal(isTransactionRequestForwardedToWallet(sendTransaction(false), false), true)
		assert.equal(isTransactionRequestForwardedToWallet(sendTransaction(false), true), false)
		assert.equal(isTransactionRequestForwardedToWallet(sendTransaction(true), false), false)
		assert.equal(isTransactionRequestForwardedToWallet(sendRawTransaction(false), false), true)
	})

	test('lets the wallet select the nonce only when the website omitted it', () => {
		assert.deepEqual(getSignerNonce(sendTransaction(false), false), { kind: 'wallet-selected' })
	})

	test('forwards the nonce the website requested unchanged', () => {
		assert.deepEqual(getSignerNonce(sendTransaction(false, 7n), false), { kind: 'website-requested', nonce: 7n })
		assert.deepEqual(getSignerNonce(sendTransaction(false, 0n), false), { kind: 'website-requested', nonce: 0n })
	})

	test('keeps the simulated nonce for requests the wallet does not sign as this transaction', () => {
		assert.deepEqual(getSignerNonce(sendTransaction(true, 7n), false), { kind: 'simulated' })
		assert.deepEqual(getSignerNonce(sendTransaction(true), false), { kind: 'simulated' })
		assert.deepEqual(getSignerNonce(sendTransaction(false, 7n), true), { kind: 'simulated' })
		assert.deepEqual(getSignerNonce(sendRawTransaction(false), false), { kind: 'simulated' })
	})
})
