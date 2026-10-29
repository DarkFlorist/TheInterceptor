import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1'
import { personalEcRecover } from '../../app/ts/background/personalEcRecoverRpc.js'
import { getSafeModeRpcPolicyReply } from '../../app/ts/safe/safeRequestPolicy.js'
import { simulatePersonalSign } from '../../app/ts/simulation/services/simulationPersonalSigning.js'
import type { PersonalSignParams } from '../../app/ts/types/jsonRpc-signing-types.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import type { SignedMessageTransaction } from '../../app/ts/types/visualizer-types.js'
import type { WebsiteSocket } from '../../app/ts/utils/requests.js'
import { addressString, bytes32String } from '../../app/ts/utils/bigint.js'
import { bytesToHex, hashMessage, privateKeyToAccount, stringToBytes } from '../../app/ts/utils/ethereumPrimitives.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, EthereumJsonRpcRequest, installBrowserMock, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const privateKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const signerAddress = 0xFCAd0B19bB29D4674531d6f115237E16AfCE377cn
const helloMessage = '0x68656c6c6f'
// personal_sign signature of the UTF-8 bytes of 'hello' by privateKey, shared with the ethereumPrimitives fixtures.
const helloSignature = '0x0c3324046197fec2336027b2c0931a7b4d5e8fc063e1977b46ab510d6dc493057889019d0e4a07d56babffba4a017a4c85c69aae7dcfacdb004e75ed453a46511b'
// helloSignature has recovery byte 27 (yParity 0), so its EIP-2098 compact form is just r || s.
const helloCompactSignature = helloSignature.slice(0, -2)
// The EIP-2098 test vectors (yParity 0 and 1), signed by private key 0x1234...1234.
const eip2098Signer = 0x2e988A386a799F506693793c6A5AF6B54dfAaBfBn
const eip2098Vectors = [
	{ message: 'Hello World', signature: '0x68a020a209d3d56c46f38cc50a33f704f4a9a10a59377f8dd762ac66910e9b907e865ad05c4035ab5792787d4a0297a43617ae897930a6fe4d822b8faea520641b', compactSignature: '0x68a020a209d3d56c46f38cc50a33f704f4a9a10a59377f8dd762ac66910e9b907e865ad05c4035ab5792787d4a0297a43617ae897930a6fe4d822b8faea52064' },
	{ message: 'It\'s a small(er) world', signature: '0x9328da16089fcba9bececa81663203989f2df5fe1faa6291a45381c81bd17f76139c6d6b623b42da56557e5e734a43dc83345ddfadec52cbe24d0cc64f5507931c', compactSignature: '0x9328da16089fcba9bececa81663203989f2df5fe1faa6291a45381c81bd17f76939c6d6b623b42da56557e5e734a43dc83345ddfadec52cbe24d0cc64f550793' },
] as const
const simulatedSigner = 0x1111111111111111111111111111111111111111n
const mockSimulationKeyAddress = 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cFn
const websiteOrigin = 'https://example.test'
const website = { websiteOrigin, icon: undefined, title: undefined }

const parsePersonalEcRecover = (params: readonly unknown[]) => {
	const request = EthereumJsonRpcRequest.parse({ method: 'personal_ecRecover', params })
	if (request.method !== 'personal_ecRecover') throw new Error('Expected a personal_ecRecover request')
	return request
}

const createSignedMessage = (fakeSignedFor: bigint, message: string, socket: WebsiteSocket): SignedMessageTransaction => {
	const originalRequestParameters: PersonalSignParams = { method: 'personal_sign', params: [message, fakeSignedFor] }
	return {
		website,
		created: new Date('2026-10-01T00:00:00.000Z'),
		activeAddress: fakeSignedFor,
		fakeSignedFor,
		originalRequestParameters,
		request: {
			...originalRequestParameters,
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: socket },
		},
		simulationMode: true,
		messageIdentifier: 1n,
	}
}

const getSimulatedSignature = async (signedMessage: SignedMessageTransaction) => (await simulatePersonalSign(signedMessage.originalRequestParameters, signedMessage.fakeSignedFor)).signature

