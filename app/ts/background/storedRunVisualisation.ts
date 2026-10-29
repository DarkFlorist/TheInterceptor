// Visualises a stored simulation run again from stored data alone, for an address-book re-label. It builds the VisualisationLookups that a simulation run builds on the node (visualizeSimulatorState in simulationUpdating.ts) from local data and what the run recorded, so it makes no RPC request; both go through the same visualisation. See "Address-book re-labels" in docs/popup-simulation-refresh.md.
import { replayRecordedProtectorChainReads } from '../simulation/protectorChainReads.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { RecordedVisualisationLookups, SimulationState, VisualizedSimulationState, VisualizedSimulatorState } from '../types/visualizer-types.js'
import { addressString } from '../utils/bigint.js'
import { lookUpMetadataForRelabel } from './metadataUtils.js'
import { type VisualisationLookups, visualizeSimulatorStateWithLookups } from './simulationUpdating.js'

// The parts of a stored run that an address-book re-label starts from: its stored visualisation and what the run recorded of its lookups, which runs stored by older versions lack.
export type StoredSimulationMetadata = Pick<VisualizedSimulatorState, 'addressBookEntries' | 'tokenPriceEstimates' | 'visualizedSimulationState'> & {
	readonly recordedVisualisationLookups?: RecordedVisualisationLookups | undefined
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
