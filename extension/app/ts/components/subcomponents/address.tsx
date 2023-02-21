import { ethers } from 'ethers'
import { addressString } from '../../utils/bigint.js'
import Blockie from './PreactBlocky.js'
import { AddressBookEntry, AddressInfo, RenameAddressCallBack, WebsiteOriginAndIcon } from '../../utils/user-interface-types.js'
import { CopyToClipboard } from './CopyToClipboard.js'
import { ApproveIcon, ArrowIcon } from '../subcomponents/icons.js'
import { JSX } from 'preact/jsx-runtime'

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
	return <div style = { style } class = 'noselect nopointer'>
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
			<span className = 'big-address-container' data-value = { params.addressBookEntry.name }>
				<span class = 'address-text-holder'>
					<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.addressBookEntry.address)) } copyMessage = 'Address copied!' style = { { 'text-overflow': 'ellipsis', overflow: 'hidden' } }>
						<p class = 'title is-5 is-spaced address-text noselect nopointer'>{ title }</p>
					</CopyToClipboard>
					<button className = 'button is-primary is-small rename-address-button' onClick ={ () => params.renameAddressCallBack(params.addressBookEntry) }>
						<span class = 'icon'>
							<img src = '../img/rename.svg'/>
						</span>
					</button>
				</span>
			</span>
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
	return <div class = 'log-table' style = 'grid-template-columns: auto max-content'>
		<div class = 'log-cell' style = 'display: block;'>
			<BigAddress
				addressBookEntry = { params.addressBookEntry }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
		<div class = 'log-cell'>
			<div class = 'media-right'>
				<button className = 'button is-primary' disabled = { !params.simulationMode }  onClick = { params.changeActiveAddress } >
					Change
				</button>
			</div>
		</div>
	</div>
}

export type SmallAddressParams = {
	readonly addressBookEntry: AddressBookEntry
	readonly textColor?: string
	readonly renameAddressCallBack: RenameAddressCallBack
	readonly style?: JSX.CSSProperties
}

export function SmallAddress(params: SmallAddressParams) {
	const textColor = params.textColor === undefined ? 'var(--text-color)' : params.textColor
	return (
		<span className = 'small-address-container' data-value = { params.addressBookEntry.name }>
			<span class = 'address-text-holder'>
				<span class = 'small-address-baggage-tag vertical-center' style = { params.style }>
					<span style = 'margin-right: 5px'>
						<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.addressBookEntry.address)) } copyMessage = 'Address copied!'>
							<AddressIcon
								address = { params.addressBookEntry.address }
								logoUri = { 'logoUri' in params.addressBookEntry ? params.addressBookEntry.logoUri : undefined }
								isBig = { false }
								backgroundColor = { textColor }
							/>
						</CopyToClipboard>
					</span>
					<CopyToClipboard content = { ethers.utils.getAddress(addressString(params.addressBookEntry.address)) } copyMessage = 'Address copied!' style = { { 'text-overflow': 'ellipsis', overflow: 'hidden' } }>
						<p class = 'paragraph address-text noselect nopointer'>{ params.addressBookEntry.name }</p>
					</CopyToClipboard>
					<button className = 'button is-primary is-small rename-address-button' onClick ={ () => params.renameAddressCallBack(params.addressBookEntry) }>
						<span class = 'icon'>
							<img src = '../img/rename.svg'/>
						</span>
					</button>
				</span>
			</span>
		</span>
	)
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

export function FromSmallAddressToSmallAddress({ from, to, renameAddressCallBack }: { from: AddressBookEntry, to: AddressBookEntry, renameAddressCallBack: RenameAddressCallBack }) {
	const textColor = 'var(--text-color)'
	return <span class = 'log-table' style = 'justify-content: center; column-gap: 5px;'>
		<div class = 'log-cell-flexless' style = 'margin: 2px;'>
			<SmallAddress
				addressBookEntry = { from }
				textColor = { textColor }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em; padding-left: 0.2em'>
			<ArrowIcon color = { textColor } />
		</div>
		<div class = 'log-cell-flexless' style = 'margin: 2px;'>
			<SmallAddress
				addressBookEntry = { to }
				textColor = { textColor }
				renameAddressCallBack = { renameAddressCallBack }
			/>
		</div>
	</span>
}

export function Website( { websiteIcon, websiteOrigin, textColor }: WebsiteOriginAndIcon & { textColor?: string }) {
	return <a style = 'margin: 2px; border-radius: 40px 40px 40px 40px; display: flex; padding: 4px 10px 4px 10px; overflow: hidden;'>
		<span style = 'margin-right: 5px; width: 24px; height: 24px; min-width: 24px'>
			<img src = { websiteIcon } alt = 'Logo' style = 'width: 24px; height: 24px;'/>
		</span>
		<p class = 'address-text' style = {`color: ${ textColor === undefined ? 'var(--text-color)' : textColor }; padding-left: 5px;` }>{ websiteOrigin }</p>
	</a>
}
