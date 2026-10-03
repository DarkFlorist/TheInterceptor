import { publishFailedPopupVisualisation } from './popupVisualisationUpdater.js'
import { queuePopupSimulationRefresh } from './popupSimulationRefreshQueue.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { SigningAddressPreference } from '../types/signerTypes.js'
import { getRpcNetworkChange } from '../utils/rpcNetworkChange.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { Semaphore } from '../utils/semaphore.js'
import type { WebsiteAccessUpdate } from './accessManagement.js'
import { reconcileWebsiteApprovalAccesses, finishWebsiteAccessUpdate, sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts } from './accessManagement.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { changeSimulationMode, getRequiredSettings, getSettingsSnapshot, requireSettings, setUseSignersAddressAsActiveAddress, trackPreviousActiveAddressForMakeMeRichList } from './settings.js'
import { updateTransactionState } from './storageVariables.js'
import type { ActiveAddressSelection } from '../utils/activeAddressSelection.js'
import { rememberSigningAddressSelection } from './signingAddressSelection.js'
import { activeStackContextsEqual, getActiveStackContext, operationBelongsToActiveStackContext } from '../utils/activeStackContext.js'
import { rpcConfigurationIsUsable, rpcServicesAreOptional } from './rpcConfigurationAvailability.js'

async function clearSimulationStateFromConfig(settingsSnapshot?: Awaited<ReturnType<typeof getRequiredSettings>>) {
	const settings = settingsSnapshot ?? await getRequiredSettings()
	const activeStackContext = getActiveStackContext(settings)
	await updateTransactionState((previousState) => {
		if (settings.simulationMode) {
			return {
				interceptorTransactionStack: {
					operations: previousState.interceptorTransactionStack.operations.filter((operation) =>
						!operationBelongsToActiveStackContext(operation, activeStackContext)
					),
				},
				safeTransactionStacks: previousState.safeTransactionStacks,
			}
		}
		const activeSafeAddress = settings.activeSigningSafeAddress
		const activeChainId = settings.activeRpcNetwork.chainId
		return {
			interceptorTransactionStack: {
				operations: previousState.interceptorTransactionStack.operations.filter((operation) =>
					!operationBelongsToActiveStackContext(operation, activeStackContext)
				),
			},
			safeTransactionStacks: previousState.safeTransactionStacks.filter((stack) =>
				stack.safeAddress !== activeSafeAddress || stack.chainId !== activeChainId
			),
		}
	})
}

export async function resetSimulationStateFromConfig(simulationServicesOwner: SimulationServicesOwner) {
	await clearSimulationStateFromConfig()
	await queuePopupSimulationRefresh({ ...simulationServicesOwner.requireCurrent(), invalidateOldState: true })
}

const keepTrackOfPreviousAddressForRichList = async () => {
	const previousActiveAddress = (await getRequiredSettings()).activeSimulationAddress
	await trackPreviousActiveAddressForMakeMeRichList(previousActiveAddress)
}

type ActiveAddressAndChainChange = {
	simulationMode: boolean
	activeAddress?: bigint
	signingAddressSelection?: 'signer' | 'safe'
	rpcNetwork?: RpcNetwork
	promptForAccessesIfNeeded?: boolean
}

type ActiveSettingsTransition = {
	readonly change: ActiveAddressAndChainChange
	readonly simulationSignerSelection?: { readonly useSignerAddress: boolean, readonly signerAddress: bigint | undefined }
	readonly signingPreference?: SigningAddressPreference
}

const changeActiveAddressAndChainSemaphore = new Semaphore(1)

