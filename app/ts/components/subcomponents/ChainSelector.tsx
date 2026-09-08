import { getRpcEntryIdentityKey } from '../../utils/rpcNetworkChange.js'
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

export function findRpcEntryByIdentityKey(rpcEntries: RpcEntries, key: string) {
	return rpcEntries.find((entry) => getRpcEntryIdentityKey(entry) === key)
}

function getBaseRpcEntryLabel(rpcEntries: RpcEntries, entry: RpcNetwork) {
	const sameName = rpcEntries.filter((other) => other.name === entry.name)
	if (sameName.some((other) => other.chainId !== entry.chainId && other.httpsRpc === entry.httpsRpc)) return `${ entry.name } (chain ${ entry.chainId }, ${ entry.httpsRpc })`
	return sameName.some((other) => other.httpsRpc !== entry.httpsRpc) ? `${ entry.name } (${ entry.httpsRpc })` : entry.name
}

export function getRpcEntryLabel(rpcEntries: RpcEntries, entry: RpcNetwork) {
	const baseLabel = getBaseRpcEntryLabel(rpcEntries, entry)
	const matching = rpcEntries.filter(other => getBaseRpcEntryLabel(rpcEntries, other) === baseLabel)
	const currencyDiffers = matching.some(other => other.currencyName !== entry.currencyName || other.currencyTicker !== entry.currencyTicker)
	const label = currencyDiffers ? `${ baseLabel } (${ entry.currencyTicker }, ${ entry.currencyName })` : baseLabel
	const variants = Array.from(new Map(matching
		.filter(other => !currencyDiffers || other.currencyName === entry.currencyName && other.currencyTicker === entry.currencyTicker)
		.map(other => [getRpcEntryIdentityKey(other), other])).keys())
	const index = variants.indexOf(getRpcEntryIdentityKey(entry))
	// List order gives otherwise identical labels a stable discriminator without exposing credentials from metadata.
	return variants.length > 1 && index !== -1 ? `${ label } (connection ${ index + 1 })` : label
}

export function RpcSelector(params: RpcSelectorParams) {
	const options = useComputed(() => params.rpcEntries.value.map(getRpcEntryIdentityKey))
	const selected = useComputed(() => params.rpcNetwork.value === undefined ? '' : getRpcEntryIdentityKey(params.rpcNetwork.value))
	const getOptionLabel = (key: string) => {
		const entry = findRpcEntryByIdentityKey(params.rpcEntries.value, key) ?? params.rpcNetwork.value
		return entry === undefined ? 'No RPC Selected' : getRpcEntryLabel(params.rpcEntries.value, entry)
	}
	const onChangedCallBack = (key: string) => {
		const newEntry = findRpcEntryByIdentityKey(params.rpcEntries.value, key)
		if (newEntry === undefined) throw new Error('Tried to select an RPC entry that is no longer available.')
		params.changeRpc(newEntry)
	}
	return <DropDownMenu selected = { selected } dropDownOptions = { options } getOptionLabel = { getOptionLabel } onChangedCallBack = { onChangedCallBack } buttonClassses = 'btn btn--outline is-small' disabled = { params.disabled }/>
}

interface ChainSelectorParams {
	chainId: ReadonlySignal<ChainIdWithUniversal>
	rpcEntries: Signal<RpcEntries>
	changeChain: (entry: ChainEntry) => void
	buttonClassses: string
	ariaLabel?: string
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
	return <DropDownMenu selected = { selected } dropDownOptions = { options } onChangedCallBack = { onChangedCallBack } buttonClassses = { params.buttonClassses } ariaLabel = { params.ariaLabel }/>
}
