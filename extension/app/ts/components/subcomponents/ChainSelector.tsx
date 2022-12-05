import { useRef, useState } from 'preact/hooks'
import { CHAINS, getChainName, isSupportedChain } from '../../utils/constants'
import { clickOutsideAlerter } from '../ui-utils'

interface ChainSelectorParams {
	currentChain: bigint,
	changeChain: (chain: bigint) => void
}

export function ChainSelector(params: ChainSelectorParams) {
	const [isOpen, setIsOpen] = useState(false)

	const wrapperRef = useRef<HTMLDivElement>(null);
	clickOutsideAlerter(wrapperRef, () => setIsOpen(false));

	function changeChain(chainName: bigint) {
		params.changeChain(chainName)
		setIsOpen(false)
	}

	return <div ref = { wrapperRef } class = { `dropdown ${ isOpen ? 'is-active' : '' }` }  style = 'width: 160px; text-align: end;'>
		<div class = 'dropdown-trigger' style = 'width: 100%;'>
			<button className = { `button is-primary ${ !isSupportedChain(params.currentChain.toString()) ? 'is-danger' : '' }` } style = 'padding-left: 6px; padding-right: 6px;' aria-haspopup = 'true' aria-controls = 'dropdown-menu' onClick = { () => setIsOpen(!isOpen) }>
				{ !isSupportedChain(params.currentChain.toString()) ? <span class = 'icon' style = 'margin-left: 0em; margin-right: 0.5em;'>
					<img src = '../img/warning-sign-white.svg' />
				</span> : <></> }
				{ getChainName(params.currentChain) } ▼
			</button>
		</div>
		<div class = 'dropdown-menu' id = 'dropdown-menu' role = 'menu' style = 'right: -10px; min-width: 160px; left: unset'>
			<div class = 'dropdown-content'>
				{
					Object.entries(CHAINS).map( ([chainId, chainMetaData]) => { return (
						<a href = '#' class = { `dropdown-item ${ BigInt(chainId) === params.currentChain ? 'is-active' : '' }` } onClick = { () => changeChain(BigInt(chainId)) } >
							{ chainMetaData.name }
						</a>
					)})
				}
			</div>
		</div>
	</div>
}
