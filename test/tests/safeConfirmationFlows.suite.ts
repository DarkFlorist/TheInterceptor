import * as assert from 'assert'
import { beforeAll, test } from 'bun:test'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { activeAddress, addressString, browserMock, created, createSafeTx, createWebsitePort, EIP712Message, ethereum, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, hexToBytes, isRecord, modules, oldTimestamp, pendingTransaction, privateKeyToAccount, recipientAddress, resetFakeSafeContractState, SAFE_EXECUTION_ABI, safeTxToTypedDataJson, signedTransaction, simulator, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'

beforeAll(async () => {
	browserMock.reset()
	resetFakeSafeContractState()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
})

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

	await modules.signerReply(simulator.ethereum, simulator.tokenPriceService, () => undefined, websiteTabConnections, childPort, {
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

test('forwards a Safe transaction to the configured Safe signer as EIP-712 typed data', async () => {
	resetFakeSafeContractState()
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [recipientAddress],
		activeSigningAddress: recipientAddress,
	}))
	const safeAddressBookEntry = {
		type: 'safe' as const,
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User' as const,
		useAsActiveAddress: true,
		safeSignerAddress: recipientAddress,
	}
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
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			safeTransaction: {
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
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				safeTx,
			},
		}],
	})

	const alternateSigner = 0x2222222222222222222222222222222222222222n
	await modules.updateUserAddressBookEntries(() => [{ ...safeAddressBookEntry, safeSignerAddress: alternateSigner }])
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [changedSignerProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedSignerProposal?.approvalStatus.status, 'SignerError')
	if (changedSignerProposal?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-signer Gnosis Safe proposal error')
	assert.match(changedSignerProposal.approvalStatus.message, /configured Gnosis Safe signer changed/u)

	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	fakeSafeContract.owners = [0x1111111111111111111111111111111111111111n]
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [changedOwnersProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedOwnersProposal?.approvalStatus.status, 'SignerError')
	if (changedOwnersProposal?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-owner Gnosis Safe proposal error')
	assert.match(changedOwnersProposal.approvalStatus.message, /owner set changed/u)

	fakeSafeContract.owners = []
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), true)

	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing Safe signer request')
	assert.equal(signerRequest.method, 'eth_signTypedData_v4')
	assert.equal(signerRequest.params[0], addressString(recipientAddress))
	assert.equal(typeof signerRequest.params[1], 'string')
	const typedData = JSON.parse(String(signerRequest.params[1]))
	assert.equal(typedData.primaryType, 'SafeTx')
	assert.equal(typedData.domain.chainId, fakeRpcNetwork.chainId.toString())
	assert.equal(typedData.message.to.toLowerCase(), `0x${ recipientAddress.toString(16).padStart(40, '0') }`)
})

