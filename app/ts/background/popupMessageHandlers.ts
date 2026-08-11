import { refreshConfirmTransactionSimulation } from './confirmTransactionSimulation.js'
import { changeActiveAddressAndChain, changeActiveRpc } from './activeSettings.js'
import { getUpdatedSimulationStackSnapshot, getUpdatedSimulationState } from './simulationUpdating.js'
import { getSettings, setUseTabsInsteadOfPopup, setPage, setUseSignersAddressAsActiveAddress, updateWebsiteAccess, getMakeCurrentAddressRich, setMetamaskCompatibilityMode, getPage, setPreSimulationBlockTimeManipulation, getPreSimulationBlockTimeManipulation, getFixedAddressRichList, getWebsiteAccess, updateMakeCurrentAddressRich, updateFixedMakeMeRichList, rememberSigningAddressPreference } from './settings.js'
import { getPendingTransactionsAndMessages, getTabState, getRpcList, getPrimaryRpcForChain, getRpcConnectionStatus, updateUserAddressBookEntries, getPopupVisualisationState, setIdsOfOpenedTabs, getIdsOfOpenedTabs, updatePendingTransactionOrMessage, addEnsLabelHash, addEnsNodeHash, updateInterceptorTransactionStack, getLatestUnexpectedError, getInterceptorTransactionStack, getChainChangeConfirmationPromise, getFetchSimulationStackRequestPromise, getPendingAccessRequests, updateTransactionState, getUserAddressBookEntries, getUserAddressBookEntriesForChainIdMorePreciseFirst, getSafeTransactionStacks } from './storageVariables.js'
import { parseEvents, parseInputData } from '../simulation/parsing.js'
import { type ChangeActiveAddress, type ModifyMakeMeRich, type ChangePage, type RemoveTransaction, type RequestAccountsFromSigner, type TransactionConfirmation, type InterceptorAccess, type ChangeInterceptorAccess, type ChainChangeConfirmation, type WatchAssetConfirmation, type EnableSimulationMode, type ChangeActiveChain, type AddOrEditAddressBookEntry, type GetAddressBookData, type RemoveAddressBookEntry, type InterceptorAccessRefresh, type InterceptorAccessChangeAddress, type Settings, type ChangeSettings, type UpdateHomePage, type SimulateGovernanceContractExecution, type ChangeAddOrModifyAddressWindowState, type OpenWebPage, type SetEnsNameForHash, UpdateConfirmTransactionDialog, UpdateConfirmTransactionDialogPendingTransactions, type ForceSetGasLimitForTransaction, type ChangePreSimulationBlockTimeManipulation, type SetTransactionOrMessageBlockTimeManipulator, type FetchSimulationStackRequestConfirmation, type ImportSimulationStack, type PopupReadyAndListeningPage } from '../types/interceptor-messages.js'
import { formEthSendTransaction, formSendRawTransaction, resolvePendingTransactionOrMessage, updateConfirmTransactionView, setGasLimitForTransaction, toPopupPendingTransactionOrSignableMessage } from './windows/confirmTransaction.js'
import { askForSignerAccountsFromSignerIfNotAvailable, assertAccessDialogAddressIsAvailable, getAddressMetadataForAccess, refreshSignerAccountsForTab, refreshSignerAccountsFromApprovedWebsitePorts, requestAddressChange, resolveInterceptorAccess, type SignerAccountRefreshOptions } from './windows/interceptorAccess.js'
import { resolveChainChange } from './windows/changeChain.js'
import { updateWebsiteApprovalAccesses } from './accessManagement.js'
import { getActiveOrFirstSignerAddress, getHtmlFile, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getActiveAddressForCurrentSignerState, sendCallbackToAllConfirmedSignerOwners, sendCallbackToConfirmedSignerOwner } from './signerStateOwnership.js'
import { findEntryWithSymbolOrName, getMetadataForAddressBookData } from './metadataSearch.js'
import { getActiveAddressEntry, getActiveAddresses, identifyAddress } from './metadataUtils.js'
import type { TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { CompleteVisualizedSimulation, InterceptorSimulationExport, type InterceptorStackOperation, InterceptorTransactionStack, type ModifyAddressWindowState } from '../types/visualizer-types.js'
import { isJSON } from '../utils/json.js'
import { doAddressBookChainIdsMatch, getSafeSigningEntry, type AddressBookEntry, type IncompleteAddressBookEntry, type SafeEntry } from '../types/addressBookTypes.js'
import { EthereumAddress, serialize } from '../types/wire-types.js'
import { fetchAbiFromBlockExplorer, isValidAbi } from '../simulation/services/EtherScanAbiFetcher.js'
import { checksummedAddress, generate256BitRandomBigInt, stringToAddress } from '../utils/bigint.js'
import { isAddress } from '../utils/ethereumPrimitives.js'
import { getIssueWithAddressString } from '../utils/addressValidation.js'
import type { Website } from '../types/websiteAccessTypes.js'
import { makeSureInterceptorIsNotSleeping } from './sleeping.js'
import type { PublishRpcConnectionStatus } from './rpcSlowRequestTracking.js'
import { craftPersonalSignPopupMessage } from './windows/personalSign.js'
import { checkAndThrowRuntimeLastError, doesUniqueRequestIdentifiersMatch, silenceChromeUnCaughtPromise, updateTabIfExists, updateWindowIfExists } from '../utils/requests.js'
import { assertNever, modifyObject } from '../utils/typescript.js'
import type { VisualizedPersonalSignRequestSafeTx } from '../types/personal-message-definitions.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { getCurrentSimulationInput, getMetadataForSimulation, simulateGnosisSafeMetaTransaction, simulateGovernanceContractExecution, updateSimulationMetadata, visualizeSimulatorState } from './simulationUpdating.js'
import { getErrorMessage, reportUnexpectedError, isExpectedHandledError, isExpectedInfrastructureError } from '../utils/errors.js'
import type { ImportSimulationStackReply, RequestAbiAndNameFromBlockExplorer, RequestIdentifyAddress, SetSafeSimulationSigner, UnexpectedErrorOccured } from '../types/interceptor-reply-messages.js'
import { getWebsiteCreatedEthereumTransactions } from '../simulation/services/SimulationModeEthereumClientService.js'
import { updatePopupVisualisationIfNeeded, updatePopupVisualisationState } from './popupVisualisationUpdater.js'
import { resolveFetchSimulationStackRequest } from './windows/fetchSimulationStack.js'
import { updateChainChangeViewWithPendingRequest } from './windows/changeChain.js'
import { resolveWatchAsset, updateWatchAssetViewWithPendingRequest } from './windows/watchAsset.js'
import { updateInterceptorAccessViewWithPendingRequests } from './windows/interceptorAccess.js'
import type { ResetSimulationServices } from '../simulation/serviceLifecycle.js'
import { updateFetchSimulationStackRequestWithPendingRequest } from './windows/fetchSimulationStack.js'
import { estimateSerializedStateBytes, formatEstimatedBytes } from '../utils/largeStateStore.js'
import { POPUP_PERFORMANCE_MARKS, markPerformance } from '../utils/popupPerformance.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { updateRichListAddress } from '../utils/richList.js'
import { serializeSimulateExecutionReply } from '../types/simulateExecutionReply.js'
import { createSafeContractValidationFailure, createSafeOwnerValidator, getSafeContractSnapshot } from '../safe/safeCore.js'
import { normalizeConsecutiveTimeManipulations } from '../utils/transactionStack.js'
import { getPendingSafeSignerAddress } from './safeConfirmationResolver.js'
import { getWalletSelectedAccount } from '../utils/signerMetadata.js'
export { importSafeStack, requestSafeStackExport, validateSafeTransactionStackForCurrentContract } from './safeStackHandlers.js'
export { getLastKnownCurrentTabId } from './currentTab.js'
export { exportSettings, importSettings, setNewRpcList, settingsOpened } from './popupMessageHandlers/settings.js'
export { allowOrPreventAddressAccessForWebsite, blockOrAllowExternalRequests, disableInterceptor, reloadConnectedTabs, removeWebsiteAccess, removeWebsiteAddressAccess, retrieveWebsiteAccess } from './popupMessageHandlers/websiteAccess.js'
import { getLastKnownCurrentTabId } from './currentTab.js'
import { disableInterceptorForPage } from './popupMessageHandlers/websiteAccess.js'

type TimestampedPopupVisualisation = {
	data: {
		simulationState: {
			simulationConductedTimestamp: Date
		}
	}
}

const getSimulationConductedTimestamp = (popupVisualisation: TimestampedPopupVisualisation) => popupVisualisation.data.simulationState.simulationConductedTimestamp

const formatCaughtErrorMessage = (error: unknown) => getErrorMessage(error) ?? 'Unknown error'

const importSimulationStackSuccess = (): ImportSimulationStackReply => ({ type: 'ImportSimulationStackReply', ok: true })
const importSimulationStackFailure = (message: string): ImportSimulationStackReply => ({ type: 'ImportSimulationStackReply', ok: false, message })

function isInterceptorDisabledForWebsite(settings: Settings, websiteOrigin: string | undefined) {
	if (websiteOrigin === undefined) return false
	return settings.websiteAccess.some((entry) => entry.website.websiteOrigin === websiteOrigin && entry.interceptorDisabled === true)
}

async function refreshSignerAccountsForTabIfNeeded(websiteTabConnections: WebsiteTabConnections, tabId: number | undefined, tabState: TabState, shouldRefreshSignerAccounts: boolean) {
	if (!shouldRefreshSignerAccounts || tabId === undefined) return tabState
	if (tabState.signerAccounts.length !== 0) return tabState
	if (tabState.signerName === 'NoSigner' || tabState.signerName === 'NoSignerDetected') return tabState

	const tabConnections = websiteTabConnections.get(tabId)
	if (tabConnections === undefined) return tabState
	const approvedConnection = Object.values(tabConnections.connections).find((connection) => connection.approved)
	if (approvedConnection === undefined) return tabState

	await askForSignerAccountsFromSignerIfNotAvailable(websiteTabConnections, approvedConnection.socket, false)
	return await getTabState(tabId)
}

async function getWalletSelectedAddressBookEntry(tabState: TabState, chainId: bigint) {
	const walletSelectedAccount = getWalletSelectedAccount(tabState)
	if (walletSelectedAccount === undefined) return undefined
	return (await getUserAddressBookEntriesForChainIdMorePreciseFirst(chainId)).find((entry) => entry.address === walletSelectedAccount)
}

export async function confirmDialog(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, websiteTabConnections: WebsiteTabConnections, confirmation: TransactionConfirmation) {
	const pending = confirmation.data.action === 'accept'
		? (await getPendingTransactionsAndMessages()).find((entry) =>
			doesUniqueRequestIdentifiersMatch(entry.uniqueRequestIdentifier, confirmation.data.uniqueRequestIdentifier)
		)
		: undefined
	const refreshedSafeSignerSelection = pending !== undefined && (
		getPendingSafeSignerAddress(pending) !== undefined
		|| pending.type === 'Transaction' && pending.safeTransaction !== undefined
		|| pending.type === 'SignableMessage' && pending.safeMessageCoSignSnapshot !== undefined
	)
		? await (async () => {
			const refreshResult = await refreshSignerAccountsForTab(
				websiteTabConnections,
				pending.uniqueRequestIdentifier.requestSocket.tabId,
				false,
			)
			return {
				selectedSigner: refreshResult?.error === undefined ? refreshResult?.accounts[0] : undefined,
				verificationError: refreshResult?.error?.message ?? (refreshResult === undefined ? 'The connected signer wallet is unavailable.' : undefined),
			}
		})()
		: undefined
	await resolvePendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, confirmation, refreshedSafeSignerSelection)
}

