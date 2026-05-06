import { MessageToPopup, MessageToPopupPayload, PopupMessage, PopupReadyAndListeningPage, Settings, WindowMessage } from '../types/interceptor-messages.js'
import { WebsiteSocket, checkAndThrowRuntimeLastError } from '../utils/requests.js'
import { EthereumQuantity, serialize } from '../types/wire-types.js'
import { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { getAllTabStates, getTabState } from './storageVariables.js'
import { getActiveAddressEntry } from './metadataUtils.js'
import { handleUnexpectedError } from '../utils/errors.js'
import { PopupMessageReplyRequests, PopupRequestsReplies, PopupRequests, RequestAbiAndNameFromBlockExplorer, RequestIdentifyAddress } from '../types/interceptor-reply-messages.js'
import type { PopupReplyOption, PopupRequestsReplyReturn } from '../types/interceptor-reply-messages.js'

function isIgnorableClosedMessageChannelError(error: Error) {
	return error.message?.includes('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received')
		|| error.message?.includes('The message port closed before a response was received')
}

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

export async function sendPopupMessageToOpenWindows(message: MessageToPopupPayload, role: MessageToPopup['role'] = 'all') {
	try {
		await browser.runtime.sendMessage(serialize(MessageToPopup, { role, ...message }))
		checkAndThrowRuntimeLastError()
	} catch (error) {
		if (error instanceof Error) {
			if (error?.message?.includes('Could not establish connection.')) {
				// ignore this error, this error is thrown when a popup is not open to receive the message
				// we are ignoring this error because the popup messaging is used to update a popups UI, and if a popup is not open, we don't need to update the UI
				return
			}
			if (isIgnorableClosedMessageChannelError(error)) return
		}
		await handleUnexpectedError(error)
	}
}

export async function sendPopupMessageToBackgroundPage(message: PopupMessage) {
	try {
		await browser.runtime.sendMessage(serialize(PopupMessage, message))
		checkAndThrowRuntimeLastError()
	} catch (error) {
		if (error instanceof Error) {
			if (isIgnorableClosedMessageChannelError(error)) return
		}
		await handleUnexpectedError(error)
	}
}

export async function sendPopupMessageWithReply(message: { method: 'popup_requestMakeMeRichData' }): Promise<PopupRequestsReplyReturn<{ method: 'popup_requestMakeMeRichData' }> | undefined>
export async function sendPopupMessageWithReply(message: { method: 'popup_requestActiveAddresses' }): Promise<PopupRequestsReplyReturn<{ method: 'popup_requestActiveAddresses' }> | undefined>
export async function sendPopupMessageWithReply(message: { method: 'popup_requestSimulationMode' }): Promise<PopupRequestsReplyReturn<{ method: 'popup_requestSimulationMode' }> | undefined>
export async function sendPopupMessageWithReply(message: { method: 'popup_requestLatestUnexpectedError' }): Promise<PopupRequestsReplyReturn<{ method: 'popup_requestLatestUnexpectedError' }> | undefined>
export async function sendPopupMessageWithReply(message: { method: 'popup_requestInterceptorSimulationInput' }): Promise<PopupRequestsReplyReturn<{ method: 'popup_requestInterceptorSimulationInput' }> | undefined>
export async function sendPopupMessageWithReply(message: { method: 'popup_requestCompleteVisualizedSimulation' }): Promise<PopupRequestsReplyReturn<{ method: 'popup_requestCompleteVisualizedSimulation' }> | undefined>
export async function sendPopupMessageWithReply(message: { method: 'popup_requestSimulationMetadata' }): Promise<PopupRequestsReplyReturn<{ method: 'popup_requestSimulationMetadata' }> | undefined>
export async function sendPopupMessageWithReply(message: RequestAbiAndNameFromBlockExplorer): Promise<PopupRequestsReplyReturn<RequestAbiAndNameFromBlockExplorer> | undefined>
export async function sendPopupMessageWithReply(message: RequestIdentifyAddress): Promise<PopupRequestsReplyReturn<RequestIdentifyAddress> | undefined>
export async function sendPopupMessageWithReply(message: { method: 'popup_isMainPopupWindowOpen' }): Promise<PopupRequestsReplyReturn<{ method: 'popup_isMainPopupWindowOpen' }> | undefined>
export async function sendPopupMessageWithReply(message: { method: 'popup_readyAndListening', data: { page: PopupReadyAndListeningPage } }): Promise<PopupRequestsReplyReturn<{ method: 'popup_readyAndListening', data: { page: PopupReadyAndListeningPage } }> | undefined>
export async function sendPopupMessageWithReply(message: PopupRequests): Promise<PopupReplyOption | undefined> {
	try {
		const rawReply = await browser.runtime.sendMessage(PopupMessageReplyRequests.serialize(message))
		if (rawReply === null) return undefined
		switch (message.method) {
			case 'popup_requestMakeMeRichData': return PopupRequestsReplies.popup_requestMakeMeRichData.parse(rawReply)
			case 'popup_requestActiveAddresses': return PopupRequestsReplies.popup_requestActiveAddresses.parse(rawReply)
			case 'popup_requestSimulationMode': return PopupRequestsReplies.popup_requestSimulationMode.parse(rawReply)
			case 'popup_requestLatestUnexpectedError': return PopupRequestsReplies.popup_requestLatestUnexpectedError.parse(rawReply)
			case 'popup_requestInterceptorSimulationInput': return PopupRequestsReplies.popup_requestInterceptorSimulationInput.parse(rawReply)
			case 'popup_requestCompleteVisualizedSimulation': return PopupRequestsReplies.popup_requestCompleteVisualizedSimulation.parse(rawReply)
			case 'popup_requestSimulationMetadata': return PopupRequestsReplies.popup_requestSimulationMetadata.parse(rawReply)
			case 'popup_requestAbiAndNameFromBlockExplorer': return PopupRequestsReplies.popup_requestAbiAndNameFromBlockExplorer.parse(rawReply)
			case 'popup_requestIdentifyAddress': return PopupRequestsReplies.popup_requestIdentifyAddress.parse(rawReply)
			case 'popup_isMainPopupWindowOpen': return PopupRequestsReplies.popup_isMainPopupWindowOpen.parse(rawReply)
			case 'popup_readyAndListening': return PopupRequestsReplies.popup_readyAndListening.parse(rawReply)
		}
	} catch (error) {
		if (error instanceof Error) {
			if (isIgnorableClosedMessageChannelError(error)) return undefined
			if (error.message?.includes('Could not establish connection.')) return undefined
		}
		await handleUnexpectedError(error)
		return undefined
	}
}

export async function sendPopupReadyAndListening(page: PopupReadyAndListeningPage): Promise<PopupOrTabId | undefined> {
	const reply = await sendPopupMessageWithReply({ method: 'popup_readyAndListening', data: { page } })
	return reply?.data.popupOrTabId
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

type HTMLFile = 'popup' | 'addressBook' | 'changeChain' | 'confirmTransaction' | 'interceptorAccess' | 'personalSign' | 'settingsView' | 'websiteAccess' | 'fetchSimulationStack'
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
	if (port.sender?.tab?.id === undefined) return undefined
	return { tabId: port.sender?.tab?.id, connectionName: EthereumQuantity.parse(port.name) }
}
