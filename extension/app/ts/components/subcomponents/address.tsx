import { ethers } from 'ethers'
import { addressString } from '../../utils/bigint.js'
import { AddressMetadata } from '../../utils/visualizer-types.js'
import Blockie from './PreactBlocky.js'
import { AddressInfo } from '../../utils/user-interface-types.js'
import { CopyToClipboard } from './CopyToClipboard.js'
import { ChainSelector } from './ChainSelector.js'
import { ApproveIcon, ArrowIcon } from '../subcomponents/icons.js'

export function findAddressInfo(addressToFind: bigint, addressInfos: readonly AddressInfo[]) {
	for (const info of addressInfos) {
		if (info.address === addressToFind) {
			return info
		}
	}
	return {
		name: ethers.utils.getAddress(addressString(addressToFind)),
		address: addressToFind,
		askForAddressAccess: true,
	}
}

export type AddressIconParams = {
	address: bigint,
	logoUri: string | undefined,
	isBig: boolean
	backgroundColor: string,
}

function AddressIcon(param: AddressIconParams) {
	const style = `${ param.isBig ? `width: 40px; height: 40px; border-radius: 10px;` : `width: 24px; height: 24px; border-radius: 2px;` }`
	if (param.logoUri === undefined) {
		return <div style = { style }>
			<Blockie
				seed = { addressString(param.address).toLowerCase() }
				size = { 8 }
				scale = { param.isBig ? 5 : 3 }
			/>
		</div>
	}

	return <div style = { style }>
		<img src = { param.logoUri } style = 'width: 100%; max-height: 100%'/>
	</div>
}

export type BigAddressParamsWithChainSelector = {
	address: bigint
	title: string | undefined
	chainId: bigint
	changeActiveChain: (chainId: bigint) => void
}

export function BigAddressWithChainSelector(param: BigAddressParamsWithChainSelector) {
	const title = param.title === undefined ? ethers.utils.getAddress(addressString(param.address)): param.title
	const addrString = ethers.utils.getAddress(addressString(param.address))

	return <div class = 'media'>
		<div class = 'media-left'>
			<CopyToClipboard content = { addrString } copyMessage = 'Address copied!'>
				<figure class = 'image noselect nopointer'>
					<Blockie seed = { addressString(param.address).toLowerCase() } size = { 8 } scale = { 5 } />
				</figure>
			</CopyToClipboard>
		</div>

		<div class = 'media-content' style = 'overflow: visible;'>
			<ChainSelector currentChain = { param.chainId } changeChain = { (chainId: bigint) => { param.changeActiveChain(chainId) } }/>
			<CopyToClipboard content = { addrString } copyMessage = 'Address copied!'>
				<p class = 'subtitle is-5 noselect nopointer'>
					{ title }
				</p>
			</CopyToClipboard>
		</div>
	</div>
}

export type BigAddressParams = {
	address: bigint
	nameAndLogo: Pick<AddressMetadata, 'name' | 'logoUri'> | undefined
	noCopying?: boolean
}

export function BigAddress(params: BigAddressParams) {
	const addrString = ethers.utils.getAddress(addressString(params.address))
	const title = params.nameAndLogo === undefined || params.nameAndLogo.name === undefined ? addrString: params.nameAndLogo.name
	const subTitle = title != addrString ? addrString : ''

	return <div class = 'media'>
		<div class = 'media-left'>
			{ !params.noCopying ?
				<CopyToClipboard content = { addrString } copyMessage = 'Address copied!'>
					<span class = 'noselect nopointer'>
						<AddressIcon
							address = { params.address }
							logoUri = { params.nameAndLogo?.logoUri }
							isBig = { true }
							backgroundColor = { 'var(--text-color)' }
						/>
					</span>
				</CopyToClipboard>
			:
				<span class = 'noselect nopointer'>
					<AddressIcon
						address = { params.address }
						logoUri = { params.nameAndLogo?.logoUri }
						isBig = { true }
						backgroundColor = { 'var(--text-color)' }
					/>
				</span>
			}
		</div>

		<div class = 'media-content' style = 'overflow-y: hidden; overflow-x: clip; display: block;'>
			{ !params.noCopying ?
				<CopyToClipboard content = { addrString } copyMessage = 'Address copied!'>
					<p class = 'title is-5 noselect nopointer is-spaced' style = 'text-overflow: ellipsis; white-space: nowrap;'>
						{ title }
					</p>
				</CopyToClipboard>
			:
				<p class = 'title is-5 noselect nopointer is-spaced' style = 'text-overflow: ellipsis; white-space: nowrap;'>
					{ title }
				</p>
			}
			{ !params.noCopying ?
				<CopyToClipboard content = { addrString } copyMessage = 'Address copied!'>
					<p class = 'subtitle is-7 noselect nopointer' style = 'text-overflow: ellipsis; white-space: nowrap;'>
						{ subTitle }
					</p>
				</CopyToClipboard>
			:
				<p class = 'subtitle is-7 noselect nopointer' style = 'text-overflow: ellipsis; white-space: nowrap;'>
					{ subTitle }
				</p>
			}
		</div>
	</div>
}