async function publishCommittedSettingsTransition(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	previousSettings: Awaited<ReturnType<typeof getRequiredSettings>>,
	updatedSettings: Awaited<ReturnType<typeof getRequiredSettings>>,
	onAccessReconciled: (accessUpdate: WebsiteAccessUpdate) => void,
	forceChainChanged = false,
) {
	const networkChange = getRpcNetworkChange(previousSettings.activeRpcNetwork, updatedSettings.activeRpcNetwork)
	const rpcChainChanged = forceChainChanged || networkChange.chainChanged
	const rpcEndpointChanged = forceChainChanged || networkChange.endpointChanged
	try {
		try {
			if (updatedSettings.simulationMode && rpcChainChanged) await clearSimulationStateFromConfig(updatedSettings)
		} finally {
			await sendPopupMessageToOpenWindows({
				method: 'popup_settingsUpdated', data: updatedSettings, popupRefreshGeneration: bumpPopupRefreshGeneration(),
			})
		}
	} finally {
		onAccessReconciled(await reconcileWebsiteApprovalAccesses(websiteTabConnections, updatedSettings))
	}
	await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	if (rpcChainChanged) {
		sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'chainChanged', result: updatedSettings.activeRpcNetwork.chainId })
		await sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
	}
	if (simulationServicesOwner.getCurrent() !== undefined && (updatedSettings.simulationMode || updatedSettings.activeSigningSafeAddress !== undefined) && (rpcEndpointChanged || !activeStackContextsEqual(getActiveStackContext(previousSettings), getActiveStackContext(updatedSettings)))) {
		await queuePopupSimulationRefresh(simulationServicesOwner.requireCurrent())
	}
	await sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, await getRequiredSettings())
}

export async function publishRpcConfigurationRecovery(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	previousSettings: Awaited<ReturnType<typeof getRequiredSettings>>,
	activeRpcNetwork: RpcNetwork,
	forceChainChanged = false,
) {
	let accessUpdate: WebsiteAccessUpdate | undefined
	try {
		const updatedSettings = await getRequiredSettings()
		if (getRpcNetworkChange(updatedSettings.activeRpcNetwork, activeRpcNetwork).selectionChanged) throw new Error('Recovered RPC network does not match the committed configuration.')
		await publishCommittedSettingsTransition(
			simulationServicesOwner,
			websiteTabConnections,
			previousSettings,
			updatedSettings,
			(update) => { accessUpdate = update },
			forceChainChanged,
		)
	} finally {
		if (accessUpdate !== undefined) await finishWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, accessUpdate, true)
	}
}

async function runActiveSettingsChange(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	transition: ActiveSettingsTransition,
): Promise<void> {
	const { change } = transition
	let accessUpdate: WebsiteAccessUpdate | undefined
	try {
		// Settings, approvals, resets, notifications and selection preferences form one ordered transition.
		await changeActiveAddressAndChainSemaphore.execute(async () => {
			const previousSnapshot = await getSettingsSnapshot()
			const previousSettings = requireSettings(previousSnapshot)
			const rpcServicesOptional = rpcServicesAreOptional(previousSnapshot.rpcConfiguration)
			const recoverServicesOnRpcSelection = simulationServicesOwner.getCurrent() === undefined && rpcServicesOptional
			if (!rpcConfigurationIsUsable(previousSnapshot.rpcConfiguration, simulationServicesOwner)) throw new Error('RPC configuration is unavailable. Settings changes are paused until it is restored.')
			if (transition.simulationSignerSelection !== undefined) {
				const { useSignerAddress, signerAddress } = transition.simulationSignerSelection
				await setUseSignersAddressAsActiveAddress(useSignerAddress, signerAddress)
			}
			if (change.simulationMode && change.activeAddress !== undefined) await keepTrackOfPreviousAddressForRichList()

			if (change.simulationMode) {
				await changeSimulationMode({
					simulationMode: change.simulationMode,
					...('activeAddress' in change ? { activeSimulationAddress: change.activeAddress } : {}),
					...(change.rpcNetwork !== undefined ? { rpcNetwork: change.rpcNetwork } : {}),
				})
			} else {
				if ('activeAddress' in change && change.signingAddressSelection === undefined) throw new Error('Signing address changes must identify whether the selection is the signer or a Safe.')
				const selectsSafe = change.signingAddressSelection === 'safe'
				await changeSimulationMode({
					simulationMode: change.simulationMode,
					...(!selectsSafe && 'activeAddress' in change ? { activeSigningAddress: change.activeAddress } : {}),
					...('activeAddress' in change ? { activeSigningSafeAddress: selectsSafe ? change.activeAddress : undefined } : {}),
					...(change.rpcNetwork !== undefined ? { rpcNetwork: change.rpcNetwork } : {}),
				})
			}

			const updatedSettings = await getRequiredSettings()
			try {
				// The preference belongs to the committed selection, even if later provider preparation fails.
				if (transition.signingPreference !== undefined) await rememberSigningAddressSelection(transition.signingPreference)
				const { endpointChanged: rpcEndpointChanged } = getRpcNetworkChange(previousSettings.activeRpcNetwork, updatedSettings.activeRpcNetwork)
				// A signer-only chain has no provider to install; simulation is disabled until a configured endpoint is selected.
				if (rpcEndpointChanged && change.rpcNetwork?.httpsRpc !== undefined) {
					try {
						if (simulationServicesOwner.getCurrent() !== undefined) simulationServicesOwner.reset(change.rpcNetwork)
						else if (recoverServicesOnRpcSelection) simulationServicesOwner.recover(change.rpcNetwork)
						else throw new Error('RPC configuration became unavailable while changing settings.')
					} catch (error) {
						// Only failed provider installation invalidates simulation output here.
						await publishFailedPopupVisualisation()
						throw error
					}
				}
			} finally {
				// Publish committed settings and access state even if installing their services fails.
				await publishCommittedSettingsTransition(simulationServicesOwner, websiteTabConnections, previousSettings, updatedSettings, (update) => { accessUpdate = update })
			}
		})
	} finally {
		// Complete committed access updates after releasing the semaphore, even if a later reset or notification fails.
		if (accessUpdate !== undefined) {
			await finishWebsiteAccessUpdate(simulationServicesOwner, websiteTabConnections, accessUpdate, change.promptForAccessesIfNeeded ?? true)
		}
	}
}

