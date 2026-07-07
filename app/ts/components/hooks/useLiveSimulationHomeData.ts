import { useEffect } from 'preact/hooks'
import { defaultActiveAddresses, defaultRpcs, defaultSimulationMode } from '../../background/settings.js'
import { MessageToPopup, type UpdateHomePage, type Settings } from '../../types/interceptor-messages.js'
import type { RpcConnectionStatus, TabIconDetails, TabState } from '../../types/user-interface-types.js'
import { PASSTHROUGH_STATE, type BlockTimeManipulation, type CompleteVisualizedSimulation, type NamedTokenId, type ResolvedSimulationResults, type ResolvedSimulationState, type SimulationResultState, type SimulationUpdatingState, type TokenPriceEstimate, type VisualizedSimulationState, toResolvedSimulationResults } from '../../types/visualizer-types.js'
import type { AddressBookEntries } from '../../types/addressBookTypes.js'
import type { RpcEntries, RpcNetwork } from '../../types/rpc.js'
import type { WebsiteAccessArray } from '../../types/websiteAccessTypes.js'
import type { EnrichedRichListElement, UnexpectedErrorOccured } from '../../types/interceptor-reply-messages.js'
import { PopupMessageReplyRequests } from '../../types/interceptor-reply-messages.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { DEFAULT_TAB_CONNECTION } from '../../utils/constants.js'
import { useSignal } from '@preact/signals'
import { POPUP_PERFORMANCE_MARKS, markPerformance } from '../../utils/popupPerformance.js'

type LiveSimulationHomeDataOptions = {
	answerMainPopupOpen: boolean
	answerSimulationDataConsumerOpen: boolean
	requestFreshHomeDataOnMount: boolean
	filterByTabId?: boolean
	requireActiveSimulationAddress?: boolean
	requestHomeDataOnSimulationStateChange?: boolean
	onInitialSettings?: (settings: Settings) => void
}

