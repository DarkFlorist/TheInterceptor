import { ConnectedToSigner, SignerReply, WalletSwitchEthereumChainReply } from '../types/interceptor-messages.js'
import type { TabState, WebsiteTabConnections } from '../types/user-interface-types.js'
import { EthereumAccountsReply, EthereumChainReply } from '../types/JsonRpc-types.js'
import { changeActiveAddressAndChain } from './background.js'
import { getSocketFromPort, sendInternalWindowMessage, sendPopupMessageToOpenWindows, websiteSocketToString } from './backgroundUtils.js'
import { getChainChangeConfirmationPromise, getRpcNetworkForChain, getTabState, updatePendingTransactionOrMessage, updateTabState } from './storageVariables.js'
import { getMetamaskCompatibilityMode, getSettings } from './settings.js'
import { resolveSignerChainChange } from './windows/changeChain.js'
import { type ApprovalState, withSuppressedUnscopedConnectionEventsForSocketAsync } from './accessManagement.js'
import type { ProviderMessage } from '../utils/requests.js'
import { METAMASK_ERROR_NOT_AUTHORIZED, METAMASK_ERROR_USER_REJECTED_REQUEST } from '../utils/constants.js'
import { reportUnexpectedError } from '../utils/errors.js'
import { resolvePendingTransactionOrMessage, updateConfirmTransactionView } from './windows/confirmTransaction.js'
import { modifyObject } from '../utils/typescript.js'
import { sendSubscriptionReplyOrCallBack } from './messageSending.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import type { ResetSimulationServices } from '../simulation/serviceLifecycle.js'
import { socketCanExecuteWithSelectedSigner } from './signerExecutionAuthority.js'

export async function ethAccountsReply(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState, _activeAddress: bigint | undefined) {
	const returnValue = { type: 'result' as const, method: 'eth_accounts_reply' as const, result: '0x' as const }
	const socket = getSocketFromPort(port)
	if (socket === undefined || !socketCanExecuteWithSelectedSigner(socket)) {
		if (socket !== undefined) sendInternalWindowMessage({ method: 'window_signer_accounts_changed', data: { socket } })
		return returnValue
	}
	if (approval !== 'hasAccess') return returnValue
	if (!('params' in request)) return returnValue
	if (port.sender?.tab?.id === undefined) return returnValue

	const [signerAccountsReply] = EthereumAccountsReply.parse(request.params)
	if (signerAccountsReply.type === 'error') {
		const stringifiedData = signerAccountsReply.error.data ? JSON.stringify(signerAccountsReply.error.data) : undefined
		const error = signerAccountsReply.error
		await updateTabState(port.sender.tab.id, (previousState: TabState) => socketCanExecuteWithSelectedSigner(socket) ? modifyObject(previousState, {
			signerAccountError: {
				code: error.code,
				message: error.message,
				...(stringifiedData !== undefined ? { data: stringifiedData } : {}),
			}
		}) : previousState)
		if (!socketCanExecuteWithSelectedSigner(socket)) return returnValue
		// Wake requesters waiting for a signer accounts round-trip even when the signer rejected or errored.
		if (socket) sendInternalWindowMessage({ method: 'window_signer_accounts_changed', data: { socket } })
		await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
		return returnValue
	}
	const signerAccounts = signerAccountsReply.accounts
	const activeSigningAddress = signerAccounts.length > 0 ? signerAccounts[0] : undefined
	const tabStateChange = await updateTabState(port.sender.tab.id, (previousState: TabState) => socketCanExecuteWithSelectedSigner(socket)
		? modifyObject(previousState, { ...signerAccounts.length > 0 ? { signerAccountError: undefined } : {}, signerAccounts, activeSigningAddress })
		: previousState)
	if (!socketCanExecuteWithSelectedSigner(socket)) return returnValue
	sendPopupMessageToOpenWindows({ method: 'popup_activeSigningAddressChanged', data: { tabId: port.sender.tab.id, activeSigningAddress } })
	if (socket) sendInternalWindowMessage({ method: 'window_signer_accounts_changed', data: { socket } })
	// update active address if we are using signers address
	const settings = await getSettings()
	if (!socketCanExecuteWithSelectedSigner(socket)) return returnValue
	if ((settings.useSignersAddressAsActiveAddress && settings.activeSimulationAddress !== signerAccounts[0])
	|| (settings.simulationMode === false && tabStateChange.previousState.activeSigningAddress !== tabStateChange.newState.activeSigningAddress)) {
		const changeActiveAddress = () => changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			simulationMode: settings.simulationMode,
			activeAddress: tabStateChange.newState.activeSigningAddress,
		})
		if (signerAccountsReply.requestAccounts && socket !== undefined) {
			await withSuppressedUnscopedConnectionEventsForSocketAsync(socket, changeActiveAddress)
		} else {
			await changeActiveAddress()
		}
		await sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
	}
	return returnValue
}

