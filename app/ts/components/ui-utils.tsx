import { ethers } from 'ethers'
import { Ref, useEffect } from 'preact/hooks'
import { getUseTabsInsteadOfPopup } from '../background/settings.js'
import { assertNever } from '../utils/typescript.js'
import { ComponentChildren } from 'preact'
import { EthereumAddress } from '../types/wire-types.js'
import { AddressBookEntry } from '../types/addressBookTypes.js'
import { checksummedAddress } from '../utils/bigint.js'
import { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { checkAndThrowRuntimeLastError, safeGetTab, safeGetWindow, updateTabIfExists, updateWindowIfExists } from '../utils/requests.js'

function assertIsNode(e: EventTarget | null): asserts e is Node {
	if (!e || !('nodeType' in e)) {
        throw new Error('Node expected')
    }
}

export function clickOutsideAlerter(ref: Ref<HTMLDivElement>, callback: () => void) {
	useEffect(() => {
		function handleClickOutside({ target }: MouseEvent) {
			assertIsNode(target);
			if (ref.current && !ref.current.contains(target)) {
				callback()
			}
		}

		document.addEventListener('mousedown', handleClickOutside);

		return () => {
			document.removeEventListener('mousedown', handleClickOutside);
		}
	}, [ref]);
}

export function getIssueWithAddressString(address: string): string | undefined {
	if (address.length > 42) return 'Address is too long.'
	if (address.length > 2 && address.substring(0, 2) !== '0x') { return 'Address does not contain 0x prefix.' }
	if (address.length < 42) return 'Address is too short.'

    if (address.match(/^(0x)?[0-9a-fA-F]{40}$/)) {
        const checkSummedAddress = ethers.getAddress(address.toLowerCase());

        // It is a checksummed address with a bad checksum
        if (checkSummedAddress !== address && address.toLowerCase() !== address) {
            return `Bad address checksum, did you mean ${ checkSummedAddress } ?`;
        }
    } else {
        return 'Address contains invalid characters.'
    }

    return undefined
}

export function upperCaseFirstCharacter(text: string) {
	if (text.length === 0) return text
	return text.charAt(0).toUpperCase() + text.slice(1)
}

export function convertNumberToCharacterRepresentationIfSmallEnough(num: number) {
	const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
	const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
	const teens = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']

	function convertTens(num: number) {
		if (num < 10) return ones[num]
		if (num >= 10 && num < 20) return teens[num - 10]
		return tens[Math.floor(num / 10)] + " " + ones[num % 10]
	}

	if (num === 0) return 'zero'
	if (num > 99) return num.toString()
	const convertedNumber = convertTens(num)
	if (convertedNumber === undefined) throw new Error('index error when trying to convert number into a string')
	return convertedNumber
}

export const humanReadableDate = (date: Date) => date.toISOString()

export function humanReadableDateFromSeconds(timeInSeconds: bigint) {
	return humanReadableDate(new Date(Number(timeInSeconds) * 1000))
}

export type PopupOrTab = {
	window: browser.windows.Window,
	type: 'popup'
	id: number
} | {
	tab: browser.tabs.Tab,
	type: 'tab'
	id: number
}

export async function openPopupOrTab(createData: browser.windows._CreateCreateData & { url: string }) : Promise<PopupOrTab | undefined> {
	if (await getUseTabsInsteadOfPopup()) {
		const tab = await browser.tabs.create({ url: createData.url })
		if (tab === undefined || tab === null || tab.id === undefined) return undefined
		return { type: 'tab', id: tab.id, tab }
	}
	const window = await browser.windows.create(createData)
	if (window === undefined || window === null || window.id === undefined) return undefined
	return { type: 'popup', id: window.id, window }
}

export async function getPopupOrTabById(popupOrTabId: PopupOrTabId) : Promise<PopupOrTab | undefined> {
	switch (popupOrTabId.type) {
		case 'tab': {
			const tab = await safeGetTab(popupOrTabId.id)
			if (tab === undefined || tab.id === undefined) return undefined
			return { type: 'tab', id: tab.id, tab }
		}
		case 'popup': {
			const window = await safeGetWindow(popupOrTabId.id)
			if (window === undefined || window === null || window.id === undefined) return undefined
			return { type: 'popup', id: window.id, window }
		}
		default: assertNever(popupOrTabId.type)
	}
}

export async function closePopupOrTabById(popupOrTabId: PopupOrTabId) {
	try {
		switch (popupOrTabId.type) {
			case 'tab': {
				await browser.tabs.remove(popupOrTabId.id)
				break
			}
			case 'popup': {
				await browser.windows.remove(popupOrTabId.id)
				break
			}
			default: assertNever(popupOrTabId.type)
		}
		checkAndThrowRuntimeLastError()
	} catch(error) {
		if (error instanceof Error && error.message.startsWith('No tab with id')) return
		throw error
	}
}

export function addWindowTabListeners(onCloseWindow: (id: number) => void, onCloseTab: (id: number) => void) {
	browser.windows.onRemoved.addListener(onCloseWindow)
	browser.tabs.onRemoved.addListener(onCloseTab)
}

export function removeWindowTabListeners(onCloseWindow: (id: number) => void, onCloseTab: (id: number) => void) {
	browser.windows.onRemoved.removeListener(onCloseWindow)
	browser.tabs.onRemoved.removeListener(onCloseTab)
}

export async function tryFocusingTabOrWindow(popupOrTab: PopupOrTabId) {
	if (popupOrTab.type === 'tab') {
		// highlight the window the tab is in
		const tab = await browser.tabs.get(popupOrTab.id)
		if (tab !== undefined && tab.windowId !== undefined) await browser.windows.update(tab.windowId, { drawAttention: true, focused: true })
		// highlight the tab itself
		return await updateTabIfExists(popupOrTab.id, { active: true, highlighted: true })
	}
	return await updateWindowIfExists(popupOrTab.id, { drawAttention: true, focused: true })
}

export const CellElement = (param: { text: ComponentChildren, useLegibleFont?: boolean }) => {
	return <div class = 'log-cell' style = 'justify-content: right;'>
		<p class = { `paragraph${ param.useLegibleFont ? ' text-legible' : '' }` } style = 'color: var(--subtitle-text-color); text-overflow: ellipsis; overflow: hidden;'>{ param.text }</p>
	</div>
}

export const getAddressBookEntryOrAFiller = (addressMetaData: readonly AddressBookEntry[], addressToFind: EthereumAddress) => {
	const foundEntry = addressMetaData.find((entry) => entry.address === addressToFind)
	if (foundEntry !== undefined) return foundEntry
	return {
		type: 'contact' as const,
		name: checksummedAddress(addressToFind),
		address: addressToFind,
		entrySource: 'FilledIn' as const
	}
}

