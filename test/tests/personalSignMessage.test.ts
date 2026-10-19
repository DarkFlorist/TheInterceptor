import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { personalEcRecover } from '../../app/ts/background/personalEcRecoverRpc.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { getMessageHashForPersonalSign, simulatePersonalSign } from '../../app/ts/simulation/services/simulationPersonalSigning.js'
import { EthereumJsonRpcRequest, JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import type { PersonalSignParams } from '../../app/ts/types/jsonRpc-signing-types.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { SignerName } from '../../app/ts/types/signerTypes.js'
import type { SignedMessageTransaction } from '../../app/ts/types/visualizer-types.js'
import { encodeAbiValues } from '../../app/ts/utils/abiRuntime.js'
import { bytesFromHex } from '../../app/ts/utils/ethereumBytes.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { hashMessage, keccak256, privateKeyToAccount, recoverAddress, type Hex } from '../../app/ts/utils/ethereumPrimitives.js'
import { classifyPersonalSignMessage, decodePersonalSignMessage, getPersonalSignMessageBytes, type PersonalSignMessageForm } from '../../app/ts/utils/personalSignMessage.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'
import { createEthereumWithGetBlockCounter, installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'

const signerAddress = 0x1111111111111111111111111111111111111111n
const mockSimulationKeyAddress = 0x2B5AD5c4795c026514f8317c7a215E218DcCD6cFn
const plainTextMessage = 'Hello world'
// The UTF-8 bytes of plainTextMessage, as viem and ethers send them.
const hexEncodedPlainTextMessage = '0x48656c6c6f20776f726c64'
// Unprefixed hex digits that MetaMask signs as the bytes of 'Sign in' while Rabby signs the digits themselves as text.
const unprefixedHexMessage = '5369676e20696e'
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

type SignedBytesCase = { readonly message: string, readonly signedBytes: Hex }
type PersonalSignCase = { readonly message: string, readonly form: PersonalSignMessageForm, readonly metaMaskBytes: Hex }

// Each message with its form and the bytes MetaMask signs for it (SignatureController normalizePersonalMessageData, then the keyring's legacyToBuffer), which the simulation signs too. Signing mode signs the same bytes for the wallet-independent forms and leaves wallet-dependent ones unknown.
const personalSignCases: readonly PersonalSignCase[] = [
	// Lowercase 0x-prefixed hex with whole bytes, as viem, ethers and web3.js send byte messages.
	{ message: hexEncodedPlainTextMessage, form: 'canonicalHexData', metaMaskBytes: hexEncodedPlainTextMessage },
	{ message: '0x6869', form: 'canonicalHexData', metaMaskBytes: '0x6869' },
	{ message: '0xff68', form: 'canonicalHexData', metaMaskBytes: '0xff68' },
	// Text that neither starts with a 0x prefix nor consists only of hex digits.
	{ message: plainTextMessage, form: 'plainText', metaMaskBytes: hexEncodedPlainTextMessage },
	{ message: 'cafe babe', form: 'plainText', metaMaskBytes: '0x636166652062616265' },
	{ message: 'hello 0x6869', form: 'plainText', metaMaskBytes: '0x68656c6c6f20307836383639' },
	// An empty message is zero bytes whether a wallet reads it as text or as hex.
	{ message: '', form: 'plainText', metaMaskBytes: '0x' },
	// Hex-like but not canonical, so wallets disagree (MetaMask signs '6869' as the bytes of 'hi', Rabby as the text 6869).
	{ message: '6869', form: 'walletDependent', metaMaskBytes: '0x6869' },
	{ message: unprefixedHexMessage, form: 'walletDependent', metaMaskBytes: '0x5369676e20696e' },
	{ message: '12', form: 'walletDependent', metaMaskBytes: '0x12' },
	{ message: '12345678', form: 'walletDependent', metaMaskBytes: '0x12345678' },
	{ message: 'add', form: 'walletDependent', metaMaskBytes: '0x0add' },
	{ message: 'cafe', form: 'walletDependent', metaMaskBytes: '0xcafe' },
	{ message: '0X6869', form: 'walletDependent', metaMaskBytes: '0x6869' },
	{ message: '0x', form: 'walletDependent', metaMaskBytes: '0x3078' },
	{ message: '0X', form: 'walletDependent', metaMaskBytes: '0x3058' },
	{ message: '0x123', form: 'walletDependent', metaMaskBytes: '0x0123' },
	{ message: '0xFF00', form: 'walletDependent', metaMaskBytes: '0xff00' },
	{ message: ' 0x6869', form: 'walletDependent', metaMaskBytes: '0x20307836383639' },
	{ message: '0x6869\n', form: 'walletDependent', metaMaskBytes: '0x3078363836390a' },
	{ message: ' ', form: 'walletDependent', metaMaskBytes: '0x20' },
	// A 0x or 0X prefix makes any non-canonical message wallet dependent, since hex converters check the digits after it with differing strictness.
	{ message: '0xhello', form: 'walletDependent', metaMaskBytes: '0x307868656c6c6f' },
	{ message: '0x6869zz', form: 'walletDependent', metaMaskBytes: '0x3078363836397a7a' },
	{ message: '0xhello world', form: 'walletDependent', metaMaskBytes: '0x307868656c6c6f20776f726c64' },
	{ message: '0x 6869', form: 'walletDependent', metaMaskBytes: '0x30782036383639' },
	{ message: '0Xzz', form: 'walletDependent', metaMaskBytes: '0x30587a7a' },
	{ message: ' 0X12', form: 'walletDependent', metaMaskBytes: '0x2030583132' },
]

// Each message next to the bytes MetaMask recovers for personal_ecRecover: eth-sig-util recoverPersonalSignature reads the message with legacyToBuffer.
const personalEcRecoverCases: readonly SignedBytesCase[] = [
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
	test('classifies each personal_sign message by its form', () => {
		for (const { message, form } of personalSignCases) assert.equal(classifyPersonalSignMessage(message), form, JSON.stringify(message))
	})

	// A website chooses the message and it is classified synchronously in the background and the popup, so long whitespace must not make classification slow.
	test('classifies messages with long whitespace runs quickly', () => {
		const whitespace = ' '.repeat(100_000)
		const started = performance.now()
		assert.equal(classifyPersonalSignMessage(`${ whitespace }hello`), 'plainText')
		const elapsed = performance.now() - started
		assert.ok(elapsed < 100, `took ${ elapsed } ms`)
		assert.equal(classifyPersonalSignMessage(`${ whitespace }0xzz`), 'walletDependent')
		assert.ok(performance.now() - started < 200, `took ${ performance.now() - started } ms`)
		assert.equal(classifyPersonalSignMessage(`${ whitespace }6869${ whitespace }`), 'walletDependent')
		// Tabs, line breaks, no-break and line separators count as surrounding whitespace too.
		assert.equal(classifyPersonalSignMessage('\t\n\u00a0\u2028 0X6869 \r\u3000'), 'walletDependent')
	})

	test('hashes and simulates personal_sign messages over the bytes MetaMask signs', async () => {
		for (const { message, metaMaskBytes } of personalSignCases) {
			const expectedHash = hashMessage({ raw: metaMaskBytes })
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

const decodeBytes = (bytes: Hex) => new TextDecoder().decode(bytesFromHex(bytes))

describe('personal_sign message display', () => {
	// What you see is what you sign: the popup shows exactly the bytes the signature covers. Simulation mode signs MetaMask's reading itself, so unprefixed hex such as 6869 shows as 'hi'.
	test('shows simulation-mode messages as the text of the bytes the simulation signs', () => {
		for (const { message, metaMaskBytes } of personalSignCases) {
			assert.deepEqual(getPersonalSignMessageBytes(message, true), bytesFromHex(metaMaskBytes), JSON.stringify(message))
			assert.equal(decodePersonalSignMessage(message, true), decodeBytes(metaMaskBytes), JSON.stringify(message))
		}
	})

	// In signing mode the wallet signs, so only messages whose form every wallet reads the same way are shown and hashed as bytes; the rest are shown exactly as written.
	test('shows signing-mode messages as the text every wallet signs, or as written when their form is wallet dependent', () => {
		for (const { message, form, metaMaskBytes } of personalSignCases) {
			const isWalletDependent = form === 'walletDependent'
			assert.deepEqual(getPersonalSignMessageBytes(message, false), isWalletDependent ? undefined : bytesFromHex(metaMaskBytes), JSON.stringify(message))
			assert.equal(decodePersonalSignMessage(message, false), isWalletDependent ? message : decodeBytes(metaMaskBytes), JSON.stringify(message))
		}
	})

	test('decodes the bytes a hex personal_sign message signs', () => {
		for (const simulationMode of [true, false]) {
			assert.equal(decodePersonalSignMessage('0x6869', simulationMode), 'hi')
			// Bytes that are not valid UTF-8 show as replacement characters, and the raw view still shows the hex.
			assert.equal(decodePersonalSignMessage('0xff68', simulationMode), '\ufffdh')
		}
		// The simulation signs like MetaMask: odd-length hex is left-padded with a zero nibble, so 0x96869 signs the bytes 0x096869 and 0xabc signs 0x0abc, and hex digits with a 0X prefix or none are bytes too.
		assert.equal(decodePersonalSignMessage('0x96869', true), '\thi')
		assert.equal(decodePersonalSignMessage('0xabc', true), '\n\ufffd')
		assert.equal(decodePersonalSignMessage('0X6869', true), 'hi')
		assert.equal(decodePersonalSignMessage('6869', true), 'hi')
	})

	test('shows plain-text personal_sign messages as the text they sign', () => {
		for (const simulationMode of [true, false]) {
			assert.equal(decodePersonalSignMessage(plainTextMessage, simulationMode), plainTextMessage)
			assert.equal(decodePersonalSignMessage('Grüße, 世界 🦊\nline two', simulationMode), 'Grüße, 世界 🦊\nline two')
			assert.equal(decodePersonalSignMessage('', simulationMode), '')
		}
		// A bare 0x has no hex digits, so the simulation signs it as the text 0x, like MetaMask.
		assert.equal(decodePersonalSignMessage('0x', true), '0x')
	})
})

const loadPersonalSignVisualization = async () => {
	installBrowserMock()
	const { updateUserAddressBookEntries, updateTabState } = await loadModules()
	const { craftPersonalSignPopupMessage } = await import('../../app/ts/background/windows/personalSign.js')
	await updateUserAddressBookEntries(() => [{ type: 'contact', name: 'Signer', address: signerAddress, entrySource: 'User', chainId: 1n }])
	const { ethereum } = createEthereumWithGetBlockCounter({ count: 0 })
	return {
		setSignerName: async (signerName: SignerName) => { await updateTabState(1, (tabState) => ({ ...tabState, signerName })) },
		visualize: async (message: string, simulationMode: boolean) => {
			const visualized = await craftPersonalSignPopupMessage(ethereum, undefined, createSignedMessage(message, simulationMode), ethereum.getRpcEntry())
			if (visualized.type !== 'NotParsed') throw new Error(`Expected an unparsed personal_sign visualization for ${ message }`)
			return { ...visualized, shownText: decodePersonalSignMessage(visualized.message, visualized.simulationMode) }
		},
	}
}

// The reading must not depend on the detected wallet, which can change while the popup is open and may not be the wallet of the requesting frame.
const signerNames: readonly SignerName[] = ['MetaMask', 'Rabby', 'NoSignerDetected']

describe('personal_sign visualization', () => {
	test('shows plain-text and hex messages as their text with the hash of the signed bytes in signing and simulation mode', async () => {
		const { visualize } = await loadPersonalSignVisualization()
		for (const simulationMode of [false, true]) {
			for (const message of [plainTextMessage, hexEncodedPlainTextMessage]) {
				const visualized = await visualize(message, simulationMode)
				assert.equal(visualized.simulationMode, simulationMode)
				assert.equal(visualized.message, message)
				assert.equal(visualized.rawMessage, message)
				assert.equal(visualized.messageHash, hashMessage(plainTextMessage))
				assert.equal(visualized.shownText, plainTextMessage)
				assert.equal(visualized.quarantine, false)
			}
		}
	})

	test('flags signing-mode messages whose form is wallet dependent, whichever wallet is detected', async () => {
		const { setSignerName, visualize } = await loadPersonalSignVisualization()
		for (const signerName of signerNames) {
			await setSignerName(signerName)
			for (const { message, form, metaMaskBytes } of personalSignCases) {
				const label = `${ signerName } ${ JSON.stringify(message) }`
				const visualized = await visualize(message, false)
				if (form === 'walletDependent') {
					assert.equal(visualized.quarantine, true, label)
					assert.equal(visualized.quarantineReasons.length, 1, label)
					assert.match(visualized.quarantineReasons[0] ?? '', /hex-encoded bytes or text/u, label)
					assert.equal(visualized.messageHash, undefined, label)
					assert.equal(visualized.shownText, message, label)
					continue
				}
				assert.equal(visualized.quarantine, false, label)
				assert.equal(visualized.messageHash, hashMessage({ raw: metaMaskBytes }), label)
				assert.equal(visualized.shownText, decodeBytes(metaMaskBytes), label)
			}
		}
	})

	test('shows, hashes and signs MetaMask\'s reading in simulation mode, whichever wallet is detected', async () => {
		const { setSignerName, visualize } = await loadPersonalSignVisualization()
		for (const signerName of signerNames) {
			await setSignerName(signerName)
			for (const { message, metaMaskBytes } of personalSignCases) {
				const label = `${ signerName } ${ JSON.stringify(message) }`
				const visualized = await visualize(message, true)
				const signedHash = hashMessage({ raw: metaMaskBytes })
				assert.equal(visualized.quarantine, false, label)
				assert.equal(visualized.messageHash, signedHash, label)
				assert.equal(visualized.shownText, decodeBytes(metaMaskBytes), label)
				const { signature } = await simulatePersonalSign(personalSign(message), signerAddress)
				assert.equal(BigInt(await recoverAddress({ hash: signedHash, signature })), mockSimulationKeyAddress, label)
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
