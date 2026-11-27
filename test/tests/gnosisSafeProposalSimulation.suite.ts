import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, addressString, browserMock, created, createGnosisSafeAddressBookEntry, createGnosisSafeTx, createWebsitePort, fakeRpcNetwork, fakeGnosisSafeContract, getPendingGnosisSafeProposal, getGnosisSafeTxHash, hexToBytes, isRecord, modules, pendingTransaction, recipientAddress, signedTransaction, simulator, uniqueRequestIdentifier, withSilencedConsole, createAcceptConfirmation } from './confirmTransactionTestHarness.js'
import { GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR } from '../../app/ts/gnosisSafe/gnosisSafeExecutionSimulation.js'
import { getCreatedGnosisSafeProposal } from '../../app/ts/gnosisSafe/gnosisSafePendingFlow.js'

test('rejects EIP-7702 authorization lists before creating a Gnosis Safe proposal', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
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
		{ kind: 'transaction', parameters: transactionParams },
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	)

	assert.equal(reply.type, 'result')
	assert.equal('error' in reply ? reply.error.code : undefined, 4200)
	assert.match('error' in reply ? reply.error.message : '', /do not support EIP-7702 authorization lists/u)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), [])
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('shows stale local Gnosis Safe stack failures in the transaction confirmation', async () => {
	fakeGnosisSafeContract.nonce = 1n
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [{
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [],
	}])
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
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
		{ kind: 'transaction', parameters: transactionParams },
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	))

	assert.deepEqual(reply, { type: 'doNotReply' })
	const [pendingFailure] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingFailure?.transactionOrMessageCreationStatus, 'FailedToSimulate')
	if (pendingFailure?.type !== 'Transaction' || !('transactionToSimulate' in pendingFailure)) throw new Error('Missing failed Gnosis Safe confirmation')
	assert.equal(pendingFailure.transactionToSimulate.success, false)
	if (pendingFailure.transactionToSimulate.success) throw new Error('Expected Gnosis Safe preparation failure')
	assert.match(pendingFailure.transactionToSimulate.error.message, /current Gnosis Safe nonce 1 is beyond this stack's final nonce 0/u)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation()), false)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.transactionOrMessageCreationStatus, 'FailedToSimulate')

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
})

test('reconciles executed Gnosis Safe operations before simulating the next proposal', async () => {
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({
		...state,
		signerAccounts: [recipientAddress],
		activeSigningAddress: recipientAddress,
		signerChain: fakeRpcNetwork.chainId,
	}))
	fakeGnosisSafeContract.owners = [recipientAddress]
	const firstSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const secondSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 1n)
	const transactions = [firstSafeTx, secondSafeTx].map((safeTx, index) => ({
		safeTx,
		safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
		created,
		websiteOrigin: 'https://example.com',
		transactionIdentifier: 80n + BigInt(index),
		signatures: [],
	}))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: { requestId: 404, requestSocket: uniqueRequestIdentifier.requestSocket },
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				safeTxHash: transactions[0]?.safeTxHash ?? 0n,
				safeTx: firstSafeTx,
			} },
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
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({
		safeSimulationSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	})])
	fakeGnosisSafeContract.nonce = 1n
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
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
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
		{ kind: 'transaction', parameters: transactionParams },
		false,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [storedStack] = await modules.getGnosisSafeTransactionStacks()
	assert.equal(storedStack?.baseNonce, 1n)
	assert.deepEqual(storedStack?.transactions.map(({ transactionIdentifier }) => transactionIdentifier), [81n])
	const storedOperations = (await modules.getInterceptorTransactionStack()).operations
	assert.deepEqual(storedOperations.map((operation) => operation.type === 'Transaction' ? operation.preSimulationTransaction.transactionIdentifier : undefined), [81n])
	const pendingProposal = (await modules.getPendingTransactionsAndMessages()).find((pending) =>
		pending.uniqueRequestIdentifier.requestId === uniqueRequestIdentifier.requestId
	)
	assert.equal(getPendingGnosisSafeProposal(pendingProposal)?.safeTx.message.nonce, 2n)
})

