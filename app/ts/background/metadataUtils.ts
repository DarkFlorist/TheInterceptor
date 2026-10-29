import { addressString, addressStringWithout0x } from '../utils/bigint.js'
import type { AddressBookEntries, AddressBookEntry, Erc20TokenEntry } from '../types/addressBookTypes.js'
import type { NamedTokenId, SimulationStateInput } from '../types/visualizer-types.js'
import { tokenMetadata, contractMetadata, erc721Metadata, erc1155Metadata } from '@darkflorist/address-metadata'
import { getAddress, keccak256, stringToBytes } from '../utils/ethereumPrimitives.js'
import { ENS_ADDR_REVERSE_NODE, ENS_TOKEN_WRAPPER, ETHEREUM_COIN_ICON, ETHEREUM_LOGS_LOGGER_ADDRESS, MOCK_ADDRESS } from '../utils/constants.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { type IdentifiedAddress, itentifyAddressViaOnChainInformation } from '../utils/tokenIdentification.js'
import { assertNever } from '../utils/typescript.js'
import { addEnsLabelHash, addEnsNodeHash, addUserAddressBookEntryIfItDoesNotExist, getEnsLabelHashes, getEnsNodeHashes, getUserAddressBookEntries, getUserAddressBookEntriesForChainIdMorePreciseFirst } from './storageVariables.js'
import { getUniqueItemsByProperties } from '../utils/typed-arrays.js'
import { getEnsReverseNodeHash, getEthereumNameServiceNameFromTokenId } from '../utils/ethereumNameService.js'
import { DEFAULT_ACTIVE_ADDRESSES } from '../config/defaults.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { IdentifyAddress, LookUpEnsName, MetadataLookups } from '../types/metadataLookups.js'
import type { EthereumAddress, EthereumBytes32 } from '../types/wire-types.js'
import type { ENSNameHashes } from '../types/ens.js'
const LOGO_URI_PREFIX = '../vendor/@darkflorist/address-metadata'
import type { EnrichedEthereumEventWithMetadata, EnrichedEthereumEvents, EnrichedEthereumInputData, EnsEvent, SolidityVariable, TokenEvent, TokenVisualizerResultWithMetadata } from '../types/EnrichedEthereumData.js'
import type { PureGroupedSolidityType } from '../types/solidityType.js'
import { promiseAllMapAbortSafe } from '../utils/requests.js'
import { getFilledInContactEntry } from '../utils/addressBookEntries.js'
import { JsonRpcResponseError, reportLocalRecoveryBestEffort } from '../utils/errors.js'
import { getDeployedContractAddress } from '../simulation/services/SimulationModeEthereumClientService.js'
import { isValidErc20Decimals } from '../utils/erc20.js'
import { findActiveAddressBookEntryForChain } from '../utils/activeAddressSelection.js'

const pathJoin = (parts: string[], sep = '/') => parts.join(sep).replace(new RegExp(sep + '{1,}', 'g'), sep)

export const getFullLogoUri = (logoURI: string) => pathJoin([LOGO_URI_PREFIX, logoURI])

/**
 * Resolves metadata for an address being surfaced as an active account. This
 * intentionally accepts metadata only from entries marked `useAsActiveAddress`;
 * static contract/token metadata and non-active address-book entries must not
 * supply active-account access policy.
 */
export async function getActiveAddressEntryForChain(address: bigint, chainId: bigint): Promise<AddressBookEntry> {
	const identifiedAddress = findActiveAddressBookEntryForChain(await getActiveAddresses(), address, chainId, 'any')
	if (identifiedAddress !== undefined) return identifiedAddress
	return getUnknownActiveAddressEntry(address)
}

export async function getWalletActiveAddressEntryForChain(address: bigint, chainId: bigint): Promise<AddressBookEntry> {
	const identifiedAddress = findActiveAddressBookEntryForChain(await getActiveAddresses(), address, chainId, 'walletAccount')
	if (identifiedAddress !== undefined) return identifiedAddress
	return getUnknownActiveAddressEntry(address)
}

function getUnknownActiveAddressEntry(address: bigint): AddressBookEntry {
	return {
		...getFilledInContactEntry(address),
		useAsActiveAddress: true,
		askForAddressAccess: true,
	}
}

export async function getActiveAddresses() : Promise<AddressBookEntries> {
	const activeAddresses = (await getUserAddressBookEntries()).filter((entry) => entry.useAsActiveAddress)
	return activeAddresses === undefined || activeAddresses.length === 0 ? DEFAULT_ACTIVE_ADDRESSES : activeAddresses
}

