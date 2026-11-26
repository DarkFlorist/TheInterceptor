import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import * as assert from 'assert'
import { test } from 'bun:test'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { getLatestUnexpectedError } from '../../app/ts/background/storageVariables.js'
import { activeAddress, addressString, browserMock, createGnosisSafeAddressBookEntry, createGnosisSafeTx, createWebsitePort, EIP712Message, ethereum, fakeRpcNetwork, fakeGnosisSafeContract, getPendingGnosisSafeProposal, getGnosisSafeTxHash, isRecord, modules, oldTimestamp, pendingTransaction, privateKeyToAccount, recipientAddress, GNOSIS_SAFE_EXECUTION_ABI, gnosisSafeTestOwnerAccount, gnosisSafeTestOwnerAddress, gnosisSafeTxToTypedDataJson, signedTransaction, simulator, uniqueRequestIdentifier, withSilencedConsole, createAcceptConfirmation, withSimulatedTransactionResult } from './confirmTransactionTestHarness.js'

test('refreshing confirm transaction updates the persisted simulation timestamp', async () => {
	browserMock.sentMessages.length = 0
	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const [pendingTransaction] = await modules.getPendingTransactionsAndMessages()
	if (pendingTransaction === undefined || pendingTransaction.type !== 'Transaction') throw new Error('missing refreshed pending transaction')
	if (pendingTransaction.popupVisualisation.statusCode !== 'success') throw new Error('unexpected popup visualisation state')
	const refreshedTimestamp = pendingTransaction.popupVisualisation.data.simulationState.simulationConductedTimestamp
	assert.ok(refreshedTimestamp.getTime() > oldTimestamp.getTime())
	assert.equal(browserMock.sentMessages.some((message) => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions'), true)
})
test('accepts a signer reply from the current approved child-frame port', async () => {
	const topSocket = { tabId: 1, connectionName: 40n }
	const childSocket = { tabId: 1, connectionName: 41n }
	const childRequestIdentifier = { requestId: 77, requestSocket: childSocket }
	const topMessages: unknown[] = []
	const childMessages: unknown[] = []
	const topPort = createWebsitePort(topSocket, 0, topMessages)
	const childPort = createWebsitePort(childSocket, 2, childMessages)
	const websiteOrigin = 'https://example.com'
	const websiteTabConnections = new Map([[topSocket.tabId, {
		signerStateOwner: {
			connectionName: topSocket.connectionName,
			confirmed: true,
			generation: 3,
			providerGeneration: 8,
		},
		connections: {
			[modules.websiteSocketToString(topSocket)]: { port: topPort, socket: topSocket, websiteOrigin, approved: true, wantsToConnect: true },
			[modules.websiteSocketToString(childSocket)]: { port: childPort, socket: childSocket, websiteOrigin, approved: true, wantsToConnect: true },
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

	await modules.signerReply(createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }), websiteTabConnections, childPort, {
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
	assert.equal(topMessages.length, 0)
	const childReply = childMessages.find((message) => isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === childRequestIdentifier.requestId)
	if (!isRecord(childReply)) throw new Error('Missing child-frame signer reply')
	assert.equal(childReply.result, modules.EthereumBytes32.serialize(signedTransaction.hash))
})

test('preserves a MetaMask keyring scan error on a retryable Gnosis Safe signature', async () => {
	const socket = uniqueRequestIdentifier.requestSocket
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getGnosisSafeTxHash(safeTx))
	const messages: unknown[] = []
	const port = createWebsitePort(socket, 0, messages)
	const websiteOrigin = 'https://example.com'
	const websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: {
			connectionName: socket.connectionName,
			confirmed: true,
			generation: 3,
			providerGeneration: 8,
		},
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		},
	}]])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: {
					version: '1.4.1',
					nonce: 0n,
					owners: [recipientAddress],
					threshold: 2n,
				},
				safeTxHash,
				safeTx,
			} },
		}],
	})

	await modules.signerReply(createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }), websiteTabConnections, port, {
		method: 'signer_reply',
		params: [{
			success: false,
			signerProviderGeneration: 8,
			forwardRequest: {
				type: 'forwardToSigner',
				replyWithSignersReply: true,
				method: 'eth_signTypedData_v4',
				params: [recipientAddress, EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx))],
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
	assert.equal(getPendingGnosisSafeProposal(retryableTransaction)?.safeTxHash, safeTxHash)
})

test('forwards a Gnosis Safe transaction to the wallet-selected Gnosis Safe owner as EIP-712 typed data', async () => {
	// Approvals of requests created in signing mode are only forwarded while the Interceptor is still in signing mode.
	await modules.changeSimulationMode({ simulationMode: false })
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [recipientAddress],
		activeSigningAddress: recipientAddress,
	}))
	const safeAddressBookEntry = createGnosisSafeAddressBookEntry({
		safeSimulationSignerAddress: 0x2222222222222222222222222222222222222222n,
	})
	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...withSimulatedTransactionResult(pendingTransaction),
			simulationMode: false,
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: {
					version: '1.4.1',
					nonce: 0n,
					owners: [],
					threshold: 2n,
				},
				safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
				safeTx,
			} },
		}],
	})

	await modules.updateUserAddressBookEntries(() => [{ ...safeAddressBookEntry, safeSimulationSignerAddress: activeAddress }])
	fakeGnosisSafeContract.owners = [0x1111111111111111111111111111111111111111n]
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation()), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [changedOwnersProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedOwnersProposal?.approvalStatus.status, 'SignerError')
	if (changedOwnersProposal?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-owner Gnosis Safe proposal error')
	assert.match(changedOwnersProposal.approvalStatus.message, /owner set changed/u)

	fakeGnosisSafeContract.owners = []
	await modules.updateStoredPendingRequest(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation()), true)

	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing Gnosis Safe signer request')
	assert.equal(signerRequest.method, 'eth_signTypedData_v4')
	assert.equal(signerRequest.params[0], addressString(recipientAddress))
	assert.equal(typeof signerRequest.params[1], 'string')
	const typedData = JSON.parse(String(signerRequest.params[1]))
	assert.equal(typedData.primaryType, 'SafeTx')
	assert.equal(typedData.domain.chainId, fakeRpcNetwork.chainId.toString())
	assert.equal(typedData.message.to.toLowerCase(), `0x${ recipientAddress.toString(16).padStart(40, '0') }`)
})

