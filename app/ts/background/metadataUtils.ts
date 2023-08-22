import { addressString, checksummedAddress } from '../utils/bigint.js'
import { AddressInfoEntry, AddressBookEntry, AddressInfo, Erc20TokenEntry, Erc721Entry, Erc1155Entry } from '../utils/user-interface-types.js'
import { SimulationState, VisualizerResult } from '../utils/visualizer-types.js'
import { nftMetadata, tokenMetadata, contractMetadata } from '@darkflorist/address-metadata'
import { ethers } from 'ethers'
import { MOCK_ADDRESS } from '../utils/constants.js'
import { UserAddressBook } from '../utils/interceptor-messages.js'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { itentifyAddressViaOnChainInformation } from '../utils/tokenIdentification.js'
import { assertNever } from '../utils/typescript.js'
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
					type: 'addressInfo',
					entrySource: 'User',
				}
			}
		}
	}
	return {
		type: 'addressInfo' as const,
		name: checksummedAddress(address),
		address: address,
		askForAddressAccess: false,
		entrySource: 'User',
	}
}

export function getAddressMetaData(address: bigint, userAddressBook: UserAddressBook) : AddressBookEntry {
	if ( address === MOCK_ADDRESS) {
		return {
			address: address,
			name: 'Ethereum Validator',
			logoUri: '../../img/contracts/rhino.png',
			type: 'contact',
		}
	}
	for (const info of userAddressBook.addressInfos) {
		if (info.address === address) {
			return {
				...info,
				type: 'addressInfo',
				entrySource: 'User',
			}
		}
	}

	for (const contact of userAddressBook.contacts) {
		if (contact.address === address) {
			return {
				...contact,
				type: 'contact',
				entrySource: 'User',
			}
		}
	}

	const addrString = addressString(address)

	const addressData = contractMetadata.get(addrString)
	if (addressData) return {
		...addressData,
		address: address,
		logoUri: addressData.logoUri ? `${ getFullLogoUri(addressData.logoUri) }` : undefined,
<<<<<<< Updated upstream
		type: 'other contract',
=======
		type: 'contract',
		entrySource: 'DarkFloristMetadata',
>>>>>>> Stashed changes
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

<<<<<<< Updated upstream
	return {
		address: address,
		name: ethers.getAddress(addrString),
		type: 'contact',
=======
	if (address === MOCK_ADDRESS) {
		return {
			address: address,
			name: 'Ethereum Validator',
			logoUri: '../../img/contracts/rhino.png',
			type: 'contact',
			entrySource: 'Interceptor',
		}
	}
	if (address === 0n) {
		return {
			address: address,
			name: '0x0 Address',
			type: 'contact',
			entrySource: 'Interceptor',
		}
>>>>>>> Stashed changes
	}
}

export async function getTokenMetadata(ethereumClientService: EthereumClientService, address: bigint) : Promise<Erc20TokenEntry | Erc721Entry | Erc1155Entry> {
	const addrString = addressString(address)
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
		type: 'ERC721',
	}
	const tokenIdentification = await itentifyAddressViaOnChainInformation(ethereumClientService, address)

	switch(tokenIdentification.type) {
		case 'ERC20': return {
			name: ethers.getAddress(addrString), // todo, we could add the name from contract here, but we should check that it doesn't exist with us already
			address: BigInt(addrString),
			symbol: '???', // todo, we could add the name from contract here, but we should check that it doesn't exist with us already
			decimals: tokenIdentification.decimals,
			type: 'ERC20',
			entrySource: 'OnChain',
		}
<<<<<<< Updated upstream
		case 'ERC1155': {
			return {
				name: ethers.getAddress(addrString),
				address: BigInt(addrString),
				symbol: '???',
				type: 'ERC1155',
				decimals: undefined,
			}
		}
		case 'ERC721':
		case 'EOA':
		case 'contract': {
			return { // Lets just assume its ERC721 if we don't really know what it is
				name: ethers.getAddress(addrString),
				address: BigInt(addrString),
				symbol: '???',
				type: 'ERC721',
			}
=======
		case 'ERC1155': return {
			name: ethers.getAddress(addrString),
			address: BigInt(addrString),
			symbol: '???',
			type: 'ERC1155',
			decimals: undefined,
			entrySource: 'OnChain',
		}
		case 'ERC721': return {
			name: ethers.getAddress(addrString),
			address: BigInt(addrString),
			symbol: '???',
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
>>>>>>> Stashed changes
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
	const tokenPromises = deDuplicatedTokens.map ((addr) => getTokenMetadata(ethereumClientService, addr))
	const tokens = await Promise.all(tokenPromises)

	const deDuplicated = new Set<bigint>(addressesToFetchMetadata)
	const addresses: AddressBookEntry[] = Array.from(deDuplicated.values()).filter( (address) => !deDuplicatedTokens.includes(address) ).map( ( address ) =>
		getAddressMetaData(address, userAddressBook)
	)

	return addresses.concat(tokens)
}
