import { popupSettingsCommandHandlers } from './popupSettingsCommands.js'
import { queuePopupSimulationRefresh } from './popupSimulationRefreshQueue.js'
import type { PopupMessage } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import { getSimulationStackTargetHash } from '../utils/simulationStackTargets.js'
import { setLatestUnexpectedError } from './storageVariables.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { changeChainDialog, changePage, changePreSimulationBlockTimeManipulation, confirmDialog, fetchSimulationStackRequestConfirmation, forceSetGasLimitForTransaction, importSafeStack, importSimulationStack, openNewTab, openWebPage, popupReadyAndListening, refreshHomeData, refreshPopupConfirmTransactionMetadata, refreshPopupConfirmTransactionSimulation, removeTransactionOrSignedMessage, reportUnexpectedErrorInWindow, requestAccountsFromSigner, requestActiveAddresses, requestCompleteVisualizedSimulation, requestHomePageBootstrap, requestInterceptorSimulationInput, requestLatestUnexpectedError, requestMakeMeRichList, requestNewHomeData, requestSafeStackExport, requestSimulationMetadata, requestSimulationMode, setSafeSimulationSigner, setTransactionOrMessageBlockTimeManipulator, simulateGnosisSafeTransactionOnPass, simulateGovernanceContractExecutionOnPass, watchAssetDialog } from './popupMessageHandlers.js'
import { popupMessageHandler, type PopupMessageDispatcherContext, type PopupMessageHandlerMap } from './popupMessageHandlerRegistry.js'
import { addressBookPopupMessageHandlers } from './popupMessageHandlerRegistries/addressBook.js'
import { settingsPopupMessageHandlers } from './popupMessageHandlerRegistries/settings.js'
import { safePopupMessageHandlers } from './popupMessageHandlerRegistries/safe.js'
import { websiteAccessPopupMessageHandlers } from './popupMessageHandlerRegistries/websiteAccess.js'

export type { PopupMessageDispatcherContext } from './popupMessageHandlerRegistry.js'