test('routes a Safe co-signing request through the configured signer of the active Safe', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd')
	const safeSignerAddress = BigInt(ownerAccount.address)
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	fakeSafeContract.owners = [safeSignerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress,
		safeVersion: '1.4.1',
	}])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress, recipientAddress],
		activeSigningAddress: recipientAddress,
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
			simulator.ethereum,
			simulator.tokenPriceService,
			() => undefined,
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
		params: [activeAddress, EIP712Message.parse(safeTxToTypedDataJson(safeTx))] as const,
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
		signRequest,
		false,
		activeAddress,
		website,
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [reviewedCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.notEqual(reviewedCoSignRequest?.type === 'SignableMessage' ? reviewedCoSignRequest.safeMessageCoSignSnapshot : undefined, undefined)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), false)
	const [mismatchedCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(mismatchedCoSignRequest?.approvalStatus.status, 'SignerError')
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	fakeSafeContract.owners = [...fakeSafeContract.owners, 0x1111111111111111111111111111111111111111n]
	await modules.confirmDialog(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	})
	await accountReply
	assert.equal(postedMessages.some((message) => isRecord(message) && message.method === 'request_signer_to_eth_accounts'), true)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [changedCoSignState] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedCoSignState?.approvalStatus.status, 'SignerError')
	if (changedCoSignState?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-state Safe co-signing error')
	assert.match(changedCoSignState.approvalStatus.message, /owner set changed/u)

	fakeSafeContract.owners = [safeSignerAddress]
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), true)

	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing Safe co-signer request')
	assert.equal(signerRequest.method, 'eth_signTypedData_v4')
	assert.equal(signerRequest.params[0], addressString(safeSignerAddress))
	assert.equal(JSON.parse(String(signerRequest.params[1])).domain.verifyingContract.toLowerCase(), addressString(activeAddress).toLowerCase())

	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	await modules.updateUserAddressBookEntries((entries) => entries.map((entry) =>
		entry.type === 'safe' && entry.address === activeAddress
			? { ...entry, safeSignerAddress: 0x2222222222222222222222222222222222222222n }
			: entry
	))
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), false)
	const changedSignerReply = postedMessages.find((message) =>
		isRecord(message) && message.type === 'result' && message.method === 'eth_signTypedData_v4' && message.requestId === uniqueRequestIdentifier.requestId
	)
	assert.equal(changedSignerReply, undefined)

	await modules.updateUserAddressBookEntries((entries) => entries.map((entry) =>
		entry.type === 'safe' && entry.address === activeAddress ? { ...entry, safeSignerAddress } : entry
	))
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForSigner' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), true)
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.type === 'result' && message.method === 'eth_signTypedData_v4' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing Safe co-signature reply')
	assert.equal(dappReply.result, signature)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})

test('recognizes only execTransaction calls to the active Safe for direct signer execution', async () => {
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const safeSignerAddress = 0x1234567890123456789012345678901234567890n
	const safeEntry = {
		type: 'safe' as const,
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User' as const,
		useAsActiveAddress: true,
		safeSignerAddress,
	}
	const transaction = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: '0x6a76120200',
		}],
	})

	assert.equal(modules.isSafeExecutionRequestForActiveSafe(transaction, safeEntry), true)
	assert.deepEqual(modules.getSafeExecutionSignerRoute(transaction, safeEntry), {
		executor: safeSignerAddress,
		transactionParams: {
			method: 'eth_sendTransaction',
			params: [{
				...transaction.params[0],
				from: safeSignerAddress,
			}],
		},
	})
	assert.equal(modules.isSafeExecutionRequestForActiveSafe(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(recipientAddress),
			to: addressString(activeAddress),
			data: '0x6a76120200',
		}],
	}), safeEntry), false)
	assert.equal(modules.isSafeExecutionRequestForActiveSafe(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			data: '0x6a76120200',
		}],
	}), safeEntry), false)
	assert.equal(modules.isSafeExecutionRequestForActiveSafe(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: '0xa9059cbb',
		}],
	}), safeEntry), false)
	assert.equal(modules.isSafeExecutionRequestForActiveSafe(transaction, { ...safeEntry, safeSignerAddress: undefined }), false)
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
		modules.prepareSafeExecutionSignerRoute(ethereum, nonzeroOuterValue, safeEntry),
		/A direct Gnosis Safe execution transaction must have zero outer ETH value/u,
	)
	fakeSafeContract.threshold = 3n
	const insufficientSignatures = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
				addressString(recipientAddress), 0n, '0x', 0n, 0n, 0n, 0n,
				addressString(0n), addressString(0n), `0x${ '00'.repeat(65) }`,
			]),
		}],
	})
	await assert.rejects(
		modules.prepareSafeExecutionSignerRoute(ethereum, insufficientSignatures, safeEntry),
		/cannot satisfy its 3-signature threshold/u,
	)
	fakeSafeContract.threshold = 2n
	fakeSafeContract.owners = [safeSignerAddress]
	await assert.rejects(
		modules.prepareSafeExecutionSignerRoute(ethereum, insufficientSignatures, safeEntry),
		/signature format that Interceptor cannot validate/u,
	)
	resetFakeSafeContractState()
})

