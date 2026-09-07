import { addressString } from '../../app/ts/utils/bigint.js'
import { isValidMessage } from '../../app/ts/utils/eip712.js'
import * as assert from 'assert'
import { test } from 'bun:test'
import { SafeMessage, createSafeMessageTypedData } from '../../app/ts/safe/safeMessage.js'
import { isSafeMessageCoSignRequest } from '../../app/ts/safe/safeRequestPolicy.js'
import { getSafeAppsRequestCommand } from '../../app/ts/background/safeAppsRequestPolicy.js'
import { createSafeAppsMessageServices } from '../../app/ts/background/safeAppsMessages.js'
import { hashMessage, hashTypedData } from '../../app/ts/utils/ethereumPrimitives.js'
import { activeAddress, createSafeAddressBookEntry, createWebsitePort, EIP712Message, fakeRpcNetwork, fakeSafeContract, modules, safeTestOwnerAccount, safeTestOwnerAddress, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

const originalMessage = 'Hello Safe 👋'
const typedData = () => createSafeMessageTypedData(fakeRpcNetwork.chainId, activeAddress, originalMessage)
const signRequest = () => ({ method: 'eth_signTypedData_v4' as const, params: [activeAddress, EIP712Message.parse(JSON.stringify(typedData()))] as const })

async function prepareMessageReview(data = typedData(), review = { text: originalMessage, isTypedData: false }, selectedSigner = safeTestOwnerAddress) {
	const signRequest = () => ({ method: 'eth_signTypedData_v4' as const, params: [activeAddress, EIP712Message.parse(JSON.stringify(data))] as const })
	fakeSafeContract.messageHash = BigInt(hashTypedData(data))
	fakeSafeContract.owners = [safeTestOwnerAddress]
	fakeSafeContract.threshold = 1n
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({ ...state, signerAccounts: [selectedSigner], activeSigningAddress: selectedSigner, signerChain: fakeRpcNetwork.chainId }))
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, [])
	const connections = new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: { socket, port, websiteOrigin: 'safe-app.example', approved: true, wantsToConnect: true } } }]])
	const request = { method: signRequest().method, params: [addressString(activeAddress), JSON.stringify(data)], interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier }
	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'message', parameters: signRequest(), review }, false, activeAddress, { websiteOrigin: 'safe-app.example', icon: undefined, title: 'Safe App' }, connections), { type: 'doNotReply' })
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'SignableMessage' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Missing Safe message review')
	return pending
}

test('Safe Apps signMessage hashes UTF-8 text with the canonical Safe EIP-712 envelope', async () => {
	const data = typedData()
	assert.equal(data.message.message, hashMessage(originalMessage))
	assert.equal(hashTypedData(data), hashTypedData({ ...data, message: { message: hashMessage(originalMessage) } }))
	assert.equal(SafeMessage.safeParse({ typedData: EIP712Message.parse(JSON.stringify(data)), review: { text: originalMessage, isTypedData: false } }).success, true)
	assert.equal(isSafeMessageCoSignRequest(signRequest(), activeAddress, fakeRpcNetwork.chainId, { text: originalMessage, isTypedData: false }), true)
	assert.equal(isSafeMessageCoSignRequest(signRequest(), activeAddress + 1n, fakeRpcNetwork.chainId), false)
	assert.equal(isSafeMessageCoSignRequest(signRequest(), activeAddress, fakeRpcNetwork.chainId + 1n), false)
	assert.equal(isSafeMessageCoSignRequest(signRequest(), activeAddress, fakeRpcNetwork.chainId, { text: 'Different text', isTypedData: false }), false)
	assert.deepEqual(Object.keys(data).sort(), ['domain', 'message', 'primaryType', 'types'])
	const command = await getSafeAppsRequestCommand({ method: 'signMessage', params: { message: originalMessage } }, 'safe-app.example', activeAddress, fakeRpcNetwork, async () => ({ version: '1.4.1', nonce: 0n, threshold: 2n, owners: [safeTestOwnerAddress] }))
	assert.equal(command.kind, 'ethereumRequest')
	if (command.kind !== 'ethereumRequest') throw new Error('Missing signing command')
	assert.equal(command.method, 'eth_signTypedData_v4')
	assert.equal(command.mapResult, 'safeMessage')
	assert.deepEqual(command.params, [data.domain.verifyingContract, JSON.stringify(data)])
	await assert.rejects(getSafeAppsRequestCommand({ method: 'submitOffChainMessage', params: { message: originalMessage, signature: `0x${ '11'.repeat(65) }`, safeAddress: data.domain.verifyingContract, chainId: '999' } }, 'safe-app.example', activeAddress, fakeRpcNetwork, async () => { throw new Error('Unexpected state lookup') }), /account or chain changed/)
})

