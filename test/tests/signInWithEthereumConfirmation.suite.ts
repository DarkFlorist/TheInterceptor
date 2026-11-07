import * as assert from 'assert'
import { test } from 'bun:test'
import { checksummedAddress } from '../../app/ts/utils/bigint.js'
import { bytesToHex, stringToBytes } from '../../app/ts/utils/ethereumBytes.js'
import { SIWE_LOOKALIKE_QUARANTINE_REASON } from '../../app/ts/utils/siwe.js'
import { activeAddress, createWebsitePort, fakeRpcNetwork, modules, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

// A sign-in message without a scheme, which means https, for the local dapp at localhost:3000.
const localDappSiweMessage = (chainId: bigint) => [
	'localhost:3000 wants you to sign in with your Ethereum account:',
	checksummedAddress(activeAddress),
	'',
	'',
	'URI: http://localhost:3000/login',
	'Version: 1',
	`Chain ID: ${ chainId }`,
	'Nonce: 32891756',
	'Issued At: 2021-09-30T16:25:24Z',
].join('\n')

// Opens the confirmation dialog for a personal_sign request sent by a frame at `pageUrl` and returns the reply to the page together with the stored pending message.
async function openSignInConfirmation(siweMessage: string, pageUrl: string) {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const signRequest = {
		method: 'personal_sign' as const,
		params: [bytesToHex(stringToBytes(siweMessage)), activeAddress] as const,
	}
	const request = {
		interceptorRequest: true as const,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier,
		...signRequest,
	}
	const socket = uniqueRequestIdentifier.requestSocket
	const websitePort = createWebsitePort(socket, 0, [])
	const port = { ...websitePort, sender: { ...websitePort.sender, url: pageUrl } }
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'localhost:3000', approved: true, wantsToConnect: true },
		},
	}]])
	const reply = await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		true,
		activeAddress,
		{ websiteOrigin: 'localhost:3000', icon: undefined, title: 'Local dapp' },
		websiteTabConnections,
	)
	return { reply, pendingMessages: await modules.getPendingTransactionsAndMessages() }
}

async function openSimulatedSignInConfirmation(siweMessage: string, pageUrl: string) {
	const { reply, pendingMessages } = await openSignInConfirmation(siweMessage, pageUrl)
	assert.deepEqual(reply, { type: 'doNotReply' })
	assert.equal(pendingMessages.length, 1)
	const [pendingMessage] = pendingMessages
	if (pendingMessage?.type !== 'SignableMessage' || pendingMessage.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Missing simulated sign-in message')
	return pendingMessage
}

test('records the full origin of the requesting frame so a sign-in message without a scheme is checked against an http page', async () => {
	// No scheme in the message means https, while the request comes from an http page on the same host.
	const pendingMessage = await openSimulatedSignInConfirmation(localDappSiweMessage(fakeRpcNetwork.chainId), 'http://localhost:3000/login')
	assert.equal(pendingMessage.signedMessageTransaction.requestOrigin, 'http://localhost:3000')
	assert.equal(pendingMessage.visualizedPersonalSignRequest.type, 'SignInWithEthereum')
	assert.equal(pendingMessage.visualizedPersonalSignRequest.quarantine, true)
	assert.deepEqual(pendingMessage.visualizedPersonalSignRequest.quarantineReasons, [
		'This sign-in message is for https://localhost:3000 (a sign-in message that names no scheme is for https), but it was requested by http://localhost:3000. A website asking you to sign in to a different website is a common phishing attack.',
	])
})

test('stores a sign-in message with the largest chain ID a stored request can hold', async () => {
	const pendingMessage = await openSimulatedSignInConfirmation(localDappSiweMessage(2n ** 256n - 1n), 'https://localhost:3000/login')
	if (pendingMessage.visualizedPersonalSignRequest.type !== 'SignInWithEthereum') throw new Error(`expected a Sign-In with Ethereum visualization, got ${ pendingMessage.visualizedPersonalSignRequest.type }`)
	assert.equal(pendingMessage.visualizedPersonalSignRequest.message.chainId, 2n ** 256n - 1n)
})

test('quarantines a sign-in message whose chain ID a stored request cannot hold instead of leaving its confirmation half-stored', async () => {
	const pendingMessage = await openSimulatedSignInConfirmation(localDappSiweMessage(2n ** 256n), 'https://localhost:3000/login')
	assert.equal(pendingMessage.visualizedPersonalSignRequest.type, 'NotParsed')
	assert.equal(pendingMessage.visualizedPersonalSignRequest.quarantine, true)
	assert.deepEqual(pendingMessage.visualizedPersonalSignRequest.quarantineReasons, [SIWE_LOOKALIKE_QUARANTINE_REASON])
})
