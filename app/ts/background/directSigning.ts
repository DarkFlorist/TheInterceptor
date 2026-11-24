import { getCreatedSafeProposal } from '../safe/safePendingFlow.js'
import { assertSigningWalletIdentity } from '../signing/publicAccountIdentity.js'
import { signingOperationError } from '../signing/signingOperationError.js'
import { addressString, bytes32String } from '../utils/bigint.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { refreshConfirmTransactionSimulation } from './confirmTransactionSimulation.js'
import * as funtypes from 'funtypes'
import type { DirectSigningRecord, DirectSigningRequest } from '../types/directSigning.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { SendTransactionParams } from '../types/JsonRpc-types.js'
import type { SignMessageParams } from '../types/jsonRpc-signing-types.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { createEthereumClientService } from '../simulation/serviceLifecycle.js'
import { EIP712Message } from '../types/eip721.js'
import { bytesFromHex, bytesToHex, ensureHex, keccak256 } from '../utils/ethereumBytes.js'
import { parseTransaction, serializeTransaction } from '../utils/ethereumTransactions.js'
import { DIRECT_SIGNING_CAPABILITY_ERROR, getSigningMethodError, prepareDirectPayload, verifyDirectResult } from '../signing/backend.js'
import { getSigningWalletBinding } from './signingWalletStore.js'
import { getPendingTransactionsAndMessages, updatePendingTransactionOrMessageInstance } from './storageVariables.js'
import { getRecordRequestInstance, isRecordForPendingRequest, readDirectSigningRecords, withDirectSigningRecords, type DirectSigningRecordsTransaction } from './directSigningStore.js'
import type { SigningWalletBinding } from '../types/signingWallet.js'
import { getHtmlFile } from './backgroundUtils.js'
import { getAcceptRefusal } from './reviewedResult.js'
import { getSettings } from './settings.js'
import { ERROR_SIMULATION_MODE_ENABLED_AFTER_REQUEST } from '../utils/constants.js'
import { captureSimulationModeGuard, type SimulationModeGuard } from '../utils/simulationModeGuard.js'

/** Read afresh at each lifecycle boundary; a request can disappear while a device is signing. */
async function findPendingSigningRequest(record: DirectSigningRecord) {
	return (await getPendingTransactionsAndMessages()).find((item) => isRecordForPendingRequest(record, item))
}

async function assertCurrentBinding(record: DirectSigningRecord) {
	assertSigningWalletIdentity(record.binding.wallet)
	const current = await getSigningWalletBinding(record.binding.wallet.address)
	if (current?.revision !== record.binding.revision) throw signingOperationError('Signing wallet changed. Cancel this request and review a new request with the current wallet.')
	const pending = await findPendingSigningRequest(record)
	if (pending === undefined || pending.simulationMode || pending.website.websiteOrigin !== record.websiteOrigin || pending.signingWalletBinding?.revision !== record.binding.revision) throw signingOperationError('The original signing request is no longer active')
}

// A client for the network the record was reviewed on, made by the same factory as the simulation services and pinned to the reviewed RPC URL and chain. Each operation gets its own, so its response cache never outlives the operation.
function clientFor(record: DirectSigningRecord) {
	return createEthereumClientService({ name: 'Reviewed signing network', chainId: record.input.chainId, httpsRpc: record.rpcUrl, currencyName: 'Ether', currencyTicker: 'ETH', primary: false, minimized: true }, async () => undefined, async () => undefined)
}

async function checkChain(record: DirectSigningRecord) {
	const client = clientFor(record)
	if (await client.getNetworkChainId(undefined) !== record.input.chainId) throw signingOperationError('RPC chain differs from the reviewed signing network')
	return client
}

