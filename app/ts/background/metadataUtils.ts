import { addressString, checksummedAddress } from '../utils/bigint.js'
import { ActiveAddressEntry, AddressBookEntry } from '../types/addressBookTypes.js'
import { NamedTokenId, SimulationState, VisualizerResult } from '../types/visualizer-types.js'
import { tokenMetadata, contractMetadata, erc721Metadata, erc1155Metadata } from '@darkflorist/address-metadata'
import { ethers } from 'ethers'
import { ETHEREUM_COIN_ICON, ETHEREUM_LOGS_LOGGER_ADDRESS, MOCK_ADDRESS } from '../utils/constants.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { IdentifiedAddress, itentifyAddressViaOnChainInformation } from '../utils/tokenIdentification.js'
import { assertNever } from '../utils/typescript.js'
import { addUserAddressBookEntryIfItDoesNotExist, getUserAddressBookEntries } from './storageVariables.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { EthereumNameServiceTokenWrapper, getEthereumNameServiceNameFromTokenId } from '../utils/ethereumNameService.js'
import { defaultActiveAddresses } from './settings.js'
import { RpcNetwork } from '../types/rpc.js'
export const LOGO_URI_PREFIX = `../vendor/@darkflorist/address-metadata`

const pathJoin = (parts: string[], sep = '/') => parts.join(sep).replace(new RegExp(sep + '{1,}', 'g'), sep)

export const getFullLogoUri = (logoURI: string) => pathJoin([LOGO_URI_PREFIX, logoURI])

export async function getActiveAddressEntry(address: bigint) : Promise<ActiveAddressEntry> {
	const identifiedAddress = await identifyAddressWithoutNode(address, undefined)
	if (identifiedAddress !== undefined && identifiedAddress.type === 'activeAddress') return identifiedAddress
	return {
		type: 'activeAddress' as const,
		name: checksummedAddress(address),
		address: address,
		askForAddressAccess: false,
		entrySource: 'FilledIn'
	}
}

export async function getActiveAddresses() : Promise<readonly ActiveAddressEntry[]> {
	const activeAddresses = (await getUserAddressBookEntries()).filter((entry): entry is ActiveAddressEntry => entry.type === 'activeAddress')
	return activeAddresses === undefined || activeAddresses.length === 0? defaultActiveAddresses : activeAddresses
}
async function identifyAddressWithoutNode(address: bigint, rpcEntry: RpcNetwork | undefined, useLocalStorage: boolean = true) : Promise<AddressBookEntry | undefined> {
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

export async function identifyAddress(ethereumClientService: EthereumClientService, address: bigint, useLocalStorage: boolean = true) : Promise<AddressBookEntry> {
	const identifiedAddress = await identifyAddressWithoutNode(address, ethereumClientService.getRpcEntry(), useLocalStorage)
	if (identifiedAddress !== undefined) return identifiedAddress
	const addrString = addressString(address)
	const tokenIdentification = await itentifyAddressViaOnChainInformation(ethereumClientService, address)
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

export async function getAddressBookEntriesForVisualiser(ethereumClientService: EthereumClientService, visualizerResults: readonly (VisualizerResult | undefined)[], simulationState: SimulationState): Promise<AddressBookEntry[]> {
	let addressesToFetchMetadata: bigint[] = []

	for (const visualizerResult of visualizerResults) {
		if (visualizerResult === undefined) continue
		const ethBalanceAddresses = visualizerResult.ethBalanceChanges.map((change) => change.address)
		const eventArguments = visualizerResult.events.map((event) => event.type !== 'NonParsed' ? event.args : []).flat()
		const addressesInEvents = eventArguments.map((event) => { 
			if (event.typeValue.type === 'address') return event.typeValue.value
			if (event.typeValue.type === 'address[]') return event.typeValue.value
			return undefined
		}).flat().filter((address): address is bigint => address !== undefined)
		addressesToFetchMetadata = addressesToFetchMetadata.concat(ethBalanceAddresses, addressesInEvents, visualizerResult.events.map((event) => event.loggersAddress))
	}

	simulationState.simulatedTransactions.forEach((tx) => {
		addressesToFetchMetadata.push(tx.signedTransaction.from)
		if (tx.signedTransaction.to !== null) addressesToFetchMetadata.push(tx.signedTransaction.to)
	})

	const deDuplicated = new Set<bigint>(addressesToFetchMetadata)
	const addressIdentificationPromises: Promise<AddressBookEntry>[] = Array.from(deDuplicated.values()).map((address) => identifyAddress(ethereumClientService, address))

	return await Promise.all(addressIdentificationPromises)
}

export async function nameTokenIds(ethereumClientService: EthereumClientService, visualizerResult: readonly (VisualizerResult | undefined)[]) {
	type TokenAddressTokenIdPair = {
		tokenAddress: bigint
		tokenId: bigint
	}
	let tokenAddresses: TokenAddressTokenIdPair[] = visualizerResult.map((visualizerResult) => {
		if (visualizerResult === undefined) return undefined
		return visualizerResult.events.map((event) => { 
			if (event.type !== 'TokenEvent' || event.tokenInformation.type !== 'ERC1155') return undefined
			return { tokenAddress: event.tokenInformation.tokenAddress, tokenId: event.tokenInformation.tokenId }
		})
	}).flat().filter((pair): pair is TokenAddressTokenIdPair => pair !== undefined)

	const pairs = getUniqueItemsByProperties(tokenAddresses, ['tokenAddress', 'tokenId'])
	const namedPairs = (await Promise.all(pairs.map(async (pair) => {
		if (pair.tokenAddress === EthereumNameServiceTokenWrapper && ethereumClientService.getChainId() === 1n) {
			const tokenIdName = await getEthereumNameServiceNameFromTokenId(ethereumClientService, pair.tokenId)
			if (tokenIdName === undefined) return undefined
			return { ...pair, tokenIdName }
		}
		return undefined
	}))).filter((pair): pair is NamedTokenId => pair !== undefined)
	return namedPairs
}