test('Safe message review shows authenticated text, forwards to the selected owner, and validates its signature', async () => {
	const pending = await prepareMessageReview()
	assert.ok(pending.safeMessageCoSignSnapshot && 'safeMessageHash' in pending.safeMessageCoSignSnapshot)
	assert.equal(pending.visualizedPersonalSignRequest.type, 'SafeMessage')
	if (pending.visualizedPersonalSignRequest.type !== 'SafeMessage') throw new Error('Expected EIP-712 review')
	assert.equal(pending.visualizedPersonalSignRequest.review.text, originalMessage)
	const resolution = await modules.resolveSafeConfirmation(simulator.ethereum, pending, 'accept', { selectedSigner: safeTestOwnerAddress, verificationError: undefined })
	assert.equal(resolution.status, 'ready')
	if (resolution.status !== 'ready' || resolution.signerFacingRequest?.method !== 'eth_signTypedData_v4') throw new Error('Missing signer request')
	assert.equal(resolution.signerFacingRequest.params[0], safeTestOwnerAddress)
	assert.equal(hashTypedData(resolution.signerFacingRequest.params[1]), hashTypedData(typedData()))
	assert.deepEqual(Object.keys(resolution.signerFacingRequest.params[1]).sort(), ['domain', 'message', 'primaryType', 'types'])
	assert.deepEqual(isValidMessage(resolution.signerFacingRequest), { valid: true })
	const signature = await safeTestOwnerAccount.signTypedData(typedData())
	assert.deepEqual(await modules.resolveSafeSignerReply(simulator.ethereum, simulator.tokenPriceService, pending, signature), { status: 'success', result: signature })
	const wrongSignature = await safeTestOwnerAccount.signMessage({ message: originalMessage })
	assert.equal((await modules.resolveSafeSignerReply(simulator.ethereum, simulator.tokenPriceService, pending, wrongSignature)).status, 'error')
	const alteredTransport = { ...pending, signedMessageTransaction: { ...pending.signedMessageTransaction, request: { ...pending.signedMessageTransaction.request, params: ['unrelated transport metadata'] } } }
	assert.equal((await modules.resolveSafeSignerReply(simulator.ethereum, simulator.tokenPriceService, alteredTransport, signature)).status, 'success')
	const alteredReview = { ...pending, signedMessageTransaction: { ...pending.signedMessageTransaction, safeMessageReview: { text: 'Altered review text', isTypedData: false } } }
	assert.equal((await modules.resolveSafeSignerReply(simulator.ethereum, simulator.tokenPriceService, alteredReview, signature)).status, 'error')
	fakeSafeContract.messageHash = 0n
	assert.equal((await modules.resolveSafeSignerReply(simulator.ethereum, simulator.tokenPriceService, pending, signature)).status, 'error')
	fakeSafeContract.messageHash = BigInt(hashTypedData(typedData()))
	fakeSafeContract.threshold = 2n
	assert.equal((await modules.resolveSafeSignerReply(simulator.ethereum, simulator.tokenPriceService, pending, signature)).status, 'error')
})

