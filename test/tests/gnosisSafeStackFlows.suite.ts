import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, createGnosisSafeStackFixture, createGnosisSafeStackTransactionFixture, createGnosisSafeTx, EIP712Message, fakeRpcNetwork, fakeGnosisSafeContract, getGnosisSafeTxHash, modules, pendingTransaction, recipientAddress, resetFakeGnosisSafeContractState, gnosisSafeTestOwnerAccount, gnosisSafeTestOwnerAddress, gnosisSafeTxToTypedDataJson, signedTransaction, simulator, } from './confirmTransactionTestHarness.js'
import { ensureHex } from '../../app/ts/utils/ethereumBytes.js'
import { GnosisSafeStackExport } from '../../app/ts/types/gnosisSafeTypes.js'

test('Gnosis Safe signature import waits for validation but acknowledges before refreshing simulation', async () => {
	const { createDeferredSignal } = await import('./backgroundEthAccountsTestHarness.js')
	const { waitForBackgroundTasks } = await import('./backgroundTasksTestHarness.js')
	const localTransaction = createGnosisSafeStackTransactionFixture()
	const localStack = createGnosisSafeStackFixture([localTransaction])
	await modules.updateSafeTransactionStacks(() => [localStack])
	const validationStarted = createDeferredSignal()
	const releaseValidation = createDeferredSignal()
	const refreshStarted = createDeferredSignal()
	const releaseRefresh = createDeferredSignal()
	fakeGnosisSafeContract.beforeVersionResponse = async () => { validationStarted.resolve(); await releaseValidation.promise }
	const originalSend = browser.runtime.sendMessage.bind(browser.runtime)
	Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: async (message: { method?: string }) => {
		if (message.method === 'popup_isSimulationVisualizerOpen') { refreshStarted.resolve(); await releaseRefresh.promise }
		return await originalSend(message)
	} })
	let acknowledged = false
	const imported = modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, { data: { name: 'Interceptor Safe Stack', version: '1.0.0', stacks: [localStack] } }).then(reply => { acknowledged = true; return reply })
	let timeout: ReturnType<typeof setTimeout> | undefined
	try {
		await validationStarted.promise
		assert.equal(acknowledged, false, 'Owner/signature validation must finish before success')
		releaseValidation.resolve()
		const reply = await Promise.race([imported, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Gnosis Safe import waited for simulation refresh')), 1000) })])
		assert.equal(reply.ok, true)
		await refreshStarted.promise
		assert.equal((await modules.getGnosisSafeTransactionStacks())[0]?.transactions.length, 1)
	} finally {
		clearTimeout(timeout)
		releaseValidation.resolve()
		releaseRefresh.resolve()
		await imported
		await waitForBackgroundTasks()
		Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: originalSend })
		fakeGnosisSafeContract.beforeVersionResponse = undefined
	}
})

test('extension Gnosis Safe stack import merges owner signatures into proposal and optimistic metadata', async () => {
	const ownerAccount = gnosisSafeTestOwnerAccount
	const ownerAddress = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [ownerAddress]
	const localTransaction = createGnosisSafeStackTransactionFixture()
	const { safeTx, safeTxHash } = localTransaction
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
	const recoveryByte = Number.parseInt(signature.slice(-2), 16)
	const nonCanonicalSignature = ensureHex(`${ signature.slice(0, -2) }${ (recoveryByte - 27).toString(16).padStart(2, '0') }`, 'test Gnosis Safe signature')
	const localStack = createGnosisSafeStackFixture([localTransaction])
	await modules.updateSafeTransactionStacks(() => [localStack])
	await modules.updateInterceptorTransactionStack(() => ({
		operations: [{
			type: 'Transaction',
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				signedTransaction,
				simulationOptions: { requiredChainId: fakeRpcNetwork.chainId },
				safeTransaction: localTransaction,
			},
		}],
	}))
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const importedStack = {
		...localStack,
		transactions: [{
			...localTransaction,
			signatures: [{ signer: ownerAddress, signature: nonCanonicalSignature }],
		}],
	}

	const reply = await modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, {
		data: {
			name: 'Interceptor Safe Stack',
			version: '1.0.0',
			stacks: [importedStack],
		},
	})

	assert.deepEqual(reply, { type: 'ImportSafeStackReply', ok: true })
	const storedSignature = (await modules.getGnosisSafeTransactionStacks())[0]?.transactions[0]?.signatures[0]
	assert.equal(storedSignature?.signer, ownerAddress)
	assert.equal(storedSignature?.signature, signature)
	const optimisticOperation = (await modules.getInterceptorTransactionStack()).operations[0]
	assert.equal(optimisticOperation?.type, 'Transaction')
	if (optimisticOperation?.type !== 'Transaction') throw new Error('Missing imported optimistic Gnosis Safe transaction')
	assert.equal(optimisticOperation.preSimulationTransaction.safeTransaction?.signatures[0]?.signer, ownerAddress)
	assert.equal(optimisticOperation.preSimulationTransaction.safeTransaction?.signatures[0]?.signature, signature)
	const exportReply = await modules.requestGnosisSafeStackExport(simulator.ethereum)
	assert.equal(exportReply.ok, true)
	if (!exportReply.ok) throw new Error(exportReply.message)
	assert.equal(exportReply.safeStackJson.includes(`\"signature\": \"${ signature }\"`), true)
	assert.equal(exportReply.safeStackJson.includes(`\"signature\": \"${ nonCanonicalSignature }\"`), false)
})

