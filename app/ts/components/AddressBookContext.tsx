import { ComponentChildren, createContext } from "preact"
import { AddressBookEntries } from "../types/addressBookTypes"
import { Signal, useSignal } from "@preact/signals"
import { useContext, useEffect } from "preact/hooks"
import { MessageToPopup } from "../types/interceptor-messages.js"

type AddressBookContext = { entries: Signal<AddressBookEntries | undefined> }
const AddressBookContext = createContext<AddressBookContext | undefined>(undefined)

export const AddressBookProvider = ({ children }: { children: ComponentChildren }) => {
	const addressBookEntries = useSignal<AddressBookEntries | undefined>(undefined)

	useEffect(() => {
		const popupMessageListener = async (msg: unknown) => {
			const maybeParsed = MessageToPopup.safeParse(msg)
			if (!maybeParsed.success) return
			const parsed = maybeParsed.value
			if (parsed.method !== 'popup_retrieveWebsiteAccessReply') return
			addressBookEntries.value = parsed.data.addressAccess
		}
		browser.runtime.onMessage.addListener(popupMessageListener)
		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	}, [])

	return <AddressBookContext.Provider value = { { entries: addressBookEntries } }>{ children }</AddressBookContext.Provider>
}

export function useAddresBook() {
	const context = useContext(AddressBookContext)
	if (context === undefined) throw new Error('useAddressBook can only be used within children of AddressBookProvider')
	return context
}
