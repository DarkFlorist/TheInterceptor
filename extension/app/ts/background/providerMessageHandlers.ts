import { ConnectedToSigner, ProviderMessage, WalletSwitchEthereumChainReply } from '../utils/interceptor-messages.js'
import { EthereumAccountsReply, EthereumChainReply } from '../utils/wire-types.js'
import { changeActiveAddressAndChainAndResetSimulation } from './background.js'
import { sendPopupMessageToOpenWindows } from './backgroundUtils.js'
import { resolveSignerChainChange } from './windows/changeChain.js'

export function ethAccountsReply(port: browser.runtime.Port, request: ProviderMessage) {
	if (!('params' in request.options)) return
	const signerAccounts = EthereumAccountsReply.parse(request.options.params)
	if ( port.sender?.tab?.id !== undefined ) {
		window.interceptor.websiteTabSignerStates.set(port.sender.tab.id, {
			signerAccounts: signerAccounts,
			signerChain: window.interceptor.signerChain,
		})
	}
	if (window.interceptor) {
		window.interceptor.signerAccounts = signerAccounts
	}

	// update active address if we are using signers address
	if (window.interceptor.settings?.useSignersAddressAsActiveAddress || window.interceptor.settings?.simulationMode === false) {
		changeActiveAddressAndChainAndResetSimulation(signerAccounts[0], 'noActiveChainChange')
	}
	sendPopupMessageToOpenWindows({ method: 'popup_accounts_update' })
}

async function changeSignerChain(port: browser.runtime.Port, signerChain: bigint ) {
	if ( port.sender?.tab?.id !== undefined ) {
		window.interceptor.websiteTabSignerStates.set(port.sender.tab.id, {
			signerAccounts: window.interceptor.signerAccounts,
			signerChain: signerChain,
		})
	}
	if (window.interceptor) {
		window.interceptor.signerChain = signerChain
	}

	// update active address if we are using signers address
	if ( !window.interceptor.settings?.simulationMode ) {
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
	window.interceptor.signerName = ConnectedToSigner.parse(request.options).params[0]
	sendPopupMessageToOpenWindows({ method: 'popup_signer_name_changed' })
}