test('routes a Gnosis Safe co-signing request through the wallet-selected owner', async () => {
	// Approvals of requests created in signing mode are only forwarded while the Interceptor is still in signing mode.
	await modules.changeSimulationMode({ simulationMode: false })
	const ownerAccount = privateKeyToAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd')
	const safeSignerAddress = BigInt(ownerAccount.address)
	const alternateOwnerAccount = privateKeyToAccount('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef')
	const alternateOwnerAddress = BigInt(alternateOwnerAccount.address)
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
	fakeGnosisSafeContract.owners = [safeSignerAddress, alternateOwnerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeSimulationSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress, recipientAddress],
		activeSigningAddress: safeSignerAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	let accountReply: Promise<unknown> | undefined
	let websiteTabConnections: Map<number, {
		signerStateOwner: {
			connectionName: bigint
			confirmed: boolean
			generation: number
			providerGeneration: number
		}
		connections: Record<string, {
			port: browser.runtime.Port
			socket: typeof socket
			websiteOrigin: string
			approved: boolean
			wantsToConnect: boolean
		}>
	}>
	let port: browser.runtime.Port
	port = createWebsitePort(socket, 0, postedMessages, (message) => {
		if (!isRecord(message) || message.method !== 'request_signer_to_eth_accounts') return
		accountReply = modules.ethAccountsReply(
			createTestSimulationServicesOwner({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService }),
			websiteTabConnections,
			port,
			{
				method: 'eth_accounts_reply',
				params: [{
					signerProviderGeneration: 1,
					type: 'success',
					accounts: [addressString(safeSignerAddress)],
					requestAccounts: false,
				}],
			},
			'hasAccess',
			activeAddress,
		)
	})
	websiteTabConnections = new Map([[socket.tabId, {
		signerStateOwner: {
			connectionName: socket.connectionName,
			confirmed: true,
			generation: 1,
			providerGeneration: 1,
		},
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [activeAddress, EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const website = { websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' }

	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		false,
		activeAddress,
		website,
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [reviewedCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.notEqual(reviewedCoSignRequest?.type === 'SignableMessage' ? reviewedCoSignRequest.safeMessageCoSignSnapshot : undefined, undefined)
	if (reviewedCoSignRequest?.type !== 'SignableMessage') throw new Error('Missing reviewed Gnosis Safe co-signing request')
	fakeGnosisSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		await assert.rejects(
			modules.resolveGnosisSafeConfirmation(simulator.ethereum, reviewedCoSignRequest, 'accept'),
			/Unexpected Gnosis Safe owner decoder failure/u,
		)
		await assert.rejects(
			modules.resolveGnosisSafeSignerReply(simulator.ethereum, reviewedCoSignRequest, '0x1234'),
			/Unexpected Gnosis Safe owner decoder failure/u,
		)
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}
	fakeGnosisSafeContract.safeOwnerLookupFailure = 'expected'
	try {
		const expectedFailure = await modules.resolveGnosisSafeConfirmation(simulator.ethereum, reviewedCoSignRequest, 'accept')
		assert.equal(expectedFailure.status, 'blocked')
		assert.match(expectedFailure.status === 'blocked' ? expectedFailure.approvalStatus.message : '', /Gnosis Safe owner lookup unavailable/u)
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}
	await modules.updateTabState(socket.tabId, (state) => ({
		...state,
		signerAccounts: [alternateOwnerAddress],
		activeSigningAddress: alternateOwnerAddress,
	}))
	fakeGnosisSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		await assert.rejects(
			modules.resolveGnosisSafeConfirmation(
				simulator.ethereum,
				reviewedCoSignRequest,
				'accept',
				{ selectedSigner: alternateOwnerAddress, verificationError: undefined },
			),
			/Unexpected Gnosis Safe owner decoder failure/u,
		)
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}
	const [unchangedCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(unchangedCoSignRequest?.approvalStatus.status, 'WaitingForUser')
	await modules.refreshPendingGnosisSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
	const [refreshedCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedCoSignRequest?.type === 'SignableMessage' ? refreshedCoSignRequest.safeMessageCoSignSnapshot?.safeSignerAddress : undefined, alternateOwnerAddress)
	assert.equal(refreshedCoSignRequest?.approvalStatus.status, 'WaitingForUser')
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation()), true)

	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing Gnosis Safe co-signer request')
	assert.equal(signerRequest.method, 'eth_signTypedData_v4')
	assert.equal(signerRequest.params[0], addressString(alternateOwnerAddress))
	assert.equal(JSON.parse(String(signerRequest.params[1])).domain.verifyingContract.toLowerCase(), addressString(activeAddress).toLowerCase())

	const signature = await alternateOwnerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
	await modules.updateUserAddressBookEntries((entries) => entries.map((entry) =>
		entry.type === 'safe' && entry.address === activeAddress
			? { ...entry, safeSimulationSignerAddress: 0x2222222222222222222222222222222222222222n }
			: entry
	))
	const signerCodeReadsBeforeReply = fakeGnosisSafeContract.requestedCodeAddresses.filter((address) => address === alternateOwnerAddress).length
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), true)
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.type === 'result' && message.method === 'eth_signTypedData_v4' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing Gnosis Safe co-signature reply')
	assert.equal(dappReply.result, signature)
	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), [])
	const signerCodeReadsAfterReply = fakeGnosisSafeContract.requestedCodeAddresses.filter((address) => address === alternateOwnerAddress).length
	assert.equal(signerCodeReadsAfterReply - signerCodeReadsBeforeReply, 1)
})

