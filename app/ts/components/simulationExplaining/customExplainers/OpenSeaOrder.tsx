import type { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import type { OpenSeaOrderMessageWithAddressBookEntries, SeaPortSingleConsiderationWithAddressBookEntries, SeaPortSingleOfferWithAddressBookEntries } from '../../../types/personal-message-definitions.js'
import { EtherAmount, EtherSymbol, TokenAmount, TokenSymbol } from '../../subcomponents/coins.js'
import { SmallAddress } from '../../subcomponents/address.js'
import { bytes32String } from '../../../utils/bigint.js'
import { ArrowIcon } from '../../subcomponents/icons.js'
import { CellElement, humanReadableDateFromSeconds } from '../../ui-utils.js'
import type { RpcNetwork } from '../../../types/rpc.js'

const tokenStyle = { 'font-weight': '500', 'color:': 'var(--text-color)' }

type SeaportItem = SeaPortSingleOfferWithAddressBookEntries | SeaPortSingleConsiderationWithAddressBookEntries

type VisualizeOpenSeaAssetParams = {
	orderOrConsideration: SeaportItem
	renameAddressCallBack: RenameAddressCallBack
	rpcNetwork: RpcNetwork
}

function SeaportItemAmount({ item, amount }: { item: SeaportItem, amount: bigint }) {
	if (item.itemType === 'NATIVE') return <EtherAmount amount = { amount } style = { tokenStyle } fontSize = 'big'/>
	if (item.itemType === 'ERC20' && item.token.type === 'ERC20') return <TokenAmount tokenEntry = { item.token } amount = { amount } style = { tokenStyle } fontSize = 'big'/>
	// ERC1155 amounts have no decimals, and a token the address book does not identify has no known decimals either.
	return <p class = 'paragraph' style = { tokenStyle }>{ amount.toString() }&nbsp;</p>
}

function ValueField({ orderOrConsideration }: { orderOrConsideration: SeaportItem }) {
	if (orderOrConsideration.itemType === 'ERC721') {
		return null
	}
	if (orderOrConsideration.itemType === 'ERC721_WITH_CRITERIA' || orderOrConsideration.itemType === 'ERC1155_WITH_CRITERIA') {
		return <p class = 'paragraph' style = { tokenStyle }>Criteria: { bytes32String(orderOrConsideration.identifierOrCriteria) }</p>
	}
	if (orderOrConsideration.startAmount === orderOrConsideration.endAmount) {
		return <SeaportItemAmount item = { orderOrConsideration } amount = { orderOrConsideration.startAmount }/>
	}
	return <>
		<SeaportItemAmount item = { orderOrConsideration } amount = { orderOrConsideration.startAmount }/>
		<p class = 'paragraph' style = { tokenStyle }> -&nbsp;</p>
		<SeaportItemAmount item = { orderOrConsideration } amount = { orderOrConsideration.endAmount }/>
	</>
}

// The token card follows the Seaport item type; a token the address book identifies as a different kind of token, or not as a token at all, is shown as a plain address.
function SeaportItemSymbol({ orderOrConsideration: item, renameAddressCallBack, rpcNetwork }: VisualizeOpenSeaAssetParams) {
	if (item.itemType === 'NATIVE') return <EtherSymbol rpcNetwork = { rpcNetwork } style = { tokenStyle } fontSize = 'big'/>
	if (item.itemType === 'ERC20' && item.token.type === 'ERC20') return <TokenSymbol tokenEntry = { item.token } renameAddressCallBack = { renameAddressCallBack } style = { tokenStyle } fontSize = 'big'/>
	const isErc721Item = item.itemType === 'ERC721' || item.itemType === 'ERC721_WITH_CRITERIA'
	const isErc1155Item = item.itemType === 'ERC1155' || item.itemType === 'ERC1155_WITH_CRITERIA'
	// Criteria items match many token identifiers, so only exact items name one.
	const tokenId = item.itemType === 'ERC721' || item.itemType === 'ERC1155' ? item.identifierOrCriteria : undefined
	if ((isErc721Item && item.token.type === 'ERC721') || (isErc1155Item && item.token.type === 'ERC1155')) return <TokenSymbol tokenEntry = { item.token } tokenId = { tokenId } renameAddressCallBack = { renameAddressCallBack } style = { tokenStyle } fontSize = 'big'/>
	return <SmallAddress addressBookEntry = { item.token } renameAddressCallBack = { renameAddressCallBack }/>
}

function SwapGrid(param: VisualizeOpenSeaAssetParams) {
	return <>
		<span class = 'grid swap-grid'>
			<div class = 'log-cell' style = 'justify-content: left;'>
				<ValueField orderOrConsideration = { param.orderOrConsideration } />
			</div>
			<div class = 'log-cell' style = 'justify-content: right;'>
				<SeaportItemSymbol { ...param }/>
			</div>
		</span>
	</>
}

type VisualizeOpenSeaConsiderationAssetParams = {
	consideration: SeaPortSingleConsiderationWithAddressBookEntries
	renameAddressCallBack: RenameAddressCallBack
	rpcNetwork: RpcNetwork
}

function VisualizeOpenSeaAsset(param: VisualizeOpenSeaConsiderationAssetParams) {
	return <>
		<div class = 'log-cell' style = 'justify-content: right;'>
			<ValueField orderOrConsideration = { param.consideration } />
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em'>
			<SeaportItemSymbol orderOrConsideration = { param.consideration } renameAddressCallBack = { param.renameAddressCallBack } rpcNetwork = { param.rpcNetwork }/>
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em; padding-left: 0.2em'>
			{ <ArrowIcon color = 'var(--text-color)' /> }
		</div>
		<div class = 'log-cell-flexless' style = 'margin: 2px;'>
			<SmallAddress addressBookEntry = { param.consideration.recipient } renameAddressCallBack = { param.renameAddressCallBack } />
		</div>
	</>
}

type OrderComponentsParams = {
	openSeaOrderMessage: OpenSeaOrderMessageWithAddressBookEntries
	renameAddressCallBack: RenameAddressCallBack
	rpcNetwork: RpcNetwork
}

export function OrderComponents(param: OrderComponentsParams) {
	return <div class = 'notification transaction-importance-box'>
		<div style = 'display: grid; grid-template-rows: max-content max-content max-content max-content;'>
			<p class = 'paragraph'> Offer </p>
			<div class = 'box swap-box'>
				{ param.openSeaOrderMessage.offer.map((offer, index) => <SwapGrid key = { index } orderOrConsideration = { offer } renameAddressCallBack = { param.renameAddressCallBack } rpcNetwork = { param.rpcNetwork }/> ) }
			</div>
			<p class = 'paragraph'> For </p>
			<div class = 'box swap-box'>
				<span class = 'log-table-4' style = 'justify-content: center; column-gap: 5px;'>
					{ param.openSeaOrderMessage.consideration.map((consideration, index) => <VisualizeOpenSeaAsset key = { index } consideration = { consideration } renameAddressCallBack = { param.renameAddressCallBack } rpcNetwork = { param.rpcNetwork } /> ) }
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
		<CellElement text = { humanReadableDateFromSeconds(orderComponents.startTime) }/>
		<CellElement text = 'End time: '/>
		<CellElement text = { humanReadableDateFromSeconds(orderComponents.endTime) }/>
		<CellElement text = 'Offerer: '/>
		<CellElement text = { <SmallAddress addressBookEntry = { orderComponents.offerer } renameAddressCallBack = { renameAddressCallBack } /> } />
		<CellElement text = 'Order type: '/>
		<CellElement text = { orderComponents.orderType }/>
		<CellElement text = 'Salt: '/>
		<CellElement text = { orderComponents.salt }/>
		<CellElement text = 'Zone: '/>
		<CellElement text = { <SmallAddress addressBookEntry = { orderComponents.zone } renameAddressCallBack = { renameAddressCallBack } /> } />
		<CellElement text = 'Zone hash: '/>
		<CellElement text = { bytes32String(orderComponents.zoneHash) }/>
	</>
}
