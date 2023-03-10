import { ConnectedToSigner, ProviderMessage, WalletSwitchEthereumChainReply } from '../utils/interceptor-messages.js'
import { EthereumAccountsReply, EthereumChainReply } from '../utils/wire-types.js'
import { changeActiveAddressAndChainAndResetSimulation } from './background.js'
import { getSocketFromPort, sendInternalWindowMessage, sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { resolveSignerChainChange } from './windows/changeChain.js'

export function ethAccountsReply(port: browser.runtime.Port, request: ProviderMessage) {
	if (!('params' in request.options)) return
	const signerAccounts = EthereumAccountsReply.parse(request.options.params)
	if ( port.sender?.tab?.id !== undefined ) {
		globalThis.interceptor.websiteTabSignerStates.set(port.sender.tab.id, {
			signerAccounts: signerAccounts,
			signerChain: globalThis.interceptor.signerChain,
		})
	}
	if (globalThis.interceptor) {
		globalThis.interceptor.signerAccounts = signerAccounts
		sendInternalWindowMessage({ method: 'window_signer_accounts_changed', data: { socket: getSocketFromPort(port)} })
	}

	// update active address if we are using signers address
	if (globalThis.interceptor.settings?.useSignersAddressAsActiveAddress || globalThis.interceptor.settings?.simulationMode === false) {
		changeActiveAddressAndChainAndResetSimulation(signerAccounts[0], 'noActiveChainChange')
	}
	sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
}

async function changeSignerChain(port: browser.runtime.Port, signerChain: bigint ) {
	if ( port.sender?.tab?.id !== undefined ) {
		globalThis.interceptor.websiteTabSignerStates.set(port.sender.tab.id, {
			signerAccounts: globalThis.interceptor.signerAccounts,
			signerChain: signerChain,
		})
	}
	if (globalThis.interceptor) {
		globalThis.interceptor.signerChain = signerChain
	}

	// update active address if we are using signers address
	if ( !globalThis.interceptor.settings?.simulationMode ) {
		return changeActiveAddressAndChainAndResetSimulation('noActiveAddressChange', signerChain)
	}
	sendPopupMessageToOpenWindows({ method: 'popup_chain_update' })
}

export function signerChainChanged(port: browser.runtime.Port, request: ProviderMessage) {
	if (!('params' in request.options)) return
	const signerChain = EthereumChainReply.parse(request.options.params)[0]
	changeSignerChain(port, signerChain)
}

export function walletSwitchEthereumChainReply(port: browser.runtime.Port, request: ProviderMessage) {
	const params = WalletSwitchEthereumChainReply.parse(request.options).params[0]
	if (params.accept) changeSignerChain(port, params.chainId )
	resolveSignerChainChange({
		method: 'popup_signerChangeChainDialog',
		options: {
			chainId: params.chainId,
			accept: params.accept,
		}
	})
}

export function connectedToSigner(_port: browser.runtime.Port, request: ProviderMessage) {
	globalThis.interceptor.signerName = ConnectedToSigner.parse(request.options).params[0]
	sendPopupMessageToOpenWindows({ method: 'popup_signer_name_changed' })
}
