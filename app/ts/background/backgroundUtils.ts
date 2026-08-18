import { MessageToPopup, type MessageToPopupPayload, PopupMessage, type PopupReadyAndListeningPage, type Settings, WindowMessage } from '../types/interceptor-messages.js'
import { type WebsiteSocket, checkAndThrowRuntimeLastError } from '../utils/requests.js'
import { EthereumQuantity, serialize } from '../types/wire-types.js'
import type { PopupOrTabId } from '../types/websiteAccessTypes.js'
import { getAllTabStates, getTabState, getUserAddressBookEntries } from './storageVariables.js'
import { getActiveAddressEntryForChain } from './metadataUtils.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { PopupMessageReplyRequests, type PopupRequests, PopupRequestsReplies, type PopupRequestsReplyReturn } from '../types/interceptor-reply-messages.js'
import { isIgnorablePortLifecycleError } from './contentScriptPortLifecycle.js'
import type { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import { getWalletSelectedAccount, resolveActiveAddressForMode } from '../utils/activeAddressSelection.js'

function isIgnorableExtensionMessagingError(error: Error) {
	return isIgnorablePortLifecycleError(error)
		|| error.message?.includes('A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received')
}

type ConfiguredActiveAddressResolution =
	| { readonly useConfiguredAddress: false }
	| { readonly useConfiguredAddress: true, readonly activeAddress: AddressBookEntry | undefined }

async function resolveConfiguredActiveAddress(settings: Settings, signerAccounts: readonly bigint[], walletSelectedAddress: bigint | undefined, addressBookEntries: AddressBookEntries | undefined): Promise<ConfiguredActiveAddressResolution> {
	const configuredAddress = settings.simulationMode ? settings.activeSimulationAddress : settings.activeSigningSafeAddress
	if ((settings.simulationMode && settings.useSignersAddressAsActiveAddress) || configuredAddress === undefined) return { useConfiguredAddress: false }
	if (addressBookEntries === undefined) throw new Error('Address-book entries are required to resolve a configured active address.')
	const resolution = resolveActiveAddressForMode(
		addressBookEntries,
		settings.simulationMode,
		settings.activeSimulationAddress,
		settings.activeSigningSafeAddress,
		settings.activeRpcNetwork.chainId,
		signerAccounts,
		walletSelectedAddress,
	)
	if (resolution.activeAddress === undefined) return { useConfiguredAddress: true, activeAddress: undefined }
	return {
		useConfiguredAddress: true,
		activeAddress: resolution.activeAddressBookEntry ?? await getActiveAddressEntryForChain(resolution.activeAddress, settings.activeRpcNetwork.chainId),
	}
}

async function getConfiguredActiveAddressBookEntries(settings: Settings) {
	const configuredAddress = settings.simulationMode ? settings.activeSimulationAddress : settings.activeSigningSafeAddress
	if ((settings.simulationMode && settings.useSignersAddressAsActiveAddress) || configuredAddress === undefined) return undefined
	return await getUserAddressBookEntries()
}

export async function getActiveAddress(settings: Settings, tabId: number) {
	const tabState = await getTabState(tabId)
	const addressBookEntries = await getConfiguredActiveAddressBookEntries(settings)
	const walletSelectedAccount = getWalletSelectedAccount(tabState)
	const configuredAddress = await resolveConfiguredActiveAddress(settings, tabState.signerAccounts, walletSelectedAccount, addressBookEntries)
	if (configuredAddress.useConfiguredAddress) return configuredAddress.activeAddress
	const signingAddr = settings.simulationMode ? tabState.activeSigningAddress : walletSelectedAccount
	if (signingAddr === undefined) return undefined
	return await getActiveAddressEntryForChain(signingAddr, settings.activeRpcNetwork.chainId)
}

export async function getActiveOrFirstSignerAddress(settings: Settings, tabId: number) {
	const tabState = await getTabState(tabId)
	const addressBookEntries = await getConfiguredActiveAddressBookEntries(settings)
	const walletSelectedAccount = getWalletSelectedAccount(tabState)
	const configuredAddress = await resolveConfiguredActiveAddress(settings, tabState.signerAccounts, walletSelectedAccount, addressBookEntries)
	if (configuredAddress.useConfiguredAddress) return configuredAddress.activeAddress
	const address = walletSelectedAccount
	if (address === undefined) return undefined
	return await getActiveAddressEntryForChain(address, settings.activeRpcNetwork.chainId)
}

export async function getActiveAddressesForAllTabs(settings: Settings) {
	const tabStates = await getAllTabStates()
	const addressBookEntries = await getConfiguredActiveAddressBookEntries(settings)
	if (settings.simulationMode) {
		const configuredAddress = await resolveConfiguredActiveAddress(settings, [], undefined, addressBookEntries)
		if (configuredAddress.useConfiguredAddress) return tabStates.map((state) => ({ tabId: state.tabId, activeAddress: configuredAddress.activeAddress }))
	}
	return Promise.all(tabStates.map(async (state) => {
		const walletSelectedAccount = getWalletSelectedAccount(state)
		const configuredAddress = await resolveConfiguredActiveAddress(settings, state.signerAccounts, walletSelectedAccount, addressBookEntries)
		if (configuredAddress.useConfiguredAddress) return { tabId: state.tabId, activeAddress: configuredAddress.activeAddress }
		const signingAddr = settings.simulationMode ? state.activeSigningAddress : walletSelectedAccount
		return { tabId: state.tabId, activeAddress: signingAddr === undefined ? undefined : await getActiveAddressEntryForChain(signingAddr, settings.activeRpcNetwork.chainId) }
	}))
}

export async function sendPopupMessageToOpenWindowsWithoutUnexpectedErrorReport(message: MessageToPopupPayload, role: MessageToPopup['role'] = 'all') {
	try {
		await browser.runtime.sendMessage(serialize(MessageToPopup, { role, ...message }))
		checkAndThrowRuntimeLastError()
	} catch (error) {
		if (error instanceof Error) {
			if (error?.message?.includes('Could not establish connection.')) {
				// ignore this error, this error is thrown when a popup is not open to receive the message we are ignoring this error because the popup messaging is used to update a popups UI, and if a popup is not open, we don't need to update the UI
				return
			}
			if (isIgnorableExtensionMessagingError(error)) return
		}
		throw error
	}
}

export async function sendPopupMessageToOpenWindows(message: MessageToPopupPayload, role: MessageToPopup['role'] = 'all') {
	try {
		await sendPopupMessageToOpenWindowsWithoutUnexpectedErrorReport(message, role)
	} catch (error) {
		await reportUnexpectedError(error)
	}
}

export async function sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport(message: PopupMessage) {
	await browser.runtime.sendMessage(serialize(PopupMessage, message))
	checkAndThrowRuntimeLastError()
}

export async function sendPopupMessageToBackgroundPage(message: PopupMessage) {
	try {
		await sendPopupMessageToBackgroundPageWithoutUnexpectedErrorReport(message)
	} catch (error) {
		if (error instanceof Error) {
			if (isIgnorableExtensionMessagingError(error)) return
		}
		await reportUnexpectedError(error)
	}
}

function parsePopupReply<Request extends PopupRequests>(message: Request, reply: unknown): PopupRequestsReplyReturn<Request> {
	const replyParser = PopupRequestsReplies[message.method]
	if (replyParser === undefined) return undefined as PopupRequestsReplyReturn<Request>
	return replyParser.parse(reply) as PopupRequestsReplyReturn<Request>
}

export async function sendPopupMessageWithReply<Request extends PopupRequests>(message: Request): Promise<PopupRequestsReplyReturn<Request> | undefined> {
	try {
		const response = await browser.runtime.sendMessage(PopupMessageReplyRequests.serialize(message))
		if (response === null || response === undefined) return undefined
		if (typeof response === 'object' && response !== null && 'error' in response) {
			const responseError = response.error
			if (typeof responseError === 'object' && responseError !== null && 'message' in responseError && typeof responseError.message === 'string') {
				throw new Error(responseError.message)
			}
		}
		return parsePopupReply(message, response)
	} catch (error) {
		if (error instanceof Error) {
			if (isIgnorableExtensionMessagingError(error)) return undefined
			if (error.message?.includes('Could not establish connection.')) return undefined
		}
		await reportUnexpectedError(error)
		return undefined
	}
}

type PopupRequestByMethod<Method extends PopupRequests['method']> = Extract<PopupRequests, { method: Method }>

export async function requestPopupMakeMeRichData() {
	const reply = await sendPopupMessageWithReply({ method: 'popup_requestMakeMeRichData' })
	return reply?.method === 'popup_requestMakeMeRichData' ? reply : undefined
}

export async function requestPopupActiveAddresses() {
	const reply = await sendPopupMessageWithReply({ method: 'popup_requestActiveAddresses' })
	return reply?.method === 'popup_requestActiveAddresses' ? reply : undefined
}

export async function requestPopupSimulationMode() {
	const reply = await sendPopupMessageWithReply({ method: 'popup_requestSimulationMode' })
	return reply?.method === 'popup_requestSimulationMode' ? reply : undefined
}

export async function requestPopupLatestUnexpectedError() {
	const reply = await sendPopupMessageWithReply({ method: 'popup_requestLatestUnexpectedError' })
	return reply?.method === 'popup_requestLatestUnexpectedError' ? reply : undefined
}

export async function requestPopupInterceptorSimulationInput() {
	const reply = await sendPopupMessageWithReply({ method: 'popup_requestInterceptorSimulationInput' })
	return reply?.method === 'popup_requestInterceptorSimulationInput' ? reply : undefined
}

export async function requestPopupCompleteVisualizedSimulation() {
	const reply = await sendPopupMessageWithReply({ method: 'popup_requestCompleteVisualizedSimulation' })
	return reply?.method === 'popup_requestCompleteVisualizedSimulation' ? reply : undefined
}

export async function requestPopupSimulationMetadata() {
	const reply = await sendPopupMessageWithReply({ method: 'popup_requestSimulationMetadata' })
	return reply?.method === 'popup_requestSimulationMetadata' ? reply : undefined
}

export function getMissingPopupReplyErrorMessage(actionDescription: string) {
	return `${ actionDescription } failed because the background page did not return a reply.`
}

export async function requestPopupAbiAndNameFromBlockExplorer(data: PopupRequestByMethod<'popup_requestAbiAndNameFromBlockExplorer'>['data']) {
	const reply = await sendPopupMessageWithReply({ method: 'popup_requestAbiAndNameFromBlockExplorer', data })
	return reply?.method === 'popup_requestAbiAndNameFromBlockExplorer' ? reply : undefined
}

export async function requestPopupIdentifyAddress(data: PopupRequestByMethod<'popup_requestIdentifyAddress'>['data']) {
	const reply = await sendPopupMessageWithReply({ method: 'popup_requestIdentifyAddress', data })
	return reply?.method === 'popup_requestIdentifyAddress' ? reply : undefined
}

export async function requestPopupSafeContractState(data: PopupRequestByMethod<'popup_requestSafeContractState'>['data']) {
	const reply = await sendPopupMessageWithReply({ method: 'popup_requestSafeContractState', data })
	return reply?.method === 'popup_requestSafeContractState' ? reply : undefined
}

export async function requestPopupSimulateGovernanceContractExecution(data: PopupRequestByMethod<'popup_simulateGovernanceContractExecution'>['data']) {
	const reply = await sendPopupMessageWithReply({ method: 'popup_simulateGovernanceContractExecution', data })
	return reply?.method === 'popup_simulateExecutionReply' ? reply : undefined
}

export async function requestPopupSimulateGnosisSafeTransaction(data: PopupRequestByMethod<'popup_simulateGnosisSafeTransaction'>['data']) {
	const reply = await sendPopupMessageWithReply({ method: 'popup_simulateGnosisSafeTransaction', data })
	return reply?.method === 'popup_simulateExecutionReply' ? reply : undefined
}

export async function requestIsMainPopupWindowOpen() {
	const reply = await sendPopupMessageWithReply({ method: 'popup_isMainPopupWindowOpen' })
	return reply?.method === 'popup_isMainPopupWindowOpen' ? reply : undefined
}

export async function requestIsSimulationDataConsumerOpen() {
	const reply = await sendPopupMessageWithReply({ method: 'popup_isSimulationVisualizerOpen' })
	return reply?.method === 'popup_isSimulationVisualizerOpen' ? reply : undefined
}

export async function sendPopupReadyAndListening(page: PopupReadyAndListeningPage): Promise<PopupOrTabId | undefined> {
	const reply = await sendPopupMessageWithReply({ method: 'popup_readyAndListening', data: { page } })
	return reply?.method === 'popup_readyAndListening' ? reply.data.popupOrTabId : undefined
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

type HTMLFile = 'popup' | 'addressBook' | 'changeChain' | 'watchAsset' | 'confirmTransaction' | 'interceptorAccess' | 'settingsView' | 'websiteAccess' | 'fetchSimulationStack' | 'simulationStack'
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
