import { publishFailedPopupVisualisation } from './popupVisualisationUpdater.js'
import { queuePopupSimulationRefresh } from './popupSimulationRefreshQueue.js'
import type { SimulationServices, SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import { getRpcNetworkChange, isSignerOnlyNetwork } from '../utils/rpcNetworkChange.js'
import type { RpcNetwork } from '../types/rpc.js'
import { reportUnexpectedError } from '../utils/errors.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { Semaphore } from '../utils/semaphore.js'
import { sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts } from './accessManagement.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { changeSimulationMode, getSettings, importSettingsAndAddressBook } from './settings.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { ExportedSettings } from '../types/exportedSettingsTypes.js'
import { getPrimaryRpcForChain, updateInterceptorTransactionStack, updateTransactionState } from './storageVariables.js'
import { buildSimulationSnapshot, captureSimulationSnapshot, type NetworkState, readSimulationInputSources, type SimulationSnapshot } from './simulationUpdating.js'
import { assertNever } from '../utils/typescript.js'
import type { InterceptorStackOperation } from '../types/visualizer-types.js'
import { activeStackContextsEqual, getActiveStackContext, operationBelongsToActiveStackContext, SIMULATION_STACK_CONTEXT } from '../utils/activeStackContext.js'

// The lock that every writer of the active network or of the installed services runs in, the effects a committed network change still owes, and the network snapshots that requests read under the same lock. activeSettings.ts builds address and chain changes on top of it.

async function clearSimulationStackContext() {
	await updateTransactionState((previousState) => ({
		interceptorTransactionStack: {
			operations: previousState.interceptorTransactionStack.operations.filter((operation) => !operationBelongsToActiveStackContext(operation, SIMULATION_STACK_CONTEXT)),
		},
		safeTransactionStacks: previousState.safeTransactionStacks,
	}))
}

const networkTransitionSemaphore = new Semaphore(1)

type NetworkChangeEffect = 'installServices' | 'clearStackForChangedChain' | 'notifyWebsitesOfChainChange' | 'notifyPopupsOfChainChange'
const NETWORK_CHANGE_EFFECTS = ['installServices', 'clearStackForChangedChain', 'notifyWebsitesOfChainChange', 'notifyPopupsOfChainChange'] as const

type CommittedNetworkChange = {
	readonly simulationServicesOwner: SimulationServicesOwner
	readonly websiteTabConnections: WebsiteTabConnections
	readonly settingsBeforeTransition: Settings
	readonly completedEffects: Set<NetworkChangeEffect>
}

// Effects that a failed transition could not complete. They belong to the lock rather than to a call chain: the failed transition has already thrown to its caller, so the next lock holder, a read included, completes them before it acts on the committed network. They live in memory only, so after a background restart services are rebuilt from the settings and websites receive the chain when they reconnect, but a stack left from the previous chain is not cleared.
let unfinishedNetworkChange: CommittedNetworkChange | undefined

// Every effect is idempotent or recorded once it succeeds: installation compares with the installed client, clearing the active stack context twice is harmless, and websites are notified once per committed change. Popup notifications are best-effort.
async function runNetworkChangeEffect(change: CommittedNetworkChange, effect: NetworkChangeEffect, updatedSettings: Settings) {
	if (change.completedEffects.has(effect)) return
	const chainChanged = getRpcNetworkChange(change.settingsBeforeTransition.activeRpcNetwork, updatedSettings.activeRpcNetwork).chainChanged
	switch (effect) {
		case 'installServices': {
			await installServicesForCommittedNetwork(change.simulationServicesOwner, updatedSettings.activeRpcNetwork)
			break
		}
		case 'clearStackForChangedChain': {
			// Simulation stack contexts carry no chain, so their operations are dropped whenever the active chain changes, in either mode; Gnosis Safe stacks are kept per chain.
			if (chainChanged) await clearSimulationStackContext()
			break
		}
		case 'notifyWebsitesOfChainChange': {
			if (chainChanged) sendMessageToApprovedWebsitePorts(change.websiteTabConnections, { method: 'chainChanged', result: updatedSettings.activeRpcNetwork.chainId })
			break
		}
		case 'notifyPopupsOfChainChange': {
			// Popup delivery is best-effort throughout the background and popups also refresh on the settings broadcast, so a failed delivery is reported but cannot block requests.
			if (chainChanged) await sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
			break
		}
		default: assertNever(effect)
	}
	change.completedEffects.add(effect)
}

// Retries the unfinished effects in commit order against the committed settings, so websites hear of the chain only once its state is complete. While one still fails, the rest stay recorded and this throws, so no lock holder proceeds on a network whose effects are incomplete.
async function completeUnfinishedNetworkChange() {
	const change = unfinishedNetworkChange
	if (change === undefined) return
	const committedSettings = await getSettings()
	for (const effect of NETWORK_CHANGE_EFFECTS) await runNetworkChangeEffect(change, effect, committedSettings)
	unfinishedNetworkChange = undefined
}

// Every writer of the active network or of the installed services runs inside this lock, after the effects of an earlier failed transition are completed. It is not reentrant, so the task must not start another transition or read a network snapshot.
export async function runNetworkTransition<T>(task: () => Promise<T>): Promise<T> {
	return await networkTransitionSemaphore.execute(async () => {
		await completeUnfinishedNetworkChange()
		return await task()
	})
}

async function captureNetworkState(): Promise<NetworkState> {
	const settings = await getSettings()
	return { settings, simulation: await captureSimulationSnapshot(settings) }
}

// Reading these under the transition lock keeps a request from pairing one network's settings, stack or services with another network's; it reads storage only, so RPC work stays outside the lock. Like every lock holder, a read first finishes the effects of a committed network change whose transition failed part-way, such as dropping the previous chain's stack, and rejects with that failure rather than return a snapshot that mixes two networks.
export async function readNetworkSnapshot(simulationServicesOwner: SimulationServicesOwner) {
	return await runNetworkTransition(async () => ({ ...await captureNetworkState(), services: simulationServicesOwner.getCurrent() }))
}

// The settings and stack as they are now, for work that changed the stack after its snapshot was read.
export async function readNetworkState() {
	return await runNetworkTransition(captureNetworkState)
}

const isSameStackOperation = (stacked: InterceptorStackOperation, operation: InterceptorStackOperation) => {
	if (stacked.type === 'Transaction' && operation.type === 'Transaction') return stacked.preSimulationTransaction.transactionIdentifier === operation.preSimulationTransaction.transactionIdentifier
	if (stacked.type === 'Message' && operation.type === 'Message') return stacked.signedMessageTransaction.messageIdentifier === operation.signedMessageTransaction.messageIdentifier
	return false
}

// A confirmed simulation operation joins the stack only while the chain it was simulated on is still active in simulation mode. Returns the stacked operation with the settings, stack snapshot and services read under the same lock, or undefined if that network went away.
export async function appendToActiveSimulationStack(simulationServicesOwner: SimulationServicesOwner, operation: InterceptorStackOperation, simulatedChainId: bigint | undefined) {
	return await runNetworkTransition(async () => {
		const settings = await getSettings()
		if (!settings.simulationMode) return undefined
		if (simulatedChainId !== undefined && simulatedChainId !== settings.activeRpcNetwork.chainId) return undefined
		// Everything the resulting snapshot needs is read before the write, so a failed read cannot leave the operation stacked behind an unfinished confirmation.
		const sources = await readSimulationInputSources(settings)
		// An operation already on the stack was appended by an earlier attempt of this confirmation, which may now finish.
		const interceptorTransactionStack = await updateInterceptorTransactionStack((previousStack) => previousStack.operations.some((stacked) => isSameStackOperation(stacked, operation))
			? previousStack
			: { operations: [...previousStack.operations, operation] })
		// The confirmation reports the stacked operation, which an earlier attempt may have prepared differently.
		const stackedOperation = interceptorTransactionStack.operations.find((stacked) => isSameStackOperation(stacked, operation)) ?? operation
		return { stackedOperation, settings, simulation: buildSimulationSnapshot(settings, sources, interceptorTransactionStack), services: simulationServicesOwner.getCurrent() }
	})
}

// Compares with the installed client rather than the previous settings, so a transition that failed part-way is repaired by its retry. A signer-only network keeps the previous provider because it has no endpoint to install.
async function installServicesForCommittedNetwork(simulationServicesOwner: SimulationServicesOwner, committedRpcNetwork: RpcNetwork) {
	if (committedRpcNetwork.httpsRpc === undefined) return
	if (!getRpcNetworkChange(simulationServicesOwner.getCurrent().ethereum.getRpcEntry(), committedRpcNetwork).endpointChanged) return
	try {
		simulationServicesOwner.reset(committedRpcNetwork)
	} catch (error) {
		// Only failed provider installation invalidates simulation output here.
		await publishFailedPopupVisualisation()
		throw error
	}
}

type CommittedNetworkEffects = {
	readonly installServices: (updatedSettings: Settings) => Promise<void>
	readonly clearStackForChangedChain: (updatedSettings: Settings) => Promise<void>
	readonly notifyChainChange: (updatedSettings: Settings) => Promise<void>
}

// Runs settings writes that may commit a new network; each effect of the committed network is compared with the settings from before the transition. If the transition fails, every effect that has not succeeded is retried before the lock is released and, if one still fails, kept for the next lock holder; the transition's own error is kept.
export async function runSettingsTransition<T>(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	transition: (settingsBeforeTransition: Settings, effects: CommittedNetworkEffects) => Promise<T>,
): Promise<T> {
	return await runNetworkTransition(async () => {
		const settingsBeforeTransition = await getSettings()
		const change: CommittedNetworkChange = { simulationServicesOwner, websiteTabConnections, settingsBeforeTransition, completedEffects: new Set() }
		const effects: CommittedNetworkEffects = {
			installServices: async (updatedSettings) => await runNetworkChangeEffect(change, 'installServices', updatedSettings),
			clearStackForChangedChain: async (updatedSettings) => await runNetworkChangeEffect(change, 'clearStackForChangedChain', updatedSettings),
			notifyChainChange: async (updatedSettings) => {
				await runNetworkChangeEffect(change, 'notifyWebsitesOfChainChange', updatedSettings)
				await runNetworkChangeEffect(change, 'notifyPopupsOfChainChange', updatedSettings)
			},
		}
		try {
			return await transition(settingsBeforeTransition, effects)
		} catch (error) {
			unfinishedNetworkChange = change
			try {
				await completeUnfinishedNetworkChange()
			} catch (repairError: unknown) {
				await reportUnexpectedError(repairError)
			}
			throw error
		}
	})
}

// A popup refresh that a committed change needs: its services and snapshot are read under the lock, and it is simulated after the lock is released, so requests waiting for the lock do not wait for the simulation.
type PendingPopupRefresh = { readonly services: SimulationServices, readonly snapshot: SimulationSnapshot }

export async function runPendingPopupRefresh(refresh: PendingPopupRefresh | undefined) {
	if (refresh !== undefined) await queuePopupSimulationRefresh(refresh.services, refresh.snapshot)
}

// Notifies popups and approved websites inside the lock, so they see network changes in commit order; the installed services already match the committed network. Returns the popup refresh for the caller to run after the lock.
export async function publishCommittedSettingsChange(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, effects: CommittedNetworkEffects, previousSettings: Settings, updatedSettings: Settings): Promise<PendingPopupRefresh | undefined> {
	const { endpointChanged } = getRpcNetworkChange(previousSettings.activeRpcNetwork, updatedSettings.activeRpcNetwork)
	await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	await effects.notifyChainChange(updatedSettings)
	// External-wallet signing has no simulated stack; Safe signing retains its separate stack visualization.
	const needsPopupRefresh = (updatedSettings.simulationMode || updatedSettings.activeSigningSafeAddress !== undefined) && (endpointChanged || !activeStackContextsEqual(getActiveStackContext(previousSettings), getActiveStackContext(updatedSettings)))
	const popupRefresh = needsPopupRefresh ? { services: simulationServicesOwner.getCurrent(), snapshot: await captureSimulationSnapshot() } : undefined
	await sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, await getSettings())
	return popupRefresh
}