// A message signature needs no live chain state, so only a transaction checks the reviewed network's chain, its nonce, fees and balance, and a message approval does not depend on a reachable RPC.
async function checkTransactionFreshness(record: DirectSigningRecord) {
	if (record.input.method !== 'eth_sendTransaction') return
	const rpc = await checkChain(record)
	const transaction = parseTransaction(ensureHex(record.input.data))
	const nonce = await rpc.getTransactionCount(record.binding.wallet.address, 'pending', undefined)
	if (nonce !== BigInt(transaction.nonce ?? 0)) throw signingOperationError('The account nonce changed. Cancel and review a new transaction before signing again.')
	const gasPrice = await rpc.getGasPrice(undefined)
	if (gasPrice > (transaction.maxFeePerGas ?? 0n)) throw signingOperationError('Network fees increased beyond the approved maximum. Review updated fees and obtain a new signature.')
	const balance = await rpc.getBalance(record.binding.wallet.address, 'pending', undefined)
	if (balance < (transaction.value ?? 0n) + BigInt(transaction.gas ?? 0) * (transaction.maxFeePerGas ?? 0n)) throw signingOperationError('Insufficient live-chain balance for the approved value and maximum fee')
}

async function prepareTransaction(ethereum: EthereumClientService, request: SendTransactionParams, address: bigint) {
	const tx = request.params[0]
	if (tx.from !== undefined && tx.from !== address) throw signingOperationError('Transaction sender differs from the selected signing account')
	if (tx.type !== undefined && tx.type !== '1559' || tx.authorizationList !== undefined || tx.gasPrice !== undefined) throw signingOperationError('Direct signing supports EIP-1559 transactions only')
	const [nonce, priority, gasPrice] = await Promise.all([ethereum.getTransactionCount(address, 'pending', undefined), ethereum.getMaxPriorityFeePerGas(undefined), ethereum.getGasPrice(undefined)])
	const maxPriorityFeePerGas = tx.maxPriorityFeePerGas ?? priority
	const maxFeePerGas = tx.maxFeePerGas ?? gasPrice * 2n + maxPriorityFeePerGas
	const gas = tx.gas ?? await ethereum.estimateGas({ ...tx, from: address, maxFeePerGas, maxPriorityFeePerGas }, undefined)
	if (maxPriorityFeePerGas > maxFeePerGas || gas < 21000n) throw signingOperationError('Invalid transaction gas or fees')
	return serializeTransaction({
		type: 'eip1559',
		chainId: ethereum.getChainId(),
		nonce, gas, maxFeePerGas, maxPriorityFeePerGas,
		to: tx.to === undefined || tx.to === null ? undefined : addressString(tx.to),
		value: tx.value ?? 0n,
		data: bytesToHex(tx.data ?? tx.input ?? new Uint8Array()),
		accessList: tx.accessList?.map((entry) => ({
			address: addressString(entry.address),
			storageKeys: entry.storageKeys.map(bytes32String),
		})),
	})
}

// The record store's lock is never held across network calls or tab creation: a command reads the record under the lock, does its RPC work unlocked, then commits under the lock only if the record is still the one it read (same revision and phase). A slow or unreachable RPC therefore never stalls other signing requests.
async function readRecord(id: string) {
	return await withDirectSigningRecords(async (records) => {
		const record = (await records.read()).find((item) => item.id === id)
		if (record === undefined) throw signingOperationError('Signing request not found')
		return record
	})
}

async function readRecordForRequest(request: DirectSigningRequest) {
	const record = await readRecord(request.id)
	if ('revision' in request && request.revision !== record.revision) throw signingOperationError('This approval or response belongs to an earlier review')
	return record
}

const SIGNING_REQUEST_CHANGED_MESSAGE = 'This signing request changed while it was being checked. Review its current state and try again.'

// Commits an update to a record read earlier, under the lock, only if no other command changed its revision or phase meanwhile. update runs under the lock and must not await the network; mayWrite runs synchronously right before the storage write.
async function commitIfUnchanged(expected: DirectSigningRecord, update: (current: DirectSigningRecord, records: DirectSigningRecordsTransaction) => Promise<DirectSigningRecord>, mayWrite?: () => void) {
	return await withDirectSigningRecords(async (records) => {
		const current = (await records.read()).find((item) => item.id === expected.id)
		if (current === undefined || current.revision !== expected.revision || current.phase !== expected.phase) throw signingOperationError(SIGNING_REQUEST_CHANGED_MESSAGE)
		return await records.store(await update(current, records), mayWrite)
	})
}

// Writes a refreshed explanation onto the website request; run under the record lock only by the refresh that still owns the record's review.
export type ApplyRefreshedReview = () => Promise<void>
export type RefreshDirectSigningReview = (record: DirectSigningRecord) => Promise<ApplyRefreshedReview>

