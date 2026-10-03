import { useEffect } from 'preact/hooks'
import { useSignal, type ReadonlySignal } from '@preact/signals'
import { sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { DelegateClearingPreferences } from '../../types/delegationSimulation.js'
import type { RpcNetwork } from '../../types/rpc.js'
import { checksummedAddress } from '../../utils/bigint.js'
import { hasDelegateClearingPreference } from '../../utils/delegateClearingState.js'

type DelegationStatus = { type: 'delegated', delegate: bigint } | { type: 'none' } | { type: 'unknown' }
type DelegationOption = { address: bigint, chainId: bigint, status: DelegationStatus }

export function DelegationSimulationOption({ activeAddress, rpcNetwork, simulationMode, preferences }: {
	activeAddress: ReadonlySignal<AddressBookEntry | undefined>
	rpcNetwork: ReadonlySignal<RpcNetwork | undefined>
	simulationMode: ReadonlySignal<boolean>
	preferences: ReadonlySignal<DelegateClearingPreferences>
}) {
	const delegationOption = useSignal<DelegationOption | undefined>(undefined)
	const pending = useSignal(false)
	const errorText = useSignal<string | undefined>(undefined)
	const address = activeAddress.value?.type === 'safe' ? undefined : activeAddress.value?.address
	const chainId = rpcNetwork.value?.chainId

	useEffect(() => {
		delegationOption.value = undefined
		errorText.value = undefined
		if (!simulationMode.value || address === undefined || chainId === undefined || typeof browser === 'undefined' || browser.runtime?.sendMessage === undefined) return
		let disposed = false
		void (async () => {
			const reply = await sendPopupMessageWithReply({ method: 'popup_requestDelegationSimulation', data: { address, chainId } })
			if (disposed || reply?.data.address !== address || reply.data.chainId !== chainId) return
			delegationOption.value = { address, chainId, status: reply.data.status }
		})()
		return () => { disposed = true }
	}, [simulationMode.value, address, chainId, rpcNetwork.value?.httpsRpc])

	const current = delegationOption.value
	const enabled = hasDelegateClearingPreference(preferences.value, address, chainId)
	const status = current !== undefined && current.address === address && current.chainId === chainId ? current.status : { type: 'unknown' as const }
	if (address === undefined || chainId === undefined || !simulationMode.value || (status.type !== 'delegated' && !enabled)) return <></>

	const change = async (enabled: boolean) => {
		pending.value = true
		errorText.value = undefined
		try {
			const reply = await sendPopupMessageWithReply({ method: 'popup_setDelegationSimulation', data: { address, chainId, enabled } })
			if (reply === undefined) throw new Error('Interceptor did not reply while updating the delegation simulation option.')
			if (!reply.data.ok) throw new Error(reply.data.message)
		} catch (error) {
			errorText.value = error instanceof Error ? error.message : 'Could not update the delegation simulation option.'
		} finally {
			pending.value = false
		}
	}

	return <details class = 'delegation-simulation-option'>
		<summary>{ status.type === 'delegated' ? 'Delegated account options' : 'Delegate clearing active' }</summary>
		<div class = 'delegation-simulation-option-content'>
			{ status.type === 'delegated' ? <p class = 'paragraph'>Delegated to { checksummedAddress(status.delegate) }</p>
				: <p class = 'paragraph'>{ status.type === 'none' ? 'No delegate is currently detected.' : 'Could not confirm the current delegate.' }</p> }
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { enabled } disabled = { pending.value } onInput = { event => {
					if (event.target instanceof HTMLInputElement) void change(event.target.checked)
				} } />
				<span>Simulate with delegate cleared</span>
			</label>
			<p class = 'paragraph'>This changes what-if simulations only. Transaction approval previews use the delegate on chain.</p>
			{ errorText.value === undefined ? <></> : <p class = 'paragraph' role = 'alert'>{ errorText.value }</p> }
		</div>
	</details>
}