test('runs the pre-sign confirmation simulation of a Gnosis Safe proposal through the Gnosis Safe\'s execTransaction', async () => {
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
		activeSigningSafeAddress: activeAddress,
	})
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getGnosisSafeTxHash(safeTx))
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
	if (popupVisualisation?.statusCode !== 'success') throw new Error('Gnosis Safe confirmation simulation failed')
	const proposalBlock = popupVisualisation.data.simulationState.simulationStateInput.at(-1)
	assert.equal(proposalBlock?.simulateWithZeroBaseFee, false, 'the executor pays the real base fee')
	const executedProposal = proposalBlock?.transactions.at(-1)?.executedTransaction
	assert.equal(executedProposal?.from, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR)
	assert.equal(executedProposal?.to, activeAddress)
	if (!popupVisualisation.data.visualizedSimulationState.success) {
		throw new Error('Gnosis Safe confirmation visualization failed')
	}
	const simulatedSafeTransaction = popupVisualisation.data.visualizedSimulationState.visualizedBlocks
		.at(-1)?.simulatedAndVisualizedTransactions.at(-1)
	assert.equal(simulatedSafeTransaction?.safeTransaction?.safeTxHash, safeTxHash)
	assert.equal(simulatedSafeTransaction?.realizedGasPrice, 0n, 'the Gnosis Safe pays no gas')
	assert.equal(simulatedSafeTransaction?.transaction.gas, 123_456n)
})

test('isolates Gnosis Safe signing previews from the simulation-mode transaction stack', async () => {
	const previousSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 0n)
	const pendingSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 2n,
		input: new Uint8Array(),
	}, 1n)
	const previousSafeRequest = {
		safeAddress: activeAddress,
		safeSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
		threshold: 2n,
		safeTxHash: BigInt(getGnosisSafeTxHash(previousSafeTx)),
		safeTx: previousSafeTx,
	}
	const pendingSafeRequest = {
		...previousSafeRequest,
		safeTxHash: BigInt(getGnosisSafeTxHash(pendingSafeTx)),
		safeTx: pendingSafeTx,
	}
	const previousSafeTransaction = modules.createGnosisSafeExecutionPreSimulationTransaction(
		{ ...pendingTransaction.transactionToSimulate, transactionIdentifier: 71n },
		previousSafeRequest,
	)
	const isolatedInput = modules.createGnosisSafeSigningSimulationInput({
		operations: [{
			type: 'Transaction',
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				transactionIdentifier: 70n,
			},
		}, {
			type: 'TimeManipulation',
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 1n, deltaUnit: 'Days' },
		}, {
			type: 'Transaction',
			preSimulationTransaction: previousSafeTransaction,
		}],
	}, pendingSafeRequest)

	assert.equal(isolatedInput.length, 1)
	assert.deepEqual(isolatedInput[0]?.transactions.map(({ transactionIdentifier }) => transactionIdentifier), [71n])
	assert.deepEqual(isolatedInput[0]?.stateOverrides, {})
	assert.deepEqual(isolatedInput[0]?.blockTimeManipulation, { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' })
	assert.equal(isolatedInput[0]?.simulateWithZeroBaseFee, false)
})

test('does not show simulation-mode stack setup in a Gnosis Safe signing confirmation', async () => {
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	await modules.browserStorageLocalSet({
		simulationMode: false,
		activeRpcNetwork: fakeRpcNetwork,
		makeCurrentAddressRich: true,
		independentActiveSimulationAddress: activeAddress,
	})
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			simulationMode: false,
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: {
				safeAddress: activeAddress,
				safeSignerAddress: recipientAddress,
				safeVersion: '1.4.1',
				threshold: 2n,
				safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
				safeTx,
			} },
		}],
	})
	browserMock.sentMessages.length = 0

	await modules.updateConfirmTransactionView(simulator.ethereum, simulator.tokenPriceService)

	const dialogUpdate = browserMock.sentMessages.find((message) => isRecord(message) && message.method === 'popup_update_confirm_transaction_dialog')
	if (!isRecord(dialogUpdate) || !isRecord(dialogUpdate.data) || !isRecord(dialogUpdate.data.visualizedSimulatorState)) {
		throw new Error('Missing Gnosis Safe confirmation simulation-state update')
	}
	const visualizedSimulatorState = dialogUpdate.data.visualizedSimulatorState
	assert.equal(visualizedSimulatorState.numberOfAddressesMadeRich, 0)
	assert.deepEqual(visualizedSimulatorState.simulationState, { kind: 'passthrough' })
})

