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

async function prepareMessageReview(data = typedData()) {
	const signRequest = () => ({ method: 'eth_signTypedData_v4' as const, params: [activeAddress, EIP712Message.parse(JSON.stringify(data))] as const })
	fakeSafeContract.messageHash = BigInt(hashTypedData(data))
	fakeSafeContract.owners = [safeTestOwnerAddress]
	fakeSafeContract.threshold = 1n
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({ ...state, signerAccounts: [safeTestOwnerAddress], activeSigningAddress: safeTestOwnerAddress, signerChain: fakeRpcNetwork.chainId }))
	const socket = uniqueRequestIdentifier.requestSocket
	const port = createWebsitePort(socket, 0, [])
	const connections = new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: { socket, port, websiteOrigin: 'safe-app.example', approved: true, wantsToConnect: true } } }]])
	const request = { ...signRequest(), interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier }
	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, signRequest(), false, activeAddress, { websiteOrigin: 'safe-app.example', icon: undefined, title: 'Safe App' }, connections), { type: 'doNotReply' })
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'SignableMessage' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Missing Safe message review')
	return pending
}

test('Safe Apps signMessage hashes UTF-8 text with the canonical Safe EIP-712 envelope', async () => {
	const data = typedData()
	assert.equal(data.message.message, hashMessage(originalMessage))
	assert.equal(hashTypedData(data), hashTypedData({ ...data, message: { message: hashMessage(originalMessage) } }))
	assert.equal(SafeMessage.safeParse(EIP712Message.parse(JSON.stringify(data))).success, true)
	assert.equal(isSafeMessageCoSignRequest(signRequest(), activeAddress, fakeRpcNetwork.chainId), true)
	assert.equal(isSafeMessageCoSignRequest(signRequest(), activeAddress + 1n, fakeRpcNetwork.chainId), false)
	assert.equal(isSafeMessageCoSignRequest(signRequest(), activeAddress, fakeRpcNetwork.chainId + 1n), false)
	const misleading = { ...data, safeMessageText: 'Different text' }
	assert.equal(isSafeMessageCoSignRequest({ ...signRequest(), params: [activeAddress, EIP712Message.parse(JSON.stringify(misleading))] }, activeAddress, fakeRpcNetwork.chainId), false)
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
	assert.equal(pending.visualizedPersonalSignRequest.type, 'EIP712')
	if (pending.visualizedPersonalSignRequest.type !== 'EIP712') throw new Error('Expected EIP-712 review')
	assert.equal(pending.visualizedPersonalSignRequest.safeMessageText, originalMessage)
	const resolution = await modules.resolveSafeConfirmation(simulator.ethereum, pending, 'accept', { selectedSigner: safeTestOwnerAddress, verificationError: undefined })
	assert.equal(resolution.status, 'ready')
	if (resolution.status !== 'ready' || resolution.signerFacingRequest?.method !== 'eth_signTypedData_v4') throw new Error('Missing signer request')
	assert.equal(resolution.signerFacingRequest.params[0], safeTestOwnerAddress)
	assert.equal(hashTypedData(resolution.signerFacingRequest.params[1]), hashTypedData(typedData()))
	const signature = await safeTestOwnerAccount.signTypedData(typedData())
	assert.deepEqual(await modules.resolveSafeSignerReply(simulator.ethereum, simulator.tokenPriceService, pending, signature), { status: 'success', result: signature })
	const wrongSignature = await safeTestOwnerAccount.signMessage({ message: originalMessage })
	assert.equal((await modules.resolveSafeSignerReply(simulator.ethereum, simulator.tokenPriceService, pending, wrongSignature)).status, 'error')
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
	const pending = await prepareMessageReview(envelope)
	if (pending.visualizedPersonalSignRequest.type !== 'EIP712') throw new Error('Missing EIP-712 review')
	assert.equal(pending.visualizedPersonalSignRequest.safeMessageText, original)
	assert.equal(pending.visualizedPersonalSignRequest.safeMessageIsTypedData, true)
	const resolution = await modules.resolveSafeConfirmation(simulator.ethereum, pending, 'accept', { selectedSigner: safeTestOwnerAddress, verificationError: undefined })
	if (resolution.status !== 'ready' || resolution.signerFacingRequest?.method !== 'eth_signTypedData_v4') throw new Error('Missing owner signature request')
	assert.equal(resolution.signerFacingRequest.params[0], safeTestOwnerAddress)
	assert.equal(hashTypedData(resolution.signerFacingRequest.params[1]), hashTypedData(envelope))
	const signature = await safeTestOwnerAccount.signTypedData(envelope)
	assert.equal((await modules.resolveSafeSignerReply(simulator.ethereum, simulator.tokenPriceService, pending, signature)).status, 'success')
	assert.equal(SafeMessage.safeParse(EIP712Message.parse(JSON.stringify({ ...envelope, safeMessageIsTypedData: false }))).success, false)
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