export async function confirmRequestAccess(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, confirmation: InterceptorAccess, publishRpcConnectionStatus: PublishRpcConnectionStatus) {
	await resolveInterceptorAccess(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, confirmation.data, publishRpcConnectionStatus)
}

export async function popupReadyAndListening(ethereum: EthereumClientService, websiteTabConnections: WebsiteTabConnections, page: PopupReadyAndListeningPage) {
	switch (page) {
		case 'watchAsset': {
			const request = await updateWatchAssetViewWithPendingRequest(websiteTabConnections)
			if (request === undefined) return undefined
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: request.popupOrTabId,
					confirmTransactionBootstrap: undefined,
				},
			}
		}
		case 'changeChain': {
			const promise = await getChainChangeConfirmationPromise()
			if (promise === undefined) return undefined
			await updateChainChangeViewWithPendingRequest()
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: promise.popupOrTabId,
					confirmTransactionBootstrap: undefined,
				},
			}
		}
		case 'confirmTransaction': {
			const pendingTransactions = await getPendingTransactionsAndMessages()
			const firstPendingTransaction = pendingTransactions[0]
			if (firstPendingTransaction === undefined) return undefined
			const currentBlockNumber = await ethereum.getBlockNumber(undefined)
			const rpcConnectionStatus = await getRpcConnectionStatus()
			const visualizedSimulatorState = await getPopupVisualisationState()
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: firstPendingTransaction.popupOrTabId,
					confirmTransactionBootstrap: {
						pendingTransactionAndSignableMessages: pendingTransactions.map(toPopupPendingTransactionOrSignableMessage),
						currentBlockNumber,
						rpcConnectionStatus,
						visualizedSimulatorState,
					},
				},
			}
		}
		case 'interceptorAccess': {
			const pendingAccessRequests = await getPendingAccessRequests()
			const firstPendingAccessRequest = pendingAccessRequests[0]
			if (firstPendingAccessRequest === undefined) return undefined
			await updateInterceptorAccessViewWithPendingRequests()
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: firstPendingAccessRequest.popupOrTabId,
					confirmTransactionBootstrap: undefined,
				},
			}
		}
		case 'fetchSimulationStack': {
			const promise = await getFetchSimulationStackRequestPromise()
			if (promise === undefined) return undefined
			await updateFetchSimulationStackRequestWithPendingRequest()
			return {
				method: 'popup_readyAndListening' as const,
				data: {
					popupOrTabId: promise.popupOrTabId,
					confirmTransactionBootstrap: undefined,
				},
			}
		}
		default:
			assertNever(page)
	}
}

export async function watchAssetDialog(websiteTabConnections: WebsiteTabConnections, confirmation: WatchAssetConfirmation) {
	await resolveWatchAsset(websiteTabConnections, confirmation)
}

async function getSignerAccount() {
	const tabId = await getLastKnownCurrentTabId()
	const signerAccounts = tabId === undefined ? undefined : (await getTabState(tabId)).signerAccounts
	return signerAccounts !== undefined && signerAccounts.length > 0 ? signerAccounts[0] : undefined
}

export async function changeActiveAddress(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, addressChange: ChangeActiveAddress) {
	// if using signers address, set the active address to signers address if available, otherwise we don't know active address and set it to be undefined
	if (addressChange.data.activeAddress === 'signer') {
		await setUseSignersAddressAsActiveAddress(true, await getSignerAccount())
		await refreshSignerAccountsFromApprovedWebsitePorts(websiteTabConnections, false)
		sendCallbackToAllConfirmedSignerOwners(websiteTabConnections, { method: 'request_signer_chainId', result: [] })
		const signerAccount = await getSignerAccount()

		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			simulationMode: addressChange.data.simulationMode,
			activeAddress: signerAccount,
		})
		if (!addressChange.data.simulationMode && signerAccount !== undefined) {
			await rememberSigningAddressPreference({ signerAddress: signerAccount, selection: 'signer' })
		}
	} else {
		const activeChainId = (await getSettings()).activeRpcNetwork.chainId
		if (addressChange.data.simulationMode) {
			assertAccessDialogAddressIsAvailable(await getUserAddressBookEntries(), activeChainId, addressChange.data.activeAddress)
		}
		const activeChainEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(activeChainId)
		const activeChainSigningSafe = activeChainEntries.find((entry): entry is SafeEntry =>
			entry.type === 'safe' && entry.address === addressChange.data.activeAddress
		)
		if (!addressChange.data.simulationMode) {
			if (activeChainSigningSafe === undefined) return
			const signerAccount = await getSignerAccount()
			if (signerAccount !== undefined && activeChainSigningSafe.safeSignerAddresses?.includes(signerAccount) !== true) return
		}
		await setUseSignersAddressAsActiveAddress(false)
		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			simulationMode: addressChange.data.simulationMode,
			activeAddress: addressChange.data.activeAddress,
		})
		if (!addressChange.data.simulationMode && activeChainSigningSafe !== undefined) {
			const signerAccount = await getSignerAccount()
			if (signerAccount !== undefined) await rememberSigningAddressPreference({
				signerAddress: signerAccount,
				selection: 'safe',
				safeAddress: activeChainSigningSafe.address,
				chainId: activeChainSigningSafe.chainId,
			})
		}
	}
}

export async function modifyMakeMeRich(makeMeRichChange: ModifyMakeMeRich) {
	if (makeMeRichChange.data.address === 'CurrentAddress') {
		await updateMakeCurrentAddressRich(() => makeMeRichChange.data.add)
		return
	}
	const address = makeMeRichChange.data.address
	await updateFixedMakeMeRichList((currentList) => updateRichListAddress(
		currentList,
		address,
		makeMeRichChange.data.add,
		(element) => element.address,
		() => ({
			address,
			makingRich: true,
			type: 'UserAdded' as const
		}),
	))
}

export async function removeAddressBookEntry(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, removeAddressBookEntry: RemoveAddressBookEntry) {
	await updateUserAddressBookEntries((previousContacts) => previousContacts.filter((contact) =>
		!(contact.address === removeAddressBookEntry.data.address
		&& (contact.chainId === removeAddressBookEntry.data.chainId || (contact.chainId === undefined && removeAddressBookEntry.data.chainId === 1n))))
	)
	if (removeAddressBookEntry.data.addressBookCategory === 'My Active Addresses' || removeAddressBookEntry.data.addressBookCategory === 'My Safes') {
		await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings(), true)
	}
	await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
}

