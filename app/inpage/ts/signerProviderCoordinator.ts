import { isEip6963ProviderInfo, type EIP6963ProviderInfo } from '../../ts/utils/eip6963ProviderInfo.js'
import { createSignerSelectionGate } from './signerSelectionGate.js'
import type { SignerName } from '../../ts/types/signerTypes.js'
import type { InternalProviderMethod } from '../../ts/utils/internalProviderMethods.js'

type SignerSelectionKind = 'explicit' | 'remembered'
type AnnouncedProvider = { readonly provider: unknown, readonly info: EIP6963ProviderInfo }

// Catalog decisions and selection gating live here; the transport owns wallet activation and background acknowledgements.
type SignerProviderTransport = {
	activateAnnouncedSigner(provider: unknown): boolean
	clearSigner(): void
	hasUsableSignerInterface(provider: unknown): provider is object
	completeSelection(info: EIP6963ProviderInfo, kind: SignerSelectionKind): Promise<void>
	isBridgeReconnectedError(error: unknown): boolean
	connectToSigner(signerName: SignerName): Promise<void>
	markInitialSignerProviderCatalogReconciled(): void
	reportSignerDiscoveryError(phase: string, error: unknown): void
	sendInternalMessageToBackgroundPage(request: { readonly method: InternalProviderMethod, readonly params?: readonly unknown[] }): Promise<unknown>
}

const MAX_EIP6963_PROVIDERS = 16
const MAX_EIP6963_CATALOG_CHARACTERS = 512_000
const MAX_CONFLICTING_EIP6963_UUIDS = 64

const getEip6963Announcement = (event: Event) => {
	if (!('detail' in event)) return undefined
	const detail = event.detail
	if (typeof detail !== 'object' || detail === null) return undefined
	const provider = Reflect.get(detail, 'provider')
	const announcedInfo = Reflect.get(detail, 'info')
	if (typeof announcedInfo !== 'object' || announcedInfo === null) return undefined
	const info = {
		uuid: Reflect.get(announcedInfo, 'uuid'),
		name: Reflect.get(announcedInfo, 'name'),
		icon: Reflect.get(announcedInfo, 'icon'),
		rdns: Reflect.get(announcedInfo, 'rdns'),
	}
	if (!isEip6963ProviderInfo(info)) return undefined
	return {
		provider,
		info: Object.freeze({ uuid: info.uuid, name: info.name, icon: info.icon, rdns: info.rdns.toLowerCase() }),
	}
}

