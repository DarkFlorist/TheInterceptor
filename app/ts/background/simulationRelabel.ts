// The one metadata re-label of a stored simulation result, shared by the stack re-label (relabelPopupVisualisation) and the displayed confirmation re-label (relabelDisplayedConfirmationSimulation); see "Address-book re-labels" in docs/popup-simulation-refresh.md.
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { SimulationState } from '../types/visualizer-types.js'
import { visualizeSimulatorState } from './simulationUpdating.js'

type SimulationMetadata = Omit<Awaited<ReturnType<typeof visualizeSimulatorState>>, 'simulationState'>

// A stored simulation run whose metadata a re-label may replace.
export type SimulationRunToRelabel<Stored> = {
	// Every new stack or confirmation simulation run stores a new id, so a run stored during the re-label's lookups has another id even on the same block within the same second.
	readonly simulationId: number
	readonly simulationState: SimulationState
	// The stored result with only its metadata replaced, keeping the simulation, its id, its timestamps and any approval status.
	readonly withMetadata: (metadata: SimulationMetadata) => Stored
}

type StoredSimulationRelabel<Stored> = {
	// Read by the caller under whatever serialization it needs against other writers of the stored result.
	readonly stored: Stored
	// Returns the run when the stored result can be re-labelled (a finished simulation on the services' chain), otherwise undefined. Checked on the stored result before the lookups and again on the current result at the write.
	readonly getRunToRelabel: (stored: Stored) => SimulationRunToRelabel<Stored> | undefined
	// Atomically replaces the stored result with relabel(current), or keeps it when relabel returns undefined.
	readonly updateStored: (relabel: (current: Stored) => Stored | undefined) => Promise<unknown>
	// Aborted by newer work that replaces the stored result and stores its own.
	readonly abortController: AbortController
}

// Re-runs only the visualisation step (address-book names, ABI-parsed input, token metadata and prices, and protector warnings such as send-to-non-contact) for a stored run without simulating again, then writes the new metadata only onto that same run.
export async function relabelStoredSimulation<Stored>(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, { stored, getRunToRelabel, updateStored, abortController }: StoredSimulationRelabel<Stored>) {
	const runToRelabel = getRunToRelabel(stored)
	if (runToRelabel === undefined) return
	// The re-visualised simulation state is dropped so the stored one, including its conducted timestamp, is kept.
	const { simulationState: _revisualizedSimulationState, ...metadata } = await visualizeSimulatorState(runToRelabel.simulationState, ethereum, tokenPriceService, abortController)
	// Lookups that made no further RPC request do not notice an abort; the newer work that aborted this re-label stores its own result instead.
	if (abortController.signal.aborted) return
	await updateStored((current) => {
		// The stale-write guard: a newer run stored meanwhile has another id, and a result stored under the same id that can no longer be re-labelled (a stack invalidation keeps the id of the run it raced with) is left alone.
		const currentRun = getRunToRelabel(current)
		if (currentRun === undefined || currentRun.simulationId !== runToRelabel.simulationId) return undefined
		return currentRun.withMetadata(metadata)
	})
}
