import { addressString, checksummedAddress } from '../utils/bigint.js'
import { AddressInfoEntry, AddressBookEntry, AddressInfo } from '../utils/user-interface-types.js'
import { SimulationState, VisualizerResult } from '../utils/visualizer-types.js'
import { nftMetadata, tokenMetadata, contractMetadata } from '@darkflorist/address-metadata'
import { ethers } from 'ethers'
import { MOCK_ADDRESS } from '../utils/constants.js'
import { UserAddressBook } from '../utils/interceptor-messages.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { itentifyAddressViaOnChainInformation } from '../utils/tokenIdentification.js'
import { assertNever } from '../utils/typescript.js'
import { getUserAddressBookEntries } from './storageVariables.js'
export const LOGO_URI_PREFIX = `../vendor/@darkflorist/address-metadata`

export function getFullLogoUri(logoURI: string) {
	return `${ LOGO_URI_PREFIX }/${ logoURI }`
}

export function findAddressInfo(address: bigint, addressInfos: readonly AddressInfo[] | undefined) : AddressInfoEntry{
	if (addressInfos !== undefined) {
		for (const info of addressInfos) {
			if (info.address === address) {
				return {
					...info,
					type: 'addressInfo'
				}
			}
		}
	}
	return {
		type: 'addressInfo' as const,
		name: checksummedAddress(address),
		address: address,
		askForAddressAccess: false,
	}
}

// todo, add caching here, if we find new address, store it
export async function identifyAddress(ethereumClientService: EthereumClientService, userAddressBook: UserAddressBook, address: bigint, useLocalStorage: boolean = true) : Promise<AddressBookEntry> {
	for (const info of userAddressBook.addressInfos) {
		if (info.address === address) {
			return {
				...info,
				type: 'addressInfo'
			}
		}
	}
	for (const contact of userAddressBook.contacts) {
		if (contact.address === address) {
			return {
				...contact,
				type: 'contact'
			}
		}
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
	}

	const tokenData = tokenMetadata.get(addrString)
	if (tokenData) return {
		...tokenData,
		address: address,
		logoUri: tokenData.logoUri ? `${ getFullLogoUri(tokenData.logoUri) }` : undefined,
		type: 'ERC20',
	}

	const nftTokenData = nftMetadata.get(addrString)
	if (nftTokenData) return {
		...nftTokenData,
		address: address,
		logoUri: nftTokenData.logoUri ? `${ getFullLogoUri(nftTokenData.logoUri) }` : undefined,
		type: 'ERC721'
	}

	if (address === MOCK_ADDRESS) {
		return {
			address: address,
			name: 'Ethereum Validator',
			logoUri: '../../img/contracts/rhino.png',
			type: 'contact',
		}
	}
	if (address === 0n) {
		return {
			address: address,
			name: '0x0 Address',
			type: 'contact',
		}
	}

	const tokenIdentification = await itentifyAddressViaOnChainInformation(ethereumClientService, address)

	switch(tokenIdentification.type) {
		case 'ERC20': return {
			name: ethers.getAddress(addrString), // todo, we could add the name from contract here, but we should check that it doesn't exist with us already
			address: BigInt(addrString),
			symbol: '???', // todo, we could add the name from contract here, but we should check that it doesn't exist with us already
			decimals: tokenIdentification.decimals,
			type: 'ERC20',
		}
		case 'ERC1155': return {
			name: ethers.getAddress(addrString),
			address: BigInt(addrString),
			symbol: '???',
			type: 'ERC1155',
			decimals: undefined,
		}
		case 'ERC721': return {
			name: ethers.getAddress(addrString),
			address: BigInt(addrString),
			symbol: '???',
			type: 'ERC721',
		}
		case 'contract': return {
			address: address,
			name: ethers.getAddress(addrString),
			type: 'contract',
		}
		case 'EOA': return {
			address: address,
			name: ethers.getAddress(addrString),
			type: 'contact',
		}
		default: assertNever(tokenIdentification)
	}
}

export async function getAddressBookEntriesForVisualiser(ethereumClientService: EthereumClientService, visualizerResult: (VisualizerResult | undefined)[], simulationState: SimulationState, userAddressBook: UserAddressBook) : Promise<AddressBookEntry[]> {
	let addressesToFetchMetadata: bigint[] = []
	let tokenAddresses: bigint[] = []

	for (const vis of visualizerResult) {
		if (vis === undefined) continue
		const ethBalanceAddresses = vis.ethBalanceChanges.map( (x) => x.address )
		const from = vis.tokenResults.map( (x) => x.from )
		const to = vis.tokenResults.map( (x) => x.to )
		tokenAddresses = tokenAddresses.concat( vis.tokenResults.map( (x) => x.tokenAddress ) )
		addressesToFetchMetadata = addressesToFetchMetadata.concat(ethBalanceAddresses, from, to)
	}
	simulationState.simulatedTransactions.forEach( (tx) => {
		if ( tx.multicallResponse.statusCode === 'success') {
			addressesToFetchMetadata.concat(tx.multicallResponse.events.map( (tx) => tx.loggersAddress ))
		}
		addressesToFetchMetadata.push(tx.signedTransaction.from)
		if (tx.signedTransaction.to !== null) addressesToFetchMetadata.push(tx.signedTransaction.to)
	})

	const deDuplicatedTokens = Array.from(new Set<bigint>(tokenAddresses).values())
	const tokenPromises = deDuplicatedTokens.map ((addr) => identifyAddress(ethereumClientService, userAddressBook, addr))
	const tokens = await Promise.all(tokenPromises)

	const deDuplicated = new Set<bigint>(addressesToFetchMetadata)
	const addresses: Promise<AddressBookEntry>[] = Array.from(deDuplicated.values()).filter( (address) => !deDuplicatedTokens.includes(address) ).map( ( address ) =>
		identifyAddress(ethereumClientService, userAddressBook, address)
	)

	return (await Promise.all(addresses)).concat(tokens)
}
