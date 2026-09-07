import { getMissingPopupReplyErrorMessage, sendPopupMessageWithReply } from '../background/backgroundUtils.js'
import type { ChangeActiveAddress, ChangeActiveAddressReply } from '../types/interceptor-reply-messages.js'

export async function requestActiveAddressChange(
	activeAddress: bigint | 'signer',
	simulationMode: boolean,
	sendMessage: (message: ChangeActiveAddress) => Promise<ChangeActiveAddressReply | undefined> = sendPopupMessageWithReply,
	addressChangeRequestId?: string,
) {
	const reply = await sendMessage({ method: 'popup_changeActiveAddress', data: { activeAddress, simulationMode, ...(addressChangeRequestId === undefined ? {} : { addressChangeRequestId }) } })
	if (reply === undefined) throw new Error(getMissingPopupReplyErrorMessage('Changing the active address'))
	if (!reply.ok) throw new Error(reply.message)
}