test('returns a Gnosis Safe signer error when the wallet-selected co-signer is not a current owner', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const safeSignerAddress = recipientAddress
	const currentOwner = gnosisSafeTestOwnerAddress
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.owners = [currentOwner]
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeSignerAddresses: [safeSignerAddress],
		safeVersion: '1.4.1',
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, [])
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [activeAddress, EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}

	const reply = await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		false,
		activeAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	)

	assert.equal(reply.type, 'result')
	if (reply.type !== 'result' || !('error' in reply)) throw new Error('Missing Gnosis Safe signer selection error')
	assert.equal(reply.error.code, -32010)
	assert.match(reply.error.message, /is not an owner of Gnosis Safe/u)
})

test('treats a missing Gnosis Safe version as an expected co-signing validation failure', async () => {
	fakeGnosisSafeContract.owners = [recipientAddress]
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ safeVersion: undefined })])
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [activeAddress, EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx))] as const,
	}
	const { createGnosisSafeMessageCoSignSnapshot, isGnosisSafeSignerSelectionFailure } = await import('../../app/ts/background/gnosisSafeConfirmationResolver.js')
	await assert.rejects(
		createGnosisSafeMessageCoSignSnapshot(simulator.ethereum, activeAddress, recipientAddress, signRequest, safeTx),
		(error: unknown) => isGnosisSafeSignerSelectionFailure(error) && error instanceof Error && /Re-save the active Gnosis Safe/u.test(error.message),
	)
})

test('rejects non-v4 Gnosis Safe co-signing as a handled signer-selection failure', async () => {
	fakeGnosisSafeContract.owners = [recipientAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [recipientAddress],
		activeSigningAddress: recipientAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const signRequest = {
		method: 'eth_signTypedData_v3' as const,
		params: [activeAddress, EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const unexpectedErrorBeforeRequest = await getLatestUnexpectedError()

	const reply = await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		false,
		activeAddress,
		{ websiteOrigin: 'https://safe-v3.example', icon: undefined, title: 'Gnosis Safe v3' },
		new Map(),
	)
	assert.equal(reply.type, 'result')
	if (reply.type !== 'result' || !('error' in reply)) throw new Error('Missing handled non-v4 Gnosis Safe co-signing error')
	assert.equal(reply.error.code, -32010)
	assert.match(reply.error.message, /requires eth_signTypedData_v4/u)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)
})

test('shows Gnosis Safe transaction context failures in the co-signing dialog without reporting them as unexpected', async () => {
	fakeGnosisSafeContract.owners = [recipientAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [recipientAddress],
		activeSigningAddress: recipientAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId + 1n, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [activeAddress, EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const unexpectedErrorBeforeRequest = await getLatestUnexpectedError()

	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		false,
		activeAddress,
		{ websiteOrigin: 'https://safe-context.example', icon: undefined, title: 'Gnosis Safe context' },
		new Map(),
	), { type: 'doNotReply' })
	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingMessage?.approvalStatus.status, 'SignerError')
	if (pendingMessage?.approvalStatus.status !== 'SignerError') throw new Error('Missing Gnosis Safe context validation error')
	assert.match(pendingMessage.approvalStatus.message, /prepared for chain 1338, but the connected network is chain 1337\./u)
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)
})

test('shows a Gnosis Safe signing-account mismatch in the confirmation dialog without reporting an unexpected error', async () => {
	const walletOwner = gnosisSafeTestOwnerAddress
	const mismatchedRequestedAccount = recipientAddress
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.owners = [walletOwner]
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const walletOwnerEntry = {
		type: 'contact' as const,
		name: 'Known Gnosis Safe owner',
		address: walletOwner,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User' as const,
	}
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeSignerAddresses: [walletOwner],
		safeVersion: '1.4.1',
	}), walletOwnerEntry])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [walletOwner],
		activeSigningAddress: walletOwner,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, [])
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [mismatchedRequestedAccount, EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const unexpectedErrorBeforeRequest = await getLatestUnexpectedError()

	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		false,
		activeAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingMessage?.type, 'SignableMessage')
	assert.equal(pendingMessage?.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(pendingMessage?.approvalStatus.status, 'SignerError')
	if (pendingMessage?.approvalStatus.status !== 'SignerError') throw new Error('Missing Gnosis Safe account mismatch error')
	assert.equal(pendingMessage.approvalStatus.code, -32010)
	assert.equal(pendingMessage.approvalStatus.message, 'The Gnosis Safe transaction signing account does not match the active Gnosis Safe.')
	assert.deepEqual(pendingMessage.approvalStatus.safeSignerErrorDetails, {
		kind: 'safeSigningAccountMismatch',
		requestedSigningAccount: mismatchedRequestedAccount,
		activeSafe: activeAddress,
		requestedSafe: activeAddress,
		safeOwners: [walletOwner],
		safeOwnerAddressBookEntries: [walletOwnerEntry],
	})
	assert.equal(pendingMessage.type === 'SignableMessage' ? pendingMessage.safeMessageCoSignSnapshot : undefined, undefined)
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	fakeGnosisSafeContract.safeOwnerLookupFailure = 'expected'
	try {
		assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
			simulator.ethereum,
			simulator.tokenPriceService,
			request,
			{ kind: 'message', parameters: signRequest },
			false,
			activeAddress,
			{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
			websiteTabConnections,
		), { type: 'doNotReply' })
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}
	const [pendingMessageWithoutOwners] = await modules.getPendingTransactionsAndMessages()
	if (pendingMessageWithoutOwners?.approvalStatus.status !== 'SignerError') throw new Error('Missing Gnosis Safe account mismatch error after owner lookup failure')
	assert.deepEqual(pendingMessageWithoutOwners.approvalStatus.safeSignerErrorDetails, {
		kind: 'safeSigningAccountMismatch',
		requestedSigningAccount: mismatchedRequestedAccount,
		activeSafe: activeAddress,
		requestedSafe: activeAddress,
		safeOwners: [],
		safeOwnerAddressBookEntries: [],
		safeOwnersUnavailableReason: 'Gnosis Safe owner lookup unavailable',
	})
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	fakeGnosisSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		const { createGnosisSafeMessageCoSignSnapshot } = await import('../../app/ts/background/gnosisSafeConfirmationResolver.js')
		await assert.rejects(
			createGnosisSafeMessageCoSignSnapshot(simulator.ethereum, activeAddress, walletOwner, signRequest, safeTx),
			/Unexpected Gnosis Safe owner decoder failure/u,
		)
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)
})

