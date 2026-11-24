import { simulateGnosisSafeTransactionOnPass } from '../executionOnPassSimulation.js'
import { requestSafeContractState } from '../safeContractState.js'
import { popupMessageHandler, popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { importSafeStack, requestSafeStackExport, setSafeSimulationSigner } from '../popupMessageHandlers/safe.js'

export const safePopupMessageHandlers = {
	popup_requestSafeContractState: popupSnapshotMessageHandler('popup_requestSafeContractState', async (context, request) => {
		const { ethereum } = context.services
		return await requestSafeContractState(ethereum, request)
	}),
	popup_setSafeSimulationSigner: popupMessageHandler('popup_setSafeSimulationSigner', async (context, request) => await setSafeSimulationSigner(context.simulationServicesOwner, context.websiteTabConnections, request)),
	popup_simulateGnosisSafeTransaction: popupSnapshotMessageHandler('popup_simulateGnosisSafeTransaction', async (context, request) => {
		const { ethereum, tokenPriceService } = context.services
		return await simulateGnosisSafeTransactionOnPass(ethereum, tokenPriceService, request.data.gnosisSafeMessage)
	}),
	popup_requestSafeStackExport: popupSnapshotMessageHandler('popup_requestSafeStackExport', async (context) => {
		const { ethereum } = context.services
		return await requestSafeStackExport(ethereum)
	}),
	popup_importSafeStack: popupSnapshotMessageHandler('popup_importSafeStack', async (context, request) => {
		const { ethereum, tokenPriceService } = context.services
		return await importSafeStack(ethereum, tokenPriceService, request)
	}),
} satisfies Partial<PopupMessageHandlerMap>
