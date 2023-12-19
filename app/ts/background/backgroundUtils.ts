import { MessageToPopup, PopupMessage, Settings, WindowMessage } from '../types/interceptor-messages.js'
import { WebsiteSocket } from '../utils/requests.js'
import { EthereumQuantity, serialize } from '../types/wire-types.js'
import { getTabState } from './storageVariables.js'
import { getActiveAddressEntry } from './metadataUtils.js'

export async function getActiveAddress(settings: Settings, tabId: number) {
	if (settings.simulationMode && !settings.useSignersAddressAsActiveAddress) {
		return settings.activeSimulationAddress !== undefined ? await getActiveAddressEntry(settings.activeSimulationAddress) : undefined
	}
	const signingAddr = (await getTabState(tabId)).activeSigningAddress
	if (signingAddr === undefined) return undefined
	return await getActiveAddressEntry(signingAddr)
}

export async function sendPopupMessageToOpenWindows(message: MessageToPopup) {
	try {
		await browser.runtime.sendMessage(serialize(MessageToPopup, message))
	} catch (error) {
		if (error instanceof Error) {
			if (error?.message?.includes('Could not establish connection.')) {
				// ignore this error, this error is thrown when a popup is not open to receive the message
				// we are ignoring this error because the popup messaging is used to update a popups UI, and if a popup is not open, we don't need to update the UI
				return
			}
			if (error?.message?.includes('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received')) {
				return
			}
		}
		throw error
	}
}

export async function sendPopupMessageToBackgroundPage(message: PopupMessage) {
	await browser.runtime.sendMessage(serialize(PopupMessage, message))
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

type HTMLFile = 'popup' | 'addressBook' | 'changeChain' | 'confirmTransaction' | 'interceptorAccess' | 'personalSign' | 'settingsView'
export function getHtmlFile(file: HTMLFile) {
	const manifest = browser.runtime.getManifest()
	if (manifest.manifest_version === 2) return `/html/${ file }.html`
	return `/html3/${ file }V3.html`
}

export async function setExtensionIcon(details: browser.action._SetIconDetails) {
	try {
		const manifest = browser.runtime.getManifest()
		if (manifest.manifest_version === 2) return browser.browserAction.setIcon(details)
		return browser.action.setIcon(details)
	} catch {
		console.warn('failed to set extension icon')
		console.warn(details)
	}
}

export async function setExtensionBadgeText(details: browser.browserAction._SetBadgeTextDetails) {
	try {
		const manifest = browser.runtime.getManifest()
		if (manifest.manifest_version === 2) return browser.browserAction.setBadgeText(details)
		return browser.action.setBadgeText(details)
	} catch {
		console.warn('failed to set extension badge text')
		console.warn(details)
	}
}

export async function setExtensionBadgeBackgroundColor(details: browser.action._SetBadgeBackgroundColorDetails) {
	try {
		const manifest = browser.runtime.getManifest()
		if (manifest.manifest_version === 2) return browser.browserAction.setBadgeBackgroundColor(details)
		return browser.action.setBadgeBackgroundColor(details)
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
