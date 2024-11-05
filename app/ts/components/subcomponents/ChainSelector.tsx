import { useRef, useState } from 'preact/hooks'
import { clickOutsideAlerter, rpcEntriesToChainEntriesWithAllChainsEntry } from '../ui-utils.js'
import { ChainEntry, RpcEntries, RpcEntry, RpcNetwork } from '../../types/rpc.js'
import { ReadonlySignal, Signal, useComputed } from '@preact/signals'

interface RpcSelectorParams {
	rpcNetwork: ReadonlySignal<RpcNetwork | undefined>
	rpcEntries: Signal<RpcEntries>
	changeRpc: (entry: RpcEntry) => void
}

export function RpcSelector(params: RpcSelectorParams) {
	const [isOpen, setIsOpen] = useState(false)

	const wrapperRef = useRef<HTMLDivElement>(null)
	clickOutsideAlerter(wrapperRef, () => setIsOpen(false))

	function changeRpc(entry: RpcEntry) {
		params.changeRpc(entry)
		setIsOpen(false)
	}

	return <div ref = { wrapperRef } class = { `dropdown ${ isOpen ? 'is-active' : '' }` } style = { { justifyContent: 'end', width: '100%' } }>
		<div class = 'dropdown-trigger' style = { { maxWidth: '100%' } }>
			<button className = { `button is-primary is-reveal ${ params.rpcNetwork.value === undefined || params.rpcNetwork.value.httpsRpc === undefined ? 'is-danger' : ''}` } aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { () => setIsOpen(!isOpen) } title = { params.rpcNetwork.value === undefined ? 'unknown' : params.rpcNetwork.value.name  } style = { { width: '100%', columnGap: '0.5em' } }>
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
	chain: ReadonlySignal<ChainEntry | undefined>
	rpcEntries: Signal<RpcEntries>
	changeChain: (entry: ChainEntry) => void
}


export function ChainSelector(params: ChainSelectorParams) {
	const [isOpen, setIsOpen] = useState(false)
	const chains = useComputed(() => rpcEntriesToChainEntriesWithAllChainsEntry(params.rpcEntries.value))

	const wrapperRef = useRef<HTMLDivElement>(null)
	clickOutsideAlerter(wrapperRef, () => setIsOpen(false))

	function changeChain(entry: ChainEntry) {
		params.changeChain(entry)
		setIsOpen(false)
	}

	return <div ref = { wrapperRef } class = { `dropdown ${ isOpen ? 'is-active' : '' }` } style = { { justifyContent: 'end', width: '100%' } }>
		<div class = 'dropdown-trigger' style = { { maxWidth: '100%' } }>
			<button className = { `button is-primary is-reveal ${ params.chain.value === undefined ? 'is-danger' : ''}` } aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { () => setIsOpen(!isOpen) } title = { params.chain.value === undefined ? 'unknown' : params.chain.value.name  } style = { { width: '100%', columnGap: '0.5em' } }>
				<span class = 'truncate' style = { { contain: 'content' } }>{ params.chain.value === undefined ? 'unknown' : params.chain.value.name }</span>
			</button>
		</div>
		<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = { { left: 'unset' } }>
			<div class = 'dropdown-content' style = { { position: 'fixed' } }> {
				chains.value.map((chain) => <>
					<button type = 'button' class = { `dropdown-item ${ params.chain.value !== undefined ? 'is-active' : '' }` } onClick = { () => changeChain(chain) } >
						{ chain.name }
					</button>
				</>)
			} </div>
		</div>
	</div>
}
