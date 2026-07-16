import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { GnosisSafeVisualizer } from '../../app/ts/components/simulationExplaining/customExplainers/GnosisSafeVisualizer.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { VisualizedPersonalSignRequestSafeTx } from '../../app/ts/types/personal-message-definitions.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import { installDomMock } from './domMock.js'

type RuntimeMessageListener = (message: unknown) => unknown

type TestNode = {
	readonly tagName?: string
	readonly childNodes?: readonly TestNode[]
	readonly textContent?: string | null
	readonly l?: Record<string, (event: unknown) => unknown>
	getAttribute?: (name: string) => string | null
}

function findFirstByClass(node: TestNode | undefined, className: string): TestNode | undefined {
	if (node === undefined) return undefined
	const classes = node.getAttribute?.('class')?.split(/\s+/) ?? []
	if (classes.includes(className)) return node
	for (const child of node.childNodes ?? []) {
		const match = findFirstByClass(child, className)
		if (match !== undefined) return match
	}
	return undefined
}

function collectElements(node: TestNode | undefined, tagName: string, results: TestNode[] = []) {
	if (node?.tagName === tagName.toUpperCase()) results.push(node)
	for (const child of node?.childNodes ?? []) collectElements(child, tagName, results)
	return results
}

function getButtonByText(root: TestNode, text: string) {
	const button = collectElements(root, 'button').find((element) => element.textContent?.replace(/\s+/g, ' ').trim() === text)
	if (button === undefined) throw new Error(`Expected button with text "${ text }"`)
	return button
}

async function clickElement(element: TestNode) {
	const clickHandler = element.l === undefined ? undefined : Object.entries(element.l).find(([key]) => key.startsWith('Click'))?.[1]
	if (clickHandler === undefined) throw new Error('Expected click handler')
	await clickHandler({ currentTarget: element })
}

function installBrowserMock() {
	const sentMessages: { method?: string }[] = []
	let runtimeMessageListener: RuntimeMessageListener | undefined
	const runtime = {
		lastError: undefined,
		async sendMessage(message: { method?: string }) {
			sentMessages.push(message)
			return undefined
		},
		onMessage: {
			addListener(listener: RuntimeMessageListener) {
				runtimeMessageListener = listener
				return undefined
			},
			removeListener(listener: RuntimeMessageListener) {
				if (runtimeMessageListener === listener) runtimeMessageListener = undefined
			},
		},
	}
	Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: { runtime } })
	Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })

	return {
		sentMessages,
		emit(message: unknown) {
			runtimeMessageListener?.(message)
		},
	}
}

const rpcNetwork: RpcEntry = {
	name: 'Test Chain',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}

const safeAddress: AddressBookEntry = {
	type: 'contact',
	name: 'Treasury Safe',
	address: 0x1000000000000000000000000000000000000001n,
	entrySource: 'User',
	chainId: rpcNetwork.chainId,
}

const recipientAddress: AddressBookEntry = {
	type: 'contact',
	name: 'Recipient',
	address: 0x2000000000000000000000000000000000000002n,
	entrySource: 'User',
	chainId: rpcNetwork.chainId,
}

const zeroAddress: AddressBookEntry = {
	type: 'contact',
	name: 'Zero address',
	address: 0n,
	entrySource: 'Interceptor',
	chainId: rpcNetwork.chainId,
}

const safeMessage: VisualizedPersonalSignRequestSafeTx = {
	activeAddress: safeAddress,
	rpcNetwork,
	simulationMode: true,
	signerName: 'NoSigner',
	quarantineReasons: [],
	quarantine: false,
	account: safeAddress,
	website: { websiteOrigin: 'https://safe.example', icon: undefined, title: 'Safe' },
	created: new Date('2024-01-01T00:00:00.000Z'),
	rawMessage: '{}',
	stringifiedMessage: '{}',
	messageIdentifier: 2n,
	method: 'eth_signTypedData_v4',
	type: 'SafeTx',
	message: {
		types: {
			SafeTx: [
				{ name: 'to', type: 'address' },
				{ name: 'value', type: 'uint256' },
				{ name: 'data', type: 'bytes' },
				{ name: 'operation', type: 'uint8' },
				{ name: 'safeTxGas', type: 'uint256' },
				{ name: 'baseGas', type: 'uint256' },
				{ name: 'gasPrice', type: 'uint256' },
				{ name: 'gasToken', type: 'address' },
				{ name: 'refundReceiver', type: 'address' },
				{ name: 'nonce', type: 'uint256' },
			],
			EIP712Domain: [
				{ name: 'chainId', type: 'uint256' },
				{ name: 'verifyingContract', type: 'address' },
			],
		},
		primaryType: 'SafeTx',
		domain: { chainId: rpcNetwork.chainId, verifyingContract: safeAddress.address },
		message: {
			to: recipientAddress.address,
			value: 0n,
			data: new Uint8Array(),
			operation: 0n,
			safeTxGas: 0n,
			baseGas: 0n,
			gasPrice: 0n,
			gasToken: zeroAddress.address,
			refundReceiver: zeroAddress.address,
			nonce: 0n,
		},
	},
	parsedMessageDataAddressBookEntries: [],
	parsedMessageData: { type: 'NonParsed', input: new Uint8Array() },
	gasToken: zeroAddress,
	to: recipientAddress,
	refundReceiver: zeroAddress,
	verifyingContract: safeAddress,
	messageHash: '0x1',
	domainHash: '0x2',
	safeTxHash: '0x3',
}

