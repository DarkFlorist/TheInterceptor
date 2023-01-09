import { addressString } from '../utils/bigint.js'
import { AddressInfo } from '../utils/user-interface-types.js'
import { AddressMetadata, SimulationState, VisualizerResult } from '../utils/visualizer-types.js'
import { nftMetadata, tokenMetadata, contractMetadata } from '@darkflorist/address-metadata'
import { ethers } from 'ethers'
import { Simulator } from '../simulation/simulator.js'
import { MOCK_ADDRESS } from '../utils/constants.js'
import { GetAddressBookDataFilter } from '../utils/interceptor-messages.js'
const LOGO_URI_PREFIX = `../vendor/@darkflorist/address-metadata`

export function getMetadataForAddressBookData(filter: GetAddressBookDataFilter, addressInfos: readonly AddressInfo[] | undefined) {
	const searchString = filter.searchString !== undefined && filter.searchString.trim().length > 0 ? filter.searchString.trim().toLowerCase() : undefined
	switch(filter.filter) {
		case 'My Contacts': return { data: [], length: 0 }
		case 'My Active Addresses': {
			const searchFiltered = searchString === undefined ? addressInfos : addressInfos?.filter( (x) =>
				x.address.toString().includes(searchString)
				|| x.name.toLowerCase().includes(searchString)
			)
			return {
				data: searchFiltered ? searchFiltered.slice(filter.startIndex, filter.maxIndex).map( (x) => ({
					type: 'addressInfo' as const,
					...x
				})) : [],
				length: searchFiltered ? searchFiltered.length : 0
			}
		}
		case 'Tokens': {
			const searchFiltered = searchString === undefined ? Array.from(tokenMetadata) : Array.from(tokenMetadata).filter( ([address, def]) =>
				address.includes(searchString)
				|| def.name.toLowerCase().includes(searchString)
				|| def.symbol.toLowerCase().includes(searchString)
			)
			return {
				data: searchFiltered.slice(filter.startIndex, filter.maxIndex).map( (x) => ({
					type: 'token' as const,
					address: BigInt(x[0]),
					...x[1]
				})),
				length: searchFiltered.length
			}
		}
		case 'Non Fungible Tokens': {
			const searchFiltered = searchString === undefined ? Array.from(nftMetadata) : Array.from(nftMetadata).filter( ([address, def]) =>
				address.includes(searchString)
				|| def.name.toLowerCase().includes(searchString)
				|| def.symbol.toLowerCase().includes(searchString)
			)
			return {
				data: searchFiltered.slice(filter.startIndex, filter.maxIndex).map( (x) => ({
					type: 'NFT' as const,
					address: BigInt(x[0]),
					...x[1]
				})),
				length: searchFiltered.length
			}
		}
		case 'Other Contracts': {
			const searchFiltered = searchString === undefined ? Array.from(contractMetadata) : Array.from(contractMetadata).filter( ([address, def]) =>
				address.includes(searchString)
				|| def.name.toLowerCase().includes(searchString)
				|| def.protocol?.toLowerCase().includes(searchString)
			)
			return {
				data: searchFiltered.slice(filter.startIndex, filter.maxIndex).map( (x) => ({
					type: 'other contract' as const,
					address: BigInt(x[0]),
					...x[1]
				})),
				length: searchFiltered.length
			}
		}
	}
}