test('signs Gnosis Safe transaction typed data normally when the active signing address is an EOA', async () => {
	const eoaAddress = gnosisSafeTestOwnerAddress
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.owners = [eoaAddress]
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [
		createGnosisSafeAddressBookEntry({ safeSignerAddresses: [eoaAddress], safeVersion: '1.4.1' }),
		{ type: 'contact', name: 'Sealwort signer', address: eoaAddress, chainId: fakeRpcNetwork.chainId, entrySource: 'User' },
	])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [eoaAddress],
		activeSigningAddress: eoaAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, [])
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [eoaAddress, EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const unexpectedErrorBeforeRequest = await getLatestUnexpectedError()

	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		false,
		eoaAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	if (pendingMessage?.type !== 'SignableMessage' || pendingMessage.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Missing EOA Gnosis Safe typed-data confirmation')
	assert.equal(pendingMessage.approvalStatus.status, 'WaitingForUser')
	assert.equal(pendingMessage.safeMessageCoSignSnapshot, undefined)
	assert.deepEqual(await modules.resolveGnosisSafeConfirmation(simulator.ethereum, pendingMessage, 'accept'), {
		status: 'ready',
		pending: pendingMessage,
		pendingChanged: false,
		signerFacingRequest: undefined,
	})
	assert.deepEqual(await modules.resolveGnosisSafeSignerReply(simulator.ethereum, pendingMessage, '0x1234'), { status: 'not-safe' })
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)
})

test('uses the configured Gnosis Safe simulation signer without changing the active Gnosis Safe account', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const simulationSignerAddress = 0x4444444444444444444444444444444444444444n
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeGnosisSafeContract.owners = [simulationSignerAddress]
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeSimulationSignerAddress: simulationSignerAddress,
		safeSignerAddresses: [simulationSignerAddress],
		safeVersion: '1.4.1',
	})])
	const signRequest = {
		method: 'eth_signTypedData_v4' as const,
		params: [activeAddress, EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx))] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, [])
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://simulation-signer.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		true,
		activeAddress,
		{ websiteOrigin: 'https://simulation-signer.example', icon: undefined, title: 'Simulation signer' },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingMessage?.type, 'SignableMessage')
	if (pendingMessage?.type !== 'SignableMessage') throw new Error('Missing simulated Gnosis Safe message')
	assert.equal(pendingMessage.activeAddress, activeAddress)
	assert.equal(pendingMessage.signedMessageTransaction.activeAddress, activeAddress)
	assert.equal(pendingMessage.signedMessageTransaction.fakeSignedFor, simulationSignerAddress)
})

