import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { PASSTHROUGH_STATE, type ResolvedExecutionSimulationState, type ResolvedSimulationInput, type SignedMessageTransaction, toResolvedExecutionSimulationState, toResolvedSimulationInput } from '../types/visualizer-types.js'
import { buildExecutionSimulationStateFromPreparedInput, getCurrentSimulationInput, prepareSimulationInputForRpc } from './simulationUpdating.js'

// One RPC request's lazily built view of the simulation. Every accessor derives from a single gated stack snapshot, so all of them agree on whether the simulation overlay applies and on which stack they see, even if the stack changes while the request runs.
export const createRequestSimulationView = (ethereum: EthereumClientService, simulationOverlayEnabled: boolean) => {
	let simulationStackSnapshotPromise: Promise<ResolvedSimulationInput> | undefined
	let simulationInputPromise: Promise<ResolvedSimulationInput> | undefined
	let executionSimulationStatePromise: Promise<ResolvedExecutionSimulationState> | undefined
	const getSimulationStackSnapshot = async () => {
		if (!simulationOverlayEnabled) return PASSTHROUGH_STATE
		if (simulationStackSnapshotPromise === undefined) simulationStackSnapshotPromise = (async () => toResolvedSimulationInput(await getCurrentSimulationInput()))()
		return await simulationStackSnapshotPromise
	}
	const getSimulationInput = async () => {
		if (simulationInputPromise === undefined) simulationInputPromise = (async () => {
			const simulationStackSnapshot = await getSimulationStackSnapshot()
			if (simulationStackSnapshot.kind === 'passthrough') return PASSTHROUGH_STATE
			return toResolvedSimulationInput(await prepareSimulationInputForRpc(simulationStackSnapshot.value, ethereum))
		})()
		return await simulationInputPromise
	}
	const getExecutionSimulationState = async () => {
		if (executionSimulationStatePromise === undefined) executionSimulationStatePromise = (async () => {
			const simulationInput = await getSimulationInput()
			if (simulationInput.kind === 'passthrough') return PASSTHROUGH_STATE
			return toResolvedExecutionSimulationState(await buildExecutionSimulationStateFromPreparedInput(simulationInput.value, ethereum))
		})()
		return await executionSimulationStatePromise
	}
	// RPC preparation rewrites transactions and state overrides but never signed messages, so they come straight from the snapshot without touching the RPC.
	const getSimulatedSignedMessages = async (): Promise<readonly SignedMessageTransaction[]> => {
		const simulationStackSnapshot = await getSimulationStackSnapshot()
		if (simulationStackSnapshot.kind === 'passthrough') return []
		return simulationStackSnapshot.value.flatMap((block) => block.signedMessages)
	}
	return { getSimulationInput, getExecutionSimulationState, getSimulatedSignedMessages }
}
