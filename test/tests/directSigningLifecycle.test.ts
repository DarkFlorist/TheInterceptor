import { beforeEach, afterEach, expect, spyOn, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { createBrowserMock, pendingTransaction, resetConfirmTransactionTestState, ethereum, simulator, withSimulatedTransactionResult } from './confirmTransactionTestHarness.js'
import { getReviewedResultId } from '../../app/ts/background/reviewedResult.js'
import { doesUniqueRequestIdentifiersMatch } from '../../app/ts/utils/requests.js'
import { DirectSigningRecord, DirectSigningRecords } from '../../app/ts/types/directSigning.js'
import { appendPendingTransactionOrMessage, clearPendingTransactions, getPendingTransactionsAndMessages } from '../../app/ts/background/storageVariables.js'
import { saveAddressSigningWallet } from '../../app/ts/background/signingAddressBookCoordinator.js'
import { readDirectSigningRecords } from '../../app/ts/background/directSigningStore.js'
import { authorizeDirectSigningDevice, updateDirectSigning, refreshDirectSigningReview } from '../../app/ts/background/directSigning.js'
import { dispatchSigningPageRequest } from '../../app/ts/background/signingRequestService.js'
import { ERROR_SIMULATION_MODE_ENABLED_AFTER_REQUEST } from '../../app/ts/utils/constants.js'
import { createLedgerResponseDecoder, frameLedgerApdu } from '../../app/ts/signing/ledgerFraming.js'
import { bytesFromHex, bytesToHex, ensureHex, type Hex } from '../../app/ts/utils/ethereumBytes.js'
import { privateKeyToAccount } from '../../app/ts/utils/ethereumSigning.js'
import { parseTransaction, serializeTransaction } from '../../app/ts/utils/ethereumTransactions.js'
import { assembleSignedTransaction, prepareTransactionSigningPayload } from '../../app/ts/signing/exactPayload.js'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { useDirectSigning } from '../../app/ts/components/hooks/useDirectSigning.js'
import { changeSimulationMode } from '../../app/ts/background/settings.js'
import { SigningPageRequest } from '../../app/ts/types/directSigning.js'
import { SigningPageReply } from '../../app/ts/types/signingPageReply.js'
import type { LedgerHid, LedgerHidDevice } from '../../app/ts/signing/ledgerHid.js'
import { installDomMock } from './domMock.js'

const privateKey: Hex = '0x0000000000000000000000000000000000000000000000000000000000000001'
const account = privateKeyToAccount(privateKey)
const address = BigInt(account.address)
const originalFetch = globalThis.fetch
let liveNonce = '0x0'
let broadcasts = 0
let broadcastFails = false
let submittedHash: string | undefined
// Runs while the background waits for an RPC reply, so a test can change settings during that await.
let duringRpcRequest: ((method: string) => Promise<void>) | undefined
let record: DirectSigningRecord

beforeEach(async () => {
	createBrowserMock()
	await resetConfirmTransactionTestState()
	await clearPendingTransactions()
	await browser.storage.local.remove('directSigningRequestsV1')
	liveNonce = '0x0'; broadcasts = 0; broadcastFails = false; submittedHash = undefined; duringRpcRequest = undefined
	globalThis.fetch = async (_input, init) => {
		if (typeof init?.body !== 'string') throw new Error('Expected RPC JSON')
		const request = JSON.parse(init.body)
		await duringRpcRequest?.(request.method)
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
	record = { id: crypto.randomUUID(), request: pendingTransaction.uniqueRequestIdentifier, requestInstanceId: pendingTransaction.instanceId, binding, websiteOrigin: pendingTransaction.website.websiteOrigin, rpcUrl: 'https://rpc.example.test', input, revision: crypto.randomUUID(), created: Date.now(), phase: 'review', reviewReady: true }
	await appendPendingTransactionOrMessage({ ...reviewedTransaction, simulationMode: false, activeAddress: address, signingWalletBinding: binding, signingChainId: 1n })
	// The website request was made in signing mode, and the Interceptor is still in it.
	await browser.storage.local.set({ simulationMode: false, directSigningRequestsV1: DirectSigningRecords.serialize([record]) })
})
afterEach(() => { globalThis.fetch = originalFetch })

// A website request whose simulation succeeded, so approving it needs no send-anyway override.
const reviewedTransaction = withSimulatedTransactionResult(pendingTransaction)

// Approves with the reviewed-result id of the website request as it is stored now, as the signing page does with the review it last received.
async function approve(item: DirectSigningRecord, forceSend = false) {
	const pending = (await getPendingTransactionsAndMessages()).find((candidate) => doesUniqueRequestIdentifiersMatch(candidate.uniqueRequestIdentifier, item.request))
	return await updateDirectSigning({ method: 'signing_approve', id: item.id, revision: item.revision, reviewedResultId: pending === undefined ? 'missing request' : getReviewedResultId(pending), forceSend })
}

async function sign() {
	record = await approve(record)
	const payload = prepareTransactionSigningPayload(record.input.data, account.address, 1n)
	// A recovered signature is the recovery id followed by r and s; Ethereum orders them r, s, v.
	const recovered = secp256k1.sign(bytesFromHex(payload.digest), bytesFromHex(privateKey), { prehash: false, format: 'recovered' })
	const bytes = Uint8Array.from([...recovered.slice(1), (recovered[0] ?? 0) + 27])
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
	await expect(approve(record)).rejects.toThrow('wallet changed')
	expect((await updateDirectSigning({ method: 'signing_cancel', id: record.id })).phase).toBe('cancelled')
	await clearPendingTransactions()
	await expect(approve(record)).rejects.toThrow()
	expect(broadcasts).toBe(0)
})

test('switching into simulation mode after the signing page opened refuses its approval', async () => {
	await browser.storage.local.set({ simulationMode: true })
	await expect(approve(record)).rejects.toThrow('switched to simulation mode')
	expect((await readDirectSigningRecords())[0]?.phase).toBe('review')
	await browser.storage.local.set({ simulationMode: false })
	expect((await approve(record)).phase).toBe('approved')
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
	await appendPendingTransactionOrMessage({ ...reviewedTransaction, uniqueRequestIdentifier: second.request, simulationMode: false, activeAddress: address, signingWalletBinding: record.binding, signingChainId: 1n })
	await browser.storage.local.set({ directSigningRequestsV1: DirectSigningRecords.serialize([record, second]) })
	const results = await Promise.allSettled([record, second].map(async (item) => await approve(item)))
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
	await appendPendingTransactionOrMessage({ ...reviewedTransaction, uniqueRequestIdentifier: other.request, simulationMode: false, activeAddress: address, signingWalletBinding: record.binding, signingChainId: other.input.chainId })
	await browser.storage.local.set({ directSigningRequestsV1: DirectSigningRecords.serialize([record, other]) })
	const approved = await approve(record)
	expect(approved.phase).toBe('approved')
	expect(broadcasts).toBe(0)
})

test('failed fee explanation preserves the old revision and permits retry', async () => {
	const old = record
	const request = { method: 'signing_editFees' as const, id: record.id, revision: record.revision, nonce: 0n, gas: 25000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 2n }
	await expect(updateDirectSigning(request, async () => { throw new Error('Explanation unavailable') })).rejects.toThrow('Explanation unavailable')
	expect((await readDirectSigningRecords())[0]).toEqual({ ...old, reviewReady: false })
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
		expect((await readDirectSigningRecords())[0]).toEqual({ ...old, reviewReady: false })
		expect(await getPendingTransactionsAndMessages()).toEqual(before)
		refresh.mockResolvedValue(pendingTransaction.popupVisualisation)
		const retried = await updateDirectSigning(request, refreshReview)
		expect(retried.revision).not.toBe(old.revision)
		expect((await readDirectSigningRecords())[0]?.reviewReady).toBe(true)
	} finally {
		refresh.mockRestore()
		chain.mockRestore()
	}
})

