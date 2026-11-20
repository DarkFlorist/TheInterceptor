import { simulateGovernanceContractExecutionOnPass } from '../executionOnPassSimulation.js'
import { popupMessageHandler, popupSnapshotMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { changePreSimulationBlockTimeManipulation, fetchSimulationStackRequestConfirmation, forceSetGasLimitForTransaction, importSimulationStack, removeTransactionOrSignedMessage, requestCompleteVisualizedSimulation, requestInterceptorSimulationInput, requestSimulationMetadata, setTransactionOrMessageBlockTimeManipulator } from '../popupMessageHandlers/simulation.js'
import { queuePopupSimulationRefresh } from '../popupSimulationRefreshQueue.js'

export const simulationPopupMessageHandlers = {
	popup_resetSimulation: popupMessageHandler('popup_resetSimulation', async (context) => await context.resetSimulationState()),
	popup_removeTransactionOrSignedMessage: popupSnapshotMessageHandler('popup_removeTransactionOrSignedMessage', async (context, request) => {
		const { ethereum, tokenPriceService } = context.services
		return await removeTransactionOrSignedMessage(ethereum, tokenPriceService, request)
	}),
	popup_refreshSimulation: popupSnapshotMessageHandler('popup_refreshSimulation', async (context) => {
		await queuePopupSimulationRefresh({ ...context.services, invalidateOldState: true })
	}),
	popup_simulateGovernanceContractExecution: popupSnapshotMessageHandler('popup_simulateGovernanceContractExecution', async (context, request) => {
		const { ethereum, tokenPriceService } = context.services
		return await simulateGovernanceContractExecutionOnPass(ethereum, tokenPriceService, request)
	}),
	popup_forceSetGasLimitForTransaction: popupSnapshotMessageHandler('popup_forceSetGasLimitForTransaction', async (context, request) => {
		const { ethereum, tokenPriceService } = context.services
		return await forceSetGasLimitForTransaction(ethereum, tokenPriceService, request)
	}),
	popup_changePreSimulationBlockTimeManipulation: popupSnapshotMessageHandler('popup_changePreSimulationBlockTimeManipulation', async (context, request) => {
		const { ethereum, tokenPriceService } = context.services
		return await changePreSimulationBlockTimeManipulation(ethereum, tokenPriceService, request)
	}),
	popup_setTransactionOrMessageBlockTimeManipulator: popupSnapshotMessageHandler('popup_setTransactionOrMessageBlockTimeManipulator', async (context, request) => {
		const { ethereum, tokenPriceService } = context.services
		return await setTransactionOrMessageBlockTimeManipulator(ethereum, tokenPriceService, request)
	}),
	popup_fetchSimulationStackRequestConfirmation: popupSnapshotMessageHandler('popup_fetchSimulationStackRequestConfirmation', async (context, request) => {
		const { ethereum } = context.services
		return await fetchSimulationStackRequestConfirmation(ethereum, context.websiteTabConnections, request)
	}),
	popup_requestInterceptorSimulationInput: popupSnapshotMessageHandler('popup_requestInterceptorSimulationInput', async (context) => {
		const { ethereum } = context.services
		return await requestInterceptorSimulationInput(ethereum)
	}),
	popup_importSimulationStack: popupSnapshotMessageHandler('popup_importSimulationStack', async (context, request) => {
		const { ethereum, tokenPriceService } = context.services
		return await importSimulationStack(ethereum, tokenPriceService, request)
	}),
	popup_requestCompleteVisualizedSimulation: popupSnapshotMessageHandler('popup_requestCompleteVisualizedSimulation', async (context) => {
		const { ethereum, tokenPriceService } = context.services
		return await requestCompleteVisualizedSimulation(ethereum, tokenPriceService)
	}),
	popup_requestSimulationMetadata: popupSnapshotMessageHandler('popup_requestSimulationMetadata', async (context) => {
		const { ethereum } = context.services
		return await requestSimulationMetadata(ethereum)
	}),
} satisfies Partial<PopupMessageHandlerMap>