type RefreshAddressBookMetadata = (ethereum: EthereumClientService, tokenPriceService: TokenPriceService) => Promise<void>

export async function refreshAddressBookMetadataAfterSave(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	try {
		await refreshPopupConfirmTransactionMetadata(ethereum, tokenPriceService, undefined)
	} catch(error) {
		if (isExpectedInfrastructureError(error)) return
		await reportUnexpectedError(error, {
			source: 'address_book_metadata_refresh',
			code: 'address_book_metadata_refresh_failed',
			displayMessage: 'Failed to refresh simulation address metadata.',
		})
	}
}

export async function addOrModifyAddressBookEntry(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, entry: AddOrEditAddressBookEntry, refreshMetadata: RefreshAddressBookMetadata = refreshAddressBookMetadataAfterSave) {
	try {
		let entryToStore: AddressBookEntry = entry.data
		if (entry.data.type === 'safe') {
			try {
				if (entry.data.chainId !== ethereum.getChainId()) {
					return {
						type: 'AddOrModifyAddressBookEntryReply' as const,
						ok: false as const,
						message: `Switch Interceptor to chain ${ entry.data.chainId.toString() } before validating this Gnosis Safe.`,
					}
				}
				const { blockNumber, state: safeState } = await getSafeContractSnapshot(ethereum, entry.data.address)
				if (safeState.owners.length === 0) throw createSafeContractValidationFailure('The Gnosis Safe does not have any owners.')
				const safeSimulationSignerAddress = entry.data.safeSimulationSignerAddress
				if (safeSimulationSignerAddress === undefined || !safeState.owners.includes(safeSimulationSignerAddress)) {
					throw createSafeContractValidationFailure('Select a current Gnosis Safe owner for simulation.')
				}
				const ownerValidator = createSafeOwnerValidator(ethereum, entry.data.address, { blockNumber, state: safeState })
				await ownerValidator.assertEoaOwner(safeSimulationSignerAddress)
				entryToStore = {
					...entry.data,
					safeSimulationSignerAddress,
					safeSignerAddresses: [...safeState.owners],
					safeVersion: safeState.version,
				}
			} catch(error) {
				if (!isExpectedHandledError(error)) {
					await reportUnexpectedError(error, {
						source: 'address_book_safe_validation',
						code: 'address_book_safe_validation_failed',
						displayMessage: 'Failed to validate the Gnosis Safe address.',
					})
				}
				return {
					type: 'AddOrModifyAddressBookEntryReply' as const,
					ok: false as const,
					message: getErrorMessage(error) ?? 'Failed to validate Gnosis Safe address.',
				}
			}
		}
		await updateUserAddressBookEntries((previousContacts) => {
			if (previousContacts.find((previous) => previous.address === entryToStore.address && doAddressBookChainIdsMatch(previous.chainId, entryToStore.chainId)) ) {
				return previousContacts.map((previous) => previous.address === entryToStore.address && doAddressBookChainIdsMatch(previous.chainId, entryToStore.chainId) ? entryToStore : previous)
			}
			return previousContacts.concat([entryToStore])
		})
		if (entryToStore.useAsActiveAddress) await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings(), true, true)
		await refreshMetadata(ethereum, tokenPriceService)
		await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
		return { type: 'AddOrModifyAddressBookEntryReply' as const, ok: true as const }
	} catch(error) {
		if (!isExpectedInfrastructureError(error)) await reportUnexpectedError(error, {
			source: 'address_book_save',
			code: 'address_book_save_failed',
			displayMessage: 'Failed to save address-book entry.',
		})
		return {
			type: 'AddOrModifyAddressBookEntryReply' as const,
			ok: false as const,
			message: getErrorMessage(error) ?? 'Failed to save address-book entry.',
		}
	}
}

export async function setSafeSimulationSigner(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	request: SetSafeSimulationSigner,
) {
	if (request.data.chainId !== ethereum.getChainId()) {
		return {
			type: 'SetSafeSimulationSignerReply' as const,
			ok: false as const,
			message: `Switch Interceptor to chain ${ request.data.chainId.toString() } before changing the Safe simulation signer.`,
		}
	}
	const safeEntry = (await getUserAddressBookEntries()).find((entry) =>
		entry.type === 'safe' && entry.address === request.data.safeAddress && entry.chainId === request.data.chainId
	)
	if (safeEntry?.type !== 'safe') {
		return { type: 'SetSafeSimulationSignerReply' as const, ok: false as const, message: 'The Gnosis Safe address-book entry no longer exists.' }
	}
	let validatedSafeState: Awaited<ReturnType<typeof getSafeContractSnapshot>>['state']
	try {
		const { blockNumber, state } = await getSafeContractSnapshot(ethereum, safeEntry.address)
		const ownerValidator = createSafeOwnerValidator(ethereum, safeEntry.address, { blockNumber, state })
		await ownerValidator.assertEoaOwner(request.data.safeSimulationSignerAddress)
		validatedSafeState = state
	} catch(error) {
		if (!isExpectedHandledError(error)) {
			await reportUnexpectedError(error, {
				source: 'safe_simulation_signer',
				code: 'safe_simulation_signer_validation_failed',
				displayMessage: 'Failed to validate the Safe simulation signer.',
			})
		}
		return {
			type: 'SetSafeSimulationSignerReply' as const,
			ok: false as const,
			message: getErrorMessage(error) ?? 'The selected address is not a current wallet-signable Safe owner.',
		}
	}
	let updatedEntry: AddressBookEntry | undefined
	await updateUserAddressBookEntries((entries) => entries.map((entry) => {
		if (entry.type !== 'safe' || entry.address !== request.data.safeAddress || entry.chainId !== request.data.chainId) return entry
		updatedEntry = {
			...entry,
			safeSimulationSignerAddress: request.data.safeSimulationSignerAddress,
			safeSignerAddresses: [...validatedSafeState.owners],
			safeVersion: validatedSafeState.version,
		}
		return updatedEntry
	}))
	if (updatedEntry === undefined) {
		return {
			type: 'SetSafeSimulationSignerReply' as const,
			ok: false as const,
			message: 'The Gnosis Safe address-book entry no longer exists.',
		}
	}
	if (updatedEntry.useAsActiveAddress) {
		await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings(), true)
	}
	await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
	return { type: 'SetSafeSimulationSignerReply' as const, ok: true as const }
}

export async function changeInterceptorAccess(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, accessChange: ChangeInterceptorAccess) {
	await updateWebsiteAccess((previousAccess) => {
		const withEntriesRemoved = previousAccess.filter((acc) => accessChange.data.find((change) => change.newEntry.website.websiteOrigin === acc.website.websiteOrigin)?.removed !== true)
		return withEntriesRemoved.map((entry) => {
			const changeForEntry = accessChange.data.find((change) => change.newEntry.website.websiteOrigin === entry.website.websiteOrigin)
			if (changeForEntry === undefined) return entry
			return changeForEntry.newEntry
		})
	})

	const interceptorDisablesChanged = accessChange.data.filter((x) => x.newEntry.interceptorDisabled !== x.oldEntry.interceptorDisabled).map((x) => x)
	await Promise.all(interceptorDisablesChanged.map(async (disable) => {
		if (disable.newEntry.interceptorDisabled === undefined) return
		return await disableInterceptorForPage(websiteTabConnections, disable.newEntry.website, disable.newEntry.interceptorDisabled)
	}))

	await updateWebsiteApprovalAccesses(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, await getSettings(), true)
	await sendPopupMessageToOpenWindows({ method: 'popup_interceptor_access_changed' })
}

export const changePage = async (page: ChangePage) => await setPage(page.data)

export async function requestAccountsFromSigner(websiteTabConnections: WebsiteTabConnections, params: RequestAccountsFromSigner) {
	if (params.data) {
		await refreshSignerAccountsFromApprovedWebsitePorts(websiteTabConnections, true)
		sendCallbackToAllConfirmedSignerOwners(websiteTabConnections, { method: 'request_signer_chainId', result: [] })
	}
}

