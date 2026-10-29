// Visualises a stored simulation run again from stored data alone, for an address-book re-label. It builds the VisualisationLookups that a simulation run builds on the node (visualizeSimulatorState in simulationUpdating.ts) from local data and what the run recorded, so it makes no RPC request; both go through the same visualisation. See "Address-book re-labels" in docs/popup-simulation-refresh.md.
import { replayRecordedProtectorChainReads } from '../simulation/protectorChainReads.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { MetadataLookups } from '../types/metadataLookups.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { RecordedVisualisationLookups, SimulationState, VisualizedSimulationState, VisualizedSimulatorState } from '../types/visualizer-types.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { addressString } from '../utils/bigint.js'
import { getAddress } from '../utils/ethereumPrimitives.js'
import { assertNever } from '../utils/typescript.js'
import { identifyAddressFromLocalData } from './metadataUtils.js'
import { type VisualisationLookups, visualizeSimulatorStateWithLookups } from './simulationUpdating.js'

// The parts of a stored run that an address-book re-label starts from: its stored visualisation and what the run recorded of its lookups, which runs stored by older versions lack.
export type StoredSimulationMetadata = Pick<VisualizedSimulatorState, 'addressBookEntries' | 'tokenPriceEstimates' | 'visualizedSimulationState'> & {
	readonly recordedVisualisationLookups?: RecordedVisualisationLookups | undefined
}

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

// An address-book re-label's lookups never reach the chain: identifying an address there simulates, and the re-label must neither simulate nor fail with the node. A removed user entry therefore shows what the run identified it as, or the bare address, until the next simulation identifies the address again. Only entries the run's own lookups resolved stand in (identifiedAddressBookEntries), never data parsed from the stored visualisation, which can carry website-controlled values.
export function lookUpMetadataForRelabel(identifiedEntries: readonly AddressBookEntry[], rpcEntry: RpcNetwork): MetadataLookups {
	const identifiedEntryByAddress = new Map(identifiedEntries.map((entry) => [entry.address, entry]))
	return {
		identifyAddress: async (address) => await identifyAddressFromLocalData(address, rpcEntry) ?? getIdentifiedOrBareAddressEntry(address, identifiedEntryByAddress.get(address), rpcEntry.chainId),
		lookUpEnsName: async () => undefined,
	}
}

// The delegation each sender had when the run was visualised, by sender.
function getStoredDelegationAddressBySender(visualizedSimulationState: VisualizedSimulationState) {
	const delegationAddressBySender = new Map<string, bigint>()
	for (const block of visualizedSimulationState.visualizedBlocks) {
		for (const { transaction } of block.simulatedAndVisualizedTransactions) {
			if (transaction.delegationAddress !== undefined) delegationAddressBySender.set(addressString(transaction.from.address), transaction.delegationAddress.address)
		}
	}
	return delegationAddressBySender
}

// Answers every lookup of a visualisation without the node: addresses are named from the address book, bundled metadata and the entries the run identified (lookUpMetadataForRelabel), and the delegations, token prices and protector chain reads are those stored with the run.
function lookUpVisualisationFromStoredRun(storedMetadata: StoredSimulationMetadata, recorded: RecordedVisualisationLookups, rpcNetwork: RpcNetwork): VisualisationLookups {
	const metadataLookups = lookUpMetadataForRelabel(recorded.identifiedAddressBookEntries, rpcNetwork)
	return {
		...metadataLookups,
		getDelegationAddressBySender: async () => {
			const storedDelegations = Array.from(getStoredDelegationAddressBySender(storedMetadata.visualizedSimulationState))
			return new Map(await Promise.all(storedDelegations.map(async ([sender, delegationAddress]) => [sender, await metadataLookups.identifyAddress(delegationAddress)] as const)))
		},
		// A token keeps the stored price only while it is still known with the decimals that price was estimated for.
		estimateTokenPrices: async (quoteToken, tokens) => storedMetadata.tokenPriceEstimates.filter((estimate) => estimate.quoteToken.address === quoteToken.address && tokens.some((token) => token.address === estimate.token.address && token.decimals === estimate.token.decimals)),
		getProtectorChainReads: (_slicedSimulationState, blockIndex, transactionIndex) => {
			const record = recorded.protectorChainReads[blockIndex]?.[transactionIndex]
			if (record === undefined) throw new Error('The stored simulation run has no recorded protector chain reads for this transaction')
			return replayRecordedProtectorChainReads(record)
		},
		// The re-label keeps the run's record, as it identifies nothing new on chain.
		getIdentifiedAddressBookEntries: () => recorded.identifiedAddressBookEntries,
	}
}

// An address-book re-label visualises a stored run again without any RPC request, so it can neither simulate nor fail with the node; it gets the services' network as plain data, not a client.
export async function visualizeStoredRunWithoutNode(simulationState: SimulationState, storedMetadata: StoredSimulationMetadata, recorded: RecordedVisualisationLookups, rpcNetwork: RpcNetwork) {
	return await visualizeSimulatorStateWithLookups(simulationState, rpcNetwork, lookUpVisualisationFromStoredRun(storedMetadata, recorded, rpcNetwork))
}
