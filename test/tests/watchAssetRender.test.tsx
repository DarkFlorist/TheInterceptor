import * as assert from 'assert'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { describe, test } from 'bun:test'
import { WatchAssetActions, WatchAssetDetails } from '../../app/ts/components/pages/WatchAsset.js'
import type { PendingWatchAssetRequest } from '../../app/ts/types/user-interface-types.js'
import { installDomMock } from './domMock.js'

type TestNode = {
	textContent?: string | null
	childNodes?: readonly TestNode[]
	parentNode?: TestNode | null
	getAttribute?: (name: string) => string | null
	style?: Record<string, string>
	tagName?: string
	disabled?: boolean
}

function findNodeByExactText(node: TestNode, text: string): TestNode | undefined {
	if (node.getAttribute !== undefined && node.textContent === text) return node
	for (const child of node.childNodes ?? []) {
		const match = findNodeByExactText(child, text)
		if (match !== undefined) return match
	}
	return undefined
}

function findFirstByTag(node: TestNode, tagName: string): TestNode | undefined {
	if (node.tagName === tagName.toUpperCase()) return node
	for (const child of node.childNodes ?? []) {
		const match = findFirstByTag(child, tagName)
		if (match !== undefined) return match
	}
	return undefined
}

function findNodeByAttribute(node: TestNode, name: string, value: string): TestNode | undefined {
	if (node.getAttribute?.(name) === value) return node
	for (const child of node.childNodes ?? []) {
		const match = findNodeByAttribute(child, name, value)
		if (match !== undefined) return match
	}
	return undefined
}

const pendingRequest: PendingWatchAssetRequest = {
	website: { websiteOrigin: 'https://dapp.example', title: 'Example dapp', icon: undefined },
	popupOrTabId: { type: 'popup', id: 1 },
	request: {
		method: 'wallet_watchAsset',
		params: [],
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 2, connectionName: 3n } },
	},
	requestedAsset: {
		type: 'ERC20',
		options: {
			address: 0x1111111111111111111111111111111111111111n,
			chainId: 1,
			symbol: 'SITE',
			decimals: 8,
			image: 'https://dapp.example/token.png',
		},
	},
	currentToken: {
		type: 'ERC20',
		name: 'Saved Token',
		symbol: 'OLD',
		decimals: 6n,
		address: 0x1111111111111111111111111111111111111111n,
		chainId: 1n,
		entrySource: 'User',
		logoUri: 'data:image/png;base64,b2xk',
	},
	token: {
		type: 'ERC20',
		name: 'Saved Token',
		symbol: 'SITE',
		decimals: 8n,
		address: 0x1111111111111111111111111111111111111111n,
		chainId: 1n,
		entrySource: 'User',
		logoUri: 'data:image/png;base64,b2xk',
	},
	proposedAssetName: undefined,
	proposedAssetDescription: undefined,
	proposedImageUrl: 'https://dapp.example/token.png',
	selectedImageUri: undefined,
	imageDownloadError: undefined,
	forwardToSigner: { signerName: 'MetaMask', connectionName: 3n, ownerGeneration: 1, signerProviderGeneration: 1 },
}

