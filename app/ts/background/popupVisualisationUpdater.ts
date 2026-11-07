// Shared execution layer for popup visualization refreshes; the optional interactive queue adds caller-local scheduling, not global ordering. See docs/popup-simulation-refresh.md.
import type { SimulationServices } from '../simulation/serviceLifecycle.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { CompleteVisualizedSimulation, ResolvedSimulationState, SimulationState } from '../types/visualizer-types.js'
import { createPassthroughCompleteVisualizedSimulation, toResolvedSimulationState } from '../types/visualizer-types.js'
import { NEW_BLOCK_ABORT, TIME_BETWEEN_BLOCKS } from '../utils/constants.js'
import { reportUnexpectedError, isExpectedInfrastructureError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { Semaphore } from '../utils/semaphore.js'
import { getSimulationProviderForSnapshot, requireSimulationSnapshot, type SimulationRead, type SimulationSnapshot, type UnavailableSimulation, getUpdatedSimulationState } from './simulationUpdating.js'
import { requestIsSimulationDataConsumerOpen, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { getPopupVisualisationFingerprint } from './popupSimulationFingerprint.js'
import { retainPreviousVisualisation } from '../utils/popupVisualisationLifecycle.js'
import { visualizeSimulatorState } from './simulationUpdating.js'
import { getPopupVisualisationState, setPopupVisualisationState } from './storageVariables.js'
import { alwaysWrite } from '../utils/largeStateStore.js'
import { snapshotNetworkIsActive } from './networkChangeGeneration.js'
import { readNetworkSnapshotForServices } from './networkTransitionLock.js'

let abortController = new AbortController()

function buildPassthroughVisualizedState(
	simulationId: number,
	numberOfAddressesMadeRich: number,
	simulationResultState: 'done' | 'corrupted' = 'done',
): CompleteVisualizedSimulation {
	return createPassthroughCompleteVisualizedSimulation(simulationId, simulationResultState, numberOfAddressesMadeRich)
}

function buildDefinedEmptyVisualizedState(
	simulationState: Extract<SimulationState, { success: true }>,
	simulationId: number,
	numberOfAddressesMadeRich: number,
): CompleteVisualizedSimulation {
	return {
		simulationUpdatingState: 'done',
		simulationResultState: 'done',
		simulationId,
		simulationState: toResolvedSimulationState(simulationState),
		addressBookEntries: [],
		tokenPriceEstimates: [],
		tokenPriceQuoteToken: undefined,
		namedTokenIds: [],
		visualizedSimulationState: {
			success: true,
			visualizedBlocks: simulationState.simulationStateInput.map((block) => ({
				simulatedAndVisualizedTransactions: [],
				visualizedPersonalSignRequests: [],
				blockTimeManipulation: block.blockTimeManipulation,
			})),
		},
		numberOfAddressesMadeRich,
	}
}

const hasSimulationInputOperations = (simulationState: SimulationState) => (
	simulationState.simulationStateInput.some((block) => block.transactions.length > 0 || block.signedMessages.length > 0)
)

// What a caller with its own snapshot shows when that snapshot has no visualisation; the stored result is shared by every refresh and may describe another network or stack.
export const createUnavailableVisualisation = (): CompleteVisualizedSimulation => ({ ...createPassthroughCompleteVisualizedSimulation(0, 'invalid'), simulationUpdatingState: 'failed' })

// A refresh without a snapshot of its own reads one under the network transition lock, so its settings and stack describe one network. It reads it before waiting for the visualisation semaphore, which a transition takes while holding its lock to publish a failed provider installation. Undefined means these services were replaced: the change that replaced them refreshes its own network, so this refresh has nothing to do.
const readSharedRefreshSnapshot = async (services: SimulationServices) => {
	const { simulation } = await readNetworkSnapshotForServices(services)
	return simulation.kind === 'replaced' ? undefined : requireSimulationSnapshot(simulation)
}

type ReadRefreshSnapshot = () => Promise<SimulationSnapshot | undefined>

type VisualisationRefreshOptions = {
	readonly invalidateOldState?: boolean
	readonly skipIfUnchanged?: boolean
}

export type PopupVisualisationOptions = VisualisationRefreshOptions & {
	readonly onlyIfNotAlreadyUpdating?: boolean
}

// 'not-run': a guard stopped the attempt before it cancelled anything. 'unchanged': the stored visualisation already describes the snapshot's input. 'ran': computed is what the attempt built for its snapshot, undefined if it was superseded or failed.
type VisualisationRefreshAttempt =
	| { readonly status: 'not-run' | 'unchanged' }
	| { readonly status: 'ran', readonly computed: CompleteVisualizedSimulation | undefined }

// The guards of both entry points below, in their order; each entry point only decides what its caller gets for each outcome. The snapshot is read here, after the consumer probe.
const attemptVisualisationRefresh = async (storedVisualisation: CompleteVisualizedSimulation, readSnapshot: ReadRefreshSnapshot, { invalidateOldState = false, skipIfUnchanged = false }: VisualisationRefreshOptions): Promise<VisualisationRefreshAttempt> => {
	const isSimulationDataConsumerOpenReply = await requestIsSimulationDataConsumerOpen()
	if (!(isSimulationDataConsumerOpenReply?.data.isOpen === true)) return { status: 'not-run' }
	const capturedSnapshot = await readSnapshot()
	// A replaced network must neither have its stack simulated nor cancel or invalidate the refresh of the network that replaced it.
	if (capturedSnapshot === undefined || !snapshotNetworkIsActive(capturedSnapshot)) return { status: 'not-run' }
	const provider = getSimulationProviderForSnapshot(capturedSnapshot)
	// Only a completed result may stand in for this refresh: a refresh discarded after its network was replaced can leave the stored result marked updating or invalid, with the same input.
	const storedResultIsComplete = storedVisualisation.simulationUpdatingState === 'done' && storedVisualisation.simulationResultState === 'done'
	if (skipIfUnchanged && storedResultIsComplete && storedVisualisation.simulationState.kind === 'simulated' && provider !== undefined) {
		const currentSimulationInput = await getCurrentSimulationStateInput(provider, capturedSnapshot)
		const currentFingerprint = getPopupVisualisationFingerprint(currentSimulationInput.simulationStateInput, currentSimulationInput.rpcNetwork, currentSimulationInput.blockNumber)
		const cachedFingerprint = getPopupVisualisationFingerprint(
			storedVisualisation.simulationState.value.simulationStateInput,
			storedVisualisation.simulationState.value.rpcNetwork,
			storedVisualisation.simulationState.value.blockNumber,
		)
		if (currentFingerprint === cachedFingerprint && (capturedSnapshot.numberOfAddressesMadeRich === storedVisualisation.numberOfAddressesMadeRich)) return { status: 'unchanged' }
	}
	// The fingerprint check above awaited the provider, so the network is checked again right before cancelling the running refresh.
	if (!snapshotNetworkIsActive(capturedSnapshot)) return { status: 'not-run' }
	abortController.abort(NEW_BLOCK_ABORT)
	abortController = new AbortController()
	const thisAbortController = abortController
	return { status: 'ran', computed: await refreshStoredVisualisation(async () => capturedSnapshot, thisAbortController, false, invalidateOldState) }
}

// Visibility/throttle-aware refresh of the shared visualisation: callers such as block updates can replace obsolete work without entering the interactive queue. Returns the stored visualisation, whichever refresh wrote it.
export const updatePopupVisualisationIfNeeded = async (ethereum: EthereumClientService, tokenPriceService: TokenPriceService, { onlyIfNotAlreadyUpdating = false, ...refreshOptions }: PopupVisualisationOptions = {}): Promise<CompleteVisualizedSimulation> => {
	try {
		const storedVisualisation = await getPopupVisualisationState()
		if (onlyIfNotAlreadyUpdating && updateSimulationVisualisationSemaphore.getPermits() === 0) return storedVisualisation
		if (onlyIfNotAlreadyUpdating && storedVisualisation.simulationState.kind === 'simulated') {
			const ageSeconds = (Date.now()- storedVisualisation.simulationState.value.simulationConductedTimestamp.getTime()) / 1000
			if (ageSeconds < TIME_BETWEEN_BLOCKS) return storedVisualisation
		}
		const attempt = await attemptVisualisationRefresh(storedVisualisation, async () => await readSharedRefreshSnapshot({ ethereum, tokenPriceService }), refreshOptions)
		if (attempt.status !== 'ran') return storedVisualisation
	} catch(error: unknown) {
		if (!isExpectedInfrastructureError(error)) await reportUnexpectedError(error)
	}
	return await getPopupVisualisationState()
}

// The same refresh for the interactive queue, which refreshes with the snapshot its revision was computed from and needs that snapshot's visualisation, so it never reuses a merely recent result. Returns the stored visualisation only when it already describes the snapshot's input, otherwise the one built for the snapshot, or the unavailable state.
export const updatePopupVisualisationForSnapshot = async (snapshot: SimulationSnapshot, refreshOptions: VisualisationRefreshOptions = {}): Promise<CompleteVisualizedSimulation> => {
	try {
		const storedVisualisation = await getPopupVisualisationState()
		const attempt = await attemptVisualisationRefresh(storedVisualisation, async () => snapshot, refreshOptions)
		if (attempt.status === 'unchanged') return storedVisualisation
		// A superseded or failed refresh leaves another refresh's result in storage, which is not this snapshot's.
		return (attempt.status === 'ran' ? attempt.computed : undefined) ?? createUnavailableVisualisation()
	} catch(error: unknown) {
		if (!isExpectedInfrastructureError(error)) await reportUnexpectedError(error)
		return createUnavailableVisualisation()
	}
}

export type ConfirmationVisualisationDependencies = {
	readonly compute?: typeof computeSnapshotVisualisation
	readonly reportError?: typeof reportUnexpectedError
}

// A confirmation window shows the visualisation of its own snapshot, so it is computed for that window and never stored or broadcast as the shared visualisation, which follows the latest stack. A failed computation or an unreadable stack shows the unavailable state, so the rest of the dialog still updates and its queue stays open.
export async function computeConfirmationVisualisation(simulation: SimulationRead, dependencies: ConfirmationVisualisationDependencies = {}) {
	try {
		return await (dependencies.compute ?? computeSnapshotVisualisation)(requireSimulationSnapshot(simulation)) ?? createUnavailableVisualisation()
	} catch (error) {
		if (!isExpectedInfrastructureError(error)) await (dependencies.reportError ?? reportUnexpectedError)(error)
		return createUnavailableVisualisation()
	}
}

const updateSimulationVisualisationSemaphore = new Semaphore(1)
async function storeAndBroadcastFailedVisualisation(shouldWrite: () => boolean) {
	await updateSimulationVisualisationSemaphore.execute(async () => {
		const previous = await getPopupVisualisationState()
		const { status, results: failed } = await setPopupVisualisationState({
			...createPassthroughCompleteVisualizedSimulation(previous.simulationId + 1, 'invalid'),
			simulationUpdatingState: 'failed',
		}, shouldWrite)
		// The write awaited storage, so a change that committed meanwhile is checked for again before announcing it.
		if (status !== 'obsolete' && shouldWrite()) await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState: failed } })
	})
}