export function getNativeTokenErc20(rpcEntry: RpcNetwork | undefined): Erc20TokenEntry {
	return {
		address: ETHEREUM_LOGS_LOGGER_ADDRESS,
		name: rpcEntry?.currencyName ?? 'Ethereum',
		type: 'ERC20',
		entrySource: 'Interceptor',
		symbol: rpcEntry?.currencyTicker ?? 'ETH',
		decimals: 18n,
		logoUri: rpcEntry !== undefined && 'currencyLogoUri' in rpcEntry ? rpcEntry.currencyLogoUri : ETHEREUM_COIN_ICON,
		...(rpcEntry?.chainId !== undefined ? { chainId: rpcEntry.chainId } : {}),
	}
}

async function identifyAddressWithoutNode(address: bigint, rpcEntry: RpcNetwork | undefined, useLocalStorage = true) : Promise<AddressBookEntry | undefined> {
	if (address === ETHEREUM_LOGS_LOGGER_ADDRESS) return getNativeTokenErc20(rpcEntry)

	if (useLocalStorage) {
		const userEntry = (await getUserAddressBookEntriesForChainIdMorePreciseFirst(rpcEntry?.chainId ?? 1n)).find((entry) => entry.address === address)
		if (userEntry !== undefined) return userEntry
	}
	const addrString = addressString(address)
	const addressData = contractMetadata.get(addrString)
	if (addressData) {
		const { logoUri, ...rest } = addressData
		return {
			...rest,
			...(logoUri !== undefined ? { logoUri: `${ getFullLogoUri(logoUri) }` } : {}),
			address: address,
			type: 'contract',
			entrySource: 'DarkFloristMetadata',
			...(rpcEntry?.chainId !== undefined ? { chainId: rpcEntry.chainId } : {}),
		}
	}

	const tokenData = tokenMetadata.get(addrString)
	if (tokenData) {
		const { logoUri, ...rest } = tokenData
		return {
			...rest,
			...(logoUri !== undefined ? { logoUri: `${ getFullLogoUri(logoUri) }` } : {}),
			address: address,
			type: 'ERC20',
			entrySource: 'DarkFloristMetadata',
			...(rpcEntry?.chainId !== undefined ? { chainId: rpcEntry.chainId } : {}),
		}
	}

	const erc721TokenData = erc721Metadata.get(addrString)
	if (erc721TokenData) {
		const { logoUri, ...rest } = erc721TokenData
		return {
			...rest,
			...(logoUri !== undefined ? { logoUri: `${ getFullLogoUri(logoUri) }` } : {}),
			address: address,
			type: 'ERC721',
			entrySource: 'DarkFloristMetadata',
			...(rpcEntry?.chainId !== undefined ? { chainId: rpcEntry.chainId } : {}),
		}
	}

	const erc1155TokenData = erc1155Metadata.get(addrString)
	if (erc1155TokenData) {
		const { logoUri, ...rest } = erc1155TokenData
		return {
			...rest,
			...(logoUri !== undefined ? { logoUri: `${ getFullLogoUri(logoUri) }` } : {}),
			address: address,
			type: 'ERC1155',
			entrySource: 'DarkFloristMetadata',
			decimals: undefined,
			...(rpcEntry?.chainId !== undefined ? { chainId: rpcEntry.chainId } : {}),
		}
	}

	if (address === MOCK_ADDRESS) return {
		address: address,
		name: 'Ethereum Validator',
		logoUri: '../../img/contracts/rhino.png',
		type: 'contact',
		entrySource: 'Interceptor',
		...(rpcEntry?.chainId !== undefined ? { chainId: rpcEntry.chainId } : {}),
	}
	if (address === 0n) return {
		address: address,
		name: '0x0 Address',
		type: 'contact',
		entrySource: 'Interceptor',
		...(rpcEntry?.chainId !== undefined ? { chainId: rpcEntry.chainId } : {}),
	}
	return undefined
}