describe('watch asset proposal rendering', () => {
	test('shows the requested token ID changes for ERC721 and ERC1155 assets', async () => {
		for (const type of ['ERC721', 'ERC1155'] as const) {
			const currentToken = type === 'ERC721'
				? { type, name: 'Collectible', symbol: 'NFT', address: pendingRequest.currentToken.address, chainId: 1n, entrySource: 'User' as const, watchedTokenIds: [7n] }
				: { type, name: 'Game Items', symbol: 'ITEM', decimals: undefined, address: pendingRequest.currentToken.address, chainId: 1n, entrySource: 'User' as const, watchedTokenIds: [7n] }
			const nftRequest: PendingWatchAssetRequest = {
				...pendingRequest,
				requestedAsset: { type, options: { address: pendingRequest.currentToken.address, tokenId: '42' } },
				currentToken,
				token: { ...currentToken, watchedTokenIds: [7n, 42n] },
				proposedAssetName: 'Token #42',
				proposedAssetDescription: 'Token-specific metadata',
			}
			const dom = installDomMock()
			try {
				await act(() => { render(h(WatchAssetDetails, { pendingRequest: nftRequest }), dom.document.body) })
				const text = dom.document.body.textContent ?? ''
				assert.match(text, new RegExp(`${ type }.*Token IDs.*7.*7, 42.*Will change`, 's'))
				assert.match(text, new RegExp(`Name${ currentToken.name }${ currentToken.name }No change`, 's'))
				assert.match(text, /Token metadataToken nameToken #42DescriptionToken-specific metadata/)
				assert.match(text, /Informational metadata is shown for verification and is not stored as an address-book field/)
				assert.equal(text.includes('Decimals'), false)
			} finally {
				render(null, dom.document.body)
				dom.restore()
			}
		}
	})

	test('shows current and proposed address-book values and marks fields that will change', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(WatchAssetDetails, { pendingRequest }), dom.document.body)
			})

			const requestSection = findNodeByExactText(dom.document.body, 'Asset proposal')?.parentNode
			assert.notEqual(requestSection, undefined)
			assert.equal(dom.document.body.textContent?.includes('on-chain'), false)
			for (const expected of [
				'https://dapp.example',
			]) assert.match(dom.document.body.textContent, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
			for (const expected of [
				'Contract',
				'Saved Token',
				'Field',
				'Current',
				'If accepted',
				'Change',
				'Asset type',
				'ERC20',
				'Chain ID',
				'1',
				'Symbol',
				'OLD',
				'SITE',
				'Will change',
				'Decimals',
				'6',
				'8',
				'Token image',
				'Download image',
			]) assert.match(requestSection?.textContent ?? '', new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
			assert.equal(requestSection?.textContent?.includes('https://dapp.example/token.png'), false)
			assert.notEqual(findNodeByAttribute(requestSection ?? {}, 'src', 'data:image/png;base64,b2xk'), undefined)
			assert.notEqual(findNodeByAttribute(requestSection ?? {}, 'value', '0x1111111111111111111111111111111111111111'), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('shows explicit fallbacks for every omitted optional request field', async () => {
		const dom = installDomMock()
		try {
			const requestWithoutHints: PendingWatchAssetRequest = {
				...pendingRequest,
				requestedAsset: { type: 'ERC20', options: { address: pendingRequest.requestedAsset.options.address } },
				token: { ...pendingRequest.currentToken, entrySource: 'User' },
				proposedImageUrl: undefined,
			}
			await act(() => {
				render(h(WatchAssetDetails, { pendingRequest: requestWithoutHints }), dom.document.body)
			})

			const requestSection = findNodeByExactText(dom.document.body, 'Asset proposal')?.parentNode
			const requestText = requestSection?.textContent ?? ''
			assert.match(requestText, /SymbolOLDOLDNo change/)
			assert.match(requestText, /Decimals66No change/)
			assert.equal(requestText.includes('Download image'), false)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('shows the old and downloaded images without a URL or remove control', async () => {
		const dom = installDomMock()
		try {
			const requestWithImage = { ...pendingRequest, selectedImageUri: 'data:image/png;base64,dG9rZW4=' }
			await act(() => {
				render(h(WatchAssetDetails, { pendingRequest: requestWithImage }), dom.document.body)
			})

			assert.equal(findNodeByExactText(dom.document.body, 'Remove'), undefined)
			assert.equal(dom.document.body.textContent?.includes('https://dapp.example/token.png'), false)
			assert.notEqual(findNodeByAttribute(dom.document.body, 'src', 'data:image/png;base64,dG9rZW4='), undefined)
			assert.notEqual(findNodeByAttribute(dom.document.body, 'src', 'data:image/png;base64,b2xk'), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('shows an image download failure without exposing the image URL', async () => {
		const dom = installDomMock()
		try {
			const failedRequest = { ...pendingRequest, imageDownloadError: 'The proposed image could not be downloaded or decoded.' }
			await act(() => {
				render(h(WatchAssetDetails, { pendingRequest: failedRequest }), dom.document.body)
			})

			assert.equal(dom.document.body.textContent?.includes('https://dapp.example/token.png'), false)
			assert.notEqual(findNodeByExactText(dom.document.body, 'The proposed image could not be downloaded or decoded.'), undefined)
			assert.notEqual(findNodeByExactText(dom.document.body, 'Download image'), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('keeps wallet forwarding visible but disabled when no wallet is connected', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(WatchAssetActions, { forwardToSigner: undefined, submitting: false, choose: () => undefined }), dom.document.body)
			})
			const forwardButton = findNodeByExactText(dom.document.body, 'Forward to wallet')
			assert.notEqual(forwardButton, undefined)
			assert.equal(forwardButton?.disabled === true || forwardButton?.getAttribute?.('disabled') !== null, true)
			assert.notEqual(findFirstByTag(forwardButton ?? {}, 'svg'), undefined)
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})

	test('names the connected wallet and renders its icon in the forwarding action', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(WatchAssetActions, {
					forwardToSigner: { signerName: 'MetaMask', connectionName: 3n, ownerGeneration: 1, signerProviderGeneration: 1 },
					submitting: false,
					choose: () => undefined,
				}), dom.document.body)
			})
			const forwardButton = findNodeByExactText(dom.document.body, 'Forward to MetaMask')
			assert.notEqual(forwardButton, undefined)
			assert.equal(forwardButton?.disabled === true || forwardButton?.getAttribute?.('disabled') !== null, false)
			assert.equal(findFirstByTag(forwardButton ?? {}, 'img')?.getAttribute?.('src'), '../img/signers/metamask.svg')
		} finally {
			render(null, dom.document.body)
			dom.restore()
		}
	})
})
