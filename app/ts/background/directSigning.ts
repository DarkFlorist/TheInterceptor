import { addressString, bytes32String } from '../utils/bigint.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { refreshConfirmTransactionSimulation } from './confirmTransactionSimulation.js'
import * as funtypes from 'funtypes'
import { type DirectSigningRecord, DirectSigningRecords, type DirectSigningRequest } from '../types/directSigning.js'
import type { PendingTransactionOrSignableMessage } from '../types/accessRequest.js'
import type { SendTransactionParams } from '../types/JsonRpc-types.js'
import type { SignMessageParams } from '../types/jsonRpc-signing-types.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { EthereumJSONRpcRequestHandler } from '../simulation/services/EthereumJSONRpcRequestHandler.js'
import { EthereumBytes32, EthereumQuantity } from '../types/wire-types.js'
import { EIP712Message } from '../types/eip721.js'
import { bytesFromHex, bytesToHex, ensureHex, keccak256 } from '../utils/ethereumBytes.js'
import { parseTransaction, serializeTransaction } from '../utils/ethereumTransactions.js'
import { DIRECT_SIGNING_CAPABILITY_ERROR, getSigningMethodError, prepareDirectPayload, verifyDirectResult } from '../signing/backend.js'
import { Semaphore } from '../utils/semaphore.js'
import { doesUniqueRequestIdentifiersMatch } from '../utils/requests.js'
import { getSigningWalletBinding, getPendingTransactionsAndMessages, updatePendingTransactionOrMessage } from './storageVariables.js'
import { getHtmlFile } from './backgroundUtils.js'

const signingStateLock = new Semaphore(1)
const storageKey = 'directSigningRequestsV1'

export async function readDirectSigningRecords() {
	const stored: unknown = (await browser.storage.local.get(storageKey))[storageKey]
	return stored === undefined ? [] : DirectSigningRecords.parse(stored)
}

async function storeRecord(record: DirectSigningRecord) {
	const records = await readDirectSigningRecords()
	const pending = await getPendingTransactionsAndMessages()
	const retained = records.filter((item) => item.id !== record.id && (item.phase === 'submitting' || pending.some((request) => doesUniqueRequestIdentifiersMatch(request.uniqueRequestIdentifier, item.request))))
	const history = records.filter((item) => item.id !== record.id && !retained.includes(item) && ['submitted', 'confirmed', 'cancelled'].includes(item.phase)).slice(-4)
	const next = [...history, ...retained, record]
	const serialized = DirectSigningRecords.serialize(next)
	if (next.length > 16 || new TextEncoder().encode(JSON.stringify(serialized)).length > 4 * 1024 * 1024) throw new Error('Too many saved signing requests. Finish or cancel pending signing requests before continuing.')
	await browser.storage.local.set({ [storageKey]: serialized })
	return record
}

/** Read afresh at each lifecycle boundary; a request can disappear while a device is signing. */
async function findPendingSigningRequest(record: DirectSigningRecord) {
	return (await getPendingTransactionsAndMessages()).find((item) => doesUniqueRequestIdentifiersMatch(item.uniqueRequestIdentifier, record.request))
}

async function assertCurrentBinding(record: DirectSigningRecord) {
	const current = await getSigningWalletBinding(record.binding.wallet.address)
	if (current?.revision !== record.binding.revision) throw new Error('Signing wallet changed. Cancel this request and review a new request with the current wallet.')
	const pending = await findPendingSigningRequest(record)
	if (pending === undefined || pending.simulationMode || pending.website.websiteOrigin !== record.websiteOrigin || pending.signingWalletBinding?.revision !== record.binding.revision) throw new Error('The original signing request is no longer active')
}

function rpcFor(record: DirectSigningRecord) { return new EthereumJSONRpcRequestHandler(record.rpcUrl, false) }

async function checkChain(record: DirectSigningRecord) {
	const rpc = rpcFor(record)
	const chainId = EthereumQuantity.parse(await rpc.jsonRpcRequest({ method: 'eth_chainId' }))
	if (chainId !== record.input.chainId) throw new Error('RPC chain differs from the reviewed signing network')
	return rpc
}