const toSignatureHex = (r: bigint, s: bigint, yParity: number) => `${ bytes32String(r) }${ bytes32String(s).slice(2) }${ (27 + yParity).toString(16) }`

// With s = 1 and R = hash * G, recovery computes r^-1 * (s * R - hash * G), which is the point at infinity.
const getSignatureRecoveringToInfinity = (message: string) => {
	const messageHashScalar = BigInt(hashMessage({ raw: message })) % secp256k1.CURVE.n
	const compressedR = secp256k1.getPublicKey(messageHashScalar, true)
	const r = BigInt(bytesToHex(compressedR.slice(1)))
	assert.ok(r < secp256k1.CURVE.n)
	return toSignatureHex(r, 1n, compressedR[0] === 3 ? 1 : 0)
}

const recoveredHelloSignerAddress = '0xfcad0b19bb29d4674531d6f115237e16afce377c'

const invalidSignatureReply = {
	type: 'result',
	method: 'personal_ecRecover',
	error: { code: -32602, message: 'Invalid personal_ecRecover signature. The signature does not recover to any address.' },
}

describe('personal_ecRecover parameters', () => {
	test('accepts any message string and every signature encoding of the same r, s and yParity', () => {
		const withRecoveryOffset = parsePersonalEcRecover([helloMessage, helloSignature])
		assert.equal(withRecoveryOffset.params[1].yParity, 0)
		assert.deepEqual(parsePersonalEcRecover([helloMessage, `${ helloSignature.slice(0, -2) }00`]).params[1], withRecoveryOffset.params[1])
		assert.deepEqual(parsePersonalEcRecover([helloMessage, helloCompactSignature]).params[1], withRecoveryOffset.params[1])
		for (const { signature, compactSignature } of eip2098Vectors) assert.deepEqual(parsePersonalEcRecover(['', compactSignature]).params[1], parsePersonalEcRecover(['', signature]).params[1])
		for (const message of ['0x', 'hello', '0x123', '']) assert.equal(parsePersonalEcRecover([message, helloSignature]).params[0], message)
	})

	test('ignores parameters after the message and signature like MetaMask', () => {
		const request = parsePersonalEcRecover([helloMessage, helloSignature, 'ignored', { ignored: true }])
		assert.deepEqual(request.params, parsePersonalEcRecover([helloMessage, helloSignature]).params)
	})

	test('rejects non-string messages, malformed signatures and missing parameters', () => {
		for (const params of [
			[5, helloSignature],
			[helloMessage, helloSignature.slice(0, -4)],
			[helloMessage, `${ helloSignature }00`],
			[helloMessage, `${ helloSignature.slice(0, -2) }02`],
			[helloMessage, helloSignature.slice(2)],
			[helloMessage, 5],
			[helloMessage],
			[],
		]) {
			assert.equal(EthereumJsonRpcRequest.safeParse({ method: 'personal_ecRecover', params }).success, false, JSON.stringify(params))
		}
		for (const request of [{ method: 'personal_ecRecover' }, { method: 'personal_ecRecover', params: helloMessage }]) {
			assert.equal(EthereumJsonRpcRequest.safeParse(request).success, false, JSON.stringify(request))
		}
	})
})

