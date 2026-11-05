import * as assert from 'node:assert'
import { test } from 'bun:test'
import { SendTransactionParams, type SendRawTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { EthereumUnsignedTransaction } from '../../app/ts/types/wire-types.js'
import { getSafeUnsupportedFormedTransactionReason, getSafeUnsupportedRequestReason, isSafeExecutableRequestFromActiveAddress, SAFE_UNSUPPORTED_TRANSACTION_MESSAGES } from '../../app/ts/safe/safeExecutionRouting.js'

const SAFE_ADDRESS = 0x1111111111111111111111111111111111111111n
const OTHER_ADDRESS = 0x2222222222222222222222222222222222222222n
const RECIPIENT = '0x3333333333333333333333333333333333333333'

const sendTransaction = (transaction: Record<string, unknown>) => SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [{ value: '0x0', data: '0x', ...transaction }] })
const rawTransaction: SendRawTransactionParams = { method: 'eth_sendRawTransaction', params: [new Uint8Array([1])] }
const authorizationList = [{ chainId: '0x1', address: RECIPIENT, nonce: '0x0' }]

const requestCases = [
	{ description: 'a call', request: sendTransaction({ to: RECIPIENT }), expected: undefined },
	{ description: 'a raw transaction', request: rawTransaction, expected: 'raw-transaction' },
	{ description: 'an EIP-7702 typed request', request: sendTransaction({ to: RECIPIENT, type: '0x4' }), expected: 'eip-7702-authorization' },
	{ description: 'a request with an authorization list', request: sendTransaction({ to: RECIPIENT, authorizationList }), expected: 'eip-7702-authorization' },
	{ description: 'a contract creation without a recipient', request: sendTransaction({}), expected: 'contract-creation' },
	{ description: 'a contract creation with a null recipient', request: sendTransaction({ to: null }), expected: 'contract-creation' },
	{ description: 'an EIP-7702 contract creation, which is reported as EIP-7702 first', request: sendTransaction({ authorizationList }), expected: 'eip-7702-authorization' },
] as const

for (const { description, request, expected } of requestCases) {
	test(`the Gnosis Safe request-shape policy reports ${ expected ?? 'nothing' } for ${ description }`, () => {
		assert.equal(getSafeUnsupportedRequestReason(request), expected)
	})
}

const formedTransaction = (to: bigint | null): EthereumUnsignedTransaction => ({ type: '1559', from: SAFE_ADDRESS, nonce: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, gas: 21_000n, to, value: 0n, input: new Uint8Array(), chainId: 1n })

test('the Gnosis Safe formed-transaction policy rejects EIP-7702 transactions and contract creations only', () => {
	assert.equal(getSafeUnsupportedFormedTransactionReason(formedTransaction(OTHER_ADDRESS)), undefined)
	assert.equal(getSafeUnsupportedFormedTransactionReason(formedTransaction(null)), 'contract-creation')
	assert.equal(getSafeUnsupportedFormedTransactionReason({ ...formedTransaction(OTHER_ADDRESS), type: '7702', authorizationList: [] }), 'eip-7702-authorization')
})

test('every unsupported Gnosis Safe transaction reason has a message', () => {
	assert.equal(SAFE_UNSUPPORTED_TRANSACTION_MESSAGES['raw-transaction'], 'Gnosis Safe wallets do not support eth_sendRawTransaction.')
	assert.equal(SAFE_UNSUPPORTED_TRANSACTION_MESSAGES['eip-7702-authorization'], 'Gnosis Safe wallets do not support EIP-7702 authorization lists.')
	assert.equal(SAFE_UNSUPPORTED_TRANSACTION_MESSAGES['contract-creation'], 'Gnosis Safe wallets do not support contract-creation transactions.')
})

const executableCases = [
	{ description: 'a call without a sender', request: sendTransaction({ to: RECIPIENT }), expected: true },
	{ description: 'a call from the active address', request: sendTransaction({ to: RECIPIENT, from: `0x${ SAFE_ADDRESS.toString(16) }` }), expected: true },
	{ description: 'a call from another sender', request: sendTransaction({ to: RECIPIENT, from: `0x${ OTHER_ADDRESS.toString(16) }` }), expected: false },
	{ description: 'a raw transaction', request: rawTransaction, expected: false },
	{ description: 'a request with an authorization list', request: sendTransaction({ to: RECIPIENT, authorizationList }), expected: false },
	{ description: 'a contract creation', request: sendTransaction({}), expected: false },
] as const

for (const { description, request, expected } of executableCases) {
	test(`${ description } ${ expected ? 'is' : 'is not' } executable through the active Gnosis Safe`, () => {
		assert.equal(isSafeExecutableRequestFromActiveAddress(request, SAFE_ADDRESS), expected)
	})
}
