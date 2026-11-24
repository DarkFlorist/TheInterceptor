import * as assert from 'node:assert'
import { test } from 'bun:test'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { acceptConfirmation, activeAddress, addressString, connectWebsite, createConfirmedSignerStateOwner, createPendingSafeProposal, createSafeAddressBookEntry, createSafeTransactionRequest, createSafeTxToRecipient, createTabConnection, createWebsitePort, EIP712Message, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, hasForwardedSignerRequest, modules, parseForwardedSafeTxTypedData, pendingTransaction, recipientAddress, requireForwardedSignerRequest, requireWebsiteReply, safeTxToTypedDataJson, setWalletAccounts, signedTransaction, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

test('accepts a signer reply from the current approved child-frame port', async () => {
	const topSocket = { tabId: 1, connectionName: 40n }
	const childSocket = { tabId: 1, connectionName: 41n }
	const childRequestIdentifier = { requestId: 77, requestSocket: childSocket }
	const topPort = createWebsitePort(topSocket, 0)
	const childPort = createWebsitePort(childSocket, 2)
	const websiteTabConnections: WebsiteTabConnections = new Map([[topSocket.tabId, {
		signerStateOwner: createConfirmedSignerStateOwner(topSocket, 3, 8),
		connections: {
			...createTabConnection(topPort.port, { socket: topSocket }).connections,
			...createTabConnection(childPort.port, { socket: childSocket }).connections,
		},
	}]])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: childRequestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
		}],
	})

	await modules.signerReply(createTestSimulationServicesOwner(simulator), websiteTabConnections, childPort.port, {
		method: 'signer_reply',
		params: [{
			success: true,
			signerProviderGeneration: 12,
			forwardRequest: {
				type: 'forwardToSigner',
				replyWithSignersReply: true,
				method: pendingTransaction.originalRequestParameters.method,
				params: pendingTransaction.originalRequestParameters.params,
				requestId: childRequestIdentifier.requestId,
			},
			reply: modules.EthereumBytes32.serialize(signedTransaction.hash),
		}],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 78, requestSocket: childSocket },
	}, 'hasAccess', activeAddress)

	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.equal(topPort.postedMessages.length, 0)
	const childReply = requireWebsiteReply(childPort.postedMessages, { method: 'eth_sendTransaction', requestId: childRequestIdentifier.requestId }, 'child-frame signer reply')
	assert.equal(childReply.result, modules.EthereumBytes32.serialize(signedTransaction.hash))
})

test('preserves a MetaMask keyring scan error on a retryable Safe signature', async () => {
	const socket = uniqueRequestIdentifier.requestSocket
	const safeTx = createSafeTxToRecipient()
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const { port, websiteTabConnections } = connectWebsite({ signerStateOwner: createConfirmedSignerStateOwner(socket, 3, 8) })
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [createPendingSafeProposal(createSafeTransactionRequest({ safeTx, reviewedOwners: [recipientAddress] }), { status: 'WaitingForSigner' })],
	})

	await modules.signerReply(createTestSimulationServicesOwner(simulator), websiteTabConnections, port, {
		method: 'signer_reply',
		params: [{
			success: false,
			signerProviderGeneration: 8,
			forwardRequest: {
				type: 'forwardToSigner',
				replyWithSignersReply: true,
				method: 'eth_signTypedData_v4',
				params: [recipientAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))],
				requestId: uniqueRequestIdentifier.requestId,
			},
			error: {
				code: -32603,
				message: 'Keyring Controller signTypedMessage: Error: Scan cancelled',
			},
		}],
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 79, requestSocket: socket },
	}, 'hasAccess', activeAddress)

	const [retryableTransaction] = await modules.getPendingTransactionsAndMessages()
	assert.deepEqual(retryableTransaction?.approvalStatus, {
		status: 'SignerError',
		code: -32603,
		message: 'Keyring Controller signTypedMessage: Error: Scan cancelled',
	})
	assert.equal(retryableTransaction?.type === 'Transaction' ? retryableTransaction.safeTransaction?.safeTxHash : undefined, safeTxHash)
})

test('forwards a Safe transaction to the wallet-selected Safe owner as EIP-712 typed data', async () => {
	await setWalletAccounts([recipientAddress])
	const safeAddressBookEntry = createSafeAddressBookEntry({
		safeSimulationSignerAddress: 0x2222222222222222222222222222222222222222n,
	})
	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	const { postedMessages, websiteTabConnections } = connectWebsite()
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [createPendingSafeProposal(createSafeTransactionRequest({ reviewedOwners: [] }))],
	})

	await modules.updateUserAddressBookEntries(() => [{ ...safeAddressBookEntry, safeSimulationSignerAddress: activeAddress }])
	fakeSafeContract.owners = [0x1111111111111111111111111111111111111111n]
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, acceptConfirmation), false)
	assert.equal(hasForwardedSignerRequest(postedMessages), false)
	const [changedOwnersProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedOwnersProposal?.approvalStatus.status, 'SignerError')
	if (changedOwnersProposal?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-owner Gnosis Safe proposal error')
	assert.match(changedOwnersProposal.approvalStatus.message, /owner set changed/u)

	fakeSafeContract.owners = []
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, acceptConfirmation), true)

	const signerRequest = requireForwardedSignerRequest(postedMessages, 'Safe signer request')
	assert.equal(signerRequest.method, 'eth_signTypedData_v4')
	assert.equal(signerRequest.params[0], addressString(recipientAddress))
	assert.equal(typeof signerRequest.params[1], 'string')
	const typedData = parseForwardedSafeTxTypedData(signerRequest.params[1])
	assert.equal(typedData.primaryType, 'SafeTx')
	assert.equal(typedData.domain.chainId, fakeRpcNetwork.chainId.toString())
	assert.equal(typedData.message.to.toLowerCase(), `0x${ recipientAddress.toString(16).padStart(40, '0') }`)
})