// Failed provider preparation must retire old results without executing the retained provider. A failed provider installation retires whatever is stored, whichever network it describes, so the write is unconditioned.
export async function publishFailedPopupVisualisation() {
	abortController.abort(NEW_BLOCK_ABORT)
	await storeAndBroadcastFailedVisualisation(alwaysWrite)
}

// A stack that could not be read retires the stored result too, which may describe a replaced network, but only while its own network is active: a later network's refresh must be neither cancelled nor overwritten.
export async function publishUnavailableSimulationVisualisation(simulation: UnavailableSimulation) {
	if (!snapshotNetworkIsActive(simulation)) return
	abortController.abort(NEW_BLOCK_ABORT)
	await storeAndBroadcastFailedVisualisation(() => snapshotNetworkIsActive(simulation))
}

// Builds the visualisation of one simulation without storing it. Visualising operations queries the services, so abort and fetch errors propagate to the caller.
async function visualiseSimulationState(simulationState: ResolvedSimulationState, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController | undefined, simulationId: number, numberOfAddressesMadeRich: number): Promise<CompleteVisualizedSimulation> {
	if (simulationState.kind === 'passthrough') return buildPassthroughVisualizedState(simulationId, numberOfAddressesMadeRich)
	if (!hasSimulationInputOperations(simulationState.value)) {
		return simulationState.value.success
			? buildDefinedEmptyVisualizedState(simulationState.value, simulationId, numberOfAddressesMadeRich)
			: buildPassthroughVisualizedState(simulationId, numberOfAddressesMadeRich)
	}
	if (ethereum.getChainId() !== simulationState.value.rpcNetwork.chainId) return buildPassthroughVisualizedState(simulationId, numberOfAddressesMadeRich, 'corrupted')
	const refreshed = await visualizeSimulatorState(simulationState.value, ethereum, tokenPriceService, abortController)
	return { ...refreshed, simulationUpdatingState: 'done', simulationResultState: 'done', simulationId, simulationState: toResolvedSimulationState(refreshed.simulationState), numberOfAddressesMadeRich }
}