export async function removeTransactionOrSignedMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, params: RemoveTransaction) {
	if (params.data.type === 'Transaction') {
		const currentStack = await getInterceptorTransactionStack()
		const transactionIdentifier = params.data.transactionIdentifier
		const safeOperation = currentStack.operations.find((operation): operation is Extract<InterceptorStackOperation, { type: 'Transaction' }> =>
			operation.type === 'Transaction'
			&& operation.preSimulationTransaction.transactionIdentifier === transactionIdentifier
		)
		const safeTransactionToRemove = safeOperation?.preSimulationTransaction.safeTransaction
		if (safeTransactionToRemove !== undefined) {
			await updateTransactionState((previousState) => {
				const identifiersToRemove = new Set<bigint>()
				const safeTransactionStacks = previousState.safeTransactionStacks.map((stack) => {
					const transactionIndex = stack.transactions.findIndex((transaction) => transaction.safeTxHash === safeTransactionToRemove.safeTxHash)
					if (transactionIndex === -1) return stack
					for (const transaction of stack.transactions.slice(transactionIndex)) identifiersToRemove.add(transaction.transactionIdentifier)
					return { ...stack, transactions: stack.transactions.slice(0, transactionIndex) }
				}).filter((stack) => stack.transactions.length > 0)
				return {
					safeTransactionStacks,
					interceptorTransactionStack: {
						operations: normalizeConsecutiveTimeManipulations(previousState.interceptorTransactionStack.operations.filter((operation) =>
							operation.type !== 'Transaction' || !identifiersToRemove.has(operation.preSimulationTransaction.transactionIdentifier)
						)),
					},
				}
			})
			await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, true, false)
			return
		}
	}
	await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
		switch (params.data.type) {
			case 'Transaction': {
				const transactionIdentifier = params.data.transactionIdentifier
				const transactionToBeRemoved = prevStack.operations.find((transaction): transaction is Extract<InterceptorStackOperation, { type: 'Transaction' }> => transaction.type === 'Transaction' && transaction.preSimulationTransaction.transactionIdentifier === transactionIdentifier)
				if (transactionToBeRemoved === undefined) return prevStack
				const removedTransaction = transactionToBeRemoved.preSimulationTransaction
				const shouldShiftNonceAfterRemoval = (transaction: typeof removedTransaction) => {
					return transactionWasFound
						&& transaction.originalRequestParameters.method === 'eth_sendTransaction'
						&& transaction.signedTransaction.from === removedTransaction.signedTransaction.from
						&& transaction.signedTransaction.nonce > removedTransaction.signedTransaction.nonce
				}

				const newOperations: InterceptorStackOperation[] = []
				let transactionWasFound = false
				for (const operation of prevStack.operations) {
					if (operation.type === 'Transaction' && transactionIdentifier === operation.preSimulationTransaction.transactionIdentifier) {
						transactionWasFound = true
						continue
					}
					if (operation.type === 'Transaction') {
						const transaction = operation.preSimulationTransaction
						const shouldUpdateNonce = shouldShiftNonceAfterRemoval(transaction)
						const newTransaction = shouldUpdateNonce ? modifyObject(transaction.signedTransaction, { nonce: transaction.signedTransaction.nonce - 1n }) : transaction.signedTransaction
						newOperations.push({ type: operation.type, preSimulationTransaction: modifyObject(transaction, { signedTransaction: newTransaction }) })
						continue
					}
					newOperations.push(operation)
				}
				return { operations: normalizeConsecutiveTimeManipulations(newOperations) }
			}
			case 'Message': {
				const messageIdentifier = params.data.messageIdentifier
				return {
					operations: normalizeConsecutiveTimeManipulations(prevStack.operations)
						.filter((operation) => !(operation.type === 'Message' && messageIdentifier === operation.signedMessageTransaction.messageIdentifier))
				}
			}
			default: assertNever(params.data)
		}
	})

	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, true, false)
}

export async function refreshPopupConfirmTransactionMetadata(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, requestAbortController: AbortController | undefined) {
	const promises = await getPendingTransactionsAndMessages()
	const first = promises[0]
	if (first === undefined) return
	const currentBlockNumberPromise = ethereum.getBlockNumber(requestAbortController)
	silenceChromeUnCaughtPromise(currentBlockNumberPromise)
	const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
	const visualizedSimulatorStatePromise = silenceChromeUnCaughtPromise((async () => {
		// A confirmation popup consumes this state even when the standalone simulation visualizer is closed.
		await updatePopupVisualisationState(ethereum, tokenPriceService, undefined, true)
		return await getPopupVisualisationState()
	})())
	switch (first.type) {
		case 'SignableMessage': {
			const visualizedPersonalSignRequestPromise = craftPersonalSignPopupMessage(ethereum, requestAbortController, first.signedMessageTransaction, ethereum.getRpcEntry())
			silenceChromeUnCaughtPromise(visualizedPersonalSignRequestPromise)
			const message: UpdateConfirmTransactionDialog = {
				method: 'popup_update_confirm_transaction_dialog',
				data: {
					visualizedSimulatorState: await visualizedSimulatorStatePromise,
					currentBlockNumber: await currentBlockNumberPromise,
					rpcConnectionStatus: await rpcConnectionStatusPromise,
				}
			}
			const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
				method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
				data: {
					pendingTransactionAndSignableMessages: [{
						...first,
						visualizedPersonalSignRequest: await visualizedPersonalSignRequestPromise,
						transactionOrMessageCreationStatus: 'Simulated' as const
					}, ...promises.slice(1)].map(toPopupPendingTransactionOrSignableMessage),
					currentBlockNumber: await currentBlockNumberPromise,
					rpcConnectionStatus: await rpcConnectionStatusPromise,
				}
			}
			await Promise.all([
				sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions), 'confirmTransaction'),
				sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
			])
			return
		}
		case 'Transaction': {
			if (first.transactionOrMessageCreationStatus !== 'Simulated' || first.popupVisualisation.statusCode === 'failed') return
			try {
				const visualizedSimulationState = await visualizeSimulatorState(first.popupVisualisation.data.simulationState, ethereum, tokenPriceService, requestAbortController)
				const updatedFirst = modifyObject(first,
					{
						popupVisualisation: {
							statusCode: 'success',
							data: modifyObject(first.popupVisualisation.data, { ...visualizedSimulationState })
						}
					})
				await updatePendingTransactionOrMessage(first.uniqueRequestIdentifier, async () => updatedFirst)
				const messagePendingTransactions: UpdateConfirmTransactionDialogPendingTransactions = {
					method: 'popup_update_confirm_transaction_dialog_pending_transactions' as const,
					data: {
						pendingTransactionAndSignableMessages: [
							updatedFirst
							, ...promises.slice(1)].map(toPopupPendingTransactionOrSignableMessage),
						currentBlockNumber: await currentBlockNumberPromise,
						rpcConnectionStatus: await rpcConnectionStatusPromise,
					}
				}
				const message: UpdateConfirmTransactionDialog = {
					method: 'popup_update_confirm_transaction_dialog' as const,
					data: {
						visualizedSimulatorState: await visualizedSimulatorStatePromise,
						currentBlockNumber: await currentBlockNumberPromise,
						rpcConnectionStatus: await rpcConnectionStatusPromise,
					}
				}
				await Promise.all([
					sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialogPendingTransactions, messagePendingTransactions), 'confirmTransaction'),
					sendPopupMessageToOpenWindows(serialize(UpdateConfirmTransactionDialog, message), 'confirmTransaction')
				])
				return
			} catch(error: unknown) {
				if (isExpectedInfrastructureError(error)) return
				throw error
			}
		}
		default: assertNever(first)
	}
}

export async function refreshPopupConfirmTransactionSimulation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	const [firstTxn] = await getPendingTransactionsAndMessages()
	if (firstTxn === undefined || firstTxn.type !== 'Transaction' || (firstTxn.transactionOrMessageCreationStatus !== 'Simulated' && firstTxn.transactionOrMessageCreationStatus !== 'FailedToSimulate')) return
	const transactionToSimulate = firstTxn.originalRequestParameters.method === 'eth_sendTransaction'
		? await formEthSendTransaction(
			ethereum,
			undefined,
			firstTxn.activeAddress,
			firstTxn.transactionToSimulate.website,
			firstTxn.originalRequestParameters,
			firstTxn.created,
			firstTxn.transactionIdentifier,
			firstTxn.simulationMode,
			firstTxn.safeTransaction === undefined ? 'transaction-sender' : 'external-executor',
		)
		: await formSendRawTransaction(ethereum, firstTxn.originalRequestParameters, firstTxn.transactionToSimulate.website, firstTxn.created, firstTxn.transactionIdentifier)
	const refreshMessage = await refreshConfirmTransactionSimulation(
		ethereum,
		tokenPriceService,
		firstTxn.activeAddress,
		firstTxn.simulationMode,
		firstTxn.uniqueRequestIdentifier,
		transactionToSimulate,
		firstTxn.safeTransaction,
	)
	if (refreshMessage === undefined) return
	await updatePendingTransactionOrMessage(firstTxn.uniqueRequestIdentifier, async (transactionOrMessage) => {
		switch (transactionOrMessage.type) {
			case 'SignableMessage': throw new Error('Tried to refresh simulation of a message')
			case 'Transaction': {
				if (transactionOrMessage.transactionOrMessageCreationStatus !== 'Simulated' && transactionOrMessage.transactionOrMessageCreationStatus !== 'FailedToSimulate') return transactionOrMessage
				const currentTimestamp = getSimulationConductedTimestamp(transactionOrMessage.popupVisualisation)
				const nextTimestamp = getSimulationConductedTimestamp(refreshMessage)
				if (currentTimestamp !== undefined && nextTimestamp !== undefined && nextTimestamp.getTime() < currentTimestamp.getTime()) return transactionOrMessage
				if (transactionToSimulate.success) {
					return {
						...transactionOrMessage,
						transactionToSimulate,
						popupVisualisation: refreshMessage,
						transactionOrMessageCreationStatus: 'Simulated' as const,
					}
				}
				return {
					...transactionOrMessage,
					transactionToSimulate,
					popupVisualisation: refreshMessage,
					transactionOrMessageCreationStatus: 'FailedToSimulate' as const,
				}
			}
			default: assertNever(transactionOrMessage)
		}
	})
	await updateConfirmTransactionView(ethereum, tokenPriceService, true)
}

