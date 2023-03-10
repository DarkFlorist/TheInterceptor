import { MessageToPopup, PopupMessage, WindowMessage } from '../utils/interceptor-messages.js'
import { WebsiteSocket } from '../utils/user-interface-types.js'
import { EthereumQuantity } from '../utils/wire-types.js'

export function getActiveAddress() {
	if (globalThis.interceptor.settings === undefined) return undefined
	return globalThis.interceptor.settings.simulationMode ? globalThis.interceptor.settings.activeSimulationAddress : globalThis.interceptor.settings.activeSigningAddress
}

export async function sendPopupMessageToOpenWindows(message: MessageToPopup) {
	try {
		await browser.runtime.sendMessage(MessageToPopup.serialize(message))
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
			if (error) return console.error(`Popup message error: ${ error.message }`);
		}
	}
}

export async function sendPopupMessageToBackgroundPage(message: PopupMessage) {
	await browser.runtime.sendMessage(PopupMessage.serialize(message))
}

export const INTERNAL_CHANNEL_NAME = 'internalChannel'

export function sendInternalWindowMessage(message: WindowMessage) {
	new BroadcastChannel(INTERNAL_CHANNEL_NAME).postMessage(WindowMessage.serialize(message))
}

export function createInternalMessageListener(handler: (message: WindowMessage) => void) {
	return (message: MessageEvent) => {
		if (message.origin !== globalThis.location.origin) return
		handler(WindowMessage.parse(message.data))
	}
}

type HTMLFile = 'popup' | 'addressBook' | 'changeChain' | 'confirmTransaction' | 'interceptorAccess' | 'personalSign'
export function getHtmlFile(file: HTMLFile) {
	const manifest = browser.runtime.getManifest()
	if (manifest.manifest_version === 2) {
		return `html/${ file }.html`
	}
	return `html3/${ file }V3.html`
}

export async function setExtensionIcon(details: browser.action._SetIconDetails) {
	const manifest = browser.runtime.getManifest()
	if (manifest.manifest_version === 2) {
		return browser.browserAction.setIcon(details)
	}
	return browser.action.setIcon(details)
}

export async function setExtensionBadgeText(details: browser.browserAction._SetBadgeTextDetails) {
	const manifest = browser.runtime.getManifest()
	if (manifest.manifest_version === 2) {
		return browser.browserAction.setBadgeText(details)
	}
	return browser.action.setBadgeText(details)
}

export async function setExtensionBadgeBackgroundColor(details: browser.action._SetBadgeBackgroundColorDetails) {
	const manifest = browser.runtime.getManifest()
	if (manifest.manifest_version === 2) {
		return browser.browserAction.setBadgeBackgroundColor(details)
	}
	return browser.action.setBadgeBackgroundColor(details)
}

export const websiteSocketToString = (socket: WebsiteSocket) => `${ socket.tabId }-${ EthereumQuantity.serialize(socket.connectionName) }`

export const getSocketFromPort = (port: browser.runtime.Port) => {
	if (port.sender?.tab?.id === undefined) throw new Error('tab id not found in socket')
	return { tabId: port.sender?.tab?.id, connectionName: EthereumQuantity.parse(port.name) }
}