test('changes the active Safe signer without revalidating the Safe contract', async () => {
	resetFakeSafeContractState()
	const alternateSigner = 0x1234567890123456789012345678901234567890n
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: false,
		safeSignerAddress: recipientAddress,
		safeSignerAddresses: [recipientAddress, alternateSigner],
	}])

	const reply = await modules.setActiveSafeSigner(
		ethereum,
		simulator.tokenPriceService,
		() => undefined,
		new Map(),
		{
			method: 'popup_setActiveSafeSigner',
			data: {
				chainId: fakeRpcNetwork.chainId,
				safeAddress: activeAddress,
				safeSignerAddress: alternateSigner,
			},
		},
	)

	assert.deepEqual(reply, { type: 'SetActiveSafeSignerReply', ok: true })
	assert.equal((await modules.getUserAddressBookEntries())[0]?.safeSignerAddress, alternateSigner)
	assert.deepEqual(fakeSafeContract.requestedRpcMethods, [])
})

test('routes a completed active Safe execution through its configured signer and rechecks signer changes', async () => {
	resetFakeSafeContractState()
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const safeSignerAddress = recipientAddress
	const existingOwnerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const existingOwnerAddress = BigInt(existingOwnerAccount.address)
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, fakeSafeContract.nonce)
	const existingSignature = await existingOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	fakeSafeContract.owners = [existingOwnerAddress, safeSignerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress,
	}])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			value: '0x0',
			data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
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
			gas: '0x5208',
			maxFeePerGas: '0x0',
			maxPriorityFeePerGas: '0x0',
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
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingExecution?.type, 'Transaction')
	if (pendingExecution?.type !== 'Transaction') throw new Error('Missing direct Safe execution request')
	assert.equal(pendingExecution.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(pendingExecution.safeTransaction, undefined)
	assert.equal(pendingExecution.safeExecutionSignerAddress, safeSignerAddress)
	assert.deepEqual(pendingExecution.safeExecutionOriginalRequestParameters, transactionParams)
	assert.equal(pendingExecution.activeAddress, safeSignerAddress)
	assert.equal(pendingExecution.originalRequestParameters.method, 'eth_sendTransaction')
	if (pendingExecution.originalRequestParameters.method !== 'eth_sendTransaction') throw new Error('Unexpected direct Safe execution method')
	assert.equal(pendingExecution.originalRequestParameters.params[0].from, safeSignerAddress)

	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: activeAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [mismatchedExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(mismatchedExecution?.approvalStatus.status, 'SignerError')

	await modules.updateTabState(socket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
	const [recoveredExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(recoveredExecution?.approvalStatus.status, 'WaitingForUser')

	fakeSafeContract.nonce += 1n
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [staleExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(staleExecution?.approvalStatus.status, 'SignerError')
	if (staleExecution?.approvalStatus.status !== 'SignerError') throw new Error('Missing stale Gnosis Safe execution error')
	assert.match(staleExecution.approvalStatus.message, /Gnosis Safe execution could not be prepared/u)

	fakeSafeContract.nonce -= 1n
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	fakeSafeContract.owners = [...fakeSafeContract.owners, 0x1111111111111111111111111111111111111111n]
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [changedOwnersExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedOwnersExecution?.approvalStatus.status, 'SignerError')
	if (changedOwnersExecution?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-owner Gnosis Safe execution error')
	assert.match(changedOwnersExecution.approvalStatus.message, /owner set changed/u)

	fakeSafeContract.owners = [existingOwnerAddress, safeSignerAddress]
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	assert.equal(await modules.resolvePendingTransactionOrMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		websiteTabConnections,
		{
			method: 'popup_confirmDialog',
			data: { action: 'accept', uniqueRequestIdentifier },
		},
		{ selectedSigner: safeSignerAddress, verificationError: undefined },
	), true)
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing direct Safe execution signer request')
	const signerTransaction = signerRequest.params[0]
	if (!isRecord(signerTransaction)) throw new Error('Missing direct Safe execution transaction parameters')
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
	assert.equal(signerTransaction.data, encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
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
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])

	const transactionHash = `0x${ 'ab'.repeat(32) }`
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: transactionHash, uniqueRequestIdentifier },
	}), true)
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.type === 'result' && message.method === 'eth_sendTransaction' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing direct Safe execution dapp reply')
	assert.equal(dappReply.result, transactionHash)
})