// Invalidates the record's review and takes ownership of its refresh with a fresh reviewRefreshId. The explanation and the refreshed record are written together under the lock, and only while this refresh still owns the review, so a refresh overtaken by a newer invalidation writes nothing.
async function refreshOwnedReview(read: DirectSigningRecord, refreshed: DirectSigningRecord, refreshReview: RefreshDirectSigningReview) {
	const reviewRefreshId = crypto.randomUUID()
	const owned = await commitIfUnchanged(read, async (current) => ({ ...current, reviewReady: false, reviewRefreshId }))
	const applyRefreshedReview = await refreshReview({ ...refreshed, reviewRefreshId })
	return await commitIfUnchanged(owned, async (current) => {
		if (current.reviewRefreshId !== reviewRefreshId) throw signingOperationError(SIGNING_REQUEST_CHANGED_MESSAGE)
		await applyRefreshedReview()
		return { ...refreshed, reviewReady: true, reviewRefreshId: undefined }
	})
}

async function prepareDirectSigningInput(ethereum: EthereumClientService, binding: SigningWalletBinding, request: SendTransactionParams | SignMessageParams) {
	const capabilityError = getSigningMethodError(binding.wallet.type, request.method)
	if (capabilityError !== undefined) throw signingOperationError(capabilityError)
	const address = addressString(binding.wallet.address)
	let data: string
	if (request.method === 'eth_sendTransaction') data = await prepareTransaction(ethereum, request, binding.wallet.address)
	else if (request.method === 'personal_sign') {
		if (request.params[1] !== binding.wallet.address) throw signingOperationError('Message requests another signing account')
		data = request.params[0]
	} else if (request.method === 'eth_signTypedData_v4') {
		if (request.params[0] !== binding.wallet.address) throw signingOperationError('Typed data requests another signing account')
		data = funtypes.String.parse(EIP712Message.serialize(request.params[1]))
	} else throw signingOperationError(DIRECT_SIGNING_CAPABILITY_ERROR)
	const input = { method: request.method, data, address, chainId: ethereum.getChainId() }
	prepareDirectPayload(input)
	return input
}

/** The explanation window leads here; device approval always follows a second review of live-chain fields. */
export async function openDirectSigning(ethereum: EthereumClientService, prices: TokenPriceService, pending: PendingTransactionOrSignableMessage, request: SendTransactionParams | SignMessageParams) {
	if (pending.simulationMode || pending.signingWalletBinding === undefined || pending.signingWalletBinding.wallet.type === 'browser') throw signingOperationError('This request is not bound to a direct signing wallet')
	const binding = pending.signingWalletBinding
	assertSigningWalletIdentity(binding.wallet)
	if (pending.signingChainId !== ethereum.getChainId()) throw signingOperationError('Signing network changed. Return to the request’s original network before continuing.')
	const findExisting = async () => (await readDirectSigningRecords()).find((record) => isRecordForPendingRequest(record, pending))
	let record = await findExisting()
	if (record === undefined) {
		const rpcUrl = ethereum.getRpcEntry().httpsRpc
		if (rpcUrl === undefined) throw signingOperationError('Configure an RPC connection for direct signing')
		// Preparing a transaction reads fees and the nonce, so it runs before the lock is taken.
		const input = await prepareDirectSigningInput(ethereum, binding, request)
		const created: DirectSigningRecord = { id: crypto.randomUUID(), request: pending.uniqueRequestIdentifier, requestInstanceId: pending.instanceId, binding, websiteOrigin: pending.website.websiteOrigin, rpcUrl, input, revision: crypto.randomUUID(), created: Date.now(), phase: 'review' }
		record = await withDirectSigningRecords(async (records) => {
			// Another open of the same request may have created its record meanwhile; the request keeps that one.
			const existing = (await records.read()).find((item) => isRecordForPendingRequest(item, pending))
			if (existing !== undefined) return existing
			await assertCurrentBinding(created)
			return await records.store(created)
		})
	}
	if (record.phase === 'review') record = await refreshOwnedReview(record, record, async (owned) => await refreshDirectSigningReview(owned, ethereum, prices))
	await browser.tabs.create({ url: `${ browser.runtime.getURL(getHtmlFile('directSigning')) }?id=${ encodeURIComponent(record.id) }` })
	return record
}