test('requires an explicit Gnosis Safe simulation signer instead of using the first cached owner', async () => {
	const cachedOwner = 0x4444444444444444444444444444444444444444n
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeSimulationSignerAddress: undefined,
		safeSignerAddresses: [cachedOwner],
		safeVersion: '1.4.1',
	})])
	const signRequest = {
		method: 'personal_sign' as const,
		params: ['0x1234', activeAddress] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}

	const reply = await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		true,
		activeAddress,
		{ websiteOrigin: 'https://simulation-signer.example', icon: undefined, title: 'Simulation signer' },
		new Map(),
	)

	assert.equal(reply.type, 'result')
	if (reply.type !== 'result' || !('error' in reply)) throw new Error('Missing Gnosis Safe simulation signer error')
	assert.equal(reply.error.code, -32010)
	assert.match(reply.error.message, /Select a Gnosis Safe signer for simulation/u)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('recognizes only execTransaction calls to the active Gnosis Safe for direct signer execution', async () => {
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const safeSignerAddress = 0x1234567890123456789012345678901234567890n
	const safeEntry = createGnosisSafeAddressBookEntry({ safeSimulationSignerAddress: recipientAddress })
	const transaction = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: '0x6a76120200',
		}],
	})

	assert.deepEqual(modules.getGnosisSafeExecutionSignerRoute(transaction, safeEntry, safeSignerAddress), {
		executor: safeSignerAddress,
		transactionParams: {
			method: 'eth_sendTransaction',
			params: [{
				...transaction.params[0],
				from: safeSignerAddress,
			}],
		},
	})
	assert.equal(modules.getGnosisSafeExecutionSignerRoute(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(recipientAddress),
			to: addressString(activeAddress),
			data: '0x6a76120200',
		}],
	}), safeEntry, safeSignerAddress), undefined)
	assert.equal(modules.getGnosisSafeExecutionSignerRoute(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			data: '0x6a76120200',
		}],
	}), safeEntry, safeSignerAddress), undefined)
	assert.equal(modules.getGnosisSafeExecutionSignerRoute(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: '0xa9059cbb',
		}],
	}), safeEntry, safeSignerAddress), undefined)
	assert.equal(modules.getGnosisSafeExecutionSignerRoute(transaction, safeEntry, undefined), undefined)
	const nonzeroOuterValue = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			value: '0x1',
			data: '0x6a76120200',
		}],
	})
	await assert.rejects(
		modules.prepareGnosisSafeExecutionSignerRoute(ethereum, nonzeroOuterValue, safeEntry, safeSignerAddress),
		/A direct Gnosis Safe execution transaction must have zero outer ETH value/u,
	)
	fakeGnosisSafeContract.threshold = 3n
	const insufficientSignatures = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [
				addressString(recipientAddress), 0n, '0x', 0n, 0n, 0n, 0n,
				addressString(0n), addressString(0n), `0x${ '00'.repeat(65) }`,
			]),
		}],
	})
	await assert.rejects(
		modules.prepareGnosisSafeExecutionSignerRoute(ethereum, insufficientSignatures, safeEntry, safeSignerAddress),
		/cannot satisfy its 3-signature threshold/u,
	)
	fakeGnosisSafeContract.threshold = 2n
	fakeGnosisSafeContract.owners = [safeSignerAddress]
	await assert.rejects(
		modules.prepareGnosisSafeExecutionSignerRoute(ethereum, insufficientSignatures, safeEntry, safeSignerAddress),
		/signature format that Interceptor cannot validate/u,
	)
})

test('changes the Gnosis Safe simulation signer only after validating current on-chain ownership', async () => {
	const alternateSigner = 0x1234567890123456789012345678901234567890n
	fakeGnosisSafeContract.owners = [recipientAddress, alternateSigner]
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		useAsActiveAddress: false,
		safeSimulationSignerAddress: recipientAddress,
		safeSignerAddresses: [recipientAddress, alternateSigner],
	})])

	const reply = await modules.setGnosisSafeSimulationSigner(
		createTestSimulationServicesOwner({ ethereum: ethereum, tokenPriceService: simulator.tokenPriceService }),
		new Map(),
		{
			method: 'popup_setSafeSimulationSigner',
			data: {
				chainId: fakeRpcNetwork.chainId,
				safeAddress: activeAddress,
				safeSimulationSignerAddress: alternateSigner,
			},
		},
	)

	assert.deepEqual(reply, { type: 'SetSafeSimulationSignerReply', ok: true })
	const updatedSafeEntry = (await modules.getUserAddressBookEntries())[0]
	assert.equal(updatedSafeEntry?.safeSimulationSignerAddress, alternateSigner)
	assert.deepEqual(updatedSafeEntry?.safeSignerAddresses, [recipientAddress, alternateSigner])
	assert.equal(updatedSafeEntry?.safeVersion, fakeGnosisSafeContract.version)
	assert.equal(fakeGnosisSafeContract.requestedCodeAddresses.includes(alternateSigner), true)

	fakeGnosisSafeContract.version = 'invalid-version'
	const unsupportedVersionFailure = await withSilencedConsole(async () => modules.setGnosisSafeSimulationSigner(
		createTestSimulationServicesOwner({ ethereum: ethereum, tokenPriceService: simulator.tokenPriceService }),
		new Map(),
		{
			method: 'popup_setSafeSimulationSigner',
			data: {
				chainId: fakeRpcNetwork.chainId,
				safeAddress: activeAddress,
				safeSimulationSignerAddress: recipientAddress,
			},
		},
	))
	fakeGnosisSafeContract.version = '1.4.1'
	assert.equal(unsupportedVersionFailure.ok, false)
	assert.match(unsupportedVersionFailure.message ?? '', /version invalid-version is not supported/u)
	assert.equal(await getLatestUnexpectedError(), undefined)

	fakeGnosisSafeContract.version = 'invalid-version'
	const { addOrModifyAddressBookEntry } = await import('../../app/ts/background/popupMessageHandlers.js')
	const unsupportedVersionSaveFailure = await withSilencedConsole(async () => addOrModifyAddressBookEntry(
		createTestSimulationServicesOwner({ ethereum: ethereum, tokenPriceService: simulator.tokenPriceService }),
		new Map(),
		{
			method: 'popup_addOrModifyAddressBookEntry',
			data: createGnosisSafeAddressBookEntry({
				useAsActiveAddress: false,
				safeSimulationSignerAddress: alternateSigner,
			}),
		},
	))
	fakeGnosisSafeContract.version = '1.4.1'
	assert.equal(unsupportedVersionSaveFailure.ok, false)
	assert.match(unsupportedVersionSaveFailure.message ?? '', /version invalid-version is not supported/u)
	assert.equal(await getLatestUnexpectedError(), undefined)
})

