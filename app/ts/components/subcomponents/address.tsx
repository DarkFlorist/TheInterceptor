import { checksummedAddress } from '../../utils/bigint.js'
import { Blockie } from './PreactBlocky.js'
import { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { CopyToClipboard } from './CopyToClipboard.js'
import { ApproveIcon, ArrowIcon } from '../subcomponents/icons.js'
import { JSX } from 'preact/jsx-runtime'
import { useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { AddressBookEntry, ActiveAddressEntry } from '../../types/addressBookTypes.js'
import { Website } from '../../types/websiteAccessTypes.js'

export function getActiveAddressEntry(addressToFind: bigint, activeAddresses: readonly ActiveAddressEntry[]) {
	for (const info of activeAddresses) {
		if (info.address === addressToFind) return info
	}
	return {
		name: checksummedAddress(addressToFind),
		address: addressToFind,
		askForAddressAccess: true,
	}
}

export type AddressIconParams = {
	address: bigint | undefined,
	logoUri: string | undefined,
	isBig: boolean
	backgroundColor: string,
}

export function AddressIcon(param: AddressIconParams) {
	const style = `background-color: var(--unimportant-text-color); ${ param.isBig ? `width: 40px; height: 40px;` : `width: 24px; height: 24px;` }`
	const addr = param.address
	if (addr !== undefined && param.logoUri === undefined) {
		const address = useSignal<bigint>(addr)
		useEffect(() => { address.value = addr }, [param.address])
		return <div style = { style } class = 'noselect nopointer'>
			<Blockie address = { address } scale = { useSignal(param.isBig ? 5 : 3) } />
		</div>
	}
	if (param.logoUri !== undefined) {
		return <div style = { style } class = 'noselect nopointer'>
			<img src = { param.logoUri } style = 'width: 100%; max-height: 100%'/>
		</div>
	}
	return <div style = { style } class = 'noselect nopointer'></div>
}


export type BigAddressParams = {
	readonly addressBookEntry: AddressBookEntry | undefined
	readonly noCopying?: boolean
	readonly noEditAddress?: boolean
	readonly renameAddressCallBack: RenameAddressCallBack
}

export function BigAddress(params: BigAddressParams) {
	const addrString = params.addressBookEntry && checksummedAddress(params.addressBookEntry.address)
	const title = params.addressBookEntry === undefined ? 'No address found' : params.addressBookEntry.name
	const subTitle = title !== addrString ? addrString : ''

	return <div class = 'media'>
		<div class = 'media-left'>
			{ !params.noCopying && addrString !== undefined ?
				<CopyToClipboard content = { addrString } copyMessage = 'Address copied!'>
					<span class = 'noselect nopointer'>
						<AddressIcon
							address = { params.addressBookEntry?.address }
							logoUri = { params.addressBookEntry !== undefined && 'logoUri' in params.addressBookEntry ? params.addressBookEntry.logoUri : undefined}
							isBig = { true }
							backgroundColor = { 'var(--text-color)' }
						/>
					</span>
				</CopyToClipboard>
			:
				<span class = 'noselect nopointer'>
					<AddressIcon
						address = { params.addressBookEntry?.address }
						logoUri = { params.addressBookEntry !== undefined && 'logoUri' in params.addressBookEntry ? params.addressBookEntry.logoUri : undefined }
						isBig = { true }
						backgroundColor = { 'var(--text-color)' }
					/>
				</span>
			}
		</div>

		<div class = { `media-content ${ params.noEditAddress ? 'noselect nopointer' : '' }` } style = 'overflow-y: hidden; overflow-x: clip; display: block;'>
			<span className = 'big-address-container' data-value = { title }>
				<span class = 'address-text-holder'>
					{ !params.noCopying && addrString !== undefined ?
						<CopyToClipboard content = { addrString } copyMessage = 'Address copied!' style = { { 'text-overflow': 'ellipsis', overflow: 'hidden' } }>
							<p class = 'title is-5 is-spaced address-text noselect nopointer'>{ title }</p>
						</CopyToClipboard>
					: <p class = 'title is-5 is-spaced address-text noselect nopointer'>{ title }</p> }
					<button
						className = 'button is-primary is-small rename-address-button'
						onClick = { () => params.addressBookEntry && params.renameAddressCallBack(params.addressBookEntry) }
						disabled = { params.addressBookEntry === undefined }
					>
						<span class = 'icon'>
							<img src = '../img/rename.svg'/>
						</span>
					</button>
				</span>
			</span>
			{ !params.noCopying && addrString !== undefined ?
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
	readonly activeAddress: AddressBookEntry | undefined
	readonly disableButton: boolean
	readonly changeActiveAddress: () => void
	readonly renameAddressCallBack: RenameAddressCallBack
	readonly buttonText: string
}

export function ActiveAddressComponent(params: ActiveAddressParams) {
	return <div class = 'log-table' style = 'grid-template-columns: auto max-content'>
		<div class = 'log-cell' style = 'display: block;'>
			<BigAddress
				addressBookEntry = { params.activeAddress }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
		<div class = 'log-cell'>
			<div class = 'media-right'>
				<button className = 'button is-primary' disabled = { params.disableButton } onClick = { params.changeActiveAddress } >
					{ params.buttonText }
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
						<CopyToClipboard content = { checksummedAddress(params.addressBookEntry.address) } copyMessage = 'Address copied!'>
							<AddressIcon
								address = { params.addressBookEntry.address }
								logoUri = { 'logoUri' in params.addressBookEntry ? params.addressBookEntry.logoUri : undefined }
								isBig = { false }
								backgroundColor = { textColor }
							/>
						</CopyToClipboard>
					</span>
					<CopyToClipboard content = { checksummedAddress(params.addressBookEntry.address) } copyMessage = 'Address copied!' style = { { 'text-overflow': 'ellipsis', overflow: 'hidden' } }>
						<p class = 'address-text noselect nopointer' style = { `color: ${ textColor }` }>{ params.addressBookEntry.name }</p>
					</CopyToClipboard>
					<button className = 'button is-primary is-small rename-address-button' onClick = { () => params.renameAddressCallBack(params.addressBookEntry) }>
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

export function WebsiteOriginText( { icon, websiteOrigin, title }: Website) {
	return <div class = 'card-header-icon unsetcursor' style = 'width: 100%; padding: 0'>
		<span style = 'width: 24px; height: 24px; min-width: 24px'>
			{ icon === undefined ? <></> : <img src = { icon } style = 'width: 24px; height: 24px;'/> }
		</span>

		<div class = 'media-content' style = 'overflow-y: hidden; overflow-x: clip; display: block; padding-left: 10px;'>
			<p class = 'title is-5 is-spaced address-text' style = 'overflow: hidden;'>{ websiteOrigin }</p>
			<p class = 'subtitle is-7' style = 'text-overflow: ellipsis; white-space: nowrap; overflow: hidden;'> { title } </p>
		</div>
	</div>
}
