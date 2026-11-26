import { NATIVE_GNOSIS_SAFE_APPS_REQUEST } from './popupMessageProtocol.js'
import { ModifyMakeMeRich, EnableSimulationMode, ChangeActiveChain, ChangeActiveAddress, SetRpcList } from './popupSettingsRequests.js'
import type { popupSettingsOperations, DirectPopupSettingsMethod } from './popupSettingsProtocol.js'
import * as funtypes from 'funtypes'
import { AddressBookEntry, ChainIdWithUniversal } from '../types/addressBookTypes.js'
import { PopupOrTabId } from './websiteAccessTypes.js'
import { CompleteVisualizedSimulation, InterceptorSimulationExport, NamedTokenId } from './visualizer-types.js'
import { EthereumAddress, EthereumQuantity, EthereumTimestamp } from './wire-types.js'
import { PopupPendingTransactionOrSignableMessage } from './accessRequest.js'
import { RpcConnectionStatus } from './user-interface-types.js'
import { SimulateExecutionReply as PopupSimulateExecutionReply } from './simulateExecutionReply.js'
import { SimulateGnosisSafeTransaction as RequestSimulateGnosisSafeTransaction, SimulateGovernanceContractExecution as RequestSimulateGovernanceContractExecution } from './simulateExecutionRequests.js'
import { GnosisSafeStackExport } from './gnosisSafeTypes.js'

export const NativeGnosisSafeAppsRelayReply = funtypes.Union(
	funtypes.ReadonlyObject({ type: funtypes.Literal('NativeGnosisSafeAppsRelayReply'), ok: funtypes.Literal(true), response: funtypes.Unknown }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('NativeGnosisSafeAppsRelayReply'), ok: funtypes.Literal(false), message: funtypes.String }),
)
export type NativeGnosisSafeAppsRelayReply = funtypes.Static<typeof NativeGnosisSafeAppsRelayReply>

export type UnexpectedErrorOccured = funtypes.Static<typeof UnexpectedErrorOccured>
export const OpenGnosisSafeAppReply = funtypes.Union(
	funtypes.ReadonlyObject({ type: funtypes.Literal('OpenGnosisSafeAppReply'), ok: funtypes.Literal(true) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('OpenGnosisSafeAppReply'), ok: funtypes.Literal(false), message: funtypes.String }),
)
export type OpenGnosisSafeAppReply = funtypes.Static<typeof OpenGnosisSafeAppReply>

export const UnexpectedErrorOccured = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_UnexpectedErrorOccured'),
	data: funtypes.ReadonlyObject({
		timestamp: EthereumTimestamp,
		message: funtypes.String,
		source: funtypes.String,
		code: funtypes.String,
		debugId: funtypes.Union(funtypes.String, funtypes.Undefined),
	})
})

export type EnrichedRichListElement = funtypes.Static<typeof EnrichedRichListElement>
export const EnrichedRichListElement = funtypes.ReadonlyObject({
	addressBookEntry: AddressBookEntry,
	makingRich: funtypes.Boolean,
	type: funtypes.Union(funtypes.Literal('PreviousActiveAddress'), funtypes.Literal('UserAdded'), funtypes.Literal('CurrentActiveAddress')),
})

type RequestMakeMeRichDataReply = funtypes.Static<typeof RequestMakeMeRichDataReply>
const RequestMakeMeRichDataReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestMakeMeRichData'),
	richList: funtypes.ReadonlyArray(EnrichedRichListElement),
	makeCurrentAddressRich: funtypes.Boolean,
})

type RequestActiveAddressesReply = funtypes.Static<typeof RequestActiveAddressesReply>
const RequestActiveAddressesReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestActiveAddresses'),
	activeAddresses: funtypes.ReadonlyArray(AddressBookEntry)
})

type RequestSimulationModeReply = funtypes.Static<typeof RequestSimulationModeReply>
const RequestSimulationModeReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestSimulationMode'),
	simulationMode: funtypes.Boolean
})

