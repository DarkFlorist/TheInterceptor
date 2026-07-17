import { BeginSignerProviderSelection, FinishSignerProviderSelection, SignerProviderSelected, SignerProvidersChanged, type SelectSignerProvider, type SubscriptionReplyOrCallBack } from '../types/interceptor-messages.js'
import type { TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import type { ProviderMessage } from '../utils/requests.js'
import { modifyObject } from '../utils/typescript.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'
import { getChainChangeConfirmationPromise, getPendingTransactionsAndMessages, getSignerPreference, getTabState, setSignerPreference, updateTabState } from './storageVariables.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { acquireSignerSelectionLease, releaseSignerSelectionLease, signerSelectionLeaseIsActive } from './signerSelectionLease.js'
import { allowLegacySignerExecution, authorizeSocketForLegacySignerExecution, authorizeSocketForSignerExecution, blockSignerExecution, getSignerExecutionTargetForSocket, isAuthoritativeTopSocket, reconcileSignerExecutionDocument, setSignerExecutionTarget, socketIsEligibleForSignerExecution } from './signerExecutionAuthority.js'

const tabHasPendingSignerWork = async (tabId: number) => {
	const [pendingSignerRequests, pendingChainChange] = await Promise.all([
		getPendingTransactionsAndMessages(),
		getChainChangeConfirmationPromise(),
	])
	return pendingSignerRequests.some((pending) => pending.uniqueRequestIdentifier.requestSocket.tabId === tabId)
		|| pendingChainChange?.request.uniqueRequestIdentifier.requestSocket.tabId === tabId
}

export function getChildSignerConnectionSynchronization(socket: ProviderMessage['uniqueRequestIdentifier']['requestSocket'], websiteOrigin: string, catalogResynchronizationNeeded: boolean): SubscriptionReplyOrCallBack | undefined {
	if (catalogResynchronizationNeeded) return { type: 'result', method: 'request_signer_provider_catalog', result: [] }
	const signerExecutionTarget = getSignerExecutionTargetForSocket(socket, websiteOrigin)
	if (signerExecutionTarget === undefined) return undefined
	return { type: 'result', method: 'select_signer_provider', result: signerExecutionTarget }
}

export async function beginSignerProviderSelection(request: ProviderMessage, websiteOrigin: string, isTopFrame: boolean, frameId: number | undefined) {
	const [providerUuid] = BeginSignerProviderSelection.parse(request).params
	const socket = request.uniqueRequestIdentifier.requestSocket
	const tabId = socket.tabId
	const socketCanSelectProvider = () => isTopFrame
		? isAuthoritativeTopSocket(socket)
		: frameId !== undefined && frameId !== 0 && providerUuid !== undefined && getSignerExecutionTargetForSocket(socket, websiteOrigin) === providerUuid
	if (!socketCanSelectProvider()) return undefined
	const token = await acquireSignerSelectionLease(tabId)
	if (!socketCanSelectProvider()) {
		releaseSignerSelectionLease(tabId, token)
		return undefined
	}
	const hasPendingSignerWork = await tabHasPendingSignerWork(tabId)
	if (!socketCanSelectProvider() || !signerSelectionLeaseIsActive(tabId, token)) {
		releaseSignerSelectionLease(tabId, token)
		return undefined
	}
	if (!hasPendingSignerWork) return token
	releaseSignerSelectionLease(tabId, token)
	return undefined
}

export function finishSignerProviderSelection(request: ProviderMessage) {
	const [token] = FinishSignerProviderSelection.parse(request).params
	const tabId = request.uniqueRequestIdentifier.requestSocket.tabId
	if (!releaseSignerSelectionLease(tabId, token)) throw new Error('The signer selection lease is no longer active')
}

export async function signerProvidersChanged(request: ProviderMessage, websiteOrigin: string, isTopFrame: boolean, frameId: number | undefined = isTopFrame ? 0 : undefined) {
	const [announcedProviders, signerProviderCatalogOverflowed, documentGeneration] = SignerProvidersChanged.parse(request).params
	const socket = request.uniqueRequestIdentifier.requestSocket
	if (!reconcileSignerExecutionDocument(socket, websiteOrigin, documentGeneration, isTopFrame, frameId)) return { preferredSignerRdns: undefined, automaticSelectionAllowed: false, signerSelectionChangeAllowed: false, legacySignerAllowed: false }
	if (!isTopFrame) {
		const executionTarget = getSignerExecutionTargetForSocket(socket, websiteOrigin)
		const selectedSignerProviderUuid = announcedProviders.some((provider) => provider.uuid === executionTarget) ? executionTarget : undefined
		const legacySignerAllowed = authorizeSocketForLegacySignerExecution(socket, websiteOrigin)
		return {
			preferredSignerRdns: undefined,
			automaticSelectionAllowed: false,
			signerSelectionChangeAllowed: selectedSignerProviderUuid !== undefined || legacySignerAllowed,
			legacySignerAllowed,
			...(selectedSignerProviderUuid === undefined ? {} : { selectedSignerProviderUuid }),
		}
	}
	const providers = announcedProviders.map((provider) => ({ ...provider, rdns: provider.rdns.toLowerCase() }))
	const tabId = request.uniqueRequestIdentifier.requestSocket.tabId
	const [preferredSignerPreference, pendingSignerRequests, pendingChainChange] = await Promise.all([
		getSignerPreference(websiteOrigin),
		getPendingTransactionsAndMessages(),
		getChainChangeConfirmationPromise(),
	])
	if (!isAuthoritativeTopSocket(socket)) return { preferredSignerRdns: undefined, automaticSelectionAllowed: false, signerSelectionChangeAllowed: false, legacySignerAllowed: false }
	const preferredSignerRdns = preferredSignerPreference?.rdns
	const signerSelectionChangeAllowed = !pendingSignerRequests.some((pending) => pending.uniqueRequestIdentifier.requestSocket.tabId === tabId)
		&& pendingChainChange?.request.uniqueRequestIdentifier.requestSocket.tabId !== tabId
	await updateTabState(request.uniqueRequestIdentifier.requestSocket.tabId, (previousState: TabState) => {
		if (!isAuthoritativeTopSocket(request.uniqueRequestIdentifier.requestSocket)) return previousState
		if (!signerSelectionChangeAllowed) return modifyObject(previousState, {
			availableSignerProviders: providers,
			signerProviderCatalogOverflowed,
		})
		const previouslySelectedProvider = previousState.selectedSignerProvider === undefined
			? undefined
			: providers.find((provider) => provider.uuid === previousState.selectedSignerProvider?.uuid)
		const matchingPreferredProviders = preferredSignerRdns === undefined ? [] : providers.filter((provider) => provider.rdns === preferredSignerRdns)
		const preserveExplicitSelection = previouslySelectedProvider !== undefined
			&& previousState.explicitlySelectedSignerProviderUuid === previouslySelectedProvider.uuid
		const preferredSignerUnavailable = preferredSignerRdns !== undefined
			&& !preserveExplicitSelection
			&& (signerProviderCatalogOverflowed || matchingPreferredProviders.length !== 1)
		const selectedSignerProvider = preserveExplicitSelection
			? previouslySelectedProvider
			: preferredSignerRdns === undefined
			? previouslySelectedProvider
			: !signerProviderCatalogOverflowed && matchingPreferredProviders.length === 1 && previouslySelectedProvider?.uuid === matchingPreferredProviders[0]?.uuid
				? previouslySelectedProvider
				: undefined
		const clearSignerState = preferredSignerUnavailable
			|| (previousState.selectedSignerProvider !== undefined && selectedSignerProvider === undefined)
		return modifyObject(previousState, {
			availableSignerProviders: providers,
			selectedSignerProvider,
			explicitlySelectedSignerProviderUuid: preserveExplicitSelection ? previouslySelectedProvider.uuid : undefined,
			preferredSignerUnavailable,
			signerProviderCatalogOverflowed,
			...(clearSignerState ? {
				signerName: 'NoSigner',
				signerConnected: true,
				signerAccounts: [],
				signerAccountError: undefined,
				signerChain: undefined,
				activeSigningAddress: undefined,
			} : {}),
		})
	})
	if (!signerSelectionChangeAllowed) {
		return { preferredSignerRdns, automaticSelectionAllowed: !signerProviderCatalogOverflowed, signerSelectionChangeAllowed: false, legacySignerAllowed: false }
	}
	const updatedState = await getTabState(tabId)
	if (!isAuthoritativeTopSocket(socket)) return { preferredSignerRdns: undefined, automaticSelectionAllowed: false, signerSelectionChangeAllowed: false, legacySignerAllowed: false }
	if (updatedState.selectedSignerProvider !== undefined) {
		setSignerExecutionTarget(tabId, updatedState.selectedSignerProvider.uuid, websiteOrigin)
	} else if (preferredSignerRdns !== undefined) {
		blockSignerExecution(tabId)
	} else {
		allowLegacySignerExecution(socket, websiteOrigin)
	}
	await sendPopupMessageToOpenWindows({ method: 'popup_signer_name_changed' })
	return { preferredSignerRdns, automaticSelectionAllowed: !signerProviderCatalogOverflowed, signerSelectionChangeAllowed, legacySignerAllowed: preferredSignerRdns === undefined }
}

export async function signerProviderSelected(request: ProviderMessage, websiteOrigin: string, isTopFrame: boolean, frameId: number | undefined, websiteTabConnections: WebsiteTabConnections) {
	const [announcedProvider, selectionKind] = SignerProviderSelected.parse(request).params
	const provider = { ...announcedProvider, rdns: announcedProvider.rdns.toLowerCase() }
	const tabId = request.uniqueRequestIdentifier.requestSocket.tabId
	if (!isTopFrame) {
		if (frameId === undefined || frameId === 0) throw new Error('Only a current top frame or child frame can select a signer provider')
		if (!authorizeSocketForSignerExecution(request.uniqueRequestIdentifier.requestSocket, provider.uuid, websiteOrigin)) throw new Error('The frame selected a signer outside the tab execution authority')
		return
	}
	const currentTabState = await getTabState(request.uniqueRequestIdentifier.requestSocket.tabId)
	if (!isAuthoritativeTopSocket(request.uniqueRequestIdentifier.requestSocket)) return
	const matchingProvider = currentTabState.availableSignerProviders?.find((announcedProvider) => announcedProvider.uuid === provider.uuid)
	if (matchingProvider === undefined
		|| matchingProvider.rdns !== provider.rdns
		|| matchingProvider.name !== provider.name
		|| matchingProvider.icon !== provider.icon) throw new Error('The selected signer was not present in the announced provider catalog')
	await setSignerPreference(websiteOrigin, provider.rdns)
	if (!isAuthoritativeTopSocket(request.uniqueRequestIdentifier.requestSocket)) return
	if (!setSignerExecutionTarget(tabId, provider.uuid, websiteOrigin)) return
	authorizeSocketForSignerExecution(request.uniqueRequestIdentifier.requestSocket, provider.uuid, websiteOrigin)
	await updateTabState(request.uniqueRequestIdentifier.requestSocket.tabId, (previousState: TabState) => {
		if (!isAuthoritativeTopSocket(request.uniqueRequestIdentifier.requestSocket)) return previousState
		return modifyObject(previousState, {
			signerName: provider.name,
			signerConnected: true,
			signerAccounts: [],
			signerAccountError: undefined,
			signerChain: undefined,
			activeSigningAddress: undefined,
			selectedSignerProvider: provider,
			explicitlySelectedSignerProviderUuid: selectionKind === 'explicit' ? provider.uuid : undefined,
			preferredSignerUnavailable: false,
		})
	})
	if (!isAuthoritativeTopSocket(request.uniqueRequestIdentifier.requestSocket)) return
	await sendPopupMessageToOpenWindows({ method: 'popup_signer_name_changed' })
	const tabConnections = websiteTabConnections.get(tabId)
	if (tabConnections === undefined) return
	for (const connection of Object.values(tabConnections.connections)) {
		if (connection.socket.connectionName === request.uniqueRequestIdentifier.requestSocket.connectionName) continue
		if (connection.websiteOrigin !== websiteOrigin) continue
		if (!socketIsEligibleForSignerExecution(connection.socket, websiteOrigin)) continue
		if (connection.frameId === 0 && !isAuthoritativeTopSocket(connection.socket)) continue
		sendSubscriptionReplyOrCallBack(websiteTabConnections, connection.socket, { type: 'result', method: 'select_signer_provider', result: provider.uuid })
	}
}

export async function selectSignerProvider(websiteTabConnections: WebsiteTabConnections, request: SelectSignerProvider) {
	if (await tabHasPendingSignerWork(request.data.tabId)) throw new Error('Resolve the pending signer request or chain change before switching wallets')
	const tabState = await getTabState(request.data.tabId)
	if (tabState.website?.websiteOrigin !== request.data.websiteOrigin) throw new Error('The signer selection does not match the current website')
	if (tabState.availableSignerProviders?.some((provider) => provider.uuid === request.data.uuid) !== true) throw new Error('The selected signer provider is no longer available')

	const tabConnections = websiteTabConnections.get(request.data.tabId)
	if (tabConnections === undefined) throw new Error('The selected website is no longer connected')
	const matchingConnections = Object.values(tabConnections.connections).filter((connection) => connection.websiteOrigin === request.data.websiteOrigin)
	const connection = matchingConnections.find((candidate) => candidate.frameId === 0 && isAuthoritativeTopSocket(candidate.socket))
	if (connection === undefined) throw new Error('The selected website top-frame connection is no longer available')
	const sent = sendSubscriptionReplyOrCallBack(websiteTabConnections, connection.socket, {
		type: 'result',
		method: 'select_signer_provider',
		result: request.data.uuid,
	})
	if (!sent) throw new Error('Failed to deliver the signer selection to the website')
}