const popupMessageHandlers = {
	popup_confirmDialog: popupMessageHandler('popup_confirmDialog', async (context, request) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await confirmDialog(ethereum, tokenPriceService, context.websiteTabConnections, request)
	}),
	popup_changePage: popupMessageHandler('popup_changePage', async (_context, request) => await changePage(request)),
	popup_requestAccountsFromSigner: popupMessageHandler('popup_requestAccountsFromSigner', async (context, request) => await requestAccountsFromSigner(context.websiteTabConnections, request)),
	popup_resetSimulation: popupMessageHandler('popup_resetSimulation', async (context) => await context.resetSimulationState()),
	popup_removeTransactionOrSignedMessage: popupMessageHandler('popup_removeTransactionOrSignedMessage', async (context, request) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await removeTransactionOrSignedMessage(ethereum, tokenPriceService, request)
	}),
	popup_refreshSimulation: popupMessageHandler('popup_refreshSimulation', async (context) => {
		await queuePopupSimulationRefresh({ ...context.simulationServicesOwner.getCurrent(), invalidateOldState: true })
	}),
	popup_refreshConfirmTransactionDialogSimulation: popupMessageHandler('popup_refreshConfirmTransactionDialogSimulation', async (context) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await refreshPopupConfirmTransactionSimulation(ethereum, tokenPriceService)
	}),
	popup_refreshConfirmTransactionMetadata: popupMessageHandler('popup_refreshConfirmTransactionMetadata', async (context) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await refreshPopupConfirmTransactionMetadata(ethereum, tokenPriceService, context.confirmTransactionAbortController)
	}),
	popup_changeChainDialog: popupMessageHandler('popup_changeChainDialog', async (context, request) => await changeChainDialog(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_watchAssetDialog: popupMessageHandler('popup_watchAssetDialog', async (context, request) => await watchAssetDialog(context.websiteTabConnections, request)),
	popup_setSafeSimulationSigner: popupMessageHandler('popup_setSafeSimulationSigner', async (context, request) => await setSafeSimulationSigner(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_requestNewHomeData: popupMessageHandler('popup_requestNewHomeData', async (context, request) => {
		const { ethereum } = context.simulationServicesOwner.getCurrent()
		return await requestNewHomeData(ethereum, context.websiteTabConnections, request.data.refreshSignerAccounts, request.data.includeWebsiteAccessAddressMetadata, context.simulationAbortController, bumpPopupRefreshGeneration())
	}),
	popup_requestHomePageBootstrap: popupMessageHandler('popup_requestHomePageBootstrap', async (context) => await requestHomePageBootstrap(context.websiteTabConnections, bumpPopupRefreshGeneration())),
	popup_refreshHomeData: popupMessageHandler('popup_refreshHomeData', async (context) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await refreshHomeData(ethereum, tokenPriceService, context.websiteTabConnections, true, bumpPopupRefreshGeneration(), context.publishRpcConnectionStatus)
	}),
	popup_simulateGovernanceContractExecution: popupMessageHandler('popup_simulateGovernanceContractExecution', async (context, request) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await simulateGovernanceContractExecutionOnPass(ethereum, tokenPriceService, request)
	}),
	popup_simulateGnosisSafeTransaction: popupMessageHandler('popup_simulateGnosisSafeTransaction', async (context, request) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await simulateGnosisSafeTransactionOnPass(ethereum, tokenPriceService, request.data.gnosisSafeMessage)
	}),
	popup_openWebPage: popupMessageHandler('popup_openWebPage', async (_context, request) => await openWebPage(request)),
	popup_clearUnexpectedError: popupMessageHandler('popup_clearUnexpectedError', async () => await setLatestUnexpectedError(undefined)),
	popup_openSimulationStack: popupMessageHandler('popup_openSimulationStack', async (_context, request) => await openNewTab('simulationStack', 'data' in request ? getSimulationStackTargetHash(request.data) : undefined)),
	popup_forceSetGasLimitForTransaction: popupMessageHandler('popup_forceSetGasLimitForTransaction', async (context, request) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await forceSetGasLimitForTransaction(ethereum, tokenPriceService, request)
	}),
	popup_changePreSimulationBlockTimeManipulation: popupMessageHandler('popup_changePreSimulationBlockTimeManipulation', async (context, request) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await changePreSimulationBlockTimeManipulation(ethereum, tokenPriceService, request)
	}),
	popup_setTransactionOrMessageBlockTimeManipulator: popupMessageHandler('popup_setTransactionOrMessageBlockTimeManipulator', async (context, request) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await setTransactionOrMessageBlockTimeManipulator(ethereum, tokenPriceService, request)
	}),
	popup_requestMakeMeRichData: popupMessageHandler('popup_requestMakeMeRichData', async (context) => {
		const { ethereum } = context.simulationServicesOwner.getCurrent()
		return await requestMakeMeRichList(ethereum, context.simulationAbortController)
	}),
	popup_requestActiveAddresses: popupMessageHandler('popup_requestActiveAddresses', async () => await requestActiveAddresses()),
	popup_requestSimulationMode: popupMessageHandler('popup_requestSimulationMode', async () => await requestSimulationMode()),
	popup_requestLatestUnexpectedError: popupMessageHandler('popup_requestLatestUnexpectedError', async () => await requestLatestUnexpectedError()),
	popup_fetchSimulationStackRequestConfirmation: popupMessageHandler('popup_fetchSimulationStackRequestConfirmation', async (context, request) => {
		const { ethereum } = context.simulationServicesOwner.getCurrent()
		return await fetchSimulationStackRequestConfirmation(ethereum, context.websiteTabConnections, request)
	}),
	popup_readyAndListening: popupMessageHandler('popup_readyAndListening', async (context, request) => {
		const { ethereum } = context.simulationServicesOwner.getCurrent()
		return await popupReadyAndListening(ethereum, context.websiteTabConnections, request.data.page)
	}),
	popup_UnexpectedErrorOccured: popupMessageHandler('popup_UnexpectedErrorOccured', async (_context, request) => await reportUnexpectedErrorInWindow(request)),
	popup_requestInterceptorSimulationInput: popupMessageHandler('popup_requestInterceptorSimulationInput', async (context) => {
		const { ethereum } = context.simulationServicesOwner.getCurrent()
		return await requestInterceptorSimulationInput(ethereum)
	}),
	popup_importSimulationStack: popupMessageHandler('popup_importSimulationStack', async (context, request) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await importSimulationStack(ethereum, tokenPriceService, request)
	}),
	popup_requestSafeStackExport: popupMessageHandler('popup_requestSafeStackExport', async (context) => {
		const { ethereum } = context.simulationServicesOwner.getCurrent()
		return await requestSafeStackExport(ethereum)
	}),
	popup_importSafeStack: popupMessageHandler('popup_importSafeStack', async (context, request) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await importSafeStack(ethereum, tokenPriceService, request)
	}),
	popup_requestCompleteVisualizedSimulation: popupMessageHandler('popup_requestCompleteVisualizedSimulation', async (context) => {
		const { ethereum, tokenPriceService } = context.simulationServicesOwner.getCurrent()
		return await requestCompleteVisualizedSimulation(ethereum, tokenPriceService)
	}),
	popup_requestSimulationMetadata: popupMessageHandler('popup_requestSimulationMetadata', async (context) => {
		const { ethereum } = context.simulationServicesOwner.getCurrent()
		return await requestSimulationMetadata(ethereum)
	}),
	popup_isMainPopupWindowOpen: popupMessageHandler('popup_isMainPopupWindowOpen', async () => undefined),
	popup_isSimulationVisualizerOpen: popupMessageHandler('popup_isSimulationVisualizerOpen', async () => undefined),
	...addressBookPopupMessageHandlers,
	...safePopupMessageHandlers,
	...settingsPopupMessageHandlers,
	...popupSettingsCommandHandlers,
	...websiteAccessPopupMessageHandlers,
} satisfies PopupMessageHandlerMap

export async function dispatchPopupMessage(context: PopupMessageDispatcherContext, request: PopupMessage): Promise<PopupReplyOption | void> {
	return await popupMessageHandlers[request.method](context, request)
}
