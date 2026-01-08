
import * as funtypes from 'funtypes'
import { AddressBookEntry, ChainIdWithUniversal } from '../types/addressBookTypes.js'
import { EthereumAddress, EthereumQuantity, EthereumTimestamp } from './wire-types.js'
import { CompleteVisualizedSimulation, NamedTokenId } from './visualizer-types.js'

export type UnexpectedErrorOccured = funtypes.Static<typeof UnexpectedErrorOccured>
export const UnexpectedErrorOccured = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_UnexpectedErrorOccured'),
	data: funtypes.ReadonlyObject({ timestamp: EthereumTimestamp, message: funtypes.String })
})

export type EnrichedRichListElement = funtypes.Static<typeof EnrichedRichListElement>
export const EnrichedRichListElement = funtypes.ReadonlyObject({
	addressBookEntry: AddressBookEntry,
	makingRich: funtypes.Boolean,
	type: funtypes.Union(funtypes.Literal('PreviousActiveAddress'), funtypes.Literal('UserAdded'), funtypes.Literal('CurrentActiveAddress')),
})

type RequestMakeMeRichDataReply = funtypes.Static<typeof RequestMakeMeRichDataReply>
const RequestMakeMeRichDataReply = funtypes.ReadonlyObject({
	type: funtypes.Literal('RequestMakeMeRichDataReply'),
	richList: funtypes.ReadonlyArray(EnrichedRichListElement),
	makeCurrentAddressRich: funtypes.Boolean,
})

type RequestActiveAddressesReply = funtypes.Static<typeof RequestActiveAddressesReply>
const RequestActiveAddressesReply = funtypes.ReadonlyObject({
	type: funtypes.Literal('RequestActiveAddressesReply'),
	activeAddresses: funtypes.ReadonlyArray(AddressBookEntry)
})

type RequestSimulationModeReply = funtypes.Static<typeof RequestSimulationModeReply>
const RequestSimulationModeReply = funtypes.ReadonlyObject({
	type: funtypes.Literal('RequestSimulationModeReply'),
	simulationMode: funtypes.Boolean
})

type RequestLatestUnexpectedErrorReply = funtypes.Static<typeof RequestLatestUnexpectedErrorReply>
const RequestLatestUnexpectedErrorReply = funtypes.ReadonlyObject({
	type: funtypes.Literal('RequestLatestUnexpectedErrorReply'),
	latestUnexpectedError: funtypes.Union(funtypes.Undefined, UnexpectedErrorOccured),
})

type RequestInterceptorSimulationInputReply = funtypes.Static<typeof RequestInterceptorSimulationInputReply>
const RequestInterceptorSimulationInputReply = funtypes.ReadonlyObject({
	type: funtypes.Literal('RequestInterceptorSimulationInputReply'),
	ethSimulateV1InputString: funtypes.String
})

type RequestCompleteVisualizedSimulationReply = funtypes.Static<typeof RequestCompleteVisualizedSimulationReply>
const RequestCompleteVisualizedSimulationReply = funtypes.ReadonlyObject({
	type: funtypes.Literal('RequestCompleteVisualizedSimulationReply'),
	visualizedSimulatorState: funtypes.Union(CompleteVisualizedSimulation, funtypes.Undefined)
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
	type: funtypes.Literal('RequestSimulationMetadata'),
	metadata: SimulationMetadata
})

type RequestAbiAndNameFromBlockExplorerReply = funtypes.Static<typeof RequestAbiAndNameFromBlockExplorerReply>
const RequestAbiAndNameFromBlockExplorerReply = funtypes.ReadonlyObject({
	type: funtypes.Literal('RequestAbiAndNameFromBlockExplorer'),
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
		address: EthereumAddress
	})
}).asReadonly()

type RequestIdentifyAddressReply = funtypes.Static<typeof RequestIdentifyAddressReply>
const RequestIdentifyAddressReply = funtypes.ReadonlyObject({
	type: funtypes.Literal('RequestIdentifyAddress'),
	data: funtypes.ReadonlyObject({
		addressBookEntry: AddressBookEntry
	})
}).asReadonly()

type RequestIsMainWindowOpen = funtypes.Static<typeof RequestIsMainWindowOpen>
const RequestIsMainWindowOpen = funtypes.ReadonlyObject({
	type: funtypes.Literal('RequestIsMainPopupWindowOpenReply'),
	data: funtypes.ReadonlyObject({
		isOpen: funtypes.Boolean,
	})
}).asReadonly()

export const PopupRequestsReplies = {
	popup_requestMakeMeRichData: RequestMakeMeRichDataReply,
	popup_requestActiveAddresses: RequestActiveAddressesReply,
	popup_requestSimulationMode: RequestSimulationModeReply,
	popup_requestLatestUnexpectedError: RequestLatestUnexpectedErrorReply,
	popup_requestInterceptorSimulationInput: RequestInterceptorSimulationInputReply,
	popup_requestCompleteVisualizedSimulation: RequestCompleteVisualizedSimulationReply,
	popup_requestSimulationMetadata: RequestSimulationMetadataReply,
	popup_requestAbiAndNameFromBlockExplorer: RequestAbiAndNameFromBlockExplorerReply,
	popup_requestIdentifyAddress: RequestIdentifyAddressReply,
	popup_isMainPopupWindowOpen: RequestIsMainWindowOpen,
}

export type PopupRequestsReplies = {
	[Key in keyof typeof PopupRequestsReplies]?: funtypes.Static<typeof PopupRequestsReplies[Key]>
}

export type RequestAbiAndNameFromBlockExplorer = funtypes.Static<typeof RequestAbiAndNameFromBlockExplorer>
export const RequestAbiAndNameFromBlockExplorer = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_requestAbiAndNameFromBlockExplorer'),
	data: funtypes.ReadonlyObject({ address: EthereumAddress, chainId: ChainIdWithUniversal })
}).asReadonly()

export const PopupMessageReplyRequests = funtypes.Union(
	RequestAbiAndNameFromBlockExplorer,
	RequestIdentifyAddress,
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestMakeMeRichData') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestActiveAddresses') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestSimulationMode') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestLatestUnexpectedError') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestInterceptorSimulationInput') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestCompleteVisualizedSimulation') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestSimulationMetadata') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_isMainPopupWindowOpen') }),
)

export type PopupRequests = funtypes.Static<typeof PopupMessageReplyRequests>
export type PopupRequestsReplyReturn<Request extends PopupRequests> = Request['method'] extends keyof PopupRequestsReplies ? PopupRequestsReplies[Request['method']] : undefined

export type PopupReplyOption = funtypes.Static<typeof PopupReplyOption>
export const PopupReplyOption = funtypes.Union(
	RequestMakeMeRichDataReply,
	RequestActiveAddressesReply,
	RequestSimulationModeReply,
	RequestLatestUnexpectedErrorReply,
	RequestInterceptorSimulationInputReply,
	RequestCompleteVisualizedSimulationReply,
	RequestSimulationMetadataReply,
	RequestAbiAndNameFromBlockExplorerReply,
	RequestIdentifyAddressReply,
	RequestIsMainWindowOpen,
	funtypes.Undefined,
)