test('returns an explicit saved-signer error and refreshes the address book after access reconciliation fails', async () => {
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ useAsActiveAddress: true, safeSimulationSignerAddress: recipientAddress })])
	const socket = { tabId: 1, connectionName: 80n }
	const connection = { port: createWebsitePort(socket, 0, []), socket, websiteOrigin: 'saved-safe.test', approved: true, wantsToConnect: true }
	const connections = new Map([[1, { connections: { [modules.websiteSocketToString(socket)]: connection } }]])
	browserMock.setStorageGetHandler(async (keys, read) => {
		if (Array.isArray(keys) && keys.includes('openedPageV2')) throw new Error('Cannot read saved signer permissions')
		return read()
	})
	browserMock.sentMessages.length = 0
	try {
		const reply = await withSilencedConsole(async () => await modules.setGnosisSafeSimulationSigner(
			createTestSimulationServicesOwner({ ethereum, tokenPriceService: simulator.tokenPriceService }), connections,
			{ method: 'popup_setSafeSimulationSigner', data: { chainId: fakeRpcNetwork.chainId, safeAddress: activeAddress, safeSimulationSignerAddress: undefined } },
		))
		assert.equal(reply.ok, false)
		assert.match('message' in reply ? reply.message : '', /was saved, but website access could not be refreshed: Cannot read saved signer permissions/u)
		assert.equal(connection.approved, false)
		assert.equal(browserMock.sentMessages.some(message => message.method === 'popup_addressBookEntriesChanged'), true)
	} finally { browserMock.setStorageGetHandler(undefined) }
	const saved = (await modules.getUserAddressBookEntries())[0]
	assert.equal(saved?.safeSimulationSignerAddress, undefined)
	assert.deepEqual(saved?.safeSignerAddresses, fakeGnosisSafeContract.owners)
})

test('refreshes Gnosis Safe owner metadata and clears a stale simulation signer without choosing a replacement', async () => {
	const staleSigner = 0x1234567890123456789012345678901234567890n
	fakeGnosisSafeContract.owners = [recipientAddress]
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		useAsActiveAddress: false,
		safeSimulationSignerAddress: staleSigner,
		safeSignerAddresses: [staleSigner],
		safeVersion: '1.3.0',
	})])

	const reply = await modules.setGnosisSafeSimulationSigner(
		createTestSimulationServicesOwner({ ethereum: ethereum, tokenPriceService: simulator.tokenPriceService }),
		new Map(),
		{
			method: 'popup_setSafeSimulationSigner',
			data: {
				chainId: fakeRpcNetwork.chainId,
				safeAddress: activeAddress,
				safeSimulationSignerAddress: undefined,
			},
		},
	)

	assert.deepEqual(reply, { type: 'SetSafeSimulationSignerReply', ok: true })
	const updatedSafeEntry = (await modules.getUserAddressBookEntries())[0]
	assert.equal(updatedSafeEntry?.safeSimulationSignerAddress, undefined)
	assert.deepEqual(updatedSafeEntry?.safeSignerAddresses, [recipientAddress])
	assert.equal(updatedSafeEntry?.safeVersion, fakeGnosisSafeContract.version)
	assert.equal(fakeGnosisSafeContract.requestedCodeAddresses.includes(recipientAddress), false)
})

