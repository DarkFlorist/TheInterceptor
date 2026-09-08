import { queuePopupSimulationRefresh } from './popupSimulationRefreshQueue.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { ResetSimulationServices, SimulationServices } from '../simulation/serviceLifecycle.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { SigningAddressPreference } from '../types/signerTypes.js'
import { getRpcNetworkChange } from '../utils/rpcNetworkChange.js'
import type { RpcNetwork } from '../types/rpc.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { Semaphore } from '../utils/semaphore.js'
import type { WebsiteAccessUpdate } from './accessManagement.js'
import { reconcileWebsiteApprovalAccesses, finishWebsiteAccessUpdate, sendActiveAccountChangeToApprovedWebsitePorts, sendMessageToApprovedWebsitePorts } from './accessManagement.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { bumpPopupRefreshGeneration } from './popupRefreshGeneration.js'
import { sendCallbackToConfirmedSignerOwner } from './signerStateOwnership.js'
import { changeSimulationMode, getSettings, setUseSignersAddressAsActiveAddress, trackPreviousActiveAddressForMakeMeRichList } from './settings.js'
import { updateTransactionState } from './storageVariables.js'
import type { ActiveAddressSelection } from '../utils/activeAddressSelection.js'
import { rememberSigningAddressSelection } from './signingAddressSelection.js'
import { activeStackContextsEqual, getActiveStackContext, operationBelongsToActiveStackContext } from '../utils/activeStackContext.js'

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

export async function resetSimulationStateFromConfig(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	await clearSimulationStateFromConfig()
	await queuePopupSimulationRefresh({ ethereum, tokenPriceService, invalidateOldState: true })
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

const changeActiveAddressAndChainSemaphore = new Semaphore(1)
async function runActiveSettingsChange(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	transition: ActiveSettingsTransition,
): Promise<void> {
	const { change } = transition
	let accessUpdate: WebsiteAccessUpdate | undefined
	// Use the installed pair for work within this transition; nested access prompts may install another pair before completion.
	let activeServices: SimulationServices = { ethereum, tokenPriceService }
	try {
		// Settings, approvals, resets, notifications and selection preferences form one ordered transition.
		await changeActiveAddressAndChainSemaphore.execute(async () => {
			if (transition.simulationSignerSelection !== undefined) {
				const { useSignerAddress, signerAddress } = transition.simulationSignerSelection
				await setUseSignersAddressAsActiveAddress(useSignerAddress, signerAddress)
			}
			if (change.simulationMode && change.activeAddress !== undefined) await keepTrackOfPreviousAddressForRichList()
			const previousSettings = await getSettings()

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
			const { chainChanged: rpcChainChanged, endpointChanged: rpcEndpointChanged } = getRpcNetworkChange(previousSettings.activeRpcNetwork, updatedSettings.activeRpcNetwork)
			try {
				// A signer-only chain has no provider to install; simulation is disabled until a configured endpoint is selected.
				if (rpcEndpointChanged && change.rpcNetwork?.httpsRpc !== undefined) activeServices = resetSimulationServices(change.rpcNetwork)
				if (updatedSettings.simulationMode && rpcChainChanged) await clearSimulationStateFromConfig()
				// Publish settings exactly once when committed; access reconciliation later publishes account and icon updates.
				await sendPopupMessageToOpenWindows({
					method: 'popup_settingsUpdated', data: updatedSettings, popupRefreshGeneration: bumpPopupRefreshGeneration(),
				})
			} finally {
				// Persisted settings still need access reconciliation if provider preparation or publication fails.
				accessUpdate = await reconcileWebsiteApprovalAccesses(websiteTabConnections, updatedSettings)
			}
			await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
			if (rpcChainChanged) {
				sendMessageToApprovedWebsitePorts(websiteTabConnections, { method: 'chainChanged', result: updatedSettings.activeRpcNetwork.chainId })
				await sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
			}
			// External-wallet signing has no simulated stack; Safe signing retains its separate stack visualization.
			if ((updatedSettings.simulationMode || updatedSettings.activeSigningSafeAddress !== undefined) && (rpcEndpointChanged || !activeStackContextsEqual(getActiveStackContext(previousSettings), getActiveStackContext(updatedSettings)))) {
				await queuePopupSimulationRefresh(activeServices)
			}
			await sendActiveAccountChangeToApprovedWebsitePorts(websiteTabConnections, await getSettings())
			if (transition.signingPreference !== undefined) await rememberSigningAddressSelection(transition.signingPreference)
		})
	} finally {
		// Complete committed access updates after releasing the semaphore, even if a later reset or notification fails.
		if (accessUpdate !== undefined) {
			await finishWebsiteAccessUpdate(activeServices.ethereum, activeServices.tokenPriceService, resetSimulationServices, websiteTabConnections, accessUpdate, change.promptForAccessesIfNeeded ?? true)
		}
	}
}

export async function changeActiveAddressAndChain(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
	websiteTabConnections: WebsiteTabConnections,
	change: ActiveAddressAndChainChange,
): Promise<void> {
	return await runActiveSettingsChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, { change })
}

export async function activateAddressSelection(
	ethereum: EthereumClientService,
	tokenPriceService: TokenPriceService,
	resetSimulationServices: ResetSimulationServices,
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
	return await runActiveSettingsChange(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
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

export async function changeActiveRpc(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, rpcNetwork: RpcNetwork, simulationMode: boolean, signerTabId: number | undefined, walletSwitchRequestId: string = crypto.randomUUID()) {
	const currentRpc = (await getSettings()).activeRpcNetwork
	const { chainChanged, selectionChanged } = getRpcNetworkChange(currentRpc, rpcNetwork)
	if (!selectionChanged) {
		return simulationMode ? { type: 'completedLocally' as const } : { type: 'signerRequestNotNeeded' as const }
	}
	if (simulationMode) {
		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, { simulationMode, rpcNetwork })
		return { type: 'completedLocally' as const }
	}
	// Same-chain endpoint and metadata edits are local, even when a signer is connected.
	if (!chainChanged) {
		await changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, { simulationMode, rpcNetwork })
		return { type: 'signerRequestNotNeeded' as const }
	}
	const signerStateToken = signerTabId !== undefined
		&& sendCallbackToConfirmedSignerOwner(websiteTabConnections, signerTabId, { method: 'request_signer_to_wallet_switchEthereumChain', result: rpcNetwork.chainId, walletSwitchRequestId })
	const settings = await getSettings()
	const popupRefreshGeneration = bumpPopupRefreshGeneration()
	await sendPopupMessageToOpenWindows({ method: 'popup_settingsUpdated', data: settings, popupRefreshGeneration })
	return signerStateToken === false
		? { type: 'signerUnavailable' as const }
		: { type: 'signerRequestSent' as const, signerStateToken }
}