export async function changeActiveAddressAndChain(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	change: ActiveAddressAndChainChange,
): Promise<void> {
	return await runActiveSettingsChange(simulationServicesOwner, websiteTabConnections, { change })
}

export async function activateAddressSelection(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	selection: ActiveAddressSelection | undefined,
	options: {
		readonly simulationMode: boolean
		readonly signerAddress: bigint | undefined
		readonly rpcNetwork?: RpcNetwork
		readonly promptForAccessesIfNeeded?: boolean
	},
): Promise<void> {
	const selectedSafe = selection?.type === 'addressBookEntry' && selection.entry.type === 'safe' ? selection.entry : undefined
	if (!options.simulationMode && selection?.type === 'addressBookEntry' && selectedSafe === undefined) throw new Error('Signing mode can only activate the external signer or an owned Gnosis Safe.')
	const useSignerAddress = selection?.type === 'signer' || (!options.simulationMode && selection === undefined)
	const signingPreference: SigningAddressPreference | undefined = options.simulationMode || options.signerAddress === undefined || selection === undefined
		? undefined
		: selectedSafe === undefined
			? { signerAddress: options.signerAddress, selection: 'signer' }
			: { signerAddress: options.signerAddress, selection: 'safe', safeAddress: selectedSafe.address, chainId: selectedSafe.chainId }
	return await runActiveSettingsChange(simulationServicesOwner, websiteTabConnections, {
		change: {
			simulationMode: options.simulationMode,
			activeAddress: selection?.type === 'signer' ? selection.address : selection?.entry.address,
			...(!options.simulationMode ? { signingAddressSelection: selectedSafe === undefined ? 'signer' as const : 'safe' as const } : {}),
			...(options.rpcNetwork === undefined ? {} : { rpcNetwork: options.rpcNetwork }),
			...(options.promptForAccessesIfNeeded === undefined ? {} : { promptForAccessesIfNeeded: options.promptForAccessesIfNeeded }),
		},
		...(options.simulationMode ? { simulationSignerSelection: {
			useSignerAddress,
			signerAddress: useSignerAddress ? selection?.type === 'signer' ? selection.address : options.signerAddress : undefined,
		} } : {}),
		...(signingPreference === undefined ? {} : { signingPreference }),
	})
}