export async function popupChangeActiveRpc(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, params: ChangeActiveChain, settings: Settings) {
	await changeActiveRpc(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, params.data, settings.simulationMode, await getLastKnownCurrentTabId())
}

export async function changeChainDialog(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, chainChange: ChainChangeConfirmation) {
	await resolveChainChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, chainChange)
}

export async function enableSimulationMode(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	params: EnableSimulationMode,
	signerAccountRefreshOptions: SignerAccountRefreshOptions = {},
) {
	const settings = await getSettings()
	// if we are on unsupported chain, force change to a supported one
	if (settings.useSignersAddressAsActiveAddress || params.data === false) {
		const tabId = await getLastKnownCurrentTabId()
		if (tabId !== undefined) await refreshSignerAccountsForTab(websiteTabConnections, tabId, false, signerAccountRefreshOptions)
		if (tabId !== undefined) sendCallbackToConfirmedSignerOwner(websiteTabConnections, tabId, { method: 'request_signer_chainId', result: [] })
		const chainToSwitch = tabId === undefined ? undefined : (await getTabState(tabId)).signerChain
		const networkToSwitch = chainToSwitch === undefined ? (await getRpcList())[0] : await getPrimaryRpcForChain(chainToSwitch)
		const targetChainId = networkToSwitch?.chainId ?? settings.activeRpcNetwork.chainId
		const configuredSigningSafeCandidate = getSafeSigningEntry(
			await getUserAddressBookEntriesForChainIdMorePreciseFirst(targetChainId),
			{
				simulationMode: params.data,
				useSignersAddressAsActiveAddress: settings.useSignersAddressAsActiveAddress,
				activeSimulationAddress: settings.activeSimulationAddress,
				chainId: targetChainId,
			},
		)
		const signerAccount = await getSignerAccount()
		const configuredSigningSafe = configuredSigningSafeCandidate !== undefined
			&& (signerAccount === undefined || configuredSigningSafeCandidate.safeSignerAddresses?.includes(signerAccount) === true)
			? configuredSigningSafeCandidate
			: undefined
		if (!params.data) {
			await setUseSignersAddressAsActiveAddress(configuredSigningSafe === undefined, signerAccount)
			if (signerAccount !== undefined && configuredSigningSafe !== undefined) await rememberSigningAddressPreference({
				signerAddress: signerAccount,
				selection: 'safe',
				safeAddress: configuredSigningSafe.address,
				chainId: configuredSigningSafe.chainId,
			})
		}
		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			simulationMode: params.data,
			activeAddress: configuredSigningSafe?.address ?? signerAccount,
			...chainToSwitch === undefined ? {} : { rpcNetwork: networkToSwitch },
		})
	} else {
		const selectedNetworkToSwitch = settings.activeRpcNetwork.httpsRpc !== undefined ? settings.activeRpcNetwork : (await getRpcList())[0]
		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			simulationMode: params.data,
			...settings.activeRpcNetwork === selectedNetworkToSwitch ? {} : { rpcNetwork: selectedNetworkToSwitch }
		})
	}
}

export async function getAddressBookData(parsed: GetAddressBookData) {
	const data = await getMetadataForAddressBookData(parsed.data)
	await sendPopupMessageToOpenWindows({
		method: 'popup_getAddressBookDataReply',
		data: {
			data: parsed.data,
			entries: data.entries,
			maxDataLength: data.maxDataLength,
		}
	})
}

type ExtensionTabName = 'settingsView' | 'addressBook' | 'websiteAccess' | 'simulationStack'

type ExistingTabUpdate = {
	active: true
	highlighted: true
	url?: string
}

function getExistingTabUpdate(tabName: ExtensionTabName, targetUrl: string, resolvedTargetUrl: URL, currentTabUrl: string | undefined, targetHash: string): ExistingTabUpdate {
	const url = getExistingTabUrlUpdate(tabName, targetUrl, resolvedTargetUrl, currentTabUrl, targetHash)
	if (url === undefined) return { active: true, highlighted: true }
	return { active: true, highlighted: true, url }
}

function getExistingTabUrlUpdate(tabName: ExtensionTabName, targetUrl: string, resolvedTargetUrl: URL, currentTabUrl: string | undefined, targetHash: string) {
	if (targetHash.length !== 0) return targetUrl
	if (tabName !== 'simulationStack') return undefined
	if (currentTabUrl === undefined) return undefined
	return shouldClearSimulationStackHash(currentTabUrl, targetUrl, resolvedTargetUrl) ? targetUrl : undefined
}

function shouldClearSimulationStackHash(currentTabUrl: string, targetUrl: string, resolvedTargetUrl: URL) {
	try {
		const currentUrl = new URL(currentTabUrl, browser.runtime.getURL('/'))
		return currentUrl.pathname !== resolvedTargetUrl.pathname || currentUrl.hash !== ''
	} catch {
		return currentTabUrl !== targetUrl
	}
}

export const openNewTab = async (tabName: ExtensionTabName, targetHash = '') => {
	const targetUrl = `${ getHtmlFile(tabName) }${ targetHash }`
	const resolvedTargetUrl = new URL(targetUrl, browser.runtime.getURL('/'))
	const openInNewTab = async () => {
		const tab = await browser.tabs.create({ url: targetUrl })
		if (tab.id !== undefined) await setIdsOfOpenedTabs({ [tabName]: tab.id })
	}

	const tabId = (await getIdsOfOpenedTabs())[tabName]
	if (tabId === undefined) return await openInNewTab()
	const allTabs = await browser.tabs.query({})
	const addressBookTab = allTabs.find((tab) => tab.id === tabId)

	if (addressBookTab?.id === undefined) return await openInNewTab()
	const tab = await updateTabIfExists(addressBookTab.id, getExistingTabUpdate(tabName, targetUrl, resolvedTargetUrl, addressBookTab.url, targetHash))
	if (tab === undefined) return await openInNewTab()
	if (tab?.windowId !== undefined) await updateWindowIfExists(tab.windowId, { focused: true })
}

export async function requestNewHomeData(
	ethereum: EthereumClientService,
	websiteTabConnections: WebsiteTabConnections,
	shouldRefreshSignerAccounts: boolean,
	includeWebsiteAccessAddressMetadata: boolean,
	requestAbortController: AbortController | undefined,
	popupRefreshGeneration: number,
) {
	const newPopupRefreshGeneration = popupRefreshGeneration
	const updatedPage = await buildHomePageUpdate(ethereum, websiteTabConnections, {
		requestAbortController,
		richDataSource: 'cached',
		shouldRefreshSignerAccounts,
		includeWebsiteAccessAddressMetadata,
		popupRefreshGeneration: newPopupRefreshGeneration,
	})
	await sendPopupMessageToOpenWindows(updatedPage)
}

export async function requestHomePageBootstrap(websiteTabConnections: WebsiteTabConnections, popupRefreshGeneration: number) {
	const settingsPromise = silenceChromeUnCaughtPromise(getSettings())
	const rpcEntriesPromise = silenceChromeUnCaughtPromise(getRpcList())
	const activeAddressesPromise = silenceChromeUnCaughtPromise(getActiveAddresses())
	const tabId = await getLastKnownCurrentTabId()
	const tabStatePromise = silenceChromeUnCaughtPromise(tabId === undefined ? getTabState(-1) : getTabState(tabId))
	const settings = await settingsPromise
	const tabState = await tabStatePromise
	const activeSigningAddress = tabId === undefined ? undefined : (await getActiveAddressForCurrentPopupSignerState(settings, websiteTabConnections, tabId))?.address
	const walletSelectedAddressBookEntry = await getWalletSelectedAddressBookEntry(tabState, settings.activeRpcNetwork.chainId)
	const interceptorDisabled = isInterceptorDisabledForWebsite(settings, tabState.website?.websiteOrigin)

	await sendPopupMessageToOpenWindows({
		method: 'popup_homePageBootstrap',
		popupRefreshGeneration,
		data: {
			activeAddresses: await activeAddressesPromise,
			walletSelectedAddressBookEntry,
			tabState,
			settings,
			activeSigningAddressInThisTab: activeSigningAddress,
			tabId,
			rpcEntries: await rpcEntriesPromise,
			interceptorDisabled,
		},
	})
}

