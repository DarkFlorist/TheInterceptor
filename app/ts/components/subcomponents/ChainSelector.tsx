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

	return <div ref = { wrapperRef } class = { `dropdown ${ isOpen ? 'is-active' : '' }` }  style = 'width: 160px; text-align: end;'>
		<div class = 'dropdown-trigger' style = 'width: 100%;'>
			<button className = { `button is-primary ${ params.rpcNetwork.httpsRpc === undefined ? 'is-danger' : '' }` } style = 'padding-left: 6px; padding-right: 6px;' aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { () => setIsOpen(!isOpen) }>
				{ params.rpcNetwork.httpsRpc === undefined ? <span class = 'icon' style = 'margin-left: 0em; margin-right: 0.5em;'>
					<img src = '../img/warning-sign-white.svg' />
				</span> : <></> }
				<p style = 'overflow: hidden; white-space: nowrap; display: block; max-width: 160px; text-overflow: ellipsis;'>{ params.rpcNetwork.name } ▼ </p>
			</button>
		</div>
		<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = 'right: -10px; min-width: 160px; left: unset'>
			<div class = 'dropdown-content'>
				{
					params.rpcEntries.map((rpcEntry) => { return (
						<a href = '#' class = { `dropdown-item ${ rpcEntry.httpsRpc === params.rpcNetwork.httpsRpc ? 'is-active' : '' }` } onClick = { () => changeRpc(rpcEntry) } >
							{ rpcEntry.name }
						</a>
					) })
				}
			</div>
		</div>
	</div>
}
