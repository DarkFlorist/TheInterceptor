import * as assert from 'node:assert'
import { spyOn, test } from 'bun:test'
import * as funtypes from 'funtypes'
import multiSendLibrary from '../fixtures/safe-libraries/MultiSendCallOnly.json'
import signMessageLibrary from '../fixtures/safe-libraries/SignMessageLib.json'
import { refreshAndPersistSafeSignerSelection } from '../../app/ts/background/safeSignerSelectionRefresh.js'
import { encodeSafeBatch, SAFE_MULTI_SEND_CALL_ONLY, SAFE_SIGN_MESSAGE_ABI, SAFE_SIGN_MESSAGE_LIB } from '../../app/ts/safe/safeDelegateCalls.js'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { dataStringWith0xStart, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { getLatestUnexpectedError } from '../../app/ts/utils/unexpectedErrorStorage.js'
import { acceptConfirmation, activeAddress, addressString, connectWebsite, createSafeAddressBookEntry, createSafeTxToRecipient, EIP712Message, ethereum, fakeRpcNetwork, fakeSafeContract, hasForwardedSignerRequest, hasPostedMethod, modules, openTransactionConfirmation, recipientAddress, requireForwardedSignerRequest, requireWebsiteReply, SAFE_EXECUTION_ABI, safeTestOwnerAccount, safeTestOwnerAddress, safeTxToTypedDataJson, setWalletAccounts, simulator, uniqueRequestIdentifier, withSafeOwnerLookupFailure, withSilencedConsole } from './confirmTransactionTestHarness.js'

const sealwortWebsite = { websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' }

// An eth_sendTransaction from `from` to `to` with the given calldata, parsed like a website's request.
const createSendTransactionParams = ({ from = activeAddress, to = activeAddress, value, data }: { readonly from?: bigint, readonly to?: bigint, readonly value?: string, readonly data: string }) => SendTransactionParams.parse({
	method: 'eth_sendTransaction',
	params: [{
		from: addressString(from),
		to: addressString(to),
		...(value === undefined ? {} : { value }),
		data,
	}],
})

// execTransaction calldata for a SafeTx from the active Safe to the recipient that carries these packed owner signatures.
const encodeExecTransactionToRecipient = (signatures: `0x${ string }`) => encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [
	addressString(recipientAddress),
	0n,
	'0x',
	0n,
	0n,
	0n,
	0n,
	addressString(0n),
	addressString(0n),
	signatures,
])

const ForwardedTransaction = funtypes.ReadonlyObject({ from: funtypes.String, to: funtypes.String, data: funtypes.String })

const confirmWithSelectedSigner = async (websiteTabConnections: Parameters<typeof modules.resolvePendingTransactionOrMessage>[2], selectedSigner: bigint) => await modules.resolvePendingTransactionOrMessage(
	simulator.ethereum,
	simulator.tokenPriceService,
	websiteTabConnections,
	acceptConfirmation,
	{ selectedSigner, verificationError: undefined },
)

test('recognizes only execTransaction calls to the active Safe for direct signer execution', async () => {
	const safeSignerAddress = 0x1234567890123456789012345678901234567890n
	const safeEntry = createSafeAddressBookEntry({ safeSimulationSignerAddress: recipientAddress })
	const transaction = createSendTransactionParams({ data: '0x6a76120200' })

	assert.deepEqual(modules.getSafeExecutionSignerRoute(transaction, safeEntry, safeSignerAddress), {
		executor: safeSignerAddress,
		transactionParams: {
			method: 'eth_sendTransaction',
			params: [{
				...transaction.params[0],
				from: safeSignerAddress,
			}],
		},
	})
	assert.equal(modules.getSafeExecutionSignerRoute(createSendTransactionParams({ from: recipientAddress, data: '0x6a76120200' }), safeEntry, safeSignerAddress), undefined)
	assert.equal(modules.getSafeExecutionSignerRoute(createSendTransactionParams({ to: recipientAddress, data: '0x6a76120200' }), safeEntry, safeSignerAddress), undefined)
	assert.equal(modules.getSafeExecutionSignerRoute(createSendTransactionParams({ data: '0xa9059cbb' }), safeEntry, safeSignerAddress), undefined)
	assert.equal(modules.getSafeExecutionSignerRoute(transaction, safeEntry, undefined), undefined)
	const nonzeroOuterValue = createSendTransactionParams({ value: '0x1', data: '0x6a76120200' })
	await assert.rejects(
		modules.prepareSafeExecutionSignerRoute(ethereum, nonzeroOuterValue, safeEntry, safeSignerAddress),
		/A direct Gnosis Safe execution transaction must have zero outer ETH value/u,
	)
	fakeSafeContract.threshold = 3n
	const insufficientSignatures = createSendTransactionParams({ data: encodeExecTransactionToRecipient(`0x${ '00'.repeat(65) }`) })
	await assert.rejects(
		modules.prepareSafeExecutionSignerRoute(ethereum, insufficientSignatures, safeEntry, safeSignerAddress),
		/cannot satisfy its 3-signature threshold/u,
	)
	fakeSafeContract.threshold = 2n
	fakeSafeContract.owners = [safeSignerAddress]
	await assert.rejects(
		modules.prepareSafeExecutionSignerRoute(ethereum, insufficientSignatures, safeEntry, safeSignerAddress),
		/signature format that Interceptor cannot validate/u,
	)
})

test('routes a completed active Safe execution through its configured signer and rechecks signer changes', async () => {
	const safeSignerAddress = recipientAddress
	const existingOwnerAddress = safeTestOwnerAddress
	const alternateSignerAddress = 0x3333333333333333333333333333333333333333n
	const safeTx = createSafeTxToRecipient({ nonce: fakeSafeContract.nonce })
	const existingSignature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	fakeSafeContract.owners = [existingOwnerAddress, safeSignerAddress, alternateSignerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSignerAddresses: [safeSignerAddress],
	})])
	await setWalletAccounts([], { signerChain: fakeRpcNetwork.chainId })
	const transactionParams = createSendTransactionParams({ value: '0x0', data: encodeExecTransactionToRecipient(existingSignature) })
	const { postedMessages, websiteTabConnections } = connectWebsite({ websiteOrigin: sealwortWebsite.websiteOrigin })
	const socket = uniqueRequestIdentifier.requestSocket

	assert.deepEqual(await openTransactionConfirmation(transactionParams, sealwortWebsite, websiteTabConnections), { type: 'doNotReply' })

	const [disconnectedExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(disconnectedExecution?.type, 'Transaction')
	if (disconnectedExecution?.type !== 'Transaction') throw new Error('Missing disconnected direct Safe execution request')
	assert.deepEqual(disconnectedExecution.safeExecutionOriginalRequestParameters, transactionParams)
	assert.equal(disconnectedExecution.safeExecutionSignerAddress, undefined)
	assert.notEqual(disconnectedExecution.safeExecutionReviewedSafeState, undefined)
	assert.equal(disconnectedExecution.safeTransaction, undefined)
	assert.equal(disconnectedExecution.approvalStatus.status, 'SignerError')

	await setWalletAccounts([safeSignerAddress])
	fakeSafeContract.version = 'invalid-version'
	await withSilencedConsole(async () => await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId))
	assert.equal(await getLatestUnexpectedError(), undefined)
	assert.equal((await modules.getPendingTransactionsAndMessages())[0]?.approvalStatus.status, 'SignerError')
	fakeSafeContract.version = '1.4.1'
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
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
	await assert.rejects(
		refreshAndPersistSafeSignerSelection(
			simulator.ethereum,
			pendingExecution,
			alternateSignerAddress,
			async () => { throw new Error('Direct Safe simulation refresh unavailable') },
		),
		/Direct Safe simulation refresh unavailable/u,
	)
	assert.deepEqual((await modules.getPendingTransactionsAndMessages())[0], pendingExecution)
	await withSafeOwnerLookupFailure('unexpected', async () => {
		await assert.rejects(
			modules.resolveSafeConfirmation(
				simulator.ethereum,
				pendingExecution,
				'accept',
				{ selectedSigner: safeSignerAddress, verificationError: undefined },
			),
			/Unexpected Safe owner decoder failure/u,
		)
		await assert.rejects(
			modules.resolveSafeConfirmation(
				simulator.ethereum,
				pendingExecution,
				'accept',
				{ selectedSigner: alternateSignerAddress, verificationError: undefined },
			),
			/Unexpected Safe owner decoder failure/u,
		)
	})

	fakeSafeContract.version = 'invalid-version'
	const unexpectedErrorBeforeUnsupportedVersion = (await getLatestUnexpectedError())?.data.code
	assert.equal(await withSilencedConsole(async () => await confirmWithSelectedSigner(websiteTabConnections, safeSignerAddress)), false)
	assert.equal((await getLatestUnexpectedError())?.data.code, unexpectedErrorBeforeUnsupportedVersion)
	assert.equal(hasForwardedSignerRequest(postedMessages), false)

	assert.equal(await withSilencedConsole(async () => await confirmWithSelectedSigner(websiteTabConnections, alternateSignerAddress)), false)
	assert.equal((await getLatestUnexpectedError())?.data.code, unexpectedErrorBeforeUnsupportedVersion)
	fakeSafeContract.version = '1.4.1'
	assert.equal(await confirmWithSelectedSigner(websiteTabConnections, alternateSignerAddress), false)
	assert.equal(hasForwardedSignerRequest(postedMessages), false)
	const [refreshedExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedExecution?.approvalStatus.status, 'WaitingForUser')
	assert.equal(refreshedExecution?.type === 'Transaction' ? refreshedExecution.safeExecutionSignerAddress : undefined, alternateSignerAddress)
	assert.equal(refreshedExecution?.originalRequestParameters.method === 'eth_sendTransaction' ? refreshedExecution.originalRequestParameters.params[0].from : undefined, alternateSignerAddress)

	await setWalletAccounts([safeSignerAddress])
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
	const [recoveredExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(recoveredExecution?.approvalStatus.status, 'WaitingForUser')

	fakeSafeContract.nonce += 1n
	assert.equal(await confirmWithSelectedSigner(websiteTabConnections, safeSignerAddress), false)
	assert.equal(hasForwardedSignerRequest(postedMessages), false)
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
	assert.equal(await confirmWithSelectedSigner(websiteTabConnections, safeSignerAddress), false)
	assert.equal(hasForwardedSignerRequest(postedMessages), false)
	const [changedOwnersExecution] = await modules.getPendingTransactionsAndMessages()
	assert.equal(changedOwnersExecution?.approvalStatus.status, 'SignerError')
	if (changedOwnersExecution?.approvalStatus.status !== 'SignerError') throw new Error('Missing changed-owner Gnosis Safe execution error')
	assert.match(changedOwnersExecution.approvalStatus.message, /owner set changed/u)

	fakeSafeContract.owners = [existingOwnerAddress, safeSignerAddress, alternateSignerAddress]
	await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({
		...pending,
		approvalStatus: { status: 'WaitingForUser' as const },
	}))
	assert.equal(await confirmWithSelectedSigner(websiteTabConnections, safeSignerAddress), true)
	const signerRequest = requireForwardedSignerRequest(postedMessages, 'direct Safe execution signer request')
	const signerTransaction = ForwardedTransaction.safeParse(signerRequest.params[0])
	if (!signerTransaction.success) throw new Error('Missing direct Safe execution transaction parameters')
	assert.equal(signerRequest.method, 'eth_sendTransaction')
	assert.equal(signerTransaction.value.from, addressString(safeSignerAddress))
	assert.equal(signerTransaction.value.to, addressString(activeAddress))
	const prevalidatedSignerSignature = `0x${ safeSignerAddress.toString(16).padStart(64, '0') }${ '0'.repeat(64) }01`
	const completedSignatures = [
		{ signer: existingOwnerAddress, signature: existingSignature },
		{ signer: safeSignerAddress, signature: prevalidatedSignerSignature },
	]
		.sort((left, right) => left.signer < right.signer ? -1 : left.signer > right.signer ? 1 : 0)
		.map(({ signature }) => signature.slice(2))
		.join('')
	assert.equal(signerTransaction.value.data, encodeExecTransactionToRecipient(`0x${ completedSignatures }`))
	assert.equal(hasPostedMethod(postedMessages, 'eth_signTypedData_v4'), false)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])

	const transactionHash = `0x${ 'ab'.repeat(32) }`
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: transactionHash, uniqueRequestIdentifier },
	}), true)
	const dappReply = requireWebsiteReply(postedMessages, { type: 'result', method: 'eth_sendTransaction', requestId: uniqueRequestIdentifier.requestId }, 'direct Safe execution dapp reply')
	assert.equal(dappReply.result, transactionHash)
})

