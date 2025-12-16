
import * as funtypes from 'funtypes'
import { AddressBookEntry } from '../types/addressBookTypes.js'
import { EthereumTimestamp } from './wire-types.js'

export type UnexpectedErrorOccured = funtypes.Static<typeof UnexpectedErrorOccured>
export const UnexpectedErrorOccured = funtypes.ReadonlyObject({
	method: funtypes.Literal('popup_UnexpectedErrorOccured'),
	data: funtypes.ReadonlyObject({ timestamp: EthereumTimestamp, message: funtypes.String })
})

type RequestMakeMeRichDataReply = funtypes.Static<typeof RequestMakeMeRichDataReply>
const RequestMakeMeRichDataReply = funtypes.ReadonlyObject({
	type: funtypes.Literal('RequestMakeMeRichDataReply'),
	richList: funtypes.ReadonlyArray(AddressBookEntry),
	makeMeRich: funtypes.Boolean,
	keepSelectedAddressRichEvenIfIChangeAddress: funtypes.Boolean,
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

type RequestEthSimulateV1InputReply = funtypes.Static<typeof RequestEthSimulateV1InputReply>
const RequestEthSimulateV1InputReply = funtypes.ReadonlyObject({
	type: funtypes.Literal('RequestEthSimulateV1InputReply'),
	ethSimulateV1InputString: funtypes.String
})

export const PopupRequestsReplies = {
	popup_requestMakeMeRichData: RequestMakeMeRichDataReply,
	popup_requestActiveAddresses: RequestActiveAddressesReply,
	popup_requestSimulationMode: RequestSimulationModeReply,
	popup_requestLatestUnexpectedError: RequestLatestUnexpectedErrorReply,
	popup_requestInterceptorSimulateInput: RequestEthSimulateV1InputReply,
}

export type PopupRequestsReplies = {
	[Key in keyof typeof PopupRequestsReplies]?: funtypes.Static<typeof PopupRequestsReplies[Key]>
}

export const PopupMessageReplyRequests = funtypes.Union(
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestMakeMeRichData') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestActiveAddresses') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestSimulationMode') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestLatestUnexpectedError') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestInterceptorSimulateInput') }),
)

export type PopupReplyOption = funtypes.Static<typeof PopupReplyOption>
export const PopupReplyOption = funtypes.Union(
	RequestMakeMeRichDataReply,
	RequestActiveAddressesReply,
	RequestSimulationModeReply,
	RequestLatestUnexpectedErrorReply,
	RequestEthSimulateV1InputReply,
)
