import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { AddressBookEntry } from '../types/addressBookTypes.js'
import type { PendingTransactionBatch, WalletSendCallsBinding } from '../types/accessRequest.js'
import type { Settings } from '../types/interceptor-messages.js'
import type { WebsiteTabConnections } from '../types/user-interface-types.js'
import { EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, JSON_RPC_ERROR_CODE_INVALID_PARAMS, METAMASK_ERROR_NOT_AUTHORIZED } from '../utils/constants.js'
import { haveSameActiveAddressSettings } from './backgroundUtils.js'
import { getSimulationSettingsSnapshot, type SimulationSettingsSnapshot } from './settings.js'
import { doWalletSendCallsMatchSimulatedTransactions, type WalletSendCallsError } from './walletSendCalls.js'
import { hasAddressAccess } from './websiteAccessPolicy.js'
import { getActiveAddressForRequest } from './websiteActiveAddress.js'

// The binding that a wallet_sendCalls batch is admitted with (website, account and network), and whether it still holds when the batch is approved.

const approvalInvalidated = (code: number, reason: string): WalletSendCallsError => ({ code, message: `${ reason } Reject this batch and send the request again.` })

const activeAccountChangedError = approvalInvalidated(METAMASK_ERROR_NOT_AUTHORIZED, 'The active account changed after this batch was requested.')

// A batch is only prepared, simulated and visualized with the client of the network it was requested for. After a network switch its preview is kept unchanged, and approval is refused until the user switches back.
export const isEthereumClientOnBatchChain = (ethereum: EthereumClientService, pendingBatch: PendingTransactionBatch) => ethereum.getChainId() === pendingBatch.binding.chainId

type SimulatedPendingTransactionBatch = Exclude<PendingTransactionBatch, { readonly transactionOrMessageCreationStatus: 'Crafting' }>

// The same contract address can behave differently on another network, so every prepared call and the visualized simulation must come from the network of the canonical request. A failed batch simulation records no network, so it cannot be approved.
function isTransactionBatchPreviewOnRequestedChain(pendingBatch: SimulatedPendingTransactionBatch) {
	const requestedChainId = pendingBatch.originalRequestParameters.params[0].chainId
	const { popupVisualisation } = pendingBatch
	return requestedChainId === pendingBatch.binding.chainId
		&& popupVisualisation.statusCode === 'success'
		&& popupVisualisation.data.simulationState.rpcNetwork.chainId === requestedChainId
		&& pendingBatch.transactionsToSimulate.every((transactionToSimulate) => transactionToSimulate.success && transactionToSimulate.transaction.chainId === requestedChainId)
}

const getModeOrNetworkBindingError = (settings: Settings, binding: WalletSendCallsBinding) => {
	if (settings.activeRpcNetwork.chainId !== binding.chainId) return approvalInvalidated(EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, 'The active network changed after this batch was requested.')
	// Batches are only added to the simulation stack, which signing mode does not use, and signing mode refuses new batches.
	if (!settings.simulationMode) return approvalInvalidated(METAMASK_ERROR_NOT_AUTHORIZED, 'The Interceptor switched to signing mode after this batch was requested.')
	return undefined
}

export type WalletSendCallsAccountLookup = { readonly snapshot: SimulationSettingsSnapshot, readonly activeAddress: AddressBookEntry | undefined }

// Looks up the active account with the settings of one snapshot. getWalletSendCallsBindingError then confirms against a later snapshot that those settings still hold.
export async function lookUpWalletSendCallsAccount(websiteTabConnections: WebsiteTabConnections, pendingBatch: PendingTransactionBatch): Promise<WalletSendCallsAccountLookup> {
	const tabId = pendingBatch.uniqueRequestIdentifier.requestSocket.tabId
	const snapshot = await getSimulationSettingsSnapshot()
	return { snapshot, activeAddress: await getActiveAddressForRequest(snapshot.settings, websiteTabConnections, tabId) }
}

// Checks the admission binding (network, simulation mode, active account and website access) against one settings snapshot, read after the account lookup. It awaits nothing, so a caller can write right after reading the snapshot, which makes the snapshot the point the approval takes effect: a change saved later counts as made after approval. The signer's accounts in the tab state are only read during the account lookup, which is acceptable because the wallet reports them on its own schedule, so a change landing just after that lookup cannot be told apart from one landing just after approval.
export function getWalletSendCallsBindingError(pendingBatch: PendingTransactionBatch, accountLookup: WalletSendCallsAccountLookup, latestSnapshot: SimulationSettingsSnapshot): WalletSendCallsError | undefined {
	const { binding } = pendingBatch
	const latestSettings = latestSnapshot.settings
	const settingsError = getModeOrNetworkBindingError(latestSettings, binding)
	if (settingsError !== undefined) return settingsError
	const { activeAddress } = accountLookup
	if (activeAddress === undefined || activeAddress.address !== binding.account || !haveSameActiveAddressSettings(accountLookup.snapshot.settings, latestSettings)) return activeAccountChangedError
	// The persisted website access decides alone. A connection's approval only mirrors it and is reconciled after an access change is saved, so it could still allow a website whose access was just revoked.
	if (hasAddressAccess(latestSettings.websiteAccess, binding.websiteOrigin, activeAddress) !== 'hasAccess') return approvalInvalidated(METAMASK_ERROR_NOT_AUTHORIZED, 'This website is no longer authorized to use the active account.')
	return undefined
}

// Re-checks the admission binding at approval time. Any change to the network, mode, account, website access or batch payload invalidates the approval.
export async function getWalletSendCallsApprovalError(
	websiteTabConnections: WebsiteTabConnections,
	ethereum: EthereumClientService,
	pendingBatch: SimulatedPendingTransactionBatch,
): Promise<WalletSendCallsError | undefined> {
	if (ethereum.getChainId() !== pendingBatch.binding.chainId) return approvalInvalidated(EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, 'The active network changed after this batch was requested.')
	const accountLookup = await lookUpWalletSendCallsAccount(websiteTabConnections, pendingBatch)
	const bindingError = getWalletSendCallsBindingError(pendingBatch, accountLookup, await getSimulationSettingsSnapshot())
	if (bindingError !== undefined) return bindingError
	if (!isTransactionBatchPreviewOnRequestedChain(pendingBatch)) return approvalInvalidated(EIP5792_ERROR_UNSUPPORTED_CHAIN_ID, 'The batch preview was not simulated on the network the batch was requested for.')
	if (!doWalletSendCallsMatchSimulatedTransactions(pendingBatch.originalRequestParameters, pendingBatch.binding.account, pendingBatch.transactionsToSimulate)) return approvalInvalidated(JSON_RPC_ERROR_CODE_INVALID_PARAMS, 'The batch calls no longer match the simulated transactions.')
	return undefined
}
