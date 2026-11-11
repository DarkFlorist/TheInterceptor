import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { EIP712Message } from '../../app/ts/types/eip721.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { SignedMessageTransaction } from '../../app/ts/types/visualizer-types.js'
import { VisualizedPersonalSignRequest } from '../../app/ts/types/personal-message-definitions.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { MockRequestHandler } from '../MockRequestHandler.js'
import { clickRenderedElement, findRenderedElement, installDomMock, type RenderedTreeNode } from './domMock.js'
import { openSeaWithTotalOriginalConsiderationItems, seaportJsSeaport16Listing } from './data/eip712Data.js'

// Address metadata, tab state and RPC lookups read extension storage, which is empty for these requests.
Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		runtime: {
			lastError: undefined,
			getManifest: () => ({ manifest_version: 3 }),
			sendMessage: async () => undefined,
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
		},
		storage: {
			local: {
				async get() { return {} },
				async set() { return undefined },
				async remove() { return undefined },
			},
		},
	},
})

const { craftPersonalSignPopupMessage } = await import('../../app/ts/background/windows/personalSign.js')
const { SignatureCard } = await import('../../app/ts/components/pages/PersonalSign.js')
const { EthereumClientService } = await import('../../app/ts/simulation/services/EthereumClientService.js')

const mainnet: RpcEntry = {
	name: 'Ethereum Mainnet',
	chainId: 1n,
	httpsRpc: new MockRequestHandler().rpcUrl,
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

// Decodes the typed data JSON string the same way an eth_signTypedData_v4 request is decoded before it is visualized, signed by the order's offerer.
async function visualizeSeaportOrder(typedDataJson: string) {
	const typedData = EIP712Message.parse(typedDataJson)
	const offerer = typedData.message.offerer
	if (typeof offerer !== 'string') throw new Error('Seaport order is missing its offerer')
	const signer = BigInt(offerer)
	const signedMessageTransaction: SignedMessageTransaction = {
		website: { websiteOrigin: 'https://opensea.io', title: 'OpenSea', icon: undefined },
		created: new Date('2025-11-11T00:00:00.000Z'),
		activeAddress: signer,
		fakeSignedFor: signer,
		originalRequestParameters: { method: 'eth_signTypedData_v4', params: [signer, typedData] },
		request: {
			method: 'eth_signTypedData_v4',
			params: [],
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } },
		},
		simulationMode: false,
		messageIdentifier: 1n,
	}
	const ethereum = new EthereumClientService(new MockRequestHandler(), async () => undefined, async () => undefined, mainnet)
	const visualized = await craftPersonalSignPopupMessage(ethereum, undefined, signedMessageTransaction, mainnet)
	// The confirmation window receives the request over extension messaging, so it must survive serialization.
	return VisualizedPersonalSignRequest.parse(serialize(VisualizedPersonalSignRequest, visualized))
}

const renderedText = (node: RenderedTreeNode) => (node.textContent ?? '').replace(/\s+/gu, ' ')

async function renderSignatureCardWithExtraDetails(visualizedPersonalSignRequest: VisualizedPersonalSignRequest) {
	const dom = installDomMock()
	try {
		await act(() => {
			render(h(SignatureCard, {
				visualizedPersonalSignRequest,
				renameAddressCallBack: () => undefined,
				removeTransactionOrSignedMessage: undefined,
				numberOfUnderTransactions: 0,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})
		const extraDetailsHeader = findRenderedElement(dom.document.body, (node) => node.tagName === 'HEADER' && node.textContent?.includes('Extra details') === true)
		if (extraDetailsHeader === undefined) throw new Error('Expected the extra details card')
		await act(async () => { await clickRenderedElement(extraDetailsHeader) })
		const text = renderedText(dom.document.body)
		await act(() => { render(null, dom.document.body) })
		return text
	} finally {
		dom.restore()
	}
}

describe('Seaport OrderComponents signature requests', () => {
	test('shows a seaport-js Seaport 1.6 listing as an OpenSea order', async () => {
		const visualized = await visualizeSeaportOrder(seaportJsSeaport16Listing)
		if (visualized.type !== 'OrderComponents') throw new Error(`Expected the OpenSea order view, got ${ visualized.type }`)
		assert.equal(visualized.isValidMessage, true)
		assert.equal(visualized.quarantine, false)
		assert.equal(visualized.message.offer[0]?.itemType, 'ERC721')
		assert.equal(visualized.message.offer[0]?.token.name, 'MetaSamurai - OFFICIAL')
		assert.deepEqual(visualized.message.consideration.map((item) => [item.itemType, item.startAmount]), [['NATIVE', 975000000000000000n], ['NATIVE', 25000000000000000n]])
		assert.equal(visualized.message.consideration[1]?.recipient.name, 'OpenSea: Fees 3')
		const text = await renderSignatureCardWithExtraDetails(visualized)
		// Each token card renders its label twice, once visibly and once in its hover actions.
		assert.ok(text.startsWith('Opensea order'), text)
		assert.ok(text.includes('Offer #323 MSMS'), text)
		assert.ok(text.includes('For 0.975ETHETH'), text)
		assert.ok(text.includes('0.025ETHETHOpenSea: Fees 3'), text)
		assert.ok(text.includes('Order type: FULL_OPEN'), text)
	})

	test('shows an OpenSea Seaport 1.5 offer as an OpenSea order', async () => {
		const visualized = await visualizeSeaportOrder(openSeaWithTotalOriginalConsiderationItems)
		if (visualized.type !== 'OrderComponents') throw new Error(`Expected the OpenSea order view, got ${ visualized.type }`)
		assert.equal(visualized.isValidMessage, true)
		assert.equal(visualized.message.offer[0]?.token.name, 'WETH')
		assert.equal(visualized.message.offer[0]?.startAmount, 100000000000000000n)
		assert.deepEqual(visualized.message.consideration.map((item) => item.itemType), ['ERC721', 'ERC20'])
		const text = await renderSignatureCardWithExtraDetails(visualized)
		assert.ok(text.startsWith('Opensea order'), text)
		assert.ok(text.includes('Offer 0.1WETHWETH'), text)
		assert.ok(text.includes('For #323 MSMS'), text)
		assert.ok(text.includes('0.0025WETHWETH'), text)
	})
})