test('extension Gnosis Safe stack export and import roundtrip leaves the local stack unchanged', async () => {
	fakeGnosisSafeContract.owners = [gnosisSafeTestOwnerAddress]
	const unsignedLocalTransaction = createGnosisSafeStackTransactionFixture()
	const signature = await gnosisSafeTestOwnerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(unsignedLocalTransaction.safeTx)))
	const localTransaction = {
		...unsignedLocalTransaction,
		signatures: [{ signer: gnosisSafeTestOwnerAddress, signature }],
	}
	await modules.updateSafeTransactionStacks(() => [createGnosisSafeStackFixture([localTransaction])])
	await modules.updateInterceptorTransactionStack(() => ({
		operations: [{
			type: 'Transaction',
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				signedTransaction,
				simulationOptions: { requiredChainId: fakeRpcNetwork.chainId },
				safeTransaction: localTransaction,
			},
		}],
	}))

	const exportReply = await modules.requestGnosisSafeStackExport(simulator.ethereum)
	assert.equal(exportReply.ok, true)
	if (!exportReply.ok) throw new Error(exportReply.message)
	const safeStacksBeforeImport = await modules.getGnosisSafeTransactionStacks()
	const simulationStackBeforeImport = await modules.getInterceptorTransactionStack()
	const exportedStack = GnosisSafeStackExport.parse(JSON.parse(exportReply.safeStackJson))

	const importReply = await modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, { data: exportedStack })

	assert.deepEqual(importReply, { type: 'ImportSafeStackReply', ok: true })
	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), safeStacksBeforeImport)
	assert.deepEqual(await modules.getInterceptorTransactionStack(), simulationStackBeforeImport)
})

test('extension Gnosis Safe stack import recovers a missing Gnosis Safe index from locally created stack operations', async () => {
	const localTransaction = createGnosisSafeStackTransactionFixture()
	await modules.updateSafeTransactionStacks(() => [createGnosisSafeStackFixture([localTransaction])])
	await modules.updateInterceptorTransactionStack(() => ({
		operations: [{
			type: 'Transaction',
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				signedTransaction,
				simulationOptions: { requiredChainId: fakeRpcNetwork.chainId },
				safeTransaction: localTransaction,
			},
		}],
	}))

	const exportReply = await modules.requestGnosisSafeStackExport(simulator.ethereum)
	assert.equal(exportReply.ok, true)
	if (!exportReply.ok) throw new Error(exportReply.message)
	const exportedStack = GnosisSafeStackExport.parse(JSON.parse(exportReply.safeStackJson))
	const secondSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 1n)
	const secondTransaction = {
		...localTransaction,
		safeTx: secondSafeTx,
		safeTxHash: BigInt(getGnosisSafeTxHash(secondSafeTx)),
		transactionIdentifier: 74n,
		websiteOrigin: 'https://later-proposal.example',
	}
	await modules.updateInterceptorTransactionStack((stack) => ({
		operations: [...stack.operations, {
			type: 'Transaction',
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				transactionIdentifier: secondTransaction.transactionIdentifier,
				signedTransaction,
				simulationOptions: { requiredChainId: fakeRpcNetwork.chainId },
				safeTransaction: secondTransaction,
			},
		}],
	}))
	await modules.updateSafeTransactionStacks(() => [])

	const importReply = await modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, { data: exportedStack })

	assert.deepEqual(importReply, { type: 'ImportSafeStackReply', ok: true })
	assert.deepEqual((await modules.getGnosisSafeTransactionStacks())[0]?.transactions, [localTransaction, secondTransaction])
})

