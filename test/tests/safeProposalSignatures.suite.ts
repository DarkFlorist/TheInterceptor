import * as assert from 'node:assert'
import { test } from 'bun:test'
import * as funtypes from 'funtypes'
import { activeAddress, connectWebsite, createPendingSafeProposal, createSafeAddressBookEntry, createSafeTransactionRequest, createSafeTxToRecipient, EIP712Message, enableSafeSigningMode, ethereum, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, hasForwardedSignerRequest, interceptStorageSet, modules, recipientAddress, requireForwardedSignerRequest, requireWebsiteReply, safeTestOwnerAccount, safeTestOwnerAddress, safeTxToTypedDataJson, setWalletAccounts, simulator, uniqueRequestIdentifier, withSafeOwnerLookupFailure } from './confirmTransactionTestHarness.js'

const safeSignerAddress = safeTestOwnerAddress

// A signing request owned by the test owner account, reviewed while it was the Safe's only owner.
const createOwnerSignedSafeRequest = (safeTx = createSafeTxToRecipient()) => createSafeTransactionRequest({ safeTx, safeSignerAddress, reviewedOwners: [safeSignerAddress] })

const signSafeTx = async (safeTx: ReturnType<typeof createSafeTxToRecipient>) => await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))

// EIP712Message keeps JSON numbers as strings, so the SafeTx nonce may arrive in either encoding.
const SafeTxMessageNonce = funtypes.ReadonlyObject({ nonce: funtypes.Union(funtypes.String, funtypes.Number) })

const readSafeTxNonce = (typedData: EIP712Message) => SafeTxMessageNonce.parse(typedData.message).nonce

async function useTestOwnerAsWalletSigner() {
	fakeSafeContract.owners = [safeSignerAddress]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSignerAddresses: [safeSignerAddress],
	})])
	await setWalletAccounts([safeSignerAddress])
}

test('rebases a later pending Safe proposal after an earlier nonce is rejected', async () => {
	await useTestOwnerAsWalletSigner()
	const firstIdentifier = { requestId: 31, requestSocket: uniqueRequestIdentifier.requestSocket }
	const secondIdentifier = { requestId: 32, requestSocket: uniqueRequestIdentifier.requestSocket }
	const firstSafeTx = createSafeTxToRecipient()
	const rebasedSafeTx = firstSafeTx
	const secondSafeTx = createSafeTxToRecipient({ nonce: 1n })
	const rebasedSafeTxHash = BigInt(getSafeTxHash(rebasedSafeTx))
	fakeSafeContract.transactionHash = rebasedSafeTxHash
	const makePendingSafeTransaction = (requestIdentifier: typeof firstIdentifier, safeTx: typeof firstSafeTx, transactionIdentifier: bigint) => ({
		...createPendingSafeProposal(createOwnerSignedSafeRequest(safeTx)),
		uniqueRequestIdentifier: requestIdentifier,
		transactionIdentifier,
	})
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [
			makePendingSafeTransaction(firstIdentifier, firstSafeTx, 31n),
			makePendingSafeTransaction(secondIdentifier, secondSafeTx, 32n),
		],
	})

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), {
		method: 'popup_confirmDialog',
		data: { action: 'reject', errorString: undefined, uniqueRequestIdentifier: firstIdentifier },
	}), false)

	const { postedMessages, websiteTabConnections } = connectWebsite({ socket: secondIdentifier.requestSocket })
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: secondIdentifier },
	}), false)
	assert.equal(hasForwardedSignerRequest(postedMessages), false)
	const [refreshedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedProposal?.type === 'Transaction' ? refreshedProposal.safeTransaction?.safeTx.message.nonce : undefined, 0n)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: secondIdentifier },
	}), true)
	const signerRequest = requireForwardedSignerRequest(postedMessages, 'rebased Safe signer request')
	const typedData = EIP712Message.parse(signerRequest.params[1])
	assert.equal(readSafeTxNonce(typedData), 0n)

	const signature = await safeTestOwnerAccount.signTypedData(typedData)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier: secondIdentifier },
	}), true)
	const [safeStack] = await modules.getSafeTransactionStacks()
	assert.equal(safeStack?.baseNonce, 0n)
	assert.equal(safeStack?.transactions[0]?.safeTxHash, rebasedSafeTxHash)
})

