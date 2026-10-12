import * as assert from 'assert'
import { test } from 'bun:test'
import { checksummedAddress } from '../../app/ts/utils/bigint.js'
import { bytesToHex, stringToBytes } from '../../app/ts/utils/ethereumBytes.js'
import { activeAddress, createWebsitePort, fakeRpcNetwork, modules, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

test('records the requesting frame scheme so a sign-in message without a scheme is checked against an http page', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	// No scheme in the message means https, while the request comes from an http page on the same host.
	const siweMessage = [
		'localhost:3000 wants you to sign in with your Ethereum account:',
		checksummedAddress(activeAddress),
		'',
		'',
		'URI: http://localhost:3000/login',
		'Version: 1',
		`Chain ID: ${ fakeRpcNetwork.chainId }`,
		'Nonce: 32891756',
		'Issued At: 2021-09-30T16:25:24Z',
	].join('\n')
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
	const port = { ...websitePort, sender: { ...websitePort.sender, url: 'http://localhost:3000/login' } }
	const websiteTabConnections = new Map([[socket.tabId, {
		connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'localhost:3000', approved: true, wantsToConnect: true },
		},
	}]])

	assert.deepEqual(await modules.openConfirmTransactionDialogForMessage(
		simulator.ethereum,
		simulator.tokenPriceService,
		request,
		{ kind: 'message', parameters: signRequest },
		true,
		activeAddress,
		{ websiteOrigin: 'localhost:3000', icon: undefined, title: 'Local dapp' },
		websiteTabConnections,
	), { type: 'doNotReply' })

	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	if (pendingMessage?.type !== 'SignableMessage' || pendingMessage.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Missing simulated sign-in message')
	assert.equal(pendingMessage.signedMessageTransaction.websiteScheme, 'http')
	assert.equal(pendingMessage.visualizedPersonalSignRequest.type, 'SignInWithEthereum')
	assert.equal(pendingMessage.visualizedPersonalSignRequest.quarantine, true)
	assert.deepEqual(pendingMessage.visualizedPersonalSignRequest.quarantineReasons, [
		'This sign-in message is for https://localhost:3000 (a sign-in message that names no scheme is for https), but it was requested by http://localhost:3000. A website asking you to sign in to a different website is a common phishing attack.',
	])
})