export async function identifyAddress(ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined, address: bigint, useLocalStorage = true) : Promise<AddressBookEntry> {
	const identifiedAddress = await identifyAddressWithoutNode(address, ethereumClientService.getRpcEntry(), useLocalStorage)
	if (identifiedAddress !== undefined) return identifiedAddress
	const addrString = addressString(address)
	const chainId = ethereumClientService.getChainId()
	let tokenIdentification: IdentifiedAddress
	try {
		tokenIdentification = await itentifyAddressViaOnChainInformation(ethereumClientService, requestAbortController, address)
	} catch(error: unknown) {
		if (!(error instanceof JsonRpcResponseError)) throw error
		reportLocalRecoveryBestEffort(error, {
			code: 'token_metadata_probe_failed',
			message: 'Using fallback address metadata after optional on-chain token probes failed.',
			details: { address: addrString },
		})
		return { ...getFilledInContactEntry(address), chainId }
	}
	const getEntry = (tokenIdentification: IdentifiedAddress): AddressBookEntry => {
		switch (tokenIdentification.type) {
			case 'ERC20': return !isValidErc20Decimals(tokenIdentification.decimals) ? {
				name: tokenIdentification.name,
				address,
				type: 'contract',
				entrySource: 'OnChain',
				chainId,
			} : {
				name: tokenIdentification.name,
				address,
				symbol: tokenIdentification.symbol,
				decimals: tokenIdentification.decimals,
				type: 'ERC20',
				entrySource: 'OnChain',
				chainId
			}
			case 'ERC1155': return {
				name: getAddress(addrString),
				address,
				symbol: '???',
				type: 'ERC1155',
				decimals: undefined,
				entrySource: 'OnChain',
				chainId
			}
			case 'ERC721': return {
				name: tokenIdentification.name,
				address,
				symbol: tokenIdentification.symbol,
				type: 'ERC721',
				entrySource: 'OnChain',
				chainId
			}
			case 'contract': return {
				address,
				name: getAddress(addrString),
				type: 'contract',
				entrySource: 'OnChain',
				chainId
			}
			case 'EOA': return {
				address,
				name: getAddress(addrString),
				type: 'contact',
				entrySource: 'OnChain',
				chainId
			}
			default: assertNever(tokenIdentification)
		}
	}
	const entry = getEntry(tokenIdentification)
	if (useLocalStorage) await addUserAddressBookEntryIfItDoesNotExist(entry)
	return entry
}

// Identifies addresses as identifyAddress does: from the address book and bundled metadata, else on chain, caching what it finds in the address book.
export const identifyAddressWith = (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined): IdentifyAddress => async (address) => await identifyAddress(ethereumClientService, requestAbortController, address)

// A simulation run's lookups, which reach the chain for what local data does not know.
export const lookUpMetadataOnChain = (ethereumClientService: EthereumClientService, requestAbortController: AbortController | undefined): MetadataLookups => ({
	identifyAddress: identifyAddressWith(ethereumClientService, requestAbortController),
	lookUpEnsName: async (nameHash) => await getEthereumNameServiceNameFromTokenId(ethereumClientService, undefined, nameHash),
})

// The entry a re-label shows for an address that neither the address book nor bundled metadata knows: the entry the run identified it with if the chain did, else the bare address, keeping the token kind and decimals of a removed user or bundled token entry so the run's token amounts still render. Marked 'OnChain', as an on-chain identification would be, so it is flagged as not in the address book.
function getIdentifiedOrBareAddressEntry(address: EthereumAddress, identifiedEntry: AddressBookEntry | undefined, chainId: bigint): AddressBookEntry {
	// The run's own on-chain identification needs no re-validation: its name and symbol are what the contract declares, which a new simulation reads again (or takes from the address book's cached copy), and its 'OnChain' source keeps it flagged as untrusted and not in the address book. A removed user or bundled entry falls through to the bare address instead, as its name came from that removed entry.
	if (identifiedEntry?.entrySource === 'OnChain') return identifiedEntry
	const bareAddressEntry = { address, name: getAddress(addressString(address)), entrySource: 'OnChain' as const, chainId }
	switch (identifiedEntry?.type) {
		case 'ERC20': return { ...bareAddressEntry, type: 'ERC20', symbol: '???', decimals: identifiedEntry.decimals }
		case 'ERC721': return { ...bareAddressEntry, type: 'ERC721', symbol: '???' }
		case 'ERC1155': return { ...bareAddressEntry, type: 'ERC1155', symbol: '???', decimals: undefined }
		case 'contract':
		case 'safe': return { ...bareAddressEntry, type: 'contract' }
		case 'contact':
		case undefined: return { ...bareAddressEntry, type: 'contact' }
		default: return assertNever(identifiedEntry)
	}
}

