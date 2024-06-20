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

	const wrapperRef = useRef<HTMLDivElement>(null);
	clickOutsideAlerter(wrapperRef, () => setIsOpen(false));

	function changeRpc(entry: RpcEntry) {
		params.changeRpc(entry)
		setIsOpen(false)
	}

	return <div ref = { wrapperRef } class = { `dropdown ${ isOpen ? 'is-active' : '' }` }  style = 'text-align: end;'>
		<div class = 'dropdown-trigger' style = 'width: 100%;'>
			<button className = { `button is-primary ${ params.rpcNetwork.httpsRpc === undefined ? 'is-danger' : '' }` } aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { () => setIsOpen(!isOpen) } title = { params.rpcNetwork.name }>
				{ params.rpcNetwork.httpsRpc === undefined ? <span class = 'icon' style = 'margin-left: 0em; margin-right: 0.5em;'>
					<img src = '../img/warning-sign-white.svg' />
				</span> : <></> }
				<span>{ params.rpcNetwork.name }</span>
{ /* 				<span style = 'overflow: hidden; white-space: nowrap; display: block; max-width: 160px; text-overflow: ellipsis;'>{ params.rpcNetwork.name }</span> */ }
			</button>
		</div>
		<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = 'right: -10px; left: unset'>
			<div class = 'dropdown-content'>
				{
					params.rpcEntries.map((rpcEntry) => { return (
						<a href = '#' class = { `dropdown-item ${ rpcEntry.httpsRpc === params.rpcNetwork.httpsRpc ? 'is-active' : '' }` } onClick = { () => changeRpc(rpcEntry) } >
							{ rpcEntry.name }
						</a>
					)})
				}
			</div>
		</div>
	</div>
}