test('extension Gnosis Safe stack import does not recover its index from a different local proposal', async () => {
	const exportedTransaction = createGnosisSafeStackTransactionFixture()
	await modules.updateSafeTransactionStacks(() => [createGnosisSafeStackFixture([exportedTransaction])])
	const exportReply = await modules.requestGnosisSafeStackExport(simulator.ethereum)
	assert.equal(exportReply.ok, true)
	if (!exportReply.ok) throw new Error(exportReply.message)
	const exportedStack = GnosisSafeStackExport.parse(JSON.parse(exportReply.safeStackJson))
	const differentSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 0n)
	const differentLocalTransaction = {
		...exportedTransaction,
		safeTx: differentSafeTx,
		safeTxHash: BigInt(getGnosisSafeTxHash(differentSafeTx)),
	}
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({
		operations: [{
			type: 'Transaction',
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				signedTransaction,
				simulationOptions: { requiredChainId: fakeRpcNetwork.chainId },
				safeTransaction: differentLocalTransaction,
			},
		}],
	}))

	const importReply = await modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, { data: exportedStack })

	assert.equal(importReply.ok, false)
	if (importReply.ok) throw new Error('Expected mismatched local proposal failure')
	assert.match(importReply.message, /does not match a locally created Interceptor Gnosis Safe stack/u)
	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), [])
})

test('Gnosis Safe stack import preserves a proposal appended while live validation is pending', async () => {
	const ownerAccount = gnosisSafeTestOwnerAccount
	const ownerAddress = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [ownerAddress]
	const firstTransaction = createGnosisSafeStackTransactionFixture({ transactionIdentifier: 73n })
	const { safeTx: firstSafeTx } = firstTransaction
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(firstSafeTx)))
	const localStack = createGnosisSafeStackFixture([firstTransaction])
	await modules.updateSafeTransactionStacks(() => [localStack])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))

	let signalValidationStarted: (() => void) | undefined
	const validationStarted = new Promise<void>((resolve) => {
		signalValidationStarted = resolve
	})
	let resumeValidation: (() => void) | undefined
	const validationMayResume = new Promise<void>((resolve) => {
		resumeValidation = resolve
	})
	fakeGnosisSafeContract.beforeVersionResponse = async () => {
		signalValidationStarted?.()
		await validationMayResume
	}
	const importPromise = modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, {
		data: {
			name: 'Interceptor Safe Stack',
			version: '1.0.0',
			stacks: [{
				...localStack,
				transactions: [{
					...firstTransaction,
					signatures: [{ signer: ownerAddress, signature }],
				}],
			}],
		},
	})

	try {
		await validationStarted
		const secondSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
			to: recipientAddress,
			value: 1n,
			input: new Uint8Array(),
		}, 1n)
		const secondTransaction = {
			...firstTransaction,
			safeTx: secondSafeTx,
			safeTxHash: BigInt(getGnosisSafeTxHash(secondSafeTx)),
			transactionIdentifier: 74n,
		}
		await modules.updateSafeTransactionStacks((previousStacks) => previousStacks.map((stack) => ({
			...stack,
			transactions: [...stack.transactions, secondTransaction],
		})))
		resumeValidation?.()
		const reply = await importPromise
		assert.deepEqual(reply, { type: 'ImportSafeStackReply', ok: true })

		const storedTransactions = (await modules.getGnosisSafeTransactionStacks())[0]?.transactions
		assert.equal(storedTransactions?.length, 2)
		assert.equal(storedTransactions?.[0]?.signatures[0]?.signer, ownerAddress)
		assert.equal(storedTransactions?.[1]?.safeTxHash, secondTransaction.safeTxHash)
	} finally {
		resumeValidation?.()
		fakeGnosisSafeContract.beforeVersionResponse = undefined
	}
})

