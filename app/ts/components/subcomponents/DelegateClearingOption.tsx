import { useEffect } from 'preact/hooks'
import { useSignal, type ReadonlySignal } from '@preact/signals'
import { sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { DelegateClearingPreferences } from '../../types/delegateClearing.js'
import type { RpcNetwork } from '../../types/rpc.js'
import { checksummedAddress } from '../../utils/bigint.js'
import { hasDelegateClearingPreference } from '../../utils/delegateClearingState.js'

type DelegationStatus = { type: 'delegated', delegate: bigint } | { type: 'none' } | { type: 'unknown' }
type DelegationOption = { address: bigint, chainId: bigint, status: DelegationStatus, checkedAt: number }
const UNKNOWN_DELEGATION_RETRY_MS = 60 * 1000

export function DelegateClearingOption({ activeAddress, rpcNetwork, simulationMode, preferences, currentBlockNumber }: {
	activeAddress: ReadonlySignal<AddressBookEntry | undefined>
	rpcNetwork: ReadonlySignal<RpcNetwork | undefined>
	simulationMode: ReadonlySignal<boolean>
	preferences: ReadonlySignal<DelegateClearingPreferences>
	currentBlockNumber: ReadonlySignal<bigint | undefined>
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
			const reply = await sendPopupMessageWithReply({ method: 'popup_requestDelegateClearing', data: { address, chainId } })
			if (disposed || reply?.data.address !== address || reply.data.chainId !== chainId) return
			delegationOption.value = { address, chainId, status: reply.data.status, checkedAt: Date.now() }
		})()
		return () => { disposed = true }
	}, [simulationMode.value, address, chainId, rpcNetwork.value?.httpsRpc])

	useEffect(() => {
		const current = delegationOption.value
		if (!simulationMode.value || currentBlockNumber.value === undefined || address === undefined || chainId === undefined
			|| current?.address !== address || current.chainId !== chainId) return
		// Block updates trigger a recheck; the shared background cache bounds RPC reads.
		if (current.status.type === 'unknown' && Date.now() - current.checkedAt < UNKNOWN_DELEGATION_RETRY_MS) return
		let disposed = false
		void (async () => {
			const reply = await sendPopupMessageWithReply({ method: 'popup_requestDelegateClearing', data: { address, chainId } })
			if (disposed || reply?.data.address !== address || reply.data.chainId !== chainId) return
			delegationOption.value = { address, chainId, status: reply.data.status, checkedAt: Date.now() }
		})()
		return () => { disposed = true }
	}, [currentBlockNumber.value, simulationMode.value, address, chainId])

	const current = delegationOption.value
	const enabled = hasDelegateClearingPreference(preferences.value, address, chainId)
	const status = current !== undefined && current.address === address && current.chainId === chainId ? current.status : { type: 'unknown' as const }
	if (address === undefined || chainId === undefined || !simulationMode.value || (status.type !== 'delegated' && !enabled)) return <></>

	const change = async (enabled: boolean) => {
		pending.value = true
		errorText.value = undefined
		try {
			const reply = await sendPopupMessageWithReply({ method: 'popup_setDelegateClearing', data: { address, chainId, enabled } })
			if (reply === undefined) throw new Error('Interceptor did not reply while updating the delegate clearing option.')
			if (!reply.data.ok) throw new Error(reply.data.message)
		} catch (error) {
			errorText.value = error instanceof Error ? error.message : 'Could not update the delegate clearing option.'
		} finally {
			pending.value = false
		}
	}

	return <details class = 'delegate-clearing-option'>
		<summary>{ status.type === 'delegated' ? 'Delegated account options' : 'Delegate clearing active' }</summary>
		<div class = 'delegate-clearing-option-content'>
			{ status.type === 'delegated' ? <p class = 'paragraph'>Delegated to { checksummedAddress(status.delegate) }</p>
				: <p class = 'paragraph'>{ status.type === 'none' ? 'No delegate is currently detected.' : 'Could not confirm the current delegate.' }</p> }
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { enabled } disabled = { pending.value } onInput = { event => {
					if (event.target instanceof HTMLInputElement) void change(event.target.checked)
				} } />
				<span>Simulate with delegate cleared</span>
			</label>
			<p class = 'paragraph'>Connected websites can read the cleared code in simulation mode, even with an empty queue. On-chain delegation and signing previews stay unchanged.</p>
			{ errorText.value === undefined ? <></> : <p class = 'paragraph' role = 'alert'>{ errorText.value }</p> }
		</div>
	</details>
}