test('returns the current Gnosis Safe overlay when a simulation-stack request is confirmed', async () => {
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({
		simulationMode: false,
		rpcNetwork: fakeRpcNetwork,
		activeSigningSafeAddress: activeAddress,
	})
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getGnosisSafeTxHash(safeTx))
	const preSimulationTransaction = modules.createGnosisSafeExecutionPreSimulationTransaction(
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
	assert.equal((await (await import('../../app/ts/background/settings.js')).getSettings()).activeSigningSafeAddress, activeAddress)
	assert.equal((await (await import('../../app/ts/background/simulationUpdating.js')).getCurrentSimulationInput())[0]?.transactions.length, 1)
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

test('prepares Gnosis Safe transaction intent without charging gas to the Gnosis Safe', async () => {
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
		{ gasPayment: 'external-executor' },
	)

	assert.equal(prepared.success, true)
	if (!prepared.success) throw new Error('Gnosis Safe transaction intent preparation failed')
	assert.equal(prepared.transaction.from, activeAddress)
	assert.equal(prepared.transaction.to, recipientAddress)
	assert.equal(prepared.transaction.value, 0n)
	assert.deepEqual(prepared.transaction.input, hexToBytes('0xa9059cbb'))
	assert.equal(prepared.transaction.gas, 32_813n)
	assert.equal(prepared.transaction.maxFeePerGas, 0n)
	assert.equal(prepared.transaction.maxPriorityFeePerGas, 0n)
	assert.equal(fakeGnosisSafeContract.requestedRpcMethods.includes('eth_getBalance'), false)
	assert.equal(fakeGnosisSafeContract.requestedRpcMethods.includes('eth_estimateGas'), false)
	assert.equal(fakeGnosisSafeContract.requestedRpcMethods.includes('eth_simulateV1'), true)
})

test('does not fall back to ordinary gas estimation when Gnosis Safe simulation state is unavailable', async () => {
	fakeGnosisSafeContract.failEthSimulate = true
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
		{ gasPayment: 'external-executor' },
	))

	assert.equal(prepared.success, false)
	if (prepared.success) throw new Error('Gnosis Safe gas preparation unexpectedly succeeded')
	assert.match(prepared.error.message, /eth_simulateV1 unavailable|requires the Interceptor simulator/u)
	assert.equal(fakeGnosisSafeContract.requestedRpcMethods.includes('eth_getBalance'), false)
	assert.equal(fakeGnosisSafeContract.requestedRpcMethods.includes('eth_estimateGas'), false)
})

test('propagates unexpected Gnosis Safe proposal RPC and reconciliation storage failures', async () => {
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const { prepareGnosisSafeTransactionConfirmation } = await import('../../app/ts/background/gnosisSafeTransactionConfirmation.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{
			from: addressString(activeAddress),
			to: addressString(recipientAddress),
			value: '0x0',
			data: '0x',
		}],
	})

	fakeGnosisSafeContract.safeOwnerLookupFailure = 'expected'
	try {
		const expectedFailure = await prepareGnosisSafeTransactionConfirmation(simulator.ethereum, { kind: 'transaction', parameters: transactionParams }, false, activeAddress, recipientAddress)
		assert.match(expectedFailure.preparationMessage ?? '', /Gnosis Safe owner lookup unavailable/u)
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}
	fakeGnosisSafeContract.safeOwnerLookupFailure = 'unexpected'
	try {
		await assert.rejects(
			prepareGnosisSafeTransactionConfirmation(simulator.ethereum, { kind: 'transaction', parameters: transactionParams }, false, activeAddress, recipientAddress),
			/Unexpected Gnosis Safe owner decoder failure/u,
		)
	} finally {
		fakeGnosisSafeContract.safeOwnerLookupFailure = undefined
	}
	browserMock.setStorageSetHandler(async () => {
		throw new Error('Gnosis Safe reconciliation storage unavailable')
	})
	try {
		await assert.rejects(
			prepareGnosisSafeTransactionConfirmation(simulator.ethereum, { kind: 'transaction', parameters: transactionParams }, false, activeAddress, recipientAddress),
			/Gnosis Safe reconciliation storage unavailable/u,
		)
	} finally {
		browserMock.setStorageSetHandler(undefined)
	}
})