test('extension Gnosis Safe stack import reconciles executed transactions and rejects altered, non-owner, and duplicate-signature exports', async () => {
	const ownerAccount = gnosisSafeTestOwnerAccount
	const ownerAddress = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [ownerAddress]
	const localTransaction = createGnosisSafeStackTransactionFixture({ transactionIdentifier: 71n })
	const { safeTx } = localTransaction
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
	const localStack = createGnosisSafeStackFixture([localTransaction])
	const importData = (transactions: readonly typeof localTransaction[]) => ({
		data: {
			name: 'Interceptor Safe Stack' as const,
			version: '1.0.0' as const,
			stacks: [{ ...localStack, transactions }],
		},
	})
	const resetLocalStack = async () => {
		await modules.updateSafeTransactionStacks(() => [localStack])
		await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	}

	await resetLocalStack()
	fakeGnosisSafeContract.nonce = 1n
	const staleReply = await modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([localTransaction]))
	assert.deepEqual(staleReply, { type: 'ImportSafeStackReply', ok: true })
	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), [])

	resetFakeGnosisSafeContractState()
	fakeGnosisSafeContract.owners = [ownerAddress]
	await resetLocalStack()
	const extraSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 1n)
	const alteredReply = await modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([
		localTransaction,
		{ ...localTransaction, safeTx: extraSafeTx, safeTxHash: BigInt(getGnosisSafeTxHash(extraSafeTx)), transactionIdentifier: 72n },
	]))
	assert.equal(alteredReply.ok, false)
	if (alteredReply.ok) throw new Error('Expected changed transaction list failure')
	assert.match(alteredReply.message, /transaction list was changed/u)

	await resetLocalStack()
	fakeGnosisSafeContract.owners = []
	const nonOwnerReply = await modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		signatures: [{ signer: ownerAddress, signature }],
	}]))
	assert.equal(nonOwnerReply.ok, false)
	if (nonOwnerReply.ok) throw new Error('Expected non-owner signature failure')
	assert.match(nonOwnerReply.message, /is not an owner of Gnosis Safe/u)

	await resetLocalStack()
	fakeGnosisSafeContract.owners = [ownerAddress]
	fakeGnosisSafeContract.ownerCode = '0x6000'
	const contractOwnerReply = await modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		signatures: [{ signer: ownerAddress, signature }],
	}]))
	assert.equal(contractOwnerReply.ok, false)
	if (contractOwnerReply.ok) throw new Error('Expected contract-owner signature failure')
	assert.match(contractOwnerReply.message, /supports EOA owners only/u)

	await resetLocalStack()
	fakeGnosisSafeContract.ownerCode = '0x'
	const duplicateSignature = { signer: ownerAddress, signature }
	const duplicateReply = await modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		signatures: [duplicateSignature, duplicateSignature],
	}]))
	assert.equal(duplicateReply.ok, false)
	if (duplicateReply.ok) throw new Error('Expected duplicate signature failure')
	assert.match(duplicateReply.message, /duplicate owner signatures/u)

	const duplicateStackReply = await modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, {
		data: {
			name: 'Interceptor Safe Stack',
			version: '1.0.0',
			stacks: [localStack, localStack],
		},
	})
	assert.equal(duplicateStackReply.ok, false)
	if (duplicateStackReply.ok) throw new Error('Expected duplicate Gnosis Safe stack failure')
	assert.match(duplicateStackReply.message, /duplicate entries for the same Gnosis Safe and chain/u)

	const delegateCallSafeTx = {
		...safeTx,
		message: { ...safeTx.message, operation: 1n },
	}
	const delegateCallReply = await modules.importGnosisSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		safeTx: delegateCallSafeTx,
		safeTxHash: BigInt(getGnosisSafeTxHash(delegateCallSafeTx)),
	}]))
	assert.equal(delegateCallReply.ok, false)
	if (delegateCallReply.ok) throw new Error('Expected delegatecall Gnosis Safe stack failure')
	assert.match(delegateCallReply.message, /DELEGATECALL is supported only/u)
})

