import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render, type VNode } from 'preact'
import { act } from 'preact/test-utils'
import { App } from '../../app/ts/components/App.js'
import { FetchSimulationStack } from '../../app/ts/components/pages/FetchSimulationStack.js'
import { SimulationStackPage } from '../../app/ts/components/pages/SimulationStackPage.js'
import { subscribeToSimulationStatePublications } from '../../app/ts/components/simulationStatePublications.js'
import { retainPreviousVisualisation } from '../../app/ts/utils/popupVisualisationLifecycle.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import { MessageToPopup, PopupMessage, type Settings, type UpdateHomePage } from '../../app/ts/types/interceptor-messages.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import type { PendingFetchSimulationStackRequestPromise } from '../../app/ts/types/user-interface-types.js'
import { type CompleteVisualizedSimulation, createPassthroughCompleteVisualizedSimulation } from '../../app/ts/types/visualizer-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { installDomMock } from './domMock.js'

// Enforces the contract documented on subscribeToSimulationStatePublications: a view answering a publication with one of these requests simulates again and, while the home popup or simulation stack page is open, publishes again, so open views keep triggering each other.
const SIMULATING_REQUESTS = new Set(['popup_requestCompleteVisualizedSimulation', 'popup_requestSimulationMetadata'])
const SUBSCRIPTION_MODULE = 'components/simulationStatePublications.ts'
const LIVE_SIMULATION_HOOK_MODULE = 'components/hooks/useLiveSimulationHomeData.ts'

type RuntimeMessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => unknown

function getMessageMethod(message: unknown) {
	if (typeof message !== 'object' || message === null || !('method' in message) || typeof message.method !== 'string') return undefined
	return message.method
}

function installBrowserMock() {
	const listeners: RuntimeMessageListener[] = []
	const sentMessages: unknown[] = []
	const sentMethods: string[] = []
	Object.defineProperty(globalThis, 'browser', {
		configurable: true,
		writable: true,
		value: {
			runtime: {
				lastError: null,
				getManifest: () => ({ manifest_version: 3 }),
				getURL: (path: string) => `chrome-extension://test-extension${ path }`,
				// Records every request and leaves it unanswered, so only what a view sends on its own is observed.
				async sendMessage(message: unknown) {
					sentMessages.push(message)
					const method = getMessageMethod(message)
					if (method !== undefined) sentMethods.push(method)
					return undefined
				},
				onMessage: {
					addListener(listener: RuntimeMessageListener) { listeners.push(listener) },
					removeListener(listener: RuntimeMessageListener) {
						const index = listeners.indexOf(listener)
						if (index >= 0) listeners.splice(index, 1)
					},
				},
			},
		},
	})
	Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })
	return {
		sentMessages,
		sentMethods,
		deliver(message: unknown) {
			for (const listener of [...listeners]) listener(message, {}, () => undefined)
		},
	}
}

