import * as funtypes from 'funtypes'
import {
	AddressBookEntry,
	ChainIdWithUniversal,
} from '../types/addressBookTypes.js'
import { PopupOrTabId } from './websiteAccessTypes.js'
import {
	CompleteVisualizedSimulation,
	InterceptorSimulationExport,
	NamedTokenId,
} from './visualizer-types.js'
import {
	EthereumAddress,
	EthereumQuantity,
	EthereumTimestamp,
} from './wire-types.js'

export type UnexpectedErrorOccured = funtypes.Static<
	typeof UnexpectedErrorOccured
>
export const UnexpectedErrorOccured = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_UnexpectedErrorOccured'),
	data: funtypes.ReadonlyObject({
		timestamp: EthereumTimestamp,
		message: funtypes.String,
		source: funtypes.String,
		code: funtypes.String,
		debugId: funtypes.Union(funtypes.String, funtypes.Undefined),
	}),
})

export type EnrichedRichListElement = funtypes.Static<
	typeof EnrichedRichListElement
>
export const EnrichedRichListElement = funtypes.ReadonlyObject({
	addressBookEntry: AddressBookEntry,
	makingRich: funtypes.Boolean,
	type: funtypes.Union(
		funtypes.Literal('PreviousActiveAddress'),
		funtypes.Literal('UserAdded'),
		funtypes.Literal('CurrentActiveAddress'),
	),
})

type RequestMakeMeRichDataReply = funtypes.Static<
	typeof RequestMakeMeRichDataReply
>
const RequestMakeMeRichDataReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestMakeMeRichData'),
	richList: funtypes.ReadonlyArray(EnrichedRichListElement),
	makeCurrentAddressRich: funtypes.Boolean,
})

type RequestActiveAddressesReply = funtypes.Static<
	typeof RequestActiveAddressesReply
>
const RequestActiveAddressesReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestActiveAddresses'),
	activeAddresses: funtypes.ReadonlyArray(AddressBookEntry),
})

type RequestSimulationModeReply = funtypes.Static<
	typeof RequestSimulationModeReply
>
const RequestSimulationModeReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestSimulationMode'),
	simulationMode: funtypes.Boolean,
})

type RequestLatestUnexpectedErrorReply = funtypes.Static<
	typeof RequestLatestUnexpectedErrorReply
>
const RequestLatestUnexpectedErrorReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestLatestUnexpectedError'),
	latestUnexpectedError: funtypes.Union(
		funtypes.Undefined,
		UnexpectedErrorOccured,
	),
})

type RequestInterceptorSimulationInputReply = funtypes.Static<
	typeof RequestInterceptorSimulationInputReply
>
const RequestInterceptorSimulationInputReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestInterceptorSimulationInput'),
	ethSimulateV1InputString: funtypes.String,
})

export type ImportSimulationStackReply = funtypes.Static<
	typeof ImportSimulationStackReply
>
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

type RequestCompleteVisualizedSimulationReply = funtypes.Static<
	typeof RequestCompleteVisualizedSimulationReply
>
const RequestCompleteVisualizedSimulationReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestCompleteVisualizedSimulation'),
	visualizedSimulatorState: CompleteVisualizedSimulation,
})

export type SimulationMetadata = funtypes.Static<typeof SimulationMetadata>
export const SimulationMetadata = funtypes.ReadonlyObject({
	namedTokenIds: funtypes.ReadonlyArray(NamedTokenId),
	addressBookEntries: funtypes.ReadonlyArray(AddressBookEntry),
	ens: funtypes.ReadonlyObject({
		ensNameHashes: funtypes.ReadonlyArray(
			funtypes.ReadonlyObject({
				nameHash: EthereumQuantity,
				name: funtypes.Union(funtypes.String, funtypes.Undefined),
			}),
		),
		ensLabelHashes: funtypes.ReadonlyArray(
			funtypes.ReadonlyObject({
				labelHash: EthereumQuantity,
				label: funtypes.Union(funtypes.String, funtypes.Undefined),
			}),
		),
	}),
})

type RequestSimulationMetadataReply = funtypes.Static<
	typeof RequestSimulationMetadataReply
>
const RequestSimulationMetadataReply = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestSimulationMetadata'),
	metadata: SimulationMetadata,
})

type RequestAbiAndNameFromBlockExplorerReply = funtypes.Static<
	typeof RequestAbiAndNameFromBlockExplorerReply
>
const RequestAbiAndNameFromBlockExplorerReply = funtypes
	.ReadonlyObject({
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
		),
	})
	.asReadonly()

export type RequestIdentifyAddress = funtypes.Static<
	typeof RequestIdentifyAddress
>
export const RequestIdentifyAddress = funtypes
	.ReadonlyObject({
		method: funtypes.Literal('popup_requestIdentifyAddress'),
		data: funtypes.ReadonlyObject({
			address: EthereumAddress,
		}),
	})
	.asReadonly()