test('Safe message service submits validated owner signatures and requires the live threshold for retrieval', async () => {
	fakeSafeContract.owners = [safeTestOwnerAddress]
	fakeSafeContract.threshold = 1n
	const services = createSafeAppsMessageServices(simulator.ethereum, activeAddress, fakeRpcNetwork.chainId)
	const signature = await safeTestOwnerAccount.signTypedData(typedData())
	const messageHash = hashTypedData(typedData())
	const originalFetch = globalThis.fetch
	const submitted: unknown[] = []
	let stored = false
	globalThis.fetch = async (_url, init) => {
		if (init?.method === 'POST') {
			if (typeof init.body !== 'string') throw new Error('Missing submission body')
			submitted.push(JSON.parse(init.body))
			stored = true
			return new Response(undefined, { status: 202 })
		}
		return stored ? Response.json({ messageHash, message: originalMessage, confirmations: [{ signature }] }) : new Response(undefined, { status: 404 })
	}
	try {
		assert.deepEqual(await services.submit(originalMessage, signature), { messageHash })
		assert.deepEqual(submitted, [{ message: originalMessage, signature }])
		assert.deepEqual(await services.submit(originalMessage, signature), { messageHash })
		assert.equal(submitted.length, 1)
		assert.equal(await services.getSignature(messageHash), signature)
		fakeSafeContract.messageSignatureValid = false
		await assert.rejects(services.getSignature(messageHash), /did not accept/)
		fakeSafeContract.messageSignatureValid = true
		fakeSafeContract.threshold = 2n
		assert.deepEqual(await getSafeAppsRequestCommand({ method: 'getOffChainSignature', params: messageHash }, 'safe-app.example', activeAddress, fakeRpcNetwork, async () => { throw new Error('Unexpected state lookup') }, services), { kind: 'result', value: '' })
		await assert.rejects(services.submit('Different message', signature))
		assert.equal(submitted.length, 1)
		globalThis.fetch = async () => Response.json({ messageHash, message: 'Wrong text', confirmations: [{ signature }] })
		await assert.rejects(services.getSignature(messageHash), /does not match/)
		globalThis.fetch = async () => new Response(undefined, { status: 503 })
		await assert.rejects(services.getSignature(messageHash), /HTTP 503/)
	} finally {
		globalThis.fetch = originalFetch
	}
})

const appTypedData = {
	types: { EIP712Domain: [{ name: 'name', type: 'string' }], Mail: [{ name: 'contents', type: 'string' }, { name: 'amount', type: 'uint256' }] },
	primaryType: 'Mail', domain: { name: 'Safe test' }, message: { contents: 'Hello typed Safe', amount: '9007199254740993' },
}

