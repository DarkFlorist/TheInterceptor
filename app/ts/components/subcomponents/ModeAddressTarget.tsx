import { useEffect, useState } from 'preact/hooks'
import * as funtypes from 'funtypes'
import { EthereumAddressOrMissing } from '../../types/wire-types.js'
const ModeTargets = funtypes.ReadonlyPartial({ selectedSigningAddress: EthereumAddressOrMissing, activeSigningSafeAddress: EthereumAddressOrMissing, activeSigningAddress: EthereumAddressOrMissing, independentActiveSimulationAddress: EthereumAddressOrMissing })

export function ModeAddressTarget({ mode }: { mode: 'simulation' | 'signing' }) {
	const [address, setAddress] = useState<bigint>()
	const [error, setError] = useState<string>()
	useEffect(() => {
		let active = true
		const refresh = async () => {
			try {
				const stored = ModeTargets.parse(await browser.storage.local.get(['selectedSigningAddress', 'activeSigningSafeAddress', 'activeSigningAddress', 'independentActiveSimulationAddress']))
				if (active) setAddress(mode === 'simulation' ? stored.independentActiveSimulationAddress : stored.selectedSigningAddress ?? stored.activeSigningSafeAddress ?? stored.activeSigningAddress)
			} catch (failure) { if (active) setError(failure instanceof Error ? failure.message : 'Unable to load remembered address') }
		}
		void refresh()
		browser.storage?.onChanged?.addListener(refresh)
		return () => { active = false; browser.storage?.onChanged?.removeListener(refresh) }
	}, [mode])
	const hex = address === undefined ? undefined : address.toString(16).padStart(40, '0')
	return <small title = { error ?? (hex === undefined ? 'No address selected' : `0x${ hex }`) }>{ error === undefined ? hex === undefined ? 'No address selected' : `0x${ hex.slice(0, 4) }…${ hex.slice(-4) }` : 'Address unavailable' }</small>
}
