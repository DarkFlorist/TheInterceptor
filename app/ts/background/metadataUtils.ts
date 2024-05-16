import { addressString, checksummedAddress } from '../utils/bigint.js'
import { AddressBookEntries, AddressBookEntry } from '../types/addressBookTypes.js'
import { EnrichedEthereumEventWithMetadata, EnrichedEthereumEvents, NamedTokenId, SimulationState, TokenEvent, TokenVisualizerResultWithMetadata } from '../types/visualizer-types.js'
import { tokenMetadata, contractMetadata, erc721Metadata, erc1155Metadata } from '@darkflorist/address-metadata'
import { ethers } from 'ethers'
import { ENS_TOKEN_WRAPPER, ETHEREUM_COIN_ICON, ETHEREUM_LOGS_LOGGER_ADDRESS, MOCK_ADDRESS } from '../utils/constants.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { IdentifiedAddress, itentifyAddressViaOnChainInformation } from '../utils/tokenIdentification.js'
import { assertNever } from '../utils/typescript.js'
import { addEnsLabelHash, addEnsNodeHash, addUserAddressBookEntryIfItDoesNotExist, getEnsLabelHashes, getEnsNodeHashes, getUserAddressBookEntries } from './storageVariables.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { getEthereumNameServiceNameFromTokenId } from '../utils/ethereumNameService.js'
import { defaultActiveAddresses } from './settings.js'
import { RpcNetwork } from '../types/rpc.js'
import { EthereumBytes32 } from '../types/wire-types.js'
const LOGO_URI_PREFIX = '../vendor/@darkflorist/address-metadata'

const pathJoin = (parts: string[], sep = '/') => parts.join(sep).replace(new RegExp(sep + '{1,}', 'g'), sep)

export const getFullLogoUri = (logoURI: string) => pathJoin([LOGO_URI_PREFIX, logoURI])

export async function getActiveAddressEntry(address: bigint): Promise<AddressBookEntry> {
	const identifiedAddress = await identifyAddressWithoutNode(address, undefined)
	if (identifiedAddress !== undefined && identifiedAddress.useAsActiveAddress) return identifiedAddress
	return {
		type: 'contact' as const,
		name: checksummedAddress(address),
		useAsActiveAddress: true,
		address: address,
		askForAddressAccess: true,
		entrySource: 'FilledIn'
	}
}

export async function getActiveAddresses() : Promise<AddressBookEntries> {
	const activeAddresses = (await getUserAddressBookEntries()).filter((entry) => entry.useAsActiveAddress)
	return activeAddresses === undefined || activeAddresses.length === 0 ? defaultActiveAddresses : activeAddresses
}
async function identifyAddressWithoutNode(address: bigint, rpcEntry: RpcNetwork | undefined, useLocalStorage = true) : Promise<AddressBookEntry | undefined> {
	if (address === ETHEREUM_LOGS_LOGGER_ADDRESS) return {
		address: ETHEREUM_LOGS_LOGGER_ADDRESS,
		name: rpcEntry?.currencyName ?? 'Ethereum',
		type: 'ERC20',
		entrySource: 'Interceptor',
		symbol: rpcEntry?.currencyTicker ?? 'ETH',
		decimals: 18n,
		logoUri: rpcEntry !== undefined && 'currencyLogoUri' in rpcEntry ? rpcEntry.currencyLogoUri : ETHEREUM_COIN_ICON,
	}

	if (useLocalStorage) {
		const userEntry = (await getUserAddressBookEntries()).find((entry) => entry.address === address)
		if (userEntry !== undefined) return userEntry
	}
	const addrString = addressString(address)
	const addressData = contractMetadata.get(addrString)
	if (addressData) return {
		...addressData,
		address: address,
		logoUri: addressData.logoUri ? `${ getFullLogoUri(addressData.logoUri) }` : undefined,
		type: 'contract',
		entrySource: 'DarkFloristMetadata',
	}

	const tokenData = tokenMetadata.get(addrString)
	if (tokenData) return {
		...tokenData,
		address: address,
		logoUri: tokenData.logoUri ? `${ getFullLogoUri(tokenData.logoUri) }` : undefined,
		type: 'ERC20',
		entrySource: 'DarkFloristMetadata',
	}

	const erc721TokenData = erc721Metadata.get(addrString)
	if (erc721TokenData) return {
		...erc721TokenData,
		address: address,
		logoUri: erc721TokenData.logoUri ? `${ getFullLogoUri(erc721TokenData.logoUri) }` : undefined,
		type: 'ERC721',
		entrySource: 'DarkFloristMetadata',
	}

	const erc1155TokenData = erc1155Metadata.get(addrString)
	if (erc1155TokenData) return {
		...erc1155TokenData,
		address: address,
		logoUri: erc1155TokenData.logoUri ? `${ getFullLogoUri(erc1155TokenData.logoUri) }` : undefined,
		type: 'ERC1155',
		entrySource: 'DarkFloristMetadata',
		decimals: undefined,
	}

	if (address === MOCK_ADDRESS) return {
		address: address,
		name: 'Ethereum Validator',
		logoUri: '../../img/contracts/rhino.png',
		type: 'contact',
		entrySource: 'Interceptor',
	}
	if (address === 0n) return {
		address: address,
		name: '0x0 Address',
		type: 'contact',
		entrySource: 'Interceptor',
	}
	return undefined
}