type RequestLatestUnexpectedErrorReply = funtypes.Static<typeof RequestLatestUnexpectedErrorReply>
const RequestLatestUnexpectedErrorReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestLatestUnexpectedError'),
	latestUnexpectedError: funtypes.Union(funtypes.Undefined, UnexpectedErrorOccured),
})

type RequestInterceptorSimulationInputReply = funtypes.Static<typeof RequestInterceptorSimulationInputReply>
const RequestInterceptorSimulationInputReply = funtypes.Union(
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_requestInterceptorSimulationInput'),
		ok: funtypes.Literal(true),
		ethSimulateV1InputString: funtypes.String,
	}),
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_requestInterceptorSimulationInput'),
		ok: funtypes.Literal(false),
		message: funtypes.String,
	}),
)

export type ImportSimulationStackReply = funtypes.Static<typeof ImportSimulationStackReply>
export const ImportSimulationStackReply = funtypes.Union(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('ImportSimulationStackReply'),
		ok: funtypes.Literal(true),
	}),
	funtypes.ReadonlyObject({
		type: funtypes.Literal('ImportSimulationStackReply'),
		ok: funtypes.Literal(false),
		message: funtypes.String,
	}),
)

export type AddOrModifyAddressBookEntryReply = funtypes.Static<typeof AddOrModifyAddressBookEntryReply>
export const AddOrModifyAddressBookEntryReply = funtypes.Union(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('AddOrModifyAddressBookEntryReply'),
		ok: funtypes.Literal(true),
	}),
	funtypes.ReadonlyObject({
		type: funtypes.Literal('AddOrModifyAddressBookEntryReply'),
		ok: funtypes.Literal(false),
		message: funtypes.String,
	}),
)

export type PopupSettingsChangeReply = funtypes.Static<typeof PopupSettingsChangeReply>
export const PopupSettingsChangeReply = funtypes.Union(
	funtypes.ReadonlyObject({ type: funtypes.Literal('PopupSettingsChangeReply'), ok: funtypes.Literal(true) }),
	funtypes.ReadonlyObject({ type: funtypes.Literal('PopupSettingsChangeReply'), ok: funtypes.Literal(false), message: funtypes.String }),
)

export type ChangeActiveAddressReply = funtypes.Static<typeof ChangeActiveAddressReply>
export const ChangeActiveAddressReply = funtypes.Union(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('ChangeActiveAddressReply'),
		ok: funtypes.Literal(true),
	}),
	funtypes.ReadonlyObject({
		type: funtypes.Literal('ChangeActiveAddressReply'),
		ok: funtypes.Literal(false),
		message: funtypes.String,
	}),
)

export type SetGnosisSafeSimulationSigner = funtypes.Static<typeof SetGnosisSafeSimulationSigner>
export const SetGnosisSafeSimulationSigner = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_setSafeSimulationSigner'),
	data: funtypes.ReadonlyObject({
		chainId: EthereumQuantity,
		safeAddress: EthereumAddress,
		safeSimulationSignerAddress: funtypes.Union(EthereumAddress, funtypes.Undefined),
	}),
})

export type SetGnosisSafeSimulationSignerReply = funtypes.Static<typeof SetGnosisSafeSimulationSignerReply>
export const SetGnosisSafeSimulationSignerReply = funtypes.Union(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('SetSafeSimulationSignerReply'),
		ok: funtypes.Literal(true),
	}),
	funtypes.ReadonlyObject({
		type: funtypes.Literal('SetSafeSimulationSignerReply'),
		ok: funtypes.Literal(false),
		message: funtypes.String,
	}),
)

type RequestGnosisSafeStackExportReply = funtypes.Static<typeof RequestGnosisSafeStackExportReply>
const RequestGnosisSafeStackExportReply = funtypes.Union(
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_requestSafeStackExport'),
		ok: funtypes.Literal(true),
		safeStackJson: funtypes.String,
	}),
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_requestSafeStackExport'),
		ok: funtypes.Literal(false),
		message: funtypes.String,
	}),
)

