import type { PopupMessage } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import type { PopupMessageDispatcherContext, PopupMessageHandlerMap } from './popupMessageHandlerRegistry.js'
import { addressBookPopupMessageHandlers } from './popupMessageHandlerRegistries/addressBook.js'
import { confirmationPopupMessageHandlers } from './popupMessageHandlerRegistries/confirmation.js'
import { diagnosticsPopupMessageHandlers } from './popupMessageHandlerRegistries/diagnostics.js'
import { homePopupMessageHandlers } from './popupMessageHandlerRegistries/home.js'
import { navigationPopupMessageHandlers } from './popupMessageHandlerRegistries/navigation.js'
import { safePopupMessageHandlers } from './popupMessageHandlerRegistries/safe.js'
import { settingsPopupMessageHandlers } from './popupMessageHandlerRegistries/settings.js'
import { popupSettingsCommandHandlers } from './popupMessageHandlerRegistries/settingsCommands.js'
import { simulationPopupMessageHandlers } from './popupMessageHandlerRegistries/simulation.js'
import { websiteAccessPopupMessageHandlers } from './popupMessageHandlerRegistries/websiteAccess.js'

// Popup message layout:
// - popupMessageRouting.ts parses a message, builds the dispatcher context and owns the error policy.
// - popupMessageHandlerRegistry.ts defines the handler types and constructors.
// - popupMessageHandlerRegistries/<domain>.ts wires each method of a protocol domain (types/popupMessageProtocol.ts) to its handler; settingsCommands.ts wires the commands that need settings admission.
// - popupMessageHandlers/<domain>.ts implements the handlers.
// This file only combines the registries into one exhaustive map.

const popupMessageHandlers = {
	...addressBookPopupMessageHandlers,
	...confirmationPopupMessageHandlers,
	...diagnosticsPopupMessageHandlers,
	...homePopupMessageHandlers,
	...navigationPopupMessageHandlers,
	...safePopupMessageHandlers,
	...settingsPopupMessageHandlers,
	...popupSettingsCommandHandlers,
	...simulationPopupMessageHandlers,
	...websiteAccessPopupMessageHandlers,
} satisfies PopupMessageHandlerMap

export async function dispatchPopupMessage(context: PopupMessageDispatcherContext, request: PopupMessage): Promise<PopupReplyOption | void> {
	return await popupMessageHandlers[request.method](context, request)
}
