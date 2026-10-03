import type { RenameAddressCallBack } from '../../../types/user-interface-types.js'
import type { OpenSeaOrderMessageWithAddressBookEntries, SeaPortSingleConsiderationWithAddressBookEntries, SeaPortSingleOfferWithAddressBookEntries } from '../../../types/personal-message-definitions.js'
import { TokenOrEthSymbol, TokenOrEthValue } from '../../subcomponents/coins.js'
import { SmallAddress } from '../../subcomponents/address.js'
import { bytes32String } from '../../../utils/bigint.js'
import { ArrowIcon } from '../../subcomponents/icons.js'
import { CellElement, humanReadableDateFromSeconds } from '../../ui-utils.js'
import type { RpcNetwork } from '../../../types/rpc.js'

const tokenStyle = { 'font-weight': '500', 'color:': 'var(--text-color)' }

type VisualizeOpenSeaAssetParams = {
	orderOrConsideration: SeaPortSingleOfferWithAddressBookEntries | SeaPortSingleConsiderationWithAddressBookEntries
	renameAddressCallBack: RenameAddressCallBack
	rpcNetwork: RpcNetwork
}

function ValueField({ orderOrConsideration }: { orderOrConsideration: SeaPortSingleOfferWithAddressBookEntries | SeaPortSingleConsiderationWithAddressBookEntries }) {
	if (orderOrConsideration.itemType === 'ERC721') {
		return null
	}
	if (orderOrConsideration.itemType === 'ERC721_WITH_CRITERIA' || orderOrConsideration.itemType === 'ERC1155_WITH_CRITERIA') {
		return <p class = 'paragraph opensea-value-text'> 'Criteria: { bytes32String(orderOrConsideration.identifierOrCriteria) } </p>
	}
	if (orderOrConsideration.startAmount === orderOrConsideration.endAmount) {
		return <TokenOrEthValue { ...orderOrConsideration.token } amount = { orderOrConsideration.startAmount } style = { tokenStyle } fontSize = 'big'/>
	}
	return <> 
		<TokenOrEthValue { ...orderOrConsideration.token } amount = { orderOrConsideration.startAmount } style = { tokenStyle } fontSize = 'big'/>
		<p class = 'paragraph opensea-value-text'> -&nbsp;</p>
		<TokenOrEthValue  { ...orderOrConsideration } amount = { orderOrConsideration.endAmount } style = { tokenStyle } fontSize = 'big'/>
	</>
}

function SwapGrid(param: VisualizeOpenSeaAssetParams) {
	return <>
		<span class = 'grid swap-grid'>
			<div class = 'log-cell opensea-offer-value'>
				<ValueField orderOrConsideration = { param.orderOrConsideration } />
			</div>
			<div class = 'log-cell log-cell--right'>
				{ param.orderOrConsideration.itemType === 'ERC721' || param.orderOrConsideration.itemType === 'ERC1155' ?
					<TokenOrEthSymbol { ...param.orderOrConsideration.token } rpcNetwork = { param.rpcNetwork } style = { tokenStyle } fontSize = 'big'/>
				: <TokenOrEthSymbol { ...param.orderOrConsideration.token } rpcNetwork = { param.rpcNetwork } style = { tokenStyle } fontSize = 'big'/> }
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
		<div class = 'log-cell log-cell--right'>
			<ValueField orderOrConsideration = { param.consideration } />
		</div>
		<div class = 'log-cell opensea-consideration-symbol'>
			{ param.consideration.itemType === 'ERC721' || param.consideration.itemType === 'ERC1155' ?
				<TokenOrEthSymbol { ...param.consideration.token } rpcNetwork = { param.rpcNetwork } style = { tokenStyle } fontSize = 'big'/>
			: <TokenOrEthSymbol { ...param.consideration.token } rpcNetwork = { param.rpcNetwork } style = { tokenStyle } fontSize = 'big'/> }
		</div>
		<div class = 'log-cell opensea-consideration-arrow'>
			{ <ArrowIcon color = 'var(--text-color)' /> }
		</div>
		<div class = 'log-cell-flexless opensea-consideration-recipient'>
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
		<div class = 'summary-legs'>
			<p class = 'summary-label'>Offer</p>
			<div class = 'box swap-box'>
				{ param.openSeaOrderMessage.offer.map((offer, index) => <SwapGrid key = { index } orderOrConsideration = { offer } renameAddressCallBack = { param.renameAddressCallBack } rpcNetwork = { param.rpcNetwork }/> ) }
			</div>
			<p class = 'summary-label'>For</p>
			<div class = 'box swap-box'>
				<span class = 'log-table-4 opensea-consideration-table'>
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
		<CellElement text = 'Total original consideration items: '/>
		<CellElement text = { orderComponents.totalOriginalConsiderationItems }/>
		<CellElement text = 'Zone: '/>
		<CellElement text = { <SmallAddress addressBookEntry = { orderComponents.zone } renameAddressCallBack = { renameAddressCallBack } /> } />
		<CellElement text = 'Zone hash: '/>
		<CellElement text = { bytes32String(orderComponents.zoneHash) }/>
	</>
}
