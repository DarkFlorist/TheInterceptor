import { sendPopupMessageToBackgroundPage, getHtmlFile } from '../../background/backgroundUtils.js'
import { useState } from 'preact/hooks'
import type { SigningWalletBindingsState } from '../hooks/useSigningWalletBindings.js'
import { signingWalletDescription } from '../../signing/backend.js'

export function openSigningWalletSetup(address?: bigint) {
	const page = getHtmlFile('signingWallet')
	return browser.tabs.create({ url: `${ browser.runtime.getURL(page) }${ address === undefined ? '' : `?address=0x${ address.toString(16).padStart(40, '0') }` }` })
}

export function SigningWalletSummary({ address, wallets, showSimulationShortcut = true }: { address: bigint, wallets: SigningWalletBindingsState, showSimulationShortcut?: boolean }) {
	const [error, setError] = useState<string>()
	const { bindings, error: loadError } = wallets
	if (bindings === undefined) return <p class = 'signing-muted' aria-busy = { loadError === undefined } role = { loadError === undefined ? 'status' : 'alert' }>{ loadError ?? 'Loading signing wallet…' }</p>
	const binding = bindings.find((item) => item.wallet.address === address)
	return <div class = 'signing-wallet-summary'>
		<p>{ signingWalletDescription(binding) }</p>
		{ binding?.wallet.type === 'ledger' ? <small>Wallet saved · connect Ledger when signing</small> : binding?.wallet.type === 'airgap' ? <small>Imported account · awaiting offline signing</small> : undefined }
		<div class = 'signing-wallet-action'>
		<button class = 'button is-small signing-secondary' onClick = { (event) => { event.stopPropagation(); void openSigningWalletSetup(address).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not open wallet setup')) } }>{ binding === undefined ? 'Set up wallet' : 'Change wallet' }</button>
		<small>Choose how this address signs. Your selected address and mode stay the same.</small>
		</div>
		{ showSimulationShortcut ? <div class = 'signing-wallet-action'>
		<button class = 'button is-small signing-secondary' onClick = { (event) => { event.stopPropagation(); void sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveAddress', data: { activeAddress: address, simulationMode: true } }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not select simulation address')) } }>Use in simulation</button>
		<small>Select this address in Simulation mode. Your signing address stays the same.</small>
		</div> : undefined }
		{ error === undefined ? undefined : <p role = 'alert'>{ error }</p> }
	</div>
}
