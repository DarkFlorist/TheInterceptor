import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render, type FunctionComponent } from 'preact'
import { act } from 'preact/test-utils'
import { AddressBook } from '../../app/ts/AddressBook.js'
import { ConfirmTransaction } from '../../app/ts/components/pages/ConfirmTransaction.js'
import { FetchSimulationStack } from '../../app/ts/components/pages/FetchSimulationStack.js'
import { InterceptorAccess } from '../../app/ts/components/pages/InterceptorAccess.js'
import { WebsiteAccessView } from '../../app/ts/components/pages/WebsiteAccess.js'
import type { PendingAccessRequest, PendingTransaction } from '../../app/ts/types/accessRequest.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { OriginalSendRequestParameters } from '../../app/ts/types/JsonRpc-types.js'
import { MessageToPopup, UpdateConfirmTransactionDialogPendingTransactions } from '../../app/ts/types/interceptor-messages.js'
import { PopupRequestsReplies } from '../../app/ts/types/interceptor-reply-messages.js'
import type { RpcEntries, RpcEntry } from '../../app/ts/types/rpc.js'
import type { FailedToCreateWebsiteCreatedEthereumTransaction } from '../../app/ts/types/visualizer-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { clickRenderedElement, findAllRenderedElements, findRenderedElement, installDomMock, type RenderedTreeNode } from './domMock.js'

type RuntimeMessageListener = (message: unknown) => unknown

const ethereumMainnet: RpcEntry = { name: 'Ethereum Mainnet', chainId: 1n, httpsRpc: 'https://mainnet.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: false }
const sepolia: RpcEntry = { name: 'Sepolia', chainId: 11155111n, httpsRpc: 'https://sepolia.example', currencyName: 'Sepolia Ether', currencyTicker: 'SEP', primary: true, minimized: false }
const gnosis: RpcEntry = { name: 'Gnosis', chainId: 100n, httpsRpc: 'https://gnosis.example', currencyName: 'xDai', currencyTicker: 'XDAI', primary: true, minimized: false }
// The Settings page removes Sepolia and adds Gnosis while the page under test stays open.
const rpcEntriesWhenPageOpened: RpcEntries = [ethereumMainnet, sepolia]
const rpcEntriesAfterSettingsChange: RpcEntries = [ethereumMainnet, gnosis]
const chainOptionsWhenPageOpened = ['All Chains', 'Ethereum Mainnet', 'Sepolia']
const chainOptionsAfterSettingsChange = ['All Chains', 'Ethereum Mainnet', 'Gnosis']

const website = { websiteOrigin: 'https://example.test', icon: undefined, title: 'Example' }
const uniqueRequestIdentifier = { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } }
const knownAddress: AddressBookEntry = {
	type: 'contact',
	name: 'Known address',
	address: 0x1111111111111111111111111111111111111111n,
	askForAddressAccess: true,
	useAsActiveAddress: true,
	entrySource: 'User',
	chainId: 1n,
}

function getMessageMethod(message: unknown) {
	if (typeof message !== 'object' || message === null || !('method' in message)) return undefined
	return message.method
}

function installPopupBrowserMock(replyToMessage: (message: unknown) => unknown = () => undefined) {
	const listeners: RuntimeMessageListener[] = []
	const previousBrowser = globalThis.browser
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: undefined,
				getManifest: () => ({ manifest_version: 3 }),
				sendMessage: async (message: unknown) => replyToMessage(message),
				onMessage: {
					addListener: (listener: RuntimeMessageListener) => { listeners.push(listener) },
					removeListener: (listener: RuntimeMessageListener) => {
						const index = listeners.indexOf(listener)
						if (index >= 0) listeners.splice(index, 1)
					},
				},
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
	const deliverSerialized = async (serializedMessage: unknown) => {
		await act(async () => {
			for (const listener of [...listeners]) listener(serializedMessage)
		})
	}
	return {
		deliverSerialized,
		deliver: async (message: MessageToPopup) => await deliverSerialized(MessageToPopup.serialize(message)),
		restore() {
			Object.defineProperty(globalThis, 'browser', { configurable: true, writable: true, value: previousBrowser })
		},
	}
}

function hasClass(node: RenderedTreeNode, className: string) {
	return node.getAttribute?.('class')?.split(/\s+/).includes(className) === true
}

