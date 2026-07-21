import { Future } from '../../utils/future.js'
import type { WalletWatchAsset } from '../../types/JsonRpc-types.js'
import type { WatchAssetConfirmation } from '../../types/interceptor-messages.js'
import type { PendingWatchAssetRequest } from '../../types/user-interface-types.js'
import type { PopupOrTabId, Website } from '../../types/websiteAccessTypes.js'
import type { InterceptedRequest } from '../../utils/requests.js'
import { doesUniqueRequestIdentifiersMatch } from '../../utils/requests.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import { itentifyAddressViaOnChainInformation } from '../../utils/tokenIdentification.js'
import { updateUserAddressBookEntries } from '../storageVariables.js'
import { getHtmlFile, sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { type PopupOrTab, addWindowTabListeners, closePopupOrTabById, openPopupOrTab, removeWindowTabListeners } from '../../utils/popupOrTab.js'
import type { AddressBookEntries, Erc20TokenEntry } from '../../types/addressBookTypes.js'
import { reportUnexpectedError } from '../../utils/errors.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { sendCallbackToConfirmedSignerOwner } from '../signerStateOwnership.js'
import { getConfirmedSignerStateToken } from '../signerStateOwnership.js'
import { checksummedAddress } from '../../utils/bigint.js'

type WatchAssetAction = WatchAssetConfirmation['data']['action']

let pendingConfirmation: Future<WatchAssetAction> | undefined
let pendingRequest: PendingWatchAssetRequest | undefined
let openedDialog: PopupOrTab | undefined

const invalidWatchAssetRequest = (message: string) => ({
	type: 'result' as const,
	method: 'wallet_watchAsset' as const,
	error: { code: -32602, message },
})

export function validateWatchAssetParameters(params: WalletWatchAsset, currentChainId: bigint) {
	const [{ type, options }] = params.params
	if (type !== 'ERC20') return `Unsupported asset type: ${ type }. The Interceptor currently supports ERC20 assets.`
	if (options.chainId !== undefined) {
		if (!Number.isSafeInteger(options.chainId) || options.chainId < 0) return 'The asset chainId must be a non-negative safe integer.'
		if (BigInt(options.chainId) !== currentChainId) return 'The asset chainId must match the active chain.'
	}
	return undefined
}

export function replaceAddressBookEntryWithVerifiedToken(entries: AddressBookEntries, token: Erc20TokenEntry): AddressBookEntries {
	const sameAddressAndChain = (entry: { address: bigint, chainId?: bigint | 'AllChains' }) => entry.address === token.address && (entry.chainId ?? 1n) === (token.chainId ?? 1n)
	const existingIndex = entries.findIndex(sameAddressAndChain)
	if (existingIndex === -1) return [...entries, token]
	const existing = entries[existingIndex]
	if (existing === undefined) return entries
	const verifiedTokenWithUserConfiguration: Erc20TokenEntry = {
		...token,
		...(existing.logoUri === undefined ? {} : { logoUri: existing.logoUri }),
		...(existing.abi === undefined ? {} : { abi: existing.abi }),
		...(existing.useAsActiveAddress === undefined ? {} : { useAsActiveAddress: existing.useAsActiveAddress }),
		...(existing.askForAddressAccess === undefined ? {} : { askForAddressAccess: existing.askForAddressAccess }),
		...(existing.declarativeNetRequestBlockMode === undefined ? {} : { declarativeNetRequestBlockMode: existing.declarativeNetRequestBlockMode }),
	}
	return entries.flatMap((entry, index) => {
		if (!sameAddressAndChain(entry)) return [entry]
		return index === existingIndex ? [verifiedTokenWithUserConfiguration] : []
	})
}

export async function updateWatchAssetViewWithPendingRequest() {
	if (pendingRequest !== undefined) await sendPopupMessageToOpenWindows({ method: 'popup_WatchAssetRequest', data: pendingRequest })
}

let forwardPendingWatchAsset: (() => boolean) | undefined

export async function resolveWatchAsset(confirmation: WatchAssetConfirmation) {
	if (pendingRequest === undefined || pendingConfirmation === undefined) return
	if (!doesUniqueRequestIdentifiersMatch(confirmation.data.uniqueRequestIdentifier, pendingRequest.request.uniqueRequestIdentifier)) throw new Error('Unique request identifier mismatch in watch asset dialog')
	if (confirmation.data.action === 'forward') {
		if (forwardPendingWatchAsset?.() === true) {
			pendingConfirmation.resolve('forward')
			return
		}
		pendingRequest = { ...pendingRequest, canForward: false }
		await updateWatchAssetViewWithPendingRequest()
		return
	}
	pendingConfirmation.resolve(confirmation.data.action)
}

async function showWatchAssetDialog(
	websiteTabConnections: WebsiteTabConnections,
	request: InterceptedRequest,
	website: Website,
	params: WalletWatchAsset,
	token: Erc20TokenEntry,
) {
	if (pendingConfirmation !== undefined || openedDialog !== undefined) return
	pendingConfirmation = new Future<WatchAssetAction>()
	const closedWhileOpening = new Set<string>()
	const popupOrTabKey = (popupOrTab: PopupOrTabId) => `${ popupOrTab.type }-${ popupOrTab.id }`
	const reject = () => pendingConfirmation?.resolve('reject')
	const onCloseWindow = (id: number) => {
		const closed = { type: 'popup' as const, id }
		if (openedDialog === undefined) closedWhileOpening.add(popupOrTabKey(closed))
		else if (openedDialog.type === closed.type && openedDialog.id === id) reject()
	}
	const onCloseTab = (id: number) => {
		const closed = { type: 'tab' as const, id }
		if (openedDialog === undefined) closedWhileOpening.add(popupOrTabKey(closed))
		else if (openedDialog.type === closed.type && openedDialog.id === id) reject()
	}
	addWindowTabListeners(onCloseWindow, onCloseTab)

	try {
		openedDialog = await openPopupOrTab({ url: getHtmlFile('watchAsset'), type: 'popup', height: 720, width: 600 })
		if (openedDialog === undefined || closedWhileOpening.has(popupOrTabKey(openedDialog))) return
		const signerParameters = {
			...params.params[0],
			options: { ...params.params[0].options, address: checksummedAddress(params.params[0].options.address) },
		}
		forwardPendingWatchAsset = () => sendCallbackToConfirmedSignerOwner(
			websiteTabConnections,
			request.uniqueRequestIdentifier.requestSocket.tabId,
			{ method: 'request_signer_to_wallet_watchAsset', result: signerParameters },
		) !== false
		pendingRequest = {
			website,
			popupOrTabId: openedDialog,
			request,
			token,
			canForward: getConfirmedSignerStateToken(websiteTabConnections, request.uniqueRequestIdentifier.requestSocket.tabId) !== undefined,
		}
		await updateWatchAssetViewWithPendingRequest()
		const action = await pendingConfirmation
		if (action === 'add') {
			await updateUserAddressBookEntries((entries) => replaceAddressBookEntryWithVerifiedToken(entries, token))
			await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		}
	} finally {
		removeWindowTabListeners(onCloseWindow, onCloseTab)
		pendingConfirmation = undefined
		pendingRequest = undefined
		forwardPendingWatchAsset = undefined
		if (openedDialog !== undefined) await closePopupOrTabById(openedDialog)
		openedDialog = undefined
	}
}

export async function handleWatchAssetRequest(
	ethereumClientService: EthereumClientService,
	websiteTabConnections: WebsiteTabConnections,
	request: InterceptedRequest,
	website: Website,
	params: WalletWatchAsset,
	dependencies: {
		identifyAddress?: typeof itentifyAddressViaOnChainInformation,
		scheduleDialog?: (showDialog: () => void) => void,
	} = {},
) {
	const validationError = validateWatchAssetParameters(params, ethereumClientService.getChainId())
	if (validationError !== undefined) return invalidWatchAssetRequest(validationError)
	const identifyAddress = dependencies.identifyAddress ?? itentifyAddressViaOnChainInformation
	const identified = await identifyAddress(ethereumClientService, undefined, params.params[0].options.address)
	if (identified.type !== 'ERC20') return invalidWatchAssetRequest('The requested address is not an ERC20 token contract on the active chain.')
	const token: Erc20TokenEntry = { ...identified, entrySource: 'User', chainId: ethereumClientService.getChainId() }
	const scheduleDialog = dependencies.scheduleDialog ?? ((showDialog: () => void) => { setTimeout(showDialog, 0) })
	scheduleDialog(() => {
		void showWatchAssetDialog(websiteTabConnections, request, website, params, token).catch(async (error: unknown) => {
			await reportUnexpectedError(error, { code: 'watch_asset_dialog_failed' })
		})
	})
	return { type: 'result' as const, method: params.method, result: true }
}
