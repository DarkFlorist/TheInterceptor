import { rpcEntriesToChainEntriesWithAllChainsEntry } from '../ui-utils.js'
import type { ChainEntry, RpcEntries, RpcEntry, RpcNetwork } from '../../types/rpc.js'
import { type ReadonlySignal, type Signal, useComputed } from '@preact/signals'
import type { ChainIdWithUniversal } from '../../types/addressBookTypes.js'
import { DropDownMenu } from './DropDownMenu.js'

interface RpcSelectorParams {
	rpcNetwork: ReadonlySignal<RpcNetwork | undefined>
	rpcEntries: Signal<RpcEntries>
	changeRpc: (entry: RpcEntry) => void
	disabled?: boolean
}

export function findRpcEntryByUrl(rpcEntries: RpcEntries, rpcUrl: string) {
	return rpcEntries.find((rpcEntry) => rpcEntry.httpsRpc === rpcUrl)
}

export function getRpcEntryLabel(rpcEntries: RpcEntries, rpcUrl: string) {
	const entry = findRpcEntryByUrl(rpcEntries, rpcUrl)
	if (entry === undefined) return rpcUrl
	const hasDuplicateName = rpcEntries.some((otherEntry) => otherEntry.name === entry.name && otherEntry.httpsRpc !== entry.httpsRpc)
	return hasDuplicateName ? `${ entry.name } (${ entry.httpsRpc })` : entry.name
}

export function RpcSelector(params: RpcSelectorParams) {
	const options = useComputed(() => params.rpcEntries.value.map((rpcEntry) => rpcEntry.httpsRpc))
	const selected = useComputed(() => params.rpcNetwork.value?.httpsRpc ?? 'No RPC Selected')
	const getOptionLabel = (rpcUrl: string) => getRpcEntryLabel(params.rpcEntries.value, rpcUrl)
	const onChangedCallBack = (rpcUrl: string) => {
		const newEntry = findRpcEntryByUrl(params.rpcEntries.value, rpcUrl)
		if (newEntry === undefined) throw new Error(`Tried to change rpc that does not exist: ${ rpcUrl }`)
		params.changeRpc(newEntry)
	}
	return <DropDownMenu selected = { selected } dropDownOptions = { options } getOptionLabel = { getOptionLabel } onChangedCallBack = { onChangedCallBack } buttonClassses = 'btn btn--outline is-small' disabled = { params.disabled }/>
}

interface ChainSelectorParams {
	chainId: ReadonlySignal<ChainIdWithUniversal>
	rpcEntries: Signal<RpcEntries>
	changeChain: (entry: ChainEntry) => void
	buttonClassses: string
}

export function findChainEntryByName(chains: readonly ChainEntry[], chainName: string) {
	return chains.find((chainEntry) => chainEntry.name === chainName)
}

export function ChainSelector(params: ChainSelectorParams) {
	const chains = useComputed(() => rpcEntriesToChainEntriesWithAllChainsEntry(params.rpcEntries.value))
	const options = useComputed(() => chains.value.map((entry) => entry.name))
	const selected = useComputed(() => chains.value.find((chainEntry) => chainEntry.chainId === params.chainId.value)?.name || 'No Chain Selected')
	const onChangedCallBack = (chainName: string) => {
		const newEntry = findChainEntryByName(chains.value, chainName)
		if (newEntry === undefined) throw new Error(`Tried to change chain that does not exist: ${ chainName }`)
		params.changeChain(newEntry)
	}
	return <DropDownMenu selected = { selected } dropDownOptions = { options } onChangedCallBack = { onChangedCallBack } buttonClassses = { params.buttonClassses }/>
}
