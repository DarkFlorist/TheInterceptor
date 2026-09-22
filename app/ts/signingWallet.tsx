import { browserWalletProviderId } from './signing/browserWallet.js'
import { addressString } from './utils/bigint.js'
import { SigningSteps } from './components/subcomponents/SigningSteps.js'
import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import * as funtypes from 'funtypes'
import { type SigningWallet, SigningWalletBindings, type SigningWalletBinding } from './types/signingWallet.js'
import { TabState } from './types/user-interface-types.js'
import { sendSigningPageRequest } from './signing/pageMessages.js'
import { selectLedgerDevice, withLedgerDevice } from './signing/ledgerHid.js'
import { checkLedgerEthereumApp, readLedgerAccount } from './signing/ledgerEthereum.js'
import { createAirGapAccountImporter } from './signing/airgapAccountImport.js'
import { SigningQrScanner } from './components/subcomponents/SigningQr.js'
import { signingWalletDescription } from './signing/backend.js'
import { sendPopupMessageToBackgroundPage } from './background/backgroundUtils.js'

function SigningWalletPage() {
	const target = new URLSearchParams(location.search).get('address')
	const [binding, setBinding] = useState<SigningWalletBinding>()
	const [bindings, setBindings] = useState<SigningWalletBindings>([])
	const [tabs, setTabs] = useState<readonly TabState[]>([])
	const [kind, setKind] = useState('ledger')
	const [label, setLabel] = useState('Account 1')
	const [path, setPath] = useState('m/44\'/60\'/0\'/0/0')
	const [addressText, setAddressText] = useState(target ?? '')
	const [accounts, setAccounts] = useState<readonly SigningWallet[]>([])
	const [selected, setSelected] = useState(0)
	const [verifiedLedgerAddress, setVerifiedLedgerAddress] = useState<bigint>()
	const [error, setError] = useState<string>()
	const [status, setStatus] = useState('')
	const [saved, setSaved] = useState(false)
	const [busy, setBusy] = useState(false)
	const [scan, setScan] = useState(false)
	const controller = useRef(new AbortController())
	useEffect(() => () => controller.current.abort(new Error('Wallet setup closed')), [])
	const accountImporter = useRef(createAirGapAccountImporter())
	const run = async (operation: () => Promise<void>) => {
		setBusy(true)
		setError(undefined)
		try {
			await operation()
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : 'Wallet setup failed')
		} finally {
			setBusy(false)
		}
	}
	useEffect(() => { void run(async () => {
		const reply = await sendSigningPageRequest({ method: 'signing_wallets' })
		const bindings = SigningWalletBindings.parse(reply.bindings)
		setBindings(bindings)
		setBinding(target === null ? undefined : bindings.find((item) => item.wallet.address === BigInt(target)))
		setTabs(funtypes.ReadonlyArray(TabState).parse(reply.tabs))
	}) }, [])
	useEffect(() => {
		const refreshAccounts = (_changes: unknown, area: string) => {
			if (area !== 'local') return
			void sendSigningPageRequest({ method: 'signing_wallets' }).then((reply) => setTabs(funtypes.ReadonlyArray(TabState).parse(reply.tabs))).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not refresh browser accounts'))
		}
		browser.storage.onChanged.addListener(refreshAccounts)
		return () => browser.storage.onChanged.removeListener(refreshAccounts)
	}, [])
	const ledger = () => run(async () => {
		setStatus('Select your Ledger, unlock it, and open Ethereum. Verify the address on the device.')
		const device = await selectLedgerDevice()
		controller.current = new AbortController()
		const account = await withLedgerDevice(device, controller.current.signal, async (exchange) => {
			await checkLedgerEthereumApp(exchange)
			return await readLedgerAccount(exchange, path, true, target ?? undefined)
		})
		setVerifiedLedgerAddress(BigInt(account.address))
		setAccounts([{ type: 'ledger', address: BigInt(account.address), publicKey: account.publicKey, derivationPath: account.derivationPath, label }])
		setSelected(0)
		setStatus('Address verified on Ledger. Review and name the account before saving.')
	})
	const discoverLedger = () => run(async () => {
		setStatus('Unlock Ledger and open Ethereum to discover the first five Ledger Live accounts.')
		const device = await selectLedgerDevice()
		controller.current = new AbortController()
		const discovered = await withLedgerDevice(device, controller.current.signal, async (exchange) => {
			await checkLedgerEthereumApp(exchange)
			const result: SigningWallet[] = []
			for (let index = 0; index < 5; index += 1) {
				const account = await readLedgerAccount(exchange, `m/44'/60'/${ index }'/0/0`, false)
				result.push({ type: 'ledger', address: BigInt(account.address), publicKey: account.publicKey, derivationPath: account.derivationPath, label: `Account ${ index + 1 }` })
			}
			return result
		})
		setAccounts(discovered); setSelected(0); setVerifiedLedgerAddress(undefined)
		setPath(discovered[0]?.type === 'ledger' ? discovered[0].derivationPath : path)
		setStatus('Select an account, then verify its address on Ledger before saving. Custom paths are also supported.')
	})
	const save = () => run(async () => {
		const account = accounts[selected]
		const wallet = kind === 'manual' ? undefined : account === undefined ? undefined : { ...account, label }
		if (wallet?.type === 'ledger' && verifiedLedgerAddress !== wallet.address) throw new Error('Verify the selected address on Ledger before saving')
		if (kind !== 'manual' && wallet === undefined) throw new Error('Select and review a wallet account first')
		const address = wallet?.address ?? BigInt(addressText)
		if (target !== null && address !== BigInt(target)) throw new Error('The wallet account does not match the address being edited')
		await sendSigningPageRequest({ method: 'signing_saveWallet', address, wallet, revision: bindings.find((item) => item.wallet.address === address)?.revision, name: label })
		setSaved(true)
		setStatus('Address and signing wallet saved. Mode and website permissions are unchanged.')
		const reply = await sendSigningPageRequest({ method: 'signing_wallets' })
		const savedBindings = SigningWalletBindings.parse(reply.bindings)
		setBindings(savedBindings)
		setBinding(savedBindings.find((item) => item.wallet.address === address))
	})
	const connectBrowserWallet = () => run(async () => {
		await sendPopupMessageToBackgroundPage({ method: 'popup_requestAccountsFromSigner', data: true })
		setStatus('Approve the account connection in your browser wallet. Exposed accounts appear here automatically.')
	})
	const removeWallet = () => run(async () => {
		if (binding === undefined) return
		await sendSigningPageRequest({ method: 'signing_saveWallet', address: binding.wallet.address, wallet: undefined, revision: binding.revision, name: undefined })
		setBindings(bindings.filter((item) => item.wallet.address !== binding.wallet.address))
		setBinding(undefined)
		setSaved(false)
		setAccounts([])
		setStatus('Wallet removed. The address remains saved.')
	})
	const importPublicAccountFrame = async (frame: string) => {
		const result = accountImporter.current(frame)
		if (result.accounts === undefined) {
			setStatus(`Received ${ result.received } of ${ result.total } fragments`)
			return false
		}
		const imported = result.accounts
		setAccounts(imported.map((account) => ({ ...account, type: 'airgap', address: BigInt(account.address), label })))
		setSelected(0)
		setScan(false)
		setStatus('Public accounts imported. Review the address before saving. Signing authority is checked when you sign.')
		return true
	}
	const browserAccounts = tabs.flatMap((tab) => {
		const providerId = browserWalletProviderId(tab)
		return !tab.signerConnected || providerId === undefined ? [] : tab.signerAccounts.map((address) => ({ tab, address, providerId }))
	})
	const selectedAccount = accounts[selected]
	const accountMatches = selectedAccount !== undefined && (target === null || selectedAccount.address === BigInt(target))
	const ledgerVerified = selectedAccount?.type === 'ledger' && verifiedLedgerAddress === selectedAccount.address
	const readyToSave = label.trim().length > 0 && (kind === 'manual' ? /^0x[0-9a-fA-F]{40}$/.test(addressText) : accountMatches && (kind !== 'ledger' || ledgerVerified))
	const steps = kind === 'ledger' ? ['Connect', 'Select account', 'Verify address', 'Save'] : kind === 'manual' ? ['Enter address', 'Save'] : ['Connect / import', 'Review account', 'Save']
	const currentStep = saved ? steps.length : kind === 'ledger' ? ledgerVerified ? 3 : accounts.length > 0 ? 2 : 0 : accounts.length > 0 ? 1 : 0
	return <main class = 'signing-page'>
		<header><h1>{ target === null ? 'Add address' : 'Change signing wallet' }</h1><p class = 'signing-muted'>Your wallet stays with this address. Mode and website permissions stay unchanged.</p></header>
		{ target === null ? undefined : <section class = 'signing-panel'><h2>Current address</h2><p class = 'signing-address'>{ target }</p><div><p class = 'signing-muted'>Saved signing wallet</p><p>{ signingWalletDescription(binding) }</p></div></section> }
		<p class = 'signing-muted'>Public account information only. Never enter a recovery phrase or private key.</p>
		<label>Signing wallet<select disabled = { busy } value = { kind } onChange = { (event) => { setKind(event.currentTarget.value); setAccounts([]); setVerifiedLedgerAddress(undefined); setScan(false); setSaved(false); setStatus('') } }>
			<option value = 'browser'>Browser wallet</option><option value = 'ledger'>Ledger</option><option value = 'airgap'>AirGap Vault</option><option value = 'manual'>Manual address · no signing wallet</option>
		</select></label>
		<SigningSteps steps = { steps } current = { currentStep }/>
		{ saved ? <section class = 'signing-panel signing-success' role = 'status'><h2>{ kind === 'manual' ? 'Address saved' : 'Address and wallet saved' }</h2><p class = 'signing-address'>{ selectedAccount === undefined ? addressText : addressString(selectedAccount.address) }</p><p>You can close this tab and select the address in Interceptor.</p></section> : <>
		{ kind === 'ledger' ? <section class = 'signing-panel'><h2>{ accounts.length === 0 ? 'Connect your Ledger' : 'Verify your selected account' }</h2><p>Unlock your device and open the Ethereum app. Check that the address on your device matches the account below.</p><div class = 'signing-actions'>
			<button class = { `button ${ accounts.length === 0 ? 'is-primary' : 'signing-secondary' }` } disabled = { busy } onClick = { discoverLedger }>Discover Ledger Live accounts</button>
			{ accounts.length === 0 ? undefined : <button class = 'button is-primary' disabled = { busy || ledgerVerified } onClick = { ledger }>{ ledgerVerified ? 'Address verified' : 'Verify selected address on Ledger' }</button> }
		</div><details><summary>Advanced: custom derivation path</summary><label>Derivation path<input disabled = { busy } value = { path } onInput = { (event) => { setPath(event.currentTarget.value); setVerifiedLedgerAddress(undefined); setAccounts([]) } }/></label><p class = 'signing-muted'>Ledger Live: m/44′/60′/N′/0/0. Legacy: m/44′/60′/0′/0/N.</p><button class = 'button signing-secondary' disabled = { busy } onClick = { ledger }>Connect and verify this path</button></details></section> : undefined }
		{ kind === 'browser' ? <section class = 'signing-panel'><h2>Connect your browser wallet</h2><p>Open an approved website with your browser wallet installed, connect, then choose one of its exposed accounts here.</p><div class = 'signing-actions'><button class = 'button is-primary' disabled = { busy } onClick = { connectBrowserWallet }>Connect browser wallet</button></div>{ browserAccounts.map(({ tab, address, providerId }) => <button key = { `${ tab.tabId }:${ address }` } class = 'button signing-secondary' onClick = { () => { setAccounts([{ type: 'browser', address, signerName: tab.signerName, providerId, label }]); setSelected(0) } }>{ tab.signerProvider?.rdns ?? tab.signerName } · { addressString(address) }</button>) }{ tabs.some((tab) => tab.signerProvider?.ambiguous) ? <p class = 'signing-error'>Multiple providers claim the same wallet identity. Disable the conflicting wallet extension and reload the website before linking.</p> : undefined }</section> : undefined }
		{ kind === 'airgap' ? <section class = 'signing-panel'>
			<h2>{ scan ? 'Scan your public account' : 'Import from AirGap Vault' }</h2><p>In Vault, export your public Ethereum account as a QR code. No private keys leave Vault.</p>
			{ scan ? <SigningQrScanner onFrame = { importPublicAccountFrame }/> : undefined }
			<div class = 'signing-actions'><button class = { `button ${ scan || accounts.length > 0 ? 'signing-secondary' : 'is-primary' }` } disabled = { busy } onClick = { () => { accountImporter.current = createAirGapAccountImporter(); setScan(!scan) } }>{ scan ? 'Cancel scan' : accounts.length > 0 ? 'Scan another account' : 'Scan public account' }</button></div>
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
		{ busy ? <button class = 'button signing-secondary' onClick = { () => controller.current.abort(new Error('Wallet setup cancelled')) }>Cancel device operation</button> : undefined }
		{ status === '' ? undefined : <p class = 'signing-notice' role = 'status'>{ status }</p> }{ error === undefined ? undefined : <p class = 'signing-error' role = 'alert'>{ error }</p> }
		{ binding === undefined || target === null ? undefined : <section class = 'signing-panel'><h2>Remove wallet binding</h2><p class = 'signing-muted'>Keep this address for reading chain data and simulation.</p><div class = 'signing-actions'><button class = 'button signing-remove' disabled = { busy } onClick = { removeWallet }>Remove signing wallet</button></div></section> }
	</main>
}
render(<SigningWalletPage/>, document.body)