test('routes a completed active Gnosis Safe execution through its configured signer and rechecks signer changes', async () => {
	// Approvals of requests created in signing mode are only forwarded while the Interceptor is still in signing mode.
	await modules.changeSimulationMode({ simulationMode: false })
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const safeSignerAddress = recipientAddress
	const existingOwnerAccount = gnosisSafeTestOwnerAccount
	const existingOwnerAddress = gnosisSafeTestOwnerAddress
	const alternateSignerAddress = 0x3333333333333333333333333333333333333333n
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, fakeGnosisSafeContract.nonce)
	const existingSignature = await existingOwnerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
	fakeGnosisSafeContract.owners = [existingOwnerAddress, safeSignerAddress, alternateSignerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeSignerAddresses: [safeSignerAddress],
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [],
		activeSigningAddress: undefined,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			value: '0x0',
			data: encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [
				addressString(recipientAddress),
				0n,
				'0x',
				0n,
				0n,
				0n,
				0n,
				addressString(0n),
				addressString(0n),
				existingSignature,
			]),
		}],
	})
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...transactionParams,
	}

	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'transaction', parameters: transactionParams },
		false,
		activeAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [disconnectedExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(disconnectedExecution?.type, 'Transaction')
	if (disconnectedExecution?.type !== 'Transaction') throw new Error('Missing disconnected direct Gnosis Safe execution request')
	if (disconnectedExecution.safeFlow.kind !== 'directExecution') throw new Error('Expected a direct Gnosis Safe execution flow')
	assert.deepEqual(disconnectedExecution.safeFlow.safeExecutionOriginalRequestParameters, transactionParams)
	assert.equal(disconnectedExecution.safeFlow.safeExecutionSignerAddress, undefined)
	assert.notEqual(disconnectedExecution.safeFlow.safeExecutionReviewedSafeState, undefined)
	assert.equal(disconnectedExecution.approvalStatus.status, 'SignerError')

	await modules.updateTabState(socket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	fakeGnosisSafeContract.version = 'invalid-version'
	await withSilencedConsole(async () => modules.refreshPendingGnosisSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId))
	assert.equal(await getLatestUnexpectedError(), undefined)
	assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.approvalStatus.status, 'SignerError')
	fakeGnosisSafeContract.version = '1.4.1'
	await modules.refreshPendingGnosisSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
	const [pendingExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingExecution?.type, 'Transaction')
	if (pendingExecution?.type !== 'Transaction') throw new Error('Missing direct Gnosis Safe execution request')
	assert.equal(pendingExecution.transactionOrMessageCreationStatus, 'Simulated')
	if (pendingExecution.safeFlow.kind !== 'directExecution') throw new Error('Expected a direct Gnosis Safe execution flow')
	assert.equal(pendingExecution.safeFlow.safeExecutionSignerAddress, safeSignerAddress)
	assert.deepEqual(pendingExecution.safeFlow.safeExecutionOriginalRequestParameters, transactionParams)
	assert.equal(pendingExecution.activeAddress, safeSignerAddress)
	assert.equal(pendingExecution.originalRequestParameters.method, 'eth_sendTransaction')
	if (pendingExecution.originalRequestParameters.method !== 'eth_sendTransaction') throw new Error('Unexpected direct Gnosis Safe execution method')
	assert.equal(pendingExecution.originalRequestParameters.params[0].from, safeSignerAddress)
	const { refreshAndPersistGnosisSafeSignerSelection } = await import('../../app/ts/background/gnosisSafeSignerSelectionRefresh.js')
	await assert.rejects(
		refreshAndPersistGnosisSafeSignerSelection(
			simulator.ethereum,
			pendingExecution,
			alternateSignerAddress,
			async () => { throw new Error('Direct Gnosis Safe simulation refresh unavailable') },
		),
		/Direct Gnosis Safe simulation refresh unavailable/u,
	)
	assert.deepEqual((await modules.getPendingTransactionsAndMessages())[0], pendingExecution)
	fakeGnosisSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		await assert.rejects(
			modules.resolveGnosisSafeConfirmation(
				simulator.ethereum,
				pendingExecution,
				'accept',
				{ selectedSigner: safeSignerAddress, verificationError: undefined },
			),
			/Unexpected Gnosis Safe owner decoder failure/u,
		)
		await assert.rejects(
			modules.resolveGnosisSafeConfirmation(
				simulator.ethereum,
				pendingExecution,
				'accept',
				{ selectedSigner: alternateSignerAddress, verificationError: undefined },
			),
			/Unexpected Gnosis Safe owner decoder failure/u,
		)
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}

	fakeGnosisSafeContract.version = 'invalid-version'
	const unexpectedErrorBeforeUnsupportedVersion = (await getLatestUnexpectedError())?.data.code
	assert.equal(await withSilencedConsole(async () => modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		await createAcceptConfirmation(),
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	)), false)
	assert.equal((await getLatestUnexpectedError())?.data.code, unexpectedErrorBeforeUnsupportedVersion)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)

	assert.equal(await withSilencedConsole(async () => modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		await createAcceptConfirmation(),
		{ selectedSigner: alternateSignerAddress, verificationError: undefined },
	)), false)
	assert.equal((await getLatestUnexpectedError())?.data.code, unexpectedErrorBeforeUnsupportedVersion)
	fakeGnosisSafeContract.version = '1.4.1'
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		await createAcceptConfirmation(),
		{ selectedSigner: alternateSignerAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedExecution?.approvalStatus.status, 'WaitingForUser')
	assert.equal(refreshedExecution?.type === 'Transaction' && refreshedExecution.safeFlow.kind === 'directExecution' ? refreshedExecution.safeFlow.safeExecutionSignerAddress : undefined, alternateSignerAddress)
	assert.equal(refreshedExecution?.originalRequestParameters.method === 'eth_sendTransaction' ? refreshedExecution.originalRequestParameters.params[0].from : undefined, alternateSignerAddress)

	await modules.updateTabState(socket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	await modules.refreshPendingGnosisSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
	const [recoveredExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(recoveredExecution?.approvalStatus.status, 'WaitingForUser')

	fakeGnosisSafeContract.nonce += 1n
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		await createAcceptConfirmation(),
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [staleExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(staleExecution?.approvalStatus.status, 'SignerError')
	if (staleExecution?.approvalStatus.status !== 'SignerError') throw new Error('Missing stale Gnosis Safe execution error')
	assert.match(staleExecution.approvalStatus.message, /Gnosis Safe execution could not be prepared/u)

	fakeGnosisSafeContract.nonce -= 1n
	await modules.updateStoredPendingRequest(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	fakeGnosisSafeContract.owners = [...fakeGnosisSafeContract.owners, 0x1111111111111111111111111111111111111111n]
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		await createAcceptConfirmation(),
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [changedOwnersExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedOwnersExecution?.approvalStatus.status, 'SignerError')
	if (changedOwnersExecution?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-owner Gnosis Safe execution error')
	assert.match(changedOwnersExecution.approvalStatus.message, /owner set changed/u)

	fakeGnosisSafeContract.owners = [existingOwnerAddress, safeSignerAddress, alternateSignerAddress]
	await modules.updateStoredPendingRequest(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		await createAcceptConfirmation(),
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	), true)
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing direct Gnosis Safe execution signer request')
	const signerTransaction = signerRequest.params[0]
	if (!isRecord(signerTransaction)) throw new Error('Missing direct Gnosis Safe execution transaction parameters')
	assert.equal(signerRequest.method, 'eth_sendTransaction')
	assert.equal(signerTransaction.from, addressString(safeSignerAddress))
	assert.equal(signerTransaction.to, addressString(activeAddress))
	const prevalidatedSignerSignature = `0x${ safeSignerAddress.toString(16).padStart(64, '0') }${ '0'.repeat(64) }01`
	const completedSignatures = [
		{ signer: existingOwnerAddress, signature: existingSignature },
		{ signer: safeSignerAddress, signature: prevalidatedSignerSignature },
	]
		.sort((left, right) => left.signer < right.signer ? -1 : left.signer > right.signer ? 1 : 0)
		.map(({ signature }) => signature.slice(2))
		.join('')
	assert.equal(signerTransaction.data, encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [
		addressString(recipientAddress),
		0n,
		'0x',
		0n,
		0n,
		0n,
		0n,
		addressString(0n),
		addressString(0n),
		`0x${ completedSignatures }`,
	]))
	assert.equal(postedMessages.some((message) => isRecord(message) && message.method === 'eth_signTypedData_v4'), false)
	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), [])

	const transactionHash = `0x${ 'ab'.repeat(32) }`
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: transactionHash, uniqueRequestIdentifier },
	}), true)
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.type === 'result' && message.method === 'eth_sendTransaction' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing direct Gnosis Safe execution dapp reply')
	assert.equal(dappReply.result, transactionHash)
})