export type ImportGnosisSafeStackReply = funtypes.Static<typeof ImportGnosisSafeStackReply>
export const ImportGnosisSafeStackReply = funtypes.Union(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('ImportSafeStackReply'),
		ok: funtypes.Literal(true),
	}),
	funtypes.ReadonlyObject({
		type: funtypes.Literal('ImportSafeStackReply'),
		ok: funtypes.Literal(false),
		message: funtypes.String,
	}),
)

type RequestCompleteVisualizedSimulationReply = funtypes.Static<typeof RequestCompleteVisualizedSimulationReply>
const RequestCompleteVisualizedSimulationReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestCompleteVisualizedSimulation'),
	visualizedSimulatorState: CompleteVisualizedSimulation
})

export type SimulationMetadata = funtypes.Static<typeof SimulationMetadata>
export const SimulationMetadata = funtypes.ReadonlyObject({
	namedTokenIds: funtypes.ReadonlyArray(NamedTokenId),
	addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
	ens: funtypes.ReadonlyObject({
		ensNameHashes: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
			nameHash: EthereumQuantity,
			name: funtypes.Union(funtypes.String, funtypes.Undefined)
		})),
		ensLabelHashes: funtypes.ReadonlyArray(funtypes.ReadonlyObject({
			labelHash: EthereumQuantity,
			label: funtypes.Union(funtypes.String, funtypes.Undefined)
		}))
	})
})

type RequestSimulationMetadataReply = funtypes.Static<typeof RequestSimulationMetadataReply>
const RequestSimulationMetadataReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestSimulationMetadata'),
	metadata: SimulationMetadata
})

type RequestAbiAndNameFromBlockExplorerReply = funtypes.Static<typeof RequestAbiAndNameFromBlockExplorerReply>
const RequestAbiAndNameFromBlockExplorerReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestAbiAndNameFromBlockExplorer'),
	data: funtypes.Union(
		funtypes.ReadonlyObject({
			success: funtypes.Literal(true),
			abi: funtypes.Union(funtypes.String, funtypes.Undefined),
			contractName: funtypes.String,
		}),
		funtypes.ReadonlyObject({
			success: funtypes.Literal(false),
			error: funtypes.String,
		}),
	)
}).asReadonly()

export type RequestIdentifyAddress = funtypes.Static<typeof RequestIdentifyAddress>
export const RequestIdentifyAddress = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestIdentifyAddress'),
	data: funtypes.ReadonlyObject({
		address: EthereumAddress,
		chainId: ChainIdWithUniversal,
	})
}).asReadonly()

type RequestIdentifyAddressReply = funtypes.Static<typeof RequestIdentifyAddressReply>
const RequestIdentifyAddressReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestIdentifyAddress'),
	data: funtypes.ReadonlyObject({
		chainId: ChainIdWithUniversal,
		addressBookEntry: funtypes.Union(AddressBookEntry, funtypes.Undefined),
	})
}).asReadonly()

export type RequestGnosisSafeContractState = funtypes.Static<typeof RequestGnosisSafeContractState>
export const RequestGnosisSafeContractState = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestSafeContractState'),
	data: funtypes.ReadonlyObject({ address: EthereumAddress, chainId: ChainIdWithUniversal }),
}).asReadonly()

type RequestGnosisSafeContractStateReply = funtypes.Static<typeof RequestGnosisSafeContractStateReply>
const RequestGnosisSafeContractStateReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestSafeContractState'),
	data: funtypes.ReadonlyObject({
		chainId: ChainIdWithUniversal,
		result: funtypes.Union(
			funtypes.ReadonlyObject({ ok: funtypes.Literal(true), owners: funtypes.ReadonlyArray(EthereumAddress), ownerAddressBookEntries: funtypes.ReadonlyArray(AddressBookEntry), version: funtypes.String }),
			funtypes.ReadonlyObject({ ok: funtypes.Literal(false), message: funtypes.String }),
		),
	}),
}).asReadonly()

