import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, addressString, browserMock, created, createSafeAddressBookEntry, createSafeTx, createWebsitePort, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, hexToBytes, isRecord, modules, pendingTransaction, recipientAddress, signedTransaction, simulator, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'

test('rejects EIP-7702 authorization lists before creating a Safe proposal', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	})])
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
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	})])
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
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [recipientAddress],
		activeSigningAddress: recipientAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	fakeSafeContract.owners = [recipientAddress]
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
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	})])
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
})

test('uses zero-reimbursement Safe semantics in the pre-sign confirmation simulation', async () => {
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
	const popupVisualisation = await (await import('../../app/ts/background/confirmTransactionSimulation.js')).refreshConfirmTransactionSimulation(
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

test('returns the current Safe overlay when a simulation-stack request is confirmed', async () => {
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
	const preSimulationTransaction = modules.createSafeExecutionPreSimulationTransaction(
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
	await modules.updateInterceptorTransactionStack(() => ({
		operations: [{ type: 'Transaction', preSimulationTransaction }],
	}))
	await modules.setFetchSimulationStackRequestPromise({
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		popupOrTabId: { type: 'popup', id: 41 },
		simulationOverlayEnabled: true,
		simulationStackVersion: '2.0.0',
		uniqueRequestIdentifier,
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

	await modules.fetchSimulationStackRequestConfirmation(simulator.ethereum, websiteTabConnections, {
		method: 'popup_fetchSimulationStackRequestConfirmation',
		data: {
			accept: true,
			simulationStackVersion: '2.0.0',
			uniqueRequestIdentifier,
		},
	})

	const reply = postedMessages.find((message) => isRecord(message) && message.method === 'interceptor_getSimulationStack')
	if (!isRecord(reply) || !isRecord(reply.result) || !isRecord(reply.result.payload)) throw new Error('Missing simulation stack reply')
	assert.equal(Array.isArray(reply.result.payload.transactions), true)
	assert.equal(Array.isArray(reply.result.payload.transactions) ? reply.result.payload.transactions.length : 0, 1)
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await modules.setFetchSimulationStackRequestPromise(undefined)
})

test('prepares Safe transaction intent without charging gas to the Safe', async () => {
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

test('propagates unexpected Safe proposal RPC and reconciliation storage failures', async () => {
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const { prepareSafeTransactionConfirmation } = await import('../../app/ts/background/safeTransactionConfirmation.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0x',
		}],
	})

	fakeSafeContract.safeOwnerLookupFailure = 'expected'
	try {
		const expectedFailure = await prepareSafeTransactionConfirmation(simulator.ethereum, transactionParams, false, activeAddress, recipientAddress)
		assert.match(expectedFailure.preparationMessage ?? '', /Safe owner lookup unavailable/u)
	} finally {
		fakeSafeContract.safeOwnerLookupFailure = undefined
	}
	fakeSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		await assert.rejects(
			prepareSafeTransactionConfirmation(simulator.ethereum, transactionParams, false, activeAddress, recipientAddress),
			/Unexpected Safe owner decoder failure/u,
		)
	} finally {
		fakeSafeContract.safeOwnerLookupFailure = undefined
	}
	browserMock.setStorageSetHandler(async () => {
		throw new Error('Safe reconciliation storage unavailable')
	})
	try {
		await assert.rejects(
			prepareSafeTransactionConfirmation(simulator.ethereum, transactionParams, false, activeAddress, recipientAddress),
			/Safe reconciliation storage unavailable/u,
		)
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
})

test('reserves proposal nonces without counting overlapping direct Safe execution metadata', async () => {
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	fakeSafeContract.nonce = 0n
	fakeSafeContract.owners = [recipientAddress]
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
	const proposalSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const overlappingDirectSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 1n)
	const safeRequest = (safeTx: typeof proposalSafeTx) => ({
		safeAddress: activeAddress,
		safeSignerAddress: recipientAddress,
		safeVersion: '1.4.1' as const,
		threshold: 1n,
		reviewedSafeState: { version: '1.4.1' as const, nonce: 0n, owners: [recipientAddress], threshold: 1n },
		safeTxHash: BigInt(getSafeTxHash(safeTx)),
		safeTx,
		executionGasLimit: 21_000n,
	})
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 401 },
			safeTransaction: safeRequest(proposalSafeTx),
		}, {
			...pendingTransaction,
			uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 402 },
			safeExecutionOriginalRequestParameters: transactionParams,
			safeTransaction: safeRequest(overlappingDirectSafeTx),
		}],
	})
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(overlappingDirectSafeTx))
	const preparation = await (await import('../../app/ts/background/safeTransactionConfirmation.js')).prepareSafeTransactionConfirmation(
		simulator.ethereum,
		transactionParams,
		false,
		activeAddress,
		recipientAddress,
	)
	const finalized = await preparation.finalize(pendingTransaction.transactionToSimulate, uniqueRequestIdentifier.requestSocket.tabId)
	assert.equal(finalized.safeTransaction?.safeTx.message.nonce, 1n)
})

test('refreshes pending Safe intent without charging gas to the Safe', async () => {
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

test('refreshes direct Safe execution without charging gas to the signer', async () => {
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
	})
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(recipientAddress),
			to: addressString(activeAddress),
			value: '0x0',
			data: '0x',
			maxFeePerGas: '0x1234',
			maxPriorityFeePerGas: '0x42',
		}],
	})
	const staleProposalSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: hexToBytes('0x1234'),
	}, 7n)
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			activeAddress: recipientAddress,
			originalRequestParameters: transactionParams,
			simulationMode: false,
			transactionToSimulate: {
				...pendingTransaction.transactionToSimulate,
				originalRequestParameters: transactionParams,
			},
			safeExecutionOriginalRequestParameters: transactionParams,
			safeExecutionSignerAddress: recipientAddress,
			safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 1n,
				reviewedSafeState: { version: '1.4.1', nonce: 7n, owners: [recipientAddress], threshold: 1n },
				safeTxHash: BigInt(getSafeTxHash(staleProposalSafeTx)),
				safeTx: staleProposalSafeTx,
				executionGasLimit: 21_000n,
			},
		}],
	})
	fakeSafeContract.requestedRpcMethods.splice(0, fakeSafeContract.requestedRpcMethods.length)

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	const [refreshed] = await modules.getPendingTransactionsAndMessages()
	if (refreshed?.type !== 'Transaction' || refreshed.transactionOrMessageCreationStatus !== 'Simulated') {
		throw new Error('Direct Safe execution was not refreshed')
	}
	assert.equal(refreshed.transactionToSimulate.transaction.maxFeePerGas, 0n)
	assert.equal(refreshed.transactionToSimulate.transaction.maxPriorityFeePerGas, 0n)
	assert.deepEqual(refreshed.transactionToSimulate.transaction.input, new Uint8Array())
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_getBalance'), false)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_estimateGas'), false)
	assert.equal(fakeSafeContract.requestedRpcMethods.includes('eth_simulateV1'), true)
})