export type ActiveAddressParams = {
	address: bigint
	title?: string
	subtitle?: string
	simulationMode: boolean
	changeActiveAddress: () => void
}

export function ActiveAddress(params: ActiveAddressParams) {
	const title = params.title === undefined ? ethers.utils.getAddress(addressString(params.address)): params.title
	const addrString = ethers.utils.getAddress(addressString(params.address))
	const subTitle = params.subtitle === undefined && title != addrString ? addrString : params.subtitle

	return <div class = 'media'>
		<div class = 'media-left'>
			<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.address)) } copyMessage = 'Address copied!'>
				<figure class = 'image noselect nopointer'>
					<Blockie seed = { addressString(params.address).toLowerCase() } size = { 8 } scale = { 5 } />
				</figure>
			</CopyToClipboard>
		</div>

		<div class = 'media-content' style = 'overflow-y: hidden;'>
			<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.address)) } copyMessage = 'Address copied!'>
				<p class = 'title is-5 noselect nopointer' style = 'text-overflow: ellipsis; white-space: nowrap;'>
					{ title }
				</p>
			</CopyToClipboard>
			<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.address)) } copyMessage = 'Address copied!'>
				<p class = 'subtitle is-7 noselect nopointer'>
					{ subTitle === undefined ? '' : subTitle }
				</p>
			</CopyToClipboard>
		</div>

		<div class = 'media-right'>
			<button className = 'button is-primary' disabled = { !params.simulationMode } onClick = { params.changeActiveAddress } >
				Change
			</button>
		</div>
	</div>
}

export type SmallAddressParams = {
	address: bigint,
	nameAndLogo: Pick<AddressMetadata, 'name' | 'logoUri'> | undefined
	textColor?: string,
}

export function getAddressName(address: bigint, metadata: Pick<AddressMetadata, 'name' | 'logoUri'> | undefined) {
	if ( metadata === undefined ) return ethers.utils.getAddress(addressString(address))
	return metadata.name
}

export function SmallAddress(params: SmallAddressParams) {
	const name = getAddressName(params.address, params.nameAndLogo)
	const textColor = params.textColor === undefined ? 'var(--text-color)' : params.textColor

	return	<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.address)) } copyMessage = 'Address copied!'>
		<div style = 'display: inline-flex; background-color: var(--alpha-005); padding: 4px; margin: 2px; padding-right: 10px; border-radius: 10px 40px 40px 10px; overflow: inherit;'>
			<span class = 'vertical-center noselect nopointer' style = 'margin-right: 5px'>
				<AddressIcon
					address = { params.address }
					logoUri = { params.nameAndLogo?.logoUri }
					isBig = { false }
					backgroundColor = { textColor }
				/>
			</span>
			<span class = 'noselect nopointer' style = { `color: ${ textColor }; overflow: hidden; text-overflow: ellipsis;` } >
				{ name }
			</span>
		</div>
	</CopyToClipboard>
}

export type FromAddressToAddressParams = {
	from: bigint
	to: bigint
	fromAddressNameAndLogo: Pick<AddressMetadata, 'name' | 'logoUri'> | undefined
	toAddressNameAndLogo: Pick<AddressMetadata, 'name' | 'logoUri'> | undefined
	isApproval: boolean
}

export function FromAddressToAddress(params: FromAddressToAddressParams ) {
	return  <div class = 'columns is-mobile' style = 'margin-bottom: 0px; color: var(--text-color);'>
		<div class = 'column' style = 'width: 47.5%; flex: none; padding-bottom: 0px;'>
			<BigAddress
				address = { params.from }
				nameAndLogo = { params.fromAddressNameAndLogo }
			/>
		</div>
		<div class = 'column' style = 'width: 5%; padding: 0px; align-self: center; flex: none;'>
			{ params.isApproval ? <ApproveIcon color = { 'var(--text-color)' }/> : <ArrowIcon color = { 'var(--text-color)' }/> }
		</div>
		<div class = 'column' style = 'width: 47.5%; flex: none; padding-bottom: 0px;'>
			<BigAddress
				address = { params.to }
				nameAndLogo = { params.toAddressNameAndLogo }
			/>
		</div>
	</div>
}