/** Persist before every irreversible boundary; an interrupted submission can only reconcile or resend the same bytes. */
export async function updateDirectSigning(request: DirectSigningRequest, refreshReview?: RefreshDirectSigningReview) {
	switch (request.method) {
		case 'signing_approve': return await approveSigningRequest(request)
		case 'signing_editFees': return await editSigningFees(request, refreshReview)
		case 'signing_broadcast': return await broadcast(request)
		default: break
	}
	return await withDirectSigningRecords(async (records) => {
		const record = (await records.read()).find((item) => item.id === request.id)
		if (record === undefined) throw signingOperationError('Signing request not found')
		if (request.method === 'signing_get') return record
		if ('revision' in request && request.revision !== record.revision) throw signingOperationError('This approval or response belongs to an earlier review')
		if (request.method === 'signing_cancel') {
			if (record.phase === 'submitting' || record.phase === 'submitted' || record.phase === 'confirmed') throw signingOperationError('A submitted transaction cannot be cancelled here. Reconcile it by its transaction hash.')
			return await records.store({ ...record, phase: 'cancelled', revision: crypto.randomUUID() })
		}
		await assertCurrentBinding(record)
		if (request.method === 'signing_result') return await acceptSigningResult(record, request.result, records)
		throw signingOperationError('Unsupported signing operation')
	})
}

async function editSigningFees(request: Extract<DirectSigningRequest, { method: 'signing_editFees' }>, refreshReview: RefreshDirectSigningReview | undefined) {
	const record = await readRecordForRequest(request)
	await assertCurrentBinding(record)
	if (refreshReview === undefined) throw signingOperationError('Fee changes require a refreshed transaction explanation')
	// Approval is invalidated before the explanation changes, even if the refresh later fails.
	return await refreshOwnedReview(record, editTransactionFees(record, request), refreshReview)
}

function editTransactionFees(record: DirectSigningRecord, request: Extract<DirectSigningRequest, { method: 'signing_editFees' }>): DirectSigningRecord {
	if (record.phase !== 'review' && record.phase !== 'signed') throw signingOperationError('Cancel device approval before editing signed fields')
	if (record.input.method !== 'eth_sendTransaction') throw signingOperationError('Messages do not have transaction fees')
	if (request.gas < 21000n || request.maxPriorityFeePerGas > request.maxFeePerGas) throw signingOperationError('Invalid transaction gas or fees')
	const data = serializeTransaction({ ...parseTransaction(ensureHex(record.input.data)), authorizationList: undefined, nonce: request.nonce, gas: request.gas, maxFeePerGas: request.maxFeePerGas, maxPriorityFeePerGas: request.maxPriorityFeePerGas })
	return { ...record, input: { ...record.input, data }, phase: 'review', reviewReady: false, revision: crypto.randomUUID(), result: undefined, transactionHash: undefined }
}

const approvalRefusalMessages = {
	staleReview: 'The transaction explanation changed. Review the current result before approving.',
	rejectOnly: 'Interceptor could not determine this transaction’s result, so it can only be cancelled.',
	sendAnywayRequired: 'This result fails or is flagged. Tick send anyway to approve it.',
	unsimulatedGasLimit: 'The gas limit changed after the last simulation. Tick send anyway to approve it without a new simulation.',
} as const

// The explanation is refreshed after the confirmation accept, for example after a fee change, so the approval must name the refreshed result and meet its reject-only and send-anyway rules like a confirmation accept.
async function assertApprovalForReviewedResult(record: DirectSigningRecord, approval: Extract<DirectSigningRequest, { method: 'signing_approve' }>) {
	const pending = await findPendingSigningRequest(record)
	if (pending === undefined || pending.transactionOrMessageCreationStatus !== 'Simulated') throw signingOperationError('The original signing request is no longer active')
	const refusal = getAcceptRefusal(pending, approval)
	if (refusal !== undefined) throw signingOperationError(approvalRefusalMessages[refusal])
}