// An RPC list update can make another endpoint the active chain's primary. Settings then select that primary together with its services, like a switch to it would; a signer-only selection has no endpoint to replace.
export async function selectUpdatedPrimaryRpcTransition(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections) {
	await runPendingPopupRefresh(await runSettingsTransition(simulationServicesOwner, websiteTabConnections, async (previousSettings, effects) => {
		if (isSignerOnlyNetwork(previousSettings.activeRpcNetwork)) return undefined
		const primary = await getPrimaryRpcForChain(previousSettings.activeRpcNetwork.chainId)
		if (primary === undefined || !getRpcNetworkChange(previousSettings.activeRpcNetwork, primary).endpointChanged) return undefined
		await changeSimulationMode({ simulationMode: previousSettings.simulationMode, rpcNetwork: primary })
		const updatedSettings = await getSettings()
		try {
			await effects.installServices(updatedSettings)
		} finally {
			// Publish committed settings even if installing their services fails.
			await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: updatedSettings, popupRefreshGeneration: bumpPopupRefreshGeneration() })
		}
		return await publishCommittedSettingsChange(simulationServicesOwner, websiteTabConnections, effects, previousSettings, updatedSettings)
	}))
}

// An import can change the active network like a switch does; the popup handler then reconciles website approvals and publishes the imported settings.
export async function importSettingsTransition(simulationServicesOwner: SimulationServicesOwner, websiteTabConnections: WebsiteTabConnections, exportedSettings: ExportedSettings) {
	await runPendingPopupRefresh(await runSettingsTransition(simulationServicesOwner, websiteTabConnections, async (settingsBeforeImport, effects) => {
		await importSettingsAndAddressBook(exportedSettings)
		const importedSettings = await getSettings()
		await effects.installServices(importedSettings)
		await effects.clearStackForChangedChain(importedSettings)
		return await publishCommittedSettingsChange(simulationServicesOwner, websiteTabConnections, effects, settingsBeforeImport, importedSettings)
	}))
}
