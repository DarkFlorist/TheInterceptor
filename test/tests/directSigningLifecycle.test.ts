import { beforeEach, afterEach, expect, spyOn, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1'
import { createBrowserMock, pendingTransaction, resetConfirmTransactionTestState, ethereum, simulator } from './confirmTransactionTestHarness.js'
import { DirectSigningRecord, DirectSigningRecords } from '../../app/ts/types/directSigning.js'
import { appendPendingTransactionOrMessage, saveAddressSigningWallet, clearPendingTransactions, getPendingTransactionsAndMessages, readDirectSigningRecords } from '../../app/ts/background/storageVariables.js'
import { updateDirectSigning, refreshDirectSigningReview } from '../../app/ts/background/directSigning.js'
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
	record = await updateDirectSigning({ method: 'signing_editFees', id: record.id, revision: record.revision, nonce: 0n, gas: 25000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 2n }, async () => undefined)
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

test('failed fee explanation preserves the old revision and permits retry', async () => {
	const old = record
	const request = { method: 'signing_editFees' as const, id: record.id, revision: record.revision, nonce: 0n, gas: 25000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 2n }
	await expect(updateDirectSigning(request, async () => { throw new Error('Explanation unavailable') })).rejects.toThrow('Explanation unavailable')
	expect((await readDirectSigningRecords())[0]).toEqual(old)
	const retried = await updateDirectSigning(request, async () => undefined)
	expect(retried.revision).not.toBe(old.revision)
})

test('returned simulation failure preserves fees and pending explanation until a successful retry', async () => {
	const simulation = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const before = await getPendingTransactionsAndMessages()
	const old = record
	const chain = spyOn(ethereum, 'getChainId').mockReturnValue(1n)
	const refresh = spyOn(simulation, 'refreshConfirmTransactionSimulation').mockResolvedValue({
		statusCode: 'failed',
		data: { ...pendingTransaction.popupVisualisation.data, error: { code: -32603, message: 'RPC unavailable', decodedErrorMessage: 'RPC unavailable' }, simulationState: { blockNumber: 0n, simulationConductedTimestamp: new Date() } },
	})
	const request = { method: 'signing_editFees' as const, id: record.id, revision: record.revision, nonce: 0n, gas: 25000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 2n }
	const refreshReview = async (edited: DirectSigningRecord) => await refreshDirectSigningReview(edited, ethereum, simulator.tokenPriceService)
	try {
		await expect(updateDirectSigning(request, refreshReview)).rejects.toThrow('Retry the fee change')
		expect((await readDirectSigningRecords())[0]).toEqual(old)
		expect(await getPendingTransactionsAndMessages()).toEqual(before)
		refresh.mockResolvedValue(pendingTransaction.popupVisualisation)
		const retried = await updateDirectSigning(request, refreshReview)
		expect(retried.revision).not.toBe(old.revision)
		expect((await getPendingTransactionsAndMessages())[0]?.directSigningReviewRevision).toBe(retried.revision)
	} finally {
		refresh.mockRestore()
		chain.mockRestore()
	}
})

test('corrupt signing history is diagnosed and preserved rather than reset', async () => {
	const { getInterceptorErrorDiagnostics, storeDirectSigningRecord } = await import('../../app/ts/background/storageVariables.js')
	const { withSilencedConsole } = await import('./consoleSilence.js')
	const corrupt = { records: 'invalid' }
	await browser.storage.local.set({ directSigningRequestsV1: corrupt })
	await withSilencedConsole(async () => {
		await expect(readDirectSigningRecords()).rejects.toThrow()
		await expect(storeDirectSigningRecord(record)).rejects.toThrow()
	})
	expect((await browser.storage.local.get('directSigningRequestsV1')).directSigningRequestsV1).toEqual(corrupt)
	expect((await getInterceptorErrorDiagnostics()).some((entry) => entry.code === 'direct_signing_records_corrupt')).toBe(true)
})

test('a transient signing-history read failure does not write or reset state', async () => {
	const failure = new Error('Storage read unavailable')
	const get = spyOn(browser.storage.local, 'get').mockRejectedValue(failure)
	const set = spyOn(browser.storage.local, 'set')
	try {
		await expect(readDirectSigningRecords()).rejects.toBe(failure)
		expect(set).not.toHaveBeenCalled()
	} finally {
		get.mockRestore()
		set.mockRestore()
	}
	expect((await readDirectSigningRecords())[0]).toEqual(record)
})
