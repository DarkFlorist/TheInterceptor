
import * as funtypes from 'funtypes'
import { AddressBookEntry } from '../types/addressBookTypes.js'
import { UnexpectedErrorOccured } from './interceptor-messages.js'

export type RequestMakeMeRichDataReply = funtypes.Static<typeof RequestMakeMeRichDataReply>
export const RequestMakeMeRichDataReply = funtypes.Union(funtypes.Undefined, funtypes.ReadonlyObject({
	richList: funtypes.ReadonlyArray(AddressBookEntry),
	makeMeRich: funtypes.Boolean,
	keepSelectedAddressRichEvenIfIChangeAddress: funtypes.Boolean,
}))

export type RequestActiveAddressesReply = funtypes.Static<typeof RequestActiveAddressesReply>
export const RequestActiveAddressesReply = funtypes.Union(funtypes.Undefined, funtypes.ReadonlyObject({
	activeAddresses: funtypes.ReadonlyArray(AddressBookEntry)
}))

export type RequestSimulationModeReply = funtypes.Static<typeof RequestSimulationModeReply>
export const RequestSimulationModeReply = funtypes.Union(funtypes.Undefined, funtypes.ReadonlyObject({
	simulationMode: funtypes.Boolean
}))

export type RequestLatestUnexpectedErrorReply = funtypes.Static<typeof RequestLatestUnexpectedErrorReply>
export const RequestLatestUnexpectedErrorReply = funtypes.Union(funtypes.Undefined, funtypes.ReadonlyObject({
	latestUnexpectedError: funtypes.Union(funtypes.Undefined, UnexpectedErrorOccured),
}))

export const PopupRequestsReplies = {
	popup_requestMakeMeRichData: RequestMakeMeRichDataReply,
	popup_requestActiveAddresses: RequestActiveAddressesReply,
	popup_requestSimulationMode: RequestSimulationModeReply,
	popup_requestLatestUnexpectedError: RequestLatestUnexpectedErrorReply,
}

export type PopupRequestsReplies = {
	[Key in keyof typeof PopupRequestsReplies]?: funtypes.Static<typeof PopupRequestsReplies[Key]>
}

export const PopupMessageReplyRequests = funtypes.Union(
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestMakeMeRichData') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestActiveAddresses') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestSimulationMode') }),
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestLatestUnexpectedError') }),
)
