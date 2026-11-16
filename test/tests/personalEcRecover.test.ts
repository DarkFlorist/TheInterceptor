import * as assert from 'assert'
import { describe, spyOn, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { MAX_PERSONAL_EC_RECOVER_MESSAGE_LENGTH, personalEcRecover } from '../../app/ts/background/personalEcRecoverRpc.js'
import { getSafeModeRpcPolicyReply } from '../../app/ts/safe/safeRequestPolicy.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import * as simulationPersonalSigning from '../../app/ts/simulation/services/simulationPersonalSigning.js'
import { getMessageHashForPersonalSign, getSimulatedMessageSignature, simulatePersonalSign } from '../../app/ts/simulation/services/simulationPersonalSigning.js'
import { JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import type { PersonalSignParams } from '../../app/ts/types/jsonRpc-signing-types.js'
import type { RpcEntry, RpcNetwork } from '../../app/ts/types/rpc.js'
import type { SignedMessageTransaction } from '../../app/ts/types/visualizer-types.js'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import type { WebsiteSocket } from '../../app/ts/utils/requests.js'
import { encodeAbiValues } from '../../app/ts/utils/abiRuntime.js'
import * as bigint from '../../app/ts/utils/bigint.js'
import { addressString, bytes32String } from '../../app/ts/utils/bigint.js'
import * as ethereumBytes from '../../app/ts/utils/ethereumBytes.js'
import { bytesToHex, hashMessage, keccak256, privateKeyToAccount, stringToBytes } from '../../app/ts/utils/ethereumPrimitives.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'
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

const createSignedMessage = (fakeSignedFor: bigint, message: string, socket: WebsiteSocket, signingWebsite: Website = website): SignedMessageTransaction => {
	const originalRequestParameters: PersonalSignParams = { method: 'personal_sign', params: [message, fakeSignedFor] }
	return {
		website: signingWebsite,
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
	const messageHashScalar = BigInt(hashMessage({ raw: message })) % secp256k1.Point.Fn.ORDER
	const compressedR = secp256k1.Point.BASE.multiply(messageHashScalar).toBytes(true)
	const r = BigInt(bytesToHex(compressedR.slice(1)))
	assert.ok(r < secp256k1.Point.Fn.ORDER)
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
			toSignatureHex(secp256k1.Point.Fn.ORDER, helloS, 0),
			toSignatureHex(5n, helloS, 0),
			getSignatureRecoveringToInfinity(helloMessage),
		]) {
			assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([helloMessage, signature]), [], websiteOrigin), invalidSignatureReply, signature)
		}
	})

	test('looks up simulated signers by the hash of the bytes simulated personal_sign actually signed', async () => {
		const socket = { tabId: 1, connectionName: 0n }
		const messages = [
			{ message: helloMessage, signedBytes: '0x68656c6c6f' },
			{ message: '0x00ff4578616d706c65', signedBytes: '0x00ff4578616d706c65' },
		] as const
		for (const { message, signedBytes } of messages) {
			const signedMessage = createSignedMessage(simulatedSigner, message, socket)
			const simulatedSigning = await simulatePersonalSign(signedMessage.originalRequestParameters, simulatedSigner)
			assert.equal(simulatedSigning.messageHash, hashMessage({ raw: signedBytes }), message)
			// With no stacked messages this is a real recovery, so it proves the simulated signature covers exactly the bytes the reported message hash describes.
			assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([message, simulatedSigning.signature]), [], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: mockSimulationKeyAddress }, message)
			assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([message, simulatedSigning.signature]), [signedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner }, message)
		}
	})

	test('recovers a 0X-prefixed message the simulation signed to its simulated signer', async () => {
		const socket = { tabId: 1, connectionName: 0n }
		// Simulated personal_sign signs '0X6869' as the bytes 0x6869, as on main.
		const signedMessage = createSignedMessage(simulatedSigner, '0X6869', socket)
		const simulatedSigning = await simulatePersonalSign(signedMessage.originalRequestParameters, simulatedSigner)
		assert.equal(simulatedSigning.messageHash, hashMessage({ raw: '0x6869' }))
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['0X6869', simulatedSigning.signature]), [signedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['0x6869', simulatedSigning.signature]), [signedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['0x6869', simulatedSigning.signature]), [], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: mockSimulationKeyAddress })
		// Signatures the simulation did not produce keep MetaMask's decoding, which reads '0X6869' as text.
		const account = privateKeyToAccount(privateKey)
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['0X6869', await account.signMessage({ message: '0X6869' })]), [], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: signerAddress })
	})

	test('simulated personal_sign signs the bytes MetaMask personal_sign reads, decoding hex directly', () => {
		const personalSignHash = (message: string) => getMessageHashForPersonalSign({ method: 'personal_sign', params: [message, simulatedSigner] })
		// A bare '0x' has no hex digits, so it is read as the text '0x'; unprefixed hex digits are read as bytes, and odd-length hex is left-padded.
		const signedBytes = { '0X6869': '0x6869', '0x6869': '0x6869', '0xABcd': '0xabcd', '0x': '0x3078', '0x00ff': '0x00ff', [`0x${ '0f'.repeat(300) }`]: `0x${ '0f'.repeat(300) }`, '12': '0x12', '1234567890': '0x1234567890', '0x123': '0x0123', '0o17': bytesToHex(stringToBytes('0o17')), 'hello': bytesToHex(stringToBytes('hello')) }
		for (const [message, bytes] of Object.entries(signedBytes)) assert.equal(personalSignHash(message), hashMessage({ raw: bytes }), message)
	})

	test('rejects a message over the length limit before decoding or hashing it', async () => {
		const decodeSpy = spyOn(ethereumBytes, 'hexOrUtf8StringToBytes')
		try {
			const signature = await getSimulatedSignature(createSignedMessage(simulatedSigner, helloMessage, { tabId: 1, connectionName: 0n }))
			const messageAtLimit = `0x${ '00'.repeat(1024 * 1024) }`
			assert.equal(messageAtLimit.length, MAX_PERSONAL_EC_RECOVER_MESSAGE_LENGTH)
			const oversizedMessage = `${ messageAtLimit }0`
			assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([oversizedMessage, signature]), [], websiteOrigin), {
				type: 'result',
				method: 'personal_ecRecover',
				error: { code: -32602, message: `Invalid personal_ecRecover message. Messages longer than ${ MAX_PERSONAL_EC_RECOVER_MESSAGE_LENGTH } characters (1 MiB of hex-encoded bytes) are not supported.` },
			})
			assert.equal(decodeSpy.mock.calls.length, 0)
			const reply = await personalEcRecover(parsePersonalEcRecover([messageAtLimit, signature]), [], websiteOrigin)
			assert.ok(reply.type === 'result' && 'result' in reply, 'a message at the limit is recovered')
			assert.equal(decodeSpy.mock.calls.length, 1)
		} finally {
			decodeSpy.mockRestore()
		}
	})

	test('skips the simulated signer lookup when the requesting website simulated-signed nothing', async () => {
		const lookupSpy = spyOn(simulationPersonalSigning, 'findSimulatedPersonalSignSigner')
		try {
			const socket = { tabId: 1, connectionName: 0n }
			const ownSigning = createSignedMessage(simulatedSigner, helloMessage, socket)
			const otherWebsiteSigning = createSignedMessage(simulatedSigner, helloMessage, socket, { websiteOrigin: 'https://other.example', icon: undefined, title: undefined })
			const request = parsePersonalEcRecover([helloMessage, await getSimulatedSignature(ownSigning)])
			assert.deepEqual(await personalEcRecover(request, [], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: mockSimulationKeyAddress })
			assert.deepEqual(await personalEcRecover(request, [otherWebsiteSigning], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: mockSimulationKeyAddress })
			assert.equal(lookupSpy.mock.calls.length, 0)
			assert.deepEqual(await personalEcRecover(request, [ownSigning], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
			assert.equal(lookupSpy.mock.calls.length, 1)
		} finally {
			lookupSpy.mockRestore()
		}
	})

	test('recovers a 1 MiB hex message the simulation signed without the quadratic BigInt decoding', async () => {
		const largeMessage = `0x${ 'ab'.repeat(1024 * 1024) }`
		const signedMessage = createSignedMessage(simulatedSigner, largeMessage, { tabId: 1, connectionName: 0n })
		const bigIntDecodeSpy = spyOn(bigint, 'stringToUint8Array')
		try {
			const started = performance.now()
			const signature = await getSimulatedSignature(signedMessage)
			assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([largeMessage, signature]), [signedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
			// stringToUint8Array takes over a minute on this message; direct hex decoding takes well under a second.
			assert.ok(performance.now() - started < 10_000)
			assert.equal(bigIntDecodeSpy.mock.calls.length, 0)
		} finally {
			bigIntDecodeSpy.mockRestore()
		}
	})

	test('recovers messages simulated signing decodes irregularly by their exact string, and recovers undecodable messages without throwing', async () => {
		const socket = { tabId: 1, connectionName: 0n }
		// Simulated signing reads the unprefixed hex digits '1234567890' as the bytes 0x1234567890, while recovery reads them as text like MetaMask, so only the exact string finds this signing.
		const decimalSigning = createSignedMessage(simulatedSigner, '1234567890', socket)
		const decimalSignature = await getSimulatedSignature(decimalSigning)
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['1234567890', decimalSignature]), [decimalSigning], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
		// The lookup applies signing's decoding only to even-length hex, so for '0x123' real recovery answers.
		const account = privateKeyToAccount(privateKey)
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['0x123', await account.signMessage({ message: { raw: '0x0123' } })]), [decimalSigning], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: signerAddress })
	})

	test('recovers an uppercase 0X spelling of hex the simulation signed in lowercase', async () => {
		const socket = { tabId: 1, connectionName: 0n }
		const signedMessage = createSignedMessage(simulatedSigner, '0x6869', socket)
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['0X6869', await getSimulatedSignature(signedMessage)]), [signedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
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
			// MetaMask's reading takes '0X' as text, so only the signing decoding of hex finds the signing under this spelling. The empty message has no hex digits to spell.
			if (message !== '') assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([`0X${ bytesToHex(stringToBytes(message)).slice(2).toUpperCase() }`, signature]), [signedMessage], websiteOrigin), recoveredSimulatedSigner, JSON.stringify(message))
			assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([message, signature]), [], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: mockSimulationKeyAddress }, JSON.stringify(message))
		}
		// Odd-length hex signs its left-padded bytes, so the even-length form of the same bytes finds the same simulated signer.
		const oddLengthHexMessage = createSignedMessage(simulatedSigner, '0x123', socket)
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['0x0123', await getSimulatedSignature(oddLengthHexMessage)]), [oddLengthHexMessage], websiteOrigin), recoveredSimulatedSigner)
	})

	test('reads unprefixed hex as text like MetaMask personal_ecRecover, unlike personal_sign which signs it as bytes, yet finds a simulated signing of it by its exact string', async () => {
		const socket = { tabId: 1, connectionName: 0n }
		const signedMessage = createSignedMessage(simulatedSigner, '12', socket)
		const signature = await getSimulatedSignature(signedMessage)
		// personal_sign('12') signed the byte 0x12, which personal_ecRecover only reads from the 0x-prefixed form.
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['0x12', signature]), [signedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover(['12', signature]), [signedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSigner })
		// Without that signing, recovery reads '12' as text like MetaMask, so the signature of the byte 0x12 recovers to some other address.
		const textReply = await personalEcRecover(parsePersonalEcRecover(['12', signature]), [], websiteOrigin)
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

describe('simulated signature to signer mapping', () => {
	const ecRecoverPrecompileAddress = 1n
	const parentBlockNumber = 8443561n
	const rpcEntry: RpcEntry = { name: 'Test RPC', chainId: 1n, httpsRpc: 'http://127.0.0.1:8545', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
	const requestHandler: IEthereumJSONRpcRequestHandler = {
		rpcUrl: rpcEntry.httpsRpc,
		clearCache: () => undefined,
		getChainId: async () => rpcEntry.chainId,
		jsonRpcRequest: async (request) => {
			if (request.method !== 'eth_getBlockByNumber') throw new Error(`Unexpected RPC method: ${ request.method }`)
			const response = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
			if (!('result' in response)) throw new Error('Expected the block fixture to be a success response')
			return response.result
		},
	}
	const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcEntry)

	// The override stores signer addresses in a Solidity mapping at slot 0, keyed by keccak256(messageHash, v, r, s) of each simulated signature.
	const getEcRecoverOverrideSlot = (messageHash: string, signature: string) => {
		const signatureKey = keccak256(encodeAbiValues(['bytes32', 'uint8', 'bytes32', 'bytes32'], [messageHash, BigInt(`0x${ signature.slice(130, 132) }`), signature.slice(0, 66), `0x${ signature.slice(66, 130) }`]))
		return keccak256(encodeAbiValues(['bytes32', 'uint256'], [signatureKey, 0n]))
	}

	test('the ecRecover precompile override and personal_ecRecover resolve a simulated personal_sign signature to the same signer', async () => {
		const signedMessage = createSignedMessage(simulatedSigner, helloMessage, { tabId: 1, connectionName: 0n })
		const simulatedSignature = await getSimulatedMessageSignature(signedMessage)
		assert.equal(simulatedSignature.signer, simulatedSigner)
		assert.equal(simulatedSignature.signature, await getSimulatedSignature(signedMessage))

		const prepared = await ethereum.prepareEthSimulateV1Input([{
			stateOverrides: {},
			transactions: [],
			signedMessages: [signedMessage],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}], parentBlockNumber, undefined)
		const ecRecoverOverride = prepared.request.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(ecRecoverPrecompileAddress)]
		assert.deepEqual(ecRecoverOverride?.state, { [getEcRecoverOverrideSlot(simulatedSignature.messageHash, simulatedSignature.signature)]: simulatedSignature.signer })

		assert.deepEqual(await personalEcRecover(parsePersonalEcRecover([helloMessage, simulatedSignature.signature]), [signedMessage], websiteOrigin), { type: 'result', method: 'personal_ecRecover', result: simulatedSignature.signer })
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

	test('answers the mock key address for a simulated signature another website requested, even from the same tab', async () => {
		installBrowserMock()
		const loadedModules = await loadModules()
		await loadedModules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: simulatedSigner, activeSigningAddress: undefined })
		await loadedModules.setUseSignersAddressAsActiveAddress(false)
		await loadedModules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: simulatedSigner, access: true }] }])
		const { socket, sendPersonalEcRecover } = await setUpWebsiteConnection(loadedModules)
		const otherWebsiteSignedMessage = createSignedMessage(simulatedSigner, helloMessage, socket, { websiteOrigin: 'https://other.example', icon: undefined, title: undefined })
		await loadedModules.updateInterceptorTransactionStack(() => ({ operations: [{ type: 'Message', signedMessageTransaction: otherWebsiteSignedMessage }] }))

		assert.equal((await sendPersonalEcRecover(1, [helloMessage, await getSimulatedSignature(otherWebsiteSignedMessage)]))?.result, addressString(mockSimulationKeyAddress))
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

