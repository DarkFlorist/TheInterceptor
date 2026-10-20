import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { getWebsiteSocketRequestOrigin, websiteSocketToString } from '../../app/ts/background/backgroundUtils.js'
import { craftPersonalSignPopupMessage } from '../../app/ts/background/windows/personalSign.js'
import { SignatureCard } from '../../app/ts/components/pages/PersonalSign.js'
import { identifySignature } from '../../app/ts/components/simulationExplaining/identifySignature.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { VisualizedPersonalSignRequest } from '../../app/ts/types/personal-message-definitions.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { SignedMessageTransaction } from '../../app/ts/types/visualizer-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { MOCK_PRIVATE_KEYS_ADDRESS } from '../../app/ts/utils/constants.js'
import { bytesToHex, stringToBytes } from '../../app/ts/utils/ethereumBytes.js'
import { getFrameOrigins } from '../../app/ts/utils/requests.js'
import { SIWE_LOOKALIKE_QUARANTINE_REASON } from '../../app/ts/utils/siwe.js'
import { clickRenderedElement, findRenderedElement, installDateMock, installDomMock } from './domMock.js'

// vitalik.eth is in the default address book, so identifying it needs no RPC.
const VITALIK_ADDRESS = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n
const VITALIK_CHECKSUMMED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const MOCK_ADDRESS_CHECKSUMMED = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'

const rpcEntry: RpcEntry = {
	name: 'Ethereum Mainnet',
	chainId: 1n,
	httpsRpc: 'https://rpc.example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	currencyLogoUri: undefined,
	primary: true,
	minimized: false,
}

const ethereum = new EthereumClientService({
	rpcUrl: rpcEntry.httpsRpc,
	clearCache: () => undefined,
	jsonRpcRequest: async () => { throw new Error('RPC should not be called') },
}, async () => undefined, async () => undefined, rpcEntry)

const installBrowserStorageMock = () => {
	const storageState: Record<string, unknown> = {}
	const previousBrowser = globalThis.browser
	Object.defineProperty(globalThis, 'browser', {
		value: {
			storage: {
				local: {
					async get(keys?: string | string[] | Record<string, unknown> | null) {
						if (keys === undefined || keys === null) return { ...storageState }
						if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
						if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
						return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
					},
					async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
					async remove(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
					},
				},
			},
		},
		configurable: true,
		writable: true,
	})
	return () => { Object.defineProperty(globalThis, 'browser', { value: previousBrowser, configurable: true, writable: true }) }
}

const siweText = ({ scheme, domain = 'example.com', address = VITALIK_CHECKSUMMED, uri = 'https://example.com/login', chainId = '1', optionalFields = [] }: { scheme?: string, domain?: string, address?: string, uri?: string, chainId?: string, optionalFields?: readonly string[] } = {}) => [
	`${ scheme === undefined ? '' : `${ scheme }://` }${ domain } wants you to sign in with your Ethereum account:`,
	address,
	'',
	'I accept the ExampleOrg Terms of Service: https://example.com/tos',
	'',
	`URI: ${ uri }`,
	'Version: 1',
	`Chain ID: ${ chainId }`,
	'Nonce: 32891756',
	'Issued At: 2021-09-30T16:25:24Z',
	...optionalFields,
].join('\n')

// The requesting website: its host and port as `Website.websiteOrigin` keeps them, and the full origin recorded with the request, which records stored before it was recorded lack.
type Requester = { readonly websiteOrigin: string, readonly requestOrigin: string | undefined }
const FROM_EXAMPLE_COM: Requester = { websiteOrigin: 'example.com', requestOrigin: 'https://example.com' }
const FROM_EVIL_EXAMPLE: Requester = { websiteOrigin: 'evil.example', requestOrigin: 'https://evil.example' }

