import { queuePopupSimulationRefresh } from './popupSimulationRefreshQueue.js'
import type { SimulationServicesOwner } from '../simulation/serviceLifecycle.js'
import type { SigningAddressPreference } from '../types/signerTypes.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import type { WebsiteAccessUpdate } from './accessManagement.js'
import { reconcileWebsiteApprovalAccesses, finishWebsiteAccessUpdate } from './accessManagement.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { changeSimulationMode, getSettings, setUseSignersAddressAsActiveAddress, trackPreviousActiveAddressForMakeMeRichList } from './settings.js'
import { updateTransactionState } from './storageVariables.js'
import type { ActiveAddressSelection } from '../utils/activeAddressSelection.js'
import { rememberSigningAddressSelection } from './signingAddressSelection.js'
import { getActiveStackContext, operationBelongsToActiveStackContext } from '../utils/activeStackContext.js'
import { publishCommittedSettingsChange, readNetworkSnapshot, runPendingPopupRefresh, runSettingsTransition } from './networkTransition.js'

async function clearSimulationStateFromConfig() {
	const settings = await getSettings()
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
	const { services, simulation } = await readNetworkSnapshot(simulationServicesOwner)
	await queuePopupSimulationRefresh({ ...services, invalidateOldState: true }, simulation)
}

const keepTrackOfPreviousAddressForRichList = async () => {
	const previousActiveAddress = (await getSettings()).activeSimulationAddress
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

async function runActiveSettingsChange(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	transition: ActiveSettingsTransition,
): Promise<void> {
	const { change } = transition
	let accessUpdate: WebsiteAccessUpdate | undefined
	try {
		// Settings, approvals, resets, notifications and selection preferences form one ordered transition.
		const popupRefresh = await runSettingsTransition(simulationServicesOwner, websiteTabConnections, async (previousSettings, effects) => {
			// These writes keep the network, mode and stack context of the settings read before the transition.
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

			const updatedSettings = await getSettings()
			try {
				try {
					// The preference belongs to the committed selection, even if later provider preparation fails.
					if (transition.signingPreference !== undefined) await rememberSigningAddressSelection(transition.signingPreference)
					await effects.installServices(updatedSettings)
					await effects.clearStackForChangedChain(updatedSettings)
				} finally {
					// Publish committed settings even if installing their services fails.
					await sendPopupMessageToOpenWindows({
						method: 'popup_settingsUpdated', data: updatedSettings, popupRefreshGeneration: bumpPopupRefreshGeneration(),
					})
				}
			} finally {
				accessUpdate = await reconcileWebsiteApprovalAccesses(websiteTabConnections, updatedSettings)
			}
			return await publishCommittedSettingsChange(simulationServicesOwner, websiteTabConnections, effects, previousSettings, updatedSettings)
		})
		await runPendingPopupRefresh(popupRefresh)
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