test('reserves proposal nonces without counting overlapping direct Gnosis Safe execution metadata', async () => {
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	fakeGnosisSafeContract.nonce = 0n
	fakeGnosisSafeContract.owners = [recipientAddress]
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
	const proposalSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const nextNonceSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 1n)
	const gnosisSafeRequest = (safeTx: typeof proposalSafeTx) => ({
		safeAddress: activeAddress,
		safeSignerAddress: recipientAddress,
		safeVersion: '1.4.1' as const,
		threshold: 1n,
		reviewedSafeState: { version: '1.4.1' as const, nonce: 0n, owners: [recipientAddress], threshold: 1n },
		safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)),
		safeTx,
		executionGasLimit: 21_000n,
	})
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 401 },
			safeFlow: { kind: 'proposal', state: 'created', safeTransaction: gnosisSafeRequest(proposalSafeTx) },
		}, {
			...pendingTransaction,
			uniqueRequestIdentifier: { ...uniqueRequestIdentifier, requestId: 402 },
			// A direct Gnosis Safe execution holds no proposal, so it reserves no Gnosis Safe nonce.
			safeFlow: { kind: 'directExecution', safeExecutionOriginalRequestParameters: transactionParams },
		}],
	})
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(nextNonceSafeTx))
	const preparation = await (await import('../../app/ts/background/gnosisSafeTransactionConfirmation.js')).prepareGnosisSafeTransactionConfirmation(
		simulator.ethereum,
		{ kind: 'transaction', parameters: transactionParams },
		false,
		activeAddress,
		recipientAddress,
	)
	const finalized = await preparation.finalize(pendingTransaction.transactionToSimulate, uniqueRequestIdentifier.requestSocket.tabId)
	assert.equal(getCreatedGnosisSafeProposal(finalized.safeFlow)?.safeTx.message.nonce, 1n)
})

test('refreshes pending Gnosis Safe intent without charging gas to the Gnosis Safe', async () => {
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
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: hexToBytes('0xa9059cbb'),
	}, 0n)
	const safeTxHash = BigInt(getGnosisSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({
		pendingTransactionsAndMessages: [{
			...pendingTransaction,
			originalRequestParameters: transactionParams,
			simulationMode: false,
			transactionToSimulate: {
				...pendingTransaction.transactionToSimulate,
				originalRequestParameters: transactionParams,
			},
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
				safeTxHash,
				safeTx,
				executionGasLimit: 32_813n,
			} },
		}],
	})

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	const [refreshed] = await modules.getPendingTransactionsAndMessages()
	if (refreshed?.type !== 'Transaction' || refreshed.transactionOrMessageCreationStatus !== 'Simulated') {
		throw new Error('Pending Gnosis Safe transaction was not refreshed')
	}
	assert.equal(refreshed.transactionToSimulate.transaction.maxFeePerGas, 0n)
	assert.equal(refreshed.transactionToSimulate.transaction.maxPriorityFeePerGas, 0n)
	assert.equal(getPendingGnosisSafeProposal(refreshed)?.executionGasLimit, 32_813n)
	assert.deepEqual(refreshed.transactionToSimulate.transaction.input, hexToBytes('0xa9059cbb'))
	assert.equal(fakeGnosisSafeContract.requestedRpcMethods.includes('eth_getBalance'), false)
	assert.equal(fakeGnosisSafeContract.requestedRpcMethods.includes('eth_estimateGas'), false)
	assert.equal(fakeGnosisSafeContract.requestedRpcMethods.includes('eth_simulateV1'), true)
})

test('refreshes direct Gnosis Safe execution without charging gas to the signer', async () => {
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
			safeFlow: { kind: 'directExecution', safeExecutionOriginalRequestParameters: transactionParams, safeExecutionSignerAddress: recipientAddress },
		}],
	})
	fakeGnosisSafeContract.requestedRpcMethods.splice(0, fakeGnosisSafeContract.requestedRpcMethods.length)

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)

	const [refreshed] = await modules.getPendingTransactionsAndMessages()
	if (refreshed?.type !== 'Transaction' || refreshed.transactionOrMessageCreationStatus !== 'Simulated') {
		throw new Error('Direct Gnosis Safe execution was not refreshed')
	}
	assert.equal(refreshed.transactionToSimulate.transaction.maxFeePerGas, 0n)
	assert.equal(refreshed.transactionToSimulate.transaction.maxPriorityFeePerGas, 0n)
	assert.deepEqual(refreshed.transactionToSimulate.transaction.input, new Uint8Array())
	assert.equal(fakeGnosisSafeContract.requestedRpcMethods.includes('eth_getBalance'), false)
	assert.equal(fakeGnosisSafeContract.requestedRpcMethods.includes('eth_estimateGas'), false)
	assert.equal(fakeGnosisSafeContract.requestedRpcMethods.includes('eth_simulateV1'), true)
})

