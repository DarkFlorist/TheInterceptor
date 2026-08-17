import type { PopupMessage } from './interceptor-messages.js'
import { hasOwnKey } from '../utils/methodHandlers.js'

export type PopupMessageDomain = 'address-book' | 'confirmation' | 'diagnostics' | 'home' | 'navigation' | 'safe' | 'settings' | 'simulation' | 'website-access'

type PopupMessageProtocolEntry = {
	readonly domain: PopupMessageDomain
	readonly legacyWireName?: true
}

// Wire names cannot be normalized without coordinating already-open extension pages. Mark historical spellings explicitly so new handlers do not copy those conventions.
export const popupMessageProtocol = {
	popup_confirmDialog: { domain: 'confirmation' },
	popup_changeActiveAddress: { domain: 'home' },
	popup_modifyMakeMeRich: { domain: 'home' },
	popup_changePage: { domain: 'navigation' },
	popup_requestAccountsFromSigner: { domain: 'confirmation' },
	popup_resetSimulation: { domain: 'simulation' },
	popup_removeTransactionOrSignedMessage: { domain: 'simulation' },
	popup_refreshSimulation: { domain: 'simulation' },
	popup_refreshConfirmTransactionDialogSimulation: { domain: 'confirmation' },
	popup_refreshConfirmTransactionMetadata: { domain: 'confirmation' },
	popup_interceptorAccess: { domain: 'website-access' },
	popup_changeInterceptorAccess: { domain: 'website-access' },
	popup_changeActiveRpc: { domain: 'settings' },
	popup_changeChainDialog: { domain: 'confirmation' },
	popup_watchAssetDialog: { domain: 'confirmation' },
	popup_enableSimulationMode: { domain: 'simulation' },
	popup_addOrModifyAddressBookEntry: { domain: 'address-book' },
	popup_setSafeSimulationSigner: { domain: 'safe' },
	popup_getAddressBookData: { domain: 'address-book' },
	popup_removeAddressBookEntry: { domain: 'address-book' },
	popup_openAddressBook: { domain: 'navigation' },
	popup_requestNewHomeData: { domain: 'home' },
	popup_requestHomePageBootstrap: { domain: 'home' },
	popup_refreshHomeData: { domain: 'home' },
	popup_requestSettings: { domain: 'settings' },
	popup_refreshInterceptorAccessMetadata: { domain: 'website-access' },
	popup_interceptorAccessChangeAddress: { domain: 'website-access' },
	popup_interceptorAccessRefresh: { domain: 'website-access' },
	popup_ChangeSettings: { domain: 'settings', legacyWireName: true },
	popup_openSettings: { domain: 'navigation' },
	popup_import_settings: { domain: 'settings', legacyWireName: true },
	popup_get_export_settings: { domain: 'settings', legacyWireName: true },
	popup_set_rpc_list: { domain: 'settings', legacyWireName: true },
	popup_simulateGovernanceContractExecution: { domain: 'simulation' },
	popup_simulateGnosisSafeTransaction: { domain: 'safe' },
	popup_changeAddOrModifyAddressWindowState: { domain: 'address-book' },
	popup_requestAbiAndNameFromBlockExplorer: { domain: 'address-book' },
	popup_openWebPage: { domain: 'navigation' },
	popup_setDisableInterceptor: { domain: 'website-access' },
	popup_clearUnexpectedError: { domain: 'diagnostics' },
	popup_acknowledgeActiveAddressSelectionResetNotice: { domain: 'home' },
	popup_setEnsNameForHash: { domain: 'address-book' },
	popup_openWebsiteAccess: { domain: 'navigation' },
	popup_openSimulationStack: { domain: 'navigation' },
	popup_retrieveWebsiteAccess: { domain: 'website-access' },
	popup_blockOrAllowExternalRequests: { domain: 'website-access' },
	popup_allowOrPreventAddressAccessForWebsite: { domain: 'website-access' },
	popup_removeWebsiteAccess: { domain: 'website-access' },
	popup_removeWebsiteAddressAccess: { domain: 'website-access' },
	popup_forceSetGasLimitForTransaction: { domain: 'simulation' },
	popup_changePreSimulationBlockTimeManipulation: { domain: 'simulation' },
	popup_setTransactionOrMessageBlockTimeManipulator: { domain: 'simulation' },
	popup_requestMakeMeRichData: { domain: 'home' },
	popup_requestActiveAddresses: { domain: 'home' },
	popup_requestSimulationMode: { domain: 'home' },
	popup_requestLatestUnexpectedError: { domain: 'diagnostics' },
	popup_fetchSimulationStackRequestConfirmation: { domain: 'simulation' },
	popup_readyAndListening: { domain: 'confirmation' },
	popup_UnexpectedErrorOccured: { domain: 'diagnostics', legacyWireName: true },
	popup_requestInterceptorSimulationInput: { domain: 'simulation' },
	popup_importSimulationStack: { domain: 'simulation' },
	popup_requestSafeStackExport: { domain: 'safe' },
	popup_importSafeStack: { domain: 'safe' },
	popup_requestCompleteVisualizedSimulation: { domain: 'simulation' },
	popup_requestSimulationMetadata: { domain: 'simulation' },
	popup_requestIdentifyAddress: { domain: 'address-book' },
	popup_requestSafeContractState: { domain: 'safe' },
	popup_isMainPopupWindowOpen: { domain: 'navigation' },
	popup_isSimulationVisualizerOpen: { domain: 'navigation' },
} satisfies Record<PopupMessage['method'], PopupMessageProtocolEntry>

export const getPopupMessageDomain = (method: PopupMessage['method']) => popupMessageProtocol[method].domain

export const isPopupMessageMethod = (value: string): value is PopupMessage['method'] => hasOwnKey(popupMessageProtocol, value)
