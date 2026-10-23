import { InterceptorMessageToInpage } from '../../app/ts/types/interceptor-messages.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { ProviderMessage } from '../../app/ts/utils/requests.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { clearSignerExecutionAuthorityForTab, getSignerDocumentGeneration, reconcileSignerExecutionDocument, registerAuthoritativeTopSocket } from '../../app/ts/background/signerExecutionAuthority.js'

function populateDocumentConnections(collection: WebsiteTabConnections): WebsiteTabConnections {
	for (const [tabId, tab] of collection) connections.set(tabId, tab)
	return connections
}

const defineGlobal = (name: PropertyKey, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
let connections: WebsiteTabConnections = new Map()
let DOCUMENT_GENERATION = '11111111-1111-4111-8111-111111111111'
const NEXT_DOCUMENT_GENERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function installBrowserMock(beforeStorageGet?: (keys: unknown) => Promise<void>) {
	connections = new Map()
	clearSignerExecutionAuthorityForTab(connections, 7)
	registerAuthoritativeTopSocket(connections, { tabId: 7, connectionName: 1n }, 'app.example')
	const generation = getSignerDocumentGeneration(connections, { tabId: 7, connectionName: 1n }, 'app.example')
	if (generation === undefined) throw new Error('Missing background document generation')
	DOCUMENT_GENERATION = generation
	reconcileSignerExecutionDocument(connections, { tabId: 7, connectionName: 1n }, 'app.example', DOCUMENT_GENERATION, true, 0)
	const storageState: Record<string, unknown> = {}
	const popupMessages: unknown[] = []
	defineGlobal('browser', {
		tabs: { sendMessage: async (_tabId: number, message: { method: string }) => message.method === 'interceptor_signer_document_probe' ? { origin: 'https://app.example' } : false },
		runtime: {
			lastError: undefined,
			async sendMessage(message: unknown) {
				popupMessages.push(message)
			},
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					await beforeStorageGet?.(keys)
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
	})
	return { storageState, popupMessages }
}

const provider = {
	uuid: '22222222-2222-4222-8222-222222222222',
	name: 'Second Wallet',
	icon: 'data:image/svg+xml,<svg/>',
	rdns: 'com.example.second',
} as const

function createProviderMessage(method: string, params: readonly unknown[], tabId = 7): ProviderMessage {
	return {
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		method,
		params,
		uniqueRequestIdentifier: {
			requestId: 1,
			requestSocket: { tabId, connectionName: 1n },
		},
	}
}

describe('EIP-6963 signer provider selection', () => {
	test('settles child catalogs for an unavailable preference while retrying an undecided top catalog', async () => {
		installBrowserMock()
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { setSignerPreference } = await import('../../app/ts/background/storageVariables.js')
		const { registerCurrentChildSignerSocket, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const child = { tabId: 7, connectionName: 2n }
		registerCurrentChildSignerSocket(connections, child, 2)
		const childCatalog = { ...createProviderMessage('signer_providers_changed', [[], false]), uniqueRequestIdentifier: { requestId: 2, requestSocket: child } }
		assert.equal((await signerProvidersChanged(connections, childCatalog, 'app.example', false, 2)).signerFrameIneligible, undefined, 'A top catalog that has not decided yet remains retryable')
		await setSignerPreference('app.example', provider.rdns)
		await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[], false]), 'app.example', true)
		assert.equal((await signerProvidersChanged(connections, childCatalog, 'app.example', false, 2)).signerFrameIneligible, true, 'An unavailable preference must not hold public child-frame requests indefinitely')
		assert.equal(socketCanExecuteWithSelectedSigner(connections, child), false)
	})

	test('background-issued document identity cannot be replaced by a catalog caller', async () => {
		installBrowserMock()
		const top = { tabId: 7, connectionName: 1n }
		const generation = getSignerDocumentGeneration(connections, top, 'app.example')
		assert.ok(generation)
		assert.notEqual(generation, NEXT_DOCUMENT_GENERATION)
		assert.equal(reconcileSignerExecutionDocument(connections, top, 'app.example', NEXT_DOCUMENT_GENERATION, true, 0), true)
		assert.equal(getSignerDocumentGeneration(connections, top, 'app.example'), generation)
		const child = { tabId: 7, connectionName: 2n }
		const { registerCurrentChildSignerSocket } = await import('../../app/ts/background/signerExecutionAuthority.js')
		registerCurrentChildSignerSocket(connections, child, 2)
		assert.equal(reconcileSignerExecutionDocument(connections, child, 'app.example', NEXT_DOCUMENT_GENERATION, false, 2), false)
		assert.equal(reconcileSignerExecutionDocument(connections, child, 'app.example', generation, false, 2), true)
	})

	test('releases a selection lease when persistence fails before its token reaches the caller', async () => {
		let failReads = true
		installBrowserMock(async () => { if (failReads) throw new Error('Signer storage unavailable') })
		const { beginSignerProviderSelection, finishSignerProviderSelection } = await import('../../app/ts/background/signerProviderSelection.js')
		const request = createProviderMessage('begin_signer_provider_selection', [provider.uuid])
		await assert.rejects(beginSignerProviderSelection(connections, request, 'app.example', true, 0), /Signer storage unavailable/)
		failReads = false
		const token = await beginSignerProviderSelection(connections, request, 'app.example', true, 0)
		if (token === undefined) throw new Error('The failed selection retained its lease')
		finishSignerProviderSelection(connections, createProviderMessage('finish_signer_provider_selection', [token]))
	})

	test('keeps active signer execution targets isolated per tab while sharing the site preference', async () => {
		installBrowserMock()
		const secondProvider = {
			...provider,
			uuid: '33333333-3333-4333-8333-333333333333',
			name: 'Third Wallet',
			rdns: 'com.example.third',
		}
		const secondTabSocket = { tabId: 8, connectionName: 1n }
		const {
			authorizeSocketForSignerExecution,
			clearSignerExecutionAuthorityForTab,
			getSignerExecutionTargetForOrigin,
			registerAuthoritativeTopSocket,
			setSignerExecutionTarget,
			socketCanExecuteWithSelectedSigner,
		} = await import('../../app/ts/background/signerExecutionAuthority.js')
		const { getSignerPreference, setSignerPreference } = await import('../../app/ts/background/storageVariables.js')
		registerAuthoritativeTopSocket(connections, secondTabSocket, 'app.example')
		reconcileSignerExecutionDocument(connections, secondTabSocket, 'app.example', NEXT_DOCUMENT_GENERATION, true, 0)

		try {
			assert.equal(setSignerExecutionTarget(connections, 7, provider.uuid, 'app.example'), true)
			assert.equal(setSignerExecutionTarget(connections, 8, secondProvider.uuid, 'app.example'), true)
			assert.equal(authorizeSocketForSignerExecution(connections, { tabId: 7, connectionName: 1n }, provider.uuid, 'app.example'), true)
			assert.equal(authorizeSocketForSignerExecution(connections, secondTabSocket, secondProvider.uuid, 'app.example'), true)

			await setSignerPreference('app.example', secondProvider.rdns)

			assert.equal(getSignerExecutionTargetForOrigin(connections, 7, 'app.example'), provider.uuid)
			assert.equal(getSignerExecutionTargetForOrigin(connections, 8, 'app.example'), secondProvider.uuid)
			assert.equal(socketCanExecuteWithSelectedSigner(connections, { tabId: 7, connectionName: 1n }), true)
			assert.equal(socketCanExecuteWithSelectedSigner(connections, secondTabSocket), true)
			assert.equal((await getSignerPreference('app.example'))?.rdns, secondProvider.rdns)
		} finally {
			clearSignerExecutionAuthorityForTab(connections, 8)
		}
	})

	test('returns the per-origin preference and publishes only top-frame provider metadata', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: provider.rdns }]
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getTabState } = await import('../../app/ts/background/storageVariables.js')

		const result = await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[provider], false]), 'app.example', true)
		const tabState = await getTabState(7)

		assert.deepEqual(result, { preferredSignerRdns: provider.rdns, automaticSelectionAllowed: false, signerSelectionChangeAllowed: true, legacySignerAllowed: false })
		assert.deepEqual(tabState.availableSignerProviders, [provider])
		assert.equal(tabState.preferredSignerUnavailable, true)
	})

	test('requires an explicit selection for a new document even when all remembered provider metadata matches', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: provider.rdns }]
		const { signerProvidersChanged, signerProviderSelected } = await import('../../app/ts/background/signerProviderSelection.js')
		const { socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const { updateTabState } = await import('../../app/ts/background/storageVariables.js')
		await updateTabState(7, (state) => ({ ...state, website: { websiteOrigin: 'app.example', title: undefined, icon: undefined } }))
		const catalogRequest = createProviderMessage('signer_providers_changed', [[provider], false])
		const rememberedSelection = createProviderMessage('signer_provider_selected', [provider, 'remembered'])
		const explicitSelection = createProviderMessage('signer_provider_selected', [provider, 'explicit'])

		assert.equal((await signerProvidersChanged(connections, catalogRequest, 'app.example', true)).automaticSelectionAllowed, false)
		await assert.rejects(signerProviderSelected(rememberedSelection, 'app.example', true, 0, populateDocumentConnections(new Map())), /remembered RDNS cannot authorize/)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, catalogRequest.uniqueRequestIdentifier.requestSocket), false)
		await signerProviderSelected(explicitSelection, 'app.example', true, 0, populateDocumentConnections(new Map()))
		assert.equal(socketCanExecuteWithSelectedSigner(connections, catalogRequest.uniqueRequestIdentifier.requestSocket), true)

		// Worker restart preserves the content script's connection identity, independently of page-supplied RDNS and generation metadata.
		clearSignerExecutionAuthorityForTab(connections, 7)
		registerAuthoritativeTopSocket(connections, catalogRequest.uniqueRequestIdentifier.requestSocket, 'app.example')
		await signerProvidersChanged(connections, catalogRequest, 'app.example', true)
		await signerProviderSelected(rememberedSelection, 'app.example', true, 0, populateDocumentConnections(new Map()))
		assert.equal(socketCanExecuteWithSelectedSigner(connections, catalogRequest.uniqueRequestIdentifier.requestSocket), true)

		const newSocket = { tabId: 7, connectionName: 9n }
		registerAuthoritativeTopSocket(connections, newSocket, 'app.example')
		await signerProvidersChanged(connections, { ...catalogRequest, uniqueRequestIdentifier: { requestId: 2, requestSocket: newSocket } }, 'app.example', true)
		await assert.rejects(signerProviderSelected({ ...rememberedSelection, uniqueRequestIdentifier: { requestId: 3, requestSocket: newSocket } }, 'app.example', true, 0, populateDocumentConnections(new Map())), /remembered RDNS cannot authorize/)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, newSocket), false)
	})

	test('settles a same-origin child catalog that lacks the selected provider without granting authority', async () => {
		installBrowserMock()
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { registerCurrentChildSignerSocket, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		setSignerExecutionTarget(connections, 7, provider.uuid, 'app.example')
		const childSocket = { tabId: 7, connectionName: 2n }
		registerCurrentChildSignerSocket(connections, childSocket, 2)
		const request = { ...createProviderMessage('signer_providers_changed', [[], false]), uniqueRequestIdentifier: { requestId: 2, requestSocket: childSocket } }
		const result = await signerProvidersChanged(connections, request, 'app.example', false, 2)
		const delivered = InterceptorMessageToInpage.parse(serialize(InterceptorMessageToInpage, { interceptorApproved: true, requestId: 2, type: 'result', method: 'signer_providers_changed', result }))
		if (delivered.method !== 'signer_providers_changed' || !('result' in delivered) || !isRecord(delivered.result)) throw new Error('Missing serialized catalog result')
		assert.equal(delivered.result.signerFrameIneligible, true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, childSocket), false)
	})

	test('does not publish catalog state from a frame without verified top-frame identity', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: provider.rdns }]
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getTabState } = await import('../../app/ts/background/storageVariables.js')

		const result = await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[provider], false]), 'app.example', false)
		const tabState = await getTabState(7)

		assert.deepEqual(result, { preferredSignerRdns: undefined, automaticSelectionAllowed: false, signerSelectionChangeAllowed: false, legacySignerAllowed: false, signerFrameIneligible: true })
		assert.deepEqual(tabState.availableSignerProviders, [])
		assert.equal(tabState.selectedSignerProvider, undefined)
	})

	test('marks a cross-origin child definitively ineligible without authorizing signer execution', async () => {
		installBrowserMock()
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const request = createProviderMessage('signer_providers_changed', [[provider], false])
		const result = await signerProvidersChanged(connections, request, 'frame.example', false, 2)
		const delivered = InterceptorMessageToInpage.parse(serialize(InterceptorMessageToInpage, { interceptorApproved: true, requestId: request.uniqueRequestIdentifier.requestId, type: 'result', method: 'signer_providers_changed', result }))
		if (delivered.method !== 'signer_providers_changed' || !('result' in delivered) || !isRecord(delivered.result)) throw new Error('Missing serialized provider catalog reply')
		assert.equal(delivered.result.signerFrameIneligible, true)
		assert.equal(result.signerFrameIneligible, true)
		assert.equal(result.signerSelectionChangeAllowed, false)
		assert.equal(result.legacySignerAllowed, false)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, request.uniqueRequestIdentifier.requestSocket), false)
	})

	test('fails closed when a remembered RDNS matches more than one announced provider', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: provider.rdns }]
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getTabState, updateTabState } = await import('../../app/ts/background/storageVariables.js')
		await updateTabState(7, (previousState) => ({
			...previousState,
			signerName: 'EIP6963',
			signerAccounts: [1n],
			activeSigningAddress: 1n,
			selectedSignerProvider: provider,
		}))
		const duplicateWalletInstance = { ...provider, uuid: '33333333-3333-4333-8333-333333333333' }

		await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[provider, duplicateWalletInstance], false]), 'app.example', true)
		const tabState = await getTabState(7)

		assert.equal(tabState.preferredSignerUnavailable, true)
		assert.equal(tabState.selectedSignerProvider, undefined)
		assert.equal(tabState.signerName, 'NoSigner')
		assert.deepEqual(tabState.signerAccounts, [])
		assert.equal(tabState.activeSigningAddress, undefined)
	})

	test('blocks legacy forwarding when an empty catalog cannot satisfy the remembered preference', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: provider.rdns }]
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')

		const result = await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[], false]), 'app.example', true)

		assert.deepEqual(result, { preferredSignerRdns: provider.rdns, automaticSelectionAllowed: false, signerSelectionChangeAllowed: true, legacySignerAllowed: false })
		assert.equal(socketCanExecuteWithSelectedSigner(connections, { tabId: 7, connectionName: 1n }), false)
	})

	test('treats RDNS identity as case-insensitive when restoring and detecting ambiguity', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: 'COM.Example.Second' }]
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getSignerPreference, getTabState } = await import('../../app/ts/background/storageVariables.js')
		const differentlyCapitalizedProvider = { ...provider, rdns: 'Com.Example.Second' }
		const duplicateWalletInstance = { ...provider, uuid: '33333333-3333-4333-8333-333333333333' }

		const restored = await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[differentlyCapitalizedProvider], false]), 'app.example', true)
		assert.deepEqual(restored, { preferredSignerRdns: provider.rdns, automaticSelectionAllowed: false, signerSelectionChangeAllowed: true, legacySignerAllowed: false })
		assert.equal((await getTabState(7)).availableSignerProviders?.[0]?.rdns, provider.rdns)
		assert.equal((await getSignerPreference('app.example'))?.rdns, provider.rdns)

		await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[differentlyCapitalizedProvider, duplicateWalletInstance], false]), 'app.example', true)
		assert.equal((await getTabState(7)).preferredSignerUnavailable, true)
	})

	test('disables remembered restoration when the provider catalog overflows', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: provider.rdns }]
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getTabState, updateTabState } = await import('../../app/ts/background/storageVariables.js')
		await updateTabState(7, (previousState) => ({
			...previousState,
			signerName: 'EIP6963',
			signerAccounts: [1n],
			selectedSignerProvider: provider,
		}))

		const result = await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[provider], true]), 'app.example', true)
		const tabState = await getTabState(7)

		assert.deepEqual(result, { preferredSignerRdns: provider.rdns, automaticSelectionAllowed: false, signerSelectionChangeAllowed: true, legacySignerAllowed: false })
		assert.equal(tabState.selectedSignerProvider, undefined)
		assert.equal(tabState.preferredSignerUnavailable, true)
		assert.equal(tabState.signerName, 'NoSigner')
	})

	test('defers remembered catalog changes while this tab has a persisted chain confirmation', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: provider.rdns }]
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getTabState, updateTabState } = await import('../../app/ts/background/storageVariables.js')
		const { defaultRpcs } = await import('../../app/ts/background/settings.js')
		await updateTabState(7, (previousState) => ({
			...previousState,
			signerName: 'EIP6963',
			signerAccounts: [1n],
			selectedSignerProvider: provider,
		}))
		storageState.chainChangeConfirmationPromise = {
			website: { websiteOrigin: 'app.example', icon: undefined, title: 'Example' },
			popupOrTabId: { type: 'popup', id: 99 },
			request: {
				...createProviderMessage('wallet_switchEthereumChain', [{ chainId: '0x1' }]),
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 7, connectionName: '0x1' } },
			},
			rpcNetwork: { ...defaultRpcs[0], chainId: '0x1' },
			simulationMode: false,
		}
		const duplicateWalletInstance = { ...provider, uuid: '33333333-3333-4333-8333-333333333333' }

		const deferred = await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[provider, duplicateWalletInstance], false]), 'app.example', true)
		const deferredTabState = await getTabState(7)
		assert.deepEqual(deferred, { preferredSignerRdns: provider.rdns, automaticSelectionAllowed: false, signerSelectionChangeAllowed: false, legacySignerAllowed: false })
		assert.deepEqual(deferredTabState.selectedSignerProvider, provider)
		assert.equal(deferredTabState.signerName, 'EIP6963')

		delete storageState.chainChangeConfirmationPromise
		const allowed = await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[provider, duplicateWalletInstance], false]), 'app.example', true)
		assert.equal(allowed.signerSelectionChangeAllowed, true)
		assert.equal((await getTabState(7)).selectedSignerProvider, undefined)
	})

	test('keeps a new document blocked while no-preference catalog reconciliation waits for pending work', async () => {
		const { storageState } = installBrowserMock()
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const { defaultRpcs } = await import('../../app/ts/background/settings.js')
		storageState.chainChangeConfirmationPromise = {
			website: { websiteOrigin: 'app.example', icon: undefined, title: 'Example' },
			popupOrTabId: { type: 'popup', id: 99 },
			request: {
				...createProviderMessage('wallet_switchEthereumChain', [{ chainId: '0x1' }]),
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 7, connectionName: '0x1' } },
			},
			rpcNetwork: { ...defaultRpcs[0], chainId: '0x1' },
			simulationMode: false,
		}

		const deferred = await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[], false]), 'app.example', true)
		assert.deepEqual(deferred, { preferredSignerRdns: undefined, automaticSelectionAllowed: false, signerSelectionChangeAllowed: false, legacySignerAllowed: false })
		assert.equal(socketCanExecuteWithSelectedSigner(connections, { tabId: 7, connectionName: 1n }), false)

		delete storageState.chainChangeConfirmationPromise
		const allowed = await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[], false]), 'app.example', true)
		assert.deepEqual(allowed, { preferredSignerRdns: undefined, automaticSelectionAllowed: false, signerSelectionChangeAllowed: true, legacySignerAllowed: true })
		assert.equal(socketCanExecuteWithSelectedSigner(connections, { tabId: 7, connectionName: 1n }), true)
	})

	test('keeps superseded document sockets blocked after the new document enables legacy signing', async () => {
		installBrowserMock()
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { registerAuthoritativeTopSocket, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const oldTopSocket = { tabId: 7, connectionName: 1n }
		const oldChildSocket = { tabId: 7, connectionName: 2n }
		const newTopSocket = { tabId: 7, connectionName: 3n }
		const newChildSocket = { tabId: 7, connectionName: 4n }

		await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[], false]), 'app.example', true)
		const oldChildCatalog = {
			...createProviderMessage('signer_providers_changed', [[], false]),
			uniqueRequestIdentifier: { requestId: 2, requestSocket: oldChildSocket },
		}
		const { registerCurrentChildSignerSocket } = await import('../../app/ts/background/signerExecutionAuthority.js')
		registerCurrentChildSignerSocket(connections, oldChildSocket, 2)
		await signerProvidersChanged(connections, oldChildCatalog, 'app.example', false, 2)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, oldTopSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, oldChildSocket), true)

		registerAuthoritativeTopSocket(connections, newTopSocket, 'app.example')
		const newTopCatalog = {
			...createProviderMessage('signer_providers_changed', [[], false]),
			uniqueRequestIdentifier: { requestId: 3, requestSocket: newTopSocket },
		}
		const newChildCatalog = {
			...createProviderMessage('signer_providers_changed', [[], false]),
			uniqueRequestIdentifier: { requestId: 4, requestSocket: newChildSocket },
		}
		await signerProvidersChanged(connections, newTopCatalog, 'app.example', true)
		registerCurrentChildSignerSocket(connections, newChildSocket, 2)
		await signerProvidersChanged(connections, newChildCatalog, 'app.example', false, 2)
		await signerProvidersChanged(connections, newTopCatalog, 'app.example', true)

		assert.equal(socketCanExecuteWithSelectedSigner(connections, oldTopSocket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, oldChildSocket), false)
		assert.equal((await signerProvidersChanged(connections, oldChildCatalog, 'app.example', false, 2)).legacySignerAllowed, false)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, newTopSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, newChildSocket), true)
	})

	test('preserves legacy and exact-provider authority across same-document port reconnects', async () => {
		installBrowserMock()
		const { allowLegacySignerExecution, authorizeSocketForLegacySignerExecution, authorizeSocketForSignerExecution, registerAuthoritativeTopSocket, registerCurrentChildSignerSocket, scheduleCurrentChildSignerSocketRemoval, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const topSocket = { tabId: 7, connectionName: 1n }
		const childSocket = { tabId: 7, connectionName: 2n }
		registerCurrentChildSignerSocket(connections, childSocket, 2)
		reconcileSignerExecutionDocument(connections, childSocket, 'app.example', DOCUMENT_GENERATION, false, 2)
		assert.equal(allowLegacySignerExecution(connections, topSocket, 'app.example'), true)
		assert.equal(authorizeSocketForLegacySignerExecution(connections, childSocket, 'app.example'), true)

		assert.equal(registerAuthoritativeTopSocket(connections, topSocket, 'app.example'), false)
		assert.equal(scheduleCurrentChildSignerSocketRemoval(connections, childSocket), true)
		assert.equal(registerCurrentChildSignerSocket(connections, childSocket, 2), false)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, topSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, childSocket), true)

		assert.equal(setSignerExecutionTarget(connections, 7, provider.uuid, 'app.example'), true)
		assert.equal(authorizeSocketForSignerExecution(connections, topSocket, provider.uuid, 'app.example'), true)
		assert.equal(authorizeSocketForSignerExecution(connections, childSocket, provider.uuid, 'app.example'), true)
		assert.equal(registerAuthoritativeTopSocket(connections, topSocket, 'app.example'), false)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, topSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, childSocket), true)
	})

	test('revokes the previous child document when the same frame connects with a new socket', async () => {
		installBrowserMock()
		const { allowLegacySignerExecution, authorizeSocketForLegacySignerExecution, authorizeSocketForSignerExecution, registerCurrentChildSignerSocket, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner, unregisterCurrentChildSignerSocket } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const topSocket = { tabId: 7, connectionName: 1n }
		const oldChildSocket = { tabId: 7, connectionName: 2n }
		const replacementChildSocket = { tabId: 7, connectionName: 3n }
		registerCurrentChildSignerSocket(connections, oldChildSocket, 2)
		assert.equal(reconcileSignerExecutionDocument(connections, oldChildSocket, 'app.example', DOCUMENT_GENERATION, false, 2), true)
		assert.equal(allowLegacySignerExecution(connections, topSocket, 'app.example'), true)
		assert.equal(authorizeSocketForLegacySignerExecution(connections, oldChildSocket, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, oldChildSocket), true)

		assert.equal(registerCurrentChildSignerSocket(connections, replacementChildSocket, 2), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, oldChildSocket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, replacementChildSocket), false)
		assert.equal(reconcileSignerExecutionDocument(connections, replacementChildSocket, 'app.example', DOCUMENT_GENERATION, false, 2), true)
		assert.equal(authorizeSocketForLegacySignerExecution(connections, replacementChildSocket, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, replacementChildSocket), true)
		assert.equal(unregisterCurrentChildSignerSocket(connections, oldChildSocket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, replacementChildSocket), true)
		assert.equal(unregisterCurrentChildSignerSocket(connections, replacementChildSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, replacementChildSocket), false)
		assert.equal(registerCurrentChildSignerSocket(connections, replacementChildSocket, 2), true)
		assert.equal(reconcileSignerExecutionDocument(connections, replacementChildSocket, 'app.example', DOCUMENT_GENERATION, false, 2), true)
		assert.equal(authorizeSocketForLegacySignerExecution(connections, replacementChildSocket, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, replacementChildSocket), true)

		assert.equal(setSignerExecutionTarget(connections, 7, provider.uuid, 'app.example'), true)
		assert.equal(authorizeSocketForSignerExecution(connections, replacementChildSocket, provider.uuid, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, replacementChildSocket), true)
		assert.equal(registerCurrentChildSignerSocket(connections, oldChildSocket, 2), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, replacementChildSocket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, oldChildSocket), false)
		assert.equal(reconcileSignerExecutionDocument(connections, oldChildSocket, 'app.example', DOCUMENT_GENERATION, false, 2), true)
		assert.equal(authorizeSocketForSignerExecution(connections, oldChildSocket, provider.uuid, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, oldChildSocket), true)
	})

	test('admits a child that connects before its new top only after their document generation matches', async () => {
		installBrowserMock()
		const { allowLegacySignerExecution, authorizeSocketForLegacySignerExecution, registerAuthoritativeTopSocket, registerCurrentChildSignerSocket, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const oldTopSocket = { tabId: 7, connectionName: 1n }
		const newChildSocket = { tabId: 7, connectionName: 2n }
		const newTopSocket = { tabId: 7, connectionName: 3n }
		registerCurrentChildSignerSocket(connections, newChildSocket, 2)
		assert.equal(reconcileSignerExecutionDocument(connections, newChildSocket, 'app.example', NEXT_DOCUMENT_GENERATION, false, 2), false)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, newChildSocket), false)

		assert.equal(registerAuthoritativeTopSocket(connections, newTopSocket, 'app.example'), true)
		assert.equal(reconcileSignerExecutionDocument(connections, newTopSocket, 'app.example', NEXT_DOCUMENT_GENERATION, true, 0), true)
		assert.equal(reconcileSignerExecutionDocument(connections, newChildSocket, 'app.example', getSignerDocumentGeneration(connections, newTopSocket, 'app.example'), false, 2), true)
		assert.equal(allowLegacySignerExecution(connections, newTopSocket, 'app.example'), true)
		assert.equal(authorizeSocketForLegacySignerExecution(connections, newChildSocket, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, oldTopSocket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, newTopSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, newChildSocket), true)
	})

	test('keeps a restored bfcache document blocked until it republishes its catalog generation', async () => {
		installBrowserMock()
		const { allowLegacySignerExecution, registerAuthoritativeTopSocket, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const restoredSocket = { tabId: 7, connectionName: 1n }
		const interveningSocket = { tabId: 7, connectionName: 2n }
		assert.equal(allowLegacySignerExecution(connections, restoredSocket, 'app.example'), true)
		assert.equal(registerAuthoritativeTopSocket(connections, interveningSocket, 'app.example'), true)
		assert.equal(reconcileSignerExecutionDocument(connections, interveningSocket, 'app.example', NEXT_DOCUMENT_GENERATION, true, 0), true)
		assert.equal(allowLegacySignerExecution(connections, interveningSocket, 'app.example'), true)

		assert.equal(registerAuthoritativeTopSocket(connections, restoredSocket, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, restoredSocket), false)
		assert.equal(allowLegacySignerExecution(connections, restoredSocket, 'app.example'), false)
		assert.equal(reconcileSignerExecutionDocument(connections, restoredSocket, 'app.example', DOCUMENT_GENERATION, true, 0), true)
		assert.equal(allowLegacySignerExecution(connections, restoredSocket, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, restoredSocket), true)
	})

	test('persists a confirmed selection and clears stale signer account state', async () => {
		const { storageState } = installBrowserMock()
		const { signerProviderSelected } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getSignerPreference, getTabState, updateTabState } = await import('../../app/ts/background/storageVariables.js')
		await updateTabState(7, (previousState) => ({
			...previousState,
			signerAccounts: [1n],
			activeSigningAddress: 1n,
			signerChain: 1n,
			availableSignerProviders: [provider],
		}))

		await signerProviderSelected(createProviderMessage('signer_provider_selected', [provider, 'explicit']), 'app.example', true, 0, populateDocumentConnections(new Map()))
		const tabState = await getTabState(7)

		assert.deepEqual(await getSignerPreference('app.example'), { websiteOrigin: 'app.example', rdns: provider.rdns })
		assert.equal(tabState.signerName, 'EIP6963')
		assert.deepEqual(tabState.signerAccounts, [])
		assert.equal(tabState.activeSigningAddress, undefined)
		assert.equal(tabState.signerChain, undefined)
		assert.deepEqual(tabState.selectedSignerProvider, provider)
		assert.equal(tabState.explicitlySelectedSignerProviderUuid, provider.uuid)
		assert.deepEqual(storageState.signerPreferences, [{ websiteOrigin: 'app.example', rdns: provider.rdns }])
	})

	test('keeps an explicit session UUID selected when its RDNS is ambiguous', async () => {
		installBrowserMock()
		const { signerProviderSelected, signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getTabState, updateTabState } = await import('../../app/ts/background/storageVariables.js')
		const duplicateWalletInstance = { ...provider, uuid: '33333333-3333-4333-8333-333333333333' }
		const unrelatedProvider = { ...provider, uuid: '44444444-4444-4444-8444-444444444444', name: 'Unrelated Wallet', rdns: 'org.example.unrelated' }
		await updateTabState(7, (previousState) => ({ ...previousState, website: { websiteOrigin: 'app.example', title: undefined, icon: undefined }, availableSignerProviders: [provider, duplicateWalletInstance] }))
		await signerProviderSelected(createProviderMessage('signer_provider_selected', [provider, 'explicit']), 'app.example', true, 0, populateDocumentConnections(new Map()))

		await signerProvidersChanged(connections, createProviderMessage('signer_providers_changed', [[provider, duplicateWalletInstance, unrelatedProvider], false]), 'app.example', true)
		const tabState = await getTabState(7)

		assert.equal(tabState.preferredSignerUnavailable, false)
		assert.deepEqual(tabState.selectedSignerProvider, provider)
		assert.equal(tabState.explicitlySelectedSignerProviderUuid, provider.uuid)
	})

	test('rejects selection to a socket without frameId even if it previously held top authority', async () => {
		installBrowserMock()
		const { selectSignerProvider } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getSignerExecutionTargetForOrigin, registerAuthoritativeTopSocket, setSignerExecutionTarget } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const { updateTabState } = await import('../../app/ts/background/storageVariables.js')
		const oldProviderUuid = '55555555-5555-4555-8555-555555555555'
		await updateTabState(7, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'app.example', icon: undefined, title: 'Example' },
			availableSignerProviders: [provider],
		}))
		const topFrameMessages: unknown[] = []
		const childFrameMessages: unknown[] = []
		const otherSiteMessages: unknown[] = []
		const websiteTabConnections: WebsiteTabConnections = populateDocumentConnections(new Map([[7, { connections: {
			'7-0x1': { port: { postMessage: (message: unknown) => topFrameMessages.push(message) }, socket: { tabId: 7, connectionName: 1n }, websiteOrigin: 'app.example', approved: true, wantsToConnect: true },
			'7-0x2': { port: { postMessage: (message: unknown) => childFrameMessages.push(message) }, socket: { tabId: 7, connectionName: 2n }, websiteOrigin: 'app.example', frameId: 2, approved: true, wantsToConnect: true },
			'7-0x3': { port: { postMessage: (message: unknown) => otherSiteMessages.push(message) }, socket: { tabId: 7, connectionName: 3n }, websiteOrigin: 'frame.example', frameId: 3, approved: true, wantsToConnect: true },
		} }]]))
		registerAuthoritativeTopSocket(websiteTabConnections, { tabId: 7, connectionName: 1n }, 'app.example')
		assert.equal(setSignerExecutionTarget(websiteTabConnections, 7, oldProviderUuid, 'app.example'), true)

		await assert.rejects(selectSignerProvider(websiteTabConnections, { method: 'popup_selectSignerProvider', data: { tabId: 7, websiteOrigin: 'app.example', uuid: provider.uuid } }), /top-frame connection/)
		assert.deepEqual(topFrameMessages, [])
		assert.deepEqual(childFrameMessages, [])
		assert.deepEqual(otherSiteMessages, [])
		assert.equal(getSignerExecutionTargetForOrigin(websiteTabConnections, 7, 'app.example'), oldProviderUuid)
	})

	test('rejects selection when no positively identified top-frame connection exists', async () => {
		installBrowserMock()
		const { selectSignerProvider } = await import('../../app/ts/background/signerProviderSelection.js')
		const { registerAuthoritativeTopSocket } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const { updateTabState } = await import('../../app/ts/background/storageVariables.js')
		await updateTabState(7, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'app.example', icon: undefined, title: 'Example' },
			availableSignerProviders: [provider],
		}))
		const deliveredMessages: unknown[] = []
		const websiteTabConnections: WebsiteTabConnections = populateDocumentConnections(new Map([[7, { connections: {
			'7-0x1': { port: { postMessage: (message: unknown) => deliveredMessages.push(message) }, socket: { tabId: 7, connectionName: 1n }, websiteOrigin: 'app.example', frameId: 2, approved: true, wantsToConnect: true },
			'7-0x2': { port: { postMessage: (message: unknown) => deliveredMessages.push(message) }, socket: { tabId: 7, connectionName: 2n }, websiteOrigin: 'app.example', approved: true, wantsToConnect: true },
		} }]]))
		registerAuthoritativeTopSocket(websiteTabConnections, { tabId: 7, connectionName: 99n }, 'app.example')

		await assert.rejects(selectSignerProvider(websiteTabConnections, { method: 'popup_selectSignerProvider', data: { tabId: 7, websiteOrigin: 'app.example', uuid: provider.uuid } }), /top-frame connection/)
		assert.deepEqual(deliveredMessages, [])
	})

	test('blocks only the tab with a pending chain-change confirmation', async () => {
		const { storageState } = installBrowserMock()
		const { selectSignerProvider } = await import('../../app/ts/background/signerProviderSelection.js')
		const { registerAuthoritativeTopSocket } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const { updateTabState } = await import('../../app/ts/background/storageVariables.js')
		const { defaultRpcs } = await import('../../app/ts/background/settings.js')
		await updateTabState(7, (previousState) => ({
			...previousState,
			website: { websiteOrigin: 'app.example', icon: undefined, title: 'Example' },
			availableSignerProviders: [provider],
		}))
		const deliveredMessages: unknown[] = []
		const websiteTabConnections: WebsiteTabConnections = populateDocumentConnections(new Map([[7, { connections: {
			'7-0x1': { port: { postMessage: (message: unknown) => deliveredMessages.push(message) }, socket: { tabId: 7, connectionName: 1n }, websiteOrigin: 'app.example', frameId: 0, approved: true, wantsToConnect: true },
		} }]]))
		registerAuthoritativeTopSocket(websiteTabConnections, { tabId: 7, connectionName: 1n }, 'app.example')
		const createPendingChainChange = (tabId: number) => ({
			website: { websiteOrigin: 'app.example', icon: undefined, title: 'Example' },
			popupOrTabId: { type: 'popup', id: 99 },
			request: {
				...createProviderMessage('wallet_switchEthereumChain', [{ chainId: '0x1' }], tabId),
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId, connectionName: '0x1' } },
			},
			rpcNetwork: { ...defaultRpcs[0], chainId: '0x1' },
			simulationMode: false,
		})
		storageState.chainChangeConfirmationPromise = createPendingChainChange(7)

		const selectionRequest = { method: 'popup_selectSignerProvider', data: { tabId: 7, websiteOrigin: 'app.example', uuid: provider.uuid } } as const
		await assert.rejects(selectSignerProvider(websiteTabConnections, selectionRequest), /pending signer request or chain change/)
		assert.deepEqual(deliveredMessages, [])

		storageState.chainChangeConfirmationPromise = createPendingChainChange(8)
		await selectSignerProvider(websiteTabConnections, selectionRequest)
		assert.equal(deliveredMessages.length, 1)
	})

	test('serializes child-frame pending creation behind an active top-frame selection lease', async () => {
		const { storageState } = installBrowserMock()
		const { beginSignerProviderSelection, finishSignerProviderSelection } = await import('../../app/ts/background/signerProviderSelection.js')
		const { setChainChangeConfirmationPromise } = await import('../../app/ts/background/pendingSignerWork.js')
		const { registerTopSignerDocument } = await import('../../app/ts/background/signerSelectionLease.js')
		const { defaultRpcs } = await import('../../app/ts/background/settings.js')
		const beginRequest = createProviderMessage('begin_signer_provider_selection', [provider.uuid])
		const token = await beginSignerProviderSelection(connections, beginRequest, 'app.example', true, 0)
		if (token === undefined) throw new Error('Missing signer selection lease')
		const pendingChainChange = {
			website: { websiteOrigin: 'frame.example', icon: undefined, title: 'Frame' },
			popupOrTabId: { type: 'popup' as const, id: 99 },
			request: {
				...createProviderMessage('wallet_switchEthereumChain', [{ chainId: '0x1' }]),
				uniqueRequestIdentifier: { requestId: 2, requestSocket: { tabId: 7, connectionName: 2n } },
			},
			rpcNetwork: defaultRpcs[0],
			simulationMode: false,
		}
		let pendingWriteFinished = false
		const pendingWrite = setChainChangeConfirmationPromise(connections, pendingChainChange).then(() => { pendingWriteFinished = true })
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(pendingWriteFinished, false)
		assert.equal(storageState.chainChangeConfirmationPromise, undefined)
		assert.equal(registerTopSignerDocument(connections, { tabId: 7, connectionName: 1n }, 'app.example'), false)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(pendingWriteFinished, false)

		finishSignerProviderSelection(connections, createProviderMessage('finish_signer_provider_selection', [token]))
		await pendingWrite
		const storedPendingChainChange = storageState.chainChangeConfirmationPromise
		if (!isRecord(storedPendingChainChange)
			|| !isRecord(storedPendingChainChange.request)
			|| !isRecord(storedPendingChainChange.request.uniqueRequestIdentifier)
			|| !isRecord(storedPendingChainChange.request.uniqueRequestIdentifier.requestSocket)) throw new Error('Missing serialized pending chain change')
		assert.equal(storedPendingChainChange.request.uniqueRequestIdentifier.requestSocket.tabId, 7)
	})

	test('rejects an old document that loses authority while queued for a signer selection lease', async () => {
		installBrowserMock()
		const { beginSignerProviderSelection, finishSignerProviderSelection } = await import('../../app/ts/background/signerProviderSelection.js')
		const { registerAuthoritativeTopSocket } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const { acquireSignerSelectionLease, releaseSignerSelectionLease } = await import('../../app/ts/background/signerSelectionLease.js')
		const oldSocket = { tabId: 7, connectionName: 1n }
		const newSocket = { tabId: 7, connectionName: 2n }
		const blockingToken = await acquireSignerSelectionLease(connections, 7)
		const staleBeginRequest = createProviderMessage('begin_signer_provider_selection', [provider.uuid])
		const queuedSelection = beginSignerProviderSelection(connections, staleBeginRequest, 'app.example', true, 0)
		await new Promise((resolve) => setTimeout(resolve, 0))
		registerAuthoritativeTopSocket(connections, newSocket, 'app.example')
		// Registering a new document invalidates the old document lease as part of authority replacement.
		assert.equal(releaseSignerSelectionLease(connections, 7, blockingToken), false)
		assert.equal(await queuedSelection, undefined)

		const currentBeginRequest = {
			...createProviderMessage('begin_signer_provider_selection', [provider.uuid]),
			uniqueRequestIdentifier: { requestId: 2, requestSocket: newSocket },
		}
		const currentToken = await beginSignerProviderSelection(connections, currentBeginRequest, 'app.example', true, 0)
		if (currentToken === undefined) throw new Error('The current document failed to acquire the released signer selection gate')
		finishSignerProviderSelection(connections, { ...currentBeginRequest, method: 'finish_signer_provider_selection', params: [currentToken] })
	})

	test('rejects an old document superseded while its pending-work check is in flight', async () => {
		let announcePendingRead: (() => void) | undefined
		let continuePendingRead: (() => void) | undefined
		const pendingReadStarted = new Promise<void>((resolve) => { announcePendingRead = resolve })
		const pendingReadGate = new Promise<void>((resolve) => { continuePendingRead = resolve })
		let delayNextPendingRead = true
		installBrowserMock(async (keys) => {
			if (!delayNextPendingRead || !Array.isArray(keys) || !keys.includes('pendingTransactionsAndMessages')) return
			delayNextPendingRead = false
			announcePendingRead?.()
			await pendingReadGate
		})
		const { beginSignerProviderSelection, finishSignerProviderSelection } = await import('../../app/ts/background/signerProviderSelection.js')
		const { registerTopSignerDocument } = await import('../../app/ts/background/signerSelectionLease.js')
		const oldBeginRequest = createProviderMessage('begin_signer_provider_selection', [provider.uuid])
		const oldSelection = beginSignerProviderSelection(connections, oldBeginRequest, 'app.example', true, 0)
		await pendingReadStarted

		const newSocket = { tabId: 7, connectionName: 2n }
		assert.equal(registerTopSignerDocument(connections, newSocket, 'app.example'), true)
		continuePendingRead?.()
		assert.equal(await oldSelection, undefined)

		const currentBeginRequest = {
			...createProviderMessage('begin_signer_provider_selection', [provider.uuid]),
			uniqueRequestIdentifier: { requestId: 2, requestSocket: newSocket },
		}
		const currentToken = await beginSignerProviderSelection(connections, currentBeginRequest, 'app.example', true, 0)
		if (currentToken === undefined) throw new Error('The current document failed to acquire the signer selection gate')
		finishSignerProviderSelection(connections, { ...currentBeginRequest, method: 'finish_signer_provider_selection', params: [currentToken] })
	})

	test('requests cached provider resynchronization when a disconnected child reconnects', async () => {
		installBrowserMock()
		const { getChildSignerConnectionSynchronization, signerProviderSelected, signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { authorizeSocketForSignerExecution, registerCurrentChildSignerSocket, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner, unregisterCurrentChildSignerSocket } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const childSocket = { tabId: 7, connectionName: 2n }
		assert.equal(setSignerExecutionTarget(connections, 7, provider.uuid, 'app.example'), true)
		assert.equal(registerCurrentChildSignerSocket(connections, childSocket, 2), true)
		assert.equal(reconcileSignerExecutionDocument(connections, childSocket, 'app.example', DOCUMENT_GENERATION, false, 2), true)
		assert.equal(authorizeSocketForSignerExecution(connections, childSocket, provider.uuid, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, childSocket), true)
		assert.equal(unregisterCurrentChildSignerSocket(connections, childSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, childSocket), false)

		const catalogResynchronizationNeeded = registerCurrentChildSignerSocket(connections, childSocket, 2)
		assert.equal(catalogResynchronizationNeeded, true)
		assert.deepEqual(getChildSignerConnectionSynchronization(connections, childSocket, 'app.example', catalogResynchronizationNeeded), {
			type: 'result',
			method: 'request_signer_provider_catalog',
			result: [],
		})
		const childCatalogRequest = {
			...createProviderMessage('signer_providers_changed', [[provider], false]),
			uniqueRequestIdentifier: { requestId: 3, requestSocket: childSocket },
		}
		const catalogReply = await signerProvidersChanged(connections, childCatalogRequest, 'app.example', false, 2)
		assert.equal(catalogReply.selectedSignerProviderUuid, provider.uuid)
		const childSelectionRequest = {
			...createProviderMessage('signer_provider_selected', [provider, 'remembered']),
			uniqueRequestIdentifier: { requestId: 4, requestSocket: childSocket },
		}
		await signerProviderSelected(childSelectionRequest, 'app.example', false, 2, populateDocumentConnections(new Map()))
		assert.equal(socketCanExecuteWithSelectedSigner(connections, childSocket), true)
	})

	test('propagates exact UUID authority only to same-origin frames and requires their acknowledgement', async () => {
		installBrowserMock()
		const { signerProviderSelected } = await import('../../app/ts/background/signerProviderSelection.js')
		const { registerAuthoritativeTopSocket, registerCurrentChildSignerSocket, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const { updateTabState } = await import('../../app/ts/background/storageVariables.js')
		const topSocket = { tabId: 7, connectionName: 1n }
		const childSocket = { tabId: 7, connectionName: 2n }
		const crossOriginChildSocket = { tabId: 7, connectionName: 3n }

		await updateTabState(7, (previousState) => ({ ...previousState, availableSignerProviders: [provider] }))
		const childMessages: unknown[] = []
		const crossOriginChildMessages: unknown[] = []
		const websiteTabConnections: WebsiteTabConnections = populateDocumentConnections(new Map([[7, { connections: {
			'7-0x1': { port: { postMessage: () => undefined }, socket: topSocket, websiteOrigin: 'app.example', frameId: 0, approved: true, wantsToConnect: true },
			'7-0x2': { port: { postMessage: (message: unknown) => childMessages.push(message) }, socket: childSocket, websiteOrigin: 'app.example', frameId: 2, approved: true, wantsToConnect: true },
			'7-0x3': { port: { postMessage: (message: unknown) => crossOriginChildMessages.push(message) }, socket: crossOriginChildSocket, websiteOrigin: 'frame.example', frameId: 3, approved: true, wantsToConnect: true },
		} }]]))
		registerAuthoritativeTopSocket(websiteTabConnections, topSocket, 'app.example')
		registerCurrentChildSignerSocket(websiteTabConnections, childSocket, 2)
		reconcileSignerExecutionDocument(websiteTabConnections, childSocket, 'app.example', DOCUMENT_GENERATION, false, 2)
		setSignerExecutionTarget(websiteTabConnections, 7, provider.uuid, 'app.example')

		await signerProviderSelected(createProviderMessage('signer_provider_selected', [provider, 'explicit']), 'app.example', true, 0, websiteTabConnections)
		assert.equal(socketCanExecuteWithSelectedSigner(websiteTabConnections, topSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(websiteTabConnections, childSocket), false)
		assert.equal(childMessages.length, 1)
		assert.deepEqual(crossOriginChildMessages, [])

		const childSelectionRequest = {
			...createProviderMessage('signer_provider_selected', [provider, 'explicit'], 7),
			uniqueRequestIdentifier: { requestId: 2, requestSocket: childSocket },
		}
		await signerProviderSelected(childSelectionRequest, 'app.example', false, 2, websiteTabConnections)
		assert.equal(socketCanExecuteWithSelectedSigner(websiteTabConnections, childSocket), true)

		const crossOriginSelectionRequest = {
			...createProviderMessage('signer_provider_selected', [provider, 'explicit'], 7),
			uniqueRequestIdentifier: { requestId: 3, requestSocket: crossOriginChildSocket },
		}
		await assert.rejects(signerProviderSelected(crossOriginSelectionRequest, 'frame.example', false, 3, websiteTabConnections), /outside the tab execution authority/)
		assert.equal(socketCanExecuteWithSelectedSigner(websiteTabConnections, crossOriginChildSocket), false)
	})

	test('blocks signer execution while superseding an old top-frame document', async () => {
		installBrowserMock()
		const { beginSignerProviderSelection, signerProviderSelected } = await import('../../app/ts/background/signerProviderSelection.js')
		const { authorizeSocketForSignerExecution, getSignerExecutionTargetForOrigin, isAuthoritativeTopSocket, registerAuthoritativeTopSocket, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const oldSocket = { tabId: 7, connectionName: 1n }
		const newSocket = { tabId: 7, connectionName: 2n }
		registerAuthoritativeTopSocket(connections, oldSocket, 'app.example')
		setSignerExecutionTarget(connections, 7, provider.uuid, 'app.example')
		assert.equal(authorizeSocketForSignerExecution(connections, oldSocket, provider.uuid, 'app.example'), true)
		registerAuthoritativeTopSocket(connections, newSocket, 'app.example')
		assert.equal(isAuthoritativeTopSocket(connections, oldSocket), false)
		assert.equal(isAuthoritativeTopSocket(connections, newSocket), true)
		assert.equal(getSignerExecutionTargetForOrigin(connections, 7, 'app.example'), undefined)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, oldSocket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, newSocket), false)

		const staleSelectionRequest = {
			...createProviderMessage('signer_provider_selected', [provider, 'explicit']),
			uniqueRequestIdentifier: { requestId: 2, requestSocket: oldSocket },
		}
		await assert.rejects(signerProviderSelected(staleSelectionRequest, 'app.example', false, 0, populateDocumentConnections(new Map())), /current top frame or child frame/)
		const staleBeginRequest = {
			...createProviderMessage('begin_signer_provider_selection', [provider.uuid]),
			uniqueRequestIdentifier: { requestId: 3, requestSocket: oldSocket },
		}
		assert.equal(await beginSignerProviderSelection(connections, staleBeginRequest, 'app.example', false, 0), undefined)
	})

	test('turns unauthorized signer forwarding into a deterministic terminal rejection', async () => {
		installBrowserMock()
		const { replyToInterceptedRequest } = await import('../../app/ts/background/messageSending.js')
		const { authorizeSignerForward, setSignerExecutionTarget } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const childSocket = { tabId: 7, connectionName: 2n }
		const deliveredMessages: unknown[] = []
		const websiteTabConnections: WebsiteTabConnections = populateDocumentConnections(new Map([[7, { connections: {
			'7-0x2': { port: { postMessage: (message: unknown) => deliveredMessages.push(message) }, socket: childSocket, websiteOrigin: 'frame.example', frameId: 2, approved: true, wantsToConnect: true },
		} }]]))
		setSignerExecutionTarget(websiteTabConnections, 7, provider.uuid, 'app.example')

		const delivered = replyToInterceptedRequest(websiteTabConnections, authorizeSignerForward(websiteTabConnections, {
			...createProviderMessage('eth_sendTransaction', [{ from: '0x1111111111111111111111111111111111111111' }]),
			type: 'forwardToSigner',
			uniqueRequestIdentifier: { requestId: 4, requestSocket: childSocket },
		}))

		assert.equal(delivered, true)
		const reply = deliveredMessages[0]
		assert.equal(isRecord(reply) && reply.type === 'result', true)
		assert.equal(isRecord(reply) && isRecord(reply.error) && reply.error.code === 4100, true)
	})

	test('authority registration, queries, and cleanup keep state private from the connection collection', async () => {
		const { blockSignerExecution, getSignerExecutionError, getSignerExecutionTargetForOrigin, isAuthoritativeTopSocket, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const untouched: WebsiteTabConnections = Object.freeze(new Map())
		const socket = { tabId: 704, connectionName: 1n }
		assert.equal(getSignerDocumentGeneration(untouched, socket, 'app.example'), undefined)
		assert.equal(getSignerExecutionTargetForOrigin(untouched, socket.tabId, 'app.example'), undefined)
		assert.equal(isAuthoritativeTopSocket(untouched, socket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(untouched, socket), false)
		assert.equal(getSignerExecutionError(untouched, socket)?.code, 4100)
		assert.equal(reconcileSignerExecutionDocument(untouched, socket, 'app.example', undefined, true, 0), false)
		blockSignerExecution(untouched, socket.tabId)
		clearSignerExecutionAuthorityForTab(untouched, socket.tabId)
		assert.deepEqual(Object.getOwnPropertyNames(untouched), [])
		registerAuthoritativeTopSocket(untouched, socket, 'app.example')
		const generation = getSignerDocumentGeneration(untouched, socket, 'app.example')
		assert.ok(generation)
		assert.deepEqual(Object.getOwnPropertyNames(untouched), [])
		clearSignerExecutionAuthorityForTab(untouched, socket.tabId)
		assert.equal(getSignerDocumentGeneration(untouched, socket, 'app.example'), undefined)
		registerAuthoritativeTopSocket(untouched, socket, 'app.example')
		assert.notEqual(getSignerDocumentGeneration(untouched, socket, 'app.example'), generation)
		clearSignerExecutionAuthorityForTab(untouched, socket.tabId)
		assert.deepEqual(Object.getOwnPropertyNames(untouched), [])
	})

	test('separate connection collections cannot share signer execution authority', async () => {
		installBrowserMock()
		const { allowLegacySignerExecution, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const socket = { tabId: 7, connectionName: 1n }
		assert.equal(allowLegacySignerExecution(connections, socket, 'app.example'), true)
		const unrelated: WebsiteTabConnections = new Map()
		assert.equal(socketCanExecuteWithSelectedSigner(connections, socket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(unrelated, socket), false)
		registerAuthoritativeTopSocket(unrelated, socket, 'app.example')
		assert.notEqual(getSignerDocumentGeneration(unrelated, socket, 'app.example'), DOCUMENT_GENERATION)
		clearSignerExecutionAuthorityForTab(unrelated, socket.tabId)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, socket), true)
	})

	test('selection gates and lease teardown are isolated between connection collections with identical tab IDs', async () => {
		installBrowserMock()
		const { acquireSignerSelectionLease, releaseSignerSelectionLease, signerSelectionLeaseIsActive, runWithSignerSelectionGate } = await import('../../app/ts/background/signerSelectionLease.js')
		const unrelated: WebsiteTabConnections = new Map()
		const token = await acquireSignerSelectionLease(connections, 7)
		const unrelatedToken = await acquireSignerSelectionLease(unrelated, 7)
		assert.equal(releaseSignerSelectionLease(unrelated, 7, token), false)
		let queuedWorkRan = false
		const queuedWork = runWithSignerSelectionGate(connections, 7, async () => { queuedWorkRan = true })
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(queuedWorkRan, false)
		clearSignerExecutionAuthorityForTab(connections, 7)
		await queuedWork
		assert.equal(queuedWorkRan, true)
		assert.equal(signerSelectionLeaseIsActive(connections, 7, token), false)
		assert.equal(signerSelectionLeaseIsActive(unrelated, 7, unrelatedToken), true)
		clearSignerExecutionAuthorityForTab(unrelated, 7)
		assert.equal(signerSelectionLeaseIsActive(unrelated, 7, unrelatedToken), false)
	})

	test('clears signer authority state when a tab closes', async () => {
		installBrowserMock()
		const { authorizeSocketForSignerExecution, clearSignerExecutionAuthorityForTab, getSignerExecutionTargetForOrigin, isAuthoritativeTopSocket, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const { acquireSignerSelectionLease, releaseSignerSelectionLease } = await import('../../app/ts/background/signerSelectionLease.js')
		const socket = { tabId: 7, connectionName: 1n }
		setSignerExecutionTarget(connections, 7, provider.uuid, 'app.example')
		assert.equal(authorizeSocketForSignerExecution(connections, socket, provider.uuid, 'app.example'), true)
		const leaseToken = await acquireSignerSelectionLease(connections, 7)
		clearSignerExecutionAuthorityForTab(connections, 7)

		assert.equal(isAuthoritativeTopSocket(connections, socket), false)
		assert.equal(getSignerExecutionTargetForOrigin(connections, 7, 'app.example'), undefined)
		assert.equal(socketCanExecuteWithSelectedSigner(connections, socket), false)
		assert.equal(releaseSignerSelectionLease(connections, 7, leaseToken), false)
	})

	test('releases only the reconnecting socket signer-selection lease', async () => {
		installBrowserMock()
		const { finishSignerProviderSelection } = await import('../../app/ts/background/signerProviderSelection.js')
		const {
			acquireSignerSelectionLease,
			releaseSignerSelectionLease,
			releaseSignerSelectionLeasesForSocket,
		} = await import('../../app/ts/background/signerSelectionLease.js')
		const reconnectingSocket = { tabId: 7, connectionName: 1n }
		const otherTabSocket = { tabId: 8, connectionName: 1n }
		const reconnectingLease = await acquireSignerSelectionLease(connections, 7, reconnectingSocket)
		releaseSignerSelectionLeasesForSocket(connections, reconnectingSocket)
		assert.equal(releaseSignerSelectionLease(connections, 7, reconnectingLease), false)
		assert.equal(finishSignerProviderSelection(connections, createProviderMessage('finish_signer_provider_selection', [reconnectingLease])), false)

		const otherTabLease = await acquireSignerSelectionLease(connections, 8, otherTabSocket)
		releaseSignerSelectionLeasesForSocket(connections, reconnectingSocket)
		assert.equal(releaseSignerSelectionLease(connections, 8, otherTabLease), true)
	})
})
