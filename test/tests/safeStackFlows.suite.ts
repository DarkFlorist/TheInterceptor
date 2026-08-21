import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, createSafeStackFixture, createSafeStackTransactionFixture, createSafeTx, EIP712Message, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, modules, pendingTransaction, recipientAddress, resetFakeSafeContractState, safeTestOwnerAccount, safeTestOwnerAddress, safeTxToTypedDataJson, signedTransaction, simulator, } from './confirmTransactionTestHarness.js'
import { ensureHex } from '../../app/ts/utils/ethereumBytes.js'
import { SafeStackExport } from '../../app/ts/types/safeTypes.js'

test('extension Safe stack import merges owner signatures into proposal and optimistic metadata', async () => {
	const ownerAccount = safeTestOwnerAccount
	const ownerAddress = safeTestOwnerAddress
	fakeSafeContract.owners = [ownerAddress]
	const localTransaction = createSafeStackTransactionFixture()
	const { safeTx, safeTxHash } = localTransaction
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	const recoveryByte = Number.parseInt(signature.slice(-2), 16)
	const nonCanonicalSignature = ensureHex(`${ signature.slice(0, -2) }${ (recoveryByte - 27).toString(16).padStart(2, '0') }`, 'test Gnosis Safe signature')
	const localStack = createSafeStackFixture([localTransaction])
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
			signatures: [{ signer: ownerAddress, signature: nonCanonicalSignature }],
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
	const storedSignature = (await modules.getSafeTransactionStacks())[0]?.transactions[0]?.signatures[0]
	assert.equal(storedSignature?.signer, ownerAddress)
	assert.equal(storedSignature?.signature, signature)
	const optimisticOperation = (await modules.getInterceptorTransactionStack()).operations[0]
	assert.equal(optimisticOperation?.type, 'Transaction')
	if (optimisticOperation?.type !== 'Transaction') throw new Error('Missing imported optimistic Safe transaction')
	assert.equal(optimisticOperation.preSimulationTransaction.safeTransaction?.signatures[0]?.signer, ownerAddress)
	assert.equal(optimisticOperation.preSimulationTransaction.safeTransaction?.signatures[0]?.signature, signature)
	const exportReply = await modules.requestSafeStackExport(simulator.ethereum)
	assert.equal(exportReply.ok, true)
	if (!exportReply.ok) throw new Error(exportReply.message)
	assert.equal(exportReply.safeStackJson.includes(`\"signature\": \"${ signature }\"`), true)
	assert.equal(exportReply.safeStackJson.includes(`\"signature\": \"${ nonCanonicalSignature }\"`), false)
})

test('extension Safe stack export and import roundtrip leaves the local stack unchanged', async () => {
	fakeSafeContract.owners = [safeTestOwnerAddress]
	const unsignedLocalTransaction = createSafeStackTransactionFixture()
	const signature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(unsignedLocalTransaction.safeTx)))
	const localTransaction = {
		...unsignedLocalTransaction,
		signatures: [{ signer: safeTestOwnerAddress, signature }],
	}
	await modules.updateSafeTransactionStacks(() => [createSafeStackFixture([localTransaction])])
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

	const exportReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(exportReply.ok, true)
	if (!exportReply.ok) throw new Error(exportReply.message)
	const safeStacksBeforeImport = await modules.getSafeTransactionStacks()
	const simulationStackBeforeImport = await modules.getInterceptorTransactionStack()
	const exportedStack = SafeStackExport.parse(JSON.parse(exportReply.safeStackJson))

	const importReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, { data: exportedStack })

	assert.deepEqual(importReply, { type: 'ImportSafeStackReply', ok: true })
	assert.deepEqual(await modules.getSafeTransactionStacks(), safeStacksBeforeImport)
	assert.deepEqual(await modules.getInterceptorTransactionStack(), simulationStackBeforeImport)
})

test('extension Safe stack import recovers a missing Safe index from locally created stack operations', async () => {
	const localTransaction = createSafeStackTransactionFixture()
	await modules.updateSafeTransactionStacks(() => [createSafeStackFixture([localTransaction])])
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

	const exportReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(exportReply.ok, true)
	if (!exportReply.ok) throw new Error(exportReply.message)
	const exportedStack = SafeStackExport.parse(JSON.parse(exportReply.safeStackJson))
	const secondSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 1n)
	const secondTransaction = {
		...localTransaction,
		safeTx: secondSafeTx,
		safeTxHash: BigInt(getSafeTxHash(secondSafeTx)),
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
				safeTransaction: secondTransaction,
			},
		}],
	}))
	await modules.updateSafeTransactionStacks(() => [])

	const importReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, { data: exportedStack })

	assert.deepEqual(importReply, { type: 'ImportSafeStackReply', ok: true })
	assert.deepEqual((await modules.getSafeTransactionStacks())[0]?.transactions, [localTransaction, secondTransaction])
})

