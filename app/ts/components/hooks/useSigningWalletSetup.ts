import { useEffect, useRef, useState } from 'preact/hooks'
import type { SigningWallet, SigningWalletBindings, SigningWalletBinding } from '../../types/signingWallet.js'
import type { TabState } from '../../types/user-interface-types.js'
import { sendSigningPageRequest } from '../../utils/signingPageMessages.js'
import { selectLedgerDevice, withLedgerDevice } from '../../signing/ledgerHid.js'
import { checkLedgerEthereumApp, readLedgerAccount } from '../../signing/ledgerEthereum.js'
import { createAirGapAccountImporter } from '../../signing/airgapAccountImport.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'

export function useSigningWalletSetup() {
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
		const bindings = reply.bindings
		setBindings(bindings)
		setBinding(target === null ? undefined : bindings.find((item) => item.wallet.address === BigInt(target)))
		setTabs(reply.tabs)
	}) }, [])
	useEffect(() => {
		const refreshAccounts = (_changes: unknown, area: string) => {
			if (area !== 'local') return
			void sendSigningPageRequest({ method: 'signing_wallets' }).then((reply) => setTabs(reply.tabs)).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not refresh browser accounts'))
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
		setStatus('Connect Ledger by USB, unlock it and open Ethereum to discover the first five accounts.')
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
		if (wallet === undefined && bindings.some((item) => item.wallet.address === address)) throw new Error('This address already has a signing wallet. Use Remove signing wallet to remove it explicitly.')
		await sendSigningPageRequest({ method: 'signing_saveWallet', address, wallet, revision: bindings.find((item) => item.wallet.address === address)?.revision, name: label })
		setSaved(true)
		setStatus('Address and signing wallet saved. Mode and website permissions are unchanged.')
		const reply = await sendSigningPageRequest({ method: 'signing_wallets' })
		const savedBindings = reply.bindings
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
	const resetAccountScan = () => { accountImporter.current = createAirGapAccountImporter() }
	const toggleAccountScan = () => { resetAccountScan(); setScan(!scan) }
	const cancelDeviceOperation = () => controller.current.abort(new Error('Wallet setup cancelled'))
	return { target, binding, bindings, tabs, kind, setKind, label, setLabel, path, setPath, addressText, setAddressText, accounts, setAccounts, selected, setSelected, verifiedLedgerAddress, setVerifiedLedgerAddress, error, status, setStatus, saved, setSaved, busy, scan, setScan, resetAccountScan, toggleAccountScan, cancelDeviceOperation, ledger, discoverLedger, save, connectBrowserWallet, removeWallet, importPublicAccountFrame }
}
