import { CHAIN, RenameAddressCallBack } from '../../../utils/user-interface-types.js'
import { OpenSeaOrderMessageWithAddressBookEntries, SeaPortSingleConsiderationWithAddressBookEntries, SeaPortSingleOfferWithAddressBookEntries } from '../../../utils/personal-message-definitions.js'
import { TokenOrEthSymbol, TokenOrEthValue } from '../../subcomponents/coins.js'
import { ComponentChildren } from 'preact'

type VisualizeOpenSeaAssetParams = {
	orderOrConsideration: SeaPortSingleOfferWithAddressBookEntries | SeaPortSingleConsiderationWithAddressBookEntries
	renameAddressCallBack: RenameAddressCallBack
	chainId: CHAIN
}

export function VisualizeOpenSeaAsset(param: VisualizeOpenSeaAssetParams) {
	return <span class = 'grid swap-grid'>
		{ param.orderOrConsideration.startAmount === param.orderOrConsideration.endAmount ? 
			<TokenOrEthValue { ...param.orderOrConsideration.token } amount = { param.orderOrConsideration.startAmount } />
		:
			<><TokenOrEthValue { ...param.orderOrConsideration.token } amount = { param.orderOrConsideration.startAmount }/> - <TokenOrEthValue  { ...param.orderOrConsideration } amount = { param.orderOrConsideration.endAmount } /></>
		}
		<TokenOrEthSymbol { ...param.orderOrConsideration.token } chain = { param.chainId }/>
		{'recipient' in param.orderOrConsideration ? <p class = 'paragraph'>recipient: { param.orderOrConsideration.recipient }</p> : <></>}
		<p class = 'paragraph'>identifierOrCriteria: { param.orderOrConsideration.identifierOrCriteria }</p>
	</span>
}

type OrderComponentsParams = {
	openSeaOrderMessage: OpenSeaOrderMessageWithAddressBookEntries
	renameAddressCallBack: RenameAddressCallBack
	chainId: CHAIN
}

export function OrderComponents(param: OrderComponentsParams) {
	return <div class = 'notification transaction-importance-box'>
		<div style = 'display: grid; grid-template-rows: max-content max-content max-content max-content;'>
			<p class = 'paragraph'> Offer </p>
			<div class = 'box swap-box'>
				{ param.openSeaOrderMessage.offer.map((offer) => <VisualizeOpenSeaAsset orderOrConsideration = { offer } renameAddressCallBack = { param.renameAddressCallBack } chainId = { param.chainId }/> ) }
			</div>
			<p class = 'paragraph'> For </p>
			<div class = 'box swap-box'>
				{ param.openSeaOrderMessage.consideration.map((consideration) => <VisualizeOpenSeaAsset orderOrConsideration = { consideration } renameAddressCallBack = { param.renameAddressCallBack } chainId = { param.chainId } /> ) }
			</div>
		</div>
	</div>
}

export function OrderComponentsExtraDetails({ orderComponents }: { orderComponents: OpenSeaOrderMessageWithAddressBookEntries }) {
	const CellElement = (param: { text: ComponentChildren }) => {
		return <div class = 'log-cell' style = 'justify-content: right;'> <p class = 'paragraph' style = 'color: var(--subtitle-text-color)'> { param.text }</p></div>
	}
	return <>
		<CellElement text = 'conduitKey: '/>
		<CellElement text = { orderComponents.conduitKey }/>
		<CellElement text = 'counter: '/>
		<CellElement text = { orderComponents.counter }/>
		<CellElement text = 'endTime: '/>
		<CellElement text = { orderComponents.endTime }/>
		<CellElement text = 'offerer: '/>
		<CellElement text = { orderComponents.offerer }/>
		<CellElement text = 'orderType: '/>
		<CellElement text = { orderComponents.orderType }/>
		<CellElement text = 'salt: '/>
		<CellElement text = { orderComponents.salt }/>
		<CellElement text = 'startTime: '/>
		<CellElement text = { orderComponents.startTime }/>
		<CellElement text = 'totalOriginalConsiderationItems: '/>
		<CellElement text = { orderComponents.totalOriginalConsiderationItems }/>
		<CellElement text = 'zone: '/>
		<CellElement text = { orderComponents.zone }/>
		<CellElement text = 'zoneHash: '/>
		<CellElement text = { orderComponents.zoneHash }/>
	</>
}