type RequestIsMainWindowOpen = funtypes.Static<typeof RequestIsMainWindowOpen>
const RequestIsMainWindowOpen = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_isMainPopupWindowOpen'),
	data: funtypes.ReadonlyObject({
		isOpen: funtypes.Boolean,
	})
}).asReadonly()

type RequestIsSimulationVisualizerOpen = funtypes.Static<typeof RequestIsSimulationVisualizerOpen>
const RequestIsSimulationVisualizerOpen = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_isSimulationVisualizerOpen'),
	data: funtypes.ReadonlyObject({
		isOpen: funtypes.Boolean,
	})
}).asReadonly()

type ConfirmTransactionBootstrapReply = funtypes.Static<typeof ConfirmTransactionBootstrapReply>
const ConfirmTransactionBootstrapReply = funtypes.ReadonlyObject({
	pendingTransactionAndSignableMessages: funtypes.ReadonlyArray(PopupPendingTransactionOrSignableMessage),
	currentBlockNumber: EthereumQuantity,
	rpcConnectionStatus: funtypes.Union(RpcConnectionStatus, funtypes.Undefined),
	visualizedSimulatorState: CompleteVisualizedSimulation,
}).asReadonly()

type PopupReadyAndListeningReply = funtypes.Static<typeof PopupReadyAndListeningReply>
const PopupReadyAndListeningReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_readyAndListening'),
	data: funtypes.ReadonlyObject({
		popupOrTabId: PopupOrTabId,
		confirmTransactionBootstrap: funtypes.Union(ConfirmTransactionBootstrapReply, funtypes.Undefined),
	}),
}).asReadonly()

type PopupSettingsReplyCodecs = {
	ChangeActiveAddressReply: typeof ChangeActiveAddressReply
	PopupSettingsChangeReply: typeof PopupSettingsChangeReply
}

// Settings commands with direct replies use their descriptor codec; imports deliver their reply by broadcast.
type PopupSettingsRepliesMap = {
	[Method in DirectPopupSettingsMethod]: PopupSettingsReplyCodecs[typeof popupSettingsOperations[Method]['reply']['type']]
}

type PopupRequestsRepliesMap = PopupSettingsRepliesMap & {
	[NATIVE_GNOSIS_SAFE_APPS_REQUEST]: typeof NativeGnosisSafeAppsRelayReply
	popup_openGnosisSafeApp: typeof OpenGnosisSafeAppReply
	popup_requestMakeMeRichData: typeof RequestMakeMeRichDataReply
	popup_requestActiveAddresses: typeof RequestActiveAddressesReply
	popup_requestSimulationMode: typeof RequestSimulationModeReply
	popup_requestLatestUnexpectedError: typeof RequestLatestUnexpectedErrorReply
	popup_requestInterceptorSimulationInput: typeof RequestInterceptorSimulationInputReply
	popup_importSimulationStack: typeof ImportSimulationStackReply
	popup_addOrModifyAddressBookEntry: typeof AddOrModifyAddressBookEntryReply
	popup_setSafeSimulationSigner: typeof SetGnosisSafeSimulationSignerReply
	popup_requestSafeStackExport: typeof RequestGnosisSafeStackExportReply
	popup_importSafeStack: typeof ImportGnosisSafeStackReply
	popup_requestCompleteVisualizedSimulation: typeof RequestCompleteVisualizedSimulationReply
	popup_requestSimulationMetadata: typeof RequestSimulationMetadataReply
	popup_requestAbiAndNameFromBlockExplorer: typeof RequestAbiAndNameFromBlockExplorerReply
	popup_requestIdentifyAddress: typeof RequestIdentifyAddressReply
	popup_requestSafeContractState: typeof RequestGnosisSafeContractStateReply
	popup_simulateGovernanceContractExecution: typeof PopupSimulateExecutionReply
	popup_simulateGnosisSafeTransaction: typeof PopupSimulateExecutionReply
	popup_isMainPopupWindowOpen: typeof RequestIsMainWindowOpen
	popup_isSimulationVisualizerOpen: typeof RequestIsSimulationVisualizerOpen
	popup_readyAndListening: typeof PopupReadyAndListeningReply
}

