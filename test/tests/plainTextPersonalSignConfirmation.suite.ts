import * as assert from 'assert'
import { test } from 'bun:test'
import { personalEcRecover } from '../../app/ts/background/personalEcRecoverRpc.js'
import { EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { hashMessage } from '../../app/ts/utils/ethereumPrimitives.js'
import { activeAddress, createWebsitePort, isRecord, modules, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

const plainTextMessage = 'Hello world'
const website = { websiteOrigin: 'https://plain-text.example', icon: undefined, title: 'Plain text' }

const openPlainTextPersonalSign = async (simulationMode: boolean, postedMessages: unknown[]) => {
	if (activeAddress === undefined) throw new Error('Missing default active address')
	const signRequest = { method: 'personal_sign' as const, params: [plainTextMessage, activeAddress] as const }
	const request = { interceptorRequest: true as const, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, ...signRequest }
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, { connections: {
		[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
			port: createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages),
			socket: uniqueRequestIdentifier.requestSocket,
			websiteOrigin: website.websiteOrigin,
			approved: true,
			wantsToConnect: true,
		},
	} }]])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(simulator.ethereum, simulator.tokenPriceService, request, { kind: 'message', parameters: signRequest }, simulationMode, activeAddress, website, websiteTabConnections), { type: 'doNotReply' })

	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	if (pendingMessage?.type !== 'SignableMessage' || pendingMessage.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Missing visualized plain-text personal_sign request')
	const visualized = pendingMessage.visualizedPersonalSignRequest
	assert.equal(visualized.type, 'NotParsed')
	assert.equal(visualized.message, plainTextMessage)
	assert.equal(visualized.messageHash, hashMessage(plainTextMessage))
	const accept = async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	})
	return { signerAddress: activeAddress, accept }
}

test('forwards an accepted plain-text personal_sign request to the signer with its original parameters', async () => {
	const postedMessages: unknown[] = []
	const { signerAddress, accept } = await openPlainTextPersonalSign(false, postedMessages)

	assert.equal(await accept(), true)
	const forwarded = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
	if (!isRecord(forwarded)) throw new Error('Missing forwarded personal_sign request')
	assert.equal(forwarded.method, 'personal_sign')
	assert.deepEqual(forwarded.params, [plainTextMessage, addressString(signerAddress)])
})

test('answers an accepted plain-text personal_sign request in simulation mode with a signature personal_ecRecover maps to the simulated signer', async () => {
	const postedMessages: unknown[] = []
	const { signerAddress, accept } = await openPlainTextPersonalSign(true, postedMessages)

	assert.equal(await accept(), true)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
	const reply = postedMessages.find((message) => isRecord(message) && message.method === 'personal_sign' && typeof message.result === 'string')
	if (!isRecord(reply) || typeof reply.result !== 'string') throw new Error('Missing simulated personal_sign signature')

	const stackMessages = (await modules.getInterceptorTransactionStack()).operations.flatMap((operation) => operation.type === 'Message' ? [operation.signedMessageTransaction] : [])
	const ecRecoverRequest = EthereumJsonRpcRequest.parse({ method: 'personal_ecRecover', params: [plainTextMessage, reply.result] })
	if (ecRecoverRequest.method !== 'personal_ecRecover') throw new Error('Expected a personal_ecRecover request')
	assert.deepEqual(await personalEcRecover(ecRecoverRequest, stackMessages), { type: 'result', method: 'personal_ecRecover', result: signerAddress })
})