// Records every entry a simulation run's address lookups resolve, to store with the run as its identifiedAddressBookEntries.
export function recordIdentifiedAddresses(identify: IdentifyAddress) {
	const identifiedEntries = new Map<bigint, AddressBookEntry>()
	return {
		identifyAddress: async (address: EthereumAddress) => {
			const entry = await identify(address)
			identifiedEntries.set(entry.address, entry)
			return entry
		},
		getIdentifiedEntries: () => Array.from(identifiedEntries.values()),
	}
}

// An address-book re-label's lookups never reach the chain: identifying an address there simulates, and the re-label must neither simulate nor fail with the node. A removed user entry therefore shows what the run identified it as, or the bare address, until the next simulation identifies the address again. Only entries the run's own lookups resolved stand in (identifiedAddressBookEntries), never data parsed from the stored visualisation, which can carry website-controlled values.
export function lookUpMetadataForRelabel(identifiedEntries: readonly AddressBookEntry[], rpcEntry: RpcNetwork): MetadataLookups {
	const identifiedEntryByAddress = new Map(identifiedEntries.map((entry) => [entry.address, entry]))
	return {
		identifyAddress: async (address) => await identifyAddressWithoutNode(address, rpcEntry) ?? getIdentifiedOrBareAddressEntry(address, identifiedEntryByAddress.get(address), rpcEntry.chainId),
		lookUpEnsName: async () => undefined,
	}
}

const getAddressesForSolidityType = (typeValue: PureGroupedSolidityType): readonly bigint[] => {
	switch(typeValue.type) {
		case 'address': return [typeValue.value]
		case 'address[]': return typeValue.value
		case 'tuple': return getAddressesForSolidityTypes(typeValue.value)
		case 'tuple[]': return typeValue.value.flatMap((tupleValue) => getAddressesForSolidityTypes(tupleValue))
		case 'bool':
		case 'bool[]':
		case 'bytes':
		case 'bytes[]':
		case 'fixedBytes':
		case 'fixedBytes[]':
		case 'signedInteger':
		case 'signedInteger[]':
		case 'string':
		case 'string[]':
		case 'unsignedInteger':
		case 'unsignedInteger[]': return []
		default: assertNever(typeValue)
	}
}

export const getAddressesForSolidityTypes = (variables: readonly SolidityVariable[]) => {
	return variables.flatMap((argumentVariable) => getAddressesForSolidityType(argumentVariable.typeValue))
}

export function getAddressesToIdentifyForVisualiserFromTransactions(events: EnrichedEthereumEvents, inputData: readonly EnrichedEthereumInputData[], simulationStateInput: SimulationStateInput) {
	const addressesToFetchMetadata = [
		...events.flatMap((event) => [event.address, ...(event.type === 'NonParsed' ? [] : getAddressesForSolidityTypes(event.args))]),
		...getAddressesForSolidityTypes(inputData.flatMap((event) => event.type !== 'NonParsed' ? event.args : [])),
	]

	for (const tx of simulationStateInput.flatMap((block) => block.transactions)) {
		addressesToFetchMetadata.push(tx.signedTransaction.from)
		addressesToFetchMetadata.push(tx.signedTransaction.to ?? getDeployedContractAddress(tx.signedTransaction.from, tx.signedTransaction.nonce))
		if (tx.signedTransaction.type === '7702') addressesToFetchMetadata.push(...tx.signedTransaction.authorizationList.map((authorization) => authorization.address))
	}

	return Array.from(new Set<bigint>([...addressesToFetchMetadata, ETHEREUM_LOGS_LOGGER_ADDRESS]).values())
}

export async function getAddressBookEntriesForVisualiserFromTransactions(identify: IdentifyAddress, events: EnrichedEthereumEvents, inputData: readonly EnrichedEthereumInputData[], simulationStateInput: SimulationStateInput): Promise<AddressBookEntry[]> {
	const addressesToIdentify = getAddressesToIdentifyForVisualiserFromTransactions(events, inputData, simulationStateInput)
	return await promiseAllMapAbortSafe(addressesToIdentify, async (address) => await identify(address))
}

export async function nameTokenIds(chainId: bigint, lookUpEnsName: LookUpEnsName, events: EnrichedEthereumEvents) {
	type TokenAddressTokenIdPair = { tokenAddress: bigint, tokenId: bigint }
	const tokenAddresses = events.map((event) => {
		if (event.type !== 'TokenEvent' || event.logInformation.type !== 'ERC1155') return undefined
		return { tokenAddress: event.logInformation.tokenAddress, tokenId: event.logInformation.tokenId }
	}).filter((pair): pair is TokenAddressTokenIdPair => pair !== undefined)

	const pairs = getUniqueItemsByProperties(tokenAddresses, ['tokenAddress', 'tokenId'])
	const namedPairs = (await Promise.all(pairs.map(async (pair) => {
		if (pair.tokenAddress === ENS_TOKEN_WRAPPER && chainId === 1n) {
			const tokenIdName = (await getAndCacheEnsNodeHash(lookUpEnsName, pair.tokenId, [])).name
			if (tokenIdName === undefined) return undefined
			return { ...pair, tokenIdName }
		}
		return undefined
	}))).filter((pair): pair is NamedTokenId => pair !== undefined)
	return namedPairs
}

