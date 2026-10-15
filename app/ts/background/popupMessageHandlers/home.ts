import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../../simulation/services/priceEstimator.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import type { ChangeActiveAddress, ModifyMakeMeRich, Settings, UpdateHomePage } from '../../types/interceptor-messages.js'
import type { TabState, WebsiteTabConnections } from '../../types/user-interface-types.js'
import type { CompleteVisualizedSimulation } from '../../types/visualizer-types.js'
import { assertActiveAddressSelectionAllowed, getActiveAddressSelection, getWalletSelectedAccount } from '../../utils/activeAddressSelection.js'
import { checksummedAddress } from '../../utils/bigint.js'
import { getErrorMessage, isExpectedInfrastructureError, reportUnexpectedError } from '../../utils/errors.js'
import { POPUP_PERFORMANCE_MARKS, markPerformance } from '../../utils/popupPerformance.js'
import { silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import { updateRichListAddress } from '../../utils/richList.js'
import { getLatestUnexpectedError } from '../../utils/unexpectedErrorStorage.js'
import { activateAddressSelection } from '../activeSettings.js'
import { getActiveOrFirstSignerAddress, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { getCurrentTabSignerAccount, getLastKnownCurrentTabId } from '../currentTab.js'
import { getActiveAddressEntryForChain, getActiveAddresses, identifyAddress } from '../metadataUtils.js'
import { updatePopupVisualisationIfNeeded } from '../popupVisualisationUpdater.js'
import type { PublishRpcConnectionStatus } from '../rpcSlowRequestTracking.js'
import { getFixedAddressRichList, getMakeCurrentAddressRich, getPreSimulationBlockTimeManipulation, getSettings, updateFixedMakeMeRichList, updateMakeCurrentAddressRich } from '../settings.js'
import { getActiveAddressForCurrentSignerState, sendCallbackToAllConfirmedSignerOwners } from '../signerStateOwnership.js'
import { updateSimulationMetadata } from '../simulationUpdating.js'
import { makeSureInterceptorIsNotSleeping } from '../sleeping.js'
import { getPopupVisualisationState, getRpcConnectionStatus, getRpcList, getSafeTransactionStacks, getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst } from '../storageVariables.js'
import { askForSignerAccountsFromSignerIfNotAvailable, getAddressMetadataForAccess, refreshSignerAccountsFromApprovedWebsitePorts } from '../windows/interceptorAccess.js'

function isInterceptorDisabledForWebsite(settings: Settings, websiteOrigin: string | undefined) {
	if (websiteOrigin === undefined) return false
	return settings.websiteAccess.some((entry) => entry.website.websiteOrigin === websiteOrigin && entry.interceptorDisabled === true)
}

async function refreshSignerAccountsForTabIfNeeded(websiteTabConnections: WebsiteTabConnections, tabId: number | undefined, tabState: TabState, shouldRefreshSignerAccounts: boolean) {
	if (!shouldRefreshSignerAccounts || tabId === undefined) return tabState
	if (tabState.signerAccounts.length !== 0) return tabState
	if (tabState.signerName === 'NoSigner' || tabState.signerName === 'NoSignerDetected') return tabState

	const tabConnections = websiteTabConnections.get(tabId)
	if (tabConnections === undefined) return tabState
	const approvedConnection = Object.values(tabConnections.connections).find((connection) => connection.approved)
	if (approvedConnection === undefined) return tabState

	await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, approvedConnection.socket, false)
	return await getTabState(tabId)
}

async function getWalletSelectedAddressBookEntry(tabState: TabState, chainId: bigint) {
	const walletSelectedAccount = getWalletSelectedAccount(tabState)
	if (walletSelectedAccount === undefined) return undefined
	return (await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId)).find((entry) => entry.address === walletSelectedAccount)
}

async function getActiveAddressForCurrentPopupSignerState(settings: Settings, websiteTabConnections: WebsiteTabConnections, tabId: number) {
	return await getActiveAddressForCurrentSignerState(websiteTabConnections, settings, tabId, async () => await getActiveOrFirstSignerAddress(settings, tabId))
}