export async function refreshHomeData(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	websiteTabConnections: WebsiteTabConnections,
	shouldRefreshSignerAccounts: boolean,
	popupRefreshGeneration: number,
	publishRpcConnectionStatus: PublishRpcConnectionStatus,
	refreshSimulation = true,
	requestAbortController: AbortController | undefined = undefined,
) {
	const newPopupRefreshGeneration = popupRefreshGeneration
	markPerformance(POPUP_PERFORMANCE_MARKS.backgroundRefreshStart)
	try {
		const currentSettings = await getSettings()
		if (currentSettings.simulationMode) await updateSimulationMetadata(ethereum, requestAbortController)
		if (refreshSimulation) await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, false, true)
		const settings = await getSettings()
		if (settings.activeRpcNetwork.httpsRpc !== undefined) await makeSureInterceptorIsNotSleeping(ethereum, publishRpcConnectionStatus)
		const updatedPage = await buildHomePageUpdate(ethereum, websiteTabConnections, {
			requestAbortController,
			richDataSource: 'fresh',
			shouldRefreshSignerAccounts,
			includeWebsiteAccessAddressMetadata: true,
			popupRefreshGeneration: newPopupRefreshGeneration,
		})
		await sendPopupMessageToOpenWindows(updatedPage)
	} finally {
		markPerformance(POPUP_PERFORMANCE_MARKS.backgroundRefreshEnd)
	}
}

export async function interceptorAccessChangeAddressOrRefresh(websiteTabConnections: WebsiteTabConnections, params: InterceptorAccessChangeAddress | InterceptorAccessRefresh) {
	await requestAddressChange(websiteTabConnections, params)
}

export async function changeSettings(ethereum: EthereumClientService, _tokenPriceService: TokenPriceService, _resetSimulationServices: ResetSimulationServices, parsedRequest: ChangeSettings, requestAbortController: AbortController | undefined) {
	if (parsedRequest.data.useTabsInsteadOfPopup !== undefined) await setUseTabsInsteadOfPopup(parsedRequest.data.useTabsInsteadOfPopup)
	if (parsedRequest.data.metamaskCompatibilityMode !== undefined) await setMetamaskCompatibilityMode(parsedRequest.data.metamaskCompatibilityMode)
	return await requestNewHomeData(ethereum, new Map(), false, true, requestAbortController, bumpPopupRefreshGeneration())
}

export async function simulateGovernanceContractExecutionOnPass(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, request: SimulateGovernanceContractExecution) {
	const pendingTransactions = await getPendingTransactionsAndMessages()
	const transaction = pendingTransactions.find((tx) => tx.type === 'Transaction' && tx.transactionIdentifier === request.data.transactionIdentifier)
	if (transaction === undefined || transaction.type !== 'Transaction') throw new Error(`Could not find transactionIdentifier: ${ request.data.transactionIdentifier }`)
	const governanceContractExecutionVisualisation = await simulateGovernanceContractExecution(transaction, ethereum, tokenPriceService)
	const reply = {
		method: 'popup_simulateExecutionReply' as const,
		data: { ...governanceContractExecutionVisualisation, transactionOrMessageIdentifier: request.data.transactionIdentifier }
	}
	await sendPopupMessageToOpenWindows(serializeSimulateExecutionReply(reply))
	return reply
}

export async function simulateGnosisSafeTransactionOnPass(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx) {
	const gnosisTransactionExecutionVisualisation = await simulateGnosisSafeMetaTransaction(gnosisSafeMessage, await getCurrentSimulationInput(), ethereum, tokenPriceService)
	const reply = {
		method: 'popup_simulateExecutionReply' as const,
		data: { ...gnosisTransactionExecutionVisualisation, transactionOrMessageIdentifier: gnosisSafeMessage.messageIdentifier }
	}
	await sendPopupMessageToOpenWindows(serializeSimulateExecutionReply(reply))
	return reply
}

const getErrorIfAnyWithIncompleteAddressBookEntry = async (ethereum: EthereumClientService, incompleteAddressBookEntry: IncompleteAddressBookEntry) => {
	// check for duplicates
	const duplicateEntry = await findEntryWithSymbolOrName(incompleteAddressBookEntry.symbol, incompleteAddressBookEntry.name, incompleteAddressBookEntry.chainId)
	if (duplicateEntry !== undefined && duplicateEntry.address !== stringToAddress(incompleteAddressBookEntry.address)) {
		return `There already exists ${ duplicateEntry.type } with ${ 'symbol' in duplicateEntry ? `the symbol "${ duplicateEntry.symbol }" and` : '' } the name "${ duplicateEntry.name }".`
	}

	// check that address is valid
	if (incompleteAddressBookEntry.address !== undefined) {
		const trimmed = incompleteAddressBookEntry.address.trim()
		if (isAddress(trimmed)) {
			const address = EthereumAddress.parse(trimmed)
			if (incompleteAddressBookEntry.addingAddress) {
				const identifiedAddress = await identifyAddress(ethereum, undefined, address)
				if (identifiedAddress.entrySource !== 'OnChain' && identifiedAddress.entrySource !== 'FilledIn') {
					return 'The address already exists. Edit the existing record instead trying to add it again.'
				}
			}
		}
		const issue = getIssueWithAddressString(trimmed)
		if (issue !== undefined) return issue
	}

	// check that ABI is valid
	const trimmedAbi = incompleteAddressBookEntry.abi === undefined ? undefined : incompleteAddressBookEntry.abi.trim()
	if (trimmedAbi !== undefined && trimmedAbi.length !== 0 && (!isJSON(trimmedAbi) || !isValidAbi(trimmedAbi))) {
		return 'The Abi provided is not a JSON ABI. Please provide a valid JSON ABI.'
	}
	return undefined
}

export async function changeAddOrModifyAddressWindowState(ethereum: EthereumClientService, parsedRequest: ChangeAddOrModifyAddressWindowState) {
	const updatePage = async (newState: ModifyAddressWindowState) => {
		const currentPage = await getPage()
		if ((currentPage.page === 'AddNewAddress' || currentPage.page === 'ModifyAddress') && currentPage.state.windowStateId === parsedRequest.data.windowStateId) {
			await setPage({ page: currentPage.page, state: newState })
		}
	}
	await updatePage(parsedRequest.data.newState)
	const message = await getErrorIfAnyWithIncompleteAddressBookEntry(ethereum, parsedRequest.data.newState.incompleteAddressBookEntry)

	const errorState = message === undefined ? undefined : { blockEditing: true, message }
	if (errorState?.message !== parsedRequest.data.newState.errorState?.message) await updatePage({ ...parsedRequest.data.newState, errorState })
	await sendPopupMessageToOpenWindows({
		method: 'popup_addOrModifyAddressWindowStateInformation',
		data: { windowStateId: parsedRequest.data.windowStateId, errorState: errorState }
	})
}

export async function requestAbiAndNameFromBlockExplorer(parsedRequest: RequestAbiAndNameFromBlockExplorer) {
	const etherscanReply = await fetchAbiFromBlockExplorer(parsedRequest.data.address, parsedRequest.data.chainId)
	if (etherscanReply.success) {
		return {
			method: 'popup_requestAbiAndNameFromBlockExplorer' as const,
			data: {
				success: true,
				abi: etherscanReply.abi,
				contractName: etherscanReply.contractName,
			}
		} as const
	}
	return {
		method: 'popup_requestAbiAndNameFromBlockExplorer' as const,
		data: {
			success: false,
			error: etherscanReply.error
		}
	} as const
}

export async function openWebPage(parsedRequest: OpenWebPage) {
	const allTabs = await browser.tabs.query({})
	const addressBookTab = allTabs.find((tab) => tab.id === parsedRequest.data.websiteSocket.tabId)
	if (addressBookTab === undefined) {
		await browser.tabs.create({ url: parsedRequest.data.url, active: true })
		return
	}
	try {
		await browser.tabs.update(parsedRequest.data.websiteSocket.tabId, { url: parsedRequest.data.url, active: true })
		checkAndThrowRuntimeLastError()
		return
	} catch (error) {
		console.warn('Failed to update tab with new webpage')
		console.warn({ error })
	}
	await browser.tabs.create({ url: parsedRequest.data.url, active: true })
}

export async function setEnsNameForHash(parsedRequest: SetEnsNameForHash) {
	if (parsedRequest.data.type === 'labelHash') {
		await addEnsLabelHash(parsedRequest.data.name)
	} else {
		await addEnsNodeHash(parsedRequest.data.name)
	}
	await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
}

export async function forceSetGasLimitForTransaction(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, parsedRequest: ForceSetGasLimitForTransaction) {
	await setGasLimitForTransaction(parsedRequest.data.transactionIdentifier, parsedRequest.data.gasLimit)
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, true, false)
	await refreshPopupConfirmTransactionSimulation(ethereum, tokenPriceService)
}

export async function changePreSimulationBlockTimeManipulation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, parsedRequest: ChangePreSimulationBlockTimeManipulation) {
	await setPreSimulationBlockTimeManipulation(parsedRequest.data.blockTimeManipulation)
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, true, true)
}

