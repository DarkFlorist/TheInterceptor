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
	token: {
		type: 'ERC20',
		name: 'Verified Token',
		symbol: 'VER',
		decimals: 6n,
		address: 0x1111111111111111111111111111111111111111n,
		chainId: 1n,
		entrySource: 'User',
	},
	forwardToSigner: { signerName: 'MetaMask', connectionName: 3n, ownerGeneration: 1, signerProviderGeneration: 1 },
}

describe('watch asset proposal rendering', () => {
	test('shows the complete website request and verified address-book entry with legible values', async () => {
		const dom = installDomMock()
		try {
			await act(() => {
				render(h(WatchAssetDetails, { pendingRequest }), dom.document.body)
			})

			const requestSection = findNodeByExactText(dom.document.body, 'Request details')?.parentNode
			const verifiedSection = findNodeByExactText(dom.document.body, 'Address book entry (verified on-chain)')?.parentNode
			assert.notEqual(requestSection, undefined)
			assert.notEqual(verifiedSection, undefined)
			for (const expected of [
				'https://dapp.example',
			]) assert.match(dom.document.body.textContent, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
			for (const expected of [
				'Asset type',
				'ERC20',
				'Contract',
				'0x1111111111111111111111111111111111111111',
				'Chain ID',
				'1',
				'Symbol hint',
				'SITE',
				'Decimals hint',
				'8',
				'Image hint',
				'https://dapp.example/token.png',
			]) assert.match(requestSection?.textContent ?? '', new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
			for (const expected of [
				'Type',
				'ERC20',
				'Name',
				'Verified Token',
				'Symbol',
				'VER',
				'Contract',
				'0x1111111111111111111111111111111111111111',
				'Decimals',
				'6',
				'Chain ID',
				'1',
			]) assert.match(verifiedSection?.textContent ?? '', new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

			const verifiedName = findNodeByExactText(dom.document.body, 'Verified Token')
			const verifiedNameStyle = verifiedName?.style?.color ?? verifiedName?.style?.cssText ?? verifiedName?.getAttribute?.('style') ?? ''
			assert.match(verifiedNameStyle, /var\(--text-color\)/)
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
			}
			await act(() => {
				render(h(WatchAssetDetails, { pendingRequest: requestWithoutHints }), dom.document.body)
			})

			const requestSection = findNodeByExactText(dom.document.body, 'Request details')?.parentNode
			const requestText = requestSection?.textContent ?? ''
			assert.match(requestText, /Chain IDNot provided \(active chain used\)/)
			assert.match(requestText, /Symbol hintNot provided/)
			assert.match(requestText, /Decimals hintNot provided/)
			assert.match(requestText, /Image hintNot provided/)
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
