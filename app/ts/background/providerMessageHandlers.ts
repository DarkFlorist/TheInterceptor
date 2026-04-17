import { ConnectedToSigner, SignerReply, WalletSwitchEthereumChainReply } from '../types/interceptor-messages.js'
import { TabState } from '../types/user-interface-types.js'
import { EthereumAccountsReply, EthereumChainReply } from '../types/JsonRpc-types.js'
import { changeActiveAddressAndChain } from './background.js'
import { getSocketFromPort, publishPopupMessageToOpenUiPorts } from './backgroundUtils.js'
import { getRpcNetworkForChain, getTabState, setDefaultSignerName, updatePendingTransactionOrMessage, updateTabState } from './storageVariables.js'
import { getMetamaskCompatibilityMode, getSettings } from './settings.js'
import { resolveSignerChainChange } from './windows/changeChain.js'
import { ApprovalState } from './accessManagement.js'
import { ProviderMessage } from '../utils/requests.js'
import { Simulator } from '../simulation/simulator.js'
import { METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { handleUnexpectedError } from '../utils/errors.js'
import { resolvePendingTransactionOrMessage, updateConfirmTransactionView } from './windows/confirmTransaction.js'
import { addressString } from '../utils/bigint.js'
import { modifyObject } from '../utils/typescript.js'
import { sendSubscriptionReplyOrCallBackToPort } from './messageSending.js'
import { emitInternalMessage } from './internalEvents.js'
import { PageSessionStore } from './pageSessions.js'

export async function ethAccountsReply(simulator: Simulator, pageSessions: PageSessionStore, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState, _activeAddress: bigint | undefined) {
	const returnValue = { type: 'result' as const, method: 'eth_accounts_reply' as const, result: '0x' as const }
	if (approval !== 'hasAccess') return returnValue
	if (!('params' in request)) return returnValue
	if (port.sender?.tab?.id === undefined) return returnValue

	const [signerAccountsReply] = EthereumAccountsReply.parse(request.params)
	if (signerAccountsReply.type === 'error') {
		const stringifiedData = signerAccountsReply.error.data ? JSON.stringify(signerAccountsReply.error.data) : undefined
		const error = signerAccountsReply.error
		await updateTabState(port.sender.tab.id, (previousState: TabState) => modifyObject(previousState, { signerAccountError: { ...error, data: stringifiedData } } ))
		await publishPopupMessageToOpenUiPorts({ method: 'popup_accounts_update' })
		return returnValue
	}
	const signerAccounts = signerAccountsReply.accounts
	const activeSigningAddress = signerAccounts.length > 0 ? signerAccounts[0] : undefined
	const tabStateChange = await updateTabState(port.sender.tab.id, (previousState: TabState) => modifyObject(previousState, { ...signerAccounts.length > 0 ? { signerAccountError: undefined } : {}, signerAccounts, activeSigningAddress }))
	publishPopupMessageToOpenUiPorts({ method: 'popup_activeSigningAddressChanged', data: { tabId: port.sender.tab.id, activeSigningAddress } })
	const socket = getSocketFromPort(port)
	if (socket) emitInternalMessage({ action: 'signer.accountsChanged', payload: { socket } })
	// update active address if we are using signers address
	const settings = await getSettings()
	if ((settings.useSignersAddressAsActiveAddress && settings.activeSimulationAddress !== signerAccounts[0])
	|| (settings.simulationMode === false && tabStateChange.previousState.activeSigningAddress !== tabStateChange.newState.activeSigningAddress)) {
		await changeActiveAddressAndChain(simulator, pageSessions, {
			simulationMode: settings.simulationMode,
			activeAddress: tabStateChange.newState.activeSigningAddress,
		})
		await publishPopupMessageToOpenUiPorts({ method: 'popup_accounts_update' })
	}
	return returnValue
}

async function changeSignerChain(simulator: Simulator, pageSessions: PageSessionStore, port: browser.runtime.Port, signerChain: bigint, approval: ApprovalState, _activeAddress: bigint | undefined) {
	if (approval !== 'hasAccess') return
	if (port.sender?.tab?.id === undefined) return
	const oldSignerChain = (await getTabState(port.sender.tab.id)).signerChain
	if (oldSignerChain !== signerChain) await updateTabState(port.sender.tab.id, (previousState: TabState) => modifyObject(previousState, { signerChain }))
	// update active address if we are using signers address
	const settings = await getSettings()
	if ((settings.useSignersAddressAsActiveAddress || !settings.simulationMode) && settings.activeRpcNetwork.chainId !== signerChain) {
		return changeActiveAddressAndChain(simulator, pageSessions, {
			simulationMode: settings.simulationMode,
			rpcNetwork: await getRpcNetworkForChain(signerChain),
		})
	}
	if (oldSignerChain !== signerChain) publishPopupMessageToOpenUiPorts({ method: 'popup_chain_update' })
}

export async function signerChainChanged(simulator: Simulator, pageSessions: PageSessionStore, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState, activeAddress: bigint | undefined) {
	const returnValue = { type: 'result' as const, method: 'signer_chainChanged' as const, result: '0x' as const }
	if (!('params' in request)) return returnValue
	const signerChain = EthereumChainReply.parse(request.params)[0]
	if (signerChain === undefined) throw new Error('signer chain were undefined')
	await changeSignerChain(simulator, pageSessions, port, signerChain, approval, activeAddress)
	return returnValue
}

export async function walletSwitchEthereumChainReply(simulator: Simulator, pageSessions: PageSessionStore, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState, activeAddress: bigint | undefined) {
	const returnValue = { type: 'result' as const, method: 'wallet_switchEthereumChain_reply' as const, result: '0x' as const }
	if (approval !== 'hasAccess') return returnValue
	const params = WalletSwitchEthereumChainReply.parse(request).params[0]
	if (params.accept) await changeSignerChain(simulator, pageSessions, port, params.chainId, approval, activeAddress)
	await resolveSignerChainChange({
		method: 'popup_signerChangeChainDialog',
		data: [params]
	})
	return returnValue
}

export async function connectedToSigner(_simulator: Simulator, _pageSessions: PageSessionStore, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState, activeAddress: bigint | undefined) {
	const [signerConnected, signerName] = ConnectedToSigner.parse(request).params
	if (approval !== 'hasAccess') {
		return { type: 'result' as const, method: 'connected_to_signer' as const, result: { metamaskCompatibilityMode: await getMetamaskCompatibilityMode(), activeAddress: '' } }
	}
	await setDefaultSignerName(signerName)
	await updateTabState(request.uniqueRequestIdentifier.requestSocket.tabId, (previousState: TabState) => modifyObject(previousState, { signerName, signerConnected }))
	await publishPopupMessageToOpenUiPorts({ method: 'popup_signer_name_changed' })
	const settings = await getSettings()
	if (!settings.simulationMode || settings.useSignersAddressAsActiveAddress) {
		sendSubscriptionReplyOrCallBackToPort(port, { type: 'result', method: 'request_signer_chainId', result: [] })
	}
	return { type: 'result' as const, method: 'connected_to_signer' as const, result: { metamaskCompatibilityMode: await getMetamaskCompatibilityMode(), activeAddress: activeAddress === undefined ? '' : addressString(activeAddress) } }
}

export async function signerReply(simulator: Simulator, pageSessions: PageSessionStore, _port: browser.runtime.Port, request: ProviderMessage, _approval: ApprovalState, _activeAddress: bigint | undefined) {
	const signerReply = SignerReply.parse(request)
	const params = signerReply.params[0]
	const doNotReply = { type: 'doNotReply' as const }
	switch(params.forwardRequest.method) {
		case 'personal_sign':
		case 'eth_signTypedData':
		case 'eth_signTypedData_v1':
		case 'eth_signTypedData_v2':
		case 'eth_signTypedData_v3':
		case 'eth_signTypedData_v4':
		case 'eth_sendRawTransaction':
		case 'eth_sendTransaction': {
			const uniqueRequestIdentifier = { requestId: params.forwardRequest.requestId, requestSocket: request.uniqueRequestIdentifier.requestSocket }
			if (params.success) {
				try {
					await resolvePendingTransactionOrMessage(simulator, pageSessions, {
						method: 'popup_confirmDialog',
						data: {
							uniqueRequestIdentifier,
							action: 'signerIncluded',
							signerReply: params.reply,
						}
					})
				} catch(e) {
					await handleUnexpectedError(e)
				}
				return doNotReply
			}
			if (params.error.code === METAMASK_ERROR_USER_REJECTED_REQUEST) {
				await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'WaitingForUser' } }))
				await updateConfirmTransactionView(simulator)
				return doNotReply
			}
			await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'SignerError', ...params.error } }))
			await updateConfirmTransactionView(simulator)
			return doNotReply
		}
	}
	if (params.success) return { type: 'result' as const, method: 'signer_reply' as const, result: params.reply }
	return { type: 'result' as const, method: 'signer_reply' as const, error: params.error }
}