export async function identifyAddress(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, address: bigint, useLocalStorage = true) : Promise<AddressBookEntry> {
	const identifiedAddress = await identifyAddressWithoutNode(address, ethereumClientService.getRpcEntry(), useLocalStorage)
	if (identifiedAddress !== undefined) return identifiedAddress
	const addrString = addressString(address)
	const tokenIdentification = await itentifyAddressViaOnChainInformation(ethereumClientService, requestAbortController, address)
	const getEntry = (tokenIdentification: IdentifiedAddress) => {
		switch (tokenIdentification.type) {
			case 'ERC20': return {
				name: tokenIdentification.name,
				address,
				symbol: tokenIdentification.symbol,
				decimals: tokenIdentification.decimals,
				type: 'ERC20' as const,
				entrySource: 'OnChain' as const,
			}
			case 'ERC1155': return {
				name: ethers.getAddress(addrString),
				address,
				symbol: '???',
				type: 'ERC1155' as const,
				decimals: undefined,
				entrySource: 'OnChain' as const,
			}
			case 'ERC721': return {
				name: tokenIdentification.name,
				address,
				symbol: tokenIdentification.symbol,
				type: 'ERC721' as const,
				entrySource: 'OnChain' as const,
			}
			case 'contract': return {
				address,
				name: ethers.getAddress(addrString),
				type: 'contract' as const,
				entrySource: 'OnChain' as const,
			}
			case 'EOA': return {
				address,
				name: ethers.getAddress(addrString),
				type: 'contact' as const,
				entrySource: 'OnChain' as const,
			}
			default: assertNever(tokenIdentification)
		}
	}
	const entry = getEntry(tokenIdentification)
	if (useLocalStorage) await addUserAddressBookEntryIfItDoesNotExist(entry)
	return entry
}

export async function getAddressBookEntriesForVisualiser(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, events: EnrichedEthereumEvents, simulationState: SimulationState): Promise<AddressBookEntry[]> {
	const eventArguments = events.flatMap((event) => event.type !== 'NonParsed' ? event.args : [])
	const addressesInEvents = eventArguments.flatMap((event) => {
		if (event.typeValue.type === 'address') return event.typeValue.value
		if (event.typeValue.type === 'address[]') return event.typeValue.value
		return undefined
	}).filter((address): address is bigint => address !== undefined)
	const addressesToFetchMetadata = [...addressesInEvents, ...events.map((event) => event.address)]

	for (const tx of simulationState.simulatedTransactions) {
		addressesToFetchMetadata.push(tx.signedTransaction.from)
		if (tx.signedTransaction.to !== null) addressesToFetchMetadata.push(tx.signedTransaction.to)
	}

	const deDuplicated = new Set<bigint>([...addressesToFetchMetadata, ETHEREUM_LOGS_LOGGER_ADDRESS])
	const addressIdentificationPromises: Promise<AddressBookEntry>[] = Array.from(deDuplicated.values()).map((address) => identifyAddress(ethereumClientService, requestAbortController, address))

	return await Promise.all(addressIdentificationPromises)
}