// Like a browser wallet forward, a direct wallet receives no request created in signing mode once the Interceptor has switched to simulation mode. The guard was captured before the settings read, and this check has no await before the caller's write, so a switch during any earlier await refuses too.
function assertSigningModeStillCurrent(simulationModeGuard: SimulationModeGuard, simulationMode: boolean) {
	if (simulationMode || !simulationModeGuard.allowsSignerForward()) throw signingOperationError(ERROR_SIMULATION_MODE_ENABLED_AFTER_REQUEST.error.message)
}

// The only grant for the signing page to send an approved request to its device: each Ledger signing command, or an AirGap request QR, including a request resumed after a reload. The page asks for it immediately before producing the device request. All asynchronous work comes first; the mode check is the last step and the reply is built without awaiting anything after it.
export async function authorizeDirectSigningDevice(request: Extract<DirectSigningRequest, { method: 'signing_authorizeDevice' }>) {
	const simulationModeGuard = captureSimulationModeGuard()
	const record = await withDirectSigningRecords(async (records) => {
		const stored = (await records.read()).find((item) => item.id === request.id)
		if (stored === undefined) throw signingOperationError('Signing request not found')
		if (request.revision !== stored.revision) throw signingOperationError('This approval or response belongs to an earlier review')
		if (stored.phase !== 'approved') throw signingOperationError('This request is no longer waiting for a signature')
		await assertCurrentBinding(stored)
		return stored
	})
	const { simulationMode } = await getSettings()
	// The grant is checked at the latest point before the page dispatches to the device; the remaining browser-to-device round trip cannot be closed across processes, and a Ledger additionally needs physical confirmation on the device.
	assertSigningModeStillCurrent(simulationModeGuard, simulationMode)
	return { ok: true as const, record }
}

async function approveSigningRequest(approval: Extract<DirectSigningRequest, { method: 'signing_approve' }>) {
	const simulationModeGuard = captureSimulationModeGuard()
	const record = await readRecordForRequest(approval)
	if (record.phase !== 'review') throw signingOperationError('Request has already been approved; resume or cancel its current signing operation')
	if (record.input.method === 'eth_sendTransaction' && record.reviewReady !== true) throw signingOperationError('Wait for the refreshed transaction explanation before approving')
	await assertCurrentBinding(record)
	// The live-chain checks run without the record lock.
	await checkTransactionFreshness(record)
	return await commitIfUnchanged(record, async (current, records) => {
		if (current.input.method === 'eth_sendTransaction' && current.reviewReady !== true) throw signingOperationError(SIGNING_REQUEST_CHANGED_MESSAGE)
		await assertCurrentBinding(current)
		await assertApprovalForReviewedResult(current, approval)
		const { simulationMode } = await getSettings()
		const pending = await getPendingTransactionsAndMessages()
		const conflictingTransaction = (await records.read()).find((candidate) => {
			if (candidate.id === current.id || candidate.input.method !== 'eth_sendTransaction') return false
			if (candidate.binding.wallet.address !== current.binding.wallet.address || candidate.input.chainId !== current.input.chainId) return false
			// An ambiguous submission retains its nonce even after the website request disappears.
			if (candidate.phase === 'submitting') return true
			return (candidate.phase === 'approved' || candidate.phase === 'signed')
				&& pending.some((request) => isRecordForPendingRequest(candidate, request))
		})
		if (current.input.method === 'eth_sendTransaction' && conflictingTransaction !== undefined) throw signingOperationError('Finish or cancel this account’s pending transaction before approving another nonce')
		assertSigningModeStillCurrent(simulationModeGuard, simulationMode)
		return { ...current, phase: 'approved' }
	}, () => {
		// The guard was captured before any await and is checked again by the store with nothing awaited before its write.
		assertSigningModeStillCurrent(simulationModeGuard, false)
	})
}

async function acceptSigningResult(record: DirectSigningRecord, result: string, records: DirectSigningRecordsTransaction) {
	if (record.phase !== 'approved') throw signingOperationError('No current approval for this signature')
	const verifiedResult = await verifyDirectResult(record.input, result)
	await assertCurrentBinding(record)
	return await records.store({ ...record, phase: 'signed', result: verifiedResult, ...(record.input.method === 'eth_sendTransaction' ? { transactionHash: keccak256(verifiedResult) } : {}) })
}

