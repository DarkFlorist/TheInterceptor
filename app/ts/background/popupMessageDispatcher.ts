import type { PopupMessage, Settings } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { ResetSimulationServices } from '../simulation/serviceLifecycle.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { assertUnreachable } from '../utils/typescript.js'
import { getSimulationStackTargetHash } from '../utils/simulationStackTargets.js'
import { getSettings } from './settings.js'
import { setLatestUnexpectedError } from './storageVariables.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { updateWebsiteApprovalAccesses } from './accessManagement.js'
import { interceptorAccessMetadataRefresh } from './windows/interceptorAccess.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import {
	addOrModifyAddressBookEntry,
	allowOrPreventAddressAccessForWebsite,
	blockOrAllowExternalRequests,
	changeActiveAddress,
	changeAddOrModifyAddressWindowState,
	changeChainDialog,
	changeInterceptorAccess,
	changePage,
	changePreSimulationBlockTimeManipulation,
	changeSettings,
	confirmDialog,
	confirmRequestAccess,
	disableInterceptor,
	enableSimulationMode,
	exportSettings,
	fetchSimulationStackRequestConfirmation,
	forceSetGasLimitForTransaction,
	getAddressBookData,
	importSettings,
	importSimulationStack,
	interceptorAccessChangeAddressOrRefresh,
	modifyMakeMeRich,
	openNewTab,
	openWebPage,
	popupChangeActiveRpc,
	popupReadyAndListening,
	refreshHomeData,
	refreshPopupConfirmTransactionMetadata,
	refreshPopupConfirmTransactionSimulation,
	removeAddressBookEntry,
	removeTransactionOrSignedMessage,
	removeWebsiteAccess,
	removeWebsiteAddressAccess,
	reportUnexpectedErrorInWindow,
	requestAbiAndNameFromBlockExplorer,
	requestAccountsFromSigner,
	requestActiveAddresses,
	requestCompleteVisualizedSimulation,
	requestHomePageBootstrap,
	requestIdentifyAddress,
	requestInterceptorSimulationInput,
	requestLatestUnexpectedError,
	requestMakeMeRichList,
	requestNewHomeData,
	requestSimulationMetadata,
	requestSimulationMode,
	retrieveWebsiteAccess,
	setEnsNameForHash,
	setNewRpcList,
	setTransactionOrMessageBlockTimeManipulator,
	settingsOpened,
	simulateGnosisSafeTransactionOnPass,
	simulateGovernanceContractExecutionOnPass,
} from './popupMessageHandlers.js'

export type PopupMessageDispatcherContext = {
	websiteTabConnections: WebsiteTabConnections
	ethereum: EthereumClientService
	tokenPriceService: TokenPriceService
	resetSimulationServices: ResetSimulationServices
	settings: Settings
	publishRpcConnectionStatus: PublishRpcConnectionStatus
	simulationAbortController: AbortController
	confirmTransactionAbortController: AbortController
	resetSimulationState: () => Promise<void>
}