export async function nameTokenIds(ethereumClientService: EthereumClientService, events: EnrichedEthereumEvents) {
	type TokenAddressTokenIdPair = { tokenAddress: bigint, tokenId: bigint }
	const tokenAddresses = events.map((event) => {
		if (event.type !== 'TokenEvent' || event.logInformation.type !== 'ERC1155') return undefined
		return { tokenAddress: event.logInformation.tokenAddress, tokenId: event.logInformation.tokenId }
	}).filter((pair): pair is TokenAddressTokenIdPair => pair !== undefined)

	const pairs = getUniqueItemsByProperties(tokenAddresses, ['tokenAddress', 'tokenId'])
	const namedPairs = (await Promise.all(pairs.map(async (pair) => {
		if (pair.tokenAddress === ENS_TOKEN_WRAPPER && ethereumClientService.getChainId() === 1n) {
			const tokenIdName = (await getAndCacheEnsNodeHash(ethereumClientService, pair.tokenId)).name
			if (tokenIdName === undefined) return undefined
			return { ...pair, tokenIdName }
		}
		return undefined
	}))).filter((pair): pair is NamedTokenId => pair !== undefined)
	return namedPairs
}

export const extractTokenEvents = (events: readonly EnrichedEthereumEventWithMetadata[]): readonly TokenVisualizerResultWithMetadata[] =>{
	return events.filter((tokenEvent): tokenEvent is TokenEvent => tokenEvent.type === 'TokenEvent').map((token) => token.logInformation)
}

export async function retrieveEnsNodeHashes(ethereumClientService: EthereumClientService, events: EnrichedEthereumEvents) {
	const hashes = events.map((event) => event.type === 'ENSAddrChanged' || event.type === 'ENSAddressChanged' ? event.logInformation.node : undefined).filter((maybeNodeHash): maybeNodeHash is bigint => maybeNodeHash !== undefined)
	const deduplicatedHashes = Array.from(new Set(hashes))
	return await Promise.all(deduplicatedHashes.map((hash) => getAndCacheEnsNodeHash(ethereumClientService, hash)))
}

export async function retrieveEnsLabelHashes(events: EnrichedEthereumEvents) {
	const labelHashesToRetrieve = events.map((event) => event.type === 'ENSNameRenewed' || event.type === 'ENSRegistrarNameRenewed' ? event.logInformation.labelHash : undefined).filter((labelHash): labelHash is bigint => labelHash !== undefined)
	const newLabels = events.map((event) => event.type === 'ENSRegistrarNameRenewed' ? event.logInformation.name : undefined).filter((label): label is string => label !== undefined)
	
	// update the maping if we have new labels
	const deduplicatedLabels = Array.from(new Set(newLabels))
	await Promise.all(deduplicatedLabels.map(async (label) => await addEnsLabelHash(label)))
	
	// return the label hashes that we have now available
	const currentLabelHashes = await getEnsLabelHashes()
	return Array.from(new Set(labelHashesToRetrieve)).map((labelHash) => {
		const found = currentLabelHashes.find((entry) => entry.labelHash === labelHash)
		return { labelHash, label: found?.label }
	})
}

export const getAndCacheEnsNodeHash = async (ethereumClientService: EthereumClientService, ensNameHash: EthereumBytes32) => {
	const currentHashes = await getEnsNodeHashes()
	const entry = currentHashes.find((entry) => entry.nameHash === ensNameHash)
	if (entry !== undefined) return entry
	const name = await getEthereumNameServiceNameFromTokenId(ethereumClientService, undefined, ensNameHash)
	if (name !== undefined) { // 
		const [label, _] = name.split('.')
		if (label !== undefined) await addEnsLabelHash(label)
		await addEnsNodeHash(name)
	}
	return { nameHash: ensNameHash, name }
}
