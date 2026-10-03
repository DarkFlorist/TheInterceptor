import { useState } from 'preact/hooks'
import type { SafeEntry } from '../../types/addressBookTypes.js'
import type { SigningWalletBindingsState } from '../hooks/useSigningWalletBindings.js'
import { sendSigningPageRequest } from '../../utils/signingPageMessages.js'
import { signingWalletDescription } from '../../signing/backend.js'

export function SafeSigningAccounts({ safe, wallets }: { safe: SafeEntry, wallets: SigningWalletBindingsState }) {
	// Draft accounts and in-flight feedback belong to one Safe on one chain.
	return <SafeSigningAccountsForm key = { `${ safe.chainId }:${ safe.address }` } safe = { safe } wallets = { wallets }/>
}

function SafeSigningAccountsForm({ safe, wallets }: { safe: SafeEntry, wallets: SigningWalletBindingsState }) {
	const bindings = wallets.bindings ?? []
	const [owner, setOwner] = useState(safe.safeSigningSignerAddress?.toString() ?? '')
	const [executor, setExecutor] = useState(safe.safeExecutionAddress?.toString() ?? '')
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)
	return <section><h3>Safe signing accounts</h3><p>Safe: 0x{ safe.address.toString(16).padStart(40, '0') }</p>
		<label>Signing owner <select value = { owner } onChange = { (event) => setOwner(event.currentTarget.value) }><option value = ''>Select owner</option>{ bindings.map((binding) => <option key = { binding.revision } value = { binding.wallet.address.toString() }>{ signingWalletDescription(binding) } · 0x{ binding.wallet.address.toString(16).padStart(40, '0') }</option>) }</select></label>
		<label>Execution / gas-paying account <select value = { executor } onChange = { (event) => setExecutor(event.currentTarget.value) }><option value = ''>Use signing owner</option>{ bindings.map((binding) => <option key = { binding.revision } value = { binding.wallet.address.toString() }>{ signingWalletDescription(binding) } · 0x{ binding.wallet.address.toString(16).padStart(40, '0') }</option>) }</select></label>
		<button class = 'button' disabled = { busy || owner === '' || wallets.bindings === undefined } onClick = { async () => {
			setBusy(true); setError(undefined)
			try { await sendSigningPageRequest({ method: 'signing_setSafeAccounts', chainId: safe.chainId, address: safe.address, owner: BigInt(owner), executor: executor === '' ? undefined : BigInt(executor) }) }
			catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save Safe signing accounts') } finally { setBusy(false) }
		} }>Verify owner and save</button>
		<p>The simulation owner is independent. Owner signatures do not broadcast an execution transaction.</p>{ (error ?? wallets.error) === undefined ? undefined : <p role = 'alert'>{ error ?? wallets.error }</p> }
	</section>
}
