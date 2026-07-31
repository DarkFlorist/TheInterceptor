import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, created, createSafeTx, EIP712Message, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, modules, pendingTransaction, privateKeyToAccount, recipientAddress, resetFakeSafeContractState, safeTxToTypedDataJson, signedTransaction, simulator, } from './confirmTransactionTestHarness.js'

test('extension Safe stack import merges owner signatures into proposal and optimistic metadata', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const ownerAddress = BigInt(ownerAccount.address)
	fakeSafeContract.owners = [ownerAddress]
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	const localTransaction = {
		safeTx,
		safeTxHash,
		created,
		websiteOrigin: 'https://example.com',
		transactionIdentifier: 70n,
		signatures: [],
	}
	const localStack = {
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [localTransaction],
	}
	await modules.updateSafeTransactionStacks(() => [localStack])
	await modules.updateInterceptorTransactionStack(() => ({
		operations: [{
			type: 'Transaction',
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				signedTransaction,
				safeTransaction: localTransaction,
			},
		}],
	}))
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const importedStack = {
		...localStack,
		transactions: [{
			...localTransaction,
			signatures: [{ signer: ownerAddress, signature }],
		}],
	}

	const reply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, {
		data: {
			name: 'Interceptor Safe Stack',
			version: '1.0.0',
			stacks: [importedStack],
		},
	})

	assert.deepEqual(reply, { type: 'ImportSafeStackReply', ok: true })
	assert.equal((await modules.getSafeTransactionStacks())[0]?.transactions[0]?.signatures[0]?.signer, ownerAddress)
	const optimisticOperation = (await modules.getInterceptorTransactionStack()).operations[0]
	assert.equal(optimisticOperation?.type, 'Transaction')
	if (optimisticOperation?.type !== 'Transaction') throw new Error('Missing imported optimistic Safe transaction')
	assert.equal(optimisticOperation.preSimulationTransaction.safeTransaction?.signatures[0]?.signer, ownerAddress)
})

test('Safe stack import preserves a proposal appended while live validation is pending', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const ownerAddress = BigInt(ownerAccount.address)
	fakeSafeContract.owners = [ownerAddress]
	const firstSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const firstSafeTxHash = BigInt(getSafeTxHash(firstSafeTx))
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(firstSafeTx)))
	const firstTransaction = {
		safeTx: firstSafeTx,
		safeTxHash: firstSafeTxHash,
		created,
		websiteOrigin: 'https://example.com',
		transactionIdentifier: 73n,
		signatures: [],
	}
	const localStack = {
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [firstTransaction],
	}
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
	fakeSafeContract.beforeVersionResponse = async () => {
		signalValidationStarted?.()
		await validationMayResume
	}
	const importPromise = modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, {
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
		const secondSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
			to: recipientAddress,
			value: 1n,
			input: new Uint8Array(),
		}, 1n)
		const secondTransaction = {
			...firstTransaction,
			safeTx: secondSafeTx,
			safeTxHash: BigInt(getSafeTxHash(secondSafeTx)),
			transactionIdentifier: 74n,
		}
		await modules.updateSafeTransactionStacks((previousStacks) => previousStacks.map((stack) => ({
			...stack,
			transactions: [...stack.transactions, secondTransaction],
		})))
		resumeValidation?.()
		const reply = await importPromise
		assert.deepEqual(reply, { type: 'ImportSafeStackReply', ok: true })

		const storedTransactions = (await modules.getSafeTransactionStacks())[0]?.transactions
		assert.equal(storedTransactions?.length, 2)
		assert.equal(storedTransactions?.[0]?.signatures[0]?.signer, ownerAddress)
		assert.equal(storedTransactions?.[1]?.safeTxHash, secondTransaction.safeTxHash)
	} finally {
		resumeValidation?.()
		fakeSafeContract.beforeVersionResponse = undefined
	}
})