function createSignedMessageTransaction(message: string, requester: Requester = FROM_EXAMPLE_COM): SignedMessageTransaction {
	const params: readonly [string, bigint] = [bytesToHex(stringToBytes(message)), VITALIK_ADDRESS]
	return {
		website: { websiteOrigin: requester.websiteOrigin, icon: undefined, title: undefined },
		...(requester.requestOrigin === undefined ? {} : { requestOrigin: requester.requestOrigin }),
		created: new Date('2026-01-01T00:00:00.000Z'),
		activeAddress: VITALIK_ADDRESS,
		fakeSignedFor: VITALIK_ADDRESS,
		originalRequestParameters: { method: 'personal_sign', params },
		request: {
			method: 'personal_sign',
			params: [...params],
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
		},
		simulationMode: true,
		messageIdentifier: 1n,
	}
}

async function visualize(message: string, requester?: Requester) {
	const restoreBrowser = installBrowserStorageMock()
	try {
		return await craftPersonalSignPopupMessage(ethereum, undefined, createSignedMessageTransaction(message, requester), rpcEntry)
	} finally {
		restoreBrowser()
	}
}

async function visualizeSignIn(message: string, requester?: Requester) {
	const visualized = await visualize(message, requester)
	if (visualized.type !== 'SignInWithEthereum') throw new Error(`expected a Sign-In with Ethereum visualization, got ${ visualized.type }`)
	return visualized
}

