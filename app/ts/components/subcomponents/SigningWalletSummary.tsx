import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { useEffect, useState } from 'preact/hooks'
import { SigningWalletBindings } from '../../types/signingWallet.js'
import { signingWalletDescription } from '../../signing/backend.js'
import { sendSigningPageRequest } from '../../signing/pageMessages.js'

export function openSigningWalletSetup(address?: bigint) {
	const page = browser.runtime.getManifest().manifest_version === 2 ? 'html/signingWallet.html' : 'html3/signingWalletV3.html'
	return browser.tabs.create({ url: `${ browser.runtime.getURL(page) }${ address === undefined ? '' : `?address=0x${ address.toString(16).padStart(40, '0') }` }` })
}

export function SigningWalletSummary({ address, actionLabel = 'Change wallet' }: { address: bigint, actionLabel?: string }) {
	const [bindings, setBindings] = useState<SigningWalletBindings>()
	const [error, setError] = useState<string>()
	useEffect(() => {
		let active = true
		const refresh = async () => {
			try { const reply = await sendSigningPageRequest({ method: 'signing_wallets' }); if (active) { setBindings(SigningWalletBindings.parse(reply.bindings)); setError(undefined) } }
			catch (failure) { if (active) setError(failure instanceof Error ? failure.message : 'Could not load signing wallet') }
		}
		const changed = (changes: Record<string, unknown>) => { if ('signingWalletBindings' in changes) void refresh() }
		void refresh()
		browser.storage?.onChanged?.addListener(changed)
		return () => { active = false; browser.storage?.onChanged?.removeListener(changed) }
	}, [address])
	if (bindings === undefined) return <p class = 'signing-muted' aria-busy = { error === undefined } role = { error === undefined ? 'status' : 'alert' }>{ error ?? 'Loading signing wallet…' }</p>
	const binding = bindings.find((item) => item.wallet.address === address)
	return <div class = 'signing-wallet-summary'>
		<p>{ signingWalletDescription(binding) }</p>
		{ binding === undefined ? <small>Set up signing wallet to sign, or switch to simulation below.</small> : undefined }
		{ binding?.wallet.type === 'ledger' ? <small>Wallet saved · connect Ledger when signing</small> : binding?.wallet.type === 'airgap' ? <small>Imported account · awaiting offline signing</small> : undefined }
		<div class = 'signing-actions'>
		<button class = 'button is-small signing-secondary' onClick = { (event) => { event.stopPropagation(); void openSigningWalletSetup(address).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not open wallet setup')) } }>{ actionLabel }</button>
		<button class = 'button is-small signing-secondary' onClick = { (event) => { event.stopPropagation(); void sendPopupMessageToBackgroundPage({ method: 'popup_changeActiveAddress', data: { activeAddress: address, simulationMode: true } }).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not select simulation address')) } }>Simulate this address</button>
		</div>
		{ error === undefined ? undefined : <p role = 'alert'>{ error }</p> }
	</div>
}
