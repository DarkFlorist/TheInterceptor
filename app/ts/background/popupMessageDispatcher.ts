import type { PopupMessage, Settings } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { ResetSimulationServices } from '../simulation/serviceLifecycle.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { getSimulationStackTargetHash } from '../utils/simulationStackTargets.js'
import { createMethodHandlerFor } from '../utils/methodHandlers.js'
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
	watchAssetDialog,
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

type PopupMessageHandler = (context: PopupMessageDispatcherContext, request: PopupMessage) => Promise<PopupReplyOption | void>
const popupMessageHandler = createMethodHandlerFor<PopupMessage, PopupMessageDispatcherContext, Promise<PopupReplyOption | void>>()

const popupMessageHandlers = {
	popup_confirmDialog: popupMessageHandler('popup_confirmDialog', async (context, request) => await confirmDialog(context.ethereum, context.tokenPriceService, context.websiteTabConnections, request)),
	popup_changeActiveAddress: popupMessageHandler('popup_changeActiveAddress', async (context, request) => await changeActiveAddress(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_modifyMakeMeRich: popupMessageHandler('popup_modifyMakeMeRich', async (_context, request) => await modifyMakeMeRich(request)),
	popup_changePage: popupMessageHandler('popup_changePage', async (_context, request) => await changePage(request)),
	popup_requestAccountsFromSigner: popupMessageHandler('popup_requestAccountsFromSigner', async (context, request) => await requestAccountsFromSigner(context.websiteTabConnections, request)),
	popup_resetSimulation: popupMessageHandler('popup_resetSimulation', async (context) => await context.resetSimulationState()),
	popup_removeTransactionOrSignedMessage: popupMessageHandler('popup_removeTransactionOrSignedMessage', async (context, request) => await removeTransactionOrSignedMessage(context.ethereum, context.tokenPriceService, request)),
	popup_refreshSimulation: popupMessageHandler('popup_refreshSimulation', async (context) => {
		await updatePopupVisualisationIfNeeded(context.ethereum, context.tokenPriceService, false, false, true)
	}),
	popup_refreshConfirmTransactionDialogSimulation: popupMessageHandler('popup_refreshConfirmTransactionDialogSimulation', async (context) => await refreshPopupConfirmTransactionSimulation(context.ethereum, context.tokenPriceService)),
	popup_refreshConfirmTransactionMetadata: popupMessageHandler('popup_refreshConfirmTransactionMetadata', async (context) => await refreshPopupConfirmTransactionMetadata(context.ethereum, context.tokenPriceService, context.confirmTransactionAbortController)),
	popup_interceptorAccess: popupMessageHandler('popup_interceptorAccess', async (context, request) => await confirmRequestAccess(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request, context.publishRpcConnectionStatus)),
	popup_changeInterceptorAccess: popupMessageHandler('popup_changeInterceptorAccess', async (context, request) => await changeInterceptorAccess(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_changeActiveRpc: popupMessageHandler('popup_changeActiveRpc', async (context, request) => await popupChangeActiveRpc(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request, context.settings)),
	popup_changeChainDialog: popupMessageHandler('popup_changeChainDialog', async (context, request) => await changeChainDialog(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_watchAssetDialog: popupMessageHandler('popup_watchAssetDialog', async (context, request) => await watchAssetDialog(context.websiteTabConnections, request)),
	popup_enableSimulationMode: popupMessageHandler('popup_enableSimulationMode', async (context, request) => await enableSimulationMode(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_addOrModifyAddressBookEntry: popupMessageHandler('popup_addOrModifyAddressBookEntry', async (context, request) => await addOrModifyAddressBookEntry(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_getAddressBookData: popupMessageHandler('popup_getAddressBookData', async (_context, request) => await getAddressBookData(request)),
	popup_removeAddressBookEntry: popupMessageHandler('popup_removeAddressBookEntry', async (context, request) => await removeAddressBookEntry(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_openAddressBook: popupMessageHandler('popup_openAddressBook', async () => await openNewTab('addressBook')),
	popup_requestNewHomeData: popupMessageHandler('popup_requestNewHomeData', async (context, request) => await requestNewHomeData(context.ethereum, context.websiteTabConnections, request.data.refreshSignerAccounts, request.data.includeWebsiteAccessAddressMetadata, context.simulationAbortController, bumpPopupRefreshGeneration())),
	popup_requestHomePageBootstrap: popupMessageHandler('popup_requestHomePageBootstrap', async (context) => await requestHomePageBootstrap(context.websiteTabConnections, bumpPopupRefreshGeneration())),
	popup_refreshHomeData: popupMessageHandler('popup_refreshHomeData', async (context) => await refreshHomeData(context.ethereum, context.tokenPriceService, context.websiteTabConnections, true, bumpPopupRefreshGeneration(), context.publishRpcConnectionStatus)),
	popup_requestSettings: popupMessageHandler('popup_requestSettings', async () => await settingsOpened()),
	popup_refreshInterceptorAccessMetadata: popupMessageHandler('popup_refreshInterceptorAccessMetadata', async () => await interceptorAccessMetadataRefresh()),
	popup_interceptorAccessChangeAddress: popupMessageHandler('popup_interceptorAccessChangeAddress', async (context, request) => await interceptorAccessChangeAddressOrRefresh(context.websiteTabConnections, request)),
	popup_interceptorAccessRefresh: popupMessageHandler('popup_interceptorAccessRefresh', async (context, request) => await interceptorAccessChangeAddressOrRefresh(context.websiteTabConnections, request)),
	popup_ChangeSettings: popupMessageHandler('popup_ChangeSettings', async (context, request) => await changeSettings(context.ethereum, context.tokenPriceService, context.resetSimulationServices, request, context.simulationAbortController)),
	popup_openSettings: popupMessageHandler('popup_openSettings', async () => await openNewTab('settingsView')),
	popup_import_settings: popupMessageHandler('popup_import_settings', async (context, request) => {
		const importSettingsReply = await importSettings(request)
		await sendPopupMessageToOpenWindows(importSettingsReply)
		if (!importSettingsReply.data.success) return
		const importedSettings = await getSettings()
		const popupRefreshGeneration = await updateWebsiteApprovalAccesses(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, importedSettings, true)
		await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: importedSettings, popupRefreshGeneration })
	}),
	popup_get_export_settings: popupMessageHandler('popup_get_export_settings', async () => await exportSettings()),
	popup_set_rpc_list: popupMessageHandler('popup_set_rpc_list', async (context, request) => await setNewRpcList(context.resetSimulationServices, request, context.settings)),
	popup_simulateGovernanceContractExecution: popupMessageHandler('popup_simulateGovernanceContractExecution', async (context, request) => await simulateGovernanceContractExecutionOnPass(context.ethereum, context.tokenPriceService, request)),
	popup_simulateGnosisSafeTransaction: popupMessageHandler('popup_simulateGnosisSafeTransaction', async (context, request) => await simulateGnosisSafeTransactionOnPass(context.ethereum, context.tokenPriceService, request.data.gnosisSafeMessage)),
	popup_changeAddOrModifyAddressWindowState: popupMessageHandler('popup_changeAddOrModifyAddressWindowState', async (context, request) => await changeAddOrModifyAddressWindowState(context.ethereum, request)),
	popup_requestAbiAndNameFromBlockExplorer: popupMessageHandler('popup_requestAbiAndNameFromBlockExplorer', async (_context, request) => await requestAbiAndNameFromBlockExplorer(request)),
	popup_openWebPage: popupMessageHandler('popup_openWebPage', async (_context, request) => await openWebPage(request)),
	popup_setDisableInterceptor: popupMessageHandler('popup_setDisableInterceptor', async (context, request) => await disableInterceptor(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_clearUnexpectedError: popupMessageHandler('popup_clearUnexpectedError', async () => await setLatestUnexpectedError(undefined)),
	popup_setEnsNameForHash: popupMessageHandler('popup_setEnsNameForHash', async (_context, request) => await setEnsNameForHash(request)),
	popup_openWebsiteAccess: popupMessageHandler('popup_openWebsiteAccess', async () => await openNewTab('websiteAccess')),
	popup_openSimulationStack: popupMessageHandler('popup_openSimulationStack', async (_context, request) => await openNewTab('simulationStack', 'data' in request ? getSimulationStackTargetHash(request.data) : undefined)),
	popup_retrieveWebsiteAccess: popupMessageHandler('popup_retrieveWebsiteAccess', async (_context, request) => await retrieveWebsiteAccess(request)),
	popup_blockOrAllowExternalRequests: popupMessageHandler('popup_blockOrAllowExternalRequests', async (context, request) => await blockOrAllowExternalRequests(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_allowOrPreventAddressAccessForWebsite: popupMessageHandler('popup_allowOrPreventAddressAccessForWebsite', async (context, request) => await allowOrPreventAddressAccessForWebsite(context.websiteTabConnections, request)),
	popup_removeWebsiteAccess: popupMessageHandler('popup_removeWebsiteAccess', async (context, request) => await removeWebsiteAccess(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_removeWebsiteAddressAccess: popupMessageHandler('popup_removeWebsiteAddressAccess', async (context, request) => await removeWebsiteAddressAccess(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_forceSetGasLimitForTransaction: popupMessageHandler('popup_forceSetGasLimitForTransaction', async (context, request) => await forceSetGasLimitForTransaction(context.ethereum, context.tokenPriceService, request)),
	popup_changePreSimulationBlockTimeManipulation: popupMessageHandler('popup_changePreSimulationBlockTimeManipulation', async (context, request) => await changePreSimulationBlockTimeManipulation(context.ethereum, context.tokenPriceService, request)),
	popup_setTransactionOrMessageBlockTimeManipulator: popupMessageHandler('popup_setTransactionOrMessageBlockTimeManipulator', async (context, request) => await setTransactionOrMessageBlockTimeManipulator(context.ethereum, context.tokenPriceService, request)),
	popup_requestMakeMeRichData: popupMessageHandler('popup_requestMakeMeRichData', async (context) => await requestMakeMeRichList(context.ethereum, context.simulationAbortController)),
	popup_requestActiveAddresses: popupMessageHandler('popup_requestActiveAddresses', async () => await requestActiveAddresses()),
	popup_requestSimulationMode: popupMessageHandler('popup_requestSimulationMode', async () => await requestSimulationMode()),
	popup_requestLatestUnexpectedError: popupMessageHandler('popup_requestLatestUnexpectedError', async () => await requestLatestUnexpectedError()),
	popup_fetchSimulationStackRequestConfirmation: popupMessageHandler('popup_fetchSimulationStackRequestConfirmation', async (context, request) => await fetchSimulationStackRequestConfirmation(context.ethereum, context.websiteTabConnections, request)),
	popup_readyAndListening: popupMessageHandler('popup_readyAndListening', async (context, request) => await popupReadyAndListening(context.ethereum, context.websiteTabConnections, request.data.page)),
	popup_UnexpectedErrorOccured: popupMessageHandler('popup_UnexpectedErrorOccured', async (_context, request) => await reportUnexpectedErrorInWindow(request)),
	popup_requestInterceptorSimulationInput: popupMessageHandler('popup_requestInterceptorSimulationInput', async (context) => await requestInterceptorSimulationInput(context.ethereum)),
	popup_importSimulationStack: popupMessageHandler('popup_importSimulationStack', async (context, request) => await importSimulationStack(context.ethereum, context.tokenPriceService, request)),
	popup_requestCompleteVisualizedSimulation: popupMessageHandler('popup_requestCompleteVisualizedSimulation', async (context) => await requestCompleteVisualizedSimulation(context.ethereum, context.tokenPriceService)),
	popup_requestSimulationMetadata: popupMessageHandler('popup_requestSimulationMetadata', async (context) => await requestSimulationMetadata(context.ethereum)),
	popup_requestIdentifyAddress: popupMessageHandler('popup_requestIdentifyAddress', async (context, request) => await requestIdentifyAddress(context.ethereum, request)),
	popup_isMainPopupWindowOpen: popupMessageHandler('popup_isMainPopupWindowOpen', async () => undefined),
	popup_isSimulationVisualizerOpen: popupMessageHandler('popup_isSimulationVisualizerOpen', async () => undefined),
} satisfies Record<PopupMessage['method'], PopupMessageHandler>

export async function dispatchPopupMessage(context: PopupMessageDispatcherContext, request: PopupMessage): Promise<PopupReplyOption | void> {
	return await popupMessageHandlers[request.method](context, request)
}