// Only the shared stored visualisation is ordered by its simulation id; a confirmation's own visualisation is never stored.
const CONFIRMATION_VISUALISATION_ID = 0

// Serialized with the shared refreshes, but neither cancellable by them nor stored. Returns undefined when the visualisation could not be fetched; unexpected errors propagate.
export async function computeSnapshotVisualisation(snapshot: SimulationSnapshot) {
	const { ethereum, tokenPriceService } = snapshot.services
	return await updateSimulationVisualisationSemaphore.execute(async () => {
		const simulationState = await getUpdatedSimulationState(snapshot)
		try {
			return await visualiseSimulationState(simulationState, ethereum, tokenPriceService, undefined, CONFIRMATION_VISUALISATION_ID, snapshot.numberOfAddressesMadeRich)
		} catch (error) {
			if (isNewBlockAbort(error) || isFailedToFetchError(error)) return undefined
			throw error
		}
	})
}

// Serialized refresh of the shared visualisation without a visibility probe; persistence callers can require unexpected errors to propagate. Invalidating the stored result runs in the same serialized section, so it cannot overwrite a result that a refresh of a newer network stored meanwhile. Returns the visualisation built for the snapshot, not the stored one, which a newer refresh may have written; undefined when the update was aborted, failed or its network was replaced.
export async function updatePopupVisualisationState(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, abortController: AbortController | undefined, throwOnUnexpectedError = false) {
	return await refreshStoredVisualisation(async () => await readSharedRefreshSnapshot({ ethereum, tokenPriceService }), abortController, throwOnUnexpectedError, false)
}

