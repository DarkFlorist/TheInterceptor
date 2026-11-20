import { useEffect, useState } from 'preact/hooks'
import type { SigningWalletBindings } from '../../types/signingWallet.js'
import { sendSigningPageRequest } from '../../utils/signingPageMessages.js'
import { MessageToPopup } from '../../types/interceptor-messages.js'
import { noReplyExpectingBrowserRuntimeOnMessageListener } from '../../utils/browser.js'

export type SigningWalletBindingsState = { readonly bindings?: SigningWalletBindings, readonly error?: string }

/** One registry subscription per list/page; rows consume this snapshot without requesting tab state themselves. */
export function useSigningWalletBindings() {
	const [state, setState] = useState<SigningWalletBindingsState>({})
	useEffect(() => {
		let active = true
		let refreshing = false
		let pending = false
		const refresh = async () => {
			pending = true
			if (refreshing) return
			refreshing = true
			try {
				while (active && pending) {
					pending = false
					try {
						const reply = await sendSigningPageRequest({ method: 'signing_wallets' })
						if (active) setState({ bindings: reply.bindings })
					} catch (failure) {
						if (active) setState({ error: failure instanceof Error ? failure.message : 'Could not load signing wallets' })
					}
				}
			} finally {
				refreshing = false
			}
		}
		// The background announces binding changes; the hook requests the bindings again instead of reading storage.
		const removeListener = noReplyExpectingBrowserRuntimeOnMessageListener((message) => {
			const parsed = MessageToPopup.safeParse(message)
			if (parsed.success && parsed.value.method === 'popup_signingWalletBindingsChanged') void refresh()
			return false
		})
		void refresh()
		return () => { active = false; removeListener() }
	}, [])
	return state
}
