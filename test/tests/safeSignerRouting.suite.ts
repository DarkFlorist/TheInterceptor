import * as assert from 'assert'
import { test } from 'bun:test'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { activeAddress, addressString, browserMock, createSafeAddressBookEntry, createSafeTx, createWebsitePort, EIP712Message, ethereum, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, isRecord, modules, oldTimestamp, pendingTransaction, privateKeyToAccount, recipientAddress, SAFE_EXECUTION_ABI, safeTestOwnerAccount, safeTestOwnerAddress, safeTxToTypedDataJson, signedTransaction, simulator, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'

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
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [recipientAddress],
		activeSigningAddress: recipientAddress,
	}))
	const safeAddressBookEntry = createSafeAddressBookEntry({
		safeSignerAddress: recipientAddress,
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
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSignerAddress,
		safeVersion: '1.4.1',
	})])
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
	const signerCodeReadsBeforeReply = fakeSafeContract.requestedCodeAddresses.filter((address) => address === safeSignerAddress).length
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
	const signerCodeReadsAfterReply = fakeSafeContract.requestedCodeAddresses.filter((address) => address === safeSignerAddress).length
	assert.equal(signerCodeReadsAfterReply - signerCodeReadsBeforeReply, 1)
})

test('recognizes only execTransaction calls to the active Safe for direct signer execution', async () => {
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const safeSignerAddress = 0x1234567890123456789012345678901234567890n
	const safeEntry = createSafeAddressBookEntry({
		safeSignerAddress,
	})
	const transaction = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: '0x6a76120200',
		}],
	})

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
	assert.equal(modules.getSafeExecutionSignerRoute(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(recipientAddress),
			to: addressString(activeAddress),
			data: '0x6a76120200',
		}],
	}), safeEntry), undefined)
	assert.equal(modules.getSafeExecutionSignerRoute(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			data: '0x6a76120200',
		}],
	}), safeEntry), undefined)
	assert.equal(modules.getSafeExecutionSignerRoute(SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(activeAddress),
			data: '0xa9059cbb',
		}],
	}), safeEntry), undefined)
	assert.equal(modules.getSafeExecutionSignerRoute(transaction, { ...safeEntry, safeSignerAddress: undefined }), undefined)
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
})

test('changes the active Safe signer without revalidating the Safe contract', async () => {
	const alternateSigner = 0x1234567890123456789012345678901234567890n
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		useAsActiveAddress: false,
		safeSignerAddress: recipientAddress,
		safeSignerAddresses: [recipientAddress, alternateSigner],
	})])

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
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const safeSignerAddress = recipientAddress
	const existingOwnerAccount = safeTestOwnerAccount
	const existingOwnerAddress = safeTestOwnerAddress
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, fakeSafeContract.nonce)
	const existingSignature = await existingOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	fakeSafeContract.owners = [existingOwnerAddress, safeSignerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSignerAddress,
	})])
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
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const configuredSigner = recipientAddress
	const existingOwnerAccount = safeTestOwnerAccount
	const existingOwnerAddress = safeTestOwnerAddress
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
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSignerAddress: configuredSigner,
	})])
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