test('extension Safe stack import reconciles executed transactions and rejects altered, non-owner, and duplicate-signature exports', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const ownerAddress = BigInt(ownerAccount.address)
	fakeSafeContract.owners = [ownerAddress]
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	const localTransaction = {
		safeTx,
		safeTxHash,
		created,
		websiteOrigin: 'https://example.com',
		transactionIdentifier: 71n,
		signatures: [],
	}
	const localStack = {
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [localTransaction],
	}
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
	fakeSafeContract.nonce = 1n
	const staleReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([localTransaction]))
	assert.deepEqual(staleReply, { type: 'ImportSafeStackReply', ok: true })
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])

	resetFakeSafeContractState()
	fakeSafeContract.owners = [ownerAddress]
	await resetLocalStack()
	const extraSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 1n)
	const alteredReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([
		localTransaction,
		{ ...localTransaction, safeTx: extraSafeTx, safeTxHash: BigInt(getSafeTxHash(extraSafeTx)), transactionIdentifier: 72n },
	]))
	assert.equal(alteredReply.ok, false)
	if (alteredReply.ok) throw new Error('Expected changed transaction list failure')
	assert.match(alteredReply.message, /transaction list was changed/u)

	await resetLocalStack()
	fakeSafeContract.ownerIsValid = false
	const nonOwnerReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		signatures: [{ signer: ownerAddress, signature }],
	}]))
	assert.equal(nonOwnerReply.ok, false)
	if (nonOwnerReply.ok) throw new Error('Expected non-owner signature failure')
	assert.match(nonOwnerReply.message, /is not an owner of Gnosis Safe/u)

	await resetLocalStack()
	fakeSafeContract.ownerIsValid = true
	fakeSafeContract.ownerCode = '0x6000'
	const contractOwnerReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		signatures: [{ signer: ownerAddress, signature }],
	}]))
	assert.equal(contractOwnerReply.ok, false)
	if (contractOwnerReply.ok) throw new Error('Expected contract-owner signature failure')
	assert.match(contractOwnerReply.message, /supports EOA owners only/u)

	await resetLocalStack()
	fakeSafeContract.ownerCode = '0x'
	const duplicateSignature = { signer: ownerAddress, signature }
	const duplicateReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		signatures: [duplicateSignature, duplicateSignature],
	}]))
	assert.equal(duplicateReply.ok, false)
	if (duplicateReply.ok) throw new Error('Expected duplicate signature failure')
	assert.match(duplicateReply.message, /duplicate owner signatures/u)

	const duplicateStackReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, {
		data: {
			name: 'Interceptor Safe Stack',
			version: '1.0.0',
			stacks: [localStack, localStack],
		},
	})
	assert.equal(duplicateStackReply.ok, false)
	if (duplicateStackReply.ok) throw new Error('Expected duplicate Safe stack failure')
	assert.match(duplicateStackReply.message, /duplicate entries for the same Gnosis Safe and chain/u)

	const delegateCallSafeTx = {
		...safeTx,
		message: { ...safeTx.message, operation: 1n },
	}
	const delegateCallReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		safeTx: delegateCallSafeTx,
		safeTxHash: BigInt(getSafeTxHash(delegateCallSafeTx)),
	}]))
	assert.equal(delegateCallReply.ok, false)
	if (delegateCallReply.ok) throw new Error('Expected delegatecall Safe stack failure')
	assert.match(delegateCallReply.message, /CALL operations only/u)
})

test('extension Safe stack export rejects an empty selected-chain stack', async () => {
	await modules.updateSafeTransactionStacks(() => [])

	const emptyReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)

	assert.equal(emptyReply.ok, false)
	if (emptyReply.ok) throw new Error('Expected empty Safe export failure')
	assert.match(emptyReply.message, /no Gnosis Safe proposals to export/u)

	await modules.updateSafeTransactionStacks(() => [{
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [],
	}])
	const emptyRecordReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(emptyRecordReply.ok, false)
	if (emptyRecordReply.ok) throw new Error('Expected empty Safe record export failure')
	assert.match(emptyRecordReply.message, /no Gnosis Safe proposals to export/u)
})

