import { addressString, checksummedAddress } from '../utils/bigint.js'
import { AddressInfoEntry, AddressBookEntry, AddressInfo } from '../utils/addressBookTypes.js'
import { NamedTokenId, SimulationState, VisualizerResult } from '../utils/visualizer-types.js'
import { nftMetadata, tokenMetadata, contractMetadata } from '@darkflorist/address-metadata'
import { ethers } from 'ethers'
import { MOCK_ADDRESS } from '../utils/constants.js'
import { UserAddressBook } from '../utils/interceptor-messages.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { itentifyAddressViaOnChainInformation } from '../utils/tokenIdentification.js'
import { assertNever } from '../utils/typescript.js'
import { getUserAddressBookEntries } from './storageVariables.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { EthereumNameServiceTokenWrapper, getEthereumNameServiceNameFromTokenId } from '../utils/ethereumNameService.js'
export const LOGO_URI_PREFIX = `../vendor/@darkflorist/address-metadata`

export function getFullLogoUri(logoURI: string) {
	return `${ LOGO_URI_PREFIX }/${ logoURI }`
}

export function findAddressInfo(address: bigint, addressInfos: readonly AddressInfo[] | undefined) : AddressInfoEntry{
	if (addressInfos !== undefined) {
		const entry = addressInfos.find((entry) => entry.address === address)
		if (entry !== undefined) return { ...entry, type: 'addressInfo', entrySource: 'User' }
	}
	return {
		type: 'addressInfo' as const,
		name: checksummedAddress(address),
		address: address,
		askForAddressAccess: false,
		entrySource: 'FilledIn'
	}
}

// todo, add caching here, if we find new address, store it
export async function identifyAddress(ethereumClientService: EthereumClientService, userAddressBook: UserAddressBook, address: bigint, useLocalStorage: boolean = true) : Promise<AddressBookEntry> {
	const addressInfo = userAddressBook.addressInfos.find((entry) => entry.address === address)
	if (addressInfo !== undefined) return { ...addressInfo, type: 'addressInfo', entrySource: 'User' }

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

	const nftTokenData = nftMetadata.get(addrString)
	if (nftTokenData) return {
		...nftTokenData,
		address: address,
		logoUri: nftTokenData.logoUri ? `${ getFullLogoUri(nftTokenData.logoUri) }` : undefined,
		type: 'ERC721',
		entrySource: 'DarkFloristMetadata',
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

export async function getAddressBookEntriesForVisualiser(ethereumClientService: EthereumClientService, visualizerResult: (VisualizerResult | undefined)[], simulationState: SimulationState, userAddressBook: UserAddressBook) : Promise<AddressBookEntry[]> {
	let addressesToFetchMetadata: bigint[] = []
	let tokenAddresses: bigint[] = []

	for (const vis of visualizerResult) {
		if (vis === undefined) continue
		const ethBalanceAddresses = vis.ethBalanceChanges.map((x) => x.address)
		const from = vis.tokenResults.map((x) => x.from)
		const to = vis.tokenResults.map((x) => x.to)
		tokenAddresses = tokenAddresses.concat(vis.tokenResults.map((x) => x.tokenAddress))
		addressesToFetchMetadata = addressesToFetchMetadata.concat(ethBalanceAddresses, from, to)
	}
	simulationState.simulatedTransactions.forEach((tx) => {
		if (tx.multicallResponse.statusCode === 'success') {
			addressesToFetchMetadata.concat(tx.multicallResponse.events.map( (tx) => tx.loggersAddress ))
		}
		addressesToFetchMetadata.push(tx.signedTransaction.from)
		if (tx.signedTransaction.to !== null) addressesToFetchMetadata.push(tx.signedTransaction.to)
	})

	const deDuplicated = new Set<bigint>(addressesToFetchMetadata.concat(tokenAddresses))
	const addressIdentificationPromises: Promise<AddressBookEntry>[] = Array.from(deDuplicated.values()).map((address) => identifyAddress(ethereumClientService, userAddressBook, address))

	return await Promise.all(addressIdentificationPromises)
}

export async function nameTokenIds(ethereumClientService: EthereumClientService, visualizerResult: (VisualizerResult | undefined)[]) {
	type TokenAddressTokenIdPair = {
		tokenAddress: bigint
		tokenId: bigint
	}
	let tokenAddresses: TokenAddressTokenIdPair[] = visualizerResult.map((vis) => {
		if (vis === undefined) return undefined
		return vis.tokenResults.map((x) => { 
			if (x.type !== 'ERC1155') return undefined
			return { tokenAddress: x.tokenAddress, tokenId: x.tokenId }
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