export async function changeActiveAddress(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, addressChange: ChangeActiveAddress) {
	if (addressChange.data.activeAddress === 'signer') {
		await refreshSignerAccountsFromApprovedWebsitePorts(websiteTabConnections, false)
		sendCallbackToAllConfirmedSignerOwners(websiteTabConnections, { method: 'request_signer_chainId', result: [] })
	}
	const settings = await getSettings()
	const signerAccount = await getCurrentTabSignerAccount()
	const activeAddresses = await getActiveAddresses()
	const signerAccounts = signerAccount === undefined ? [] : [signerAccount]
	const selection = getActiveAddressSelection(addressChange.data.activeAddress, activeAddresses, addressChange.data.simulationMode, settings.activeRpcNetwork.chainId, signerAccounts)
	if (selection === undefined) {
		if (!addressChange.data.simulationMode) {
			if (addressChange.data.activeAddress === 'signer') {
				await activateAddressSelection(simulationServicesOwner, websiteTabConnections, undefined, {
					simulationMode: false,
					signerAddress: undefined,
				})
				return { type: 'ChangeActiveAddressReply', ok: true } as const
			}
		}
		try {
			assertActiveAddressSelectionAllowed(addressChange.data.activeAddress, activeAddresses, addressChange.data.simulationMode, settings.activeRpcNetwork.chainId, signerAccounts)
		} catch (error) {
			return {
				type: 'ChangeActiveAddressReply',
				ok: false,
				message: error instanceof Error ? error.message : 'The selected address is not available.',
			} as const
		}
		return { type: 'ChangeActiveAddressReply', ok: false, message: 'The selected address is not available.' } as const
	}
	await activateAddressSelection(simulationServicesOwner, websiteTabConnections, selection, {
		simulationMode: addressChange.data.simulationMode,
		signerAddress: signerAccount,
	})
	return { type: 'ChangeActiveAddressReply', ok: true } as const
}

export async function modifyMakeMeRich(makeMeRichChange: ModifyMakeMeRich) {
	if (makeMeRichChange.data.address === 'CurrentAddress') {
		return await updateMakeCurrentAddressRich(() => makeMeRichChange.data.add)
	}
	const address = makeMeRichChange.data.address
	return await updateFixedMakeMeRichList((currentList) => updateRichListAddress(
		currentList,
		address,
		makeMeRichChange.data.add,
		(element) => element.address,
		() => ({
			address,
			makingRich: true,
			type: 'UserAdded' as const
		}),
	))
}

export async function requestNewHomeData(
	ethereum: EthereumClientService,
	websiteTabConnections: WebsiteTabConnections,
	shouldRefreshSignerAccounts: boolean,
	includeWebsiteAccessAddressMetadata: boolean,
	requestAbortController: AbortController | undefined,
	popupRefreshGeneration: number,
) {
	const updatedPage = await buildHomePageUpdate(ethereum, websiteTabConnections, {
		requestAbortController,
		richDataSource: 'cached',
		shouldRefreshSignerAccounts,
		includeWebsiteAccessAddressMetadata,
		popupRefreshGeneration,
	})
	await sendPopupMessageToOpenWindows(updatedPage)
}

export async function requestHomePageBootstrap(websiteTabConnections: WebsiteTabConnections, popupRefreshGeneration: number) {
	const settingsPromise = silenceChromeUnCaughtPromise(getSettings())
	const rpcEntriesPromise = silenceChromeUnCaughtPromise(getRpcList())
	const activeAddressesPromise = silenceChromeUnCaughtPromise(getActiveAddresses())
	const safeTransactionStacksPromise = silenceChromeUnCaughtPromise(getSafeTransactionStacks())
	const tabId = await getLastKnownCurrentTabId()
	const tabStatePromise = silenceChromeUnCaughtPromise(tabId === undefined ? getTabState(-1) : getTabState(tabId))
	const settings = await settingsPromise
	const tabState = await tabStatePromise
	const activeSigningAddress = tabId === undefined ? undefined : (await getActiveAddressForCurrentPopupSignerState(settings, websiteTabConnections, tabId))?.address
	const walletSelectedAddressBookEntry = await getWalletSelectedAddressBookEntry(tabState, settings.activeRpcNetwork.chainId)
	const interceptorDisabled = isInterceptorDisabledForWebsite(settings, tabState.website?.websiteOrigin)
	await sendPopupMessageToOpenWindows({
		method: 'popup_homePageBootstrap',
		popupRefreshGeneration,
		data: {
			activeAddresses: await activeAddressesPromise,
			hasSafeTransactionsToExport: (await safeTransactionStacksPromise).some((stack) =>
				stack.chainId === settings.activeRpcNetwork.chainId && stack.transactions.length > 0
			),
			walletSelectedAddressBookEntry,
			tabState,
			settings,
			activeSigningAddressInThisTab: activeSigningAddress,
			tabId,
			rpcEntries: await rpcEntriesPromise,
			interceptorDisabled,
		},
	})
}

