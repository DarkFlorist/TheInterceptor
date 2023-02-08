import { ethers } from 'ethers'
import { addressString } from '../../utils/bigint.js'
import Blockie from './PreactBlocky.js'
import { AddressBookEntry, AddressInfo, RenameAddressCallBack } from '../../utils/user-interface-types.js'
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

export function AddressIcon(param: AddressIconParams) {
	const style = `${ param.isBig ? `width: 40px; height: 40px; border-radius: 10px;` : `width: 24px; height: 24px; border-radius: 2px;` }`
	return <div style = { style }>
		{ param.logoUri === undefined ? <>
			<Blockie
				seed = { addressString(param.address).toLowerCase() }
				size = { 8 }
				scale = { param.isBig ? 5 : 3 }
			/>
			</> : <img src = { param.logoUri } style = 'width: 100%; max-height: 100%'/>
		}
	</div>
}


export type BigAddressParams = {
	readonly addressBookEntry: AddressBookEntry
	readonly noCopying?: boolean
	readonly renameAddressCallBack: RenameAddressCallBack
}

export function BigAddress(params: BigAddressParams) {
	const addrString = ethers.utils.getAddress(addressString(params.addressBookEntry.address))
	const title = params.addressBookEntry.name
	const subTitle = title != addrString ? addrString : ''

	return <div class = 'media'>
		<div class = 'media-left'>
			{ !params.noCopying ?
				<CopyToClipboard content = { addrString } copyMessage = 'Address copied!'>
					<span class = 'noselect nopointer'>
						<AddressIcon
							address = { params.addressBookEntry.address }
							logoUri = { 'logoUri' in params.addressBookEntry ? params.addressBookEntry.logoUri : undefined}
							isBig = { true }
							backgroundColor = { 'var(--text-color)' }
						/>
					</span>
				</CopyToClipboard>
			:
				<span class = 'noselect nopointer'>
					<AddressIcon
						address = { params.addressBookEntry.address }
						logoUri = { 'logoUri' in params.addressBookEntry ? params.addressBookEntry.logoUri : undefined }
						isBig = { true }
						backgroundColor = { 'var(--text-color)' }
					/>
				</span>
			}
		</div>

		<div class = 'media-content' style = 'overflow-y: hidden; overflow-x: clip; display: block;'>
			<div style = 'display: flex; position: relative;'>
				<RenameAddressButton renameAddress = { () => params.renameAddressCallBack(params.addressBookEntry) }>
					{ !params.noCopying ?
						<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.addressBookEntry.address)) } copyMessage = 'Address copied!'>
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
	readonly addressBookEntry: AddressBookEntry
	readonly simulationMode: boolean
	readonly changeActiveAddress: () => void
	readonly renameAddressCallBack: RenameAddressCallBack
}

export function ActiveAddress(params: ActiveAddressParams) {
	const title = params.addressBookEntry.name
	const addrString = ethers.utils.getAddress(addressString(params.addressBookEntry.address))
	const subTitle = title != addrString ? addrString : ''

	return <div class = 'media'>
		<div class = 'media-left'>
			<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.addressBookEntry.address)) } copyMessage = 'Address copied!'>
				<figure class = 'image noselect nopointer'>
					<Blockie seed = { addressString(params.addressBookEntry.address).toLowerCase() } size = { 8 } scale = { 5 } />
				</figure>
			</CopyToClipboard>
		</div>

		<div class = 'media-content' style = 'overflow-y: hidden;'>
			<div style = 'display: flex; position: relative;'>
				<RenameAddressButton renameAddress = { () => params.renameAddressCallBack(params.addressBookEntry) }>
					<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.addressBookEntry.address)) } copyMessage = 'Address copied!'>
						<p class = 'title is-5 noselect nopointer' style = 'text-overflow: ellipsis; white-space: nowrap;'>
							{ title }
						</p>
					</CopyToClipboard>
				</RenameAddressButton>
			</div>
			<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.addressBookEntry.address)) } copyMessage = 'Address copied!'>
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
	readonly addressBookEntry: AddressBookEntry
	readonly textColor?: string
	readonly renameAddressCallBack: RenameAddressCallBack
}

export function SmallAddress(params: SmallAddressParams) {
	const textColor = params.textColor === undefined ? 'var(--text-color)' : params.textColor

	return	<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.addressBookEntry.address)) } copyMessage = 'Address copied!'>
		<div style = 'display: inline-flex; width: 100%; position: relative; background-color: var(--alpha-005); padding: 4px; margin: 2px; padding-right: 10px; border-radius: 10px 40px 40px 10px; overflow: inherit;'>
			<span class = 'vertical-center noselect nopointer' style = 'margin-right: 5px'>
				<AddressIcon
					address = { params.addressBookEntry.address }
					logoUri = { 'logoUri' in params.addressBookEntry ? params.addressBookEntry.logoUri : undefined }
					isBig = { false }
					backgroundColor = { textColor }
				/>
			</span>
			<RenameAddressButton renameAddress = { () => params.renameAddressCallBack(params.addressBookEntry) }>
				<span class = 'noselect nopointer' style = { `color: ${ textColor }; overflow: hidden; text-overflow: ellipsis;` } >
					{ params.addressBookEntry.name }
				</span>
			</RenameAddressButton>
		</div>
	</CopyToClipboard>
}

export type FromAddressToAddressParams = {
	readonly fromEntry: AddressBookEntry
	readonly toEntry: AddressBookEntry
	readonly isApproval: boolean
	readonly renameAddressCallBack: RenameAddressCallBack
}

export function FromAddressToAddress(params: FromAddressToAddressParams ) {
	return  <div class = 'columns is-mobile' style = 'margin-bottom: 0px; color: var(--text-color);'>
		<div class = 'column' style = 'width: 47.5%; flex: none; padding-bottom: 0px;'>
			<BigAddress
				addressBookEntry = { params.fromEntry }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
		<div class = 'column' style = 'width: 5%; padding: 0px; align-self: center; flex: none;'>
			{ params.isApproval ? <ApproveIcon color = { 'var(--text-color)' }/> : <ArrowIcon color = { 'var(--text-color)' }/> }
		</div>
		<div class = 'column' style = 'width: 47.5%; flex: none; padding-bottom: 0px;'>
			<BigAddress
				addressBookEntry = { params.toEntry }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
	</div>
}