export const PopupRequestsReplies: PopupRequestsRepliesMap = {
	[NATIVE_GNOSIS_SAFE_APPS_REQUEST]: NativeGnosisSafeAppsRelayReply,
	popup_openGnosisSafeApp: OpenGnosisSafeAppReply,
	popup_requestMakeMeRichData: RequestMakeMeRichDataReply,
	popup_requestActiveAddresses: RequestActiveAddressesReply,
	popup_requestSimulationMode: RequestSimulationModeReply,
	popup_requestLatestUnexpectedError: RequestLatestUnexpectedErrorReply,
	popup_requestInterceptorSimulationInput: RequestInterceptorSimulationInputReply,
	popup_importSimulationStack: ImportSimulationStackReply,
	popup_addOrModifyAddressBookEntry: AddOrModifyAddressBookEntryReply,
	popup_changeActiveAddress: ChangeActiveAddressReply,
	popup_enableSimulationMode: PopupSettingsChangeReply,
	popup_changeActiveRpc: PopupSettingsChangeReply,
	popup_modifyMakeMeRich: PopupSettingsChangeReply,
	popup_set_rpc_list: PopupSettingsChangeReply,
	popup_setSafeSimulationSigner: SetGnosisSafeSimulationSignerReply,
	popup_requestSafeStackExport: RequestGnosisSafeStackExportReply,
	popup_importSafeStack: ImportGnosisSafeStackReply,
	popup_requestCompleteVisualizedSimulation: RequestCompleteVisualizedSimulationReply,
	popup_requestSimulationMetadata: RequestSimulationMetadataReply,
	popup_requestAbiAndNameFromBlockExplorer: RequestAbiAndNameFromBlockExplorerReply,
	popup_requestIdentifyAddress: RequestIdentifyAddressReply,
	popup_requestSafeContractState: RequestGnosisSafeContractStateReply,
	popup_simulateGovernanceContractExecution: PopupSimulateExecutionReply,
	popup_simulateGnosisSafeTransaction: PopupSimulateExecutionReply,
	popup_isMainPopupWindowOpen: RequestIsMainWindowOpen,
	popup_isSimulationVisualizerOpen: RequestIsSimulationVisualizerOpen,
	popup_readyAndListening: PopupReadyAndListeningReply,
}

type PopupRequestsReplies = {
	[Key in keyof typeof PopupRequestsReplies]?: funtypes.Static<typeof PopupRequestsReplies[Key]>
}

export type RequestAbiAndNameFromBlockExplorer = funtypes.Static<typeof RequestAbiAndNameFromBlockExplorer>
export const RequestAbiAndNameFromBlockExplorer = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestAbiAndNameFromBlockExplorer'),
	data: funtypes.ReadonlyObject({ address: EthereumAddress, chainId: ChainIdWithUniversal })
}).asReadonly()