async function changeSignerChain(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, signerChain: bigint, approval: ApprovalState, _activeAddress: bigint | undefined) {
	if (approval !== 'hasAccess') return
	if (port.sender?.tab?.id === undefined) return
	const socket = getSocketFromPort(port)
	if (socket === undefined || !socketCanExecuteWithSelectedSigner(socket)) return
	const oldSignerChain = (await getTabState(port.sender.tab.id)).signerChain
	if (!socketCanExecuteWithSelectedSigner(socket)) return
	if (oldSignerChain !== signerChain) await updateTabState(port.sender.tab.id, (previousState: TabState) => socketCanExecuteWithSelectedSigner(socket) ? modifyObject(previousState, { signerChain }) : previousState)
	if (!socketCanExecuteWithSelectedSigner(socket)) return
	// update active address if we are using signers address
	const settings = await getSettings()
	if (!socketCanExecuteWithSelectedSigner(socket)) return
	if ((settings.useSignersAddressAsActiveAddress || !settings.simulationMode) && settings.activeRpcNetwork.chainId !== signerChain) {
		return changeActiveAddressAndChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, {
			simulationMode: settings.simulationMode,
			rpcNetwork: await getRpcNetworkForChain(signerChain),
		})
	}
	if (oldSignerChain !== signerChain) sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
}

export async function signerChainChanged(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState, activeAddress: bigint | undefined) {
	const returnValue = { type: 'result' as const, method: 'signer_chainChanged' as const, result: '0x' as const }
	if (!('params' in request)) return returnValue
	const signerChain = EthereumChainReply.parse(request.params)[0]
	if (signerChain === undefined) throw new Error('signer chain were undefined')
	await changeSignerChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, port, signerChain, approval, activeAddress)
	return returnValue
}

export async function walletSwitchEthereumChainReply(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState, activeAddress: bigint | undefined) {
	const returnValue = { type: 'result' as const, method: 'wallet_switchEthereumChain_reply' as const, result: '0x' as const }
	if (approval !== 'hasAccess') return returnValue
	const params = WalletSwitchEthereumChainReply.parse(request).params[0]
	if (!socketCanExecuteWithSelectedSigner(request.uniqueRequestIdentifier.requestSocket)) {
		const pendingChainChange = await getChainChangeConfirmationPromise()
		if (pendingChainChange !== undefined
			&& websiteSocketToString(pendingChainChange.request.uniqueRequestIdentifier.requestSocket) === websiteSocketToString(request.uniqueRequestIdentifier.requestSocket)) {
			await resolveSignerChainChange({
				method: 'popup_signerChangeChainDialog',
				data: [{ accept: false, chainId: params.chainId, error: { code: METAMASK_ERROR_NOT_AUTHORIZED, message: 'Ignored a stale signer chain-switch reply.' } }],
			})
		}
		return returnValue
	}
	if (params.accept) await changeSignerChain(ethereum, tokenPriceService, resetSimulationServices, websiteTabConnections, port, params.chainId, approval, activeAddress)
	if (!socketCanExecuteWithSelectedSigner(request.uniqueRequestIdentifier.requestSocket)) return returnValue
	await resolveSignerChainChange({
		method: 'popup_signerChangeChainDialog',
		data: [params]
	})
	return returnValue
}

