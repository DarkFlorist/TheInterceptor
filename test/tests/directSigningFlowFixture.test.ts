import * as assert from 'node:assert'
import { test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { createDirectSigningFlowPendingRequest } from '../benchmarks/directSigningFlowPendingRequest.js'
import { getPendingRequestReview } from '../../app/ts/background/reviewedResult.js'
import type { DirectSigningRecord } from '../../app/ts/types/directSigning.js'
import { bytesFromHex, bytesToHex } from '../../app/ts/utils/ethereumBytes.js'
import { serializeTransaction } from '../../app/ts/utils/ethereumTransactions.js'

const address = 0x7e5f4552091a69125d5dfcb7b8c2659029395bdfn
const publicKey = bytesToHex(secp256k1.getPublicKey(bytesFromHex('0x0000000000000000000000000000000000000000000000000000000000000001'), false))
const data = serializeTransaction({ type: 'eip1559', chainId: 1n, nonce: 0n, gas: 21000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n, to: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', value: 1000000000000000n })
const record: DirectSigningRecord = { id: 'walkthrough', request: { requestId: 1, requestSocket: { tabId: 98765, connectionName: 0n } }, requestInstanceId: 'walkthrough', binding: { revision: crypto.randomUUID(), wallet: { type: 'ledger', address, label: 'Walkthrough public test account', publicKey, derivationPath: 'm/44\'/60\'/0\'/0/0' } }, websiteOrigin: 'https://walkthrough.example.test', rpcUrl: 'http://127.0.0.1:1', input: { method: 'eth_sendTransaction', data, address: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf', chainId: 1n }, revision: crypto.randomUUID(), created: 1, phase: 'review', reviewReady: true }

// The Chrome walkthrough clicks the signing page's approval, which a reject-only or send-anyway result would disable.
test('the direct-signing walkthrough seeds a transaction its signing page can approve', () => {
	const review = getPendingRequestReview(createDirectSigningFlowPendingRequest(record))
	assert.equal(review.rejectOnly, false)
	assert.equal(review.sendAnywayReason, undefined)
})