test('rejects a stale forwarded Safe nonce before persistence and rebases it when retried', async () => {
	await useTestOwnerAsWalletSigner()
	const requestIdentifier = { requestId: 33, requestSocket: uniqueRequestIdentifier.requestSocket }
	const staleSafeTx = createSafeTxToRecipient({ nonce: 1n })
	const rebasedSafeTx = createSafeTxToRecipient()
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(rebasedSafeTx))
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...createPendingSafeProposal(createOwnerSignedSafeRequest(staleSafeTx), { status: 'WaitingForSigner' }),
			uniqueRequestIdentifier: requestIdentifier,
		}],
	})
	const staleSignature = await signSafeTx(staleSafeTx)

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: staleSignature, uniqueRequestIdentifier: requestIdentifier },
	}), false)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	const [stalePending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(stalePending?.approvalStatus.status, 'SignerError')
	if (stalePending?.approvalStatus.status !== 'SignerError') throw new Error('Missing stale Safe nonce signer error')
	assert.match(stalePending.approvalStatus.message, /next available nonce is 0/u)

	const { postedMessages, websiteTabConnections } = connectWebsite({ socket: requestIdentifier.requestSocket })
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: requestIdentifier },
	}), false)
	assert.equal(hasForwardedSignerRequest(postedMessages), false)
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedPending?.type === 'Transaction' ? refreshedPending.safeTransaction?.safeTx.message.nonce : undefined, 0n)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: requestIdentifier },
	}), true)
	const signerRequest = requireForwardedSignerRequest(postedMessages, 'retried Safe signer request')
	assert.equal(readSafeTxNonce(EIP712Message.parse(signerRequest.params[1])), 0n)
})

test('persists and simulates a valid Safe owner signature before replying with the canonical Safe hash', async () => {
	fakeSafeContract.owners = [safeSignerAddress]
	const safeAddressBookEntry = createSafeAddressBookEntry({ safeSimulationSignerAddress: safeSignerAddress })
	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	const safeTx = createSafeTxToRecipient()
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const signature = await signSafeTx(safeTx)
	const { postedMessages, websiteTabConnections } = connectWebsite()
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await enableSafeSigningMode()
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [createPendingSafeProposal(createOwnerSignedSafeRequest(safeTx), { status: 'WaitingForSigner' })],
	})

	await modules.updateUserAddressBookEntries(() => [{ ...safeAddressBookEntry, safeSimulationSignerAddress: recipientAddress }])
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), true)

	const safeStacks = await modules.getSafeTransactionStacks()
	assert.equal(safeStacks.length, 1)
	assert.equal(safeStacks[0]?.transactions[0]?.safeTxHash, safeTxHash)
	assert.equal(safeStacks[0]?.transactions[0]?.signatures[0]?.signer, safeSignerAddress)
	const interceptorStack = await modules.getInterceptorTransactionStack()
	const optimisticTransaction = interceptorStack.operations.find((operation) =>
		operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction?.safeTxHash === safeTxHash
	)
	assert.notEqual(optimisticTransaction, undefined)
	if (optimisticTransaction?.type !== 'Transaction') throw new Error('Missing optimistic Safe transaction')
	assert.equal(optimisticTransaction.preSimulationTransaction.signedTransaction.type, '1559')
	if (optimisticTransaction.preSimulationTransaction.signedTransaction.type !== '1559') throw new Error('Safe simulation transaction is not EIP-1559')
	assert.equal(optimisticTransaction.preSimulationTransaction.signedTransaction.maxFeePerGas, 0n)
	assert.equal(optimisticTransaction.preSimulationTransaction.signedTransaction.maxPriorityFeePerGas, 0n)
	assert.deepEqual(optimisticTransaction.preSimulationTransaction.simulationOptions, {
		requiredChainId: fakeRpcNetwork.chainId,
		simulateWithZeroBaseFee: true,
	})
	assert.equal((await modules.getSettings()).activeSigningSafeAddress, activeAddress)
	const simulationInput = await modules.getCurrentSimulationInput()
	const safeSimulationBlock = simulationInput.find((block) => block.transactions.some((transaction) =>
		transaction.safeTransaction?.safeTxHash === safeTxHash
	))
	assert.equal(safeSimulationBlock?.simulateWithZeroBaseFee, true)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const dappReply = requireWebsiteReply(postedMessages, { method: 'eth_sendTransaction', requestId: uniqueRequestIdentifier.requestId }, 'Safe transaction dapp reply')
	assert.equal(dappReply.result, modules.EthereumBytes32.serialize(safeTxHash))
})