test('blocks direct Safe execution when the configured signer cannot satisfy the threshold', async () => {
	resetFakeSafeContractState()
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const configuredSigner = recipientAddress
	const existingOwnerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const existingOwnerAddress = BigInt(existingOwnerAccount.address)
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, fakeSafeContract.nonce)
	const existingSignature = await existingOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	fakeSafeContract.threshold = 3n
	fakeSafeContract.owners = [existingOwnerAddress, configuredSigner, 0x1111111111111111111111111111111111111111n]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress: configuredSigner,
	}])
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
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
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' },
		websiteTabConnections,
	)), { type: 'doNotReply' })

	const [pendingFailure] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingFailure?.transactionOrMessageCreationStatus, 'FailedToSimulate')
	if (pendingFailure?.type !== 'Transaction' || !('transactionToSimulate' in pendingFailure)) throw new Error('Missing failed direct Safe execution confirmation')
	assert.equal(pendingFailure.transactionToSimulate.success, false)
	if (pendingFailure.transactionToSimulate.success) throw new Error('Expected Safe execution preparation failure')
	assert.match(pendingFailure.transactionToSimulate.error.message, /cannot satisfy its 3-signature threshold/u)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
})

test('rejects EIP-7702 authorization lists before creating a Safe proposal', async () => {
	resetFakeSafeContractState()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	}])
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			type: '0x4',
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			authorizationList: [{
				chainId: '0x1',
				address: '0x0000000000000000000000000000000000000000',
				nonce: '0x0',
				yParity: '0x0',
				r: '0x1',
				s: '0x2',
			}],
		}],
	})
	const postedMessages: unknown[] = []
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages)
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	const reply = await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: transactionParams.method,
			params: transactionParams.params,
		},
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	)

	assert.equal(reply.type, 'result')
	assert.equal('error' in reply ? reply.error.code : undefined, 4200)
	assert.match('error' in reply ? reply.error.message : '', /do not support EIP-7702 authorization lists/u)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('shows stale local Safe stack failures in the transaction confirmation', async () => {
	resetFakeSafeContractState()
	fakeSafeContract.nonce = 1n
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [{
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [],
	}])
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	}])
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0x',
		}],
	})
	const postedMessages: unknown[] = []
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages)
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	const reply = await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: transactionParams.method,
			params: transactionParams.params,
		},
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	))

	assert.deepEqual(reply, { type: 'doNotReply' })
	const [pendingFailure] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingFailure?.transactionOrMessageCreationStatus, 'FailedToSimulate')
	if (pendingFailure?.type !== 'Transaction' || !('transactionToSimulate' in pendingFailure)) throw new Error('Missing failed Safe confirmation')
	assert.equal(pendingFailure.transactionToSimulate.success, false)
	if (pendingFailure.transactionToSimulate.success) throw new Error('Expected Safe preparation failure')
	assert.match(pendingFailure.transactionToSimulate.error.message, /current Gnosis Safe nonce 1 is beyond this stack's final nonce 0/u)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.transactionOrMessageCreationStatus, 'FailedToSimulate')

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('reconciles executed Safe operations before simulating the next proposal', async () => {
	resetFakeSafeContractState()
	const firstSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const secondSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 1n)
	const transactions = [firstSafeTx, secondSafeTx].map((safeTx, index) => ({
		safeTx,
		safeTxHash: BigInt(getSafeTxHash(safeTx)),
		created,
		websiteOrigin: 'https://example.com',
		transactionIdentifier: 80n + BigInt(index),
		signatures: [],
	}))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: { requestId: 404, requestSocket: uniqueRequestIdentifier.requestSocket },
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				safeTxHash: transactions[0]?.safeTxHash ?? 0n,
				safeTx: firstSafeTx,
			},
		}],
	})
	await modules.updateSafeTransactionStacks(() => [{
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions,
	}])
	await modules.updateInterceptorTransactionStack(() => ({
		operations: transactions.map((safeTransaction) => ({
			type: 'Transaction' as const,
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				signedTransaction,
				transactionIdentifier: safeTransaction.transactionIdentifier,
				safeTransaction,
			},
		})),
	}))
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	}])
	fakeSafeContract.nonce = 1n
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x2',
			data: '0x',
		}],
	})
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 2n,
		input: new Uint8Array(),
	}, 2n)))
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, [])
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: transactionParams.method,
			params: transactionParams.params,
		},
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [storedStack] = await modules.getSafeTransactionStacks()
	assert.equal(storedStack?.baseNonce, 1n)
	assert.deepEqual(storedStack?.transactions.map(({ transactionIdentifier }) => transactionIdentifier), [81n])
	const storedOperations = (await modules.getInterceptorTransactionStack()).operations
	assert.deepEqual(storedOperations.map((operation) => operation.type === 'Transaction' ? operation.preSimulationTransaction.transactionIdentifier : undefined), [81n])
	const pendingProposal = (await modules.getPendingTransactionsAndMessages()).find((pending) =>
		pending.uniqueRequestIdentifier.requestId === uniqueRequestIdentifier.requestId
	)
	assert.equal(pendingProposal?.safeTransaction?.safeTx.message.nonce, 2n)

		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
		await modules.updateSafeTransactionStacks(() => [])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
		await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('uses zero-reimbursement Safe semantics in the pre-sign confirmation simulation', async () => {
	resetFakeSafeContractState()
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
	})
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const popupVisualisation = await (await import('../../app/ts/background/background.js')).refreshConfirmTransactionSimulation(
		simulator.ethereum,
		simulator.tokenPriceService,
		activeAddress,
		false,
		uniqueRequestIdentifier,
		pendingTransaction.transactionToSimulate,
		{
			safeAddress: activeAddress,
			safeSignerAddress: recipientAddress,
			safeVersion: '1.4.1',
			threshold: 2n,
			safeTxHash,
			safeTx,
			executionGasLimit: 123_456n,
		},
	)

	assert.equal(popupVisualisation?.statusCode, 'success')
	if (popupVisualisation?.statusCode !== 'success') throw new Error('Safe confirmation simulation failed')
	assert.equal(popupVisualisation.data.simulationState.simulationStateInput.at(-1)?.simulateWithZeroBaseFee, true)
	if (!popupVisualisation.data.visualizedSimulationState.success) {
		throw new Error('Safe confirmation visualization failed')
	}
	const simulatedSafeTransaction = popupVisualisation.data.visualizedSimulationState.visualizedBlocks
		.at(-1)?.simulatedAndVisualizedTransactions.at(-1)
	assert.equal(simulatedSafeTransaction?.safeTransaction?.safeTxHash, safeTxHash)
	assert.equal(simulatedSafeTransaction?.realizedGasPrice, 0n)
	assert.equal(simulatedSafeTransaction?.transaction.gas, 123_456n)
})

