import { useEffect } from 'preact/hooks'
import { useSignal, type ReadonlySignal } from '@preact/signals'
import { sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { RpcNetwork } from '../../types/rpc.js'
import { checksummedAddress } from '../../utils/bigint.js'

type DelegatedAccount = { address: bigint, chainId: bigint, delegate: bigint, enabled: boolean }

export function DelegationSimulationOption({ activeAddress, rpcNetwork, simulationMode }: {
	activeAddress: ReadonlySignal<AddressBookEntry | undefined>
	rpcNetwork: ReadonlySignal<RpcNetwork | undefined>
	simulationMode: ReadonlySignal<boolean>
}) {
	const delegatedAccount = useSignal<DelegatedAccount | undefined>(undefined)
	const pending = useSignal(false)
	const errorText = useSignal<string | undefined>(undefined)
	const address = activeAddress.value?.type === 'safe' ? undefined : activeAddress.value?.address
	const chainId = rpcNetwork.value?.chainId
	const rpcUrl = rpcNetwork.value?.httpsRpc

	useEffect(() => {
		delegatedAccount.value = undefined
		errorText.value = undefined
		if (!simulationMode.value || address === undefined || chainId === undefined || rpcUrl === undefined) return
		let disposed = false
		void (async () => {
			const reply = await sendPopupMessageWithReply({ method: 'popup_requestDelegationSimulation', data: { address, chainId } })
			if (disposed || reply?.data.address !== address || reply.data.chainId !== chainId) return
			if (reply.data.status.type === 'delegated') delegatedAccount.value = { address, chainId, delegate: reply.data.status.delegate, enabled: reply.data.enabled }
		})()
		return () => { disposed = true }
	}, [simulationMode.value, address, chainId, rpcUrl])

	const current = delegatedAccount.value
	if (current === undefined || !simulationMode.value || current.address !== address || current.chainId !== chainId) return <></>

	const change = async (enabled: boolean) => {
		pending.value = true
		errorText.value = undefined
		try {
			const reply = await sendPopupMessageWithReply({ method: 'popup_setDelegationSimulation', data: { address: current.address, chainId: current.chainId, enabled } })
			if (reply === undefined) throw new Error('Interceptor did not reply while updating the delegation simulation option.')
			if (!reply.data.ok) throw new Error(reply.data.message)
			if (delegatedAccount.value?.address === reply.data.address && delegatedAccount.value.chainId === reply.data.chainId) {
				delegatedAccount.value = { ...delegatedAccount.value, enabled: reply.data.enabled }
			}
		} catch (error) {
			errorText.value = error instanceof Error ? error.message : 'Could not update the delegation simulation option.'
		} finally {
			pending.value = false
		}
	}

	return <details class = 'delegation-simulation-option'>
		<summary>Delegated account options</summary>
		<div class = 'delegation-simulation-option-content'>
			<p class = 'paragraph'>Delegated to { checksummedAddress(current.delegate) }</p>
			<label class = 'form-control'>
				<input type = 'checkbox' checked = { current.enabled } disabled = { pending.value } onInput = { event => {
					if (event.target instanceof HTMLInputElement) void change(event.target.checked)
				} } />
				<span>Simulate with delegate cleared</span>
			</label>
			<p class = 'paragraph'>This changes Interceptor simulations only. It does not clear the delegate on chain.</p>
			{ errorText.value === undefined ? <></> : <p class = 'paragraph' role = 'alert'>{ errorText.value }</p> }
		</div>
	</details>
}
