import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { personalEcRecover } from '../../app/ts/background/personalEcRecoverRpc.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { getMessageHashForPersonalSign, simulatePersonalSign } from '../../app/ts/simulation/services/simulationPersonalSigning.js'
import { EthereumJsonRpcRequest, JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import type { PersonalSignParams } from '../../app/ts/types/jsonRpc-signing-types.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { SignedMessageTransaction } from '../../app/ts/types/visualizer-types.js'
import { encodeAbiValues } from '../../app/ts/utils/abiRuntime.js'
import { bytesFromHex } from '../../app/ts/utils/ethereumBytes.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { hashMessage, keccak256, privateKeyToAccount, recoverAddress, type Hex } from '../../app/ts/utils/ethereumPrimitives.js'
import { decodePersonalSignMessage } from '../../app/ts/utils/personalSignMessage.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'
import { createEthereumWithGetBlockCounter, installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'

const signerAddress = 0x1111111111111111111111111111111111111111n
const mockSimulationKeyAddress = 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cFn
const plainTextMessage = 'Hello world'
// The UTF-8 bytes of plainTextMessage, as viem and ethers send them.
const hexEncodedPlainTextMessage = '0x48656c6c6f20776f726c64'
const website = { websiteOrigin: 'https://example.test', icon: undefined, title: undefined }

const personalSign = (message: string): PersonalSignParams => ({ method: 'personal_sign', params: [message, signerAddress] })

const createSignedMessage = (message: string, simulationMode: boolean): SignedMessageTransaction => {
	const originalRequestParameters = personalSign(message)
	return {
		website,
		created: new Date('2026-10-01T00:00:00.000Z'),
		activeAddress: signerAddress,
		fakeSignedFor: signerAddress,
		originalRequestParameters,
		request: {
			...originalRequestParameters,
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
		},
		simulationMode,
		messageIdentifier: 1n,
	}
}

// Each message next to the bytes MetaMask signs for personal_sign: SignatureController normalizePersonalMessageData, then the keyring's legacyToBuffer.
const personalSignCases: readonly { readonly message: string, readonly signedBytes: Hex }[] = [
	{ message: '', signedBytes: '0x' },
	{ message: '0x', signedBytes: '0x3078' },
	{ message: '12', signedBytes: '0x12' },
	{ message: '12345678', signedBytes: '0x12345678' },
	{ message: 'cafe', signedBytes: '0xcafe' },
	{ message: '0X6869', signedBytes: '0x6869' },
	{ message: '0x123', signedBytes: '0x0123' },
	{ message: '0xFF00', signedBytes: '0xff00' },
	{ message: '0xhello', signedBytes: '0x307868656c6c6f' },
	{ message: plainTextMessage, signedBytes: hexEncodedPlainTextMessage },
	{ message: hexEncodedPlainTextMessage, signedBytes: hexEncodedPlainTextMessage },
]

// Each message next to the bytes MetaMask recovers for personal_ecRecover: eth-sig-util recoverPersonalSignature reads the message with legacyToBuffer.
const personalEcRecoverCases: readonly { readonly message: string, readonly signedBytes: Hex }[] = [
	{ message: '', signedBytes: '0x' },
	{ message: '0x', signedBytes: '0x' },
	{ message: '12', signedBytes: '0x3132' },
	{ message: '12345678', signedBytes: '0x3132333435363738' },
	{ message: 'cafe', signedBytes: '0x63616665' },
	{ message: '0X6869', signedBytes: '0x305836383639' },
	{ message: '0x123', signedBytes: '0x0123' },
	{ message: '0xFF00', signedBytes: '0xff00' },
	{ message: '0xhello', signedBytes: '0x307868656c6c6f' },
	{ message: plainTextMessage, signedBytes: hexEncodedPlainTextMessage },
	{ message: hexEncodedPlainTextMessage, signedBytes: hexEncodedPlainTextMessage },
]

describe('personal_sign message bytes', () => {
	test('hashes and simulates personal_sign messages over the bytes MetaMask signs', async () => {
		for (const { message, signedBytes } of personalSignCases) {
			const expectedHash = hashMessage({ raw: signedBytes })
			assert.equal(getMessageHashForPersonalSign(personalSign(message)), expectedHash, JSON.stringify(message))
			const { signature } = await simulatePersonalSign(personalSign(message), signerAddress)
			assert.equal(BigInt(await recoverAddress({ hash: expectedHash, signature })), mockSimulationKeyAddress, JSON.stringify(message))
		}
	})

	test('recovers personal_ecRecover messages over the bytes MetaMask recovers', async () => {
		const account = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
		for (const { message, signedBytes } of personalEcRecoverCases) {
			const request = EthereumJsonRpcRequest.parse({ method: 'personal_ecRecover', params: [message, await account.signMessage({ message: { raw: signedBytes } })] })
			if (request.method !== 'personal_ecRecover') throw new Error('Expected a personal_ecRecover request')
			assert.deepEqual(await personalEcRecover(request, []), { type: 'result', method: 'personal_ecRecover', result: BigInt(account.address) }, JSON.stringify(message))
		}
	})
})

describe('personal_sign message display', () => {
	// What you see is what you sign: the popup shows exactly the bytes the signature covers. This replaces main's check that unprefixed hex such as 6869 is shown as the literal text 6869, which MetaMask instead signs as the bytes of 'hi'.
	test('shows the text of exactly the bytes personal_sign signs', () => {
		for (const { message, signedBytes } of personalSignCases) {
			assert.equal(decodePersonalSignMessage(message), new TextDecoder().decode(bytesFromHex(signedBytes)), JSON.stringify(message))
		}
	})

	test('decodes the bytes a hex personal_sign message signs', () => {
		assert.equal(decodePersonalSignMessage('0x6869'), 'hi')
		assert.equal(decodePersonalSignMessage('0X6869'), 'hi')
		// MetaMask signs hex digits without a 0x prefix as bytes too.
		assert.equal(decodePersonalSignMessage('6869'), 'hi')
		// Bytes that are not valid UTF-8 show as replacement characters, and the raw view still shows the hex.
		assert.equal(decodePersonalSignMessage('0xff68'), '\ufffdh')
		// Odd-length hex is left-padded with a zero nibble, so 0x96869 signs the bytes 0x096869 and 0xabc signs 0x0abc.
		assert.equal(decodePersonalSignMessage('0x96869'), '\thi')
		assert.equal(decodePersonalSignMessage('0xabc'), '\n\ufffd')
	})

	test('shows plain-text personal_sign messages as the text they sign', () => {
		assert.equal(decodePersonalSignMessage(plainTextMessage), plainTextMessage)
		assert.equal(decodePersonalSignMessage('Grüße, 世界 🦊\nline two'), 'Grüße, 世界 🦊\nline two')
		assert.equal(decodePersonalSignMessage(''), '')
		// A bare 0x has no hex digits, so MetaMask signs it as the text 0x.
		assert.equal(decodePersonalSignMessage('0x'), '0x')
		assert.equal(decodePersonalSignMessage('0xhello'), '0xhello')
	})
})

describe('personal_sign visualization', () => {
	test('shows plain-text and hex messages as their text with the hash of the signed bytes in signing and simulation mode', async () => {
		installBrowserMock()
		const { updateUserAddressBookEntries } = await loadModules()
		const { craftPersonalSignPopupMessage } = await import('../../app/ts/background/windows/personalSign.js')
		await updateUserAddressBookEntries(() => [{ type: 'contact', name: 'Signer', address: signerAddress, entrySource: 'User', chainId: 1n }])
		const { ethereum } = createEthereumWithGetBlockCounter({ count: 0 })

		for (const simulationMode of [false, true]) {
			for (const message of [plainTextMessage, hexEncodedPlainTextMessage]) {
				const visualized = await craftPersonalSignPopupMessage(ethereum, undefined, createSignedMessage(message, simulationMode), ethereum.getRpcEntry())
				if (visualized.type !== 'NotParsed') throw new Error(`Expected an unparsed personal_sign visualization for ${ message }`)
				assert.equal(visualized.simulationMode, simulationMode)
				assert.equal(visualized.message, message)
				assert.equal(visualized.rawMessage, message)
				assert.equal(visualized.messageHash, hashMessage(plainTextMessage))
				assert.equal(decodePersonalSignMessage(visualized.message), plainTextMessage)
				assert.equal(visualized.quarantine, false)
			}
		}
	})
})

const rpcEntry: RpcEntry = {
	name: 'Testnet',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: true,
}

const createServiceWithParentBlock = () => new EthereumClientService(
	{
		rpcUrl: rpcEntry.httpsRpc,
		clearCache: () => undefined,
		async getChainId() { return rpcEntry.chainId },
		async jsonRpcRequest(request) {
			if (request.method !== 'eth_getBlockByNumber') throw new Error(`Unexpected RPC method: ${ request.method }`)
			const response = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
			if ('error' in response) throw new Error(response.error.message)
			return response.result
		},
	},
	async () => undefined,
	async () => undefined,
	rpcEntry,
)

// The ecRecover override contract looks up keccak256(abi.encode(hash, v, r, s)) in the mapping at storage slot 0.
const getEcRecoverOverrideSlot = (messageHash: Hex, signature: Hex) => {
	const signatureKey = keccak256(encodeAbiValues(['bytes32', 'uint8', 'bytes32', 'bytes32'], [messageHash, BigInt(Number.parseInt(signature.slice(130, 132), 16)), signature.slice(0, 66), `0x${ signature.slice(66, 130) }`]))
	return keccak256(encodeAbiValues(['bytes32', 'uint256'], [signatureKey, 0n]))
}

describe('simulated plain-text personal_sign signatures', () => {
	test('sign the UTF-8 bytes and recover to the simulated signer through the ecRecover override', async () => {
		const signedMessage = createSignedMessage(plainTextMessage, true)
		const { signature, messageHash } = await simulatePersonalSign(signedMessage.originalRequestParameters, signedMessage.fakeSignedFor)
		assert.equal(messageHash, hashMessage(plainTextMessage))
		assert.equal(BigInt(await recoverAddress({ hash: hashMessage(plainTextMessage), signature })), mockSimulationKeyAddress)
		assert.equal((await simulatePersonalSign(createSignedMessage(hexEncodedPlainTextMessage, true).originalRequestParameters, signerAddress)).signature, signature)

		const prepared = await createServiceWithParentBlock().prepareEthSimulateV1Input([{
			stateOverrides: {},
			transactions: [],
			signedMessages: [signedMessage],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}], 1n, undefined)

		const ecRecoverOverride = prepared.request.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(1n)]
		assert.deepEqual(ecRecoverOverride?.state, { [getEcRecoverOverrideSlot(hashMessage(plainTextMessage), signature)]: signerAddress })
	})
})
