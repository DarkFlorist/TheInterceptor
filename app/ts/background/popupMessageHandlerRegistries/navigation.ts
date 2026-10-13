import { getSimulationStackTargetHash } from '../../utils/simulationStackTargets.js'
import { popupMessageHandler, type PopupMessageHandlerMap } from '../popupMessageHandlerRegistry.js'
import { changePage, openNewTab, openWebPage } from '../popupMessageHandlers/navigation.js'

export const navigationPopupMessageHandlers = {
	popup_changePage: popupMessageHandler('popup_changePage', async (_context, request) => await changePage(request)),
	popup_openWebPage: popupMessageHandler('popup_openWebPage', async (_context, request) => await openWebPage(request)),
	popup_openSimulationStack: popupMessageHandler('popup_openSimulationStack', async (_context, request) => await openNewTab('simulationStack', 'data' in request ? getSimulationStackTargetHash(request.data) : undefined)),
	// The background sends these probes and open popups answer them; the background itself has nothing to reply.
	popup_isMainPopupWindowOpen: popupMessageHandler('popup_isMainPopupWindowOpen', async () => undefined),
	popup_isSimulationVisualizerOpen: popupMessageHandler('popup_isSimulationVisualizerOpen', async () => undefined),
} satisfies Partial<PopupMessageHandlerMap>