test('adds an unsigned Safe proposal and merges a later owner signature into both stack representations', async () => {
	fakeSafeContract.owners = [safeSignerAddress]
	const safeTx = createSafeTxToRecipient()
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const { postedMessages, websiteTabConnections } = connectWebsite()
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await enableSafeSigningMode()
	const safePending = createPendingSafeProposal(createOwnerSignedSafeRequest(safeTx))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [safePending],
	})

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'addToSafeStack', uniqueRequestIdentifier },
	}), true)

	const [storedStack] = await modules.getSafeTransactionStacks()
	assert.equal(storedStack?.transactions[0]?.safeTxHash, safeTxHash)
	assert.deepEqual(storedStack?.transactions[0]?.signatures, [])
	assert.equal(hasForwardedSignerRequest(postedMessages), false)
	const dappReply = requireWebsiteReply(postedMessages, { method: 'eth_sendTransaction', requestId: uniqueRequestIdentifier.requestId }, 'unsigned Safe transaction dapp reply')
	assert.equal(dappReply.result, modules.EthereumBytes32.serialize(safeTxHash))

	const signature = await signSafeTx(safeTx)
	const signedResolution = await modules.resolveSafeSignerReply(
		simulator.ethereum,
		simulator.tokenPriceService,
		{ ...safePending, approvalStatus: { status: 'WaitingForSigner' } },
		signature,
	)
	assert.equal(signedResolution.status, 'success')
	const [signedStack] = await modules.getSafeTransactionStacks()
	assert.equal(signedStack?.transactions[0]?.signatures[0]?.signer, safeSignerAddress)
	const mirroredProposal = (await modules.getInterceptorTransactionStack()).operations.find((operation) =>
		operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction?.safeTxHash === safeTxHash
	)
	if (mirroredProposal?.type !== 'Transaction') throw new Error('Missing optimistic Safe transaction mirror')
	assert.equal(mirroredProposal.preSimulationTransaction.safeTransaction?.signatures[0]?.signer, safeSignerAddress)
})

test('invalid Safe owner signatures retain the request as a signer error without creating a Safe stack', async () => {
	await modules.updateSafeTransactionStacks(() => [])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [createPendingSafeProposal(createSafeTransactionRequest(), { status: 'WaitingForSigner' })],
	})

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: '0x1234', uniqueRequestIdentifier },
	}), false)

	const retainedRequests = await modules.getPendingTransactionsAndMessages()
	assert.equal(retainedRequests.length, 1)
	const retainedRequest = retainedRequests[0]
	assert.equal(retainedRequest?.approvalStatus.status, 'SignerError')
	if (retainedRequest?.approvalStatus.status !== 'SignerError') throw new Error('missing Safe signature error')
	assert.match(retainedRequest.approvalStatus.message, /owner signature was rejected/u)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})

test('propagates unexpected Safe signer-reply RPC and storage failures', async () => {
	fakeSafeContract.owners = [safeSignerAddress]
	fakeSafeContract.threshold = 2n
	const safeTx = createSafeTxToRecipient()
	const signature = await signSafeTx(safeTx)
	const safePending = createPendingSafeProposal(createOwnerSignedSafeRequest(safeTx), { status: 'WaitingForSigner' })

	await withSafeOwnerLookupFailure('unexpected', async () => {
		await assert.rejects(
			modules.resolveSafeSignerReply(ethereum, simulator.tokenPriceService, safePending, signature),
			/Unexpected Safe owner decoder failure/u,
		)
	})
	const expectedFailure = await withSafeOwnerLookupFailure('expected', async () => await modules.resolveSafeSignerReply(ethereum, simulator.tokenPriceService, safePending, signature))
	assert.equal(expectedFailure.status, 'error')
	assert.match(expectedFailure.status === 'error' ? expectedFailure.approvalStatus.message : '', /Safe owner lookup unavailable/u)

	const restoreStorageSet = interceptStorageSet(async () => {
		throw new Error('Safe stack storage unavailable')
	})
	try {
		await assert.rejects(
			modules.resolveSafeSignerReply(ethereum, simulator.tokenPriceService, safePending, signature),
			/Safe stack storage unavailable/u,
		)
	} finally {
		restoreStorageSet()
	}
})