test('atomic Gnosis Safe batch preparation and simulation preserve one nonce and delegate execution as the Gnosis Safe', async () => {
	const { encodeGnosisSafeBatch, GNOSIS_SAFE_MULTI_SEND_CALL_ONLY } = await import('../../app/ts/gnosisSafe/gnosisSafeDelegateCalls.js')
	const { validateGnosisSafeDelegateSimulationInput, GNOSIS_SAFE_DELEGATE_EXECUTE_ABI } = await import('../../app/ts/gnosisSafe/gnosisSafeSimulation.js')
	const { prepareGnosisSafeExecutionSimulationInput } = await import('../../app/ts/gnosisSafe/gnosisSafeExecutionSimulation.js')
	const { encodeFunctionCall } = await import('../../app/ts/utils/abiRuntime.js')
	const { dataStringWith0xStart } = await import('../../app/ts/utils/bigint.js')
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	await modules.updateSafeTransactionStacks(() => [])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	fakeGnosisSafeContract.owners = [recipientAddress]
	const input = encodeGnosisSafeBatch([{ to: recipientAddress, value: 0n, data: new Uint8Array([1]) }, { to: recipientAddress, value: 5n, data: new Uint8Array([2]) }])
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: GNOSIS_SAFE_MULTI_SEND_CALL_ONLY, operation: 1n, value: 0n, input }, 0n)
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
	const params = SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [{ from: addressString(activeAddress), to: addressString(GNOSIS_SAFE_MULTI_SEND_CALL_ONLY), value: '0x0', data: dataStringWith0xStart(input), gas: '0x989680' }] })
	const websiteTransaction = { ...pendingTransaction.transactionToSimulate, originalRequestParameters: params, transaction: { ...pendingTransaction.transactionToSimulate.transaction, to: GNOSIS_SAFE_MULTI_SEND_CALL_ONLY, input, value: 0n, gas: 10_000_000n } }
	const preparation = await (await import('../../app/ts/background/gnosisSafeTransactionConfirmation.js')).prepareGnosisSafeTransactionConfirmation(simulator.ethereum, { kind: 'transaction', parameters: params, safeTransaction: { operation: 1 } }, false, activeAddress, recipientAddress)
	const finalized = await preparation.finalize(websiteTransaction, uniqueRequestIdentifier.requestSocket.tabId)
	const batchProposal = getCreatedGnosisSafeProposal(finalized.safeFlow)
	assert.deepEqual(batchProposal?.safeTx, safeTx)
	if (batchProposal === undefined) throw new Error('Missing batch proposal')
	const simulated = modules.createGnosisSafeExecutionPreSimulationTransaction(websiteTransaction, batchProposal)
	assert.equal(simulated.signedTransaction.from, activeAddress)
	assert.equal(simulated.signedTransaction.to, activeAddress)
	assert.equal(dataStringWith0xStart(simulated.signedTransaction.input), encodeFunctionCall(GNOSIS_SAFE_DELEGATE_EXECUTE_ABI, 'delegateCallExecute', [addressString(GNOSIS_SAFE_MULTI_SEND_CALL_ONLY), dataStringWith0xStart(input)]))
	const block = { transactions: [simulated], signedMessages: [], stateOverrides: {}, blockTimeManipulation: { type: 'AddToTimestamp' as const, deltaToAdd: 12n, deltaUnit: 'Seconds' as const }, simulateWithZeroBaseFee: false }
	await validateGnosisSafeDelegateSimulationInput([block], simulator.ethereum, 123n)
	await assert.rejects(validateGnosisSafeDelegateSimulationInput([{ ...block, transactions: [{ ...simulated, signedTransaction: { ...simulated.signedTransaction, to: recipientAddress } }] }], simulator.ethereum, 123n), /does not match its proposal/)
	// The Gnosis Safe makes the delegate call itself, through execTransaction, without replacing its code.
	const [prepared] = await prepareGnosisSafeExecutionSimulationInput([block], simulator.ethereum, 123n, 1n)
	assert.equal(prepared?.stateOverrides[addressString(activeAddress)]?.code, undefined)
	const executed = prepared?.transactions[0]?.executedTransaction
	if (executed === undefined) throw new Error('Expected the batch to run through the Gnosis Safe')
	const { decodeGnosisSafeExecution } = await import('../../app/ts/gnosisSafe/gnosisSafeExecution.js')
	assert.equal(executed.to, activeAddress)
	assert.deepEqual(decodeGnosisSafeExecution(fakeRpcNetwork.chainId, activeAddress, 0n, executed.input).safeTx, safeTx)
})