test('blocks direct Safe execution when the configured signer cannot satisfy the threshold', async () => {
	const configuredSigner = recipientAddress
	const existingOwnerAddress = safeTestOwnerAddress
	const safeTx = createSafeTxToRecipient({ nonce: fakeSafeContract.nonce })
	const existingSignature = await safeTestOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	fakeSafeContract.threshold = 3n
	fakeSafeContract.owners = [existingOwnerAddress, configuredSigner, 0x1111111111111111111111111111111111111111n]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: configuredSigner,
	})])
	await setWalletAccounts([configuredSigner], { signerChain: fakeRpcNetwork.chainId })
	const transactionParams = createSendTransactionParams({ data: encodeExecTransactionToRecipient(existingSignature) })
	const { postedMessages, websiteTabConnections } = connectWebsite({ websiteOrigin: sealwortWebsite.websiteOrigin })

	assert.deepEqual(await withSilencedConsole(async () => await openTransactionConfirmation(transactionParams, sealwortWebsite, websiteTabConnections)), { type: 'doNotReply' })

	const [pendingFailure] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingFailure?.transactionOrMessageCreationStatus, 'FailedToSimulate')
	if (pendingFailure?.type !== 'Transaction' || !('transactionToSimulate' in pendingFailure)) throw new Error('Missing failed direct Safe execution confirmation')
	assert.equal(pendingFailure.transactionToSimulate.success, false)
	if (pendingFailure.transactionToSimulate.success) throw new Error('Expected Safe execution preparation failure')
	assert.match(pendingFailure.transactionToSimulate.error.message, /cannot satisfy its 3-signature threshold/u)
	assert.equal(hasForwardedSignerRequest(postedMessages), false)
})

