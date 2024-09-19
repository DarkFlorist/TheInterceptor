import { useRef, useState } from 'preact/hooks'
import { clickOutsideAlerter } from '../ui-utils.js'
import { RpcEntries, RpcEntry, RpcNetwork } from '../../types/rpc.js'

interface ChainSelectorParams {
	rpcNetwork: RpcNetwork
	rpcEntries: RpcEntries
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
			<button className = { `button is-primary is-reveal ${ params.rpcNetwork.httpsRpc === undefined ? 'is-danger' : ''}` } aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { () => setIsOpen(!isOpen) } title = { params.rpcNetwork.name } style = { { width: '100%', columnGap: '0.5em' } }>
				<span class = 'truncate' style = { { contain: 'content' } }>{ params.rpcNetwork.name }</span>
			</button>
		</div>
		<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = { { left: 'unset' } }>
			<div class = 'dropdown-content'>
				{
					params.rpcEntries.map((rpcEntry) => {
						return (
							<button type = 'button' class = { `dropdown-item ${ rpcEntry.httpsRpc === params.rpcNetwork.httpsRpc ? 'is-active' : '' }` } onClick = { () => changeRpc(rpcEntry) } >
								{ rpcEntry.name }
							</button>
						)
					})
				}
			</div>
		</div>
	</div>
}