describe('personal_ecRecover recovery', () => {
	test('recovers the signer of hex and plain text messages like MetaMask', async () => {
		const recoveredSigner = { type: 'result', method: 'personal_ecRecover', result: signerAddress }
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([helloMessage, helloSignature]), [], websiteOrigin), recoveredSigner)
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['hello', helloSignature]), [], websiteOrigin), recoveredSigner)
		const account = privateKeyToAccount(privateKey)
		const bytesMessage = '0x00ff4578616d706c65'
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([bytesMessage, await account.signMessage({ message: { raw: bytesMessage } })]), [], websiteOrigin), recoveredSigner)
		// Odd-length hex is left-padded to whole bytes, and strings that are not 0x-prefixed hex are UTF-8 text.
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['0x123', await account.signMessage({ message: { raw: '0x0123' } })]), [], websiteOrigin), recoveredSigner)
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['68656c6c6f', await account.signMessage({ message: '68656c6c6f' })]), [], websiteOrigin), recoveredSigner)
	})

	test('recovers the EIP-2098 test vectors in full and compact form', async () => {
		for (const { message, signature, compactSignature } of eip2098Vectors) {
			for (const encodedSignature of [signature, compactSignature]) {
				assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([message, encodedSignature]), [], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: eip2098Signer }, encodedSignature)
			}
		}
	})

	test('returns invalid params when the signature does not recover to an address', async () => {
		const helloR = BigInt(helloSignature.slice(0, 66))
		const helloS = BigInt(`0x${ helloSignature.slice(66, 130) }`)
		for (const signature of [
			toSignatureHex(0n, helloS, 0),
			toSignatureHex(helloR, 0n, 0),
			toSignatureHex(secp256k1.CURVE.n, helloS, 0),
			toSignatureHex(5n, helloS, 0),
			getSignatureRecoveringToInfinity(helloMessage),
		]) {
			assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([helloMessage, signature]), [], websiteOrigin), invalidSignatureReply, signature)
		}
	})

	test('maps simulated personal_sign signatures back to the simulated signer', async () => {
		const socket = { tabId: 1, connectionName: 0n }
		const signedMessage = createSignedMessage(simulatedSigner, helloMessage, socket)
		const request = parsePersonalEcRecover([helloMessage, await getSimulatedSignature(signedMessage)])

		assert.deepEqual(await personalEcRecover(request, [signedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['hello', await getSimulatedSignature(signedMessage)]), [signedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
		assert.deepEqual(await personalEcRecover(request, [], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: mockSimulationKeyAddress })
		const otherMessageReply = await personalEcRecover(parsePersonalEcRecover(['0x00', await getSimulatedSignature(signedMessage)]), [signedMessage], websiteOrigin)
		assert.ok(otherMessageReply.type === 'result' && 'result' in otherMessageReply)
		assert.notEqual(otherMessageReply.result, simulatedSigner)
	})

	test('maps simulated plain-text personal_sign signatures back to the simulated signer', async () => {
		const socket = { tabId: 1, connectionName: 0n }
		const recoveredSimulatedSigner = { type: 'result', method: 'personal_ecRecover', result: simulatedSigner }
		for (const message of ['Hello world', 'Grüße 🦊', '']) {
			const signedMessage = createSignedMessage(simulatedSigner, message, socket)
			const signature = await getSimulatedSignature(signedMessage)
			assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([message, signature]), [signedMessage], websiteOrigin), recoveredSimulatedSigner, JSON.stringify(message))
			assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([bytesToHex(stringToBytes(message)), signature]), [signedMessage], websiteOrigin), recoveredSimulatedSigner, JSON.stringify(message))
			assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([message, signature]), [], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: mockSimulationKeyAddress }, JSON.stringify(message))
		}
		// Odd-length hex signs its left-padded bytes, so the even-length form of the same bytes finds the same simulated signer.
		const oddLengthHexMessage = createSignedMessage(simulatedSigner, '0x123', socket)
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['0x0123', await getSimulatedSignature(oddLengthHexMessage)]), [oddLengthHexMessage], websiteOrigin), recoveredSimulatedSigner)
	})

	test('reads unprefixed hex as text like MetaMask personal_ecRecover, unlike personal_sign which signs it as bytes', async () => {
		const socket = { tabId: 1, connectionName: 0n }
		const signedMessage = createSignedMessage(simulatedSigner, '12', socket)
		const signature = await getSimulatedSignature(signedMessage)
		// personal_sign('12') signed the byte 0x12, which personal_ecRecover only reads from the 0x-prefixed form.
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['0x12', signature]), [signedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
		const textReply = await personalEcRecover(parsePersonalEcRecover(['12', signature]), [signedMessage], websiteOrigin)
		assert.ok(textReply.type === 'result' && 'result' in textReply)
		assert.notEqual(textReply.result, simulatedSigner)
		assert.notEqual(textReply.result, mockSimulationKeyAddress)
	})

	test('answers the mock key address for a reproduced mock signature of a message the user did not approve in the simulation', async () => {
		const socket = { tabId: 1, connectionName: 0n }
		const approvedMessage = createSignedMessage(simulatedSigner, helloMessage, socket)
		// The mock keys are public, so the page can sign any message with them itself; only the stacked, user-approved message maps to the simulated signer.
		const unapprovedMessage = createSignedMessage(simulatedSigner, '0x00', socket)
		const reply = await personalEcRecover(parsePersonalEcRecover(['0x00', await getSimulatedSignature(unapprovedMessage)]), [approvedMessage], websiteOrigin)
		assert.deepEqual(reply, { type: 'result', method: 'personal_ecRecover', result: mockSimulationKeyAddress })
	})

	test('prefers the most recent simulated signer when mock-key signatures collide', async () => {
		const socket = { tabId: 1, connectionName: 0n }
		const earlierSignedMessage = createSignedMessage(0x3333333333333333333333333333333333333333n, helloMessage, socket)
		const laterSignedMessage = createSignedMessage(simulatedSigner, helloMessage, socket)
		const sharedSignature = await getSimulatedSignature(laterSignedMessage)
		assert.equal(await getSimulatedSignature(earlierSignedMessage), sharedSignature)

		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([helloMessage, sharedSignature]), [earlierSignedMessage, laterSignedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
	})

	test('maps a simulated signature back to its simulated signer only for the website that requested the signing', async () => {
		const socket = { tabId: 1, connectionName: 0n }
		const signedMessage = createSignedMessage(simulatedSigner, helloMessage, socket)
		// The mock keys are public, so another page can compute this signature for a message it guesses.
		const request = parsePersonalEcRecover([helloMessage, await getSimulatedSignature(signedMessage)])
		assert.deepEqual(await personalEcRecover(request, [signedMessage], 'https://other.example'), { type: 'result', method: 'personal_ecRecover', result: mockSimulationKeyAddress })
		assert.deepEqual(await personalEcRecover(request, [signedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
	})
})

describe('personal_ecRecover routing', () => {
	const setUpWebsiteConnection = async (loadedModules: Awaited<ReturnType<typeof loadModules>>, { approved = true }: { readonly approved?: boolean } = {}) => {
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const websiteTabConnections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[loadedModules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved, wantsToConnect: true },
		} }]])
		const getBlockCalls = { count: 0 }
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter(getBlockCalls)
		const sendPersonalEcRecover = async (requestId: number, params: readonly unknown[] | undefined) => {
			await loadedModules.handleInterceptedRequest(port, websiteOrigin, website, simulationServicesOwner, socket, {
				interceptorRequest: true,
				usingInterceptorWithoutSigner: false,
				uniqueRequestIdentifier: { requestId, requestSocket: socket },
				method: 'personal_ecRecover',
				...(params === undefined ? {} : { params }),
			}, websiteTabConnections, noopPublishRpcConnectionStatus)
			return messages.find((message) => message.requestId === requestId)
		}
		return { socket, messages, getBlockCalls, sendPersonalEcRecover }
	}

	const useSigningMode = async (loadedModules: Awaited<ReturnType<typeof loadModules>>, rpcNetwork?: RpcNetwork) => {
		await loadedModules.changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: signerAddress, ...rpcNetwork === undefined ? {} : { rpcNetwork } })
		await loadedModules.setUseSignersAddressAsActiveAddress(true)
		await loadedModules.updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [signerAddress], activeSigningAddress: signerAddress, signerChain: 1n }))
		await loadedModules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: signerAddress, access: true }] }])
	}

	const safeAddress = 0x5959595959595959595959595959595959595959n
	const useSafeSigningMode = async (loadedModules: Awaited<ReturnType<typeof loadModules>>) => {
		await loadedModules.changeSimulationMode({ simulationMode: false, activeSimulationAddress: safeAddress, activeSigningAddress: signerAddress, activeSigningSafeAddress: safeAddress })
		await loadedModules.setUseSignersAddressAsActiveAddress(false)
		await loadedModules.updateUserAddressBookEntries(() => [{
			type: 'safe',
			name: 'Treasury Safe',
			address: safeAddress,
			chainId: 1n,
			entrySource: 'User',
			useAsActiveAddress: true,
			safeSignerAddresses: [signerAddress],
			safeVersion: '1.4.1',
		}])
		await loadedModules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: safeAddress, access: true }] }])
		await loadedModules.updateTabState(1, (previousState) => ({ ...previousState, signerAccounts: [signerAddress], activeSigningAddress: signerAddress }))
	}

	test('answers simulated personal_sign signatures with the simulated signer in simulation mode', async () => {
		installBrowserMock()
		const loadedModules = await loadModules()
		await loadedModules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: simulatedSigner, activeSigningAddress: undefined })
		await loadedModules.setUseSignersAddressAsActiveAddress(false)
		await loadedModules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: simulatedSigner, access: true }] }])
		const { socket, messages, getBlockCalls, sendPersonalEcRecover } = await setUpWebsiteConnection(loadedModules)
		const signedMessage = createSignedMessage(simulatedSigner, helloMessage, socket)
		const plainTextSignedMessage = createSignedMessage(simulatedSigner, 'Hello world', socket)
		await loadedModules.updateInterceptorTransactionStack(() => ({ operations: [{ type: 'Message', signedMessageTransaction: plainTextSignedMessage }, { type: 'Message', signedMessageTransaction: signedMessage }] }))

		assert.deepEqual(await sendPersonalEcRecover(1, [helloMessage, await getSimulatedSignature(signedMessage)]), {
			interceptorApproved: true,
			requestId: 1,
			bridgeRequestSettled: true,
			type: 'result',
			method: 'personal_ecRecover',
			result: '0x1111111111111111111111111111111111111111',
		})
		assert.equal((await sendPersonalEcRecover(2, [helloMessage, helloSignature]))?.result, recoveredHelloSignerAddress)
		assert.equal((await sendPersonalEcRecover(3, ['Hello world', await getSimulatedSignature(plainTextSignedMessage)]))?.result, '0x1111111111111111111111111111111111111111')
		assert.equal(getBlockCalls.count, 0)
		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
	})

	test('answers a Safe owner as simulated signer only in simulation mode, never from the Safe signing-mode stack', async () => {
		installBrowserMock()
		const loadedModules = await loadModules()
		await useSafeSigningMode(loadedModules)
		const { socket, messages, sendPersonalEcRecover } = await setUpWebsiteConnection(loadedModules)
		const ownerSignedMessage = createSignedMessage(signerAddress, helloMessage, socket)
		const ownerSimulatedSignature = await getSimulatedSignature(ownerSignedMessage)
		await loadedModules.updateInterceptorTransactionStack(() => ({ operations: [{ type: 'Message', signedMessageTransaction: ownerSignedMessage }] }))

		// The Safe signing-mode stack holds only Safe transactions, so the stacked message is not consulted and the mock key is recovered instead of the owner.
		assert.equal((await sendPersonalEcRecover(1, [helloMessage, ownerSimulatedSignature]))?.result, addressString(mockSimulationKeyAddress))
		// In simulation mode the same message answers with the Safe's simulation owner, an address the Safe's public owner list already discloses.
		await loadedModules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: safeAddress, activeSigningAddress: undefined })
		assert.equal((await sendPersonalEcRecover(2, [helloMessage, ownerSimulatedSignature]))?.result, addressString(signerAddress))
		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
	})

	test('recovers hex and plain text messages locally in signing mode, including on signer-only networks', async () => {
		installBrowserMock()
		const loadedModules = await loadModules()
		await useSigningMode(loadedModules)
		const { messages, sendPersonalEcRecover } = await setUpWebsiteConnection(loadedModules)

		assert.equal((await sendPersonalEcRecover(1, [helloMessage, helloSignature]))?.result, recoveredHelloSignerAddress)
		assert.equal((await sendPersonalEcRecover(2, ['hello', helloSignature]))?.result, recoveredHelloSignerAddress)
		await useSigningMode(loadedModules, { name: 'Signer only', chainId: 1n, httpsRpc: undefined, currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true })
		assert.equal((await sendPersonalEcRecover(3, [helloMessage, helloSignature]))?.result, recoveredHelloSignerAddress)
		assert.equal((await sendPersonalEcRecover(4, ['hello', helloSignature]))?.result, recoveredHelloSignerAddress)
		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
	})

	test('answers compact signatures and ignores extra parameters in signing mode like the wallet did', async () => {
		installBrowserMock()
		const loadedModules = await loadModules()
		await useSigningMode(loadedModules)
		const { messages, sendPersonalEcRecover } = await setUpWebsiteConnection(loadedModules)

		assert.equal((await sendPersonalEcRecover(1, [helloMessage, helloCompactSignature]))?.result, recoveredHelloSignerAddress)
		assert.equal((await sendPersonalEcRecover(2, [helloMessage, helloSignature, 'ignored']))?.result, recoveredHelloSignerAddress)
		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
	})

	test('is not blocked by the Safe signing-mode policy', async () => {
		installBrowserMock()
		const parsedRequest = parsePersonalEcRecover([helloMessage, helloSignature])
		const rawRequest = {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
			method: 'personal_ecRecover',
			params: [helloMessage, helloSignature],
		}
		assert.equal(getSafeModeRpcPolicyReply({ rawRequest, parsedRequest, safeSigningMode: true, forwardToSigner: true, activeAddress: safeAddress, chainId: 1n, hasRpcConnection: true }), undefined)

		const loadedModules = await loadModules()
		await useSafeSigningMode(loadedModules)
		const { messages, sendPersonalEcRecover } = await setUpWebsiteConnection(loadedModules)
		assert.equal((await sendPersonalEcRecover(1, [helloMessage, helloSignature]))?.result, recoveredHelloSignerAddress)
		// Parse failures are answered before the Safe policy, which would otherwise refuse the unparsed method as unsupported for a Safe.
		assert.deepEqual((await sendPersonalEcRecover(2, ['hello']))?.error, { code: -32602, message: 'Invalid personal_ecRecover parameters. Expected a message string and a 65 byte or 64 byte compact signature.' })
		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
	})

	test('refuses websites without access instead of answering or forwarding', async () => {
		for (const websiteAccess of [[{ website, access: false, addressAccess: undefined }], []]) {
			installBrowserMock()
			const loadedModules = await loadModules()
			await useSigningMode(loadedModules)
			await loadedModules.updateWebsiteAccess(() => websiteAccess)
			const { messages, sendPersonalEcRecover } = await setUpWebsiteConnection(loadedModules, { approved: false })

			const reply = await sendPersonalEcRecover(1, [helloMessage, helloSignature])
			assert.deepEqual(reply?.error, { code: 4100, message: 'The requested method and/or account has not been authorized by the user.' }, JSON.stringify(websiteAccess))
			assert.equal(reply?.result, undefined)
			assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
		}
	})

	test('rejects malformed parameters with invalid params instead of forwarding them to the signer', async () => {
		installBrowserMock()
		const loadedModules = await loadModules()
		await useSigningMode(loadedModules)
		const { messages, sendPersonalEcRecover } = await setUpWebsiteConnection(loadedModules)

		const malformedRequests: readonly (readonly [number, readonly unknown[] | undefined])[] = [[1, [helloMessage, helloSignature.slice(0, -4)]], [2, undefined]]
		for (const [requestId, params] of malformedRequests) {
			assert.deepEqual(await sendPersonalEcRecover(requestId, params), {
				interceptorApproved: true,
				requestId,
				bridgeRequestSettled: true,
				type: 'result',
				method: 'personal_ecRecover',
				error: { code: -32602, message: 'Invalid personal_ecRecover parameters. Expected a message string and a 65 byte or 64 byte compact signature.' },
			}, JSON.stringify(params))
		}
		assert.equal(messages.some((message) => message.type === 'forwardToSigner'), false)
	})
})