const nextSafeMessage: VisualizedPersonalSignRequestSafeTx = {
	...safeMessage,
	messageIdentifier: 3n,
	safeTxHash: '0x4',
}

describe('GnosisSafeVisualizer outcome simulation', () => {
	test('replaces the action with a spinner while the simulation is pending and supports refresh', async () => {
		const browserMock = installBrowserMock()
		const dom = installDomMock()

		await act(() => {
			render(h(GnosisSafeVisualizer, {
				gnosisSafeMessage: safeMessage,
				activeAddress: safeAddress.address,
				renameAddressCallBack: () => undefined,
				editEnsNamedHashCallBack: () => undefined,
			}), dom.document.body)
		})

		assert.equal(dom.document.body.textContent?.includes('Outcome if approved'), true)
		const outcomePanel = findFirstByClass(dom.document.body, 'safe-outcome-panel')
		assert.equal(outcomePanel?.textContent?.includes('Simulate outcome'), true)
		assert.equal(outcomePanel?.textContent?.includes('Preview the transaction'), false)
		assert.equal(outcomePanel?.textContent?.includes('See what the Safe transaction would do'), false)
		const initialButton = getButtonByText(dom.document.body, 'Simulate outcome')

		await act(async () => {
			await clickElement(initialButton)
		})

		const outcomeContent = findFirstByClass(dom.document.body, 'safe-outcome-panel__content')
		const loadingState = findFirstByClass(dom.document.body, 'safe-outcome-panel__loading')
		assert.equal(String(outcomeContent?.getAttribute?.('aria-busy')), 'true')
		assert.equal(loadingState?.getAttribute?.('role'), 'status')
		assert.equal(loadingState?.getAttribute?.('aria-label'), 'Simulating outcome')
		assert.equal(loadingState?.textContent?.trim(), '')
		assert.notEqual(findFirstByClass(dom.document.body, 'spinner'), undefined)
		assert.equal(collectElements(dom.document.body, 'button').some((button) => button.textContent?.includes('Simulate outcome')), false)
		assert.equal(browserMock.sentMessages.filter((message) => message.method === 'popup_simulateGnosisSafeTransaction').length, 1)

		await act(async () => {
			await clickElement(initialButton)
		})
		assert.equal(browserMock.sentMessages.filter((message) => message.method === 'popup_simulateGnosisSafeTransaction').length, 1)

		await act(async () => {
			browserMock.emit({
				role: 'all',
				method: 'popup_simulateExecutionReply',
				data: {
					success: false,
					errorType: 'Other',
					transactionOrMessageIdentifier: '0x2',
					errorMessage: 'Simulation unavailable',
				},
			})
			await Promise.resolve()
		})

		assert.equal(String(outcomeContent?.getAttribute?.('aria-busy')), 'false')
		assert.equal(findFirstByClass(dom.document.body, 'spinner'), undefined)
		assert.equal(dom.document.body.textContent?.includes('Simulation unavailable'), true)

		await act(async () => {
			await clickElement(getButtonByText(dom.document.body, 'Refresh simulation'))
		})
		assert.equal(findFirstByClass(dom.document.body, 'safe-outcome-panel__loading')?.textContent?.trim(), '')
		assert.notEqual(findFirstByClass(dom.document.body, 'spinner'), undefined)
		assert.equal(browserMock.sentMessages.filter((message) => message.method === 'popup_simulateGnosisSafeTransaction').length, 2)

		dom.restore()
	})

	test('only accepts replies for the current Safe message after the component is reused', async () => {
		const browserMock = installBrowserMock()
		const dom = installDomMock()
		const renderSafeMessage = (gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx) => render(h(GnosisSafeVisualizer, {
			gnosisSafeMessage,
			activeAddress: safeAddress.address,
			renameAddressCallBack: () => undefined,
			editEnsNamedHashCallBack: () => undefined,
		}), dom.document.body)

		await act(() => {
			renderSafeMessage(safeMessage)
		})
		await act(async () => {
			await clickElement(getButtonByText(dom.document.body, 'Simulate outcome'))
		})

		await act(() => {
			renderSafeMessage(nextSafeMessage)
		})
		await act(async () => {
			await clickElement(getButtonByText(dom.document.body, 'Simulate outcome'))
		})

		browserMock.emit({
			role: 'all',
			method: 'popup_simulateExecutionReply',
			data: {
				success: false,
				errorType: 'Other',
				transactionOrMessageIdentifier: '0x2',
				errorMessage: 'Stale simulation result',
			},
		})
		await act(async () => {
			await Promise.resolve()
		})

		const outcomeContent = findFirstByClass(dom.document.body, 'safe-outcome-panel__content')
		assert.equal(String(outcomeContent?.getAttribute?.('aria-busy')), 'true')
		assert.equal(dom.document.body.textContent?.includes('Stale simulation result'), false)
		assert.notEqual(findFirstByClass(dom.document.body, 'spinner'), undefined)

		browserMock.emit({
			role: 'all',
			method: 'popup_simulateExecutionReply',
			data: {
				success: false,
				errorType: 'Other',
				transactionOrMessageIdentifier: '0x3',
				errorMessage: 'Current simulation result',
			},
		})
		await act(async () => {
			await Promise.resolve()
		})

		assert.equal(String(outcomeContent?.getAttribute?.('aria-busy')), 'false')
		assert.equal(dom.document.body.textContent?.includes('Current simulation result'), true)
		assert.equal(findFirstByClass(dom.document.body, 'spinner'), undefined)
		assert.equal(browserMock.sentMessages.filter((message) => message.method === 'popup_simulateGnosisSafeTransaction').length, 2)

		dom.restore()
	})
})
