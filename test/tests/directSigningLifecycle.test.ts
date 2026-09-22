import { beforeEach, afterEach, expect, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1'
import { createBrowserMock, pendingTransaction, resetConfirmTransactionTestState } from './confirmTransactionTestHarness.js'
import { DirectSigningRecord, DirectSigningRecords } from '../../app/ts/types/directSigning.js'
import { appendPendingTransactionOrMessage, saveAddressSigningWallet, clearPendingTransactions } from '../../app/ts/background/storageVariables.js'
import { readDirectSigningRecords, updateDirectSigning } from '../../app/ts/background/directSigning.js'
import { bytesFromHex, bytesToHex, ensureHex, type Hex } from '../../app/ts/utils/ethereumBytes.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumSigning.js'
import { parseTransaction, serializeTransaction } from '../../app/ts/utils/ethereumTransactions.js'
import { assembleSignedTransaction, prepareTransactionSigningPayload } from '../../app/ts/signing/exactPayload.js'

const privateKey: Hex = '0x0000000000000000000000000000000000000000000000000000000000000001'
const account = privateKeyToAccount(privateKey)
const address = BigInt(account.address)
const originalFetch = globalThis.fetch
let liveNonce = '0x0'
let broadcasts = 0
let broadcastFails = false
let submittedHash: string | undefined
let record: DirectSigningRecord

beforeEach(async () => {
	createBrowserMock()
	await resetConfirmTransactionTestState()
	await clearPendingTransactions()
	await browser.storage.local.remove('directSigningRequestsV1')
	liveNonce = '0x0'; broadcasts = 0; broadcastFails = false; submittedHash = undefined
	globalThis.fetch = async (_input, init) => {
		if (typeof init?.body !== 'string') throw new Error('Expected RPC JSON')
		const request = JSON.parse(init.body)
		let result: unknown
		switch (request.method) {
			case 'eth_chainId': result = '0x1'; break
			case 'eth_getTransactionCount': result = liveNonce; break
			case 'eth_gasPrice': result = '0x1'; break
			case 'eth_getBalance': result = '0xffffffffffffffff'; break
			case 'eth_getTransactionReceipt': result = null; break
			case 'eth_getTransactionByHash': result = submittedHash === undefined ? null : { hash: submittedHash }; break
			case 'eth_sendRawTransaction':
				broadcasts += 1
				if (broadcastFails) throw new TypeError('Network request failed after submission')
				result = record.transactionHash
				break
			default: throw new Error(`Unexpected RPC ${ request.method }`)
		}
		return Response.json({ jsonrpc: '2.0', id: request.id, result })
	}
	const binding = await saveAddressSigningWallet(address, { type: 'ledger', label: 'Main Ledger', address, publicKey: bytesToHex(secp256k1.getPublicKey(bytesFromHex(privateKey), false)), derivationPath: 'm/44\'/60\'/0\'/0/0' }, undefined, 'Savings')
	if (binding === undefined) throw new Error('Missing binding')
	const input = { method: 'eth_sendTransaction' as const, address: account.address, chainId: 1n, data: serializeTransaction({ type: 'eip1559', chainId: 1n, nonce: 0n, gas: 21000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, to: account.address, value: 0n }) }
	record = { id: crypto.randomUUID(), request: pendingTransaction.uniqueRequestIdentifier, binding, websiteOrigin: pendingTransaction.website.websiteOrigin, rpcUrl: 'https://rpc.example.test', input, revision: crypto.randomUUID(), created: Date.now(), phase: 'review' }
	await appendPendingTransactionOrMessage({ ...pendingTransaction, simulationMode: false, activeAddress: address, signingWalletBinding: binding, signingChainId: 1n, directSigningReviewRevision: record.revision })
	await browser.storage.local.set({ directSigningRequestsV1: DirectSigningRecords.serialize([record]) })
})
afterEach(() => { globalThis.fetch = originalFetch })

async function sign() {
	record = await updateDirectSigning({ method: 'signing_approve', id: record.id, revision: record.revision })
	const payload = prepareTransactionSigningPayload(record.input.data, account.address, 1n)
	const signature = secp256k1.sign(bytesFromHex(payload.digest), bytesFromHex(privateKey))
	const bytes = new Uint8Array(65)
	bytes.set(signature.toCompactRawBytes()); bytes[64] = signature.recovery + 27
	const result = await assembleSignedTransaction(payload, bytesToHex(bytes))
	record = await updateDirectSigning({ method: 'signing_result', id: record.id, revision: record.revision, result })
	return record
}

test('approval and verified signature persist separately and never broadcast implicitly', async () => {
	await sign()
	expect(record.phase).toBe('signed')
	expect(broadcasts).toBe(0)
	expect(DirectSigningRecord.parse(DirectSigningRecord.serialize(record))).toEqual(record)
	expect((await readDirectSigningRecords())[0]).toEqual(record)
	const submitted = await updateDirectSigning({ method: 'signing_broadcast', id: record.id, revision: record.revision })
	expect(submitted.phase).toBe('submitted')
	expect(broadcasts).toBe(1)
})

test('editing fees invalidates the signed response and requires fresh review', async () => {
	await sign()
	const old = record
	record = await updateDirectSigning({ method: 'signing_editFees', id: record.id, revision: record.revision, nonce: 0n, gas: 25000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 2n })
	expect(record.phase).toBe('review')
	expect(record.result).toBeUndefined()
	expect(record.revision).not.toBe(old.revision)
	await expect(updateDirectSigning({ method: 'signing_result', id: record.id, revision: old.revision, result: old.result ?? '' })).rejects.toThrow('earlier review')
})

test('rejects changed wallets, cancellation, and a disappeared originating request', async () => {
	await saveAddressSigningWallet(address, { ...record.binding.wallet, label: 'Changed' }, record.binding.revision)
	await expect(updateDirectSigning({ method: 'signing_approve', id: record.id, revision: record.revision })).rejects.toThrow('wallet changed')
	expect((await updateDirectSigning({ method: 'signing_cancel', id: record.id })).phase).toBe('cancelled')
	await clearPendingTransactions()
	await expect(updateDirectSigning({ method: 'signing_approve', id: record.id, revision: record.revision })).rejects.toThrow()
	expect(broadcasts).toBe(0)
})

test('delayed offline transactions recheck the live nonce before submission', async () => {
	await sign(); liveNonce = '0x1'
	await expect(updateDirectSigning({ method: 'signing_broadcast', id: record.id, revision: record.revision })).rejects.toThrow('nonce changed')
	expect(broadcasts).toBe(0)
})

test('ambiguous submission survives a reload and reconciles its exact hash without signing again', async () => {
	await sign(); broadcastFails = true
	await expect(updateDirectSigning({ method: 'signing_broadcast', id: record.id, revision: record.revision })).rejects.toThrow()
	const recovered = (await readDirectSigningRecords())[0]
	expect(recovered?.phase).toBe('submitting')
	expect(recovered?.result).toBe(record.result)
	submittedHash = record.transactionHash
	const reconciled = await updateDirectSigning({ method: 'signing_broadcast', id: record.id, revision: record.revision })
	expect(reconciled.phase).toBe('submitted')
	expect(broadcasts).toBe(1)
})

test('concurrent approvals for the same account reserve one transaction at a time', async () => {
	const second = { ...record, id: crypto.randomUUID(), request: { ...record.request, requestId: 99 }, revision: crypto.randomUUID() }
	await appendPendingTransactionOrMessage({ ...pendingTransaction, uniqueRequestIdentifier: second.request, simulationMode: false, activeAddress: address, signingWalletBinding: record.binding, signingChainId: 1n, directSigningReviewRevision: second.revision })
	await browser.storage.local.set({ directSigningRequestsV1: DirectSigningRecords.serialize([record, second]) })
	const results = await Promise.allSettled([record, second].map((item) => updateDirectSigning({ method: 'signing_approve', id: item.id, revision: item.revision })))
	expect(results.map((item) => item.status)).toEqual(['fulfilled', 'rejected'])
	expect(broadcasts).toBe(0)
})

for (const unrelatedChain of [false, true]) test(`nonce reservation ignores ${ unrelatedChain ? 'another chain' : 'a cancelled request' }`, async () => {
	const chainId = unrelatedChain ? 2n : record.input.chainId
	const other: DirectSigningRecord = {
		...record,
		id: crypto.randomUUID(),
		request: { ...record.request, requestId: 99 },
		revision: crypto.randomUUID(),
		input: { ...record.input, chainId, data: serializeTransaction({ ...parseTransaction(ensureHex(record.input.data)), chainId }) },
		phase: unrelatedChain ? 'approved' : 'cancelled',
	}
	await appendPendingTransactionOrMessage({ ...pendingTransaction, uniqueRequestIdentifier: other.request, simulationMode: false, activeAddress: address, signingWalletBinding: record.binding, signingChainId: other.input.chainId })
	await browser.storage.local.set({ directSigningRequestsV1: DirectSigningRecords.serialize([record, other]) })
	const approved = await updateDirectSigning({ method: 'signing_approve', id: record.id, revision: record.revision })
	expect(approved.phase).toBe('approved')
	expect(broadcasts).toBe(0)
})
