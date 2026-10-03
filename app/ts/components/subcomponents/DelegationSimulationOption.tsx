import { useEffect, useRef } from 'preact/hooks'
import { useSignal, type ReadonlySignal } from '@preact/signals'
import { sendPopupMessageWithReply } from '../../background/backgroundUtils.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import type { DelegateClearingPreferences } from '../../types/delegationSimulation.js'
import type { RpcNetwork } from '../../types/rpc.js'
import { checksummedAddress } from '../../utils/bigint.js'
import { browserStorageLocalSafeParse } from '../../utils/storageUtils.js'

type DelegationStatus = { type: 'delegated', delegate: bigint } | { type: 'none' } | { type: 'unknown' }
type DelegationOption = { address: bigint, chainId: bigint, status: DelegationStatus, enabled: boolean }
type PreferenceSnapshot = { revision: number, value: DelegateClearingPreferences | undefined }

function reconcileEnabledPreference(address: bigint, chainId: bigint, replyEnabled: boolean, requestedRevision: number, latest: PreferenceSnapshot) {
	return latest.revision === requestedRevision ? replyEnabled : latest.value?.some((entry) => entry.address === address && entry.chainId === chainId) ?? false
}

export function DelegationSimulationOption({ activeAddress, rpcNetwork, simulationMode }: {
	activeAddress: ReadonlySignal<AddressBookEntry | undefined>
	rpcNetwork: ReadonlySignal<RpcNetwork | undefined>
	simulationMode: ReadonlySignal<boolean>
}) {
	const delegationOption = useSignal<DelegationOption | undefined>(undefined)
	const latestPreferences = useRef<PreferenceSnapshot>({ revision: 0, value: undefined })
	const pending = useSignal(false)
	const errorText = useSignal<string | undefined>(undefined)
	const address = activeAddress.value?.type === 'safe' ? undefined : activeAddress.value?.address
	const chainId = rpcNetwork.value?.chainId

	useEffect(() => {
		const storageChanges = typeof browser === 'undefined' ? undefined : browser.storage?.onChanged
		if (storageChanges === undefined) return
		const onStorageChanged = (changes: { readonly delegateClearingPreferences?: browser.storage.StorageChange }, areaName: string) => {
			if (areaName !== 'local' || changes.delegateClearingPreferences === undefined) return
			const preferences = browserStorageLocalSafeParse({ delegateClearingPreferences: changes.delegateClearingPreferences.newValue })?.delegateClearingPreferences ?? []
			latestPreferences.current = { revision: latestPreferences.current.revision + 1, value: preferences }
			const current = delegationOption.value
			if (current === undefined) return
			delegationOption.value = { ...current, enabled: preferences.some((entry) => entry.address === current.address && entry.chainId === current.chainId) }
		}
		storageChanges.addListener(onStorageChanged)
		return () => storageChanges.removeListener(onStorageChanged)
	}, [])

	useEffect(() => {
		delegationOption.value = undefined
		errorText.value = undefined
		if (!simulationMode.value || address === undefined || chainId === undefined || typeof browser === 'undefined' || browser.runtime?.sendMessage === undefined) return
		let disposed = false
		const requestedRevision = latestPreferences.current.revision
		void (async () => {
			const reply = await sendPopupMessageWithReply({ method: 'popup_requestDelegationSimulation', data: { address, chainId } })
			if (disposed || reply?.data.address !== address || reply.data.chainId !== chainId) return
			const enabled = reconcileEnabledPreference(address, chainId, reply.data.enabled, requestedRevision, latestPreferences.current)
			delegationOption.value = { address, chainId, status: reply.data.status, enabled }
		})()
		return () => { disposed = true }
	}, [simulationMode.value, address, chainId, rpcNetwork.value?.httpsRpc])

	const current = delegationOption.value
	if (current === undefined || !simulationMode.value || current.address !== address || current.chainId !== chainId || (current.status.type !== 'delegated' && !current.enabled)) return <></>

	const change = async (enabled: boolean) => {
		pending.value = true
		errorText.value = undefined
		const requestedRevision = latestPreferences.current.revision
		try {
			const reply = await sendPopupMessageWithReply({ method: 'popup_setDelegationSimulation', data: { address: current.address, chainId: current.chainId, enabled } })
			if (reply === undefined) throw new Error('Interceptor did not reply while updating the delegation simulation option.')
			if (!reply.data.ok) throw new Error(reply.data.message)
			if (delegationOption.value?.address === reply.data.address && delegationOption.value.chainId === reply.data.chainId) {
				delegationOption.value = { ...delegationOption.value, enabled: reconcileEnabledPreference(reply.data.address, reply.data.chainId, reply.data.enabled, requestedRevision, latestPreferences.current) }
			}
		} catch (error) {
			errorText.value = error instanceof Error ? error.message : 'Could not update the delegation simulation option.'
		} finally {
			pending.value = false
		}
	}

	return <details class = 'delegation-simulation-option'>
		<summary>{ current.status.type === 'delegated' ? 'Delegated account options' : 'Delegate clearing active' }</summary>
		<div class = 'delegation-simulation-option-content'>
			{ current.status.type === 'delegated' ? <p class = 'paragraph'>Delegated to { checksummedAddress(current.status.delegate) }</p>
				: <p class = 'paragraph'>{ current.status.type === 'none' ? 'No delegate is currently detected.' : 'Could not confirm the current delegate.' }</p> }
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
