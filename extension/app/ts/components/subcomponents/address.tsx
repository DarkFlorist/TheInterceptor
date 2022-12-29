import { ethers } from 'ethers'
import { addressString } from '../../utils/bigint.js'
import { AddressMetadata } from '../../utils/visualizer-types.js'
import Blockie from './PreactBlocky.js'
import { AddressInfo, RenameAddressCallBack } from '../../utils/user-interface-types.js'
import { CopyToClipboard } from './CopyToClipboard.js'
import { ApproveIcon, ArrowIcon } from '../subcomponents/icons.js'
import RenameAddressButton from './RenameAddressButton.js'

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


export type BigAddressParams = {
	readonly address: bigint
	readonly noCopying?: boolean
	readonly nameAndLogo: Pick<AddressMetadata, 'name' | 'logoUri'> | undefined
	readonly renameAddressCallBack: RenameAddressCallBack | undefined
}

export function BigAddress(params: BigAddressParams) {
	const addrString = ethers.utils.getAddress(addressString(params.address))
	const title = params.nameAndLogo === undefined || params.nameAndLogo.name === undefined ? addrString: params.nameAndLogo.name
	const subTitle = title != addrString ? addrString : ''
	const renameAddressCallBack = params.renameAddressCallBack

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
			<div style = 'display: flex; position: relative;'>
				<RenameAddressButton renameAddress = { renameAddressCallBack === undefined ? undefined : () => renameAddressCallBack(title, addressString(params.address)) }>
					{ !params.noCopying ?
						<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.address)) } copyMessage = 'Address copied!'>
							<p class = 'title is-5 noselect nopointer is-spaced' style = 'text-overflow: ellipsis; white-space: nowrap;'>
								{ title }
							</p>
						</CopyToClipboard>
					:
						<p class = 'title is-5 noselect nopointer is-spaced' style = 'text-overflow: ellipsis; white-space: nowrap;'>
							{ title }
						</p>
					}
				</RenameAddressButton>
			</div>

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
	readonly address: bigint
	readonly title?: string
	readonly subtitle?: string
	readonly simulationMode: boolean
	readonly changeActiveAddress: () => void
	readonly renameAddressCallBack: RenameAddressCallBack
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
			<div style = 'display: flex; position: relative;'>
				<RenameAddressButton renameAddress = { () => params.renameAddressCallBack(title, addressString(params.address)) }>
					<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.address)) } copyMessage = 'Address copied!'>
						<p class = 'title is-5 noselect nopointer' style = 'text-overflow: ellipsis; white-space: nowrap;'>
							{ title }
						</p>
					</CopyToClipboard>
				</RenameAddressButton>
			</div>
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
	readonly address: bigint
	readonly nameAndLogo: Pick<AddressMetadata, 'name' | 'logoUri'> | undefined
	readonly textColor?: string
	readonly renameAddressCallBack: RenameAddressCallBack | undefined
}

export function getAddressName(address: bigint, metadata: Pick<AddressMetadata, 'name' | 'logoUri'> | undefined) {
	if ( metadata === undefined ) return ethers.utils.getAddress(addressString(address))
	return metadata.name
}

export function SmallAddress(params: SmallAddressParams) {
	const name = getAddressName(params.address, params.nameAndLogo)
	const textColor = params.textColor === undefined ? 'var(--text-color)' : params.textColor
	const renameAddressCallBack = params.renameAddressCallBack

	return	<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.address)) } copyMessage = 'Address copied!'>
		<div style = 'display: inline-flex; width: 100%; position: relative; background-color: var(--alpha-005); padding: 4px; margin: 2px; padding-right: 10px; border-radius: 10px 40px 40px 10px; overflow: inherit;'>
			<span class = 'vertical-center noselect nopointer' style = 'margin-right: 5px'>
				<AddressIcon
					address = { params.address }
					logoUri = { params.nameAndLogo?.logoUri }
					isBig = { false }
					backgroundColor = { textColor }
				/>
			</span>

			<RenameAddressButton renameAddress = { renameAddressCallBack === undefined ? undefined : () => renameAddressCallBack(name, addressString(params.address)) }>
				<span class = 'noselect nopointer' style = { `color: ${ textColor }; overflow: hidden; text-overflow: ellipsis;` } >
					{ name }
				</span>
			</RenameAddressButton>
		</div>
	</CopyToClipboard>
}

export type FromAddressToAddressParams = {
	readonly from: bigint
	readonly to: bigint
	readonly fromAddressNameAndLogo: Pick<AddressMetadata, 'name' | 'logoUri'> | undefined
	readonly toAddressNameAndLogo: Pick<AddressMetadata, 'name' | 'logoUri'> | undefined
	readonly isApproval: boolean
	readonly renameAddressCallBack: RenameAddressCallBack | undefined
}

export function FromAddressToAddress(params: FromAddressToAddressParams ) {
	return  <div class = 'columns is-mobile' style = 'margin-bottom: 0px; color: var(--text-color);'>
		<div class = 'column' style = 'width: 47.5%; flex: none; padding-bottom: 0px;'>
			<BigAddress
				address = { params.from }
				nameAndLogo = { params.fromAddressNameAndLogo }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
		<div class = 'column' style = 'width: 5%; padding: 0px; align-self: center; flex: none;'>
			{ params.isApproval ? <ApproveIcon color = { 'var(--text-color)' }/> : <ArrowIcon color = { 'var(--text-color)' }/> }
		</div>
		<div class = 'column' style = 'width: 47.5%; flex: none; padding-bottom: 0px;'>
			<BigAddress
				address = { params.to }
				nameAndLogo = { params.toAddressNameAndLogo }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
	</div>
}
