import { ComponentChildren } from 'preact'
import { JSX } from 'preact/jsx-runtime'
import { checksummedAddress } from '../../utils/bigint.js'
import { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { AddressBookEntries, AddressBookEntry } from '../../types/addressBookTypes.js'
import { Website } from '../../types/websiteAccessTypes.js'
import { Blockie } from './SVGBlockie.js'
import { InlineCard } from './InlineCard.js'
import { EditIcon } from './icons.js'
import { ActionableTextProps, MultilineCard, TextAction } from './MultilineCard.js'

export function getActiveAddressEntry(addressToFind: bigint, activeAddresses: AddressBookEntries): AddressBookEntry {
	for (const info of activeAddresses) {
		if (info.address === addressToFind) return info
	}
	return { name: checksummedAddress(addressToFind), address: addressToFind, askForAddressAccess: true, type: 'contact', useAsActiveAddress: true, entrySource: 'User' }
}

type AddressIconParams = {
	address: bigint | undefined,
	logoUri: string | undefined,
	isBig: boolean
	backgroundColor: string,
}

const AddressIconFrame = ({ isBig, children }: { isBig: boolean, children?: ComponentChildren }) => {
	const cssProperties: JSX.CSSProperties = { backgroundColor: 'var(--unimportant-text-color)', fontSize: isBig ? '2.5em' : '1.5em' }
	return <div style = { cssProperties } class = 'noselect nopointer'>{ children }</div>
}

export function AddressIcon(param: AddressIconParams) {
	if (param.address !== undefined && param.logoUri === undefined) {
		return (
			<AddressIconFrame isBig = { param.isBig }>
				<Blockie address = { param.address } style = { { display: 'block' } } />
			</AddressIconFrame>
		)
	}

	if (param.logoUri !== undefined) {
		return (
			<AddressIconFrame isBig = { param.isBig }>
				<img src = { param.logoUri } style = { { display: 'block', width: '1em', minWidth: '1em', height: '1em' } }/>
			</AddressIconFrame>
		)
	}

	return <AddressIconFrame isBig = { param.isBig } />
}


type BigAddressParams = {
	readonly addressBookEntry: AddressBookEntry | undefined
	readonly noCopying?: boolean
	readonly noEditAddress?: boolean
	readonly renameAddressCallBack: RenameAddressCallBack
	readonly style?: JSX.CSSProperties
}

export function BigAddress(params: BigAddressParams) {
	const addrString = params.addressBookEntry && checksummedAddress(params.addressBookEntry.address)
	const title = params.addressBookEntry === undefined ? 'No address found' : params.addressBookEntry.name
	const subTitle = addrString && title !== addrString ? addrString : '(Not in addressbook)'

	const renameAddressAction: TextAction = {
		label: 'Edit',
		icon: () => <EditIcon />,
		onClick: () => params.addressBookEntry && params.renameAddressCallBack(params.addressBookEntry)
	}

	const labelConfig: ActionableTextProps = {
		displayText: title,
		action: !params.noEditAddress && title !== addrString ? renameAddressAction : undefined
	}

	const noteConfig: ActionableTextProps = {
		displayText: subTitle,
		action: addrString && subTitle !== addrString ? renameAddressAction : undefined
	}

	return (
		<MultilineCard
			label = { labelConfig }
			note = { noteConfig }
			icon = { { component: () => params.addressBookEntry ? <Blockie address = { params.addressBookEntry.address } /> : <></> } }
			style = { params.style }
		/>
	)
}

type ActiveAddressParams = {
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

type SmallAddressParams = {
	readonly addressBookEntry: AddressBookEntry
	readonly textColor?: string
	readonly renameAddressCallBack: RenameAddressCallBack
	readonly style?: JSX.CSSProperties
}

export function SmallAddress({ addressBookEntry, renameAddressCallBack, style }: SmallAddressParams) {
	const addressString = checksummedAddress(addressBookEntry.address)

	const generateIcon = () => {
		if (addressBookEntry.logoUri) return <img src = { addressBookEntry.logoUri } style = { { minWidth: '1em', minHeight: '1em' } } />
		if (addressBookEntry.address) return <Blockie address = { addressBookEntry.address } />
		return <></>
	}

	return <InlineCard label={ addressBookEntry.name } copyValue = { addressString } icon={ generateIcon } onEditClicked={ () => renameAddressCallBack(addressBookEntry) } style = { style } />
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