export async function dispatchPopupMessage(context: PopupMessageDispatcherContext, request: PopupMessage): Promise<PopupReplyOption | void> {
	const {
		websiteTabConnections,
		ethereum,
		tokenPriceService,
		resetSimulationServices,
		settings,
		publishRpcConnectionStatus,
		simulationAbortController,
		confirmTransactionAbortController,
	} = context
	switch (request.method) {
		case 'popup_confirmDialog': return await confirmDialog(ethereum, tokenPriceService, websiteTabConnections, request)
		case 'popup_changeActiveAddress': return await changeActiveAddress(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request)
		case 'popup_modifyMakeMeRich': return await modifyMakeMeRich(request)
		case 'popup_changePage': return await changePage(request)
		case 'popup_requestAccountsFromSigner': return await requestAccountsFromSigner(websiteTabConnections, request)
		case 'popup_resetSimulation': return await context.resetSimulationState()
		case 'popup_removeTransactionOrSignedMessage': return await removeTransactionOrSignedMessage(ethereum, tokenPriceService, request)
		case 'popup_refreshSimulation': {
			await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, false, true)
			return
		}
		case 'popup_refreshConfirmTransactionDialogSimulation': return await refreshPopupConfirmTransactionSimulation(ethereum, tokenPriceService)
		case 'popup_refreshConfirmTransactionMetadata': return refreshPopupConfirmTransactionMetadata(ethereum, tokenPriceService, confirmTransactionAbortController)
		case 'popup_interceptorAccess': return await confirmRequestAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request, publishRpcConnectionStatus)
		case 'popup_changeInterceptorAccess': return await changeInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request)
		case 'popup_changeActiveRpc': return await popupChangeActiveRpc(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request, settings)
		case 'popup_changeChainDialog': return await changeChainDialog(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request)
		case 'popup_enableSimulationMode': return await enableSimulationMode(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request)
		case 'popup_addOrModifyAddressBookEntry': return await addOrModifyAddressBookEntry(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request)
		case 'popup_getAddressBookData': return await getAddressBookData(request)
		case 'popup_removeAddressBookEntry': return await removeAddressBookEntry(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request)
		case 'popup_openAddressBook': return await openNewTab('addressBook')
		case 'popup_requestNewHomeData': return await requestNewHomeData(ethereum, websiteTabConnections, request.data.refreshSignerAccounts, request.data.includeWebsiteAccessAddressMetadata, simulationAbortController, bumpPopupRefreshGeneration())
		case 'popup_requestHomePageBootstrap': return await requestHomePageBootstrap(websiteTabConnections, bumpPopupRefreshGeneration())
		case 'popup_refreshHomeData': return await refreshHomeData(ethereum, tokenPriceService, websiteTabConnections, true, bumpPopupRefreshGeneration(), publishRpcConnectionStatus)
		case 'popup_requestSettings': return await settingsOpened()
		case 'popup_refreshInterceptorAccessMetadata': return await interceptorAccessMetadataRefresh()
		case 'popup_interceptorAccessChangeAddress': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, request)
		case 'popup_interceptorAccessRefresh': return await interceptorAccessChangeAddressOrRefresh(websiteTabConnections, request)
		case 'popup_ChangeSettings': return await changeSettings(ethereum, tokenPriceService, resetSimulationServices, request, simulationAbortController)
		case 'popup_openSettings': return await openNewTab('settingsView')
		case 'popup_import_settings': {
			const importSettingsReply = await importSettings(request)
			await sendPopupMessageToOpenWindows(importSettingsReply)
			if (!importSettingsReply.data.success) return
			const importedSettings = await getSettings()
			const popupRefreshGeneration = await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, importedSettings, true)
			await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: importedSettings, popupRefreshGeneration })
			return
		}
		case 'popup_get_export_settings': return await exportSettings()
		case 'popup_set_rpc_list': return await setNewRpcList(resetSimulationServices, request, settings)
		case 'popup_simulateGovernanceContractExecution': return await simulateGovernanceContractExecutionOnPass(ethereum, tokenPriceService, request)
		case 'popup_simulateGnosisSafeTransaction': return await simulateGnosisSafeTransactionOnPass(ethereum, tokenPriceService, request.data.gnosisSafeMessage)
		case 'popup_changeAddOrModifyAddressWindowState': return await changeAddOrModifyAddressWindowState(ethereum, request)
		case 'popup_requestAbiAndNameFromBlockExplorer': return await requestAbiAndNameFromBlockExplorer(request)
		case 'popup_openWebPage': return await openWebPage(request)
		case 'popup_setDisableInterceptor': return await disableInterceptor(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request)
		case 'popup_clearUnexpectedError': return await setLatestUnexpectedError(undefined)
		case 'popup_setEnsNameForHash': return await setEnsNameForHash(request)
		case 'popup_openWebsiteAccess': return await openNewTab('websiteAccess')
		case 'popup_openSimulationStack': return await openNewTab('simulationStack', 'data' in request ? getSimulationStackTargetHash(request.data) : undefined)
		case 'popup_retrieveWebsiteAccess': return await retrieveWebsiteAccess(request)
		case 'popup_blockOrAllowExternalRequests': return await blockOrAllowExternalRequests(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request)
		case 'popup_allowOrPreventAddressAccessForWebsite': return await allowOrPreventAddressAccessForWebsite(websiteTabConnections, request)
		case 'popup_removeWebsiteAccess': return await removeWebsiteAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request)
		case 'popup_removeWebsiteAddressAccess': return await removeWebsiteAddressAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, request)
		case 'popup_forceSetGasLimitForTransaction': return await forceSetGasLimitForTransaction(ethereum, tokenPriceService, request)
		case 'popup_changePreSimulationBlockTimeManipulation': return await changePreSimulationBlockTimeManipulation(ethereum, tokenPriceService, request)
		case 'popup_setTransactionOrMessageBlockTimeManipulator': return await setTransactionOrMessageBlockTimeManipulator(ethereum, tokenPriceService, request)
		case 'popup_requestMakeMeRichData': return await requestMakeMeRichList(ethereum, simulationAbortController)
		case 'popup_requestActiveAddresses': return await requestActiveAddresses()
		case 'popup_requestSimulationMode': return await requestSimulationMode()
		case 'popup_requestLatestUnexpectedError': return await requestLatestUnexpectedError()
		case 'popup_fetchSimulationStackRequestConfirmation': return await fetchSimulationStackRequestConfirmation(ethereum, websiteTabConnections, request)
		case 'popup_readyAndListening': return await popupReadyAndListening(ethereum, request.data.page)
		case 'popup_UnexpectedErrorOccured': return await reportUnexpectedErrorInWindow(request)
		case 'popup_requestInterceptorSimulationInput': return await requestInterceptorSimulationInput(ethereum)
		case 'popup_importSimulationStack': return await importSimulationStack(ethereum, tokenPriceService, request)
		case 'popup_requestCompleteVisualizedSimulation': return await requestCompleteVisualizedSimulation(ethereum, tokenPriceService)
		case 'popup_requestSimulationMetadata': return await requestSimulationMetadata(ethereum)
		case 'popup_requestIdentifyAddress': return await requestIdentifyAddress(ethereum, request)
		case 'popup_isMainPopupWindowOpen': return
		case 'popup_isSimulationVisualizerOpen': return
		default: assertUnreachable(request)
	}
}