test('prepares Safe transaction intent without charging gas to the Safe', async () => {
	resetFakeSafeContractState()
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0xa9059cbb',
			maxFeePerGas: '0x1234',
			maxPriorityFeePerGas: '0x42',
		}],
	})

	const prepared = await modules.formEthSendTransaction(
		simulator.ethereum,
		undefined,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		transactionParams,
		created,
		1n,
		false,
		'external-executor',
	)

	assert.equal(prepared.success, true)
	if (!prepared.success) throw new Error('Safe transaction intent preparation failed')
	assert.equal(prepared.transaction.from, activeAddress)
	assert.equal(prepared.transaction.to, recipientAddress)
	assert.equal(prepared.transaction.value, 0n)
	assert.deepEqual(prepared.transaction.input, hexToBytes('0xa9059cbb'))
	assert.equal(prepared.transaction.gas, 32_813n)
	assert.equal(prepared.transaction.maxFeePerGas, 0n)
	assert.equal(prepared.transaction.maxPriorityFeePerGas, 0n)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_getBalance'), false)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_estimateGas'), false)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), true)
})

test('does not fall back to ordinary gas estimation when Safe simulation state is unavailable', async () => {
	resetFakeSafeContractState()
	fakeSafeContract.failEthSimulate = true
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0xa9059cbb',
		}],
	})

	const prepared = await withSilencedConsole(async () => await modules.formEthSendTransaction(
		simulator.ethereum,
		undefined,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		transactionParams,
		created,
		1n,
		false,
		'external-executor',
	))

	assert.equal(prepared.success, false)
	if (prepared.success) throw new Error('Safe gas preparation unexpectedly succeeded')
	assert.match(prepared.error.message, /eth_simulateV1 unavailable|requires the Interceptor simulator/u)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_getBalance'), false)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_estimateGas'), false)
})

