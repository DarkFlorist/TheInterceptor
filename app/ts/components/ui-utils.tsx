import { ethers } from 'ethers'
import { Ref, useEffect } from 'preact/hooks'
import { getUseTabsInsteadOfPopup } from '../background/settings.js'
import { assertNever } from '../utils/typescript.js'
import { ComponentChildren } from 'preact'
import { RpcNetwork } from '../types/rpc.js'
import { EthereumAddress } from '../types/wire-types.js'
import { AddressBookEntry } from '../types/addressBookTypes.js'
import { checksummedAddress } from '../utils/bigint.js'
import { PopupOrTabId } from '../types/websiteAccessTypes.js'

function assertIsNode(e: EventTarget | null): asserts e is Node {
	if (!e || !('nodeType' in e)) {
        throw new Error(`Node expected`)
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

    return undefined;
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
		else if (num >= 10 && num < 20) return teens[num - 10]
		else {
			return tens[Math.floor(num / 10)] + " " + ones[num % 10]
		}
	}

	if (num == 0) return 'zero'
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
	browserObject: browser.windows.Window,
	popupOrTab: { type: 'popup',  id: number }
} | {
	browserObject: browser.tabs.Tab,
	popupOrTab: { type: 'tab',  id: number }
}

export async function openPopupOrTab(createData: browser.windows._CreateCreateData & { url: string }) : Promise<PopupOrTab | undefined> {
	if (await getUseTabsInsteadOfPopup()) {
		const tab = await browser.tabs.create({ url: createData.url })
		if (tab === undefined || tab === null || tab.id === undefined) return undefined
		return { popupOrTab: { type: 'tab', id: tab.id }, browserObject: tab }
	}
	const window = await browser.windows.create(createData)
	if (window === undefined || window === null || window.id === undefined) return undefined
	return { popupOrTab: { type: 'popup', id: window.id }, browserObject: window }
}

export async function browserTabsQueryById(id: number) {
	return (await browser.tabs.query({})).find((x) => x.id === id)
}

export async function getPopupOrTabById(popupOrTabId: PopupOrTabId) : Promise<PopupOrTab | undefined> {
	switch (popupOrTabId.type) {
		case 'tab': {
			try {
				const tab = await browserTabsQueryById(popupOrTabId.id)
				if (tab === undefined || tab.id === undefined) return undefined
				return { popupOrTab: { type: 'tab', id: tab.id }, browserObject: tab }
			} catch(e) {
				return undefined
			}
		}
		case 'popup': {
			try {
				const window = await browser.windows.get(popupOrTabId.id)
				if (window === undefined || window === null || window.id === undefined) return undefined
				return { popupOrTab: { type: 'popup', id: window.id }, browserObject: window }
			} catch(e) {
				return undefined
			}
		}
		default: assertNever(popupOrTabId.type)
	}
}

export async function getPopupOrTabOnlyById(popupOrTab: PopupOrTabId) : Promise<PopupOrTab | undefined> {
	switch (popupOrTab.type) {
		case 'tab': {
			try {
				const tab = await browserTabsQueryById(popupOrTab.id)
				if (tab !== undefined) return { popupOrTab: { type: 'tab', id: popupOrTab.id }, browserObject: tab }
			} catch(e) {
				console.log('Failed to focus tab:', popupOrTab.id)
				console.warn(e)
			}
			return undefined
		}
		case 'popup': {
			try {
				const window = await browser.windows.get(popupOrTab.id)
				if (window === undefined || window === null) return undefined
				return { popupOrTab: { type: 'popup', id: popupOrTab.id }, browserObject: window }
			} catch(e) {
				console.log('Failed to focus poup:', popupOrTab.id)
				console.warn(e)
			}
			return undefined
		}
		default: assertNever(popupOrTab.type)
	}
}

export async function closePopupOrTabById(popupOrTabId: PopupOrTabId) {
	try {
		switch (popupOrTabId.type) {
			case 'tab': return await browser.tabs.remove(popupOrTabId.id)
			case 'popup': return await browser.windows.remove(popupOrTabId.id)
			default: assertNever(popupOrTabId.type)
		}
	} catch(e) {
		console.log(`Failed to close ${ popupOrTabId.type }: ${ popupOrTabId.id }`)
		console.warn(e)
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
	try {
		if (popupOrTab.type === 'tab') {
			await browser.tabs.update(popupOrTab.id, { active: true })
		} else {
			await browser.windows.update(popupOrTab.id, { focused: true })
		}
	} catch(e) {
		console.warn('failed to focus', popupOrTab.type, ': ', popupOrTab.id)
		console.warn(e)
	}
}

export const CellElement = (param: { text: ComponentChildren }) => {
	return <div class = 'log-cell' style = 'justify-content: right;'>
		<p class = 'paragraph' style = 'color: var(--subtitle-text-color); text-overflow: ellipsis; overflow: hidden;'>{ param.text }</p>
	</div>
}

export const getArtificialERC20ForEth = (rpcNetwork: RpcNetwork) => {
	return {
		address: 0n,
		logoUri: '../../img/coins/ethereum.png',
		symbol: rpcNetwork.currencyTicker,
		decimals: 18n,
		name: rpcNetwork.currencyName,
		type: 'ERC20' as const,
		entrySource: 'DarkFloristMetadata' as const,
	}
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
