import { useRef, useState, useEffect } from 'preact/hooks'
import { clickOutsideAlerter } from '../ui-utils.js'
import { ExternalPopupMessage, RPCEntries, RPCEntry, SelectedNetwork } from '../../utils/interceptor-messages.js'

interface ChainSelectorParams {
	selectedNetwork: SelectedNetwork
	changeRPC: (entry: RPCEntry) => void
}

export function ChainSelector(params: ChainSelectorParams) {
	const [isOpen, setIsOpen] = useState(false)
	const [rpcEntries, setRPCEntries] = useState<RPCEntries | undefined>(undefined)

	useEffect(() => {
		async function popupMessageListener(msg: unknown) {
			const message = ExternalPopupMessage.parse(msg)
			if (message.method === 'popup_update_rpc_list') return setRPCEntries(message.data)
		}
		browser.runtime.onMessage.addListener(popupMessageListener)

		return () => browser.runtime.onMessage.removeListener(popupMessageListener)
	})

	const wrapperRef = useRef<HTMLDivElement>(null);
	clickOutsideAlerter(wrapperRef, () => setIsOpen(false));

	function changeRPC(entry: RPCEntry) {
		params.changeRPC(entry)
		setIsOpen(false)
	}

	return <div ref = { wrapperRef } class = { `dropdown ${ isOpen ? 'is-active' : '' }` }  style = 'width: 160px; text-align: end;'>
		<div class = 'dropdown-trigger' style = 'width: 100%;'>
			<button className = { `button is-primary ${ params.selectedNetwork.https_rpc === undefined ? 'is-danger' : '' }` } style = 'padding-left: 6px; padding-right: 6px;' aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { () => setIsOpen(!isOpen) }>
				{ params.selectedNetwork.https_rpc === undefined ? <span class = 'icon' style = 'margin-left: 0em; margin-right: 0.5em;'>
					<img src = '../img/warning-sign-white.svg' />
				</span> : <></> }
				{ params.selectedNetwork.name } ▼
			</button>
		</div>
		<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = 'right: -10px; min-width: 160px; left: unset'>
			<div class = 'dropdown-content'>
				{
					rpcEntries === undefined ? <></> : rpcEntries.map((rpcEntry) => { return (
						<a href = '#' class = { `dropdown-item ${ rpcEntry.https_rpc === params.selectedNetwork.https_rpc ? 'is-active' : '' }` } onClick = { () => changeRPC(rpcEntry) } >
							{ rpcEntry.name }
						</a>
					)})
				}
			</div>
		</div>
	</div>
}