export function useLiveSimulationHomeData(options: LiveSimulationHomeDataOptions) {
	const activeAddresses = useSignal<AddressBookEntries>(defaultActiveAddresses)
	const activeSimulationAddress = useSignal<bigint | undefined>(defaultActiveAddresses[0]?.address)
	const activeSigningAddress = useSignal<bigint | undefined>(undefined)
	const useSignersAddressAsActiveAddress = useSignal<boolean>(false)
	const simVisResults = useSignal<ResolvedSimulationResults>(PASSTHROUGH_STATE)
	const websiteAccess = useSignal<WebsiteAccessArray | undefined>(undefined)
	const websiteAccessAddressMetadata = useSignal<AddressBookEntries>([])
	const rpcNetwork = useSignal<RpcNetwork | undefined>(defaultRpcs[0])
	const tabIconDetails = useSignal<TabIconDetails>(DEFAULT_TAB_CONNECTION)
	const isSettingsLoaded = useSignal<boolean>(false)
	const currentBlockNumber = useSignal<bigint | undefined>(undefined)
	const tabState = useSignal<TabState | undefined>(undefined)
	const rpcConnectionStatus = useSignal<RpcConnectionStatus>(undefined)
	const currentTabId = useSignal<number | undefined>(undefined)
	const rpcEntries = useSignal<RpcEntries>(defaultRpcs)
	const simulationUpdatingState = useSignal<SimulationUpdatingState | undefined>(undefined)
	const simulationResultState = useSignal<SimulationResultState | undefined>(undefined)
	const interceptorDisabled = useSignal<boolean>(false)
	const unexpectedError = useSignal<UnexpectedErrorOccured | undefined>(undefined)
	const preSimulationBlockTimeManipulation = useSignal<BlockTimeManipulation | undefined>(undefined)
	const popupRefreshAppliedGeneration = useSignal(0)
	const popupRefreshGeneration = useSignal(0)
	const pendingPopupRefreshGeneration = useSignal(0)
	const popupIconRefreshGeneration = useSignal(0)
	const fixedAddressRichList = useSignal<readonly EnrichedRichListElement[]>([])
	const makeCurrentAddressRich = useSignal<boolean>(false)
	const simulationMode = useSignal<boolean>(defaultSimulationMode)
	const numberOfAddressesMadeRich = useSignal(0)

	const requestCachedHomeData = async (refreshSignerAccounts: boolean, includeWebsiteAccessAddressMetadata: boolean) => {
		await sendPopupMessageToBackgroundPage({ method: 'popup_requestNewHomeData', data: { refreshSignerAccounts, includeWebsiteAccessAddressMetadata } })
	}

	useEffect(() => {
		const setSimulationState = (
			simState: ResolvedSimulationState,
			addressBookEntries: AddressBookEntries,
			tokenPriceEstimates: readonly TokenPriceEstimate[],
			visualizedSimulationState: VisualizedSimulationState,
			activeSimulationAddress: bigint | undefined,
			namedTokenIds: readonly NamedTokenId[],
		): void => {
			if ((options.requireActiveSimulationAddress !== false && activeSimulationAddress === undefined) || simState.kind === 'passthrough') {
				simVisResults.value = PASSTHROUGH_STATE
				return
			}
			simVisResults.value = toResolvedSimulationResults({
				blockNumber: simState.value.blockNumber,
				blockTimestamp: simState.value.blockTimestamp,
				simulationConductedTimestamp: simState.value.simulationConductedTimestamp,
				simulationStateInput: simState.value.simulationStateInput,
				visualizedSimulationState,
				rpcNetwork: simState.value.rpcNetwork,
				tokenPriceEstimates,
				addressBookEntries,
				namedTokenIds,
			})
		}

		const updateVisualizedState = (state: CompleteVisualizedSimulation) => {
			setSimulationState(
				state.simulationState,
				state.addressBookEntries,
				state.tokenPriceEstimates,
				state.visualizedSimulationState,
				activeSimulationAddress.value,
				state.namedTokenIds,
			)
			simulationUpdatingState.value = state.simulationUpdatingState
			simulationResultState.value = state.simulationResultState
			numberOfAddressesMadeRich.value = state.numberOfAddressesMadeRich
		}

		const shouldIgnoreOutdatedPopupRefreshMessage = (refreshGeneration: number, minimumGeneration = popupRefreshGeneration.value) => refreshGeneration < minimumGeneration
		const updateHomePageSettings = (settings: Settings) => {
			rpcNetwork.value = settings.activeRpcNetwork
			activeSimulationAddress.value = settings.activeSimulationAddress
			useSignersAddressAsActiveAddress.value = settings.useSignersAddressAsActiveAddress
			websiteAccess.value = settings.websiteAccess
			simulationMode.value = settings.simulationMode
		}
		const updateHomePage = ({ data, popupRefreshGeneration: updateGeneration }: UpdateHomePage) => {
			if (options.filterByTabId !== false && data.tabId !== currentTabId.value && currentTabId.value !== undefined) return
			const minimumValidGeneration = Math.max(popupRefreshGeneration.value, pendingPopupRefreshGeneration.value)
			if (shouldIgnoreOutdatedPopupRefreshMessage(updateGeneration, minimumValidGeneration)) return
			popupRefreshGeneration.value = updateGeneration
			if (pendingPopupRefreshGeneration.value <= updateGeneration) {
				pendingPopupRefreshGeneration.value = 0
			}
			const wasLoaded = isSettingsLoaded.value
			isSettingsLoaded.value = true
			rpcEntries.value = data.rpcEntries
			currentTabId.value = data.tabId
			activeSigningAddress.value = data.activeSigningAddressInThisTab
			activeAddresses.value = data.activeAddresses
			interceptorDisabled.value = data.interceptorDisabled
			makeCurrentAddressRich.value = data.makeCurrentAddressRich
			fixedAddressRichList.value = data.richList
			unexpectedError.value = data.latestUnexpectedError
			if (!wasLoaded) options.onInitialSettings?.(data.settings)
			updateHomePageSettings(data.settings)
			if (popupIconRefreshGeneration.value <= updateGeneration) {
				tabIconDetails.value = data.tabState.tabIconDetails
				popupIconRefreshGeneration.value = updateGeneration
			}
			updateVisualizedState(data.visualizedSimulatorState)
			tabState.value = data.tabState
			currentBlockNumber.value = data.currentBlockNumber
			websiteAccessAddressMetadata.value = data.websiteAccessAddressMetadata
			rpcConnectionStatus.value = data.rpcConnectionStatus
			preSimulationBlockTimeManipulation.value = data.preSimulationBlockTimeManipulation
			markPerformance(POPUP_PERFORMANCE_MARKS.refreshComplete)
			popupRefreshAppliedGeneration.value += 1
		}

		const replyPopupMessageListener = (msg: unknown, _sender: unknown, sendResponse: (response?: unknown) => void) => {
			const maybeRequest = PopupMessageReplyRequests.safeParse(msg)
			if (maybeRequest.success) {
				if (maybeRequest.value.method === 'popup_isMainPopupWindowOpen' && options.answerMainPopupOpen) {
					sendResponse({ method: 'popup_isMainPopupWindowOpen', data: { isOpen: true } })
					return true
				}
				// Historical wire name: both the popup and the full stack tab consume live simulation data.
				if (maybeRequest.value.method === 'popup_isSimulationVisualizerOpen' && options.answerSimulationDataConsumerOpen) {
					sendResponse({ method: 'popup_isSimulationVisualizerOpen', data: { isOpen: true } })
					return true
				}
			}

			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return undefined
			const parsed = maybeParsed.value
			if (parsed.role === 'confirmTransaction') return undefined
			switch(parsed.method) {
				case 'popup_UnexpectedErrorOccured':
					unexpectedError.value = parsed
					return undefined
				case 'popup_settingsUpdated':
					if (shouldIgnoreOutdatedPopupRefreshMessage(parsed.popupRefreshGeneration)) return undefined
					pendingPopupRefreshGeneration.value = Math.max(pendingPopupRefreshGeneration.value, parsed.popupRefreshGeneration)
					requestCachedHomeData(false, true)
					return undefined
				case 'popup_accounts_update':
				case 'popup_chain_update':
				case 'popup_signer_name_changed':
					requestCachedHomeData(true, true)
					return undefined
				case 'popup_addressBookEntriesChanged':
				case 'popup_interceptor_access_changed':
				case 'popup_websiteAccess_changed':
				case 'popup_setDisableInterceptorReply':
				case 'popup_update_rpc_list':
					requestCachedHomeData(false, true)
					return undefined
				case 'popup_activeSigningAddressChanged': {
					if (parsed.data.tabId !== currentTabId.value) return undefined
					activeSigningAddress.value = parsed.data.activeSigningAddress
					return undefined
				}
				case 'popup_websiteIconChanged': {
					if (currentTabId.value === undefined || parsed.tabId !== currentTabId.value) return undefined
					if (shouldIgnoreOutdatedPopupRefreshMessage(parsed.popupRefreshGeneration)) return undefined
					if (parsed.popupRefreshGeneration < popupIconRefreshGeneration.value) return undefined
					popupIconRefreshGeneration.value = parsed.popupRefreshGeneration
					tabIconDetails.value = parsed.data
					return undefined
				}
				case 'popup_new_block_arrived':
				case 'popup_failed_to_get_block':
					rpcConnectionStatus.value = parsed.data.rpcConnectionStatus
					currentBlockNumber.value = parsed.data.rpcConnectionStatus?.latestBlock?.number
					return undefined
				case 'popup_simulation_state_changed':
					updateVisualizedState(parsed.data.visualizedSimulatorState)
					if (options.requestHomeDataOnSimulationStateChange === true) void requestCachedHomeData(false, false)
					return undefined
			}
			if (parsed.method !== 'popup_UpdateHomePage') return undefined
			updateHomePage(parsed)
			return undefined
		}

		browser.runtime.onMessage.addListener(replyPopupMessageListener)
		return () => {
			browser.runtime.onMessage.removeListener(replyPopupMessageListener)
		}
	}, [])

	useEffect(() => {
		void (async () => {
			await requestCachedHomeData(false, false)
			if (options.requestFreshHomeDataOnMount) {
				void sendPopupMessageToBackgroundPage({ method: 'popup_refreshHomeData' })
			}
		})()
	}, [])

	return {
		activeAddresses,
		activeSimulationAddress,
		activeSigningAddress,
		useSignersAddressAsActiveAddress,
		simVisResults,
		websiteAccess,
		websiteAccessAddressMetadata,
		rpcNetwork,
		tabIconDetails,
		isSettingsLoaded,
		currentBlockNumber,
		tabState,
		rpcConnectionStatus,
		currentTabId,
		rpcEntries,
		simulationUpdatingState,
		simulationResultState,
		interceptorDisabled,
		unexpectedError,
		preSimulationBlockTimeManipulation,
		popupRefreshAppliedGeneration,
		fixedAddressRichList,
		makeCurrentAddressRich,
		simulationMode,
		numberOfAddressesMadeRich,
	}
}
