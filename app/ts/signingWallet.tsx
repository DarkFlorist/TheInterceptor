import { render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import * as funtypes from 'funtypes'
import { type SigningWallet, SigningWalletBindings, type SigningWalletBinding } from './types/signingWallet.js'
import { TabState } from './types/user-interface-types.js'
import { sendSigningPageRequest } from './signing/pageMessages.js'
import { selectLedgerDevice, withLedgerDevice } from './signing/ledgerHid.js'
import { checkLedgerEthereumApp, readLedgerAccount } from './signing/ledgerEthereum.js'
import { importAirGapAccounts } from './signing/airgapEthereum.js'
import { createAirGapUrDecoder } from './signing/airgapUr.js'
import { SigningQrScanner } from './components/subcomponents/SigningQr.js'
import { signingWalletDescription } from './signing/backend.js'
import { sendPopupMessageToBackgroundPage } from './background/backgroundUtils.js'

function SigningWalletPage() {
	const target = new URLSearchParams(location.search).get('address')
	const [binding, setBinding] = useState<SigningWalletBinding>()
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
	const [busy, setBusy] = useState(false)
	const [scan, setScan] = useState(false)
	const controller = useRef(new AbortController())
	useEffect(() => () => controller.current.abort(new Error('Wallet setup closed')), [])
	const [importType, setImportType] = useState<'crypto-account' | 'crypto-hdkey'>('crypto-account')
	const [decoder, setDecoder] = useState(() => createAirGapUrDecoder('crypto-account'))
	const run = async (operation: () => Promise<void>) => {
		setBusy(true); setError(undefined)
		try { await operation() } catch (failure) { setError(failure instanceof Error ? failure.message : 'Wallet setup failed') } finally { setBusy(false) }
	}
	useEffect(() => { void run(async () => {
		const reply = await sendSigningPageRequest({ method: 'signing_wallets' })
		const bindings = SigningWalletBindings.parse(reply.bindings)
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
		await sendSigningPageRequest({ method: 'signing_saveWallet', address, wallet, revision: binding?.wallet.address === address ? binding.revision : undefined, name: label })
		setStatus('Address and signing wallet saved. Mode and website permissions are unchanged.')
		const reply = await sendSigningPageRequest({ method: 'signing_wallets' })
		setBinding(SigningWalletBindings.parse(reply.bindings).find((item) => item.wallet.address === address))
	})
	return <main style = 'max-width: 760px; margin: 30px auto; padding: 24px; color: var(--text-color); display: flex; flex-direction: column; gap: 16px;'>
		<h1 style = 'font-size: 1.5rem; font-weight: 600;'>{ target === null ? 'Add address' : 'Change signing wallet' }</h1>
		{ target === null ? undefined : <p>Address: { target } · { signingWalletDescription(binding) }</p> }
		<p>Save public account information only. Never enter a recovery phrase or private key.</p>
		<label>Wallet <select disabled = { busy } value = { kind } onChange = { (event) => { setKind(event.currentTarget.value); setAccounts([]); setScan(false); setStatus('') } }>
			<option value = 'browser'>Browser wallet</option><option value = 'ledger'>Ledger</option><option value = 'airgap'>AirGap Vault</option><option value = 'manual'>Manual address</option>
		</select></label>
		{ kind === 'ledger' ? <section><label>Derivation path <input value = { path } onInput = { (event) => setPath(event.currentTarget.value) }/></label><p>Ledger Live account N: m/44′/60′/N′/0/0. Legacy account N: m/44′/60′/0′/0/N.</p><button class = 'button is-primary' disabled = { busy } onClick = { discoverLedger }>Discover Ledger Live accounts</button><button class = 'button is-primary' disabled = { busy } onClick = { ledger }>Connect and verify address on Ledger</button></section> : undefined }
		{ kind === 'browser' ? <section><p>Open an approved website with your browser wallet installed, connect, then choose one of its exposed accounts here.</p><button class = 'button is-primary' disabled = { busy } onClick = { () => run(async () => { await sendPopupMessageToBackgroundPage({ method: 'popup_requestAccountsFromSigner', data: true }); setStatus('Approve the account connection in your browser wallet. Exposed accounts appear here automatically.') }) }>Connect browser wallet</button>{ tabs.flatMap((tab) => tab.signerAccounts.map((address) => <button key = { `${ tab.tabId }:${ address }` } class = 'button is-primary' onClick = { () => { setAccounts([{ type: 'browser', address, signerName: tab.signerName, providerId: tab.signerName, label }]); setSelected(0) } }>{ tab.signerName } · 0x{ address.toString(16).padStart(40, '0') }</button>)) }</section> : undefined }
		{ kind === 'airgap' ? <section>
			<p>Export a public Ethereum account from AirGap Vault using the ERC-4527 crypto-account or crypto-hdkey format. The imported account awaits offline signing; it is not continuously connected.</p>
			<select disabled = { scan } onChange = { (event) => { const type = event.currentTarget.value === 'crypto-hdkey' ? 'crypto-hdkey' : 'crypto-account'; setImportType(type); setDecoder(createAirGapUrDecoder(type)) } }><option value = 'crypto-account'>crypto-account</option><option value = 'crypto-hdkey'>crypto-hdkey</option></select>
			<button class = 'button is-primary' onClick = { () => { setDecoder(createAirGapUrDecoder(importType)); setScan(!scan) } }>{ scan ? 'Cancel scan' : 'Scan public account' }</button>
			{ scan ? <SigningQrScanner onFrame = { async (frame) => {
				const result = decoder.receive(frame)
				if (result.payload === undefined) return false
				const imported = importAirGapAccounts(importType, result.payload)
				setAccounts(imported.map((account) => ({ ...account, type: 'airgap', address: BigInt(account.address), label })))
				setSelected(0); setScan(false); setStatus('Review imported accounts. Importing public keys does not prove signing authority.')
				return true
			} }/> : undefined }
		</section> : undefined }
		{ kind === 'manual' ? <label>Address <input value = { addressText } onInput = { (event) => setAddressText(event.currentTarget.value) }/></label> : undefined }
		{ accounts.map((account, index) => <p key = { account.address.toString() }><label><input type = 'radio' checked = { selected === index } onChange = { () => { setSelected(index); if (account.type === 'ledger') setPath(account.derivationPath) } }/>0x{ account.address.toString(16).padStart(40, '0') } { account.type === 'browser' ? account.signerName : account.derivationPath }</label></p>) }
		<label>Account name / wallet label <input maxLength = { 100 } value = { label } onInput = { (event) => setLabel(event.currentTarget.value) }/></label>
		{ busy ? <button class = 'button is-primary' onClick = { () => controller.current.abort(new Error('Wallet setup cancelled')) }>Cancel device operation</button> : undefined }
		<p role = 'status'>{ status }</p>{ error === undefined ? undefined : <p role = 'alert'>{ error }</p> }
		<button class = 'button is-primary' disabled = { busy } onClick = { save }>Save address and wallet</button>
		{ binding === undefined ? undefined : <button class = 'button is-primary' disabled = { busy } onClick = { () => run(async () => { await sendSigningPageRequest({ method: 'signing_saveWallet', address: binding.wallet.address, wallet: undefined, revision: binding.revision, name: undefined }); setBinding(undefined); setStatus('Wallet removed. The address remains saved.') }) }>Remove signing wallet</button> }
	</main>
}
render(<SigningWalletPage/>, document.body)