test('on-chain Gnosis Safe message review context is bound to calldata and stays outside RPC transaction params', async () => {
	const { GNOSIS_SAFE_SIGN_MESSAGE_LIB, GNOSIS_SAFE_SIGN_MESSAGE_ABI } = await import('../../app/ts/gnosisSafe/gnosisSafeDelegateCalls.js')
	const { getGnosisSafeMessageDigest } = await import('../../app/ts/gnosisSafe/gnosisSafeMessage.js')
	const { encodeFunctionCall } = await import('../../app/ts/utils/abiRuntime.js')
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const { prepareGnosisSafeTransactionConfirmation } = await import('../../app/ts/background/gnosisSafeTransactionConfirmation.js')
	await modules.updateSafeTransactionStacks(() => [])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	fakeGnosisSafeContract.owners = [recipientAddress]
	const review = { text: 'Approve this Gnosis Safe message', isTypedData: false }
	const data = encodeFunctionCall(GNOSIS_SAFE_SIGN_MESSAGE_ABI, 'signMessage', [getGnosisSafeMessageDigest(review.text)])
	const input = hexToBytes(data)
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: GNOSIS_SAFE_SIGN_MESSAGE_LIB, operation: 1n, value: 0n, input }, 0n)
	fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(safeTx))
	const params = SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [{ from: addressString(activeAddress), to: addressString(GNOSIS_SAFE_SIGN_MESSAGE_LIB), value: '0x0', data, gas: '0x989680' }] })
	const websiteTransaction = { ...pendingTransaction.transactionToSimulate, originalRequestParameters: params, transaction: { ...pendingTransaction.transactionToSimulate.transaction, to: GNOSIS_SAFE_SIGN_MESSAGE_LIB, input, value: 0n, gas: 10_000_000n } }
	const preparation = await prepareGnosisSafeTransactionConfirmation(simulator.ethereum, { kind: 'transaction', parameters: params, safeTransaction: { operation: 1, messageReview: review } }, false, activeAddress, recipientAddress)
	const finalized = await preparation.finalize(websiteTransaction, uniqueRequestIdentifier.requestSocket.tabId)
	assert.deepEqual(getCreatedGnosisSafeProposal(finalized.safeFlow)?.messageReview, review)
	assert.deepEqual(getCreatedGnosisSafeProposal(finalized.safeFlow)?.safeTx, safeTx)
	assert.equal('safeMessageText' in params.params[0], false)
	assert.equal('safeOperation' in params.params[0], false)
	const mismatched = await prepareGnosisSafeTransactionConfirmation(simulator.ethereum, { kind: 'transaction', parameters: params, safeTransaction: { operation: 1, messageReview: { ...review, text: 'Different message' } } }, false, activeAddress, recipientAddress)
	const rejected = await withSilencedConsole(async () => await mismatched.finalize(websiteTransaction, uniqueRequestIdentifier.requestSocket.tabId))
	assert.equal(rejected.transactionToSimulate.success, false)
	assert.deepEqual(rejected.safeFlow, { kind: 'proposal', state: 'creationFailed' })
})

test('clears a pending Gnosis Safe proposal stored before its flow was recorded as safeFlow instead of refreshing it as another kind of transaction', async () => {
	const { PendingTransactionOrSignableMessage } = await import('../../app/ts/types/accessRequest.js')
	const safeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, { to: recipientAddress, value: 0n, input: new Uint8Array() }, 0n)
	const safeTransaction = { safeAddress: activeAddress, safeVersion: '1.4.1', threshold: 1n, safeTxHash: BigInt(getGnosisSafeTxHash(safeTx)), safeTx }
	const storedProposal = modules.serialize(PendingTransactionOrSignableMessage, { ...pendingTransaction, simulationMode: false, safeFlow: { kind: 'proposal', state: 'created', safeTransaction } })
	await browser.storage.local.set({ pendingTransactionsAndMessages: [storedProposal] })
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1, 'the current format is read back')
	// Earlier versions kept a Gnosis Safe proposal's transaction in its own pending field.
	const { safeFlow, ...earlierVersionFields } = storedProposal
	await browser.storage.local.set({ pendingTransactionsAndMessages: [{ ...earlierVersionFields, safeTransaction: safeFlow.safeTransaction }] })
	assert.deepEqual(await withSilencedConsole(async () => await modules.getPendingTransactionsAndMessages()), [])
})