async function checkTransactionFreshness(record: DirectSigningRecord) {
	const rpc = await checkChain(record)
	if (record.input.method !== 'eth_sendTransaction') return
	const transaction = parseTransaction(ensureHex(record.input.data))
	const nonce = EthereumQuantity.parse(await rpc.jsonRpcRequest({ method: 'eth_getTransactionCount', params: [record.binding.wallet.address, 'pending'] }))
	if (nonce !== BigInt(transaction.nonce ?? 0)) throw new Error('The account nonce changed. Cancel and review a new transaction before signing again.')
	const gasPrice = EthereumQuantity.parse(await rpc.jsonRpcRequest({ method: 'eth_gasPrice' }))
	if (gasPrice > (transaction.maxFeePerGas ?? 0n)) throw new Error('Network fees increased beyond the approved maximum. Review updated fees and obtain a new signature.')
	const balance = EthereumQuantity.parse(await rpc.jsonRpcRequest({ method: 'eth_getBalance', params: [record.binding.wallet.address, 'pending'] }))
	if (balance < (transaction.value ?? 0n) + BigInt(transaction.gas ?? 0) * (transaction.maxFeePerGas ?? 0n)) throw new Error('Insufficient live-chain balance for the approved value and maximum fee')
}

async function prepareTransaction(ethereum: EthereumClientService, request: SendTransactionParams, address: bigint) {
	const tx = request.params[0]
	if (tx.from !== undefined && tx.from !== address) throw new Error('Transaction sender differs from the selected signing account')
	if (tx.type !== undefined && tx.type !== '1559' || tx.authorizationList !== undefined || tx.gasPrice !== undefined) throw new Error('Direct signing supports EIP-1559 transactions only')
	const [nonce, priority, gasPrice] = await Promise.all([ethereum.getTransactionCount(address, 'pending', undefined), ethereum.getMaxPriorityFeePerGas(undefined), ethereum.getGasPrice(undefined)])
	const maxPriorityFeePerGas = tx.maxPriorityFeePerGas ?? priority
	const maxFeePerGas = tx.maxFeePerGas ?? gasPrice * 2n + maxPriorityFeePerGas
	const gas = tx.gas ?? await ethereum.estimateGas({ ...tx, from: address, maxFeePerGas, maxPriorityFeePerGas }, undefined)
	if (maxPriorityFeePerGas > maxFeePerGas || gas < 21000n) throw new Error('Invalid transaction gas or fees')
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

/** The explanation window leads here; device approval always follows a second review of live-chain fields. */
export async function openDirectSigning(ethereum: EthereumClientService, prices: TokenPriceService, pending: PendingTransactionOrSignableMessage, request: SendTransactionParams | SignMessageParams) {
	return await signingStateLock.execute(async () => {
		if (pending.simulationMode || pending.signingWalletBinding === undefined || pending.signingWalletBinding.wallet.type === 'browser') throw new Error('This request is not bound to a direct signing wallet')
		if (pending.signingChainId !== ethereum.getChainId()) throw new Error('Signing network changed. Return to the request’s original network before continuing.')
		const existing = (await readDirectSigningRecords()).find((record) => doesUniqueRequestIdentifiersMatch(record.request, pending.uniqueRequestIdentifier))
		let record = existing
		if (record === undefined) {
			const binding = pending.signingWalletBinding
			const capabilityError = getSigningMethodError(binding.wallet.type, request.method)
			if (capabilityError !== undefined) throw new Error(capabilityError)
			const rpcUrl = ethereum.getRpcEntry().httpsRpc
			if (rpcUrl === undefined) throw new Error('Configure an RPC connection for direct signing')
			const address = addressString(binding.wallet.address)
			let data: string
			if (request.method === 'eth_sendTransaction') data = await prepareTransaction(ethereum, request, binding.wallet.address)
			else if (request.method === 'personal_sign') {
				if (request.params[1] !== binding.wallet.address) throw new Error('Message requests another signing account')
				data = request.params[0]
			} else if (request.method === 'eth_signTypedData_v4') {
				if (request.params[0] !== binding.wallet.address) throw new Error('Typed data requests another signing account')
				data = funtypes.String.parse(EIP712Message.serialize(request.params[1]))
			} else throw new Error(DIRECT_SIGNING_CAPABILITY_ERROR)
			const input = { method: request.method, data, address, chainId: ethereum.getChainId() }
			prepareDirectPayload(input)
			record = { id: crypto.randomUUID(), request: pending.uniqueRequestIdentifier, binding, websiteOrigin: pending.website.websiteOrigin, rpcUrl, input, revision: crypto.randomUUID(), created: Date.now(), phase: 'review' }
			await assertCurrentBinding(record)
			await storeRecord(record)
		}
		if (record.phase === 'review') await refreshDirectSigningReview(record, ethereum, prices)
		await browser.tabs.create({ url: `${ browser.runtime.getURL(getHtmlFile('directSigning')) }?id=${ encodeURIComponent(record.id) }` })
		return record
	})
}

/** Persist before every irreversible boundary; an interrupted submission can only reconcile or resend the same bytes. */
export async function updateDirectSigning(request: DirectSigningRequest) {
	return await signingStateLock.execute(async () => {
		const record = (await readDirectSigningRecords()).find((item) => item.id === request.id)
		if (record === undefined) throw new Error('Signing request not found')
		if (request.method === 'signing_get') return record
		if ('revision' in request && request.revision !== record.revision) throw new Error('This approval or response belongs to an earlier review')
		if (request.method === 'signing_cancel') {
			if (record.phase === 'submitting' || record.phase === 'submitted' || record.phase === 'confirmed') throw new Error('A submitted transaction cannot be cancelled here. Reconcile it by its transaction hash.')
			return await storeRecord({ ...record, phase: 'cancelled', revision: crypto.randomUUID() })
		}
		if (request.method === 'signing_broadcast' && (record.phase === 'submitting' || record.phase === 'submitted' || record.phase === 'confirmed')) return await broadcast(record)
		await assertCurrentBinding(record)
		switch (request.method) {
			case 'signing_editFees': return await editTransactionFees(record, request)
			case 'signing_approve': return await approveSigningRequest(record)
			case 'signing_result': return await acceptSigningResult(record, request.result)
			case 'signing_broadcast': return await broadcast(record)
			default: throw new Error('Unsupported signing operation')
		}
	})
}

async function editTransactionFees(record: DirectSigningRecord, request: Extract<DirectSigningRequest, { method: 'signing_editFees' }>) {
	if (record.phase !== 'review' && record.phase !== 'signed') throw new Error('Cancel device approval before editing signed fields')
	if (record.input.method !== 'eth_sendTransaction') throw new Error('Messages do not have transaction fees')
	if (request.gas < 21000n || request.maxPriorityFeePerGas > request.maxFeePerGas) throw new Error('Invalid transaction gas or fees')
	const data = serializeTransaction({ ...parseTransaction(ensureHex(record.input.data)), authorizationList: undefined, nonce: request.nonce, gas: request.gas, maxFeePerGas: request.maxFeePerGas, maxPriorityFeePerGas: request.maxPriorityFeePerGas })
	return await storeRecord({ ...record, input: { ...record.input, data }, phase: 'review', revision: crypto.randomUUID(), result: undefined, transactionHash: undefined })
}

async function approveSigningRequest(record: DirectSigningRecord) {
	if (record.phase !== 'review') throw new Error('Request has already been approved; resume or cancel its current signing operation')
	const reviewedRequest = await findPendingSigningRequest(record)
	if (record.input.method === 'eth_sendTransaction' && reviewedRequest?.directSigningReviewRevision !== record.revision) throw new Error('Wait for the refreshed transaction explanation before approving')
	const pending = await getPendingTransactionsAndMessages()
	const conflictingTransaction = (await readDirectSigningRecords()).find((candidate) => {
		if (candidate.id === record.id || candidate.input.method !== 'eth_sendTransaction') return false
		if (candidate.binding.wallet.address !== record.binding.wallet.address || candidate.input.chainId !== record.input.chainId) return false
		// An ambiguous submission retains its nonce even after the website request disappears.
		if (candidate.phase === 'submitting') return true
		return (candidate.phase === 'approved' || candidate.phase === 'signed')
			&& pending.some((request) => doesUniqueRequestIdentifiersMatch(request.uniqueRequestIdentifier, candidate.request))
	})
	if (record.input.method === 'eth_sendTransaction' && conflictingTransaction !== undefined) throw new Error('Finish or cancel this account’s pending transaction before approving another nonce')
	await checkTransactionFreshness(record)
	return await storeRecord({ ...record, phase: 'approved' })
}

async function acceptSigningResult(record: DirectSigningRecord, result: string) {
	if (record.phase !== 'approved') throw new Error('No current approval for this signature')
	const verifiedResult = await verifyDirectResult(record.input, result)
	await assertCurrentBinding(record)
	return await storeRecord({ ...record, phase: 'signed', result: verifiedResult, ...(record.input.method === 'eth_sendTransaction' ? { transactionHash: keccak256(verifiedResult) } : {}) })
}

async function broadcast(record: DirectSigningRecord) {
	if (record.input.method !== 'eth_sendTransaction' || record.result === undefined || record.transactionHash === undefined || !['signed', 'submitting', 'submitted', 'confirmed'].includes(record.phase)) throw new Error('A verified signed transaction is required')
	await verifyDirectResult(record.input, record.result)
	const rpc = await checkChain(record)
	const hash = BigInt(record.transactionHash)
	const receipt: unknown = await rpc.jsonRpcRequest({ method: 'eth_getTransactionReceipt', params: [hash] })
	if (receipt !== null) {
		const parsed = funtypes.ReadonlyObject({ transactionHash: EthereumBytes32, blockNumber: EthereumQuantity, status: funtypes.Union(funtypes.Literal('0x0'), funtypes.Literal('0x1')) }).parse(receipt)
		if (parsed.transactionHash !== hash) throw new Error('RPC receipt belongs to a different transaction')
		return await storeRecord({ ...record, phase: 'confirmed', executionSucceeded: parsed.status === '0x1' })
	}
	const known: unknown = await rpc.jsonRpcRequest({ method: 'eth_getTransactionByHash', params: [hash] })
	if (known !== null) {
		if (funtypes.ReadonlyObject({ hash: EthereumBytes32 }).parse(known).hash !== hash) throw new Error('RPC returned a different transaction while reconciling submission')
		return await storeRecord({ ...record, phase: 'submitted' })
	}
	if (record.phase === 'submitted' || record.phase === 'confirmed') throw new Error('Previously submitted transaction is not currently visible. Keep its hash and check the configured RPC before taking further action.')
	if (record.phase === 'signed') await checkTransactionFreshness(record)
	const submitting = await storeRecord({ ...record, phase: 'submitting' })
	const returnedHash = EthereumBytes32.parse(await rpc.jsonRpcRequest({ method: 'eth_sendRawTransaction', params: [bytesFromHex(ensureHex(record.result))] }))
	if (returnedHash !== hash) throw new Error('RPC returned a different transaction hash; reconcile the signed transaction hash before proceeding')
	return await storeRecord({ ...submitting, phase: 'submitted' })
}

/** Refresh the existing explanation using the final nonce and fees, and bind its completion to this payload revision. */
export async function refreshDirectSigningReview(record: DirectSigningRecord, ethereum: EthereumClientService, prices: TokenPriceService) {
	if (record.input.method !== 'eth_sendTransaction') return
	if (record.input.chainId !== ethereum.getChainId()) throw new Error('Return to the request’s network to refresh its explanation')
	const pending = await findPendingSigningRequest(record)
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('The transaction explanation is not ready')
	const final = parseTransaction(ensureHex(record.input.data))
	const transactionToSimulate = { ...pending.transactionToSimulate, transaction: { ...pending.transactionToSimulate.transaction, nonce: BigInt(final.nonce ?? 0), gas: BigInt(final.gas ?? 0), maxFeePerGas: final.maxFeePerGas ?? 0n, maxPriorityFeePerGas: final.maxPriorityFeePerGas ?? 0n } }
	const popupVisualisation = await refreshConfirmTransactionSimulation(ethereum, prices, pending.activeAddress, false, pending.uniqueRequestIdentifier, transactionToSimulate, pending.safeTransaction)
	if (popupVisualisation === undefined) throw new Error('The refreshed explanation was interrupted; review again')
	await assertCurrentBinding(record)
	await updatePendingTransactionOrMessage(record.request, async (current) => {
		if (current.type !== 'Transaction' || current.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('The transaction changed during explanation refresh')
		return { ...current, transactionToSimulate, popupVisualisation, directSigningReviewRevision: record.revision }
	})
}