export async function refreshHomeData(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	websiteTabConnections: WebsiteTabConnections,
	shouldRefreshSignerAccounts: boolean,
	popupRefreshGeneration: number,
	publishRpcConnectionStatus: PublishRpcConnectionStatus,
	refreshSimulation = true,
	requestAbortController: AbortController | undefined = undefined,
) {
	markPerformance(POPUP_PERFORMANCE_MARKS.backgroundRefreshStart)
	try {
		const currentSettings = await getSettings()
		if (currentSettings.simulationMode) await updateSimulationMetadata(ethereum, requestAbortController)
		if (refreshSimulation) await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { skipIfUnchanged: true })
		const settings = await getSettings()
		if (settings.activeRpcNetwork.httpsRpc !== undefined) await makeSureInterceptorIsNotSleeping(ethereum, publishRpcConnectionStatus)
		const updatedPage = await buildHomePageUpdate(ethereum, websiteTabConnections, {
			requestAbortController,
			richDataSource: 'fresh',
			shouldRefreshSignerAccounts,
			includeWebsiteAccessAddressMetadata: true,
			popupRefreshGeneration,
		})
		await sendPopupMessageToOpenWindows(updatedPage)
	} finally {
		markPerformance(POPUP_PERFORMANCE_MARKS.backgroundRefreshEnd)
	}
}

export async function requestMakeMeRichList(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined) {
	const makeMeRichPromise = silenceChromeUnCaughtPromise(getMakeCurrentAddressRich())
	const fixedAddressRichList = await getFixedAddressRichList()
	const fixedRichListPromises = Array.from(fixedAddressRichList.values()).map(async(element) => {
		try {
			return { ...element, addressBookEntry: await identifyAddress(ethereumClientService, requestAbortController, element.address) }
		} catch (error) {
			if (isExpectedInfrastructureError(error)) throw error
			const address = checksummedAddress(element.address)
			const errorMessage = getErrorMessage(error) ?? 'Unknown error'
			await reportUnexpectedError(error, {
				displayMessage: `Failed to identify rich list address ${ address }: ${ errorMessage }`,
				details: { address, richListEntry: element },
				suppressExpectedHandledErrors: false,
			})
			return {
				...element,
				addressBookEntry: {
					type: 'contact' as const,
					name: address,
					address: element.address,
					entrySource: 'FilledIn' as const,
				}
			}
		}
	})
	return {
		method: 'popup_requestMakeMeRichData' as const,
		richList: await Promise.all(fixedRichListPromises),
		makeCurrentAddressRich: await makeMeRichPromise,
	}
}

export const requestActiveAddresses = async () => ({ method: 'popup_requestActiveAddresses' as const, activeAddresses: await getActiveAddresses() })

export const requestSimulationMode = async () => ({ method: 'popup_requestSimulationMode' as const, simulationMode: (await getSettings()).simulationMode })

async function getCachedRichData(chainId: bigint) {
	const [makeCurrentAddressRich, fixedAddressRichList] = await Promise.all([
		getMakeCurrentAddressRich(),
		getFixedAddressRichList(),
	])
	return {
		method: 'popup_requestMakeMeRichData' as const,
		richList: await Promise.all(fixedAddressRichList.map(async(element) => (
			{ ...element, addressBookEntry: await getActiveAddressEntryForChain(element.address, chainId) }
		))),
		makeCurrentAddressRich,
	}
}