test('direct Safe execution checks delegate library bytecode before completing or forwarding owner signatures', async () => {
	fakeSafeContract.owners = [safeTestOwnerAddress]
	fakeSafeContract.threshold = 1n
	const safeEntry = createSafeAddressBookEntry({ safeVersion: '1.4.1' })
	const originalGetCode = simulator.ethereum.getCode.bind(simulator.ethereum)
	let libraryCode = new Uint8Array()
	const blocks: unknown[] = []
	const getCode = spyOn(simulator.ethereum, 'getCode').mockImplementation(async (address, block, abortController) => {
		if (address !== SAFE_MULTI_SEND_CALL_ONLY && address !== SAFE_SIGN_MESSAGE_LIB) return await originalGetCode(address, block, abortController)
		blocks.push(block)
		return libraryCode
	})
	const delegateLibraryCalls = [
		{ to: SAFE_MULTI_SEND_CALL_ONLY, data: dataStringWith0xStart(encodeSafeBatch([{ to: recipientAddress, value: 0n, data: new Uint8Array() }, { to: recipientAddress, value: 1n, data: new Uint8Array() }])), bytecode: multiSendLibrary.deployedBytecode },
		{ to: SAFE_SIGN_MESSAGE_LIB, data: encodeFunctionCall(SAFE_SIGN_MESSAGE_ABI, 'signMessage', [`0x${ '12'.repeat(32) }`]), bytecode: signMessageLibrary.deployedBytecode },
	]
	const packedSignatureVariants = ['0x', `0x${ '00'.repeat(65) }`] as const
	try {
		for (const { to, data, bytecode } of delegateLibraryCalls) {
			for (const signatures of packedSignatureVariants) {
				const request = createSendTransactionParams({ data: encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(to), 0n, data, 1n, 0n, 0n, 0n, addressString(0n), addressString(0n), signatures]) })
				for (const invalidCode of [new Uint8Array(), new Uint8Array([1])]) {
					libraryCode = invalidCode
					await assert.rejects(modules.prepareSafeExecutionSignerRoute(simulator.ethereum, request, safeEntry, safeTestOwnerAddress), /missing or has unexpected bytecode/)
				}
				libraryCode = stringToUint8Array(bytecode)
				const route = await modules.prepareSafeExecutionSignerRoute(simulator.ethereum, request, safeEntry, safeTestOwnerAddress)
				assert.equal(route?.executor, safeTestOwnerAddress)
				assert.equal(route?.transactionParams.params[0].from, safeTestOwnerAddress)
			}
		}
		assert.equal(blocks.length, 12)
		assert.ok(blocks.every((block) => block === 123n))
	} finally { getCode.mockRestore() }
})
