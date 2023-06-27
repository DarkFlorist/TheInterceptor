import { RenameAddressCallBack } from '../../../utils/user-interface-types.js'
import { OpenSeaOrderMessageWithAddressBookEntries, SeaPortSingleConsiderationWithAddressBookEntries, SeaPortSingleOfferWithAddressBookEntries } from '../../../utils/personal-message-definitions.js'
import { Token721AmountField, TokenOrEthSymbol, TokenOrEthValue } from '../../subcomponents/coins.js'
import { SmallAddress } from '../../subcomponents/address.js'
import { bytes32String } from '../../../utils/bigint.js'
import { ArrowIcon } from '../../subcomponents/icons.js'
import { CellElement, humanReadableDate } from '../../ui-utils.js'
import { SelectedNetwork } from '../../../utils/visualizer-types.js'

const tokenStyle = { 'font-size': '28px', 'font-weight': '500', 'color:': 'var(--text-color)' }

type VisualizeOpenSeaAssetParams = {
	orderOrConsideration: SeaPortSingleOfferWithAddressBookEntries | SeaPortSingleConsiderationWithAddressBookEntries
	renameAddressCallBack: RenameAddressCallBack
	selectedNetwork: SelectedNetwork
}

function ValueField({ orderOrConsideration }: { orderOrConsideration: SeaPortSingleOfferWithAddressBookEntries | SeaPortSingleConsiderationWithAddressBookEntries }) {
	if (orderOrConsideration.itemType === 'ERC721' || orderOrConsideration.itemType === 'ERC1155') {
		return <Token721AmountField { ...orderOrConsideration.token } tokenId = { orderOrConsideration.identifierOrCriteria } type = { 'NFT' } style = { tokenStyle }/>
	}
	if (orderOrConsideration.itemType === 'ERC721_WITH_CRITERIA' || orderOrConsideration.itemType === 'ERC1155_WITH_CRITERIA') {
		return <p class = 'paragraph' style = { tokenStyle }> 'Criteria: { bytes32String(orderOrConsideration.identifierOrCriteria) } </p>
	}
	if (orderOrConsideration.startAmount === orderOrConsideration.endAmount) {
		return <TokenOrEthValue { ...orderOrConsideration.token } amount = { orderOrConsideration.startAmount } style = { tokenStyle }/>
	}
	return <> 
		<TokenOrEthValue { ...orderOrConsideration.token } amount = { orderOrConsideration.startAmount } style = { tokenStyle }/>
		<p class = 'paragraph' style = { tokenStyle }> -&nbsp;</p>
		<TokenOrEthValue  { ...orderOrConsideration } amount = { orderOrConsideration.endAmount } style = { tokenStyle }/>
	</>
}

function SwapGrid(param: VisualizeOpenSeaAssetParams) {
	return <>
		<span class = 'grid swap-grid'>
			<div class = 'log-cell' style = 'justify-content: left;'>
			<ValueField orderOrConsideration = { param.orderOrConsideration } />
			</div>
			<div class = 'log-cell' style = 'justify-content: right;'>
				{ param.orderOrConsideration.itemType === 'ERC721' || param.orderOrConsideration.itemType === 'ERC1155' ?
					<TokenOrEthSymbol { ...param.orderOrConsideration.token } selectedNetwork = { param.selectedNetwork } id = { param.orderOrConsideration.identifierOrCriteria } style = { tokenStyle }/>
				: <TokenOrEthSymbol { ...param.orderOrConsideration.token } selectedNetwork = { param.selectedNetwork } style = { tokenStyle }/> }
			</div>
		</span>
	</>
}

type VisualizeOpenSeaConsiderationAssetParams = {
	consideration: SeaPortSingleConsiderationWithAddressBookEntries
	renameAddressCallBack: RenameAddressCallBack
	selectedNetwork: SelectedNetwork
}

