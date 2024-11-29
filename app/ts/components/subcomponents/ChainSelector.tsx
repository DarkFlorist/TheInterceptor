import { useRef } from 'preact/hooks'
import { clickOutsideAlerter, rpcEntriesToChainEntriesWithAllChainsEntry } from '../ui-utils.js'
import { ChainEntry, RpcEntries, RpcEntry, RpcNetwork } from '../../types/rpc.js'
import { ReadonlySignal, Signal, useComputed, useSignal } from '@preact/signals'
import { ChainIdWithUniversal } from '../../types/addressBookTypes.js'

interface RpcSelectorParams {
	rpcNetwork: ReadonlySignal<RpcNetwork | undefined>
	rpcEntries: Signal<RpcEntries>
	changeRpc: (entry: RpcEntry) => void
}

export function RpcSelector(params: RpcSelectorParams) {
	const isOpen = useSignal(false)

	const wrapperRef = useRef<HTMLDivElement>(null)
	clickOutsideAlerter(wrapperRef, () => { isOpen.value = false })

	function changeRpc(entry: RpcEntry) {
		params.changeRpc(entry)
		isOpen.value = false
	}

	return <div ref = { wrapperRef } class = { `dropdown ${ isOpen.value ? 'is-active' : '' }` } style = { { justifyContent: 'end', width: '100%' } }>
		<div class = 'dropdown-trigger' style = { { maxWidth: '100%' } }>
			<button className = { `button is-primary is-reveal ${ params.rpcNetwork.value === undefined || params.rpcNetwork.value.httpsRpc === undefined ? 'is-danger' : ''}` } aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { () => { isOpen.value = !isOpen.value } } title = { params.rpcNetwork.value === undefined ? 'unknown' : params.rpcNetwork.value.name  } style = { { width: '100%', columnGap: '0.5em' } }>
				<span class = 'truncate' style = { { contain: 'content' } }>{ params.rpcNetwork.value === undefined ? 'unknown' : params.rpcNetwork.value.name }</span>
			</button>
		</div>
		<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = { { left: 'unset' } }>
			<div class = 'dropdown-content' style = { { position: 'fixed' } }> {
				params.rpcEntries.value.map((rpcEntry) => <>
					<button type = 'button' class = { `dropdown-item ${ params.rpcNetwork.value !== undefined && rpcEntry.httpsRpc === params.rpcNetwork.value.httpsRpc ? 'is-active' : '' }` } onClick = { () => changeRpc(rpcEntry) } >
						{ rpcEntry.name }
					</button>
				</>)
			} </div>
		</div>
	</div>
}

interface ChainSelectorParams {
	chainId: ReadonlySignal<ChainIdWithUniversal>
	rpcEntries: Signal<RpcEntries>
	changeChain: (entry: ChainEntry) => void
}

export function ChainSelector(params: ChainSelectorParams) {
	const isOpen = useSignal(false)
	const chains = useComputed(() => rpcEntriesToChainEntriesWithAllChainsEntry(params.rpcEntries.value))
	const chain = useComputed(() => chains.value.find((chainEntry) => chainEntry.chainId === params.chainId.value))
	const wrapperRef = useRef<HTMLDivElement>(null)
	clickOutsideAlerter(wrapperRef, () => { isOpen.value = false })

	function changeChain(entry: ChainEntry) {
		params.changeChain(entry)
		isOpen.value = false
	}

	return <div ref = { wrapperRef } class = { `dropdown ${ isOpen.value ? 'is-active' : '' }` } style = { { width: '100%' } }>
		<div class = 'dropdown-trigger' style = { { maxWidth: '100%' } }>
			<button className = { `button is-primary is-reveal ${ chain.value === undefined ? 'is-danger' : '' }` } aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { () => { isOpen.value = !isOpen.value } } title = { chain.value === undefined ? 'unknown' : chain.value.name  } style = { { width: '100%', columnGap: '0.5em' } }>
				<span class = 'truncate' style = { { contain: 'content' } }>{ chain.value === undefined ? 'unknown' : chain.value.name }</span>
			</button>
		</div>
		<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = { { left: 'unset' } }>
			<div class = 'dropdown-content' style = { { position: 'fixed' } }> {
				chains.value.map((chainEntry) => <>
					<button type = 'button' class = { `dropdown-item ${ chain.value !== undefined && chainEntry.chainId === chain.value?.chainId ? 'is-active' : '' }` } onClick = { () => changeChain(chainEntry) } >
						{ chainEntry.name }
					</button>
				</>)
			} </div>
		</div>
	</div>
}
