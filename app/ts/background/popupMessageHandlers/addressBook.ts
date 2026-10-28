import { createSafeContractValidationFailure, validateSafeOwnerIsEoa } from '../../safe/safeCore.js'
import { isValidAbi, fetchAbiFromBlockExplorer } from '../../simulation/services/EtherScanAbiFetcher.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import { doAddressBookChainIdsMatch, type AddressBookEntry, type IncompleteAddressBookEntry } from '../../types/addressBookTypes.js'
import type { AddOrEditAddressBookEntry, ChangeAddOrModifyAddressWindowState, GetAddressBookData, RemoveAddressBookEntry, SetEnsNameForHash } from '../../types/interceptor-messages.js'
import type { RequestAbiAndNameFromBlockExplorer, RequestIdentifyAddress } from '../../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import type { ModifyAddressWindowState } from '../../types/visualizer-types.js'
import { EthereumAddress } from '../../types/wire-types.js'
import { getIssueWithAddressString } from '../../utils/addressValidation.js'
import { stringToAddress } from '../../utils/bigint.js'
import { getErrorMessage, isExpectedInfrastructureError, reportUnexpectedError } from '../../utils/errors.js'
import { isAddress } from '../../utils/ethereumPrimitives.js'
import { isJSON } from '../../utils/json.js'
import { sendPopupMessageToOpenWindows } from '../backgroundUtils.js'
import { findEntryWithSymbolOrName, getMetadataForAddressBookData } from '../metadataSearch.js'
import { identifyAddress } from '../metadataUtils.js'
import { getPage, setPage, getSettings } from '../settings.js'
import { addEnsLabelHash, addEnsNodeHash, updateUserAddressBookEntries } from '../storageVariables.js'
import { updateWebsiteApprovalAccesses } from '../accessManagement.js'

export async function removeAddressBookEntry(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, removeAddressBookEntry: RemoveAddressBookEntry) {
	await updateUserAddressBookEntries((previousContacts) => previousContacts.filter((contact) =>
		!(contact.address === removeAddressBookEntry.data.address
		&& (contact.chainId === removeAddressBookEntry.data.chainId || (contact.chainId === undefined && removeAddressBookEntry.data.chainId === 1n))))
	)
	if (removeAddressBookEntry.data.addressBookCategory === 'My Active Addresses' || removeAddressBookEntry.data.addressBookCategory === 'My Safes') {
		await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true)
	}
	await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
}

export async function addOrModifyAddressBookEntry(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, entry: AddOrEditAddressBookEntry) {
	const { ethereum } = simulationServicesOwner.getCurrent()
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
				const safeSimulationSignerAddress = entry.data.safeSimulationSignerAddress
				if (safeSimulationSignerAddress === undefined) {
					throw createSafeContractValidationFailure('Select a current Gnosis Safe owner for simulation.')
				}
				const { snapshot: { state: safeState } } = await validateSafeOwnerIsEoa(ethereum, entry.data.address, safeSimulationSignerAddress)
				entryToStore = {
					...entry.data,
					safeSimulationSignerAddress,
					safeSignerAddresses: [...safeState.owners],
					safeVersion: safeState.version,
				}
			} catch(error) {
				await reportUnexpectedError(error, {
					source: 'address_book_safe_validation',
					code: 'address_book_safe_validation_failed',
					displayMessage: 'Failed to validate the Gnosis Safe address.',
				})
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
		if (entryToStore.useAsActiveAddress) await updateWebsiteApprovalAccesses(simulationServicesOwner, websiteTabConnections, await getSettings(), true, true)
		void sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
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

export async function setEnsNameForHash(parsedRequest: SetEnsNameForHash) {
	if (parsedRequest.data.type === 'labelHash') {
		await addEnsLabelHash(parsedRequest.data.name)
	} else {
		await addEnsNodeHash(parsedRequest.data.name)
	}
	await sendPopupMessageToOpenWindows({ method: 'popup_addressBookEntriesChanged' })
}

export async function requestIdentifyAddress(ethereumClientService: EthereumClientService, parsedRequest: RequestIdentifyAddress) {
	const requestedChainId = parsedRequest.data.chainId
	const addressBookEntry = requestedChainId === 'AllChains' || requestedChainId !== ethereumClientService.getChainId()
		? undefined
		: await identifyAddress(ethereumClientService, undefined, parsedRequest.data.address)
	return { method: 'popup_requestIdentifyAddress' as const, data: { chainId: requestedChainId, addressBookEntry } }
}