export function VisualizeOpenSeaAsset(param: VisualizeOpenSeaConsiderationAssetParams) {
	const textColor = 'var(--text-color)'
	return <>
		<div class = 'log-cell' style = 'justify-content: right;'>
			<ValueField orderOrConsideration = { param.consideration } />
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em'>
			{ param.consideration.itemType === 'ERC721' || param.consideration.itemType === 'ERC1155' ?
				<TokenOrEthSymbol { ...param.consideration.token } selectedNetwork = { param.selectedNetwork } id = { param.consideration.identifierOrCriteria } style = { tokenStyle }/>
			: <TokenOrEthSymbol { ...param.consideration.token } selectedNetwork = { param.selectedNetwork } style = { tokenStyle }/> }
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em; padding-left: 0.2em'>
			{ <ArrowIcon color = { textColor } /> }
		</div>
		<div class = 'log-cell-flexless' style = 'margin: 2px;'>
			<SmallAddress addressBookEntry = { param.consideration.recipient } renameAddressCallBack = { param.renameAddressCallBack } />
		</div>
	</>
}

type OrderComponentsParams = {
	openSeaOrderMessage: OpenSeaOrderMessageWithAddressBookEntries
	renameAddressCallBack: RenameAddressCallBack
	selectedNetwork: SelectedNetwork
}

export function OrderComponents(param: OrderComponentsParams) {
	return <div class = 'notification transaction-importance-box'>
		<div style = 'display: grid; grid-template-rows: max-content max-content max-content max-content;'>
			<p class = 'paragraph'> Offer </p>
			<div class = 'box swap-box'>
				{ param.openSeaOrderMessage.offer.map((offer) => <SwapGrid orderOrConsideration = { offer } renameAddressCallBack = { param.renameAddressCallBack } selectedNetwork = { param.selectedNetwork }/> ) }
			</div>
			<p class = 'paragraph'> For </p>
			<div class = 'box swap-box'>
				<span class = 'log-table-4' style = 'justify-content: center; column-gap: 5px;'>
					{ param.openSeaOrderMessage.consideration.map((consideration) => <VisualizeOpenSeaAsset consideration = { consideration } renameAddressCallBack = { param.renameAddressCallBack } selectedNetwork = { param.selectedNetwork } /> ) }
				</span>
			</div>
		</div>
	</div>
}

export function OrderComponentsExtraDetails({ orderComponents, renameAddressCallBack }: { orderComponents: OpenSeaOrderMessageWithAddressBookEntries, renameAddressCallBack: RenameAddressCallBack }) {
	return <>
		<CellElement text = 'Conduit key: '/>
		<CellElement text = { bytes32String(orderComponents.conduitKey) }/>
		<CellElement text = 'Counter: '/>
		<CellElement text = { orderComponents.counter }/>
		<CellElement text = 'Start time: '/>
		<CellElement text = { humanReadableDate(orderComponents.startTime) }/>
		<CellElement text = 'End time: '/>
		<CellElement text = { humanReadableDate(orderComponents.endTime) }/>
		<CellElement text = 'Offerer: '/>
		<CellElement text = { <SmallAddress addressBookEntry = { orderComponents.offerer } renameAddressCallBack = { renameAddressCallBack } /> } />
		<CellElement text = 'Order type: '/>
		<CellElement text = { orderComponents.orderType }/>
		<CellElement text = 'Salt: '/>
		<CellElement text = { orderComponents.salt }/>
		<CellElement text = 'Total original consideration items: '/>
		<CellElement text = { orderComponents.totalOriginalConsiderationItems }/>
		<CellElement text = 'Zone: '/>
		<CellElement text = { <SmallAddress addressBookEntry = { orderComponents.zone } renameAddressCallBack = { renameAddressCallBack } /> } />
		<CellElement text = 'Zone hash: '/>
		<CellElement text = { bytes32String(orderComponents.zoneHash) }/>
	</>
}