test('blocks direct Gnosis Safe execution when the configured signer cannot satisfy the threshold', async () => {
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const configuredSigner = recipientAddress
	const existingOwnerAccount = gnosisSafeTestOwnerAccount
	const existingOwnerAddress = gnosisSafeTestOwnerAddress
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, fakeGnosisSafeContract.nonce)
	const existingSignature = await existingOwnerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
	fakeGnosisSafeContract.threshold = 3n
	fakeGnosisSafeContract.owners = [existingOwnerAddress, configuredSigner, 0x1111111111111111111111111111111111111111n]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeSimulationSignerAddress: configuredSigner,
	})])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [configuredSigner],
		activeSigningAddress: configuredSigner,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [
				addressString(recipientAddress),
				0n,
				'0x',
				0n,
				0n,
				0n,
				0n,
				addressString(0n),
				addressString(0n),
				existingSignature,
			]),
		}],
	})
	const postedMessages: unknown[] = []
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, postedMessages)
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: {
				port,
				socket,
				websiteOrigin: 'https://sealwort.example',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	assert.deepEqual(await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			...transactionParams,
		},
		{ kind: 'transaction', parameters: transactionParams },
		false,
		activeAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	)), { type: 'doNotReply' })

	const [pendingFailure] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingFailure?.transactionOrMessageCreationStatus, 'FailedToSimulate')
	if (pendingFailure?.type !== 'Transaction' || !('transactionToSimulate' in pendingFailure)) throw new Error('Missing failed direct Gnosis Safe execution confirmation')
	assert.equal(pendingFailure.transactionToSimulate.success, false)
	if (pendingFailure.transactionToSimulate.success) throw new Error('Expected Gnosis Safe execution preparation failure')
	assert.match(pendingFailure.transactionToSimulate.error.message, /cannot satisfy its 3-signature threshold/u)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
})

test('direct Gnosis Safe execution checks delegate library bytecode before completing or forwarding owner signatures', async () => {
	const { spyOn } = await import('bun:test')
	const { encodeGnosisSafeBatch, GNOSIS_SAFE_MULTI_SEND_CALL_ONLY, GNOSIS_SAFE_SIGN_MESSAGE_LIB, GNOSIS_SAFE_SIGN_MESSAGE_ABI } = await import('../../app/ts/gnosisSafe/gnosisSafeDelegateCalls.js')
	const { stringToUint8Array, dataStringWith0xStart } = await import('../../app/ts/utils/bigint.js')
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const multiSend = await import('../fixtures/gnosis-safe-libraries/MultiSendCallOnly.json')
	const signMessage = await import('../fixtures/gnosis-safe-libraries/SignMessageLib.json')
	fakeGnosisSafeContract.owners = [gnosisSafeTestOwnerAddress]
	fakeGnosisSafeContract.threshold = 1n
	const safeEntry = createGnosisSafeAddressBookEntry({ safeVersion: '1.4.1' })
	const originalGetCode = simulator.ethereum.getCode.bind(simulator.ethereum)
	let libraryCode = new Uint8Array()
	const blocks: bigint[] = []
	const getCode = spyOn(simulator.ethereum, 'getCode').mockImplementation(async (address, block, abortController) => {
		if (address !== GNOSIS_SAFE_MULTI_SEND_CALL_ONLY && address !== GNOSIS_SAFE_SIGN_MESSAGE_LIB) return await originalGetCode(address, block, abortController)
		blocks.push(block)
		return libraryCode
	})
	try {
		for (const { to, data, bytecode } of [
			{ to: GNOSIS_SAFE_MULTI_SEND_CALL_ONLY, data: dataStringWith0xStart(encodeGnosisSafeBatch([{ to: recipientAddress, value: 0n, data: new Uint8Array() }, { to: recipientAddress, value: 1n, data: new Uint8Array() }])), bytecode: multiSend.default.deployedBytecode },
			{ to: GNOSIS_SAFE_SIGN_MESSAGE_LIB, data: encodeFunctionCall(GNOSIS_SAFE_SIGN_MESSAGE_ABI, 'signMessage', ['0x' + '12'.repeat(32)]), bytecode: signMessage.default.deployedBytecode },
		]) for (const signatures of ['0x', '0x' + '00'.repeat(65)]) {
			const request = SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [{ from: addressString(activeAddress), to: addressString(activeAddress), data: encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [addressString(to), 0n, data, 1n, 0n, 0n, 0n, addressString(0n), addressString(0n), signatures]) }] })
			for (const invalidCode of [new Uint8Array(), new Uint8Array([1])]) {
				libraryCode = invalidCode
				await assert.rejects(modules.prepareGnosisSafeExecutionSignerRoute(simulator.ethereum, request, safeEntry, gnosisSafeTestOwnerAddress), /missing or has unexpected bytecode/)
			}
			libraryCode = stringToUint8Array(bytecode)
			const route = await modules.prepareGnosisSafeExecutionSignerRoute(simulator.ethereum, request, safeEntry, gnosisSafeTestOwnerAddress)
			assert.equal(route?.executor, gnosisSafeTestOwnerAddress)
			assert.equal(route?.transactionParams.params[0].from, gnosisSafeTestOwnerAddress)
		}
		assert.equal(blocks.length, 12)
		assert.ok(blocks.every((block) => block === 123n))
	} finally { getCode.mockRestore() }
})