export async function connectedToSigner(_ethereum: EthereumClientService, _tokenPriceService: TokenPriceService, _resetSimulationServices: ResetSimulationServices, _websiteTabConnections: WebsiteTabConnections, _port: browser.runtime.Port, request: ProviderMessage, approval: ApprovalState, _activeAddress: bigint | undefined) {
	const [signerConnected, signerName] = ConnectedToSigner.parse(request).params
	if (approval !== 'hasAccess' || !socketCanExecuteWithSelectedSigner(request.uniqueRequestIdentifier.requestSocket)) {
		return { type: 'result' as const, method: 'connected_to_signer' as const, result: { metamaskCompatibilityMode: await getMetamaskCompatibilityMode() } }
	}
	await updateTabState(request.uniqueRequestIdentifier.requestSocket.tabId, (previousState: TabState) => socketCanExecuteWithSelectedSigner(request.uniqueRequestIdentifier.requestSocket)
		? modifyObject(previousState, { signerName, signerConnected })
		: previousState)
	if (!socketCanExecuteWithSelectedSigner(request.uniqueRequestIdentifier.requestSocket)) return { type: 'result' as const, method: 'connected_to_signer' as const, result: { metamaskCompatibilityMode: await getMetamaskCompatibilityMode() } }
	await sendPopupMessageToOpenWindows({ method: 'popup_signer_name_changed' })
	const settings = await getSettings()
	if ((!settings.simulationMode || settings.useSignersAddressAsActiveAddress)
		&& socketCanExecuteWithSelectedSigner(request.uniqueRequestIdentifier.requestSocket)) {
		sendSubscriptionReplyOrCallBack(_websiteTabConnections, request.uniqueRequestIdentifier.requestSocket, { type: 'result', method: 'request_signer_chainId', result: [] })
	}
	return { type: 'result' as const, method: 'connected_to_signer' as const, result: { metamaskCompatibilityMode: await getMetamaskCompatibilityMode() } }
}

export async function signerReply(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, _resetSimulationServices: ResetSimulationServices, websiteTabConnections: WebsiteTabConnections, _port: browser.runtime.Port, request: ProviderMessage, _approval: ApprovalState, _activeAddress: bigint | undefined) {
	const signerReply = SignerReply.parse(request)
	const params = signerReply.params[0]
	const doNotReply = { type: 'doNotReply' as const }
	if (!socketCanExecuteWithSelectedSigner(request.uniqueRequestIdentifier.requestSocket)) {
		if (params.forwardRequest.method === 'personal_sign'
			|| params.forwardRequest.method === 'eth_signTypedData'
			|| params.forwardRequest.method === 'eth_signTypedData_v1'
			|| params.forwardRequest.method === 'eth_signTypedData_v2'
			|| params.forwardRequest.method === 'eth_signTypedData_v3'
			|| params.forwardRequest.method === 'eth_signTypedData_v4'
			|| params.forwardRequest.method === 'eth_sendRawTransaction'
			|| params.forwardRequest.method === 'eth_sendTransaction') {
			await resolvePendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, {
				method: 'popup_confirmDialog',
				data: {
					uniqueRequestIdentifier: { requestId: params.forwardRequest.requestId, requestSocket: request.uniqueRequestIdentifier.requestSocket },
					action: 'noResponse',
				},
			})
		}
		return { type: 'result' as const, method: 'signer_reply' as const, error: { code: METAMASK_ERROR_NOT_AUTHORIZED, message: 'Ignored a stale signer reply.' } }
	}
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
					await resolvePendingTransactionOrMessage(ethereum, tokenPriceService, websiteTabConnections, {
						method: 'popup_confirmDialog',
						data: {
							uniqueRequestIdentifier,
							action: 'signerIncluded',
							signerReply: params.reply,
						}
					})
				} catch(e) {
					await reportUnexpectedError(e)
				}
				return doNotReply
				}
				if (params.error.code === METAMASK_ERROR_USER_REJECTED_REQUEST) {
					await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'WaitingForUser' } }))
					await updateConfirmTransactionView(ethereum, tokenPriceService)
					return doNotReply
				}
				await updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (transaction) => modifyObject(transaction, { approvalStatus: { status: 'SignerError', ...params.error } }))
				await updateConfirmTransactionView(ethereum, tokenPriceService)
				return doNotReply
			}
		}
	if (params.success) return { type: 'result' as const, method: 'signer_reply' as const, result: params.reply }
	return { type: 'result' as const, method: 'signer_reply' as const, error: params.error }
}