export async function setTransactionOrMessageBlockTimeManipulator(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, parsedRequest: SetTransactionOrMessageBlockTimeManipulator) {
	const newStack = await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
		const normalizedPrevStack = { operations: normalizeConsecutiveTimeManipulations(prevStack.operations) }
		const identifier = parsedRequest.data.transactionOrMessageIdentifier
		const appendAfterIndex = normalizedPrevStack.operations.findIndex((operation) => {
			switch(operation.type) {
				case 'Transaction': return identifier.type === operation.type && identifier.transactionIdentifier === operation.preSimulationTransaction.transactionIdentifier
				case 'Message': return identifier.type === operation.type && identifier.messageIdentifier === operation.signedMessageTransaction.messageIdentifier
				case 'TimeManipulation': return false
				default: return assertNever(operation)
			}
		})
		if (appendAfterIndex < 0) return normalizedPrevStack
		const indexOfMaybeManipulator = appendAfterIndex + 1
		const maybeExistingManipulator = normalizedPrevStack.operations[indexOfMaybeManipulator]
		if (maybeExistingManipulator?.type === 'TimeManipulation') {
			// no delay, so we can remove the manipulator
			if (parsedRequest.data.blockTimeManipulation.type === 'No Delay') return { operations: normalizeConsecutiveTimeManipulations([...normalizedPrevStack.operations.slice(0, indexOfMaybeManipulator), ...normalizedPrevStack.operations.slice(indexOfMaybeManipulator + 1)]) }
			const newManipulator = { type: 'TimeManipulation', blockTimeManipulation: parsedRequest.data.blockTimeManipulation } as const
			// replace manipulator
			return { operations: normalizeConsecutiveTimeManipulations(normalizedPrevStack.operations.map((operation, index) => index === indexOfMaybeManipulator ? newManipulator : operation)) }
		}
		// insert new manipulator
		if (parsedRequest.data.blockTimeManipulation.type === 'No Delay') return normalizedPrevStack
		const newManipulator = { type: 'TimeManipulation', blockTimeManipulation: parsedRequest.data.blockTimeManipulation } as const
		return { operations: normalizeConsecutiveTimeManipulations([...normalizedPrevStack.operations.slice(0, indexOfMaybeManipulator), newManipulator, ...normalizedPrevStack.operations.slice(indexOfMaybeManipulator)]) }
	})
	const secondToLastOperation = newStack.operations[newStack.operations.length - 2]
	if (secondToLastOperation === undefined || secondToLastOperation.type === 'TimeManipulation') {
		await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, true, true)
		return
	}
	const appendIdentifier = parsedRequest.data.transactionOrMessageIdentifier.type === 'Transaction' ? parsedRequest.data.transactionOrMessageIdentifier.transactionIdentifier : parsedRequest.data.transactionOrMessageIdentifier.messageIdentifier
	const operationIdentifier = secondToLastOperation.type === 'Transaction' ? secondToLastOperation.preSimulationTransaction.transactionIdentifier : secondToLastOperation.signedMessageTransaction.messageIdentifier
	const appendedToEnd = appendIdentifier === operationIdentifier
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, !appendedToEnd, true)
}

export async function requestMakeMeRichList(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined) {
	const makeMeRichPromise = silenceChromeUnCaughtPromise(getMakeCurrentAddressRich())
	const fixedAddressRichList = await getFixedAddressRichList()
	const fixedRichListPromises = Array.from(fixedAddressRichList.values()).map(async(element) => {
		try {
			return { ...element, addressBookEntry: await identifyAddress(ethereumClientService, requestAbortController, element.address) }
		} catch (error) {
			if (isExpectedInfrastructureError(error)) throw error
			const address = checksummedAddress(element.address)
			const errorMessage = formatCaughtErrorMessage(error)
			await reportUnexpectedError(error, {
				displayMessage: `Failed to identify rich list address ${ address }: ${ errorMessage }`,
				details: { address, richListEntry: element },
				suppressExpectedInfrastructure: false,
			})
			return {
				...element,
				addressBookEntry: {
					type: 'contact' as const,
					name: address,
					address: element.address,
					entrySource: 'FilledIn' as const,
				}
			}
		}
	})
	return {
		method: 'popup_requestMakeMeRichData' as const,
		richList: await Promise.all(fixedRichListPromises),
		makeCurrentAddressRich: await makeMeRichPromise,
	}
}

export const requestActiveAddresses = async () => ({ method: 'popup_requestActiveAddresses' as const, activeAddresses: await getActiveAddresses() })

export const requestSimulationMode = async () => ({ method: 'popup_requestSimulationMode' as const, simulationMode: (await getSettings()).simulationMode })

export const requestLatestUnexpectedError = async () => ({ method: 'popup_requestLatestUnexpectedError' as const, latestUnexpectedError: await getLatestUnexpectedError() })

async function getCachedRichData() {
	const [makeCurrentAddressRich, fixedAddressRichList] = await Promise.all([
		getMakeCurrentAddressRich(),
		getFixedAddressRichList(),
	])
	return {
		method: 'popup_requestMakeMeRichData' as const,
		richList: await Promise.all(fixedAddressRichList.map(async(element) => (
			{ ...element, addressBookEntry: await getActiveAddressEntry(element.address) }
		))),
		makeCurrentAddressRich,
	}
}

async function getActiveAddressForCurrentPopupSignerState(settings: Settings, websiteTabConnections: WebsiteTabConnections, tabId: number) {
	return await getActiveAddressForCurrentSignerState(websiteTabConnections, settings, tabId, async () => await getActiveOrFirstSignerAddress(settings, tabId))
}

async function buildHomePageUpdate(
	ethereum: EthereumClientService,
	websiteTabConnections: WebsiteTabConnections,
	{
		requestAbortController,
		richDataSource,
		shouldRefreshSignerAccounts,
		includeWebsiteAccessAddressMetadata,
		popupRefreshGeneration,
	}: {
		requestAbortController?: AbortController
		richDataSource: 'cached' | 'fresh'
		shouldRefreshSignerAccounts: boolean
		includeWebsiteAccessAddressMetadata: boolean
		popupRefreshGeneration: number
	}
): Promise<UpdateHomePage> {
	const settingsPromise = silenceChromeUnCaughtPromise(getSettings())
	const rpcConnectionStatusPromise = silenceChromeUnCaughtPromise(getRpcConnectionStatus())
	const rpcEntriesPromise = silenceChromeUnCaughtPromise(getRpcList())
	const preSimulationBlockTimeManipulationPromise = silenceChromeUnCaughtPromise(getPreSimulationBlockTimeManipulation())
	const visualizedSimulatorStatePromise: Promise<CompleteVisualizedSimulation> = silenceChromeUnCaughtPromise(getPopupVisualisationState())
	const activeAddressesPromise = silenceChromeUnCaughtPromise(getActiveAddresses())
	const latestUnexpectedErrorPromise = silenceChromeUnCaughtPromise(getLatestUnexpectedError())
	const richDataPromise = silenceChromeUnCaughtPromise(
		richDataSource === 'fresh'
			? requestMakeMeRichList(ethereum, requestAbortController)
			: getCachedRichData()
	)
	const hasSafeTransactionsToExportPromise = silenceChromeUnCaughtPromise(getSafeTransactionStacks().then((stacks) => stacks.some((stack) =>
		stack.chainId === ethereum.getChainId() && stack.transactions.length > 0
	)))
	const tabId = await getLastKnownCurrentTabId()
	const tabStatePromise = silenceChromeUnCaughtPromise(tabId === undefined ? getTabState(-1) : getTabState(tabId))
	const settings = await settingsPromise
	let tabState = await tabStatePromise
	tabState = await refreshSignerAccountsForTabIfNeeded(websiteTabConnections, tabId, tabState, shouldRefreshSignerAccounts)
	const activeSigningAddress = tabId === undefined ? undefined : (await getActiveAddressForCurrentPopupSignerState(settings, websiteTabConnections, tabId))?.address
	const walletSelectedAddressBookEntry = await getWalletSelectedAddressBookEntry(tabState, settings.activeRpcNetwork.chainId)
	const interceptorDisabled = isInterceptorDisabledForWebsite(settings, tabState.website?.websiteOrigin)
	const richData = await richDataPromise
	const websiteAccessAddressMetadata = includeWebsiteAccessAddressMetadata ? await getAddressMetadataForAccess(settings.websiteAccess) : []
	return {
		method: 'popup_UpdateHomePage' as const,
		homeDataSource: richDataSource,
		popupRefreshGeneration: popupRefreshGeneration,
		data: {
			visualizedSimulatorState: await visualizedSimulatorStatePromise,
			activeAddresses: await activeAddressesPromise,
			walletSelectedAddressBookEntry,
			richList: richData.richList,
			makeCurrentAddressRich: richData.makeCurrentAddressRich,
			hasSafeTransactionsToExport: await hasSafeTransactionsToExportPromise,
			latestUnexpectedError: await latestUnexpectedErrorPromise,
			websiteAccessAddressMetadata,
			tabState,
			activeSigningAddressInThisTab: activeSigningAddress,
			currentBlockNumber: ethereum.getCachedBlock()?.number,
			settings,
			rpcConnectionStatus: await rpcConnectionStatusPromise,
			tabId,
			rpcEntries: await rpcEntriesPromise,
			interceptorDisabled,
			preSimulationBlockTimeManipulation: await preSimulationBlockTimeManipulationPromise,
		}
	}
}