export function getAddressMetaData(address: bigint, addressInfos: readonly AddressInfo[] | undefined) : AddressMetadata {
	if ( address === MOCK_ADDRESS) {
		return {
			name: 'Ethereum Validator',
			logoURI: '../../img/contracts/rhino.png',
			protocol: undefined,
			metadataSource: 'other',
		}
	}
	if (addressInfos !== undefined) {
		for (const info of addressInfos) {
			if (info.address === address) {
				return {
					name: info.name,
					logoURI: undefined,
					protocol: undefined,
					metadataSource: 'addressBook',
				}
			}
		}
	}

	const addrString = addressString(address)

	const addressData = contractMetadata.get(addrString)
	if (addressData) return {
		...addressData,
		logoURI: addressData.logoURI ? `${ LOGO_URI_PREFIX }/${ addressData.logoURI }` : undefined,
		metadataSource: 'contract',
	}

	const tokenData = tokenMetadata.get(addrString)
	if (tokenData) return {
		name: tokenData.name,
		symbol: tokenData.symbol,
		logoURI: tokenData.logoURI ? `${ LOGO_URI_PREFIX }/${ tokenData.logoURI }` : undefined,
		protocol: undefined,
		metadataSource: 'token',
		decimals: tokenData.decimals,
	}

	const nftTokenData = nftMetadata.get(addrString)
	if (nftTokenData) return {
		name: nftTokenData.name,
		symbol: nftTokenData.symbol,
		logoURI: nftTokenData.logoURI ? `${ LOGO_URI_PREFIX }/${ nftTokenData.logoURI }` : undefined,
		metadataSource: 'nft',
		protocol: undefined,
		decimals: undefined,
	}

	return {
		name: ethers.utils.getAddress(addrString),
		logoURI: undefined,
		protocol: undefined,
		metadataSource: 'other',
	}
}

async function getTokenMetadata(simulator: Simulator, address: bigint) : Promise<AddressMetadata> {
	const addrString = addressString(address)
	const tokenData = tokenMetadata.get(addrString)
	if (tokenData) return {
		name: tokenData.name,
		symbol: tokenData.symbol,
		logoURI: tokenData.logoURI ? `${ LOGO_URI_PREFIX }/${ tokenData.logoURI }` : undefined,
		protocol: undefined,
		metadataSource: 'token',
		decimals: tokenData.decimals,
	}
	const nftTokenData = nftMetadata.get(addrString)
	if (nftTokenData) return {
		name: nftTokenData.name,
		symbol: nftTokenData.symbol,
		logoURI: nftTokenData.logoURI ? `${ LOGO_URI_PREFIX }/${ nftTokenData.logoURI }` : undefined,
		metadataSource: 'nft',
		protocol: undefined,
		decimals: undefined
	}
	const decimals = simulator === undefined ? undefined : await simulator.ethereum.getTokenDecimals(address).catch(() => {
		console.log(`could not fetch decimals for ${ address }`)
		return undefined
	})
	return {
		name: ethers.utils.getAddress(addrString),
		symbol: '???',
		protocol: undefined,
		logoURI: undefined,
		metadataSource: 'imputed' as const,
		decimals
	}
}

export async function getAddressMetadataForVisualiser(simulator: Simulator, visualizerResult: (VisualizerResult | undefined)[], simulationState: SimulationState, addressInfos: readonly AddressInfo[] | undefined) : Promise<[string, AddressMetadata][]> {
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
		addressesToFetchMetadata.push(tx.unsignedTransaction.from)
		if (tx.unsignedTransaction.to !== null) addressesToFetchMetadata.push(tx.unsignedTransaction.to)
	})

	const deDuplicatedTokens = Array.from(new Set<bigint>(tokenAddresses).values())
	const tokenPromises = deDuplicatedTokens.map ( (addr) => getTokenMetadata(simulator, addr))
	const tokenResolves = await Promise.all(tokenPromises)

	const tokens: [string, AddressMetadata][] = deDuplicatedTokens.map( (addr, index) => [
		addressString(addr), tokenResolves[index]]
	)

	const deDuplicated = new Set<bigint>(addressesToFetchMetadata)
	const addresses: [string, AddressMetadata][] = Array.from(deDuplicated.values()).filter( (address) => !deDuplicatedTokens.includes(address) ).map( ( address ) =>
		[addressString(address), getAddressMetaData(address, addressInfos)]
	)

	return addresses.concat(tokens)
}
