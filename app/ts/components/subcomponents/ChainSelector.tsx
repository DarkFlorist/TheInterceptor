import { useRef, useState, useEffect } from 'preact/hooks'
import { clickOutsideAlerter } from '../ui-utils.js'
import { ExternalPopupMessage } from '../../utils/interceptor-messages.js'
import { RpcEntries, RpcEntry, RpcNetwork } from '../../utils/visualizer-types.js'

interface ChainSelectorParams {
	rpcNetwork: RpcNetwork
	changeRpc: (entry: RpcEntry) => void
}

export function ChainSelector(params: ChainSelectorParams) {
	const [isOpen, setIsOpen] = useState(false)
	const [rpcEntries, setRpcEntries] = useState<RpcEntries | undefined>(undefined)

	useEffect(() => {
		async function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method === 'popup_update_rpc_list') return setRpcEntries(message.data)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	const wrapperRef = useRef<HTMLDivElement>(null);
	clickOutsideAlerter(wrapperRef, () => setIsOpen(false));

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
				{ params.rpcNetwork.name } ▼
			</button>
		</div>
		<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = 'right: -10px; min-width: 160px; left: unset'>
			<div class = 'dropdown-content'>
				{
					rpcEntries === undefined ? <></> : rpcEntries.map((rpcEntry) => { return (
						<a href = '#' class = { `dropdown-item ${ rpcEntry.httpsRpc === params.rpcNetwork.httpsRpc ? 'is-active' : '' }` } onClick = { () => changeRpc(rpcEntry) } >
							{ rpcEntry.name }
						</a>
					)})
				}
			</div>
		</div>
	</div>
}
