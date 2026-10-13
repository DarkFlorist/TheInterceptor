import { browserWalletProviderId } from './signing/browserWallet.js'
import { addressString } from './utils/bigint.js'
import { SigningSteps } from './components/subcomponents/SigningSteps.js'
import { render } from 'preact'
import { SigningQrScanner } from './components/subcomponents/SigningQr.js'
import { signingWalletDescription } from './signing/backend.js'

import { useSigningWalletSetup } from './components/hooks/useSigningWalletSetup.js'

function SigningWalletPage() {
	const { target, binding, tabs, kind, setKind, label, setLabel, path, setPath, addressText, setAddressText, accounts, setAccounts, selected, setSelected, verifiedLedgerAddress, setVerifiedLedgerAddress, error, status, setStatus, saved, setSaved, busy, scan, setScan, resetAccountScan, toggleAccountScan, cancelDeviceOperation, ledger, discoverLedger, save, connectBrowserWallet, removeWallet, importPublicAccountFrame } = useSigningWalletSetup()
	const browserAccounts = tabs.flatMap((tab) => {
		const providerId = browserWalletProviderId(tab)
		return !tab.signerConnected || providerId === undefined ? [] : tab.signerAccounts.map((address) => ({ tab, address, providerId }))
	})
	const selectedAccount = accounts[selected]
	const accountMatches = selectedAccount !== undefined && (target === null || selectedAccount.address === BigInt(target))
	const ledgerVerified = selectedAccount?.type === 'ledger' && verifiedLedgerAddress === selectedAccount.address
	const readyToSave = label.trim().length > 0 && (kind === 'manual' ? /^0x[0-9a-fA-F]{40}$/.test(addressText) : accountMatches && (kind !== 'ledger' || ledgerVerified))
	const steps = kind === 'ledger' ? ['Connect', 'Select account', 'Verify address', 'Save'] : kind === 'manual' ? ['Enter address', 'Save'] : ['Connect / import', 'Review account', 'Save']
	const currentStep = saved ? steps.length - 1 : kind === 'ledger' ? ledgerVerified ? 3 : accounts.length > 0 ? 2 : 0 : accounts.length > 0 ? 1 : 0
	return <main class = 'signing-page'>
		<header><h1>{ target === null ? 'Add address' : 'Change signing wallet' }</h1><p class = 'signing-muted'>Your wallet stays with this address. Mode and website permissions stay unchanged.</p></header>
		{ target === null ? undefined : <section class = 'signing-panel'><h2>Current address</h2><p class = 'signing-address'>{ target }</p><div><p class = 'signing-muted'>Saved signing wallet</p><p>{ signingWalletDescription(binding) }</p></div></section> }
		<p class = 'signing-muted'>Public account information only. Never enter a recovery phrase or private key.</p>
		<label>Signing wallet<select disabled = { busy } value = { kind } onChange = { (event) => { setKind(event.currentTarget.value); setAccounts([]); setVerifiedLedgerAddress(undefined); setScan(false); setSaved(false); setStatus('') } }>
			<option value = 'browser'>Browser wallet</option><option value = 'ledger'>Ledger</option><option value = 'airgap'>AirGap Vault</option><option value = 'manual'>Manual address · no signing wallet</option>
		</select></label>
		<SigningSteps steps = { steps } current = { currentStep } status = { saved ? 'complete' : 'active' }/>
		{ saved ? <section class = 'signing-panel signing-success' role = 'status'><h2>{ kind === 'manual' ? 'Address saved' : 'Address and wallet saved' }</h2><p class = 'signing-address'>{ selectedAccount === undefined ? addressText : addressString(selectedAccount.address) }</p><p>You can close this tab and select the address in Interceptor.</p></section> : <>
		{ kind === 'ledger' ? <section class = 'signing-panel'><h2>{ accounts.length === 0 ? 'Connect your Ledger' : 'Verify your selected account' }</h2><p>Connect by USB, unlock your device and open the Ethereum app. Ledger Live is not required. Check that the address on your device matches the account below.</p><div class = 'signing-actions'>
			<button class = { `button ${ accounts.length === 0 ? 'is-primary' : 'signing-secondary' }` } disabled = { busy } onClick = { discoverLedger }>Connect Ledger</button>
			{ accounts.length === 0 ? undefined : <button class = 'button is-primary' disabled = { busy || ledgerVerified } onClick = { ledger }>{ ledgerVerified ? 'Address verified' : 'Verify selected address on Ledger' }</button> }
		</div><details><summary>Advanced: custom derivation path</summary><label>Derivation path<input disabled = { busy } value = { path } onInput = { (event) => { setPath(event.currentTarget.value); setVerifiedLedgerAddress(undefined); setAccounts([]) } }/></label><p class = 'signing-muted'>Default account format (Ledger Live): m/44′/60′/N′/0/0. Legacy: m/44′/60′/0′/0/N.</p><button class = 'button signing-secondary' disabled = { busy } onClick = { ledger }>Connect and verify this path</button></details></section> : undefined }
		{ kind === 'browser' ? <section class = 'signing-panel'><h2>Connect your browser wallet</h2><p>Open an approved website with your browser wallet installed, connect, then choose one of its exposed accounts here.</p><div class = 'signing-actions'><button class = 'button is-primary' disabled = { busy } onClick = { connectBrowserWallet }>Connect browser wallet</button></div>{ browserAccounts.map(({ tab, address, providerId }) => <button key = { `${ tab.tabId }:${ address }` } class = 'button signing-secondary' onClick = { () => { setAccounts([{ type: 'browser', address, signerName: tab.signerName, providerId, label }]); setSelected(0) } }>{ tab.signerProvider?.rdns ?? tab.signerName } · { addressString(address) }</button>) }{ tabs.some((tab) => tab.signerProvider?.ambiguous) ? <p class = 'signing-error'>Multiple providers claim the same wallet identity. Disable the conflicting wallet extension and reload the website before linking.</p> : undefined }</section> : undefined }
		{ kind === 'airgap' ? <section class = 'signing-panel'>
			<h2>{ scan ? 'Scan your public account' : 'Import from AirGap Vault' }</h2><p>In Vault, export your public Ethereum account as a QR code. No private keys leave Vault.</p>
			{ scan ? <SigningQrScanner onFrame = { importPublicAccountFrame } onError = { () => setStatus('Account scan stopped.') } onStart = { resetAccountScan }/> : undefined }
			<div class = 'signing-actions'><button class = { `button ${ scan || accounts.length > 0 ? 'signing-secondary' : 'is-primary' }` } disabled = { busy } onClick = { toggleAccountScan }>{ scan ? 'Cancel scan' : accounts.length > 0 ? 'Scan another account' : 'Scan public account' }</button></div>
			<p class = 'signing-muted'>Vault 3.34.4’s public-account format is reference-tested. QR exports do not report the installed Vault version. Saved AirGap accounts await offline signing; they do not need a continuous connection.</p>
		</section> : undefined }
		{ kind === 'manual' ? <section class = 'signing-panel'><h2>Save an address without a wallet</h2><label>Ethereum address<input value = { addressText } placeholder = '0x…' onInput = { (event) => setAddressText(event.currentTarget.value) }/></label><p class = 'signing-muted'>Use it to read chain data or simulate. Add a matching signing wallet later.</p></section> : undefined }
		{ accounts.length === 0 ? undefined : <section class = 'signing-panel'><h2>{ kind === 'ledger' ? 'Select an account' : 'Review imported account' }</h2>
			{ accounts.map((account, index) => <label class = 'signing-account' key = { account.address.toString() }><input type = 'radio' name = 'signing-account' disabled = { busy } checked = { selected === index } onChange = { () => { setSelected(index); if (account.type === 'ledger') { setPath(account.derivationPath); setLabel(account.label) } } }/><span><span class = 'signing-address'>{ addressString(account.address) }</span><small>{ account.type === 'browser' ? account.signerName : account.derivationPath }</small></span></label>) }
			{ ledgerVerified ? <p class = 'signing-notice'>✓ Address verified on Ledger</p> : undefined }
			{ accountMatches ? undefined : <p class = 'signing-error' role = 'alert'>This account does not match the address being edited. Select a matching account.</p> }
		</section> }
		<section class = 'signing-panel'><label>Account name / wallet label<input maxLength = { 100 } value = { label } onInput = { (event) => setLabel(event.currentTarget.value) }/></label>
			{ readyToSave ? undefined : <p class = 'signing-muted'>{ kind === 'ledger' ? 'Select an account and verify it on your device to enable saving.' : kind === 'manual' ? 'Enter a full Ethereum address and a name to enable saving.' : 'Import or select a matching account and give it a name to enable saving.' }</p> }
			<div class = 'signing-actions'><button class = 'button is-primary' disabled = { busy || !readyToSave } onClick = { save }>{ kind === 'manual' ? 'Save address' : 'Save address and wallet' }</button></div>
		</section>
		</> }
		{ busy ? <button class = 'button signing-secondary' onClick = { cancelDeviceOperation }>Cancel device operation</button> : undefined }
		{ status === '' ? undefined : <p class = 'signing-notice' role = 'status'>{ status }</p> }{ error === undefined ? undefined : <p class = 'signing-error' role = 'alert'>{ error }</p> }
		{ binding === undefined || target === null ? undefined : <section class = 'signing-panel'><h2>Remove wallet binding</h2><p class = 'signing-muted'>Keep this address for reading chain data and simulation.</p><div class = 'signing-actions'><button class = 'button signing-remove' disabled = { busy } onClick = { removeWallet }>Remove signing wallet</button></div></section> }
	</main>
}
render(<SigningWalletPage/>, document.body)
