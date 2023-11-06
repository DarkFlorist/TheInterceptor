import { addressString, checksummedAddress } from '../utils/bigint.js'
import { ActiveAddress, ActiveAddressEntry, AddressBookEntry, UserAddressBook } from '../types/addressBookTypes.js'
import { NamedTokenId, SimulationState, VisualizerResult } from '../types/visualizer-types.js'
import { tokenMetadata, contractMetadata, erc721Metadata, erc1155Metadata } from '@darkflorist/address-metadata'
import { ethers } from 'ethers'
import { MOCK_ADDRESS } from '../utils/constants.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { itentifyAddressViaOnChainInformation } from '../utils/tokenIdentification.js'
import { assertNever } from '../utils/typescript.js'
import { getUserAddressBookEntries } from './storageVariables.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { EthereumNameServiceTokenWrapper, getEthereumNameServiceNameFromTokenId } from '../utils/ethereumNameService.js'
import { EthereumAddress } from '../types/wire-types.js'
export const LOGO_URI_PREFIX = `../vendor/@darkflorist/address-metadata`

const pathJoin = (parts: string[], sep = '/') => parts.join(sep).replace(new RegExp(sep + '{1,}', 'g'), sep)

export const getFullLogoUri = (logoURI: string) => pathJoin([LOGO_URI_PREFIX, logoURI])

export function getActiveAddressEntry(address: bigint, activeAddresses: readonly ActiveAddress[] | undefined) : ActiveAddressEntry {
	if (activeAddresses !== undefined) {
		const entry = activeAddresses.find((entry) => entry.address === address)
		if (entry !== undefined) return { ...entry, type: 'activeAddress', entrySource: 'User' }
	}
	return {
		type: 'activeAddress' as const,
		name: checksummedAddress(address),
		address: address,
		askForAddressAccess: false,
		entrySource: 'FilledIn'
	}
}

// todo, add caching here, if we find new address, store it
export async function identifyAddress(ethereumClientService: EthereumClientService, userAddressBook: UserAddressBook, address: bigint, useLocalStorage: boolean = true) : Promise<AddressBookEntry> {
	const activeAddress = userAddressBook.activeAddresses.find((entry) => entry.address === address)
	if (activeAddress !== undefined) return { ...activeAddress, type: 'activeAddress', entrySource: 'User' }

	const contact = userAddressBook.contacts.find((entry) => entry.address === address)
	if (contact !== undefined) return { ...contact, type: 'contact', entrySource: 'User' }

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

	const tokenIdentification = await itentifyAddressViaOnChainInformation(ethereumClientService, address)

	switch(tokenIdentification.type) {
		case 'ERC20': return {
			name: tokenIdentification.name,
			address: BigInt(addrString),
			symbol: tokenIdentification.symbol,
			decimals: tokenIdentification.decimals,
			type: 'ERC20',
			entrySource: 'OnChain',
		}
		case 'ERC1155': return {
			name: ethers.getAddress(addrString),
			address: BigInt(addrString),
			symbol: '???',
			type: 'ERC1155',
			decimals: undefined,
			entrySource: 'OnChain',
		}
		case 'ERC721': return {
			name: tokenIdentification.name,
			address: BigInt(addrString),
			symbol: tokenIdentification.symbol,
			type: 'ERC721',
			entrySource: 'OnChain',
		}
		case 'contract': return {
			address: address,
			name: ethers.getAddress(addrString),
			type: 'contract',
			entrySource: 'OnChain',
		}
		case 'EOA': return {
			address: address,
			name: ethers.getAddress(addrString),
			type: 'contact',
			entrySource: 'OnChain',
		}
		default: assertNever(tokenIdentification)
	}
}

export async function getAddressBookEntriesForVisualiser(ethereumClientService: EthereumClientService, visualizerResult: readonly (VisualizerResult | undefined)[], simulationState: SimulationState, userAddressBook: UserAddressBook) : Promise<AddressBookEntry[]> {
	let addressesToFetchMetadata: bigint[] = []

	for (const vis of visualizerResult) {
		if (vis === undefined) continue
		const ethBalanceAddresses = vis.ethBalanceChanges.map((change) => change.address)
		const eventArguments = vis.events.map((event) => event.type !== 'NonParsed' ? event.args : []).flat()
		const addressesInEvents = eventArguments.filter((event): event is { typeValue: { type: 'address', value: EthereumAddress }, paramName: string } => event.typeValue.type === 'address').map((event) => event.typeValue.value)
		addressesToFetchMetadata = addressesToFetchMetadata.concat(ethBalanceAddresses, addressesInEvents, vis.events.map((event) => event.loggersAddress))
	}

	simulationState.simulatedTransactions.forEach((tx) => {
		addressesToFetchMetadata.push(tx.signedTransaction.from)
		if (tx.signedTransaction.to !== null) addressesToFetchMetadata.push(tx.signedTransaction.to)
	})

	const deDuplicated = new Set<bigint>(addressesToFetchMetadata)
	const addressIdentificationPromises: Promise<AddressBookEntry>[] = Array.from(deDuplicated.values()).map((address) => identifyAddress(ethereumClientService, userAddressBook, address))

	return await Promise.all(addressIdentificationPromises)
}

export async function nameTokenIds(ethereumClientService: EthereumClientService, visualizerResult: readonly (VisualizerResult | undefined)[]) {
	type TokenAddressTokenIdPair = {
		tokenAddress: bigint
		tokenId: bigint
	}
	let tokenAddresses: TokenAddressTokenIdPair[] = visualizerResult.map((vis) => {
		if (vis === undefined) return undefined
		return vis.events.map((x) => { 
			if (x.type !== 'TokenEvent' || x.tokenInformation.type !== 'ERC1155') return undefined
			return { tokenAddress: x.tokenInformation.tokenAddress, tokenId: x.tokenInformation.tokenId }
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