export function createSignerProviderCoordinator(host: SignerProviderTransport) {
	const selectionGate = createSignerSelectionGate(() => {
		if (signerProviderCatalogRetryTimer === undefined && (signerProviderCatalogReconciliationNeeded || pendingExplicitSignerProviderUuid !== undefined)) enqueueProviderCatalogSynchronization()
	})
	const rejectedSignerProviders = new WeakSet<object>()
	const announcedProviders = new Map<string, AnnouncedProvider>()
	const conflictingProviderUuids = new Set<string>()
	let announcedProviderMetadataCharacters = 0
	let signerProviderCatalogOverflowed = false
	let preferredSignerRdns: string | undefined
	let selectedSignerProviderUuid: string | undefined
	let explicitlySelectedSignerProviderUuid: string | undefined
	let signerProviderCatalogTransition: Promise<void> = Promise.resolve()
	let signerProviderCatalogSynchronizationQueued = false
	let signerProviderCatalogReconciliationNeeded = false
	let signerProviderCatalogRetryTimer: ReturnType<typeof setTimeout> | undefined
	let signerProviderCatalogRetryDelayMilliseconds = 250
	let pendingExplicitSignerProviderUuid: string | undefined
	let signerCatalogDecisionGeneration = 0
	let signerProviderCatalogRevision = 0
	let pendingInitialSignerConnection: { readonly signerName: SignerName } | undefined

	const scheduleInitialSignerConnection = (signerName: SignerName) => {
		pendingInitialSignerConnection = { signerName }
		enqueueProviderCatalogSynchronization()
	}

	const connectToScheduledInitialSigner = () => {
		const pendingConnection = pendingInitialSignerConnection
		pendingInitialSignerConnection = undefined
		if (pendingConnection === undefined) return
		// Connection status is retried independently when the background worker or content port reconnects. Do not hold catalog reconciliation behind a status reply that may have been lost with the previous bridge.
		void host.connectToSigner(pendingConnection.signerName)
	}

	const applyAnnouncedProviderSelectionWithoutLease = async (uuid: string, selectionKind: SignerSelectionKind): Promise<boolean> => {
		pendingInitialSignerConnection = undefined
		const announcedProvider = announcedProviders.get(uuid)
		if (announcedProvider === undefined) throw new Error('The selected EIP-6963 provider is no longer available')
		const { provider, info } = announcedProvider
		if (selectedSignerProviderUuid === uuid) {
			// A worker restart needs fresh ownership and account replies even for the same provider object.
			await host.completeSelection(info, selectionKind)
			host.markInitialSignerProviderCatalogReconciled()
			return true
		}
		if (!host.activateAnnouncedSigner(provider)) {
			if (typeof provider === 'object' && provider !== null) rejectedSignerProviders.add(provider)
			if (announcedProviders.get(uuid) === announcedProvider) {
				announcedProviders.delete(uuid)
				announcedProviderMetadataCharacters -= getProviderMetadataCharacters(info)
				signerProviderCatalogRevision++
			}
			if (explicitlySelectedSignerProviderUuid === uuid) explicitlySelectedSignerProviderUuid = undefined
			if (pendingExplicitSignerProviderUuid === uuid) pendingExplicitSignerProviderUuid = undefined
			signerProviderCatalogReconciliationNeeded = true
			host.reportSignerDiscoveryError('select unusable EIP-6963 signer provider', new Error(`The selected EIP-6963 provider '${ info.name }' does not expose a usable EIP-1193 interface`))
			enqueueProviderCatalogSynchronization()
			return false
		}

		selectedSignerProviderUuid = uuid
		await host.completeSelection(info, selectionKind)
		host.markInitialSignerProviderCatalogReconciled()
		return true
	}

	const runWithSelectionLease = async (uuid: string | undefined, apply: () => Promise<boolean>): Promise<boolean> => {
		const capturedDecisionGeneration = signerCatalogDecisionGeneration
		const capturedCatalogRevision = signerProviderCatalogRevision
		const retry = () => {
			signerProviderCatalogReconciliationNeeded = true
			scheduleSignerProviderCatalogRetry()
			return false
		}
		const leaseToken = await host.sendInternalMessageToBackgroundPage({ method: 'begin_signer_provider_selection', params: [uuid] })
		if (leaseToken !== undefined && typeof leaseToken !== 'string') throw new Error('Failed to parse signer selection lease')
		if (leaseToken === undefined) return retry()
		try {
			if (selectionGate.hasExternalBlockers()
				|| capturedDecisionGeneration !== signerCatalogDecisionGeneration
				|| capturedCatalogRevision !== signerProviderCatalogRevision) return retry()
			return await apply()
		} finally {
			await host.sendInternalMessageToBackgroundPage({ method: 'finish_signer_provider_selection', params: [leaseToken] })
		}
	}

	const applyAnnouncedProviderSelection = async (uuid: string, selectionKind: SignerSelectionKind): Promise<boolean> => {
		const applied = await runWithSelectionLease(uuid, async () => await applyAnnouncedProviderSelectionWithoutLease(uuid, selectionKind))
		// Only selecting a provider has an explicit UUID to replay; clearing an unavailable preference does not.
		if (!applied && selectionKind === 'explicit' && announcedProviders.has(uuid)) pendingExplicitSignerProviderUuid = uuid
		return applied
	}

	const selectAnnouncedProvider = async (uuid: string, selectionKind: SignerSelectionKind): Promise<void> => {
		const announcedProvider = announcedProviders.get(uuid)
		if (announcedProvider === undefined) {
			if (selectionKind === 'explicit' && !signerProviderCatalogOverflowed) {
				signerCatalogDecisionGeneration++
				pendingExplicitSignerProviderUuid = uuid
				signerProviderCatalogReconciliationNeeded = true
				return
			}
			throw new Error('The selected EIP-6963 provider is no longer available')
		}
		if (selectionKind === 'explicit') {
			signerCatalogDecisionGeneration++
			explicitlySelectedSignerProviderUuid = uuid
			preferredSignerRdns = announcedProvider.info.rdns
			if (!selectionGate.isIdle()) {
				pendingExplicitSignerProviderUuid = uuid
				signerProviderCatalogReconciliationNeeded = true
				return
			}
			pendingExplicitSignerProviderUuid = undefined
		}
		await selectionGate.runSelection(async () => await applyAnnouncedProviderSelection(uuid, selectionKind))
	}

	const clearUnavailablePreferredSigner = async (force = false): Promise<void> => {
		if (preferredSignerRdns === undefined) {
			host.markInitialSignerProviderCatalogReconciled()
			return
		}
		if (!selectionGate.isIdle()) {
			signerProviderCatalogReconciliationNeeded = true
			return
		}
		const selectedProvider = selectedSignerProviderUuid === undefined ? undefined : announcedProviders.get(selectedSignerProviderUuid)
		if (!force && selectedProvider?.info.rdns === preferredSignerRdns) {
			host.markInitialSignerProviderCatalogReconciled()
			return
		}
		await selectionGate.runSelection(async () => await runWithSelectionLease(undefined, async () => {
			host.clearSigner()
			selectedSignerProviderUuid = undefined
			explicitlySelectedSignerProviderUuid = undefined
			await host.connectToSigner('NoSigner')
			host.markInitialSignerProviderCatalogReconciled()
			return true
		}))
	}

	const synchronizeAnnouncedProviders = async (): Promise<void> => {
		if (!selectionGate.isIdle()) {
			signerProviderCatalogReconciliationNeeded = true
			return
		}
		const catalogDecisionGeneration = signerCatalogDecisionGeneration
		const catalogRevision = signerProviderCatalogRevision
		const providers = [...announcedProviders.values()].map((announcement) => announcement.info)
		const reply = await host.sendInternalMessageToBackgroundPage({ method: 'signer_providers_changed', params: [providers, signerProviderCatalogOverflowed] })
		if (typeof reply !== 'object'
			|| reply === null
			|| !('automaticSelectionAllowed' in reply)
			|| !('signerSelectionChangeAllowed' in reply)) throw new Error('Failed to parse signer_providers_changed reply')
		const replyPreferredRdns = 'preferredSignerRdns' in reply ? reply.preferredSignerRdns : undefined
		const automaticSelectionAllowed = reply.automaticSelectionAllowed
		const signerSelectionChangeAllowed = reply.signerSelectionChangeAllowed
		if (replyPreferredRdns !== undefined && typeof replyPreferredRdns !== 'string') throw new Error('Failed to parse preferred signer RDNS')
		if (typeof automaticSelectionAllowed !== 'boolean') throw new Error('Failed to parse automatic signer selection permission')
		if (typeof signerSelectionChangeAllowed !== 'boolean') throw new Error('Failed to parse signer selection change permission')
		if ('legacySignerAllowed' in reply && reply.legacySignerAllowed !== undefined && typeof reply.legacySignerAllowed !== 'boolean') throw new Error('Failed to parse legacy signer permission')
		if ('selectedSignerProviderUuid' in reply && reply.selectedSignerProviderUuid !== undefined && typeof reply.selectedSignerProviderUuid !== 'string') throw new Error('Failed to parse selected signer provider UUID')
		if (catalogDecisionGeneration !== signerCatalogDecisionGeneration || catalogRevision !== signerProviderCatalogRevision) return
		if ('signerFrameIneligible' in reply && reply.signerFrameIneligible === true) {
			// A frame with a different origin or no matching provider can use simulation APIs without waiting for signer authority.
			pendingInitialSignerConnection = undefined
			clearSignerProviderCatalogRetry()
			host.markInitialSignerProviderCatalogReconciled()
			return
		}
		if (!signerSelectionChangeAllowed) {
			signerProviderCatalogReconciliationNeeded = true
			scheduleSignerProviderCatalogRetry()
			return
		}
		clearSignerProviderCatalogRetry()
		if (!selectionGate.isIdle()) {
			signerProviderCatalogReconciliationNeeded = true
			return
		}
		preferredSignerRdns = replyPreferredRdns?.toLowerCase()
		if ('selectedSignerProviderUuid' in reply && typeof reply.selectedSignerProviderUuid === 'string') {
			const selectedSignerProviderUuid = reply.selectedSignerProviderUuid
			await selectionGate.runSelection(async () => await applyAnnouncedProviderSelection(selectedSignerProviderUuid, 'remembered'))
			return
		}
		if (replyPreferredRdns === undefined) {
			if (!('legacySignerAllowed' in reply) || reply.legacySignerAllowed !== false) await connectToScheduledInitialSigner()
			host.markInitialSignerProviderCatalogReconciled()
			return
		}
		pendingInitialSignerConnection = undefined
		if (explicitlySelectedSignerProviderUuid !== undefined) {
			const explicitlySelectedProvider = announcedProviders.get(explicitlySelectedSignerProviderUuid)
			if (explicitlySelectedProvider === undefined || explicitlySelectedProvider.info.rdns !== preferredSignerRdns) {
				await clearUnavailablePreferredSigner(true)
				return
			}
			if (selectedSignerProviderUuid !== explicitlySelectedProvider.info.uuid) {
				await selectionGate.runSelection(async () => await applyAnnouncedProviderSelection(explicitlySelectedProvider.info.uuid, 'explicit'))
			}
			if (selectedSignerProviderUuid === explicitlySelectedProvider.info.uuid) host.markInitialSignerProviderCatalogReconciled()
			return
		}
		if (!automaticSelectionAllowed) {
			await clearUnavailablePreferredSigner(true)
			return
		}
		const preferredProviders = [...announcedProviders.values()].filter((announcement) => announcement.info.rdns === preferredSignerRdns)
		if (preferredProviders.length !== 1) {
			await clearUnavailablePreferredSigner(true)
			return
		}
		const preferredProvider = preferredProviders[0]
		if (preferredProvider === undefined) return
		await selectAnnouncedProvider(preferredProvider.info.uuid, 'remembered')
	}

	const clearSignerProviderCatalogRetry = () => {
		if (signerProviderCatalogRetryTimer !== undefined) clearTimeout(signerProviderCatalogRetryTimer)
		signerProviderCatalogRetryTimer = undefined
		signerProviderCatalogRetryDelayMilliseconds = 250
	}

	const scheduleSignerProviderCatalogRetry = () => {
		if (signerProviderCatalogRetryTimer !== undefined) return
		const retryDelayMilliseconds = signerProviderCatalogRetryDelayMilliseconds
		signerProviderCatalogRetryTimer = setTimeout(() => {
			signerProviderCatalogRetryTimer = undefined
			enqueueProviderCatalogSynchronization()
		}, retryDelayMilliseconds)
		signerProviderCatalogRetryDelayMilliseconds = Math.min(retryDelayMilliseconds * 2, 5000)
	}

	const reconcileSignerProviderCatalog = async (): Promise<void> => {
		if (!selectionGate.isIdle()) {
			signerProviderCatalogReconciliationNeeded = true
			return
		}
		const pendingUuid = pendingExplicitSignerProviderUuid
		if (pendingUuid !== undefined
			&& !announcedProviders.has(pendingUuid)
			&& !signerProviderCatalogOverflowed) return
		pendingExplicitSignerProviderUuid = undefined
		signerProviderCatalogReconciliationNeeded = false
		if (pendingUuid !== undefined) {
			try {
				// Rebuild background document authority before replaying the user's selection after a worker restart.
				await synchronizeAnnouncedProviders()
				await selectionGate.runSelection(async () => await applyAnnouncedProviderSelection(pendingUuid, 'explicit'))
			} catch (error: unknown) {
				host.reportSignerDiscoveryError('apply deferred EIP-6963 signer selection', error)
			}
		}
		if (pendingExplicitSignerProviderUuid !== undefined) return
		try {
			await synchronizeAnnouncedProviders()
		} catch (error: unknown) {
			if (!host.isBridgeReconnectedError(error)) throw error
			signerProviderCatalogReconciliationNeeded = true
			enqueueProviderCatalogSynchronization()
		}
	}

	const enqueueProviderCatalogSynchronization = (): void => {
		if (signerProviderCatalogSynchronizationQueued) return
		signerProviderCatalogSynchronizationQueued = true
		queueMicrotask(() => {
			signerProviderCatalogSynchronizationQueued = false
			const synchronize = async () => await reconcileSignerProviderCatalog()
			const transition = signerProviderCatalogTransition.then(synchronize, synchronize)
			signerProviderCatalogTransition = transition.catch((error: unknown) => {
				host.markInitialSignerProviderCatalogReconciled()
				host.reportSignerDiscoveryError('synchronize EIP-6963 providers', error)
			})
		})
	}

	const getProviderMetadataCharacters = (info: EIP6963ProviderInfo) => info.uuid.length + info.name.length + info.icon.length + info.rdns.length

	const quarantineConflictingProviderUuid = (uuid: string) => {
		if (conflictingProviderUuids.size >= MAX_CONFLICTING_EIP6963_UUIDS) {
			if (!signerProviderCatalogOverflowed) {
				signerProviderCatalogOverflowed = true
				signerProviderCatalogRevision++
			}
			return
		}
		conflictingProviderUuids.add(uuid)
	}

	const collectAnnouncedProvider = (event: Event) => {
		let announcement: ReturnType<typeof getEip6963Announcement>
		try {
			announcement = getEip6963Announcement(event)
		} catch (error: unknown) {
			host.reportSignerDiscoveryError('read EIP-6963 provider announcement', error)
			return
		}
		if (announcement === undefined) return
		const { provider, info } = announcement
		if (info.rdns === 'dark.florist' && info.name === 'The Interceptor') return
		try {
			if (!host.hasUsableSignerInterface(provider)) return
		} catch (error: unknown) {
			host.reportSignerDiscoveryError('validate EIP-6963 provider interface', error)
			return
		}
		if (rejectedSignerProviders.has(provider)) return
		if (conflictingProviderUuids.has(info.uuid)) return
		const existingAnnouncement = announcedProviders.get(info.uuid)
		if (existingAnnouncement !== undefined) {
			// Re-announcements may wrap the provider again. Keep the original object so duplicate metadata cannot replace the user's selected signer.
			if (existingAnnouncement.info.name === info.name
				&& existingAnnouncement.info.icon === info.icon
				&& existingAnnouncement.info.rdns === info.rdns) return
			announcedProviders.delete(info.uuid)
			signerProviderCatalogRevision++
			announcedProviderMetadataCharacters -= getProviderMetadataCharacters(existingAnnouncement.info)
			quarantineConflictingProviderUuid(info.uuid)
			host.reportSignerDiscoveryError('deduplicate EIP-6963 provider announcement', new Error(`Conflicting announcements used UUID ${ info.uuid }; both were excluded`))
			enqueueProviderCatalogSynchronization()
			return
		}
		if (signerProviderCatalogOverflowed) return
		const metadataCharacters = getProviderMetadataCharacters(info)
		if (announcedProviders.size >= MAX_EIP6963_PROVIDERS
			|| announcedProviderMetadataCharacters + metadataCharacters > MAX_EIP6963_CATALOG_CHARACTERS) {
			if (!signerProviderCatalogOverflowed) {
				signerProviderCatalogOverflowed = true
				signerProviderCatalogRevision++
				enqueueProviderCatalogSynchronization()
			}
			return
		}
		announcedProviders.set(info.uuid, { provider, info })
		signerProviderCatalogRevision++
		announcedProviderMetadataCharacters += metadataCharacters
		enqueueProviderCatalogSynchronization()
	}


	return {
		rejectProvider: (provider: object) => { rejectedSignerProviders.add(provider) },
		isProviderRejected: (provider: object) => rejectedSignerProviders.has(provider),
		blockSignerSelection: selectionGate.block,
		runWithSignerSelectionBlocked: selectionGate.runBlocked,
		handleBridgeReconnect: () => {
			signerProviderCatalogReconciliationNeeded = true
			if (explicitlySelectedSignerProviderUuid !== undefined) pendingExplicitSignerProviderUuid = explicitlySelectedSignerProviderUuid
		},
		scheduleInitialSignerConnection,
		selectAnnouncedProvider,
		enqueueProviderCatalogSynchronization,
		collectAnnouncedProvider,
	}
}
