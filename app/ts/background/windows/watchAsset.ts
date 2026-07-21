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
import type { AddressBookEntries, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../../types/addressBookTypes.js'
import { reportUnexpectedError } from '../../utils/errors.js'
import { getConfirmedSignerStateToken, isSignerStateTokenCurrent, sendCallbackToExpectedConfirmedSignerOwner } from '../signerStateOwnership.js'
import { checksummedAddress } from '../../utils/bigint.js'
import { Semaphore } from '../../utils/semaphore.js'
import { isSignerMissing } from '../../utils/signerMetadata.js'
import { imageToUri, type ImageToUriResult } from '../../utils/imageToUri.js'
import { invalidWatchAssetRequest } from '../rpcRequestParsing.js'

export const MAX_PENDING_WATCH_ASSET_REQUESTS = 20
export const MAX_PENDING_WATCH_ASSET_REQUESTS_PER_ORIGIN = 3
export const MAX_WATCH_ASSET_IMAGE_SIZE_BYTES = 262_144

function watchAssetQueueIdentity(request: StoredWatchAssetRequest) {
	const tokenId = request.requestedAsset.type === 'ERC20' ? '' : `|${ BigInt(request.requestedAsset.options.tokenId).toString() }`
	return `${ request.website.websiteOrigin }|${ request.token.chainId ?? 1n }|${ request.requestedAsset.type }|${ request.requestedAsset.options.address }${ tokenId }`
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
	if (options.chainId !== undefined) {
		if (!Number.isSafeInteger(options.chainId) || options.chainId < 0) return 'The asset chainId must be a non-negative safe integer.'
		if (BigInt(options.chainId) !== currentChainId) return 'The asset chainId must match the active chain.'
	}
	if (type === 'ERC20') {
		if (options.symbol !== undefined && (options.symbol.length === 0 || options.symbol.length > 11)) return 'The asset symbol must contain from 1 to 11 characters.'
		if (options.decimals !== undefined && (!Number.isSafeInteger(options.decimals) || options.decimals < 0 || options.decimals > 36)) return 'The asset decimals must be an integer from 0 to 36.'
		if (options.image !== undefined) {
			try {
				const imageUrl = new URL(options.image)
				if (imageUrl.protocol !== 'https:' && imageUrl.protocol !== 'http:') return 'The asset image must be an HTTP or HTTPS URL.'
			} catch {
				return 'The asset image must be a valid URL.'
			}
		}
	} else {
		if (!/^\d+$/.test(options.tokenId)) return 'The asset tokenId must be a non-negative decimal integer string.'
		if (BigInt(options.tokenId) > (1n << 256n) - 1n) return 'The asset tokenId must fit in an unsigned 256-bit integer.'
	}
	return undefined
}

type WatchAssetAddressBookEntry = Erc20TokenEntry | Erc721Entry | Erc1155Entry

export function replaceAddressBookEntryWithAsset(entries: AddressBookEntries, token: WatchAssetAddressBookEntry): AddressBookEntries {
	const sameAddressAndChain = (entry: { address: bigint, chainId?: bigint | 'AllChains' }) => entry.address === token.address && (entry.chainId ?? 1n) === (token.chainId ?? 1n)
	const existingIndex = entries.findIndex(sameAddressAndChain)
	if (existingIndex === -1) return [...entries, token]
	const existing = entries[existingIndex]
	if (existing === undefined) return entries
	const tokenWithUserConfiguration: WatchAssetAddressBookEntry = {
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
				result: { ...request.requestedAsset, options: { ...request.requestedAsset.options, address: checksummedAddress(request.requestedAsset.options.address) } },
			},
		) !== false,
		downloadImage: async (url) => await imageToUri(url, MAX_WATCH_ASSET_IMAGE_SIZE_BYTES),
	}
}

function removeAssetLogo(token: WatchAssetAddressBookEntry): WatchAssetAddressBookEntry {
	const { logoUri: _logoUri, ...tokenWithoutLogo } = token
	return tokenWithoutLogo
}

function isSameAddressBookAsset(first: WatchAssetAddressBookEntry, second: WatchAssetAddressBookEntry) {
	return first.type === second.type && first.address === second.address && (first.chainId ?? 1n) === (second.chainId ?? 1n)
}

function refreshQueuedNftRequests(requests: readonly StoredWatchAssetRequest[], entries: AddressBookEntries) {
	return requests.map((request): StoredWatchAssetRequest => {
		if (request.requestedAsset.type === 'ERC20') return request
		const latest = entries.find((entry): entry is Erc721Entry | Erc1155Entry => (entry.type === 'ERC721' || entry.type === 'ERC1155') && isSameAddressBookAsset(entry, request.token))
		if (latest === undefined || latest.type !== request.requestedAsset.type) return request
		const requestedTokenId = BigInt(request.requestedAsset.options.tokenId)
		return {
			...request,
			currentToken: latest,
			token: {
				...latest,
				entrySource: 'User',
				watchedTokenIds: Array.from(new Set([...(latest.watchedTokenIds ?? []), requestedTokenId])),
			},
		}
	})
}