export const PopupMessageReplyRequests = funtypes.Union(
	funtypes.ReadonlyObject({ method: funtypes.Literal(NATIVE_GNOSIS_SAFE_APPS_REQUEST) }).And(funtypes.ReadonlyPartial({ data: funtypes.Unknown })),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_openGnosisSafeApp'), data: funtypes.ReadonlyObject({ sourceTabId: funtypes.Number.withConstraint((value) => Number.isSafeInteger(value) && value >= 0) }) }),
	RequestAbiAndNameFromBlockExplorer,
	RequestIdentifyAddress,
	RequestGnosisSafeContractState,
	RequestSimulateGovernanceContractExecution,
	RequestSimulateGnosisSafeTransaction,
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestMakeMeRichData') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestActiveAddresses') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestSimulationMode') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestLatestUnexpectedError') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestInterceptorSimulationInput') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_importSimulationStack'), data: InterceptorSimulationExport }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_addOrModifyAddressBookEntry'), data: AddressBookEntry }),
	ChangeActiveAddress,
	EnableSimulationMode,
	ChangeActiveChain,
	ModifyMakeMeRich,
	SetRpcList,
	SetGnosisSafeSimulationSigner,
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestSafeStackExport') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_importSafeStack'), data: GnosisSafeStackExport }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestCompleteVisualizedSimulation') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestSimulationMetadata') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_isMainPopupWindowOpen') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_isSimulationVisualizerOpen') }),
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_readyAndListening'),
		data: funtypes.ReadonlyObject({
			page: funtypes.Union(
				funtypes.Literal('changeChain'),
				funtypes.Literal('watchAsset'),
				funtypes.Literal('confirmTransaction'),
				funtypes.Literal('interceptorAccess'),
				funtypes.Literal('fetchSimulationStack'),
			),
		}),
	}),
)

export type PopupRequests = funtypes.Static<typeof PopupMessageReplyRequests>
export type PopupRequestsReplyReturn<Request extends PopupRequests> = Request['method'] extends keyof typeof PopupRequestsReplies ? funtypes.Static<(typeof PopupRequestsReplies)[Request['method']]> : undefined

export type PopupReplyOption =
	| NativeGnosisSafeAppsRelayReply
	| OpenGnosisSafeAppReply
	| RequestMakeMeRichDataReply
	| RequestActiveAddressesReply
	| RequestSimulationModeReply
	| RequestLatestUnexpectedErrorReply
	| RequestInterceptorSimulationInputReply
	| ImportSimulationStackReply
	| AddOrModifyAddressBookEntryReply
	| PopupSettingsChangeReply
	| ChangeActiveAddressReply
	| SetGnosisSafeSimulationSignerReply
	| RequestGnosisSafeStackExportReply
	| ImportGnosisSafeStackReply
	| RequestCompleteVisualizedSimulationReply
	| RequestSimulationMetadataReply
	| RequestAbiAndNameFromBlockExplorerReply
	| RequestIdentifyAddressReply
	| RequestGnosisSafeContractStateReply
	| funtypes.Static<typeof PopupSimulateExecutionReply>
	| RequestIsMainWindowOpen
	| RequestIsSimulationVisualizerOpen
	| PopupReadyAndListeningReply
	| undefined

export const PopupReplyOption: funtypes.Codec<PopupReplyOption> = funtypes.Union(
	NativeGnosisSafeAppsRelayReply,
	OpenGnosisSafeAppReply,
	RequestMakeMeRichDataReply,
	RequestActiveAddressesReply,
	RequestSimulationModeReply,
	RequestLatestUnexpectedErrorReply,
	RequestInterceptorSimulationInputReply,
	ImportSimulationStackReply,
	AddOrModifyAddressBookEntryReply,
	PopupSettingsChangeReply,
	ChangeActiveAddressReply,
	SetGnosisSafeSimulationSignerReply,
	RequestGnosisSafeStackExportReply,
	ImportGnosisSafeStackReply,
	RequestCompleteVisualizedSimulationReply,
	RequestSimulationMetadataReply,
	RequestAbiAndNameFromBlockExplorerReply,
	RequestIdentifyAddressReply,
	RequestGnosisSafeContractStateReply,
	PopupSimulateExecutionReply,
	RequestIsMainWindowOpen,
	RequestIsSimulationVisualizerOpen,
	PopupReadyAndListeningReply,
	funtypes.Undefined,
)