test('extension Safe stack import does not recover its index from a different local proposal', async () => {
	const exportedTransaction = createSafeStackTransactionFixture()
	await modules.updateSafeTransactionStacks(() => [createSafeStackFixture([exportedTransaction])])
	const exportReply = await modules.requestSafeStackExport(simulator.ethereum, simulator.tokenPriceService)
	assert.equal(exportReply.ok, true)
	if (!exportReply.ok) throw new Error(exportReply.message)
	const exportedStack = SafeStackExport.parse(JSON.parse(exportReply.safeStackJson))
	const differentSafeTx = createSafeTx(fakeRpcNetwork.chainId, activeAddress, {
		to: recipientAddress,
		value: 1n,
		input: new Uint8Array(),
	}, 0n)
	const differentLocalTransaction = {
		...exportedTransaction,
		safeTx: differentSafeTx,
		safeTxHash: BigInt(getSafeTxHash(differentSafeTx)),
	}
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateInterceptorTransactionStack(() => ({
		operations: [{
			type: 'Transaction',
			preSimulationTransaction: {
				...pendingTransaction.transactionToSimulate,
				signedTransaction,
				safeTransaction: differentLocalTransaction,
			},
		}],
	}))

	const importReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, { data: exportedStack })

	assert.equal(importReply.ok, false)
	if (importReply.ok) throw new Error('Expected mismatched local proposal failure')
	assert.match(importReply.message, /does not match a locally created Interceptor Gnosis Safe stack/u)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
})

test('Safe stack import preserves a proposal appended while live validation is pending', async () => {
	const ownerAccount = safeTestOwnerAccount
	const ownerAddress = safeTestOwnerAddress
	fakeSafeContract.owners = [ownerAddress]
	const firstTransaction = createSafeStackTransactionFixture({ transactionIdentifier: 73n })
	const { safeTx: firstSafeTx } = firstTransaction
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(firstSafeTx)))
	const localStack = createSafeStackFixture([firstTransaction])
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
	const ownerAccount = safeTestOwnerAccount
	const ownerAddress = safeTestOwnerAddress
	fakeSafeContract.owners = [ownerAddress]
	const localTransaction = createSafeStackTransactionFixture({ transactionIdentifier: 71n })
	const { safeTx } = localTransaction
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	const localStack = createSafeStackFixture([localTransaction])
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
	fakeSafeContract.owners = []
	const nonOwnerReply = await modules.importSafeStack(simulator.ethereum, simulator.tokenPriceService, importData([{
		...localTransaction,
		signatures: [{ signer: ownerAddress, signature }],
	}]))
	assert.equal(nonOwnerReply.ok, false)
	if (nonOwnerReply.ok) throw new Error('Expected non-owner signature failure')
	assert.match(nonOwnerReply.message, /is not an owner of Gnosis Safe/u)

	await resetLocalStack()
	fakeSafeContract.owners = [ownerAddress]
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

	const emptyReply = await modules.requestSafeStackExport(simulator.ethereum)

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
	const emptyRecordReply = await modules.requestSafeStackExport(simulator.ethereum)
	assert.equal(emptyRecordReply.ok, false)
	if (emptyRecordReply.ok) throw new Error('Expected empty Safe record export failure')
	assert.match(emptyRecordReply.message, /no Gnosis Safe proposals to export/u)
})

test('extension Safe stack export preserves and includes already executed transactions', async () => {
	const ownerAccount = safeTestOwnerAccount
	const ownerAddress = safeTestOwnerAddress
	fakeSafeContract.owners = [ownerAddress]
	const stackTransaction = createSafeStackTransactionFixture({ transactionIdentifier: 73n })
	const { safeTx } = stackTransaction
	const signature = await ownerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	const signedStackTransaction = {
		...stackTransaction,
		signatures: [{ signer: ownerAddress, signature }],
	}
	await modules.updateSafeTransactionStacks(() => [createSafeStackFixture([signedStackTransaction])])

	const validReply = await modules.requestSafeStackExport(simulator.ethereum)
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
	const [stackBeforeExport] = await modules.getSafeTransactionStacks()
	if (stackBeforeExport === undefined) throw new Error('Missing Safe stack before export')
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
		safeTransactionStacks: await modules.getSafeTransactionStacks(),
		interceptorTransactionStack: await modules.getInterceptorTransactionStack(),
	}
	fakeSafeContract.nonce = 1n
	let liveSafeStateQueried = false
	fakeSafeContract.beforeVersionResponse = async () => { liveSafeStateQueried = true }
	const exportReply = await modules.requestSafeStackExport(simulator.ethereum)
	fakeSafeContract.beforeVersionResponse = undefined
	assert.equal(exportReply.ok, true)
	if (!exportReply.ok) throw new Error('Expected read-only Safe export')
	assert.equal(liveSafeStateQueried, false)
	const exportedStack = JSON.parse(exportReply.safeStackJson).stacks[0]
	assert.equal(exportedStack?.baseNonce, '0x0')
	assert.equal(exportedStack?.transactions.length, 2)
	assert.deepEqual(exportedStack?.transactions.map((transaction: { safeTx: { message: { nonce: string } } }) => transaction.safeTx.message.nonce), ['0', '1'])
	assert.deepEqual(await modules.getSafeTransactionStacks(), transactionStateBeforeExport.safeTransactionStacks)
	assert.deepEqual(await modules.getInterceptorTransactionStack(), transactionStateBeforeExport.interceptorTransactionStack)
})
