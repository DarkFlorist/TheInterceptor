import type { PopupMessage } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import { getSimulationStackTargetHash } from '../utils/simulationStackTargets.js'
import { setLatestUnexpectedError } from './storageVariables.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { updatePopupVisualisationIfNeeded } from './popupVisualisationUpdater.js'
import { changeActiveAddress, changeChainDialog, changePage, changePreSimulationBlockTimeManipulation, confirmDialog, enableSimulationMode, fetchSimulationStackRequestConfirmation, forceSetGasLimitForTransaction, importSafeStack, importSimulationStack, modifyMakeMeRich, openNewTab, openWebPage, popupReadyAndListening, refreshHomeData, refreshPopupConfirmTransactionMetadata, refreshPopupConfirmTransactionSimulation, removeTransactionOrSignedMessage, reportUnexpectedErrorInWindow, requestAccountsFromSigner, requestActiveAddresses, requestCompleteVisualizedSimulation, requestHomePageBootstrap, requestInterceptorSimulationInput, requestLatestUnexpectedError, requestMakeMeRichList, requestNewHomeData, requestSafeStackExport, requestSimulationMetadata, requestSimulationMode, setSafeSimulationSigner, setTransactionOrMessageBlockTimeManipulator, simulateGnosisSafeTransactionOnPass, simulateGovernanceContractExecutionOnPass, watchAssetDialog } from './popupMessageHandlers.js'
import { popupMessageHandler, type PopupMessageDispatcherContext, type PopupMessageHandlerMap } from './popupMessageHandlerRegistry.js'
import { addressBookPopupMessageHandlers } from './popupMessageHandlerRegistries/addressBook.js'
import { settingsPopupMessageHandlers } from './popupMessageHandlerRegistries/settings.js'
import { safePopupMessageHandlers } from './popupMessageHandlerRegistries/safe.js'
import { websiteAccessPopupMessageHandlers } from './popupMessageHandlerRegistries/websiteAccess.js'

export type { PopupMessageDispatcherContext } from './popupMessageHandlerRegistry.js'

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
	popup_changeChainDialog: popupMessageHandler('popup_changeChainDialog', async (context, request) => await changeChainDialog(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_watchAssetDialog: popupMessageHandler('popup_watchAssetDialog', async (context, request) => await watchAssetDialog(context.websiteTabConnections, request)),
	popup_enableSimulationMode: popupMessageHandler('popup_enableSimulationMode', async (context, request) => await enableSimulationMode(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_setSafeSimulationSigner: popupMessageHandler('popup_setSafeSimulationSigner', async (context, request) => await setSafeSimulationSigner(context.ethereum, context.tokenPriceService, context.resetSimulationServices, context.websiteTabConnections, request)),
	popup_requestNewHomeData: popupMessageHandler('popup_requestNewHomeData', async (context, request) => await requestNewHomeData(context.ethereum, context.websiteTabConnections, request.data.refreshSignerAccounts, request.data.includeWebsiteAccessAddressMetadata, context.simulationAbortController, bumpPopupRefreshGeneration())),
	popup_requestHomePageBootstrap: popupMessageHandler('popup_requestHomePageBootstrap', async (context) => await requestHomePageBootstrap(context.websiteTabConnections, bumpPopupRefreshGeneration())),
	popup_refreshHomeData: popupMessageHandler('popup_refreshHomeData', async (context) => await refreshHomeData(context.ethereum, context.tokenPriceService, context.websiteTabConnections, true, bumpPopupRefreshGeneration(), context.publishRpcConnectionStatus)),
	popup_simulateGovernanceContractExecution: popupMessageHandler('popup_simulateGovernanceContractExecution', async (context, request) => await simulateGovernanceContractExecutionOnPass(context.ethereum, context.tokenPriceService, request)),
	popup_simulateGnosisSafeTransaction: popupMessageHandler('popup_simulateGnosisSafeTransaction', async (context, request) => await simulateGnosisSafeTransactionOnPass(context.ethereum, context.tokenPriceService, request.data.gnosisSafeMessage)),
	popup_openWebPage: popupMessageHandler('popup_openWebPage', async (_context, request) => await openWebPage(request)),
	popup_clearUnexpectedError: popupMessageHandler('popup_clearUnexpectedError', async () => await setLatestUnexpectedError(undefined)),
	popup_openSimulationStack: popupMessageHandler('popup_openSimulationStack', async (_context, request) => await openNewTab('simulationStack', 'data' in request ? getSimulationStackTargetHash(request.data) : undefined)),
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
	popup_requestSafeStackExport: popupMessageHandler('popup_requestSafeStackExport', async (context) => await requestSafeStackExport(context.ethereum)),
	popup_importSafeStack: popupMessageHandler('popup_importSafeStack', async (context, request) => await importSafeStack(context.ethereum, context.tokenPriceService, request)),
	popup_requestCompleteVisualizedSimulation: popupMessageHandler('popup_requestCompleteVisualizedSimulation', async (context) => await requestCompleteVisualizedSimulation(context.ethereum, context.tokenPriceService)),
	popup_requestSimulationMetadata: popupMessageHandler('popup_requestSimulationMetadata', async (context) => await requestSimulationMetadata(context.ethereum)),
	popup_isMainPopupWindowOpen: popupMessageHandler('popup_isMainPopupWindowOpen', async () => undefined),
	popup_isSimulationVisualizerOpen: popupMessageHandler('popup_isSimulationVisualizerOpen', async () => undefined),
	...addressBookPopupMessageHandlers,
	...safePopupMessageHandlers,
	...settingsPopupMessageHandlers,
	...websiteAccessPopupMessageHandlers,
} satisfies PopupMessageHandlerMap

export async function dispatchPopupMessage(context: PopupMessageDispatcherContext, request: PopupMessage): Promise<PopupReplyOption | void> {
	return await popupMessageHandlers[request.method](context, request)
}