async function broadcast(request: Extract<DirectSigningRequest, { method: 'signing_broadcast' }>) {
	const record = await readRecordForRequest(request)
	if (record.input.method !== 'eth_sendTransaction' || record.result === undefined || record.transactionHash === undefined || !['signed', 'submitting', 'submitted', 'confirmed'].includes(record.phase)) throw signingOperationError('A verified signed transaction is required')
	if (record.phase === 'signed') await assertCurrentBinding(record)
	const signedTransaction = record.result
	await verifyDirectResult(record.input, signedTransaction)
	// Reconciliation and submission talk to the RPC without the record lock; each phase change commits only onto the record as read.
	const rpc = await checkChain(record)
	const hash = BigInt(record.transactionHash)
	const receipt = await rpc.getTransactionReceipt(hash, undefined)
	if (receipt !== null) {
		if (receipt.transactionHash !== hash) throw signingOperationError('RPC receipt belongs to a different transaction')
		return await commitIfUnchanged(record, async (current) => ({ ...current, phase: 'confirmed', executionSucceeded: receipt.status === 'success' }))
	}
	const known = await rpc.getTransactionByHash(hash, undefined)
	if (known !== null) {
		if (known.hash !== hash) throw signingOperationError('RPC returned a different transaction while reconciling submission')
		return await commitIfUnchanged(record, async (current) => ({ ...current, phase: 'submitted' }))
	}
	if (record.phase === 'submitted' || record.phase === 'confirmed') throw signingOperationError('Previously submitted transaction is not currently visible. Keep its hash and check the configured RPC before taking further action.')
	if (record.phase === 'signed') await checkTransactionFreshness(record)
	// Persisted before sending, so a concurrent broadcast of a signed record fails this commit instead of sending. Two retries of an already submitting record can both send, but they resend the same signed bytes, which the network accepts at most once.
	const submitting = await commitIfUnchanged(record, async (current) => ({ ...current, phase: 'submitting' }))
	const returnedHash = await rpc.sendRawTransaction(bytesFromHex(ensureHex(signedTransaction)), undefined)
	if (returnedHash !== hash) throw signingOperationError('RPC returned a different transaction hash; reconcile the signed transaction hash before proceeding')
	return await commitIfUnchanged(submitting, async (current) => ({ ...current, phase: 'submitted' }))
}

/** Simulates the existing explanation with the final nonce and fees. Returns the write of the refreshed explanation, which the caller applies under the record lock only while its refresh still owns the review. */
export async function refreshDirectSigningReview(record: DirectSigningRecord, ethereum: EthereumClientService, prices: TokenPriceService): Promise<ApplyRefreshedReview> {
	if (record.input.method !== 'eth_sendTransaction') return async () => undefined
	if (record.input.chainId !== ethereum.getChainId()) throw signingOperationError('Return to the request’s network to refresh its explanation')
	const pending = await findPendingSigningRequest(record)
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw signingOperationError('The transaction explanation is not ready')
	const final = parseTransaction(ensureHex(record.input.data))
	const transactionToSimulate = { ...pending.transactionToSimulate, transaction: { ...pending.transactionToSimulate.transaction, nonce: BigInt(final.nonce ?? 0), gas: BigInt(final.gas ?? 0), maxFeePerGas: final.maxFeePerGas ?? 0n, maxPriorityFeePerGas: final.maxPriorityFeePerGas ?? 0n } }
	const popupVisualisation = await refreshConfirmTransactionSimulation(ethereum, prices, pending.activeAddress, false, pending.uniqueRequestIdentifier, transactionToSimulate, getCreatedSafeProposal(pending.safeFlow))
	if (popupVisualisation === undefined) throw signingOperationError('The refreshed explanation was interrupted; review again')
	if (popupVisualisation.statusCode === 'failed') throw signingOperationError('Unable to refresh the transaction explanation. Retry the fee change when the RPC connection is available.')
	return async () => {
		await assertCurrentBinding(record)
		const stillPending = await updatePendingTransactionOrMessageInstance(getRecordRequestInstance(record), async (current) => {
			if (current.type !== 'Transaction' || current.transactionOrMessageCreationStatus !== 'Simulated') throw signingOperationError('The transaction changed during explanation refresh')
			return { ...current, transactionToSimulate, popupVisualisation }
		})
		if (!stillPending) throw signingOperationError('The original signing request is no longer active')
	}
}
