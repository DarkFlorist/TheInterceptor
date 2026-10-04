import type { SimulationServices, SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { PopupMessage, Settings } from '../types/interceptor-messages.js'
import type { PopupReplyOption } from '../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { createMethodHandlerFor } from '../utils/methodHandlers.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import type { RpcConfigurationState } from './storageVariables.js'
import { getRpcServicesAtAdmission, rpcConfigurationIsReady } from './rpcConfigurationAvailability.js'
import { RPC_CONFIGURATION_UNAVAILABLE_ERROR } from '../types/interceptor-reply-messages.js'
import { RPC_CONFIGURATION_UNAVAILABLE_MESSAGE } from '../utils/rpcConfigurationError.js'

function rpcConfigurationUnavailableReply(request: PopupMessage): PopupReplyOption {
	switch (request.method) {
		case 'popup_setSafeSimulationSigner': return { type: 'SetSafeSimulationSignerReply', ok: false, message: RPC_CONFIGURATION_UNAVAILABLE_MESSAGE }
		case 'popup_addOrModifyAddressBookEntry': return { type: 'AddOrModifyAddressBookEntryReply', ok: false, message: RPC_CONFIGURATION_UNAVAILABLE_MESSAGE }
		case 'popup_changeActiveAddress': return { type: 'ChangeActiveAddressReply', ok: false, message: RPC_CONFIGURATION_UNAVAILABLE_MESSAGE }
		case 'popup_enableSimulationMode':
		case 'popup_changeActiveRpc':
		case 'popup_modifyMakeMeRich': return { type: 'PopupSettingsChangeReply', ok: false, message: RPC_CONFIGURATION_UNAVAILABLE_MESSAGE }
		default: return { error: RPC_CONFIGURATION_UNAVAILABLE_ERROR }
	}
}

export type PopupMessageDispatcherContext = {
	websiteTabConnections: WebsiteTabConnections
	simulationServicesOwner: SimulationServicesOwner
	settings: Settings | undefined
	rpcConfiguration: RpcConfigurationState
	publishRpcConnectionStatus: PublishRpcConnectionStatus
	simulationAbortController: AbortController
	confirmTransactionAbortController: AbortController
	resetSimulationState: () => Promise<void>
}

export type PopupMessageHandler = (context: PopupMessageDispatcherContext, request: PopupMessage) => Promise<PopupReplyOption | void>
export type PopupMessageHandlerMap = Record<PopupMessage['method'], PopupMessageHandler>
export type PopupReadyMessageDispatcherContext = Omit<PopupMessageDispatcherContext, 'settings'> & { readonly settings: Settings }

type PopupAdmissionMode = 'settings' | 'recovery' | 'rpc-configuration' | 'rpc-lifecycle' | 'rpc-snapshot' | 'optional-rpc-snapshot'

// This exhaustive table is the single source of truth for popup admission. Adding a protocol method requires choosing its availability and snapshot semantics here.
const POPUP_ADMISSION_MODE = {
	popup_ChangeSettings: 'settings',
	popup_UnexpectedErrorOccured: 'settings',
	popup_addOrModifyAddressBookEntry: 'optional-rpc-snapshot',
	popup_allowOrPreventAddressAccessForWebsite: 'settings',
	popup_blockOrAllowExternalRequests: 'settings',
	popup_changeActiveAddress: 'settings',
	popup_changeActiveRpc: 'settings',
	popup_changeAddOrModifyAddressWindowState: 'rpc-snapshot',
	popup_changeChainDialog: 'settings',
	popup_changeInterceptorAccess: 'settings',
	popup_changePage: 'settings',
	popup_changePreSimulationBlockTimeManipulation: 'rpc-snapshot',
	popup_clearUnexpectedError: 'settings',
	popup_confirmDialog: 'rpc-snapshot',
	popup_enableSimulationMode: 'rpc-configuration',
	popup_fetchSimulationStackRequestConfirmation: 'rpc-snapshot',
	popup_forceSetGasLimitForTransaction: 'rpc-snapshot',
	popup_getAddressBookData: 'settings',
	popup_get_export_settings: 'settings',
	popup_importSafeStack: 'rpc-snapshot',
	popup_importSimulationStack: 'rpc-snapshot',
	popup_import_settings: 'settings',
	popup_interceptorAccess: 'settings',
	popup_interceptorAccessChangeAddress: 'settings',
	popup_interceptorAccessRefresh: 'settings',
	popup_isMainPopupWindowOpen: 'settings',
	popup_isSimulationVisualizerOpen: 'settings',
	popup_modifyMakeMeRich: 'settings',
	popup_openAddressBook: 'settings',
	popup_openSettings: 'recovery',
	popup_openSimulationStack: 'settings',
	popup_openWebPage: 'settings',
	popup_openWebsiteAccess: 'settings',
	popup_readyAndListening: 'rpc-snapshot',
	popup_refreshConfirmTransactionDialogSimulation: 'rpc-snapshot',
	popup_refreshConfirmTransactionMetadata: 'rpc-snapshot',
	popup_refreshHomeData: 'rpc-snapshot',
	popup_refreshInterceptorAccessMetadata: 'settings',
	popup_refreshSimulation: 'rpc-snapshot',
	popup_removeAddressBookEntry: 'settings',
	popup_removeTransactionOrSignedMessage: 'rpc-snapshot',
	popup_removeWebsiteAccess: 'settings',
	popup_removeWebsiteAddressAccess: 'settings',
	popup_requestAbiAndNameFromBlockExplorer: 'settings',
	popup_requestAccountsFromSigner: 'settings',
	popup_requestActiveAddresses: 'settings',
	popup_requestCompleteVisualizedSimulation: 'rpc-snapshot',
	popup_requestHomePageBootstrap: 'settings',
	popup_requestIdentifyAddress: 'rpc-snapshot',
	popup_requestInterceptorSimulationInput: 'rpc-snapshot',
	popup_requestLatestUnexpectedError: 'settings',
	popup_requestMakeMeRichData: 'rpc-snapshot',
	popup_requestNewHomeData: 'rpc-snapshot',
	popup_requestSafeContractState: 'rpc-snapshot',
	popup_requestSafeStackExport: 'rpc-snapshot',
	popup_requestSettings: 'recovery',
	popup_requestSettingsChangeStatus: 'settings',
	popup_requestSimulationMetadata: 'rpc-snapshot',
	popup_requestSimulationMode: 'settings',
	popup_resetSimulation: 'rpc-lifecycle',
	popup_restoreDefaultRpcConfiguration: 'recovery',
	popup_retrieveWebsiteAccess: 'settings',
	popup_retryRpcConfiguration: 'recovery',
	popup_setDisableInterceptor: 'settings',
	popup_setEnsNameForHash: 'settings',
	popup_setSafeSimulationSigner: 'rpc-snapshot',
	popup_setTransactionOrMessageBlockTimeManipulator: 'rpc-snapshot',
	popup_set_rpc_list: 'settings',
	popup_simulateGnosisSafeTransaction: 'rpc-snapshot',
	popup_simulateGovernanceContractExecution: 'rpc-snapshot',
	popup_watchAssetDialog: 'settings',
} as const satisfies Record<PopupMessage['method'], PopupAdmissionMode>

type PopupMethodForAdmission<Mode extends PopupAdmissionMode> = {
	[Method in keyof typeof POPUP_ADMISSION_MODE]: typeof POPUP_ADMISSION_MODE[Method] extends Mode ? Method : never
}[keyof typeof POPUP_ADMISSION_MODE]
type PopupRecoveryMethod = PopupMethodForAdmission<'recovery'>
type PopupOptionalSnapshotMethod = PopupMethodForAdmission<'optional-rpc-snapshot'>
type PopupSnapshotMethod = PopupMethodForAdmission<'rpc-snapshot'>
export type PopupReadyAdmissionMethod = PopupMethodForAdmission<'settings' | 'rpc-configuration' | 'rpc-lifecycle'>

const popupMethodHandler = createMethodHandlerFor<PopupMessage, PopupMessageDispatcherContext, Promise<PopupReplyOption | void>>()

export type PopupAdmission =
	| { readonly kind: 'admitted', readonly settings: Settings | undefined, readonly services: SimulationServices | undefined }
	| { readonly kind: 'rejected', readonly reply: PopupReplyOption }

// All static availability policy is resolved from POPUP_ADMISSION_MODE here. Optional handlers supply only their request-variant requirements.
export function admitPopupRequest(context: PopupMessageDispatcherContext, request: PopupMessage, optionalRequirements?: { readonly requiresSettings: boolean, readonly requiresRpc: boolean }): PopupAdmission {
	const mode = POPUP_ADMISSION_MODE[request.method]
	const requiresSettings = mode === 'settings' || mode === 'rpc-configuration' || mode === 'rpc-lifecycle' || mode === 'rpc-snapshot'
		|| (mode === 'optional-rpc-snapshot' && optionalRequirements?.requiresSettings === true)
	const requiresRpcConfiguration = mode === 'rpc-configuration'
	const requiresRpcServices = mode === 'rpc-lifecycle' || mode === 'rpc-snapshot'
		|| (mode === 'optional-rpc-snapshot' && optionalRequirements?.requiresRpc === true)
	if (requiresSettings && context.settings === undefined) return { kind: 'rejected', reply: rpcConfigurationUnavailableReply(request) }
	if (requiresRpcConfiguration && !rpcConfigurationIsReady(context.rpcConfiguration)) return { kind: 'rejected', reply: rpcConfigurationUnavailableReply(request) }
	if (!requiresRpcServices) return { kind: 'admitted', settings: context.settings, services: undefined }
	const services = getRpcServicesAtAdmission(context.rpcConfiguration, context.simulationServicesOwner)
	if (context.settings === undefined || services === undefined) return { kind: 'rejected', reply: rpcConfigurationUnavailableReply(request) }
	return { kind: 'admitted', settings: context.settings, services }
}

export function popupMessageHandler<Method extends PopupReadyAdmissionMethod>(
	method: Method,
	handler: (context: PopupReadyMessageDispatcherContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
): PopupMessageHandler {
	return popupMethodHandler(method, async (context, request) => {
		const admission = admitPopupRequest(context, request)
		if (admission.kind === 'rejected') return admission.reply
		if (admission.settings === undefined) return rpcConfigurationUnavailableReply(request)
		return await handler({ ...context, settings: admission.settings }, request)
	})
}

export function popupRecoveryMessageHandler<Method extends PopupRecoveryMethod>(
	method: Method,
	handler: (context: PopupMessageDispatcherContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
): PopupMessageHandler {
	return popupMethodHandler(method, async (context, request) => {
		const admission = admitPopupRequest(context, request)
		if (admission.kind === 'rejected') return admission.reply
		return await handler(context, request)
	})
}

// One fixed-provider operation: this context deliberately exposes neither reset nor the live owner.
export type PopupSnapshotContext = Omit<PopupReadyMessageDispatcherContext, 'simulationServicesOwner' | 'resetSimulationState'> & {
	readonly services: SimulationServices
}

export function popupSnapshotMessageHandler<Method extends PopupSnapshotMethod>(
	method: Method,
	handler: (context: PopupSnapshotContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
): PopupMessageHandler {
	return popupMethodHandler(method, async (context, request) => {
		const admission = admitPopupRequest(context, request)
		if (admission.kind === 'rejected') return admission.reply
		if (admission.settings === undefined || admission.services === undefined) return rpcConfigurationUnavailableReply(request)
		const { simulationServicesOwner, resetSimulationState: _resetSimulationState, ...executionContext } = context
		return await handler({ ...executionContext, settings: admission.settings, services: admission.services }, request)
	})
}

export type PopupOptionalSnapshotContext = Omit<PopupMessageDispatcherContext, 'resetSimulationState'> & {
	readonly services: SimulationServices | undefined
}

// Mixed commands can remain available offline while declaring exactly which request variants require an admitted service snapshot.
export function popupOptionalSnapshotMessageHandler<Method extends PopupOptionalSnapshotMethod>(
	method: Method,
	handler: (context: PopupOptionalSnapshotContext, request: Extract<PopupMessage, { readonly method: Method }>) => Promise<PopupReplyOption | void>,
	requiresRpc: (request: Extract<PopupMessage, { readonly method: Method }>) => boolean,
	requiresSettings: (request: Extract<PopupMessage, { readonly method: Method }>) => boolean = () => false,
): PopupMessageHandler {
	return popupMethodHandler(method, async (context, request) => {
		const admission = admitPopupRequest(context, request, { requiresSettings: requiresSettings(request), requiresRpc: requiresRpc(request) })
		if (admission.kind === 'rejected') return admission.reply
		const { resetSimulationState: _resetSimulationState, ...executionContext } = context
		return await handler({ ...executionContext, settings: admission.settings, services: admission.services }, request)
	})
}