async function clickButtonWithText(root: RenderedTreeNode, text: string) {
	const button = findRenderedElement(root, (node) => node.tagName === 'BUTTON' && node.textContent?.trim() === text)
	if (button === undefined) throw new Error(`Expected a '${ text }' button`)
	await act(async () => {
		await clickRenderedElement(button)
		await new Promise((resolve) => setTimeout(resolve, 0))
	})
}

function readChainSelectorOptions(root: RenderedTreeNode, chainSelectorContainerClass: string) {
	const chainSelector = findRenderedElement(root, (node) => hasClass(node, chainSelectorContainerClass))
	if (chainSelector === undefined) throw new Error(`Expected a chain selector inside .${ chainSelectorContainerClass }`)
	// Sorted because the DOM mock has no `nextSibling`, so Preact appends re-keyed options instead of inserting them in list order.
	return findAllRenderedElements(chainSelector, (node) => node.tagName === 'BUTTON' && hasClass(node, 'dropdown-item')).map((option) => option.textContent?.trim()).sort()
}

async function assertChainSelectorFollowsRpcListUpdates({ page, replyToMessage, showChainSelector, chainSelectorContainerClass }: {
	page: FunctionComponent
	replyToMessage?: (message: unknown) => unknown
	showChainSelector: (root: RenderedTreeNode, browserMock: ReturnType<typeof installPopupBrowserMock>) => Promise<void>
	chainSelectorContainerClass: string
}) {
	const dom = installDomMock()
	// WebsiteAccessView reads the selected website from the URL hash when it mounts.
	Object.defineProperty(globalThis.window, 'location', { configurable: true, writable: true, value: { hash: '' } })
	const browserMock = installPopupBrowserMock(replyToMessage)
	try {
		await act(async () => {
			render(h(page, {}), dom.document.body)
			await new Promise((resolve) => setTimeout(resolve, 0))
		})
		await showChainSelector(dom.document.body, browserMock)
		await browserMock.deliver({
			role: 'all',
			method: 'popup_requestSettingsReply',
			data: {
				useTabsInsteadOfPopup: false,
				metamaskCompatibilityMode: false,
				safeAppsCompatibilityMode: false,
				activeRpcNetwork: ethereumMainnet,
				rpcEntries: rpcEntriesWhenPageOpened,
			},
		})
		assert.deepEqual(readChainSelectorOptions(dom.document.body, chainSelectorContainerClass), chainOptionsWhenPageOpened)

		await browserMock.deliver({ role: 'all', method: 'popup_update_rpc_list', data: rpcEntriesAfterSettingsChange })
		assert.deepEqual(readChainSelectorOptions(dom.document.body, chainSelectorContainerClass), chainOptionsAfterSettingsChange)
	} finally {
		await act(() => { render(null, dom.document.body) })
		browserMock.restore()
		dom.restore()
	}
}

const addressEditorChainSelectorClass = 'address-editor-chain-field'

