
import * as funtypes from 'funtypes'
import { AddressBookEntry } from '../types/addressBookTypes.js'

export type RequestMakeMeRichDataReply = funtypes.Static<typeof RequestMakeMeRichDataReply>
export const RequestMakeMeRichDataReply = funtypes.Union(funtypes.Undefined, funtypes.ReadonlyObject({
	richList: funtypes.ReadonlyArray(AddressBookEntry),
	makeMeRich: funtypes.Boolean,
	keepSelectedAddressRichEvenIfIChangeAddress: funtypes.Boolean,
}))

export type PopupRequestsReplies = funtypes.Static<typeof PopupRequestsReplies>
export const PopupRequestsReplies = funtypes.ReadonlyObject({
	popup_requestMakeMeRichData: RequestMakeMeRichDataReply
})

export const PopupMessageReplyRequests = funtypes.Union(
	funtypes.ReadonlyObject({ method: funtypes.Literal('popup_requestMakeMeRichData') })
)