test('extension Safe stack export revalidates current Safe state before returning JSON', async () => {
	resetFakeSafeContractState()
	const ownerAccount = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
	const ownerAddress = BigInt(ownerAccount.address)
	fakeSafeContract.owners = [ownerAddress]
	const safeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const safeTxHash = BigInt(getSafeTxHash(safeTx))
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	await modules.updateSafeTransactionStacks(() => [{
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [{
			safeTx,
			safeTxHash,
			created,
			websiteOrigin: 'https://example.com',
			transactionIdentifier: 73n,
			signatures: [{ signer: ownerAddress, signature }],
		}],
	}])

	const validReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(validReply.ok, true)
	if (!validReply.ok) throw new Error('Expected valid Safe export')
	assert.equal(JSON.parse(validReply.safeStackJson).stacks.length, 1)

	const secondSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 1n)
	const secondSafeTxHash = BigInt(getSafeTxHash(secondSafeTx))
	const secondSignature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(secondSafeTx)))
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
	const [stackBeforeReconciliation] = await modules.getSafeTransactionStacks()
	if (stackBeforeReconciliation === undefined) throw new Error('Missing Safe stack before export reconciliation')
	await modules.updateInterceptorTransactionStack(() => ({
		operations: stackBeforeReconciliation.transactions.map((safeTransaction) => ({
			type: 'Transaction' as const,
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				signedTransaction,
				transactionIdentifier: safeTransaction.transactionIdentifier,
				safeTransaction,
			},
		})),
	}))
	fakeSafeContract.nonce = 1n
	const reconciledReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(reconciledReply.ok, true)
	if (!reconciledReply.ok) throw new Error('Expected reconciled Safe export')
	const reconciledExport = JSON.parse(reconciledReply.safeStackJson)
	assert.equal(reconciledExport.stacks[0]?.baseNonce, '0x1')
	assert.equal(reconciledExport.stacks[0]?.transactions.length, 1)
	assert.equal(reconciledExport.stacks[0]?.transactions[0]?.safeTx.message.nonce, '1')
	const [storedReconciledStack] = await modules.getSafeTransactionStacks()
	assert.equal(storedReconciledStack?.baseNonce, 1n)
	assert.deepEqual(storedReconciledStack?.transactions.map(({ transactionIdentifier }) => transactionIdentifier), [74n])
	const reconciledOperations = (await modules.getInterceptorTransactionStack()).operations
	assert.deepEqual(reconciledOperations.map((operation) => operation.type === 'Transaction' ? operation.preSimulationTransaction.transactionIdentifier : undefined), [74n])

	fakeSafeContract.nonce = 0n
	await modules.updateSafeTransactionStacks(() => [{
		chainId: fakeRpcNetwork.chainId,
		safeAddress: activeAddress,
		safeVersion: '1.4.1',
		baseNonce: 0n,
		threshold: 2n,
		transactions: [{
			safeTx,
			safeTxHash,
			created,
			websiteOrigin: 'https://example.com',
			transactionIdentifier: 73n,
			signatures: [{ signer: ownerAddress, signature }],
		}],
	}])
	fakeSafeContract.ownerCode = '0x6000'
	const contractOwnerReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(contractOwnerReply.ok, false)
	if (contractOwnerReply.ok) throw new Error('Expected contract-owner Safe export failure')
	assert.match(contractOwnerReply.message, /supports EOA owners only/u)

	fakeSafeContract.ownerCode = '0x'
	const delegateCallSafeTx = {
		...safeTx,
		message: { ...safeTx.message, operation: 1n },
	}
	await modules.updateSafeTransactionStacks((stacks) => stacks.map((stack) => ({
		...stack,
		transactions: stack.transactions.map((transaction) => ({
			...transaction,
			safeTx: delegateCallSafeTx,
			safeTxHash: BigInt(getSafeTxHash(delegateCallSafeTx)),
			signatures: [],
		})),
	})))
	const delegateCallReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(delegateCallReply.ok, false)
	if (delegateCallReply.ok) throw new Error('Expected delegatecall Safe export failure')
	assert.match(delegateCallReply.message, /CALL operations only/u)
})