test('corrupt signing history is diagnosed and preserved rather than reset', async () => {
	const { getInterceptorErrorDiagnostics } = await import('../../app/ts/background/storageVariables.js')
	const { storeDirectSigningRecord } = await import('../../app/ts/background/directSigningStore.js')
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

test('storage serializes standalone writes and lifecycle transactions without losing submitting records', async () => {
	const { storeDirectSigningRecord, withDirectSigningRecords } = await import('../../app/ts/background/directSigningStore.js')
	const first = { ...record, id: 'first', phase: 'submitting' as const }
	const second = { ...record, id: 'second', phase: 'submitting' as const }
	await Promise.all([storeDirectSigningRecord(first), storeDirectSigningRecord(second)])
	expect((await readDirectSigningRecords()).map((item) => item.id)).toContain('first')
	expect((await readDirectSigningRecords()).map((item) => item.id)).toContain('second')
	let release: () => void = () => undefined
	let entered: () => void = () => undefined
	const gate = new Promise<void>((resolve) => { release = resolve })
	const ready = new Promise<void>((resolve) => { entered = resolve })
	const transaction = withDirectSigningRecords(async (records) => {
		entered()
		await gate
		await records.store({ ...first, phase: 'confirmed' })
	})
	await ready
	let stored = false
	const standalone = storeDirectSigningRecord({ ...second, phase: 'confirmed' }).then(() => { stored = true })
	await Promise.resolve()
	expect(stored).toBe(false)
	release()
	await Promise.all([transaction, standalone])
	const saved = await readDirectSigningRecords()
	expect(saved.find((item) => item.id === 'first')?.phase).toBe('confirmed')
	expect(saved.find((item) => item.id === 'second')?.phase).toBe('confirmed')
})

test('concurrent storage writes enforce the aggregate limit and preserve ambiguous submissions', async () => {
	const { storeDirectSigningRecord } = await import('../../app/ts/background/directSigningStore.js')
	await browser.storage.local.remove('directSigningRequestsV1')
	const results = await Promise.allSettled(Array.from({ length: 17 }, (_, index) => storeDirectSigningRecord({ ...record, id: String(index), phase: 'submitting' })))
	expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(16)
	expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
	expect(await readDirectSigningRecords()).toHaveLength(16)
})

test('missing authoritative review readiness blocks approval even for legacy pending explanations', async () => {
	await browser.storage.local.set({ directSigningRequestsV1: DirectSigningRecords.serialize([{ ...record, reviewReady: undefined }]) })
	await expect(approve(record)).rejects.toThrow('refreshed transaction explanation')
})

test('a failed review refresh invalidates approval without changing the payload revision', async () => {
	await expect(updateDirectSigning({ method: 'signing_editFees', id: record.id, revision: record.revision, nonce: 0n, gas: 25000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 2n }, async () => { throw new Error('Refresh interrupted') })).rejects.toThrow('Refresh interrupted')
	await expect(approve(record)).rejects.toThrow('refreshed transaction explanation')
})

const reverted = { transactionStatus: 'Transaction Failed' as const, error: { code: -32000, message: 'execution reverted', decodedErrorMessage: 'execution reverted' } }

// Stands in for refreshDirectSigningReview: the fee change stores a refreshed simulation result on the website request.
const storeRefreshedResult = (refreshed: (pending: typeof reviewedTransaction) => typeof reviewedTransaction) => async () => {
	const { updatePendingTransactionOrMessageInstance } = await import('../../app/ts/background/storageVariables.js')
	await updatePendingTransactionOrMessageInstance({ uniqueRequestIdentifier: record.request, instanceId: record.requestInstanceId }, async (pending) => pending.type === 'Transaction' && pending.transactionOrMessageCreationStatus === 'Simulated' ? { ...pending, popupVisualisation: refreshed(reviewedTransaction).popupVisualisation } : pending)
}

test('a refresh that makes the transaction revert blocks approval until the refreshed result is approved with send anyway', async () => {
	const [pendingBeforeRefresh] = await getPendingTransactionsAndMessages()
	if (pendingBeforeRefresh === undefined) throw new Error('Expected the website request')
	const reviewedBeforeRefresh = getReviewedResultId(pendingBeforeRefresh)
	record = await updateDirectSigning({ method: 'signing_editFees', id: record.id, revision: record.revision, nonce: 0n, gas: 25000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 2n }, storeRefreshedResult((pending) => withSimulatedTransactionResult(pending, reverted)))
	await expect(updateDirectSigning({ method: 'signing_approve', id: record.id, revision: record.revision, reviewedResultId: reviewedBeforeRefresh, forceSend: true })).rejects.toThrow('explanation changed')
	await expect(approve(record)).rejects.toThrow('send anyway')
	expect((await readDirectSigningRecords())[0]?.phase).toBe('review')
	expect((await approve(record, true)).phase).toBe('approved')
})

test('a refresh that leaves the transaction without a reviewable result blocks approval even with send anyway', async () => {
	record = await updateDirectSigning({ method: 'signing_editFees', id: record.id, revision: record.revision, nonce: 0n, gas: 25000n, maxFeePerGas: 20n, maxPriorityFeePerGas: 2n }, storeRefreshedResult((pending) => ({ ...pending, popupVisualisation: { ...pending.popupVisualisation, data: { ...pending.popupVisualisation.data, visualizedSimulationState: { success: true as const, visualizedBlocks: [] } } } })))
	await expect(approve(record, true)).rejects.toThrow('only be cancelled')
	expect((await readDirectSigningRecords())[0]?.phase).toBe('review')
})

for (const rpcMethod of ['eth_chainId', 'eth_getTransactionCount', 'eth_getBalance']) test(`switching into simulation mode during approval's ${ rpcMethod } freshness check refuses the approval`, async () => {
	duringRpcRequest = async (method) => {
		if (method !== rpcMethod) return
		duringRpcRequest = undefined
		await changeSimulationMode({ simulationMode: true })
	}
	await expect(approve(record)).rejects.toThrow('switched to simulation mode')
	expect((await readDirectSigningRecords())[0]?.phase).toBe('review')
})

test('an approved request cannot be authorized for its device after switching into simulation mode', async () => {
	record = await approve(record)
	await changeSimulationMode({ simulationMode: true })
	await expect(authorizeDirectSigningDevice({ method: 'signing_authorizeDevice', id: record.id, revision: record.revision })).rejects.toThrow('switched to simulation mode')
	await changeSimulationMode({ simulationMode: false })
	expect((await authorizeDirectSigningDevice({ method: 'signing_authorizeDevice', id: record.id, revision: record.revision })).record.phase).toBe('approved')
})

// Runs onRead after each storage read while armed, before the read's result is returned to the background.
function interceptStorageReads(onRead: () => Promise<void>) {
	const originalGet = browser.storage.local.get
	browser.storage.local.get = async (keys?: Parameters<typeof originalGet>[0]) => {
		const items = await originalGet(keys)
		await onRead()
		return items
	}
	return () => { browser.storage.local.get = originalGet }
}

test('switching into simulation mode during any await of a device authorization refuses the grant', async () => {
	record = await approve(record)
	const authorize = async () => await dispatchSigningPageRequest({ method: 'signing_authorizeDevice', id: record.id, revision: record.revision }, simulator, new Map())
	let readsDuringAuthorization = 0
	const stopCounting = interceptStorageReads(async () => { readsDuringAuthorization++ })
	try {
		expect((await authorize()).ok).toBe(true)
	} finally { stopCounting() }
	expect(readsDuringAuthorization).toBeGreaterThan(0)
	for (let switchAtRead = 0; switchAtRead < readsDuringAuthorization; switchAtRead++) {
		await changeSimulationMode({ simulationMode: false })
		let reads = 0
		const stopSwitching = interceptStorageReads(async () => {
			if (reads++ === switchAtRead) await changeSimulationMode({ simulationMode: true })
		})
		try {
			expect(await authorize()).toEqual({ ok: false, message: ERROR_SIMULATION_MODE_ENABLED_AFTER_REQUEST.error.message })
		} finally { stopSwitching() }
	}
})

// Answers the signing page's messages with the background signing-page dispatcher, as the extension's signing-page listener does.
function answerSigningPageWithBackground() {
	browser.runtime.sendMessage = async (message: unknown) => SigningPageReply.serialize(await dispatchSigningPageRequest(SigningPageRequest.parse(message), simulator, new Map()))
}

const LEDGER_SIGN_TRANSACTION = 4
// A Ledger holding the test account that records the instruction of every command it receives. beforeReply can hold a reply back; signing commands are declined so a test that wrongly reaches one ends at once.
function installLedger(beforeReply: (instruction: number) => Promise<void> = async () => undefined) {
	const instructions: number[] = []
	const publicKey = secp256k1.getPublicKey(bytesFromHex(privateKey), false)
	const accountResponse = Uint8Array.from([65, ...publicKey, 40, ...new TextEncoder().encode(account.address.slice(2)), 0x90, 0])
	const decoders = new Map<number, ReturnType<typeof createLedgerResponseDecoder>>()
	const device: LedgerHidDevice = Object.assign(new EventTarget(), {
		vendorId: 0x2c97, productId: 1, productName: 'Test Ledger', opened: false, collections: [{ usagePage: 0xffa0 }],
		open: async () => undefined, close: async () => undefined,
		sendReport: async (_reportId: number, data: Uint8Array<ArrayBuffer>) => {
			const channel = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(0)
			const decode = decoders.get(channel) ?? createLedgerResponseDecoder(channel)
			decoders.set(channel, decode)
			const apdu = decode(data)
			if (apdu === undefined) return
			decoders.delete(channel)
			const instruction = apdu[1] ?? -1
			instructions.push(instruction)
			const response = instruction === 6 ? Uint8Array.of(0, 1, 9, 19, 0x90, 0) : instruction === 2 ? accountResponse : Uint8Array.of(0x69, 0x85)
			void (async () => {
				await beforeReply(instruction)
				for (const packet of frameLedgerApdu(channel, response)) device.dispatchEvent(Object.assign(new Event('inputreport'), { reportId: 0, data: new DataView(packet.slice().buffer) }))
			})()
		},
	})
	const hid: LedgerHid = Object.assign(new EventTarget(), { requestDevice: async () => [device], getDevices: async () => [device] })
	const locks = { request: async <T>(_name: string, _options: unknown, callback: () => Promise<T>) => await callback() }
	Object.defineProperty(navigator, 'hid', { value: hid, configurable: true })
	Object.defineProperty(navigator, 'locks', { value: locks, configurable: true })
	return { instructions, restore: () => { Reflect.deleteProperty(navigator, 'hid'); Reflect.deleteProperty(navigator, 'locks') } }
}

async function approveForWallet(walletType: 'ledger' | 'airgap') {
	if (walletType === 'airgap') {
		const airgap = await saveAddressSigningWallet(address, { type: 'airgap', label: 'Vault', address, publicKey: bytesToHex(secp256k1.getPublicKey(bytesFromHex(privateKey), true)), derivationPath: 'm/44\'/60\'/0\'/0/0', sourceFingerprint: 0x11223344 }, record.binding.revision, 'Savings')
		if (airgap === undefined) throw new Error('Missing AirGap binding')
		record = { ...record, binding: airgap }
		// Changing the address's signing wallet ends requests made for the previous one, so the website request is made again for the AirGap wallet.
		await clearPendingTransactions()
		await appendPendingTransactionOrMessage({ ...reviewedTransaction, simulationMode: false, activeAddress: address, signingWalletBinding: airgap, signingChainId: 1n })
		await browser.storage.local.set({ directSigningRequestsV1: DirectSigningRecords.serialize([record]) })
	}
	record = await approve(record)
	expect(record.phase).toBe('approved')
}

// Opens the signing page for the record, as a reload does, and runs the test against the recovered approval.
async function withReloadedSigningPage(run: (page: () => ReturnType<typeof useDirectSigning>) => Promise<void>) {
	answerSigningPageWithBackground()
	Object.defineProperty(globalThis, 'location', { value: { origin: '', search: `?id=${ encodeURIComponent(record.id) }` }, configurable: true, writable: true })
	const dom = installDomMock()
	let rendered: ReturnType<typeof useDirectSigning> | undefined
	const SigningPageProbe = () => { rendered = useDirectSigning(); return null }
	const page = () => {
		if (rendered === undefined) throw new Error('Expected the signing page to render')
		return rendered
	}
	try {
		await act(() => { render(h(SigningPageProbe, null), dom.document.body) })
		for (let attempt = 0; attempt < 100 && rendered?.record === undefined; attempt++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))
		if (page().record?.phase !== 'approved') throw new Error('Expected the reloaded page to recover the approval')
		await run(page)
	} finally {
		render(null, dom.document.body)
		dom.restore()
	}
}

async function resume(page: () => ReturnType<typeof useDirectSigning>) {
	const sign = page().sign
	await act(async () => await sign())
}

for (const walletType of ['ledger', 'airgap'] as const) test(`resuming a ${ walletType === 'ledger' ? 'Ledger' : 'AirGap' } approval after a reload and a switch into simulation mode produces no device request`, async () => {
	await approveForWallet(walletType)
	const ledger = installLedger()
	try {
		await withReloadedSigningPage(async (page) => {
			await changeSimulationMode({ simulationMode: true })
			await resume(page)
			expect(page().error).toContain('switched to simulation mode')
			expect(page().qr).toBeUndefined()
			expect(ledger.instructions).not.toContain(LEDGER_SIGN_TRANSACTION)
		})
	} finally { ledger.restore() }
	expect((await readDirectSigningRecords())[0]?.phase).toBe('approved')
})

for (const [instruction, read] of [[6, 'app configuration'], [2, 'account']] as const) test(`switching into simulation mode during the Ledger ${ read } read sends no signing command`, async () => {
	await approveForWallet('ledger')
	const ledger = installLedger(async (replyingTo) => {
		if (replyingTo === instruction) await changeSimulationMode({ simulationMode: true })
	})
	try {
		await withReloadedSigningPage(async (page) => {
			await resume(page)
			expect(ledger.instructions).toContain(instruction)
			expect(ledger.instructions).not.toContain(LEDGER_SIGN_TRANSACTION)
			expect(page().error).toContain('switched to simulation mode')
		})
	} finally { ledger.restore() }
})

// A page can send a new request under the id of one a signing record was made for; the record keeps to its own request instance.
test('a signing record neither approves nor cancels a newer request the page sent under the same request id', async () => {
	await clearPendingTransactions()
	const replacement = { ...reviewedTransaction, instanceId: 'replacement request', simulationMode: false, activeAddress: address, signingWalletBinding: record.binding, signingChainId: 1n }
	await appendPendingTransactionOrMessage(replacement)
	await expect(approve(record)).rejects.toThrow('no longer active')
	const cancelled = await dispatchSigningPageRequest({ method: 'signing_cancel', id: record.id }, simulator, new Map())
	expect(cancelled.ok).toBe(true)
	expect((await getPendingTransactionsAndMessages()).map((pending) => pending.instanceId)).toEqual(['replacement request'])
})