test('refreshes pending Safe intent without charging gas to the Safe', async () => {
	resetFakeSafeContractState()
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
	})
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0xa9059cbb',
			maxFeePerGas: '0x1234',
			maxPriorityFeePerGas: '0x42',
		}],
	})
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: hexToBytes('0xa9059cbb'),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			originalRequestParameters: transactionParams,
			simulationMode: false,
			transactionToSimulate: {
				...pendingTransaction.transactionToSimulate,
				originalRequestParameters: transactionParams,
			},
			safeTransaction: {
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
				safeTxHash,
				safeTx,
				executionGasLimit: 32_813n,
			},
		}],
	})

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	const [refreshed] = await modules.getPendingTransactionsAndMessages()
	if (refreshed?.type !== 'Transaction' || refreshed.transactionOrMessageCreationStatus !== 'Simulated') {
		throw new Error('Pending Safe transaction was not refreshed')
	}
	assert.equal(refreshed.transactionToSimulate.transaction.maxFeePerGas, 0n)
	assert.equal(refreshed.transactionToSimulate.transaction.maxPriorityFeePerGas, 0n)
	assert.equal(refreshed.safeTransaction?.executionGasLimit, 32_813n)
	assert.deepEqual(refreshed.transactionToSimulate.transaction.input, hexToBytes('0xa9059cbb'))
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_getBalance'), false)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_estimateGas'), false)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), true)
})

