import { getMissingPopupReplyErrorMessage, sendPopupMessageWithReply } from '../background/backgroundUtils.js'

type ActiveAddressChangeMessage = {
	readonly method: 'popup_changeActiveAddress'
	readonly data: {
		readonly activeAddress: bigint | 'signer'
		readonly simulationMode: boolean
	}
}

type ActiveAddressChangeReply =
	| { readonly type: 'ChangeActiveAddressReply', readonly ok: true }
	| { readonly type: 'ChangeActiveAddressReply', readonly ok: false, readonly message: string }

export async function requestActiveAddressChange(
	activeAddress: bigint | 'signer',
	simulationMode: boolean,
	sendMessage: (message: ActiveAddressChangeMessage) => Promise<ActiveAddressChangeReply | undefined> = sendPopupMessageWithReply,
) {
	const reply = await sendMessage({ method: 'popup_changeActiveAddress', data: { activeAddress, simulationMode } })
	if (reply === undefined) throw new Error(getMissingPopupReplyErrorMessage('Changing the active address'))
	if (!reply.ok) throw new Error(reply.message)
}