test('Safe typed messages authenticate the original EIP-712 data through review, owner signing and gateway retrieval', async () => {
	const original = JSON.stringify(appTypedData, undefined, 2)
	const envelope = createSafeMessageTypedData(fakeRpcNetwork.chainId, activeAddress, original, true)
	assert.equal(envelope.message.message, hashTypedData(appTypedData))
	assert.equal(createSafeMessageTypedData(fakeRpcNetwork.chainId, activeAddress, JSON.stringify({ domain: appTypedData.domain, types: { Mail: appTypedData.types.Mail }, message: appTypedData.message }), true).message.message, envelope.message.message)
	assert.notEqual(envelope.message.message, hashMessage(original))
	const command = await getSafeAppsRequestCommand({ method: 'signTypedMessage', params: { typedData: appTypedData } }, 'app.example', activeAddress, fakeRpcNetwork, async () => { throw new Error('Unexpected state lookup') })
	if (command.kind !== 'ethereumRequest' || command.mapResult !== 'safeMessage') throw new Error('Missing typed signing command')
	assert.equal(command.isTypedData, true)
	assert.equal(command.message, original)
	const pending = await prepareMessageReview(envelope, { text: original, isTypedData: true })
	if (pending.visualizedPersonalSignRequest.type !== 'SafeMessage') throw new Error('Missing EIP-712 review')
	assert.equal(pending.visualizedPersonalSignRequest.review.text, original)
	assert.equal(pending.visualizedPersonalSignRequest.review.isTypedData, true)
	const resolution = await modules.resolveSafeConfirmation(simulator.ethereum, pending, 'accept', { selectedSigner: safeTestOwnerAddress, verificationError: undefined })
	if (resolution.status !== 'ready' || resolution.signerFacingRequest?.method !== 'eth_signTypedData_v4') throw new Error('Missing owner signature request')
	assert.equal(resolution.signerFacingRequest.params[0], safeTestOwnerAddress)
	assert.equal(hashTypedData(resolution.signerFacingRequest.params[1]), hashTypedData(envelope))
	const signature = await safeTestOwnerAccount.signTypedData(envelope)
	assert.equal((await modules.resolveSafeSignerReply(simulator.ethereum, simulator.tokenPriceService, pending, signature)).status, 'success')
	assert.equal(SafeMessage.safeParse({ typedData: EIP712Message.parse(JSON.stringify(envelope)), review: { text: original, isTypedData: false } }).success, false)
	const services = createSafeAppsMessageServices(simulator.ethereum, activeAddress, fakeRpcNetwork.chainId)
	const messageHash = hashTypedData(envelope)
	const originalFetch = globalThis.fetch
	let stored = false
	globalThis.fetch = async (_url, init) => {
		if (init?.method === 'POST') {
			assert.equal(typeof init.body, 'string')
			assert.deepEqual(JSON.parse(String(init.body)), { message: appTypedData, signature })
			stored = true
			return new Response(undefined, { status: 202 })
		}
		return stored ? Response.json({ messageHash, message: appTypedData, confirmations: [{ signature }] }) : new Response(undefined, { status: 404 })
	}
	try {
		assert.deepEqual(await services.submit(original, signature, true), { messageHash })
		assert.equal(await services.getSignature(messageHash), signature)
		await assert.rejects(services.submit(original, signature, false))
	} finally { globalThis.fetch = originalFetch }
	await assert.rejects(getSafeAppsRequestCommand({ method: 'signTypedMessage', params: { typedData: { ...appTypedData, message: { contents: 'Missing amount' } } } }, 'app.example', activeAddress, fakeRpcNetwork, async () => { throw new Error('Unexpected state lookup') }), /Invalid Safe typed message/)
})

for (const isTypedData of [false, true]) test(`Safe ${ isTypedData ? 'typed' : 'plain' } message recovers after selecting an owner`, async () => {
	const text = isTypedData ? JSON.stringify(appTypedData) : originalMessage
	const data = createSafeMessageTypedData(fakeRpcNetwork.chainId, activeAddress, text, isTypedData)
	const pending = await prepareMessageReview(data, { text, isTypedData }, safeTestOwnerAddress + 1n)
	assert.equal(pending.approvalStatus.status, 'SignerError')
	assert.equal(pending.safeMessageCoSignSnapshot, undefined)
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({ ...state, signerAccounts: [safeTestOwnerAddress], activeSigningAddress: safeTestOwnerAddress }))
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, uniqueRequestIdentifier.requestSocket.tabId)
	const [recovered] = await modules.getPendingTransactionsAndMessages()
	if (recovered?.type !== 'SignableMessage') throw new Error('Missing recovered Safe message')
	assert.equal(recovered.approvalStatus.status, 'WaitingForUser')
	assert.equal(recovered.safeMessageCoSignSnapshot?.safeSignerAddress, safeTestOwnerAddress)
	const result = await modules.resolveSafeConfirmation(simulator.ethereum, recovered, 'accept', { selectedSigner: safeTestOwnerAddress, verificationError: undefined })
	if (result.status !== 'ready' || result.signerFacingRequest?.method !== 'eth_signTypedData_v4') throw new Error('Missing recovered owner request')
	assert.equal(result.signerFacingRequest.params[0], safeTestOwnerAddress)
})