export async function fetchSimulationStackRequestConfirmation(ethereumClientService: EthereumClientService, websiteTabConnections: WebsiteTabConnections, confirmation: FetchSimulationStackRequestConfirmation) {
	const pendingRequest = await getFetchSimulationStackRequestPromise()
	if (pendingRequest === undefined) throw new Error('The pending simulation stack request is unavailable.')
	const snapshot = await getUpdatedSimulationStackSnapshot(ethereumClientService, pendingRequest.simulationOverlayEnabled)
	await resolveFetchSimulationStackRequest(snapshot, websiteTabConnections, confirmation)
}

export async function reportUnexpectedErrorInWindow(parsedRequest: UnexpectedErrorOccured) {
	await reportUnexpectedError(parsedRequest.data.message, {
		displayMessage: parsedRequest.data.message,
		source: parsedRequest.data.source,
		code: parsedRequest.data.code,
		debugId: parsedRequest.data.debugId,
		details: parsedRequest.data,
		suppressExpectedInfrastructure: false,
	})
}

export async function requestInterceptorSimulationInput(ethereumClientService: EthereumClientService) {
	const stack = await getInterceptorTransactionStack()
	if (stack.operations.some((operation) =>
		operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction !== undefined
	)) {
		return {
			method: 'popup_requestInterceptorSimulationInput' as const,
			ok: false as const,
			message: 'The simulation stack contains Gnosis Safe proposals, which require the synchronized Gnosis Safe export format. Use Copy Gnosis Safe transactions for those proposals, or remove them before using Export simulation for the remaining operations.',
		}
	}
	const simulationInput = await getCurrentSimulationInput()
	const currentBlockNumberPromise = silenceChromeUnCaughtPromise(ethereumClientService.getBlockNumber(undefined))
	const eth_simulateV1 = await ethereumClientService.ethSimulateV1Input(simulationInput, await currentBlockNumberPromise, undefined)

	const interceptorSimulateStack = modifyObject(stack, { operations: stack.operations.map((operation) => {
		switch(operation.type) {
			case 'Message': return modifyObject(operation, { signedMessageTransaction: modifyObject(operation.signedMessageTransaction, { website: { ...operation.signedMessageTransaction.website, icon: undefined, title: undefined } }) })
			case 'TimeManipulation': return operation
			case 'Transaction': return modifyObject(operation, { preSimulationTransaction: modifyObject(operation.preSimulationTransaction, { website: { ...operation.preSimulationTransaction.website, icon: undefined, title: undefined } }) })
			default: return assertNever(operation)
		}
	}) })
	return { method: 'popup_requestInterceptorSimulationInput' as const, ok: true as const, ethSimulateV1InputString:
		JSON.stringify(
			InterceptorSimulationExport.serialize({
				name: 'Interceptor Simulation Export',
				version: '1.0.0',
				eth_simulateV1,
				interceptorSimulateStack,
			})
		, null, '\t')
	}
}

export async function importSimulationStack(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, parsedRequest: ImportSimulationStack): Promise<ImportSimulationStackReply> {
	if (parsedRequest.data.version !== '1.0.0') return importSimulationStackFailure('Only simulation stack export version 1.0.0 is supported.')
	if (parsedRequest.data.interceptorSimulateStack.operations.length === 0) return importSimulationStackSuccess()
	if (parsedRequest.data.interceptorSimulateStack.operations.some((operation) =>
		operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction !== undefined
	)) {
		return importSimulationStackFailure('Gnosis Safe transactions cannot be imported through simulation stack import. Use Import Gnosis Safe so Gnosis Safe proposals and signatures remain synchronized.')
	}

	const importedStackBytes = estimateSerializedStateBytes(InterceptorTransactionStack, parsedRequest.data.interceptorSimulateStack)
	console.info(`[simulation-stack import] received ${ parsedRequest.data.interceptorSimulateStack.operations.length } operations (${ formatEstimatedBytes(importedStackBytes) }).`)

	const websiteAccess = await getWebsiteAccess()
	const updateWebsiteDetails = (website: Website) => {
		const websiteData = websiteAccess.find((access) => access.website.websiteOrigin === website.websiteOrigin)?.website
		return websiteData ?? website
	}

	let updatedStack: InterceptorTransactionStack
	try {
		updatedStack = await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
			const newOperations = [...prevStack.operations, ...parsedRequest.data.interceptorSimulateStack.operations]
			// generate new ids for operations to prevent duplicated ids
			return { operations: normalizeConsecutiveTimeManipulations(newOperations.map((operation) => {
				switch(operation.type) {
					case 'Message': return modifyObject(operation, { signedMessageTransaction: modifyObject(operation.signedMessageTransaction, { messageIdentifier: generate256BitRandomBigInt(), website: updateWebsiteDetails(operation.signedMessageTransaction.website) }) })
					case 'TimeManipulation': return operation
					case 'Transaction': return modifyObject(operation, { preSimulationTransaction: modifyObject(operation.preSimulationTransaction, { transactionIdentifier: generate256BitRandomBigInt(), website: updateWebsiteDetails(operation.preSimulationTransaction.website) }) })
					default: return assertNever(operation)
				}
			})) }
		})
	} catch (error) {
		return importSimulationStackFailure(`Failed to store the imported simulation stack (${ formatEstimatedBytes(importedStackBytes) }): ${ formatCaughtErrorMessage(error) }`)
	}

	const updatedStackBytes = estimateSerializedStateBytes(InterceptorTransactionStack, updatedStack)
	console.info(`[simulation-stack import] persisted transaction stack at ${ formatEstimatedBytes(updatedStackBytes) }.`)

	try {
		await updatePopupVisualisationState(ethereum, tokenPriceService, undefined, true)
		const popupVisualisation = await getPopupVisualisationState()
		const popupVisualisationBytes = estimateSerializedStateBytes(CompleteVisualizedSimulation, popupVisualisation)
		console.info(`[simulation-stack import] persisted popup visualisation at ${ formatEstimatedBytes(popupVisualisationBytes) }.`)
	} catch (error) {
		return importSimulationStackFailure(`Imported stack was stored (${ formatEstimatedBytes(updatedStackBytes) }), but updating the visualized simulation failed: ${ formatCaughtErrorMessage(error) }`)
	}

	return importSimulationStackSuccess()
}

export async function requestCompleteVisualizedSimulation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	const visualizedSimulatorState = await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, false, false, true)
	return { method: 'popup_requestCompleteVisualizedSimulation' as const, visualizedSimulatorState }
}

export async function requestSimulationMetadata(ethereumClientService: EthereumClientService) {
	const settings = await getSettings()
	const simulationState = settings.simulationMode ? await getUpdatedSimulationState(ethereumClientService) : { kind: 'passthrough' as const }
	if (simulationState.kind === 'passthrough' || simulationState.value.success === false) return {
		method: 'popup_requestSimulationMetadata' as const,
		metadata: {
			namedTokenIds: [], addressBookEntries: [], ens: { ensNameHashes: [], ensLabelHashes: [] }
		}
	}
	const eventsForEachBlockAndTransactionPromise = silenceChromeUnCaughtPromise(Promise.all(
		simulationState.value.simulatedBlocks.map((block) =>
			Promise.all(block.simulatedTransactions.map(
				async (simulatedTransaction) => simulatedTransaction.ethSimulateV1CallResult.status === 'failure' ? [] : await parseEvents(simulatedTransaction.ethSimulateV1CallResult.logs, ethereumClientService, undefined)
			))
		)
	))
	const parsedInputDataForEachBlockAndTransactionPromise = silenceChromeUnCaughtPromise(Promise.all(
		simulationState.value.simulatedBlocks.map((block) => {
			const transactions = getWebsiteCreatedEthereumTransactions(block.simulatedTransactions)
			return Promise.all(transactions.map((transaction) =>
				parseInputData({ to: transaction.transaction.to, input: transaction.transaction.input, value: transaction.transaction.value }, ethereumClientService, undefined)
			))
		})
	))
	const events = (await eventsForEachBlockAndTransactionPromise).flat()
	const inputData = (await parsedInputDataForEachBlockAndTransactionPromise).flat()

	const metadata = await getMetadataForSimulation(simulationState.value, ethereumClientService, undefined, events, inputData)
	return { method: 'popup_requestSimulationMetadata' as const, metadata }
}

export async function requestIdentifyAddress(ethereumClientService: EthereumClientService, parsedRequest: RequestIdentifyAddress) {
	const requestedChainId = parsedRequest.data.chainId
	const addressBookEntry = requestedChainId === 'AllChains' || requestedChainId !== ethereumClientService.getChainId()
		? undefined
		: await identifyAddress(ethereumClientService, undefined, parsedRequest.data.address)
	return { method: 'popup_requestIdentifyAddress' as const, data: { chainId: requestedChainId, addressBookEntry } }
}