async function refreshStoredVisualisation(readSnapshot: ReadRefreshSnapshot, abortController: AbortController | undefined, throwOnUnexpectedError: boolean, invalidateOldState: boolean) {
	try {
		const capturedSnapshot = await readSnapshot()
		if (capturedSnapshot === undefined) return undefined
		const { ethereum, tokenPriceService } = capturedSnapshot.services
		return await updateSimulationVisualisationSemaphore.execute(async () => {
			if (abortController?.signal.aborted) return undefined
			// A replaced network cannot have its stack simulated; the refresh that follows the change publishes that network's result.
			if (!snapshotNetworkIsActive(capturedSnapshot)) return undefined
			// Every store and broadcast of this refresh first checks that its network is still active, so a replaced network's result never overwrites or announces over the newer network's.
			const storeIfNetworkActive = async (state: CompleteVisualizedSimulation) => {
				const { status, results } = await setPopupVisualisationState(state, () => snapshotNetworkIsActive(capturedSnapshot))
				return status === 'obsolete' ? undefined : results
			}
			const broadcastIfNetworkActive = async (visualizedSimulatorState: CompleteVisualizedSimulation) => {
				if (snapshotNetworkIsActive(capturedSnapshot)) await sendPopupMessageToOpenWindows({ method: 'popup_simulation_state_changed', data: { visualizedSimulatorState } })
			}
			let popupVisualisation = await getPopupVisualisationState()
			if (invalidateOldState) {
				const invalidated = await storeIfNetworkActive(retainPreviousVisualisation(popupVisualisation, { simulationId: popupVisualisation.simulationId + 1, simulationUpdatingState: 'updating', simulationResultState: 'invalid' }))
				if (invalidated === undefined) return undefined
				await broadcastIfNetworkActive(invalidated)
				popupVisualisation = invalidated
			}
			const simulationId = popupVisualisation.simulationId + 1
			const simulationState = await getUpdatedSimulationState(capturedSnapshot)
			const numberOfAddressesMadeRich = capturedSnapshot.numberOfAddressesMadeRich
			if (simulationState.kind === 'passthrough' || !hasSimulationInputOperations(simulationState.value)) {
				const newState = await visualiseSimulationState(simulationState, ethereum, tokenPriceService, abortController, simulationId, numberOfAddressesMadeRich)
				if (await storeIfNetworkActive(newState) === undefined) return undefined
				await broadcastIfNetworkActive(newState)
				return newState
			}
			const visualizedSimulatorState = await storeIfNetworkActive(retainPreviousVisualisation(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
			if (visualizedSimulatorState === undefined) return undefined
			const changedMessagePromise = silenceChromeUnCaughtPromise(broadcastIfNetworkActive(visualizedSimulatorState))
			try {
				const newVisualizedState = await visualiseSimulationState(simulationState, ethereum, tokenPriceService, abortController, simulationId, numberOfAddressesMadeRich)
				const storedVisualizedState = await storeIfNetworkActive(newVisualizedState)
				await changedMessagePromise
				if (storedVisualizedState === undefined) return undefined
				await broadcastIfNetworkActive(storedVisualizedState)
				return newVisualizedState
			} catch (error) {
				if (isNewBlockAbort(error)) return undefined
				if (isFailedToFetchError(error)) {
					const state = await storeIfNetworkActive(retainPreviousVisualisation(popupVisualisation, { simulationId, simulationUpdatingState: 'updating' }))
					if (state !== undefined) await broadcastIfNetworkActive(state)
					return undefined
				}
				if (throwOnUnexpectedError) throw error
				const state = await storeIfNetworkActive(retainPreviousVisualisation(popupVisualisation, { simulationId, simulationUpdatingState: 'failed' }))
				if (state !== undefined) await broadcastIfNetworkActive(state)
				await reportUnexpectedError(error)
				return undefined
			}
		})
	} catch (error) {
		if (throwOnUnexpectedError) throw error
		if (isExpectedInfrastructureError(error)) return undefined
		await reportUnexpectedError(error)
	}
	return undefined
}

async function getCurrentSimulationStateInput(ethereum: EthereumClientService, snapshot: SimulationSnapshot) {
	return {
		simulationStateInput: snapshot.simulationStateInput,
		rpcNetwork: ethereum.getRpcEntry(),
		blockNumber: await ethereum.getBlockNumber(undefined),
	}
}