let resolutionInProgress = false
export async function resolveWatchAsset(websiteTabConnections: WebsiteTabConnections, confirmation: WatchAssetConfirmation, dependencies = defaultResolutionDependencies(websiteTabConnections)) {
	if (resolutionInProgress) return
	resolutionInProgress = true
	try {
		const requests = await dependencies.getRequests()
		const request = requests.find((stored) => requestsMatch(stored, confirmation.data.uniqueRequestIdentifier))
		if (request === undefined || request.popupOrTabId === undefined) return
		if (confirmation.data.action === 'downloadImage') {
			const imageUrl = request.requestedAsset.type === 'ERC20' ? request.requestedAsset.options.image : undefined
			const imageResult = imageUrl === undefined ? undefined : await dependencies.downloadImage(imageUrl)
			const updated = await dependencies.updateRequests((storedRequests) => storedRequests.map((stored) => {
				if (!requestsMatch(stored, confirmation.data.uniqueRequestIdentifier)) return stored
				if (imageUrl === undefined) return { ...stored, imageDownloadError: 'The website did not provide an image URL.' }
				if (imageResult?.data === undefined) return { ...stored, imageDownloadError: 'The proposed image could not be downloaded or decoded.' }
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
			let updatedAddressBook: AddressBookEntries | undefined
			await dependencies.updateAddressBook((entries) => {
				const latest = entries.find((entry): entry is WatchAssetAddressBookEntry => (entry.type === 'ERC20' || entry.type === 'ERC721' || entry.type === 'ERC1155') && isSameAddressBookAsset(entry, request.token))
				const mergedToken = request.token.type === 'ERC20'
					? request.token
					: {
						...request.token,
						watchedTokenIds: Array.from(new Set([...(latest?.type === request.token.type ? latest.watchedTokenIds ?? [] : []), ...(request.token.watchedTokenIds ?? [])])),
					}
				const token = request.selectedImageUri === undefined ? removeAssetLogo(mergedToken) : { ...mergedToken, logoUri: request.selectedImageUri }
				updatedAddressBook = replaceAddressBookEntryWithAsset(entries, token)
				return updatedAddressBook
			})
			if (updatedAddressBook !== undefined) await dependencies.updateRequests((storedRequests) => refreshQueuedNftRequests(storedRequests, updatedAddressBook ?? []))
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
	let currentToken: WatchAssetAddressBookEntry
	if (existingEntry?.type === requestedAsset.type) {
		currentToken = existingEntry
	} else {
		const identifyAddress = dependencies.identifyAddress ?? itentifyAddressViaOnChainInformation
		const identified = await identifyAddress(ethereumClientService, undefined, requestedAsset.options.address)
		if (identified.type !== requestedAsset.type) return invalidWatchAssetRequest(`The requested address is not an ${ requestedAsset.type } token contract on the active chain.`)
		const identifiedToken: WatchAssetAddressBookEntry = { ...identified, entrySource: 'OnChain', chainId }
		currentToken = identifiedToken
		const updateAddressBook = dependencies.updateAddressBook ?? updateUserAddressBookEntries
		await updateAddressBook((entries) => {
			const updatedEntries = replaceAddressBookEntryWithAsset(entries, identifiedToken)
			currentToken = updatedEntries.find((entry): entry is WatchAssetAddressBookEntry => (entry.type === 'ERC20' || entry.type === 'ERC721' || entry.type === 'ERC1155') && entry.type === identifiedToken.type && entry.address === identifiedToken.address && (entry.chainId ?? 1n) === chainId) ?? identifiedToken
			return updatedEntries
		})
		const publishAddressBookChanged = dependencies.publishAddressBookChanged ?? (async () => await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' }))
		await publishAddressBookChanged()
	}
	const token: WatchAssetAddressBookEntry = requestedAsset.type === 'ERC20' && currentToken.type === 'ERC20'
		? {
			...currentToken,
			entrySource: 'User',
			chainId,
			symbol: requestedAsset.options.symbol ?? currentToken.symbol,
			decimals: requestedAsset.options.decimals === undefined ? currentToken.decimals : BigInt(requestedAsset.options.decimals),
		}
		: requestedAsset.type !== 'ERC20' && currentToken.type === requestedAsset.type
			? {
				...currentToken,
				entrySource: 'User',
				chainId,
				watchedTokenIds: Array.from(new Set([...(currentToken.watchedTokenIds ?? []), BigInt(requestedAsset.options.tokenId)])),
			}
			: currentToken
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
