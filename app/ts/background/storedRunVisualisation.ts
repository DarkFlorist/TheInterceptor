// Visualises a stored simulation run again from stored data alone, for an address-book re-label. It builds the VisualisationLookups that a simulation run builds on the node (visualizeSimulatorState in simulationUpdating.ts) from local data and what the run recorded, so it makes no RPC request; both go through the same visualisation. See "Address-book re-labels" in docs/popup-simulation-refresh.md.
import { replayRecordedProtectorChainReads } from '../simulation/protectorChainReads.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { RecordedProtectorChainReads, SimulationState, VisualizedSimulationState, VisualizedSimulatorState } from '../types/visualizer-types.js'
import { addressString } from '../utils/bigint.js'
import { lookUpMetadataForRelabel } from './metadataUtils.js'
import { type VisualisationLookups, visualizeSimulatorStateWithLookups } from './simulationUpdating.js'

// The parts of a run's stored visualisation that an address-book re-label starts from.
export type StoredSimulationMetadata = Pick<VisualizedSimulatorState, 'addressBookEntries' | 'tokenPriceEstimates' | 'visualizedSimulationState'>

// What a simulation run recorded of its lookups, which an address-book re-label replays instead of making them: the protector chain reads per block and transaction, and every address-book entry its address lookups resolved.
export type RecordedVisualisationLookups = {
	readonly protectorChainReads: readonly (readonly RecordedProtectorChainReads[])[]
	readonly identifiedAddressBookEntries: readonly AddressBookEntry[]
}

// The protector chain reads recorded with each transaction of a stored visualisation, by block, or undefined when a transaction was stored by a version that did not record them. A failed simulation ran no protectors, so it needs none.
function getRecordedProtectorChainReads(visualizedSimulationState: VisualizedSimulationState) {
	if (visualizedSimulationState.success === false) return []
	const recordedByBlock: RecordedProtectorChainReads[][] = []
	for (const block of visualizedSimulationState.visualizedBlocks) {
		const recordedForBlock: RecordedProtectorChainReads[] = []
		for (const transaction of block.simulatedAndVisualizedTransactions) {
			if (transaction.protectorChainReads === undefined) return undefined
			recordedForBlock.push(transaction.protectorChainReads)
		}
		recordedByBlock.push(recordedForBlock)
	}
	return recordedByBlock
}

// What a stored visualisation recorded of its run's lookups, or undefined when it was stored by a version that did not record its protectors' chain reads or the entries its address lookups resolved, so it could only be visualised again by simulating.
export function getRecordedVisualisationLookups(visualizedSimulationState: VisualizedSimulationState): RecordedVisualisationLookups | undefined {
	const protectorChainReads = getRecordedProtectorChainReads(visualizedSimulationState)
	if (protectorChainReads === undefined || visualizedSimulationState.identifiedAddressBookEntries === undefined) return undefined
	return { protectorChainReads, identifiedAddressBookEntries: visualizedSimulationState.identifiedAddressBookEntries }
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