describe('pages that copy the RPC list from the settings reply follow popup_update_rpc_list', () => {
	test('AddressBook updates its chain filter', async () => {
		await assertChainSelectorFollowsRpcListUpdates({
			page: AddressBook,
			showChainSelector: async () => undefined,
			chainSelectorContainerClass: 'address-book-chain-selector',
		})
	})

	test('InterceptorAccess updates the chain selector of its address editor', async () => {
		const pendingAccessRequest: PendingAccessRequest = {
			website,
			requestAccessToAddress: knownAddress,
			originalRequestAccessToAddress: knownAddress,
			associatedAddresses: [],
			signerAccounts: [],
			signerName: 'NoSigner',
			simulationMode: true,
			popupOrTabId: { type: 'popup', id: 1 },
			socket: uniqueRequestIdentifier.requestSocket,
			request: undefined,
			activeAddress: knownAddress.address,
			accessRequestId: 'access-request',
		}
		await assertChainSelectorFollowsRpcListUpdates({
			page: InterceptorAccess,
			showChainSelector: async (root, browserMock) => {
				await browserMock.deliver({ role: 'all', method: 'popup_interceptorAccessDialog', data: { activeAddresses: [knownAddress], pendingAccessRequests: [pendingAccessRequest] } })
				await clickButtonWithText(root, 'Change')
				await clickButtonWithText(root, 'Add New Address')
			},
			chainSelectorContainerClass: addressEditorChainSelectorClass,
		})
	})

	test('WebsiteAccess updates the chain selector of its address editor', async () => {
		await assertChainSelectorFollowsRpcListUpdates({
			page: WebsiteAccessView,
			showChainSelector: async (root, browserMock) => {
				await browserMock.deliver({
					role: 'all',
					method: 'popup_retrieveWebsiteAccessReply',
					data: {
						websiteAccess: [{ website, addressAccess: [{ address: knownAddress.address, access: true }], access: true }],
						addressAccessMetadata: [knownAddress],
					},
				})
				// The website details only offer address editing inside the remove-address confirmation dialog.
				await clickButtonWithText(root, 'edit')
			},
			chainSelectorContainerClass: addressEditorChainSelectorClass,
		})
	})

	test('FetchSimulationStack updates the chain selector of its address editor', async () => {
		await assertChainSelectorFollowsRpcListUpdates({
			page: FetchSimulationStack,
			replyToMessage: (message) => getMessageMethod(message) === 'popup_requestSimulationMetadata'
				? PopupRequestsReplies.popup_requestSimulationMetadata.serialize({
					method: 'popup_requestSimulationMetadata',
					metadata: { namedTokenIds: [], addressBookEntries: [knownAddress], ens: { ensNameHashes: [], ensLabelHashes: [] } },
				})
				: undefined,
			showChainSelector: async (root, browserMock) => {
				await browserMock.deliver({
					role: 'all',
					method: 'popup_fetchSimulationStackRequest',
					data: { website, popupOrTabId: { type: 'popup', id: 1 }, simulationOverlayEnabled: false, simulationStackVersion: '2.0.0', uniqueRequestIdentifier },
				})
				await clickButtonWithText(root, 'edit')
			},
			chainSelectorContainerClass: addressEditorChainSelectorClass,
		})
	})

	test('ConfirmTransaction updates the chain selector of its address editor', async () => {
		const created = new Date('2024-01-01T00:00:00.000Z')
		const originalRequestParameters: OriginalSendRequestParameters = { method: 'eth_sendTransaction', params: [{ from: knownAddress.address, to: 0x2222222222222222222222222222222222222222n, value: 0n, input: new Uint8Array() }] }
		const transactionToSimulate: FailedToCreateWebsiteCreatedEthereumTransaction = { website, created, originalRequestParameters, transactionIdentifier: 1n, success: false, error: { code: -32000, message: 'simulation failed' } }
		const failedTransaction: PendingTransaction = {
			type: 'Transaction',
			transactionOrMessageCreationStatus: 'FailedToSimulate',
			popupOrTabId: { type: 'popup', id: 1 },
			originalRequestParameters,
			uniqueRequestIdentifier,
			simulationMode: true,
			activeAddress: knownAddress.address,
			created,
			transactionIdentifier: 1n,
			transactionToSimulate,
			website,
			approvalStatus: { status: 'WaitingForUser' },
			popupVisualisation: {
				statusCode: 'failed',
				data: {
					activeAddress: knownAddress.address,
					simulationMode: true,
					simulationStartedTimestamp: created,
					uniqueRequestIdentifier,
					transactionToSimulate,
					signerName: 'NoSignerDetected',
					error: { code: -32000, message: 'simulation failed', decodedErrorMessage: 'simulation failed' },
					simulationState: { blockNumber: 123n, simulationConductedTimestamp: created },
				},
			},
		}
		const pendingTransactionsUpdate: UpdateConfirmTransactionDialogPendingTransactions = {
			method: 'popup_update_confirm_transaction_dialog_pending_transactions',
			data: { pendingTransactionAndSignableMessages: [failedTransaction], currentBlockNumber: 123n, rpcConnectionStatus: undefined },
		}
		await assertChainSelectorFollowsRpcListUpdates({
			page: ConfirmTransaction,
			showChainSelector: async (root, browserMock) => {
				// MessageToPopup leaves this payload unparsed, so it has to be serialized with its own codec.
				await browserMock.deliverSerialized({
					role: 'all',
					...serialize(UpdateConfirmTransactionDialogPendingTransactions, pendingTransactionsUpdate),
				})
				await clickButtonWithText(root, 'edit')
			},
			chainSelectorContainerClass: addressEditorChainSelectorClass,
		})
	})
})