type RequestIdentifyAddressReply = funtypes.Static<
	typeof RequestIdentifyAddressReply
>
const RequestIdentifyAddressReply = funtypes
	.ReadonlyObject({
		method: funtypes.Literal('popup_requestIdentifyAddress'),
		data: funtypes.ReadonlyObject({
			addressBookEntry: AddressBookEntry,
		}),
	})
	.asReadonly()

type RequestIsMainWindowOpen = funtypes.Static<typeof RequestIsMainWindowOpen>
const RequestIsMainWindowOpen = funtypes
	.ReadonlyObject({
		method: funtypes.Literal('popup_isMainPopupWindowOpen'),
		data: funtypes.ReadonlyObject({
			isOpen: funtypes.Boolean,
		}),
	})
	.asReadonly()

type PopupReadyAndListeningReply = funtypes.Static<
	typeof PopupReadyAndListeningReply
>
const PopupReadyAndListeningReply = funtypes
	.ReadonlyObject({
		method: funtypes.Literal('popup_readyAndListening'),
		data: funtypes.ReadonlyObject({
			popupOrTabId: PopupOrTabId,
		}),
	})
	.asReadonly()

export const PopupRequestsReplies = {
	popup_requestMakeMeRichData: RequestMakeMeRichDataReply,
	popup_requestActiveAddresses: RequestActiveAddressesReply,
	popup_requestSimulationMode: RequestSimulationModeReply,
	popup_requestLatestUnexpectedError: RequestLatestUnexpectedErrorReply,
	popup_requestInterceptorSimulationInput:
		RequestInterceptorSimulationInputReply,
	popup_importSimulationStack: ImportSimulationStackReply,
	popup_requestCompleteVisualizedSimulation:
		RequestCompleteVisualizedSimulationReply,
	popup_requestSimulationMetadata: RequestSimulationMetadataReply,
	popup_requestAbiAndNameFromBlockExplorer:
		RequestAbiAndNameFromBlockExplorerReply,
	popup_requestIdentifyAddress: RequestIdentifyAddressReply,
	popup_isMainPopupWindowOpen: RequestIsMainWindowOpen,
	popup_readyAndListening: PopupReadyAndListeningReply,
}

type PopupRequestsReplies = {
	[Key in keyof typeof PopupRequestsReplies]?: funtypes.Static<
		(typeof PopupRequestsReplies)[Key]
	>
}

export type RequestAbiAndNameFromBlockExplorer = funtypes.Static<
	typeof RequestAbiAndNameFromBlockExplorer
>
export const RequestAbiAndNameFromBlockExplorer = funtypes
	.ReadonlyObject({
		method: funtypes.Literal('popup_requestAbiAndNameFromBlockExplorer'),
		data: funtypes.ReadonlyObject({
			address: EthereumAddress,
			chainId: ChainIdWithUniversal,
		}),
	})
	.asReadonly()

export const PopupMessageReplyRequests = funtypes.Union(
	RequestAbiAndNameFromBlockExplorer,
	RequestIdentifyAddress,
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_requestMakeMeRichData'),
	}),
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_requestActiveAddresses'),
	}),
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_requestSimulationMode'),
	}),
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_requestLatestUnexpectedError'),
	}),
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_requestInterceptorSimulationInput'),
	}),
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_importSimulationStack'),
		data: InterceptorSimulationExport,
	}),
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_requestCompleteVisualizedSimulation'),
	}),
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_requestSimulationMetadata'),
	}),
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_isMainPopupWindowOpen'),
	}),
	funtypes.ReadonlyObject({
		method: funtypes.Literal('popup_readyAndListening'),
		data: funtypes.ReadonlyObject({
			page: funtypes.Union(
				funtypes.Literal('changeChain'),
				funtypes.Literal('confirmTransaction'),
				funtypes.Literal('interceptorAccess'),
				funtypes.Literal('fetchSimulationStack'),
			),
		}),
	}),
)

export type PopupRequests = funtypes.Static<typeof PopupMessageReplyRequests>
export type PopupRequestsReplyReturn<Request extends PopupRequests> =
	Request['method'] extends keyof typeof PopupRequestsReplies
		? funtypes.Static<(typeof PopupRequestsReplies)[Request['method']]>
		: undefined

export type PopupReplyOption = funtypes.Static<typeof PopupReplyOption>
export const PopupReplyOption = funtypes.Union(
	RequestMakeMeRichDataReply,
	RequestActiveAddressesReply,
	RequestSimulationModeReply,
	RequestLatestUnexpectedErrorReply,
	RequestInterceptorSimulationInputReply,
	ImportSimulationStackReply,
	RequestCompleteVisualizedSimulationReply,
	RequestSimulationMetadataReply,
	RequestAbiAndNameFromBlockExplorerReply,
	RequestIdentifyAddressReply,
	RequestIsMainWindowOpen,
	PopupReadyAndListeningReply,
	funtypes.Undefined,
)
