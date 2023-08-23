import { ethers } from 'ethers'
import { Ref, useEffect } from 'preact/hooks'
import { getUseTabsInsteadOfPopup } from '../background/settings.js'
import { assertNever } from '../utils/typescript.js'
import { ComponentChildren } from 'preact'
import { WindowOrTabId } from '../utils/user-interface-types.js'

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
	const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
	const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
	const teens = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];

	function convertTens(num: number) {
		if (num < 10) return ones[num];
		else if (num >= 10 && num < 20) return teens[num - 10];
		else {
			return tens[Math.floor(num / 10)] + " " + ones[num % 10];
		}
	}

	if (num == 0) return 'zero'
	if (num > 99) return num.toString()
	return convertTens(num)
}

export const humanReadableDate = (date: Date) => date.toISOString()

export function humanReadableDateFromSeconds(timeInSeconds: bigint) {
	return humanReadableDate(new Date(Number(timeInSeconds) * 1000))
}

export type PopupOrTabId = {
	id: number,
	type: 'tab' | 'popup'
}

export type PopupOrTab = {
	windowOrTab: browser.windows.Window,
	type: 'popup'
} | {
	windowOrTab: browser.tabs.Tab,
	type: 'tab'
}

export async function openPopupOrTab(createData: browser.windows._CreateCreateData & { url: string }) : Promise<PopupOrTab | undefined> {
	if (await getUseTabsInsteadOfPopup()) {
		const tab = await browser.tabs.create({ url: createData.url })
		if (tab === undefined || tab === null) return undefined
		return { type: 'tab', windowOrTab: tab }
	}
	const window = await browser.windows.create(createData)
	if (window === undefined || window === null) return undefined
	return { type: 'popup', windowOrTab: window }
}

export async function browserTabsQueryById(id: number) {
	return (await browser.tabs.query({})).find((x) => x.id === id)
}

export async function getPopupOrTabById(popupOrTabId: PopupOrTabId) : Promise<PopupOrTab | undefined> {
	switch (popupOrTabId.type) {
		case 'tab': {
			try {
				const tab = await browserTabsQueryById(popupOrTabId.id)
				if (tab === undefined) return undefined
				return { type: 'tab', windowOrTab: tab }
			} catch(e) {
				return undefined
			}
		}
		case 'popup': {
			try {
				const window = await browser.windows.get(popupOrTabId.id)
				if (window === undefined || window === null) return undefined
				return { type: 'popup', windowOrTab: window }
			} catch(e) {
				return undefined
			}
		}
		default: assertNever(popupOrTabId.type)
	}
}

export async function getPopupOrTabOnlyById(id: number) : Promise<PopupOrTab | undefined> {
	try {
		const tab = await browserTabsQueryById(id)
		if (tab !== undefined) return { type: 'tab', windowOrTab: tab }
	} catch(e) {}
	try {
		const window = await browser.windows.get(id)
		if (window === undefined || window === null) return undefined
		return { type: 'popup', windowOrTab: window }
	} catch(e) {}
	return undefined
}

export async function closePopupOrTabById(popupOrTabId: PopupOrTabId) {
	try {
		switch (popupOrTabId.type) {
			case 'tab': return await browser.tabs.remove(popupOrTabId.id)
			case 'popup': return await browser.windows.remove(popupOrTabId.id)
			default: assertNever(popupOrTabId.type)
		}
	} catch(e) {}
}

export async function closePopupOrTab(popupOrTab: PopupOrTab) {
	if (popupOrTab.windowOrTab.id === undefined) return
	try {
		switch (popupOrTab.type) {
			case 'tab': return await browser.tabs.remove(popupOrTab.windowOrTab.id)
			case 'popup': return await browser.windows.remove(popupOrTab.windowOrTab.id)
			default: assertNever(popupOrTab)
		}
	} catch(e) {}
}

export function addWindowTabListener(onCloseWindow: (id: number) => void) {
	browser.windows.onRemoved.addListener(onCloseWindow)
	browser.tabs.onRemoved.addListener(onCloseWindow)
}

export function removeWindowTabListener(onCloseWindow: (id: number) => void) {
	browser.windows.onRemoved.removeListener(onCloseWindow)
	browser.tabs.onRemoved.removeListener(onCloseWindow)
}

export async function tryFocusingTabOrWindow(windowOrTab: WindowOrTabId) {
	try {
		if (windowOrTab.type === 'tab') {
			browser.tabs.update(windowOrTab.id, { active: true })
		} else {
			browser.windows.update(windowOrTab.id, { focused: true })
		}
	} catch(e) {
		console.warn('failed to focus', windowOrTab.type, ': ', windowOrTab.id)
		console.warn(e)
	}
}

export const CellElement = (param: { text: ComponentChildren }) => {
	return <div class = 'log-cell' style = 'justify-content: right;'>
		<p class = 'paragraph' style = 'color: var(--subtitle-text-color); text-overflow: ellipsis; overflow: hidden;width: 100%;'>{ param.text }</p>
	</div>
}
