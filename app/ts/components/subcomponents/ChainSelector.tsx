import { rpcEntriesToChainEntriesWithAllChainsEntry } from '../ui-utils.js'
import { ChainEntry, RpcEntries, RpcEntry, RpcNetwork } from '../../types/rpc.js'
import { ReadonlySignal, Signal, useComputed } from '@preact/signals'
import { ChainIdWithUniversal } from '../../types/addressBookTypes.js'
import { DropDownMenu } from './DropDownMenu.js'

interface RpcSelectorParams {
	rpcNetwork: ReadonlySignal<RpcNetwork | undefined>
	rpcEntries: Signal<RpcEntries>
	changeRpc: (entry: RpcEntry) => void
}

export function RpcSelector(params: RpcSelectorParams) {
	const options = useComputed(() => params.rpcEntries.value.map((rpcEntry) => rpcEntry.name))
	const selected = useComputed(() => params.rpcNetwork.value?.name || 'No RPC Selected')
	const onChangedCallBack = (rpcName: string) => {
		const newEntry = params.rpcEntries.value.find((rpcEntry) => rpcEntry.name === rpcName)
		if (newEntry === undefined) throw new Error(`Tried to change rpc that does not exist: ${ rpcName }`)
		params.changeRpc(newEntry)
	}
	return <DropDownMenu selected = { selected } dropDownOptions = { options } onChangedCallBack = { onChangedCallBack } buttonClassses = 'btn btn--outline is-small'/>
}

interface ChainSelectorParams {
	chainId: ReadonlySignal<ChainIdWithUniversal>
	rpcEntries: Signal<RpcEntries>
	changeChain: (entry: ChainEntry) => void
	buttonClassses: string
}

export function ChainSelector(params: ChainSelectorParams) {
	const chains = useComputed(() => rpcEntriesToChainEntriesWithAllChainsEntry(params.rpcEntries.value))
	const options = useComputed(() => chains.value.map((entry) => entry.name))
	const selected = useComputed(() => chains.value.find((chainEntry) => chainEntry.chainId === params.chainId.value)?.name || 'No Chain Selected')
	const onChangedCallBack = (rpcName: string) => {
		const newEntry = params.rpcEntries.value.find((rpcEntry) => rpcEntry.name === rpcName)
		if (newEntry === undefined) throw new Error(`Tried to change chain that does not exist: ${ rpcName }`)
		params.changeChain(newEntry)
	}
	return <DropDownMenu selected = { selected } dropDownOptions = { options } onChangedCallBack = { onChangedCallBack } buttonClassses = { params.buttonClassses }/>
}