test('shows a Safe signer mismatch in the confirmation popup and never forwards it', async () => {
	resetFakeSafeContractState()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
	})
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	}])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerName: 'MetaMask',
		signerAccounts: [activeAddress],
		activeSigningAddress: activeAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0x',
			gas: '0x5208',
		}],
	})
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	const postedMessages: unknown[] = []
	const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages)
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port,
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		method: transactionParams.method,
		params: transactionParams.params,
	}

	assert.deepEqual(await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		transactionParams,
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingMismatch] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingMismatch?.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(pendingMismatch?.approvalStatus.status, 'SignerError')
	if (pendingMismatch?.approvalStatus.status !== 'SignerError') throw new Error('Missing Safe signer mismatch')
	assert.match(pendingMismatch.approvalStatus.message, /Gnosis Safe signer mismatch/u)
	assert.match(pendingMismatch.approvalStatus.message, /Select 0x[0-9A-Fa-f]{40} in MetaMask, then retry\./u)
	assert.match(pendingMismatch.approvalStatus.message.toLowerCase(), new RegExp(addressString(recipientAddress).toLowerCase(), 'u'))
	assert.match(pendingMismatch.approvalStatus.message.toLowerCase(), new RegExp(addressString(activeAddress).toLowerCase(), 'u'))
	assert.equal(pendingMismatch.type === 'Transaction' && pendingMismatch.safeTransaction !== undefined, true)

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('refreshes the selected signer before forwarding a Safe transaction', async () => {
	resetFakeSafeContractState()
	const configuredSigner = recipientAddress
	const freshlySelectedSigner = activeAddress
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress: configuredSigner,
	}])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerName: 'MetaMask',
		signerAccounts: [configuredSigner],
		activeSigningAddress: configuredSigner,
		signerChain: fakeRpcNetwork.chainId,
	}))
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: configuredSigner,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [], threshold: 2n },
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				safeTx,
			},
		}],
	})
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
			simulator.ethereum,
			simulator.tokenPriceService,
			() => undefined,
			websiteTabConnections,
			port,
			{
				method: 'eth_accounts_reply',
				params: [{
					signerProviderGeneration: 1,
					type: 'success',
					accounts: [addressString(freshlySelectedSigner)],
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
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	await modules.confirmDialog(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	})
	await accountReply

	assert.equal(postedMessages.some((message) => isRecord(message) && message.method === 'request_signer_to_eth_accounts'), true)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedMismatch] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedMismatch?.approvalStatus.status, 'SignerError')
	if (refreshedMismatch?.approvalStatus.status !== 'SignerError') throw new Error('Missing refreshed Safe signer mismatch')
	assert.match(refreshedMismatch.approvalStatus.message.toLowerCase(), new RegExp(addressString(freshlySelectedSigner).toLowerCase(), 'u'))

	await modules.ethAccountsReply(
		simulator.ethereum,
		simulator.tokenPriceService,
		() => undefined,
		websiteTabConnections,
		port,
		{
			method: 'eth_accounts_reply',
			params: [{
				signerProviderGeneration: 1,
				type: 'success',
				accounts: [addressString(configuredSigner)],
				requestAccounts: false,
			}],
		},
		'hasAccess',
		activeAddress,
	)
	const [readyAfterAccountChange] = await modules.getPendingTransactionsAndMessages()
	assert.equal(readyAfterAccountChange?.approvalStatus.status, 'WaitingForUser')
})

test('rebases a later pending Safe proposal after an earlier nonce is rejected', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const safeSignerAddress = BigInt(ownerAccount.address)
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress,
	}])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	const firstIdentifier = { requestId: 31, requestSocket: uniqueRequestIdentifier.requestSocket }
	const secondIdentifier = { requestId: 32, requestSocket: uniqueRequestIdentifier.requestSocket }
	const firstSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const rebasedSafeTx = firstSafeTx
	const secondSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 1n)
	const rebasedSafeTxHash = BigInt(getSafeTxHash(rebasedSafeTx))
	fakeSafeContract.transactionHash = rebasedSafeTxHash
	const makePendingSafeTransaction = (requestIdentifier: typeof firstIdentifier, safeTx: typeof firstSafeTx, transactionIdentifier: bigint) => ({
		...pendingTransaction,
		uniqueRequestIdentifier: requestIdentifier,
		transactionIdentifier,
		simulationMode: false as const,
		approvalStatus: { status: 'WaitingForUser' as const },
		safeTransaction: {
			safeAddress: activeAddress,
			safeSignerAddress,
			safeVersion: '1.4.1',
			threshold: 2n,
			reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [], threshold: 2n },
			safeTxHash: BigInt(getSafeTxHash(safeTx)),
			safeTx,
		},
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

	const postedMessages: unknown[] = []
	const socket = secondIdentifier.requestSocket
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
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: secondIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedProposal] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedProposal?.safeTransaction?.safeTx.message.nonce, 0n)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: secondIdentifier },
	}), true)
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing rebased Safe signer request')
	const typedData = EIP712Message.parse(signerRequest.params[1])
	assert.equal(typedData.message.nonce, 0n)

	const signature = await ownerAccount.signTypedData(typedData)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier: secondIdentifier },
	}), true)
	const [safeStack] = await modules.getSafeTransactionStacks()
	assert.equal(safeStack?.baseNonce, 0n)
	assert.equal(safeStack?.transactions[0]?.safeTxHash, rebasedSafeTxHash)
})

