import * as assert from 'assert'
import { describe, test } from 'bun:test'
import type { ProviderMessage } from '../../app/ts/utils/requests.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import { clearSignerExecutionAuthorityForTab, reconcileSignerExecutionDocument, registerAuthoritativeTopSocket } from '../../app/ts/background/signerExecutionAuthority.js'

const defineGlobal = (name: PropertyKey, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const DOCUMENT_GENERATION = '11111111-1111-4111-8111-111111111111'
const NEXT_DOCUMENT_GENERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function installBrowserMock(beforeStorageGet?: (keys: unknown) => Promise<void>) {
	clearSignerExecutionAuthorityForTab(7)
	registerAuthoritativeTopSocket({ tabId: 7, connectionName: 1n }, 'app.example')
	reconcileSignerExecutionDocument({ tabId: 7, connectionName: 1n }, 'app.example', DOCUMENT_GENERATION, true, 0)
	const storageState: Record<string, unknown> = {}
	const popupMessages: unknown[] = []
	defineGlobal('browser', {
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
	const normalizedParams = method === 'signer_providers_changed' && params.length === 2 ? [...params, DOCUMENT_GENERATION] : params
	return {
		interceptorRequest: true,
		interceptorInternalRequest: true,
		usingInterceptorWithoutSigner: false,
		method,
		params: normalizedParams,
		uniqueRequestIdentifier: {
			requestId: 1,
			requestSocket: { tabId, connectionName: 1n },
		},
	}
}

describe('EIP-6963 signer provider selection', () => {
	test('returns the per-origin preference and publishes only top-frame provider metadata', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: provider.rdns }]
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getTabState } = await import('../../app/ts/background/storageVariables.js')

		const result = await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[provider], false]), 'app.example', true)
		const tabState = await getTabState(7)

		assert.deepEqual(result, { preferredSignerRdns: provider.rdns, automaticSelectionAllowed: true, signerSelectionChangeAllowed: true, legacySignerAllowed: false })
		assert.deepEqual(tabState.availableSignerProviders, [provider])
		assert.equal(tabState.preferredSignerUnavailable, false)
	})

	test('does not publish catalog state from a frame without verified top-frame identity', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: provider.rdns }]
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getTabState } = await import('../../app/ts/background/storageVariables.js')

		const result = await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[provider], false]), 'app.example', false)
		const tabState = await getTabState(7)

		assert.deepEqual(result, { preferredSignerRdns: undefined, automaticSelectionAllowed: false, signerSelectionChangeAllowed: false, legacySignerAllowed: false })
		assert.deepEqual(tabState.availableSignerProviders, [])
		assert.equal(tabState.selectedSignerProvider, undefined)
	})

	test('fails closed when a remembered RDNS matches more than one announced provider', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: provider.rdns }]
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getTabState, updateTabState } = await import('../../app/ts/background/storageVariables.js')
		await updateTabState(7, (previousState) => ({
			...previousState,
			signerName: provider.name,
			signerAccounts: [1n],
			activeSigningAddress: 1n,
			selectedSignerProvider: provider,
		}))
		const duplicateWalletInstance = { ...provider, uuid: '33333333-3333-4333-8333-333333333333' }

		await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[provider, duplicateWalletInstance], false]), 'app.example', true)
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

		const result = await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[], false]), 'app.example', true)

		assert.deepEqual(result, { preferredSignerRdns: provider.rdns, automaticSelectionAllowed: true, signerSelectionChangeAllowed: true, legacySignerAllowed: false })
		assert.equal(socketCanExecuteWithSelectedSigner({ tabId: 7, connectionName: 1n }), false)
	})

	test('treats RDNS identity as case-insensitive when restoring and detecting ambiguity', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: 'COM.Example.Second' }]
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getSignerPreference, getTabState } = await import('../../app/ts/background/storageVariables.js')
		const differentlyCapitalizedProvider = { ...provider, rdns: 'Com.Example.Second' }
		const duplicateWalletInstance = { ...provider, uuid: '33333333-3333-4333-8333-333333333333' }

		const restored = await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[differentlyCapitalizedProvider], false]), 'app.example', true)
		assert.deepEqual(restored, { preferredSignerRdns: provider.rdns, automaticSelectionAllowed: true, signerSelectionChangeAllowed: true, legacySignerAllowed: false })
		assert.equal((await getTabState(7)).availableSignerProviders?.[0]?.rdns, provider.rdns)
		assert.equal((await getSignerPreference('app.example'))?.rdns, provider.rdns)

		await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[differentlyCapitalizedProvider, duplicateWalletInstance], false]), 'app.example', true)
		assert.equal((await getTabState(7)).preferredSignerUnavailable, true)
	})

	test('disables remembered restoration when the provider catalog overflows', async () => {
		const { storageState } = installBrowserMock()
		storageState.signerPreferences = [{ websiteOrigin: 'app.example', rdns: provider.rdns }]
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { getTabState, updateTabState } = await import('../../app/ts/background/storageVariables.js')
		await updateTabState(7, (previousState) => ({
			...previousState,
			signerName: provider.name,
			signerAccounts: [1n],
			selectedSignerProvider: provider,
		}))

		const result = await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[provider], true]), 'app.example', true)
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
			signerName: provider.name,
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

		const deferred = await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[provider, duplicateWalletInstance], false]), 'app.example', true)
		const deferredTabState = await getTabState(7)
		assert.deepEqual(deferred, { preferredSignerRdns: provider.rdns, automaticSelectionAllowed: true, signerSelectionChangeAllowed: false, legacySignerAllowed: false })
		assert.deepEqual(deferredTabState.selectedSignerProvider, provider)
		assert.equal(deferredTabState.signerName, provider.name)

		delete storageState.chainChangeConfirmationPromise
		const allowed = await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[provider, duplicateWalletInstance], false]), 'app.example', true)
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

		const deferred = await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[], false]), 'app.example', true)
		assert.deepEqual(deferred, { preferredSignerRdns: undefined, automaticSelectionAllowed: true, signerSelectionChangeAllowed: false, legacySignerAllowed: false })
		assert.equal(socketCanExecuteWithSelectedSigner({ tabId: 7, connectionName: 1n }), false)

		delete storageState.chainChangeConfirmationPromise
		const allowed = await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[], false]), 'app.example', true)
		assert.deepEqual(allowed, { preferredSignerRdns: undefined, automaticSelectionAllowed: true, signerSelectionChangeAllowed: true, legacySignerAllowed: true })
		assert.equal(socketCanExecuteWithSelectedSigner({ tabId: 7, connectionName: 1n }), true)
	})

	test('keeps superseded document sockets blocked after the new document enables legacy signing', async () => {
		installBrowserMock()
		const { signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { registerAuthoritativeTopSocket, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const oldTopSocket = { tabId: 7, connectionName: 1n }
		const oldChildSocket = { tabId: 7, connectionName: 2n }
		const newTopSocket = { tabId: 7, connectionName: 3n }
		const newChildSocket = { tabId: 7, connectionName: 4n }

		await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[], false]), 'app.example', true)
		const oldChildCatalog = {
			...createProviderMessage('signer_providers_changed', [[], false]),
			uniqueRequestIdentifier: { requestId: 2, requestSocket: oldChildSocket },
		}
		const { registerCurrentChildSignerSocket } = await import('../../app/ts/background/signerExecutionAuthority.js')
		registerCurrentChildSignerSocket(oldChildSocket, 2)
		await signerProvidersChanged(oldChildCatalog, 'app.example', false, 2)
		assert.equal(socketCanExecuteWithSelectedSigner(oldTopSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(oldChildSocket), true)

		registerAuthoritativeTopSocket(newTopSocket, 'app.example')
		const newTopCatalog = {
			...createProviderMessage('signer_providers_changed', [[], false, NEXT_DOCUMENT_GENERATION]),
			uniqueRequestIdentifier: { requestId: 3, requestSocket: newTopSocket },
		}
		const newChildCatalog = {
			...createProviderMessage('signer_providers_changed', [[], false, NEXT_DOCUMENT_GENERATION]),
			uniqueRequestIdentifier: { requestId: 4, requestSocket: newChildSocket },
		}
		await signerProvidersChanged(newTopCatalog, 'app.example', true)
		registerCurrentChildSignerSocket(newChildSocket, 2)
		await signerProvidersChanged(newChildCatalog, 'app.example', false, 2)
		await signerProvidersChanged(newTopCatalog, 'app.example', true)

		assert.equal(socketCanExecuteWithSelectedSigner(oldTopSocket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(oldChildSocket), false)
		assert.equal((await signerProvidersChanged(oldChildCatalog, 'app.example', false, 2)).legacySignerAllowed, false)
		assert.equal(socketCanExecuteWithSelectedSigner(newTopSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(newChildSocket), true)
	})

	test('preserves legacy and exact-provider authority across same-document port reconnects', async () => {
		installBrowserMock()
		const { allowLegacySignerExecution, authorizeSocketForLegacySignerExecution, authorizeSocketForSignerExecution, registerAuthoritativeTopSocket, registerCurrentChildSignerSocket, scheduleCurrentChildSignerSocketRemoval, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const topSocket = { tabId: 7, connectionName: 1n }
		const childSocket = { tabId: 7, connectionName: 2n }
		registerCurrentChildSignerSocket(childSocket, 2)
		reconcileSignerExecutionDocument(childSocket, 'app.example', DOCUMENT_GENERATION, false, 2)
		assert.equal(allowLegacySignerExecution(topSocket, 'app.example'), true)
		assert.equal(authorizeSocketForLegacySignerExecution(childSocket, 'app.example'), true)

		assert.equal(registerAuthoritativeTopSocket(topSocket, 'app.example'), false)
		assert.equal(scheduleCurrentChildSignerSocketRemoval(childSocket), true)
		assert.equal(registerCurrentChildSignerSocket(childSocket, 2), false)
		assert.equal(socketCanExecuteWithSelectedSigner(topSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(childSocket), true)

		assert.equal(setSignerExecutionTarget(7, provider.uuid, 'app.example'), true)
		assert.equal(authorizeSocketForSignerExecution(topSocket, provider.uuid, 'app.example'), true)
		assert.equal(authorizeSocketForSignerExecution(childSocket, provider.uuid, 'app.example'), true)
		assert.equal(registerAuthoritativeTopSocket(topSocket, 'app.example'), false)
		assert.equal(socketCanExecuteWithSelectedSigner(topSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(childSocket), true)
	})

	test('revokes the previous child document when the same frame connects with a new socket', async () => {
		installBrowserMock()
		const { allowLegacySignerExecution, authorizeSocketForLegacySignerExecution, authorizeSocketForSignerExecution, registerCurrentChildSignerSocket, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner, unregisterCurrentChildSignerSocket } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const topSocket = { tabId: 7, connectionName: 1n }
		const oldChildSocket = { tabId: 7, connectionName: 2n }
		const replacementChildSocket = { tabId: 7, connectionName: 3n }
		registerCurrentChildSignerSocket(oldChildSocket, 2)
		assert.equal(reconcileSignerExecutionDocument(oldChildSocket, 'app.example', DOCUMENT_GENERATION, false, 2), true)
		assert.equal(allowLegacySignerExecution(topSocket, 'app.example'), true)
		assert.equal(authorizeSocketForLegacySignerExecution(oldChildSocket, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(oldChildSocket), true)

		assert.equal(registerCurrentChildSignerSocket(replacementChildSocket, 2), true)
		assert.equal(socketCanExecuteWithSelectedSigner(oldChildSocket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(replacementChildSocket), false)
		assert.equal(reconcileSignerExecutionDocument(replacementChildSocket, 'app.example', DOCUMENT_GENERATION, false, 2), true)
		assert.equal(authorizeSocketForLegacySignerExecution(replacementChildSocket, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(replacementChildSocket), true)
		assert.equal(unregisterCurrentChildSignerSocket(oldChildSocket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(replacementChildSocket), true)
		assert.equal(unregisterCurrentChildSignerSocket(replacementChildSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(replacementChildSocket), false)
		assert.equal(registerCurrentChildSignerSocket(replacementChildSocket, 2), true)
		assert.equal(reconcileSignerExecutionDocument(replacementChildSocket, 'app.example', DOCUMENT_GENERATION, false, 2), true)
		assert.equal(authorizeSocketForLegacySignerExecution(replacementChildSocket, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(replacementChildSocket), true)

		assert.equal(setSignerExecutionTarget(7, provider.uuid, 'app.example'), true)
		assert.equal(authorizeSocketForSignerExecution(replacementChildSocket, provider.uuid, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(replacementChildSocket), true)
		assert.equal(registerCurrentChildSignerSocket(oldChildSocket, 2), true)
		assert.equal(socketCanExecuteWithSelectedSigner(replacementChildSocket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(oldChildSocket), false)
		assert.equal(reconcileSignerExecutionDocument(oldChildSocket, 'app.example', DOCUMENT_GENERATION, false, 2), true)
		assert.equal(authorizeSocketForSignerExecution(oldChildSocket, provider.uuid, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(oldChildSocket), true)
	})

	test('admits a child that connects before its new top only after their document generation matches', async () => {
		installBrowserMock()
		const { allowLegacySignerExecution, authorizeSocketForLegacySignerExecution, registerAuthoritativeTopSocket, registerCurrentChildSignerSocket, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const oldTopSocket = { tabId: 7, connectionName: 1n }
		const newChildSocket = { tabId: 7, connectionName: 2n }
		const newTopSocket = { tabId: 7, connectionName: 3n }
		registerCurrentChildSignerSocket(newChildSocket, 2)
		assert.equal(reconcileSignerExecutionDocument(newChildSocket, 'app.example', NEXT_DOCUMENT_GENERATION, false, 2), false)
		assert.equal(socketCanExecuteWithSelectedSigner(newChildSocket), false)

		assert.equal(registerAuthoritativeTopSocket(newTopSocket, 'app.example'), true)
		assert.equal(reconcileSignerExecutionDocument(newTopSocket, 'app.example', NEXT_DOCUMENT_GENERATION, true, 0), true)
		assert.equal(reconcileSignerExecutionDocument(newChildSocket, 'app.example', NEXT_DOCUMENT_GENERATION, false, 2), true)
		assert.equal(allowLegacySignerExecution(newTopSocket, 'app.example'), true)
		assert.equal(authorizeSocketForLegacySignerExecution(newChildSocket, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(oldTopSocket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(newTopSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(newChildSocket), true)
	})

	test('keeps a restored bfcache document blocked until it republishes its catalog generation', async () => {
		installBrowserMock()
		const { allowLegacySignerExecution, registerAuthoritativeTopSocket, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const restoredSocket = { tabId: 7, connectionName: 1n }
		const interveningSocket = { tabId: 7, connectionName: 2n }
		assert.equal(allowLegacySignerExecution(restoredSocket, 'app.example'), true)
		assert.equal(registerAuthoritativeTopSocket(interveningSocket, 'app.example'), true)
		assert.equal(reconcileSignerExecutionDocument(interveningSocket, 'app.example', NEXT_DOCUMENT_GENERATION, true, 0), true)
		assert.equal(allowLegacySignerExecution(interveningSocket, 'app.example'), true)

		assert.equal(registerAuthoritativeTopSocket(restoredSocket, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(restoredSocket), false)
		assert.equal(allowLegacySignerExecution(restoredSocket, 'app.example'), false)
		assert.equal(reconcileSignerExecutionDocument(restoredSocket, 'app.example', DOCUMENT_GENERATION, true, 0), true)
		assert.equal(allowLegacySignerExecution(restoredSocket, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(restoredSocket), true)
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

		await signerProviderSelected(createProviderMessage('signer_provider_selected', [provider, 'explicit']), 'app.example', true, 0, new Map())
		const tabState = await getTabState(7)

		assert.deepEqual(await getSignerPreference('app.example'), { websiteOrigin: 'app.example', rdns: provider.rdns })
		assert.equal(tabState.signerName, provider.name)
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
		await updateTabState(7, (previousState) => ({ ...previousState, availableSignerProviders: [provider, duplicateWalletInstance] }))
		await signerProviderSelected(createProviderMessage('signer_provider_selected', [provider, 'explicit']), 'app.example', true, 0, new Map())

		await signerProvidersChanged(createProviderMessage('signer_providers_changed', [[provider, duplicateWalletInstance, unrelatedProvider], false]), 'app.example', true)
		const tabState = await getTabState(7)

		assert.equal(tabState.preferredSignerUnavailable, false)
		assert.deepEqual(tabState.selectedSignerProvider, provider)
		assert.equal(tabState.explicitlySelectedSignerProviderUuid, provider.uuid)
	})

	test('delivers an explicit selection to the top frame and commits authority only after its acknowledgement', async () => {
		installBrowserMock()
		const { selectSignerProvider, signerProviderSelected } = await import('../../app/ts/background/signerProviderSelection.js')
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
		const websiteTabConnections: WebsiteTabConnections = new Map([[7, { connections: {
			'7-0x1': { port: { postMessage: (message: unknown) => topFrameMessages.push(message) }, socket: { tabId: 7, connectionName: 1n }, websiteOrigin: 'app.example', frameId: 0, approved: true, wantsToConnect: true },
			'7-0x2': { port: { postMessage: (message: unknown) => childFrameMessages.push(message) }, socket: { tabId: 7, connectionName: 2n }, websiteOrigin: 'app.example', frameId: 2, approved: true, wantsToConnect: true },
			'7-0x3': { port: { postMessage: (message: unknown) => otherSiteMessages.push(message) }, socket: { tabId: 7, connectionName: 3n }, websiteOrigin: 'frame.example', frameId: 3, approved: true, wantsToConnect: true },
		} }]])
		registerAuthoritativeTopSocket({ tabId: 7, connectionName: 1n }, 'app.example')
		assert.equal(setSignerExecutionTarget(7, oldProviderUuid, 'app.example'), true)

		await selectSignerProvider(websiteTabConnections, { method: 'popup_selectSignerProvider', data: { tabId: 7, websiteOrigin: 'app.example', uuid: provider.uuid } })

		assert.equal(topFrameMessages.length, 1)
		assert.deepEqual(childFrameMessages, [])
		assert.deepEqual(otherSiteMessages, [])
		assert.equal(getSignerExecutionTargetForOrigin(7, 'app.example'), oldProviderUuid)

		await signerProviderSelected(createProviderMessage('signer_provider_selected', [provider, 'explicit']), 'app.example', true, 0, websiteTabConnections)
		assert.equal(getSignerExecutionTargetForOrigin(7, 'app.example'), provider.uuid)
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
		const websiteTabConnections: WebsiteTabConnections = new Map([[7, { connections: {
			'7-0x1': { port: { postMessage: (message: unknown) => deliveredMessages.push(message) }, socket: { tabId: 7, connectionName: 1n }, websiteOrigin: 'app.example', frameId: 2, approved: true, wantsToConnect: true },
			'7-0x2': { port: { postMessage: (message: unknown) => deliveredMessages.push(message) }, socket: { tabId: 7, connectionName: 2n }, websiteOrigin: 'app.example', approved: true, wantsToConnect: true },
		} }]])
		registerAuthoritativeTopSocket({ tabId: 7, connectionName: 99n }, 'app.example')

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
		const websiteTabConnections: WebsiteTabConnections = new Map([[7, { connections: {
			'7-0x1': { port: { postMessage: (message: unknown) => deliveredMessages.push(message) }, socket: { tabId: 7, connectionName: 1n }, websiteOrigin: 'app.example', frameId: 0, approved: true, wantsToConnect: true },
		} }]])
		registerAuthoritativeTopSocket({ tabId: 7, connectionName: 1n }, 'app.example')
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
		const { setChainChangeConfirmationPromise } = await import('../../app/ts/background/storageVariables.js')
		const { registerTopSignerDocument } = await import('../../app/ts/background/signerSelectionLease.js')
		const { defaultRpcs } = await import('../../app/ts/background/settings.js')
		const beginRequest = createProviderMessage('begin_signer_provider_selection', [provider.uuid])
		const token = await beginSignerProviderSelection(beginRequest, 'app.example', true, 0)
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
		const pendingWrite = setChainChangeConfirmationPromise(pendingChainChange).then(() => { pendingWriteFinished = true })
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(pendingWriteFinished, false)
		assert.equal(storageState.chainChangeConfirmationPromise, undefined)
		assert.equal(registerTopSignerDocument({ tabId: 7, connectionName: 1n }, 'app.example'), false)
		await new Promise((resolve) => setTimeout(resolve, 0))
		assert.equal(pendingWriteFinished, false)

		finishSignerProviderSelection(createProviderMessage('finish_signer_provider_selection', [token]))
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
		const blockingToken = await acquireSignerSelectionLease(7)
		const staleBeginRequest = createProviderMessage('begin_signer_provider_selection', [provider.uuid])
		const queuedSelection = beginSignerProviderSelection(staleBeginRequest, 'app.example', true, 0)
		await new Promise((resolve) => setTimeout(resolve, 0))
		registerAuthoritativeTopSocket(newSocket, 'app.example')
		assert.equal(releaseSignerSelectionLease(7, blockingToken), true)
		assert.equal(await queuedSelection, undefined)

		const currentBeginRequest = {
			...createProviderMessage('begin_signer_provider_selection', [provider.uuid]),
			uniqueRequestIdentifier: { requestId: 2, requestSocket: newSocket },
		}
		const currentToken = await beginSignerProviderSelection(currentBeginRequest, 'app.example', true, 0)
		if (currentToken === undefined) throw new Error('The current document failed to acquire the released signer selection gate')
		finishSignerProviderSelection({ ...currentBeginRequest, method: 'finish_signer_provider_selection', params: [currentToken] })
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
		const oldSelection = beginSignerProviderSelection(oldBeginRequest, 'app.example', true, 0)
		await pendingReadStarted

		const newSocket = { tabId: 7, connectionName: 2n }
		assert.equal(registerTopSignerDocument(newSocket, 'app.example'), true)
		continuePendingRead?.()
		assert.equal(await oldSelection, undefined)

		const currentBeginRequest = {
			...createProviderMessage('begin_signer_provider_selection', [provider.uuid]),
			uniqueRequestIdentifier: { requestId: 2, requestSocket: newSocket },
		}
		const currentToken = await beginSignerProviderSelection(currentBeginRequest, 'app.example', true, 0)
		if (currentToken === undefined) throw new Error('The current document failed to acquire the signer selection gate')
		finishSignerProviderSelection({ ...currentBeginRequest, method: 'finish_signer_provider_selection', params: [currentToken] })
	})

	test('requests cached provider resynchronization when a disconnected child reconnects', async () => {
		installBrowserMock()
		const { getChildSignerConnectionSynchronization, signerProviderSelected, signerProvidersChanged } = await import('../../app/ts/background/signerProviderSelection.js')
		const { authorizeSocketForSignerExecution, registerCurrentChildSignerSocket, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner, unregisterCurrentChildSignerSocket } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const childSocket = { tabId: 7, connectionName: 2n }
		assert.equal(setSignerExecutionTarget(7, provider.uuid, 'app.example'), true)
		assert.equal(registerCurrentChildSignerSocket(childSocket, 2), true)
		assert.equal(reconcileSignerExecutionDocument(childSocket, 'app.example', DOCUMENT_GENERATION, false, 2), true)
		assert.equal(authorizeSocketForSignerExecution(childSocket, provider.uuid, 'app.example'), true)
		assert.equal(socketCanExecuteWithSelectedSigner(childSocket), true)
		assert.equal(unregisterCurrentChildSignerSocket(childSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(childSocket), false)

		const catalogResynchronizationNeeded = registerCurrentChildSignerSocket(childSocket, 2)
		assert.equal(catalogResynchronizationNeeded, true)
		assert.deepEqual(getChildSignerConnectionSynchronization(childSocket, 'app.example', catalogResynchronizationNeeded), {
			type: 'result',
			method: 'request_signer_provider_catalog',
			result: [],
		})
		const childCatalogRequest = {
			...createProviderMessage('signer_providers_changed', [[provider], false]),
			uniqueRequestIdentifier: { requestId: 3, requestSocket: childSocket },
		}
		const catalogReply = await signerProvidersChanged(childCatalogRequest, 'app.example', false, 2)
		assert.equal(catalogReply.selectedSignerProviderUuid, provider.uuid)
		const childSelectionRequest = {
			...createProviderMessage('signer_provider_selected', [provider, 'remembered']),
			uniqueRequestIdentifier: { requestId: 4, requestSocket: childSocket },
		}
		await signerProviderSelected(childSelectionRequest, 'app.example', false, 2, new Map())
		assert.equal(socketCanExecuteWithSelectedSigner(childSocket), true)
	})

	test('propagates exact UUID authority only to same-origin frames and requires their acknowledgement', async () => {
		installBrowserMock()
		const { signerProviderSelected } = await import('../../app/ts/background/signerProviderSelection.js')
		const { registerAuthoritativeTopSocket, registerCurrentChildSignerSocket, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const { updateTabState } = await import('../../app/ts/background/storageVariables.js')
		const topSocket = { tabId: 7, connectionName: 1n }
		const childSocket = { tabId: 7, connectionName: 2n }
		const crossOriginChildSocket = { tabId: 7, connectionName: 3n }
		registerAuthoritativeTopSocket(topSocket, 'app.example')
		registerCurrentChildSignerSocket(childSocket, 2)
		reconcileSignerExecutionDocument(childSocket, 'app.example', DOCUMENT_GENERATION, false, 2)
		setSignerExecutionTarget(7, provider.uuid, 'app.example')
		await updateTabState(7, (previousState) => ({ ...previousState, availableSignerProviders: [provider] }))
		const childMessages: unknown[] = []
		const crossOriginChildMessages: unknown[] = []
		const websiteTabConnections: WebsiteTabConnections = new Map([[7, { connections: {
			'7-0x1': { port: { postMessage: () => undefined }, socket: topSocket, websiteOrigin: 'app.example', frameId: 0, approved: true, wantsToConnect: true },
			'7-0x2': { port: { postMessage: (message: unknown) => childMessages.push(message) }, socket: childSocket, websiteOrigin: 'app.example', frameId: 2, approved: true, wantsToConnect: true },
			'7-0x3': { port: { postMessage: (message: unknown) => crossOriginChildMessages.push(message) }, socket: crossOriginChildSocket, websiteOrigin: 'frame.example', frameId: 3, approved: true, wantsToConnect: true },
		} }]])

		await signerProviderSelected(createProviderMessage('signer_provider_selected', [provider, 'explicit']), 'app.example', true, 0, websiteTabConnections)
		assert.equal(socketCanExecuteWithSelectedSigner(topSocket), true)
		assert.equal(socketCanExecuteWithSelectedSigner(childSocket), false)
		assert.equal(childMessages.length, 1)
		assert.deepEqual(crossOriginChildMessages, [])

		const childSelectionRequest = {
			...createProviderMessage('signer_provider_selected', [provider, 'explicit'], 7),
			uniqueRequestIdentifier: { requestId: 2, requestSocket: childSocket },
		}
		await signerProviderSelected(childSelectionRequest, 'app.example', false, 2, websiteTabConnections)
		assert.equal(socketCanExecuteWithSelectedSigner(childSocket), true)

		const crossOriginSelectionRequest = {
			...createProviderMessage('signer_provider_selected', [provider, 'explicit'], 7),
			uniqueRequestIdentifier: { requestId: 3, requestSocket: crossOriginChildSocket },
		}
		await assert.rejects(signerProviderSelected(crossOriginSelectionRequest, 'frame.example', false, 3, websiteTabConnections), /outside the tab execution authority/)
		assert.equal(socketCanExecuteWithSelectedSigner(crossOriginChildSocket), false)
	})

	test('blocks signer execution while superseding an old top-frame document', async () => {
		installBrowserMock()
		const { beginSignerProviderSelection, signerProviderSelected } = await import('../../app/ts/background/signerProviderSelection.js')
		const { authorizeSocketForSignerExecution, getSignerExecutionTargetForOrigin, isAuthoritativeTopSocket, registerAuthoritativeTopSocket, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const oldSocket = { tabId: 7, connectionName: 1n }
		const newSocket = { tabId: 7, connectionName: 2n }
		registerAuthoritativeTopSocket(oldSocket, 'app.example')
		setSignerExecutionTarget(7, provider.uuid, 'app.example')
		assert.equal(authorizeSocketForSignerExecution(oldSocket, provider.uuid, 'app.example'), true)
		registerAuthoritativeTopSocket(newSocket, 'app.example')
		assert.equal(isAuthoritativeTopSocket(oldSocket), false)
		assert.equal(isAuthoritativeTopSocket(newSocket), true)
		assert.equal(getSignerExecutionTargetForOrigin(7, 'app.example'), undefined)
		assert.equal(socketCanExecuteWithSelectedSigner(oldSocket), false)
		assert.equal(socketCanExecuteWithSelectedSigner(newSocket), false)

		const staleSelectionRequest = {
			...createProviderMessage('signer_provider_selected', [provider, 'explicit']),
			uniqueRequestIdentifier: { requestId: 2, requestSocket: oldSocket },
		}
		await assert.rejects(signerProviderSelected(staleSelectionRequest, 'app.example', false, 0, new Map()), /current top frame or child frame/)
		const staleBeginRequest = {
			...createProviderMessage('begin_signer_provider_selection', [provider.uuid]),
			uniqueRequestIdentifier: { requestId: 3, requestSocket: oldSocket },
		}
		assert.equal(await beginSignerProviderSelection(staleBeginRequest, 'app.example', false, 0), undefined)
	})

	test('turns unauthorized signer forwarding into a deterministic terminal rejection', async () => {
		installBrowserMock()
		const { replyToInterceptedRequest } = await import('../../app/ts/background/messageSending.js')
		const { setSignerExecutionTarget } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const childSocket = { tabId: 7, connectionName: 2n }
		const deliveredMessages: unknown[] = []
		const websiteTabConnections: WebsiteTabConnections = new Map([[7, { connections: {
			'7-0x2': { port: { postMessage: (message: unknown) => deliveredMessages.push(message) }, socket: childSocket, websiteOrigin: 'frame.example', frameId: 2, approved: true, wantsToConnect: true },
		} }]])
		setSignerExecutionTarget(7, provider.uuid, 'app.example')

		const delivered = replyToInterceptedRequest(websiteTabConnections, {
			...createProviderMessage('eth_sendTransaction', [{ from: '0x1111111111111111111111111111111111111111' }]),
			type: 'forwardToSigner',
			uniqueRequestIdentifier: { requestId: 4, requestSocket: childSocket },
		})

		assert.equal(delivered, true)
		const reply = deliveredMessages[0]
		assert.equal(isRecord(reply) && reply.type === 'result', true)
		assert.equal(isRecord(reply) && isRecord(reply.error) && reply.error.code === 4100, true)
	})

	test('blocks every background signer callback until the frame acknowledges the exact UUID', async () => {
		installBrowserMock()
		const { sendSubscriptionReplyOrCallBack } = await import('../../app/ts/background/messageSending.js')
		const { authorizeSocketForSignerExecution, registerCurrentChildSignerSocket, setSignerExecutionTarget } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const childSocket = { tabId: 7, connectionName: 2n }
		const deliveredMessages: unknown[] = []
		const websiteTabConnections: WebsiteTabConnections = new Map([[7, { connections: {
			'7-0x2': { port: { postMessage: (message: unknown) => deliveredMessages.push(message) }, socket: childSocket, websiteOrigin: 'frame.example', frameId: 2, approved: true, wantsToConnect: true },
		} }]])
		registerCurrentChildSignerSocket(childSocket, 2)
		reconcileSignerExecutionDocument(childSocket, 'app.example', DOCUMENT_GENERATION, false, 2)
		setSignerExecutionTarget(7, provider.uuid, 'app.example')

		sendSubscriptionReplyOrCallBack(websiteTabConnections, childSocket, { type: 'result', method: 'request_signer_to_eth_requestAccounts', result: [] })
		sendSubscriptionReplyOrCallBack(websiteTabConnections, childSocket, { type: 'result', method: 'request_signer_to_eth_accounts', result: [] })
		sendSubscriptionReplyOrCallBack(websiteTabConnections, childSocket, { type: 'result', method: 'request_signer_chainId', result: [] })
		sendSubscriptionReplyOrCallBack(websiteTabConnections, childSocket, { type: 'result', method: 'request_signer_to_wallet_switchEthereumChain', result: 1n })
		assert.deepEqual(deliveredMessages, [])

		assert.equal(authorizeSocketForSignerExecution(childSocket, provider.uuid, 'app.example'), true)
		sendSubscriptionReplyOrCallBack(websiteTabConnections, childSocket, { type: 'result', method: 'request_signer_to_eth_accounts', result: [] })
		assert.equal(deliveredMessages.length, 1)
	})

	test('clears signer authority state when a tab closes', async () => {
		installBrowserMock()
		const { authorizeSocketForSignerExecution, clearSignerExecutionAuthorityForTab, getSignerExecutionTargetForOrigin, isAuthoritativeTopSocket, setSignerExecutionTarget, socketCanExecuteWithSelectedSigner } = await import('../../app/ts/background/signerExecutionAuthority.js')
		const { acquireSignerSelectionLease, releaseSignerSelectionLease, releaseSignerSelectionLeasesForTab } = await import('../../app/ts/background/signerSelectionLease.js')
		const socket = { tabId: 7, connectionName: 1n }
		setSignerExecutionTarget(7, provider.uuid, 'app.example')
		assert.equal(authorizeSocketForSignerExecution(socket, provider.uuid, 'app.example'), true)
		const leaseToken = await acquireSignerSelectionLease(7)
		releaseSignerSelectionLeasesForTab(7)
		clearSignerExecutionAuthorityForTab(7)

		assert.equal(isAuthoritativeTopSocket(socket), false)
		assert.equal(getSignerExecutionTargetForOrigin(7, 'app.example'), undefined)
		assert.equal(socketCanExecuteWithSelectedSigner(socket), false)
		assert.equal(releaseSignerSelectionLease(7, leaseToken), false)
	})
})
