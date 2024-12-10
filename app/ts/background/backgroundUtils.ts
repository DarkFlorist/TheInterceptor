import { MessageToPopup, PopupMessage, Settings, WindowMessage } from '../types/interceptor-messages.js'
import { WebsiteSocket, checkAndThrowRuntimeLastError } from '../utils/requests.js'
import { EthereumQuantity, serialize } from '../types/wire-types.js'
import { getAllTabStates, getTabState } from './storageVariables.js'
import { getActiveAddressEntry } from './metadataUtils.js'
import { handleUnexpectedError } from '../utils/errors.js'

export async function getActiveAddress(settings: Settings, tabId: number) {
	if (settings.simulationMode && !settings.useSignersAddressAsActiveAddress) {
		return settings.activeSimulationAddress !== undefined ? await getActiveAddressEntry(settings.activeSimulationAddress) : undefined
	}
	const signingAddr = (await getTabState(tabId)).activeSigningAddress
	if (signingAddr === undefined) return undefined
	return await getActiveAddressEntry(signingAddr)
}

export async function getActiveAddressesForAllTabs(settings: Settings) {
	const tabStates = await getAllTabStates()
	if (settings.simulationMode && !settings.useSignersAddressAsActiveAddress) {
		const addressEntry = settings.activeSimulationAddress !== undefined ? await getActiveAddressEntry(settings.activeSimulationAddress) : undefined
		return tabStates.map((state) => ({ tabId: state.tabId, activeAddress: addressEntry }))
	}
	return Promise.all(tabStates.map(async (state) => ({ tabId: state.tabId, activeAddress: state.activeSigningAddress === undefined ? undefined : await getActiveAddressEntry(state.activeSigningAddress) })))
}

export async function sendPopupMessageToOpenWindows(message: MessageToPopup) {
	try {
		await browser.runtime.sendMessage(serialize(MessageToPopup, message))
		checkAndThrowRuntimeLastError()
		return true
	} catch (error) {
		if (error instanceof Error) {
			if (error?.message?.includes('Could not establish connection.')) {
				// ignore this error, this error is thrown when a popup is not open to receive the message
				// we are ignoring this error because the popup messaging is used to update a popups UI, and if a popup is not open, we don't need to update the UI
				return false
			}
			if (error?.message?.includes('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received')) {
				return false
			}
			if (error?.message?.includes('The message port closed before a response was received')) {
				return false
			}
		}
		handleUnexpectedError(error)
		return false
	}
}

export async function sendPopupMessageToBackgroundPage(message: PopupMessage) {
	try {
		await browser.runtime.sendMessage(serialize(PopupMessage, message))
		checkAndThrowRuntimeLastError()
		return true
	} catch (error) {
		if (error instanceof Error) {
			if (error?.message?.includes('The message port closed before a response was received')) {
				return false
			}
		}
		handleUnexpectedError(error)
		return false
	}
}

export const INTERNAL_CHANNEL_NAME = 'internalChannel'

export function sendInternalWindowMessage(message: WindowMessage) {
	new BroadcastChannel(INTERNAL_CHANNEL_NAME).postMessage(serialize(WindowMessage, message))
}

export function createInternalMessageListener(handler: (message: WindowMessage) => void) {
	return (message: MessageEvent) => {
		if (message.origin !== globalThis.location.origin) return
		handler(WindowMessage.parse(message.data))
	}
}

type HTMLFile = 'popup' | 'addressBook' | 'changeChain' | 'confirmTransaction' | 'interceptorAccess' | 'personalSign' | 'settingsView' | 'websiteAccess'
export function getHtmlFile(file: HTMLFile) {
	const manifest = browser.runtime.getManifest()
	if (manifest.manifest_version === 2) return `/html/${ file }.html`
	return `/html3/${ file }V3.html`
}

export async function setExtensionIcon(details: browser.action._SetIconDetails) {
	const manifest = browser.runtime.getManifest()
	if (manifest.manifest_version === 2) {
		await browser.browserAction.setIcon(details)
	} else {
		// see https://issues.chromium.org/issues/337214677
		await (browser.action.setIcon as unknown as ((details: browser.action._SetIconDetails, callback: () => void) => Promise<void>))(details, () => { browser.runtime.lastError })
	}
	checkAndThrowRuntimeLastError()
}

export async function setExtensionTitle(details: browser.action._SetTitleDetails) {
	const manifest = browser.runtime.getManifest()
	if (manifest.manifest_version === 2) {
		await browser.browserAction.setTitle(details)
	} else {
		await browser.action.setTitle(details)
	}
	checkAndThrowRuntimeLastError()
}

export async function setExtensionBadgeText(details: browser.browserAction._SetBadgeTextDetails) {
	try {
		const manifest = browser.runtime.getManifest()
		if (manifest.manifest_version === 2) {
			await browser.browserAction.setBadgeText(details)
		} else {
			// see https://issues.chromium.org/issues/337214677
			await (browser.action.setBadgeText as unknown as ((details: browser.browserAction._SetBadgeTextDetails, callback: () => void) => Promise<void>))(details, () => { browser.runtime.lastError })
		}
		checkAndThrowRuntimeLastError()
	} catch {
		console.warn('failed to set extension badge text')
		console.warn(details)
	}
}

export async function setExtensionBadgeBackgroundColor(details: browser.action._SetBadgeBackgroundColorDetails) {
	try {
		const manifest = browser.runtime.getManifest()
		if (manifest.manifest_version === 2) {
			await browser.browserAction.setBadgeBackgroundColor(details)
		} else {
			// see https://issues.chromium.org/issues/337214677
			await (browser.action.setBadgeBackgroundColor as unknown as ((details: browser.action._SetBadgeBackgroundColorDetails, callback: () => void) => Promise<void>))(details, () => { browser.runtime.lastError })
		}
		checkAndThrowRuntimeLastError()
	} catch {
		console.warn('failed to set extension badge background color')
		console.warn(details)
	}
}

export const websiteSocketToString = (socket: WebsiteSocket) => `${ socket.tabId }-${ serialize(EthereumQuantity, socket.connectionName) }`

export const getSocketFromPort = (port: browser.runtime.Port) => {
	if (port.sender?.tab?.id === undefined) throw new Error('tab id not found in socket')
	return { tabId: port.sender?.tab?.id, connectionName: EthereumQuantity.parse(port.name) }
}
