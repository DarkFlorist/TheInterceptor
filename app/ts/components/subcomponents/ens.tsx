import { JSX } from 'preact/jsx-runtime'
import { EthereumBytes32 } from '../../types/wire-types.js'
import { bytes32String, stringToUint8Array } from '../../utils/bigint.js'
import { CopyToClipboard } from './CopyToClipboard.js'
import { zorbImageDataURI } from './EnsGradient.js'

export type EditEnsNamedHashCallBack = (type: 'nameHash' | 'labelHash', nameHash: EthereumBytes32, name: string | undefined) => void

type NameHashComponentParams = {
	readonly type: 'nameHash' | 'labelHash'
	readonly nameHash: EthereumBytes32,
	readonly name: string | undefined,
	readonly style?: JSX.CSSProperties
	readonly editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

export const EnsNamedHashComponent = (params: NameHashComponentParams) => {
	const name = params.name !== undefined ? params.name : bytes32String(params.nameHash)
	const textColor = 'var(--text-color)'
	return (
		<span className = 'small-address-container' data-value = { name }>
			<span class = 'address-text-holder'>
				<span class = 'small-address-baggage-tag vertical-center' style = { params.style }>
					<span style = 'margin-right: 5px'>
						<CopyToClipboard content = { name } copyMessage = 'Copied!'>
							<img style = { { display: 'block', width: '1em', height: '1em' } } src = { zorbImageDataURI(stringToUint8Array(`0x${ params.nameHash.toString(16) }`)) }/>
						</CopyToClipboard>
					</span>
					<CopyToClipboard content = { name } copyMessage = 'Copied!' style = { { 'text-overflow': 'ellipsis', overflow: 'hidden' } }>
						<p class = 'address-text noselect nopointer' style = { `color: ${ textColor }` }>{ name }</p>
					</CopyToClipboard>
					<button className = 'button is-primary is-small rename-address-button' onClick = { () => { params.editEnsNamedHashCallBack(params.type, params.nameHash, params.name) } }>
						<span class = 'icon'>
							<img src = '../img/rename.svg'/>
						</span>
					</button>
				</span>
			</span>
		</span>
	)
}