test('extension Gnosis Safe stack export rejects an empty selected-chain stack', async () => {
	await modules.updateSafeTransactionStacks(() => [])

	const emptyReply = await modules.requestGnosisSafeStackExport(simulator.ethereum)

	assert.equal(emptyReply.ok, false)
	if (emptyReply.ok) throw new Error('Expected empty Gnosis Safe export failure')
	assert.match(emptyReply.message, /no Gnosis Safe proposals to export/u)

	await modules.updateSafeTransactionStacks(() => [{
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [],
	}])
	const emptyRecordReply = await modules.requestGnosisSafeStackExport(simulator.ethereum)
	assert.equal(emptyRecordReply.ok, false)
	if (emptyRecordReply.ok) throw new Error('Expected empty Gnosis Safe record export failure')
	assert.match(emptyRecordReply.message, /no Gnosis Safe proposals to export/u)
})

test('extension Gnosis Safe stack export preserves and includes already executed transactions', async () => {
	const ownerAccount = gnosisSafeTestOwnerAccount
	const ownerAddress = gnosisSafeTestOwnerAddress
	fakeGnosisSafeContract.owners = [ownerAddress]
	const stackTransaction = createGnosisSafeStackTransactionFixture({ transactionIdentifier: 73n })
	const { safeTx } = stackTransaction
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(safeTx)))
	const signedStackTransaction = {
		...stackTransaction,
		signatures: [{ signer: ownerAddress, signature }],
	}
	await modules.updateSafeTransactionStacks(() => [createGnosisSafeStackFixture([signedStackTransaction])])

	const validReply = await modules.requestGnosisSafeStackExport(simulator.ethereum)
	assert.equal(validReply.ok, true)
	if (!validReply.ok) throw new Error('Expected valid Gnosis Safe export')
	assert.equal(JSON.parse(validReply.safeStackJson).stacks.length, 1)

	const secondSafeTx = createGnosisSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 1n)
	const secondSafeTxHash = BigInt(getGnosisSafeTxHash(secondSafeTx))
	const secondSignature = await ownerAccount.signTypedData(EIP712Message.parse(gnosisSafeTxToTypedDataJson(secondSafeTx)))
	await modules.updateSafeTransactionStacks((stacks) => stacks.map((stack) => ({
		...stack,
		transactions: [...stack.transactions, {
			...stack.transactions[0],
			safeTx: secondSafeTx,
			safeTxHash: secondSafeTxHash,
			transactionIdentifier: 74n,
			signatures: [{ signer: ownerAddress, signature: secondSignature }],
		}],
	})))
	const [stackBeforeExport] = await modules.getGnosisSafeTransactionStacks()
	if (stackBeforeExport === undefined) throw new Error('Missing Gnosis Safe stack before export')
	await modules.updateInterceptorTransactionStack(() => ({
		operations: stackBeforeExport.transactions.map((safeTransaction) => ({
			type: 'Transaction' as const,
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				signedTransaction,
				transactionIdentifier: safeTransaction.transactionIdentifier,
				safeTransaction,
			},
		})),
	}))
	const transactionStateBeforeExport = {
		safeTransactionStacks: await modules.getGnosisSafeTransactionStacks(),
		interceptorTransactionStack: await modules.getInterceptorTransactionStack(),
	}
	fakeGnosisSafeContract.nonce = 1n
	let liveSafeStateQueried = false
	fakeGnosisSafeContract.beforeVersionResponse = async () => { liveSafeStateQueried = true }
	const exportReply = await modules.requestGnosisSafeStackExport(simulator.ethereum)
	fakeGnosisSafeContract.beforeVersionResponse = undefined
	assert.equal(exportReply.ok, true)
	if (!exportReply.ok) throw new Error('Expected read-only Gnosis Safe export')
	assert.equal(liveSafeStateQueried, false)
	const exportedStack = JSON.parse(exportReply.safeStackJson).stacks[0]
	assert.equal(exportedStack?.baseNonce, '0x0')
	assert.equal(exportedStack?.transactions.length, 2)
	assert.deepEqual(exportedStack?.transactions.map((transaction: { safeTx: { message: { nonce: string } } }) => transaction.safeTx.message.nonce), ['0', '1'])
	assert.deepEqual(await modules.getGnosisSafeTransactionStacks(), transactionStateBeforeExport.safeTransactionStacks)
	assert.deepEqual(await modules.getInterceptorTransactionStack(), transactionStateBeforeExport.interceptorTransactionStack)
})