async function buildHomePageUpdate(
	ethereum: EthereumClientService,
	websiteTabConnections: WebsiteTabConnections,
	{
		requestAbortController,
		richDataSource,
		shouldRefreshSignerAccounts,
		includeWebsiteAccessAddressMetadata,
		popupRefreshGeneration,
	}: {
		requestAbortController?: AbortController
		richDataSource: 'cached' | 'fresh'
		shouldRefreshSignerAccounts: boolean
		includeWebsiteAccessAddressMetadata: boolean
		popupRefreshGeneration: number
	}
): Promise<UpdateHomePage> {
	const settingsPromise = silenceChromeUnCaughtPromise(getSettings())
	const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
	const rpcEntriesPromise = silenceChromeUnCaughtPromise(getRpcList())
	const preSimulationBlockTimeManipulationPromise = silenceChromeUnCaughtPromise(getPreSimulationBlockTimeManipulation())
	const visualizedSimulatorStatePromise: Promise<CompleteVisualizedSimulation> = silenceChromeUnCaughtPromise(getPopupVisualisationState())
	const activeAddressesPromise = silenceChromeUnCaughtPromise(getActiveAddresses())
	const latestUnexpectedErrorPromise = silenceChromeUnCaughtPromise(getLatestUnexpectedError())
	const richDataPromise = silenceChromeUnCaughtPromise(
		richDataSource === 'fresh'
			? requestMakeMeRichList(ethereum, requestAbortController)
			: settingsPromise.then(async (currentSettings) => await getCachedRichData(currentSettings.activeRpcNetwork.chainId))
	)
	const hasSafeTransactionsToExportPromise = silenceChromeUnCaughtPromise(getSafeTransactionStacks().then((stacks) => stacks.some((stack) =>
		stack.chainId === ethereum.getChainId() && stack.transactions.length > 0
	)))
	const tabId = await getLastKnownCurrentTabId()
	const tabStatePromise = silenceChromeUnCaughtPromise(tabId === undefined ? getTabState(-1) : getTabState(tabId))
	let settings = await settingsPromise
	let tabState = await tabStatePromise
	tabState = await refreshSignerAccountsForTabIfNeeded(websiteTabConnections, tabId, tabState, shouldRefreshSignerAccounts)
	if (shouldRefreshSignerAccounts) settings = await getSettings()
	const activeSigningAddress = tabId === undefined ? undefined : (await getActiveAddressForCurrentPopupSignerState(settings, websiteTabConnections, tabId))?.address
	const walletSelectedAddressBookEntry = await getWalletSelectedAddressBookEntry(tabState, settings.activeRpcNetwork.chainId)
	const interceptorDisabled = isInterceptorDisabledForWebsite(settings, tabState.website?.websiteOrigin)
	const richData = await richDataPromise
	const websiteAccessAddressMetadata = includeWebsiteAccessAddressMetadata ? await getAddressMetadataForAccess(settings.websiteAccess, settings.activeRpcNetwork.chainId) : []
	return {
		method: 'popup_UpdateHomePage' as const,
		homeDataSource: richDataSource,
		popupRefreshGeneration: popupRefreshGeneration,
		data: {
			visualizedSimulatorState: await visualizedSimulatorStatePromise,
			activeAddresses: await activeAddressesPromise,
			walletSelectedAddressBookEntry,
			richList: richData.richList,
			makeCurrentAddressRich: richData.makeCurrentAddressRich,
			hasSafeTransactionsToExport: await hasSafeTransactionsToExportPromise,
			latestUnexpectedError: await latestUnexpectedErrorPromise,
			websiteAccessAddressMetadata,
			tabState,
			activeSigningAddressInThisTab: activeSigningAddress,
			currentBlockNumber: ethereum.getCachedBlock()?.number,
			settings,
			rpcConnectionStatus: await rpcConnectionStatusPromise,
			tabId,
			rpcEntries: await rpcEntriesPromise,
			interceptorDisabled,
			preSimulationBlockTimeManipulation: await preSimulationBlockTimeManipulationPromise,
		}
	}
}