test('rejects a stale forwarded Safe nonce before persistence and rebases it when retried', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const safeSignerAddress = BigInt(ownerAccount.address)
	await modules.updateUserAddressBookEntries(() => [{
		type: 'safe',
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User',
		useAsActiveAddress: true,
		safeSignerAddress,
	}])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [safeSignerAddress],
		activeSigningAddress: safeSignerAddress,
	}))
	const requestIdentifier = { requestId: 33, requestSocket: uniqueRequestIdentifier.requestSocket }
	const staleSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 1n)
	const rebasedSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(rebasedSafeTx))
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: requestIdentifier,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress,
					safeVersion: '1.4.1',
					threshold: 2n,
					reviewedSafeState: { version: '1.4.1', nonce: 0n, owners: [], threshold: 2n },
					safeTxHash: BigInt(getSafeTxHash(staleSafeTx)),
				safeTx: staleSafeTx,
			},
		}],
	})
	const staleSignature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(staleSafeTx)))

	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, new Map(), {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: staleSignature, uniqueRequestIdentifier: requestIdentifier },
	}), false)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	const [stalePending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(stalePending?.approvalStatus.status, 'SignerError')
	if (stalePending?.approvalStatus.status !== 'SignerError') throw new Error('Missing stale Safe nonce signer error')
	assert.match(stalePending.approvalStatus.message, /next available nonce is 0/u)

	const postedMessages: unknown[] = []
	const socket = requestIdentifier.requestSocket
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
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: requestIdentifier },
	}), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedPending?.safeTransaction?.safeTx.message.nonce, 0n)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier: requestIdentifier },
	}), true)
	const signerRequest = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(signerRequest) || !Array.isArray(signerRequest.params)) throw new Error('Missing retried Safe signer request')
	assert.equal(EIP712Message.parse(signerRequest.params[1]).message.nonce, 0n)
})

test('persists and simulates a valid Safe owner signature before replying with the canonical Safe hash', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const safeSignerAddress = BigInt(ownerAccount.address)
	const safeAddressBookEntry = {
		type: 'safe' as const,
		name: 'Treasury Safe',
		address: activeAddress,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User' as const,
		useAsActiveAddress: true,
		safeSignerAddress,
	}
	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
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
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
	})
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				reviewedSafeState: {
					version: '1.4.1',
					nonce: 0n,
					owners: [],
					threshold: 2n,
				},
				safeTxHash,
				safeTx,
			},
		}],
	})

	await modules.updateUserAddressBookEntries(() => [{
		...safeAddressBookEntry,
		safeSignerAddress: 0x2222222222222222222222222222222222222222n,
	}])
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), false)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])

	await modules.updateUserAddressBookEntries(() => [safeAddressBookEntry])
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForSigner' as const },
	}))
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
	const simulationInput = await (await import('../../app/ts/background/simulationUpdating.js')).getCurrentSimulationInput()
	const safeSimulationBlock = simulationInput.find((block) => block.transactions.some((transaction) =>
		transaction.safeTransaction?.safeTxHash === safeTxHash
	))
	assert.equal(safeSimulationBlock?.simulateWithZeroBaseFee, true)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	const dappReply = postedMessages.find((message) =>
		isRecord(message) && message.method === 'eth_sendTransaction' && message.requestId === uniqueRequestIdentifier.requestId
	)
	if (!isRecord(dappReply)) throw new Error('Missing Safe transaction dapp reply')
	assert.equal(dappReply.result, modules.EthereumBytes32.serialize(safeTxHash))
})

test('invalid Safe owner signatures retain the request as a signer error without creating a Safe stack', async () => {
	resetFakeSafeContractState()
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	await modules.updateSafeTransactionStacks(() => [])
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			approvalStatus: { status: 'WaitingForSigner' },
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				safeTxHash: BigInt(getSafeTxHash(safeTx)),
				safeTx,
			},
		}],
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