describe('request simulation view', () => {
	const stackSignedMessage = async (loadedModules: Awaited<ReturnType<typeof loadModules>>) => {
		await loadedModules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: simulatedSigner, activeSigningAddress: undefined })
		const signedMessage = createSignedMessage(simulatedSigner, helloMessage, { tabId: 1, connectionName: 0n })
		await loadedModules.updateInterceptorTransactionStack(() => ({ operations: [{ type: 'Message', signedMessageTransaction: signedMessage }] }))
	}

	test('shares the simulation overlay gate between signed messages and the simulation input', async () => {
		installBrowserMock()
		const loadedModules = await loadModules()
		const { createRequestSimulationView } = await import('../../app/ts/background/requestSimulationView.js')
		const getBlockCalls = { count: 0 }
		const { ethereum } = createEthereumWithGetBlockCounter(getBlockCalls)
		await stackSignedMessage(loadedModules)

		const overlayDisabledView = createRequestSimulationView(ethereum, false)
		assert.deepEqual(await overlayDisabledView.getSimulatedSignedMessages(), [])
		assert.deepEqual(await overlayDisabledView.getSimulationInput(), { kind: 'passthrough' })

		const overlayEnabledView = createRequestSimulationView(ethereum, true)
		assert.deepEqual((await overlayEnabledView.getSimulatedSignedMessages()).map((signedMessage) => signedMessage.fakeSignedFor), [simulatedSigner])
		const simulationInput = await overlayEnabledView.getSimulationInput()
		assert.ok(simulationInput.kind === 'simulated')
		assert.deepEqual(simulationInput.value.flatMap((block) => block.signedMessages), await overlayEnabledView.getSimulatedSignedMessages())
		// A stack of only signed messages needs no RPC preparation.
		assert.equal(getBlockCalls.count, 0)
	})

	test('reads signed messages and the simulation input from one stack snapshot per request', async () => {
		installBrowserMock()
		const loadedModules = await loadModules()
		const { createRequestSimulationView } = await import('../../app/ts/background/requestSimulationView.js')
		const { ethereum } = createEthereumWithGetBlockCounter({ count: 0 })
		await stackSignedMessage(loadedModules)

		const requestView = createRequestSimulationView(ethereum, true)
		const signedMessages = await requestView.getSimulatedSignedMessages()
		await loadedModules.updateInterceptorTransactionStack(() => ({ operations: [] }))

		const simulationInput = await requestView.getSimulationInput()
		assert.ok(simulationInput.kind === 'simulated')
		assert.deepEqual(simulationInput.value.flatMap((block) => block.signedMessages), signedMessages)
		assert.deepEqual(await createRequestSimulationView(ethereum, true).getSimulatedSignedMessages(), [])
	})
})
