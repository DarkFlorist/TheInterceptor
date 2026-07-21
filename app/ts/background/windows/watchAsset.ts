import type { WalletWatchAsset } from '../../types/JsonRpc-types.js'
import type { WatchAssetConfirmation } from '../../types/interceptor-messages.js'
import type { PendingWatchAssetRequest, StoredWatchAssetRequest, WebsiteTabConnections } from '../../types/user-interface-types.js'
import type { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import type { InterceptedRequest, UniqueRequestIdentifier } from '../../utils/requests.js'
import { doesUniqueRequestIdentifiersMatch } from '../../utils/requests.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { itentifyAddressViaOnChainInformation } from '../../utils/tokenIdentification.js'
import { getPendingWatchAssetRequests, getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst, updatePendingWatchAssetRequests, updateUserAddressBookEntries } from '../storageVariables.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { addWindowTabListeners, closePopupOrTabById, getPopupOrTabById, openPopupOrTab } from '../../utils/popupOrTab.js'
import type { AddressBookEntries, Erc20TokenEntry } from '../../types/addressBookTypes.js'
import { reportUnexpectedError } from '../../utils/errors.js'
import { getConfirmedSignerStateToken, isSignerStateTokenCurrent, sendCallbackToExpectedConfirmedSignerOwner } from '../signerStateOwnership.js'
import { checksummedAddress } from '../../utils/bigint.js'
import { Semaphore } from '../../utils/semaphore.js'
import { isSignerMissing } from '../../utils/signerMetadata.js'
import { imageToUri, type ImageToUriResult } from '../../utils/imageToUri.js'

const invalidWatchAssetRequest = (message: string) => ({
	type: 'result' as const,
	method: 'wallet_watchAsset' as const,
	error: { code: -32602, message },
})

export const MAX_PENDING_WATCH_ASSET_REQUESTS = 20
export const MAX_PENDING_WATCH_ASSET_REQUESTS_PER_ORIGIN = 3
export const MAX_WATCH_ASSET_IMAGE_SIZE_BYTES = 262_144

function watchAssetQueueIdentity(request: StoredWatchAssetRequest) {
	return `${ request.website.websiteOrigin }|${ request.token.chainId ?? 1n }|${ request.requestedAsset.type }|${ request.requestedAsset.options.address }`
}

export function enqueueStoredWatchAssetRequest(requests: readonly StoredWatchAssetRequest[], request: StoredWatchAssetRequest) {
	if (requests.some((pending) => watchAssetQueueIdentity(pending) === watchAssetQueueIdentity(request))) return requests
	if (requests.length >= MAX_PENDING_WATCH_ASSET_REQUESTS) return requests
	const pendingFromOrigin = requests.filter((pending) => pending.website.websiteOrigin === request.website.websiteOrigin).length
	if (pendingFromOrigin >= MAX_PENDING_WATCH_ASSET_REQUESTS_PER_ORIGIN) return requests
	return [...requests, request]
}

function requestsMatch(request: StoredWatchAssetRequest, identifier: UniqueRequestIdentifier) {
	return doesUniqueRequestIdentifiersMatch(request.request.uniqueRequestIdentifier, identifier)
}

export function validateWatchAssetParameters(params: WalletWatchAsset, currentChainId: bigint) {
	const [{ type, options }] = params.params
	if (type !== 'ERC20') return `Unsupported asset type: ${ type }. The Interceptor currently supports ERC20 assets.`
	if (options.chainId !== undefined) {
		if (!Number.isSafeInteger(options.chainId) || options.chainId < 0) return 'The asset chainId must be a non-negative safe integer.'
		if (BigInt(options.chainId) !== currentChainId) return 'The asset chainId must match the active chain.'
	}
	if (options.decimals !== undefined && (!Number.isSafeInteger(options.decimals) || options.decimals < 0 || options.decimals > 255)) return 'The asset decimals must be an integer from 0 to 255.'
	return undefined
}

export function replaceAddressBookEntryWithToken(entries: AddressBookEntries, token: Erc20TokenEntry): AddressBookEntries {
	const sameAddressAndChain = (entry: { address: bigint, chainId?: bigint | 'AllChains' }) => entry.address === token.address && (entry.chainId ?? 1n) === (token.chainId ?? 1n)
	const existingIndex = entries.findIndex(sameAddressAndChain)
	if (existingIndex === -1) return [...entries, token]
	const existing = entries[existingIndex]
	if (existing === undefined) return entries
	const tokenWithUserConfiguration: Erc20TokenEntry = {
		...token,
		...(token.logoUri !== undefined || existing.logoUri === undefined ? {} : { logoUri: existing.logoUri }),
		...(existing.abi === undefined ? {} : { abi: existing.abi }),
		...(existing.useAsActiveAddress === undefined ? {} : { useAsActiveAddress: existing.useAsActiveAddress }),
		...(existing.askForAddressAccess === undefined ? {} : { askForAddressAccess: existing.askForAddressAccess }),
		...(existing.declarativeNetRequestBlockMode === undefined ? {} : { declarativeNetRequestBlockMode: existing.declarativeNetRequestBlockMode }),
	}
	return entries.flatMap((entry, index) => {
		if (!sameAddressAndChain(entry)) return [entry]
		return index === existingIndex ? [tokenWithUserConfiguration] : []
	})
}

function toPendingRequest(request: StoredWatchAssetRequest): PendingWatchAssetRequest | undefined {
	if (request.popupOrTabId === undefined) return undefined
	return { ...request, popupOrTabId: request.popupOrTabId }
}

async function getForwardSignerTarget(websiteTabConnections: WebsiteTabConnections, request: StoredWatchAssetRequest) {
	const tabId = request.request.uniqueRequestIdentifier.requestSocket.tabId
	const signerStateToken = getConfirmedSignerStateToken(websiteTabConnections, tabId)
	if (signerStateToken === undefined) return undefined
	const signerName = (await getTabState(tabId)).signerName
	if (!isSignerStateTokenCurrent(websiteTabConnections, signerStateToken) || isSignerMissing(signerName)) return undefined
	return {
		signerName,
		connectionName: signerStateToken.socket.connectionName,
		ownerGeneration: signerStateToken.ownerGeneration,
		signerProviderGeneration: signerStateToken.signerProviderGeneration,
	}
}

function doForwardSignerTargetsMatch(first: StoredWatchAssetRequest['forwardToSigner'], second: StoredWatchAssetRequest['forwardToSigner']) {
	if (first === undefined || second === undefined) return first === second
	return first.signerName === second.signerName
		&& first.connectionName === second.connectionName
		&& first.ownerGeneration === second.ownerGeneration
		&& first.signerProviderGeneration === second.signerProviderGeneration
}

async function publishWatchAssetRequest(request: StoredWatchAssetRequest) {
	const pending = toPendingRequest(request)
	if (pending !== undefined) await sendPopupMessageToOpenWindows({ method: 'popup_WatchAssetRequest', data: pending })
}

export async function updateWatchAssetViewWithPendingRequest(websiteTabConnections?: WebsiteTabConnections) {
	const [first] = await getPendingWatchAssetRequests()
	if (first === undefined || first.popupOrTabId === undefined) return undefined
	const forwardToSigner = websiteTabConnections === undefined ? undefined : await getForwardSignerTarget(websiteTabConnections, first)
	const request = doForwardSignerTargetsMatch(forwardToSigner, first.forwardToSigner)
		? first
		: (await updatePendingWatchAssetRequests((requests) => requests.map((stored) => requestsMatch(stored, first.request.uniqueRequestIdentifier) ? { ...stored, forwardToSigner } : stored)))[0]
	if (request === undefined) return undefined
	await publishWatchAssetRequest(request)
	return toPendingRequest(request)
}

type QueueProcessingDependencies = {
	getRequests: typeof getPendingWatchAssetRequests
	updateRequests: typeof updatePendingWatchAssetRequests
	openDialog: () => Promise<PopupOrTabId | undefined>
	dialogExists: (popupOrTabId: PopupOrTabId) => Promise<boolean>
	closeDialog: typeof closePopupOrTabById
	publish: typeof publishWatchAssetRequest
}

const defaultQueueProcessingDependencies: QueueProcessingDependencies = {
	getRequests: getPendingWatchAssetRequests,
	updateRequests: updatePendingWatchAssetRequests,
	openDialog: async () => {
		const opened = await openPopupOrTab({ url: getHtmlFile('watchAsset'), type: 'popup', height: 720, width: 600 })
		return opened === undefined ? undefined : { type: opened.type, id: opened.id }
	},
	dialogExists: async (popupOrTabId) => await getPopupOrTabById(popupOrTabId) !== undefined,
	closeDialog: closePopupOrTabById,
	publish: publishWatchAssetRequest,
}

const queueProcessingSemaphore = new Semaphore(1)
export async function processWatchAssetQueue(websiteTabConnections: WebsiteTabConnections | undefined, dependencies: QueueProcessingDependencies = defaultQueueProcessingDependencies) {
	await queueProcessingSemaphore.execute(async () => {
		while (true) {
			const [first] = await dependencies.getRequests()
			if (first === undefined) return
			if (first.popupOrTabId !== undefined) {
				if (await dependencies.dialogExists(first.popupOrTabId)) {
					const [current] = await dependencies.getRequests()
					if (current === undefined || !requestsMatch(current, first.request.uniqueRequestIdentifier)) continue
					const forwardToSigner = websiteTabConnections === undefined ? undefined : await getForwardSignerTarget(websiteTabConnections, current)
					const active = doForwardSignerTargetsMatch(forwardToSigner, current.forwardToSigner)
						? current
						: (await dependencies.updateRequests((requests) => requests.map((stored) => requestsMatch(stored, current.request.uniqueRequestIdentifier) ? { ...stored, forwardToSigner } : stored)))[0]
					if (active !== undefined) await dependencies.publish(active)
					return
				}
				await dependencies.updateRequests((requests) => requests.filter((stored) => !requestsMatch(stored, first.request.uniqueRequestIdentifier)))
				continue
			}
			const popupOrTabId = await dependencies.openDialog()
			if (popupOrTabId === undefined) {
				return
			}
			const forwardToSigner = websiteTabConnections === undefined ? undefined : await getForwardSignerTarget(websiteTabConnections, first)
			const [active] = await dependencies.updateRequests((requests) => requests.map((stored) => requestsMatch(stored, first.request.uniqueRequestIdentifier) ? { ...stored, popupOrTabId, forwardToSigner } : stored))
			if (active === undefined || !requestsMatch(active, first.request.uniqueRequestIdentifier)) {
				await dependencies.closeDialog(popupOrTabId)
				continue
			}
			await dependencies.publish(active)
			return
		}
	})
}

type ResolutionDependencies = {
	getRequests: typeof getPendingWatchAssetRequests
	updateRequests: typeof updatePendingWatchAssetRequests
	updateAddressBook: typeof updateUserAddressBookEntries
	publishAddressBookChanged: () => Promise<void>
	publish: typeof publishWatchAssetRequest
	closeDialog: typeof closePopupOrTabById
	processQueue: (websiteTabConnections: WebsiteTabConnections) => Promise<void>
	sendToSigner: (request: StoredWatchAssetRequest) => boolean
	downloadImage: (url: string) => Promise<ImageToUriResult>
}

function defaultResolutionDependencies(websiteTabConnections: WebsiteTabConnections): ResolutionDependencies {
	return {
		getRequests: getPendingWatchAssetRequests,
		updateRequests: updatePendingWatchAssetRequests,
		updateAddressBook: updateUserAddressBookEntries,
		publishAddressBookChanged: async () => await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' }),
		publish: publishWatchAssetRequest,
		closeDialog: closePopupOrTabById,
		processQueue: async (connections) => await processWatchAssetQueue(connections),
		sendToSigner: (request) => request.forwardToSigner !== undefined && sendCallbackToExpectedConfirmedSignerOwner(
			websiteTabConnections,
			{
				tabId: request.request.uniqueRequestIdentifier.requestSocket.tabId,
				connectionName: request.forwardToSigner.connectionName,
				ownerGeneration: request.forwardToSigner.ownerGeneration,
				signerProviderGeneration: request.forwardToSigner.signerProviderGeneration,
			},
			{
				method: 'request_signer_to_wallet_watchAsset',
				result: {
					...request.requestedAsset,
					options: { ...request.requestedAsset.options, address: checksummedAddress(request.requestedAsset.options.address) },
				},
			},
		) !== false,
		downloadImage: async (url) => await imageToUri(url, MAX_WATCH_ASSET_IMAGE_SIZE_BYTES),
	}
}

function removeTokenLogo(token: Erc20TokenEntry): Erc20TokenEntry {
	const { logoUri: _logoUri, ...tokenWithoutLogo } = token
	return tokenWithoutLogo
}

let resolutionInProgress = false
export async function resolveWatchAsset(websiteTabConnections: WebsiteTabConnections, confirmation: WatchAssetConfirmation, dependencies = defaultResolutionDependencies(websiteTabConnections)) {
	if (resolutionInProgress) return
	resolutionInProgress = true
	try {
		const requests = await dependencies.getRequests()
		const request = requests.find((stored) => requestsMatch(stored, confirmation.data.uniqueRequestIdentifier))
		if (request === undefined || request.popupOrTabId === undefined) return
		if (confirmation.data.action === 'downloadImage' || confirmation.data.action === 'removeImage') {
			const imageUrl = request.requestedAsset.options.image
			const imageResult = confirmation.data.action === 'downloadImage' && imageUrl !== undefined
				? await dependencies.downloadImage(imageUrl)
				: undefined
			const updated = await dependencies.updateRequests((storedRequests) => storedRequests.map((stored) => {
				if (!requestsMatch(stored, confirmation.data.uniqueRequestIdentifier)) return stored
				if (confirmation.data.action === 'removeImage') return { ...stored, selectedImageUri: undefined, imageDownloadError: undefined }
				if (imageUrl === undefined) return { ...stored, imageDownloadError: 'The website did not provide an image URL.' }
				if (imageResult?.data === undefined) return { ...stored, imageDownloadError: imageResult?.failureReason ?? 'The image could not be downloaded.' }
				return { ...stored, selectedImageUri: imageResult.data, imageDownloadError: undefined }
			}))
			const stillPending = updated.find((stored) => requestsMatch(stored, confirmation.data.uniqueRequestIdentifier))
			if (stillPending !== undefined) await dependencies.publish(stillPending)
			return
		}
		if (confirmation.data.action === 'forward' && dependencies.sendToSigner(request) === false) {
			const updated = await dependencies.updateRequests((storedRequests) => storedRequests.map((stored) => requestsMatch(stored, confirmation.data.uniqueRequestIdentifier) ? { ...stored, forwardToSigner: undefined } : stored))
			const stillPending = updated.find((stored) => requestsMatch(stored, confirmation.data.uniqueRequestIdentifier))
			if (stillPending !== undefined) await dependencies.publish(stillPending)
			return
		}
		if (confirmation.data.action === 'add') {
			const token = request.selectedImageUri === undefined ? removeTokenLogo(request.token) : { ...request.token, logoUri: request.selectedImageUri }
			await dependencies.updateAddressBook((entries) => replaceAddressBookEntryWithToken(entries, token))
			await dependencies.publishAddressBookChanged()
		}
		await dependencies.updateRequests((storedRequests) => storedRequests.filter((stored) => !requestsMatch(stored, confirmation.data.uniqueRequestIdentifier)))
		await dependencies.closeDialog(request.popupOrTabId)
		await dependencies.processQueue(websiteTabConnections)
	} finally {
		resolutionInProgress = false
	}
}

async function dismissWatchAssetDialog(popupOrTabId: PopupOrTabId) {
	let removed = false
	await updatePendingWatchAssetRequests((requests) => requests.filter((request) => {
		const matches = request.popupOrTabId?.type === popupOrTabId.type && request.popupOrTabId.id === popupOrTabId.id
		if (matches) removed = true
		return !matches
	}))
	if (removed) await processWatchAssetQueue(undefined)
}

let windowListenersInitialized = false
export function initializeWatchAssetWindowListeners() {
	if (windowListenersInitialized) return true
	if (browser.windows.onRemoved === undefined || browser.tabs.onRemoved === undefined) return false
	windowListenersInitialized = true
	const dismiss = (popupOrTabId: PopupOrTabId) => {
		void dismissWatchAssetDialog(popupOrTabId).catch(async (error: unknown) => {
			await reportUnexpectedError(error, { code: 'watch_asset_dialog_close_failed' })
		})
	}
	addWindowTabListeners((id) => dismiss({ type: 'popup', id }), (id) => dismiss({ type: 'tab', id }))
	return true
}

export async function handleWatchAssetRequest(
	ethereumClientService: EthereumClientService,
	websiteTabConnections: WebsiteTabConnections,
	request: InterceptedRequest,
	website: Website,
	params: WalletWatchAsset,
	dependencies: {
		identifyAddress?: typeof itentifyAddressViaOnChainInformation,
		getAddressBookEntries?: () => Promise<AddressBookEntries>,
		updateAddressBook?: typeof updateUserAddressBookEntries,
		publishAddressBookChanged?: () => Promise<void>,
		scheduleDialog?: (showDialog: () => void) => void,
		enqueueRequest?: (request: StoredWatchAssetRequest) => Promise<void>,
		processQueue?: (websiteTabConnections: WebsiteTabConnections) => Promise<void>,
	} = {},
) {
	const validationError = validateWatchAssetParameters(params, ethereumClientService.getChainId())
	if (validationError !== undefined) return invalidWatchAssetRequest(validationError)
	const requestedAsset = params.params[0]
	const chainId = ethereumClientService.getChainId()
	const getAddressBookEntries = dependencies.getAddressBookEntries ?? (async () => await getUserAddressBookEntriesForChainIdMorePreciseFirst(ethereumClientService.getChainId()))
	const existingEntry = (await getAddressBookEntries()).find((entry) => entry.address === requestedAsset.options.address)
	let currentToken: Erc20TokenEntry
	if (existingEntry?.type === 'ERC20') {
		currentToken = existingEntry
	} else {
		const identifyAddress = dependencies.identifyAddress ?? itentifyAddressViaOnChainInformation
		const identified = await identifyAddress(ethereumClientService, undefined, requestedAsset.options.address)
		if (identified.type !== 'ERC20') return invalidWatchAssetRequest('The requested address is not an ERC20 token contract on the active chain.')
		const identifiedToken: Erc20TokenEntry = { ...identified, entrySource: 'OnChain', chainId }
		currentToken = identifiedToken
		const updateAddressBook = dependencies.updateAddressBook ?? updateUserAddressBookEntries
		await updateAddressBook((entries) => {
			const updatedEntries = replaceAddressBookEntryWithToken(entries, identifiedToken)
			currentToken = updatedEntries.find((entry): entry is Erc20TokenEntry => entry.type === 'ERC20' && entry.address === identifiedToken.address && (entry.chainId ?? 1n) === chainId) ?? identifiedToken
			return updatedEntries
		})
		const publishAddressBookChanged = dependencies.publishAddressBookChanged ?? (async () => await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' }))
		await publishAddressBookChanged()
	}
	const token: Erc20TokenEntry = {
		...currentToken,
		entrySource: 'User',
		chainId,
		symbol: requestedAsset.options.symbol ?? currentToken.symbol,
		decimals: requestedAsset.options.decimals === undefined ? currentToken.decimals : BigInt(requestedAsset.options.decimals),
	}
	const requestBeforeSignerCheck: StoredWatchAssetRequest = {
		website,
		popupOrTabId: undefined,
		request,
		requestedAsset,
		currentToken,
		token,
		selectedImageUri: undefined,
		imageDownloadError: undefined,
		forwardToSigner: undefined,
	}
	const storedRequest = { ...requestBeforeSignerCheck, forwardToSigner: await getForwardSignerTarget(websiteTabConnections, requestBeforeSignerCheck) }
	const enqueueRequest = dependencies.enqueueRequest ?? (async (pending) => { await updatePendingWatchAssetRequests((requests) => enqueueStoredWatchAssetRequest(requests, pending)) })
	await enqueueRequest(storedRequest)
	const processQueue = dependencies.processQueue ?? (async (connections) => await processWatchAssetQueue(connections))
	const scheduleDialog = dependencies.scheduleDialog ?? ((showDialog: () => void) => { setTimeout(showDialog, 0) })
	scheduleDialog(() => {
		void processQueue(websiteTabConnections).catch(async (error: unknown) => {
			await reportUnexpectedError(error, { code: 'watch_asset_dialog_failed' })
		})
	})
	// EIP-747 requires valid requests to return true before prompting. This acknowledges recognition, not user consent or address-book insertion.
	return { type: 'result' as const, method: params.method, result: true }
}