async function settle() {
	for (let tick = 0; tick < 5; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const rpcNetwork: RpcNetwork = {
	name: 'Ethereum',
	chainId: 1n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}
const settings: Settings = {
	activeSimulationAddress: 0x4000000000000000000000000000000000000004n,
	activeSigningSafeAddress: undefined,
	activeRpcNetwork: rpcNetwork,
	openedPage: { page: 'Home' },
	useSignersAddressAsActiveAddress: false,
	websiteAccess: [],
	simulationMode: true,
}
const tabId = 7

const freshHomePageUpdate: UpdateHomePage = {
	method: 'popup_UpdateHomePage',
	homeDataSource: 'fresh',
	popupRefreshGeneration: 1,
	data: {
		visualizedSimulatorState: createPassthroughCompleteVisualizedSimulation(1, 'done'),
		activeAddresses: [],
		richList: [],
		makeCurrentAddressRich: false,
		hasSafeTransactionsToExport: false,
		latestUnexpectedError: undefined,
		websiteAccessAddressMetadata: [],
		tabState: {
			tabId,
			website: { websiteOrigin: 'https://tab.example', icon: undefined, title: 'Tab' },
			signerConnected: false,
			signerName: 'NoSigner',
			signerAccounts: [],
			signerAccountError: undefined,
			signerChain: undefined,
			tabIconDetails: { icon: '../img/head-not-active.png', iconReason: 'Test tab' },
			activeSigningAddress: undefined,
		},
		currentBlockNumber: undefined,
		settings,
		rpcConnectionStatus: undefined,
		activeSigningAddressInThisTab: undefined,
		tabId,
		rpcEntries: [rpcNetwork],
		interceptorDisabled: false,
		preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' },
	},
}

const fetchSimulationStackRequest: PendingFetchSimulationStackRequestPromise = {
	website: { websiteOrigin: 'https://requester.example', icon: undefined, title: undefined },
	popupOrTabId: { type: 'popup', id: 41 },
	simulationOverlayEnabled: true,
	simulationStackVersion: '2.0.0',
	uniqueRequestIdentifier: { requestId: 7, requestSocket: { tabId: 3, connectionName: 5n } },
}

const publishedEntry: AddressBookEntry = { type: 'contact', name: 'Published Contact', address: 0x1111111111111111111111111111111111111111n, entrySource: 'User', askForAddressAccess: true, useAsActiveAddress: false }
const finishedState: CompleteVisualizedSimulation = { ...createPassthroughCompleteVisualizedSimulation(3, 'done'), addressBookEntries: [publishedEntry] }
// One refresh cycle as the updater publishes it: invalidated while updating, finished, then a failed refresh that keeps the finished state's entries.
const publishedStates: readonly CompleteVisualizedSimulation[] = [
	retainPreviousVisualisation(freshHomePageUpdate.data.visualizedSimulatorState, { simulationId: 2, simulationUpdatingState: 'updating', simulationResultState: 'invalid' }),
	finishedState,
	retainPreviousVisualisation(finishedState, { simulationId: 4, simulationUpdatingState: 'failed' }),
]

type OpenedView = { readonly text: string, readonly sentMethods: readonly string[] }
type PublicationConsumingView = {
	readonly name: string
	readonly viewModule: string
	readonly subscribingModule: string
	readonly render: () => VNode
	readonly openingMessages: readonly unknown[]
	// Evidence that the view received the publications, so it cannot pass by ignoring them.
	readonly receivedPublications: (view: OpenedView) => boolean
}

// Every view that receives popup_simulation_state_changed. The scans below fail until a newly subscribing view is added here and checked like the others.
const PUBLICATION_CONSUMING_VIEWS: readonly PublicationConsumingView[] = [
	{
		name: 'home popup',
		viewModule: 'components/App.tsx',
		subscribingModule: LIVE_SIMULATION_HOOK_MODULE,
		render: () => h(App, {}),
		openingMessages: [serialize(MessageToPopup, { role: 'all', ...freshHomePageUpdate })],
		receivedPublications: ({ sentMethods }) => sentMethods.includes('popup_requestNewHomeData'),
	},
	{
		name: 'simulation stack page',
		viewModule: 'components/pages/SimulationStackPage.tsx',
		subscribingModule: LIVE_SIMULATION_HOOK_MODULE,
		render: () => h(SimulationStackPage, {}),
		openingMessages: [serialize(MessageToPopup, { role: 'all', ...freshHomePageUpdate })],
		receivedPublications: ({ sentMethods }) => sentMethods.includes('popup_requestNewHomeData'),
	},
	{
		name: 'fetch simulation stack page',
		viewModule: 'components/pages/FetchSimulationStack.tsx',
		subscribingModule: 'components/pages/FetchSimulationStack.tsx',
		render: () => h(FetchSimulationStack, {}),
		openingMessages: [serialize(MessageToPopup, { role: 'all', method: 'popup_fetchSimulationStackRequest', data: fetchSimulationStackRequest })],
		receivedPublications: ({ text }) => text.includes('Published Contact'),
	},
]

const appSourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
const appSources = new Map<string, string>()
for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: appSourceDirectory })) appSources.set(file.replaceAll('\\', '/'), await Bun.file(`${ appSourceDirectory }${ file }`).text())

