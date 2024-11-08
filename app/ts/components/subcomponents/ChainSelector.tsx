import { useRef, useState } from 'preact/hooks'
import { clickOutsideAlerter } from '../ui-utils.js'
import { RpcEntries, RpcEntry, RpcNetwork } from '../../types/rpc.js'
import { ReadonlySignal, Signal } from '@preact/signals'

interface ChainSelectorParams {
	rpcNetwork: ReadonlySignal<RpcNetwork | undefined>
	rpcEntries: Signal<RpcEntries>
	changeRpc: (entry: RpcEntry) => void
}

export function ChainSelector(params: ChainSelectorParams) {
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
			<div class = 'dropdown-content' style = { { position: 'fixed' } }>
				{
					params.rpcEntries.value.map((rpcEntry) => {
						return (
							<button type = 'button' class = { `dropdown-item ${ params.rpcNetwork.value !== undefined && rpcEntry.httpsRpc === params.rpcNetwork.value.httpsRpc ? 'is-active' : '' }` } onClick = { () => changeRpc(rpcEntry) } >
								{ rpcEntry.name }
							</button>
						)
					})
				}
			</div>
		</div>
	</div>
}