export const extractTokenEvents = (events: readonly EnrichedEthereumEventWithMetadata[]): readonly TokenVisualizerResultWithMetadata[] => {
	return events.filter((tokenEvent): tokenEvent is TokenEvent => tokenEvent.type === 'TokenEvent').map((token) => token.logInformation)
}
export const extractEnsEvents = (events: readonly EnrichedEthereumEventWithMetadata[]): readonly EnsEvent[] => {
	return events.filter((tokenEvent): tokenEvent is EnsEvent => tokenEvent.type === 'ENS')
}

export const retrieveEnsNodeAndLabelHashes = async (lookUpEnsName: LookUpEnsName, events: EnrichedEthereumEvents, addressBookEntriesToMatchReverseResolutions: readonly AddressBookEntry[]) => {
	const labelHashesToRetrieve = events.map((event) => 'logInformation' in event && 'labelHash' in event.logInformation ? event.logInformation.labelHash : undefined).filter((labelHash): labelHash is bigint => labelHash !== undefined)
	const reverseEnsLabelHashes = addressBookEntriesToMatchReverseResolutions.map((entry) => addressStringWithout0x(entry.address)).map((label) => ({ label, labelHash: BigInt(keccak256(stringToBytes(label))) }))
	const newLabels = [...events.map((event) => 'logInformation' in event && 'name' in event.logInformation ? event.logInformation.name : undefined).filter((label): label is string => label !== undefined)]

	// update the mappings if we have new labels
	const deduplicatedLabels = Array.from(new Set(newLabels))
	await Promise.all(deduplicatedLabels.map(async (label) => Promise.all([await addEnsLabelHash(label), await addEnsNodeHash(label.endsWith('.eth') ? label : `${ label }.eth`)])))

	// return the label hashes that we have now available
	const currentLabelHashes = [...reverseEnsLabelHashes, ...await getEnsLabelHashes()]
	const ensLabelHashes = Array.from(new Set(labelHashesToRetrieve)).map((labelHash) => {
		const found = currentLabelHashes.find((entry) => entry.labelHash === labelHash)
		if (found) addEnsLabelHash(found.label) // if we actally use the label, add to our cache. This should already be there unless it was a reverse ens label hash that we guessed
		return { labelHash, label: found?.label }
	})

	const hashes = new Set<bigint>()
	for (const event of events) {
		if (!('logInformation' in event && 'node' in event.logInformation)) continue
		hashes.add(event.logInformation.node)
	}
	const reverseEnsNameHashes = addressBookEntriesToMatchReverseResolutions.map((addressBookEntry) => getEnsReverseNodeHash(addressBookEntry.address))
	const ensNameHashes = await Promise.all([...hashes].map((hash) => getAndCacheEnsNodeHash(lookUpEnsName, hash, reverseEnsNameHashes)))

	return { ensNameHashes, ensLabelHashes }
}

const addNewEnsNameEntry = async (name: string) => {
	const [label] = name.split('.')
	if (label !== undefined) await addEnsLabelHash(label)
	await addEnsNodeHash(name)
}

const getAndCacheEnsNodeHash = async (lookUpEnsName: LookUpEnsName, ensNameHash: EthereumBytes32, extraNameHashes: ENSNameHashes) => {
	const currentHashes = [ENS_ADDR_REVERSE_NODE, ...await getEnsNodeHashes()]
	const entry = currentHashes.find((entry) => entry.nameHash === ensNameHash)
	if (entry !== undefined) return entry

	const extraNameEntry = extraNameHashes.find((entry) => entry.nameHash === ensNameHash)
	if (extraNameEntry !== undefined) { // extra name entries do not exist in our localstorage, so if we find a match, lets add them there
		await addNewEnsNameEntry(extraNameEntry.name)
		return extraNameEntry
	}

	const name = await lookUpEnsName(ensNameHash)
	if (name !== undefined) await addNewEnsNameEntry(name)
	return { nameHash: ensNameHash, name }
}