function getModulesMatching(pattern: RegExp, isScanned: (module: string) => boolean = () => true) {
	return Array.from(appSources).filter(([module, source]) => isScanned(module) && pattern.test(source)).map(([module]) => module).toSorted()
}

const getUniqueSorted = (values: readonly string[]) => Array.from(new Set(values)).toSorted()

describe('simulation state publication consumers', () => {
	test('popup code handles the publication only through the shared subscription', () => {
		const isPopupCode = (module: string) => !module.startsWith('background/') && !module.startsWith('types/')
		assert.deepEqual(getModulesMatching(/popup_simulation_state_changed/u, isPopupCode), [SUBSCRIPTION_MODULE])
	})

	test('every module that subscribes is covered by the view checks', () => {
		const subscribingModules = getModulesMatching(/(?<!function )\bsubscribeToSimulationStatePublications\(/u)
		assert.deepEqual(subscribingModules, getUniqueSorted(PUBLICATION_CONSUMING_VIEWS.map((view) => view.subscribingModule)), 'Add the view that receives publications through the new subscription to PUBLICATION_CONSUMING_VIEWS')
	})

	test('every view that uses the live simulation hook is covered by the view checks', () => {
		const liveSimulationViews = PUBLICATION_CONSUMING_VIEWS.filter((view) => view.subscribingModule === LIVE_SIMULATION_HOOK_MODULE).map((view) => view.viewModule)
		assert.deepEqual(getModulesMatching(/(?<!function )\buseLiveSimulationHomeData\(/u), getUniqueSorted(liveSimulationViews), 'Add the view that uses useLiveSimulationHomeData to PUBLICATION_CONSUMING_VIEWS')
	})

	test('an error thrown while a view handles a publication is reported as a popup listener failure', async () => {
		const browserMock = installBrowserMock()
		const unsubscribe = subscribeToSimulationStatePublications(() => { throw new Error('publication handler failed') })
		try {
			browserMock.deliver(serialize(MessageToPopup, { role: 'all', method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: finishedState } }))
			await settle()
			const reportedErrors = browserMock.sentMessages.flatMap((message) => {
				const parsed = PopupMessage.safeParse(message)
				return parsed.success && parsed.value.method === 'popup_UnexpectedErrorOccured' ? [parsed.value.data] : []
			})
			assert.deepEqual(reportedErrors.map(({ code, message, source }) => ({ code, message, source })), [{ code: 'popup_message_listener_failed', message: 'publication handler failed', source: 'popup' }])
		} finally {
			unsubscribe()
		}
	})

	for (const view of PUBLICATION_CONSUMING_VIEWS) test(`the ${ view.name } renders publications without requesting another simulation`, async () => {
		const dom = installDomMock()
		const browserMock = installBrowserMock()
		try {
			await act(() => { render(view.render(), dom.document.body) })
			for (const message of view.openingMessages) await act(() => { browserMock.deliver(message) })
			await settle()
			browserMock.sentMethods.splice(0)
			for (const visualizedSimulatorState of publishedStates) {
				await act(() => { browserMock.deliver(serialize(MessageToPopup, { role: 'all', method: 'popup_simulation_state_changed', data: { visualizedSimulatorState } })) })
				await settle()
			}
			assert.deepEqual(browserMock.sentMethods.filter((method) => SIMULATING_REQUESTS.has(method)), [])
			assert.ok(view.receivedPublications({ text: dom.document.body.textContent, sentMethods: browserMock.sentMethods }))
		} finally {
			await act(() => { render(null, dom.document.body) })
			dom.restore()
		}
	})
})
