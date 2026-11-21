import { getMissingPopupReplyErrorMessage, sendPopupMessageWithReply } from '../background/backgroundUtils.js'
import type { ChangeActiveAddress } from '../types/popupSettingsRequests.js'
import type { ChangeActiveAddressReply } from '../types/interceptor-reply-messages.js'
import type { ActiveAddressEntryKind } from '../utils/activeAddressSelection.js'

export type ActiveAddressChangeTarget = { readonly activeAddress: bigint | 'signer', readonly activeAddressKind?: ActiveAddressEntryKind }

export async function requestActiveAddressChange(
	{ activeAddress, activeAddressKind }: ActiveAddressChangeTarget,
	simulationMode: boolean,
	sendMessage: (message: ChangeActiveAddress) => Promise<ChangeActiveAddressReply | undefined> = sendPopupMessageWithReply,
) {
	const reply = await sendMessage({ method: 'popup_changeActiveAddress', data: { activeAddress, simulationMode, ...activeAddressKind === undefined ? {} : { activeAddressKind } } })
	if (reply === undefined) throw new Error(getMissingPopupReplyErrorMessage('Changing the active address'))
	if (!reply.ok) throw new Error(reply.message)
}
