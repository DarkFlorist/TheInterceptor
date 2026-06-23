import { getUseTabsInsteadOfPopup } from '../background/settings.js'
import { assertNever } from './typescript.js'
import type { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { checkAndThrowRuntimeLastError, getTabIfExists, getWindowIfExists, isMissingBrowserTargetError, updateTabIfExists, updateWindowIfExists } from './requests.js'

export type PopupOrTab = {
	window: browser.windows.Window
	type: 'popup'
	id: number
} | {
	tab: browser.tabs.Tab
	type: 'tab'
	id: number
}

export async function openPopupOrTab(createData: browser.windows._CreateCreateData & { url: string }): Promise<PopupOrTab | undefined> {
	if (await getUseTabsInsteadOfPopup()) {
		const tab = await browser.tabs.create({ url: createData.url })
		if (tab === undefined || tab.id === undefined) return undefined
		return { type: 'tab', id: tab.id, tab }
	}
	const window = await browser.windows.create(createData)
	if (window === undefined || window.id === undefined) return undefined
	return { type: 'popup', id: window.id, window }
}

export async function getPopupOrTabById(popupOrTabId: PopupOrTabId): Promise<PopupOrTab | undefined> {
	switch (popupOrTabId.type) {
		case 'tab': {
			const tab = await getTabIfExists(popupOrTabId.id)
			if (tab === undefined || tab.id === undefined) return undefined
			return { type: 'tab', id: tab.id, tab }
		}
		case 'popup': {
			const window = await getWindowIfExists(popupOrTabId.id)
			if (window === undefined || window.id === undefined) return undefined
			return { type: 'popup', id: window.id, window }
		}
		default: assertNever(popupOrTabId.type)
	}
}

export async function closePopupOrTabById(popupOrTabId: PopupOrTabId) {
	try {
		switch (popupOrTabId.type) {
			case 'tab': {
				const tab = await getTabIfExists(popupOrTabId.id)
				if (tab !== undefined) await browser.tabs.remove(popupOrTabId.id)
				break
			}
			case 'popup': {
				const window = await getWindowIfExists(popupOrTabId.id)
				if (window !== undefined) await browser.windows.remove(popupOrTabId.id)
				break
			}
			default: assertNever(popupOrTabId.type)
		}
		checkAndThrowRuntimeLastError()
	} catch (error) {
		if (isMissingBrowserTargetError(error)) return
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
		const tab = await browser.tabs.get(popupOrTab.id)
		if (tab !== undefined && tab.windowId !== undefined) await browser.windows.update(tab.windowId, { drawAttention: true, focused: true })
		return await updateTabIfExists(popupOrTab.id, { active: true, highlighted: true })
	}
	return await updateWindowIfExists(popupOrTab.id, { drawAttention: true, focused: true })
}
