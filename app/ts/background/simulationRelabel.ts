import { isMissingRecordedProtectorReadError } from '../simulation/protectorChainReads.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { SimulationState, StoredCompleteVisualizedSimulation } from '../types/visualizer-types.js'
import { type StoredSimulationMetadata, visualizeStoredRunWithoutNode } from './storedRunVisualisation.js'

type SimulationMetadata = Omit<NonNullable<Awaited<ReturnType<typeof visualizeStoredRunWithoutNode>>>, 'simulationState'>

export type StackRunToRelabel = {
	readonly simulationId: number
	readonly simulationState: SimulationState
	readonly storedMetadata: StoredSimulationMetadata
	readonly withMetadata: (metadata: SimulationMetadata) => StoredCompleteVisualizedSimulation
}

async function readRelabelledStackMetadata(run: StackRunToRelabel, rpcNetwork: RpcNetwork): Promise<SimulationMetadata | undefined> {
	// Legacy runs may lack the reads today's protectors need. A fresh simulation will record them.
	const recorded = run.storedMetadata.recordedVisualisationLookups
	if (recorded === undefined) return undefined
	try {
		const visualisation = await visualizeStoredRunWithoutNode(run.simulationState, run.storedMetadata, recorded, rpcNetwork)
		if (visualisation === undefined) return undefined
		const { simulationState: _simulationState, ...metadata } = visualisation
		return metadata
	} catch (error: unknown) {
		if (isMissingRecordedProtectorReadError(error)) return undefined
		throw error
	}
}

// Replays the stored stack visualization without RPC and applies the metadata only if the same eligible stack run is still current.
export async function relabelStoredSimulation(rpcNetwork: RpcNetwork, { stored, getRunToRelabel, updateStored }: {
	readonly stored: StoredCompleteVisualizedSimulation
	readonly getRunToRelabel: (stored: StoredCompleteVisualizedSimulation) => StackRunToRelabel | undefined
	readonly updateStored: (relabel: (current: StoredCompleteVisualizedSimulation) => StoredCompleteVisualizedSimulation | undefined) => Promise<unknown>
}) {
	const run = getRunToRelabel(stored)
	if (run === undefined) return
	const metadata = await readRelabelledStackMetadata(run, rpcNetwork)
	if (metadata === undefined) return
	await updateStored((current) => {
		const currentRun = getRunToRelabel(current)
		if (currentRun === undefined || currentRun.simulationId !== run.simulationId) return undefined
		return currentRun.withMetadata(metadata)
	})
}