describe('Sign-In with Ethereum personal_sign visualization', () => {
	test('reads the request origin from the same content script port URL as the connection website origin', () => {
		const socket = { tabId: 7, connectionName: 3n }
		const port = { name: '0x3', sender: { url: 'http://localhost:3000/login?next=%2F' } }
		// The connection is registered the way onContentScriptConnected does it, with its website origin from getFrameOrigins.
		const { websiteOrigin } = getFrameOrigins(port.sender.url)
		const websiteTabConnections = new Map([[socket.tabId, { connections: { [websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: false } } }]])
		assert.equal(websiteOrigin, 'localhost:3000')
		assert.equal(getWebsiteSocketRequestOrigin(websiteTabConnections, socket), `http://${ websiteOrigin }`)
		assert.equal(getWebsiteSocketRequestOrigin(websiteTabConnections, { tabId: socket.tabId, connectionName: 4n }), undefined)
	})

	test('visualizes a sign-in message from the website it names without quarantine', async () => {
		const text = siweText({ optionalFields: ['Resources:', '- https://example.com/my-web2-claim.json'] })
		const visualized = await visualizeSignIn(text)
		assert.equal(visualized.quarantine, false)
		assert.deepEqual(visualized.quarantineReasons, [])
		assert.equal(visualized.message.domain, 'example.com')
		assert.equal(visualized.message.statement, 'I accept the ExampleOrg Terms of Service: https://example.com/tos')
		assert.deepEqual(visualized.message.resources, ['https://example.com/my-web2-claim.json'])
		assert.equal(visualized.signInAccount.name, 'vitalik.eth')
		assert.equal(visualized.account.name, 'vitalik.eth')
		// The raw message keeps the signed bytes and the parsed view shows the decoded text.
		assert.equal(visualized.rawMessage, bytesToHex(stringToBytes(text)))
		assert.equal(visualized.stringifiedMessage, text)
		assert.equal(visualized.messageHash.startsWith('0x'), true)
		assert.deepEqual(VisualizedPersonalSignRequest.parse(serialize(VisualizedPersonalSignRequest, visualized)), visualized)
		assert.deepEqual(identifySignature(visualized), {
			title: 'Sign in to example.com',
			rejectAction: 'Reject sign in to example.com',
			simulationAction: 'Simulate sign in to example.com',
			signingAction: 'Sign in to example.com',
		})
	})

	test('quarantines a sign-in message for a different website', async () => {
		const visualized = await visualizeSignIn(siweText({ domain: 'example.com' }), FROM_EVIL_EXAMPLE)
		assert.equal(visualized.quarantine, true)
		assert.deepEqual(visualized.quarantineReasons, ['This sign-in message is for https://example.com, but it was requested by https://evil.example. A website asking you to sign in to a different website is a common phishing attack.'])
	})

	test('flags a sign-in message from a record without a requesting origin instead of checking its host alone', async () => {
		// An http page on the named host asking for an http sign-in: comparing hosts alone would pass it, so a record that cannot tell its scheme apart is flagged.
		const visualized = await visualizeSignIn(siweText({ scheme: 'http' }), { websiteOrigin: 'example.com', requestOrigin: undefined })
		assert.equal(visualized.message.scheme, 'http')
		assert.equal(visualized.quarantine, true)
		assert.deepEqual(visualized.quarantineReasons, ['This sign-in message is for http://example.com, but the Interceptor did not record the full origin of the website that requested it, so it cannot check that they match.'])
	})

	test('flags a sign-in message for an account other than the signing account', async () => {
		const visualized = await visualizeSignIn(siweText({ address: MOCK_ADDRESS_CHECKSUMMED }))
		assert.equal(visualized.signInAccount.address, MOCK_PRIVATE_KEYS_ADDRESS)
		assert.equal(visualized.quarantine, true)
		assert.deepEqual(visualized.quarantineReasons, ['The signature request is for an account that is different from your active address.'])
	})

	test('flags a sign-in message bound to a chain other than the active one', async () => {
		const visualized = await visualizeSignIn(siweText({ chainId: '5' }))
		assert.equal(visualized.quarantine, true)
		assert.deepEqual(visualized.quarantineReasons, ['The signature request is for a different chain (Goerli) than what is currently active (Ethereum Mainnet).'])
	})

	test('keeps ordinary messages on the unparsed path without quarantine', async () => {
		const visualized = await visualize('Welcome! Sign this message to continue.')
		assert.equal(visualized.type, 'NotParsed')
		assert.equal(visualized.quarantine, false)
		assert.deepEqual(visualized.quarantineReasons, [])
	})

	test('quarantines a message that reads like a sign-in request but does not conform to EIP-4361', async () => {
		const visualized = await visualize(`${ siweText() }\n`, FROM_EVIL_EXAMPLE)
		assert.equal(visualized.type, 'NotParsed')
		assert.equal(visualized.quarantine, true)
		assert.deepEqual(visualized.quarantineReasons, [SIWE_LOOKALIKE_QUARANTINE_REASON])
	})

	test('quarantines a message with a malformed URI or resource even when its website, account and chain match', async () => {
		for (const text of [
			siweText({ uri: 'https://example.com:abc/login' }),
			siweText({ uri: 'https://[not-an-ip]/login' }),
			siweText({ optionalFields: ['Resources:', '- https://example.com:abc/claim.json'] }),
			siweText({ optionalFields: ['Resources:', '- https://[not-an-ip]/claim.json'] }),
		]) {
			const visualized = await visualize(text)
			assert.equal(visualized.type, 'NotParsed', text)
			assert.equal(visualized.quarantine, true, text)
			assert.deepEqual(visualized.quarantineReasons, [SIWE_LOOKALIKE_QUARANTINE_REASON], text)
		}
	})

	test('quarantines a percent-encoded domain instead of matching its decoded host', async () => {
		const visualized = await visualize(siweText({ domain: '%65vil.example' }), FROM_EVIL_EXAMPLE)
		assert.equal(visualized.type, 'NotParsed')
		assert.equal(visualized.quarantine, true)
		assert.deepEqual(visualized.quarantineReasons, [SIWE_LOOKALIKE_QUARANTINE_REASON])
	})

	test('updates the validity warnings and the relative times as the clock passes the validity window while the card is shown', async () => {
		const visualized = await visualizeSignIn(siweText({ optionalFields: ['Expiration Time: 2026-01-01T00:00:30Z', 'Not Before: 2026-01-01T00:00:10Z'] }))
		// The window has long passed when the request is crafted, but time-dependent warnings are not stored with it; the card checks them against its own clock.
		assert.equal(visualized.quarantine, false)
		assert.deepEqual(visualized.quarantineReasons, [])
		const notValidYetWarning = 'This sign-in message is not valid until 2026-01-01T00:00:10.000Z, so signing it now gives the website a sign-in it can use later.'
		const expiredWarning = 'This sign-in message expired at 2026-01-01T00:00:30.000Z.'
		const dom = installDomMock()
		const clock = installDateMock('2026-01-01T00:00:00.000Z')
		// The DOM mock stubs setInterval out, so capture the once-a-second refreshes of the card and tick them by hand.
		const domMockSetInterval = globalThis.setInterval
		const intervalCallbacks: (() => void)[] = []
		Object.defineProperty(globalThis, 'setInterval', { value: (callback: () => void) => intervalCallbacks.push(callback), configurable: true, writable: true })
		const renderedText = () => dom.document.body.textContent ?? ''
		const advanceClockTo = async (now: string) => {
			clock.setNow(now)
			await act(() => { for (const tick of intervalCallbacks) tick() })
		}
		try {
			await act(() => {
				render(h(SignatureCard, {
					visualizedPersonalSignRequest: visualized,
					renameAddressCallBack: () => undefined,
					removeTransactionOrSignedMessage: undefined,
					numberOfUnderTransactions: 0,
					editEnsNamedHashCallBack: () => undefined,
				}), dom.document.body)
			})
			assert.notEqual(intervalCallbacks.length, 0)
			assert.equal(renderedText().includes('Expires at: 2026-01-01T00:00:30.000Z (in 30s)'), true, renderedText())
			assert.equal(renderedText().includes(notValidYetWarning), true, renderedText())
			assert.equal(renderedText().includes(expiredWarning), false, renderedText())

			await advanceClockTo('2026-01-01T00:00:20.000Z')
			assert.equal(renderedText().includes(notValidYetWarning), false, renderedText())
			assert.equal(renderedText().includes(expiredWarning), false, renderedText())

			await advanceClockTo('2026-01-01T00:01:00.000Z')
			assert.equal(renderedText().includes('Expires at: 2026-01-01T00:00:30.000Z (30s ago)'), true, renderedText())
			assert.equal(renderedText().includes(notValidYetWarning), false, renderedText())
			assert.equal(renderedText().includes(expiredWarning), true, renderedText())
		} finally {
			await act(() => { render(null, dom.document.body) })
			Object.defineProperty(globalThis, 'setInterval', { value: domMockSetInterval, configurable: true, writable: true })
			clock.restore()
			dom.restore()
		}
	})

	test('shows the sign-in fields, the warning and the raw message in the signature card', async () => {
		const visualized = await visualizeSignIn(siweText({ optionalFields: ['Request ID: request-1', 'Resources:', '- ipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq/'] }), FROM_EVIL_EXAMPLE)
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(SignatureCard, {
					visualizedPersonalSignRequest: visualized,
					renameAddressCallBack: () => undefined,
					removeTransactionOrSignedMessage: undefined,
					numberOfUnderTransactions: 0,
					editEnsNamedHashCallBack: () => undefined,
				}), dom.document.body)
			})
			const renderedText = dom.document.body.textContent ?? ''
			for (const expected of [
				'Sign in to example.com',
				'Sign in toexample.com',
				'StatementI accept the ExampleOrg Terms of Service: https://example.com/tos',
				'URIhttps://example.com/login',
				'Account: vitalik.eth',
				'Chain: Ethereum Mainnet (1)',
				'Nonce: 32891756',
				'Issued at: 2021-09-30T16:25:24.000Z',
				'Request ID: request-1',
				'Resourcesipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq/',
				'This sign-in message is for https://example.com, but it was requested by https://evil.example.',
				'Raw message',
			]) assert.equal(renderedText.includes(expected), true, `expected "${ expected }" in "${ renderedText }"`)
			assert.equal(renderedText.includes('Expires at'), false)

			const rawMessageHeader = findRenderedElement(dom.document.body, (node) => node.tagName === 'HEADER' && node.textContent?.includes('Raw message') === true)
			if (rawMessageHeader === undefined) throw new Error('Expected the raw message card')
			await act(async () => { await clickRenderedElement(rawMessageHeader) })
			assert.equal(dom.document.body.textContent?.includes('example.com wants you to sign in with your Ethereum account:'), true)
		} finally {
			await act(() => { render(null, dom.document.body) })
			dom.restore()
		}
	})
})
