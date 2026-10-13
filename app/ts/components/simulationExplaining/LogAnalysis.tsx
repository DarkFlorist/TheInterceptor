// Token and non-token event tables shown in a transaction's log analysis cards.
import { SmallAddress } from '../subcomponents/address.js'
import { TokenSymbol, TokenAmount, AllApproval, tokenEventToTokenSymbolParams } from '../subcomponents/coins.js'
import type { LogAnalysisParams, NonLogAnalysisParams, RenameAddressCallBack } from '../../types/user-interface-types.js'
import { identifyRoutes } from './SwapTransactions.js'
import { ApproveIcon, ArrowIcon } from '../subcomponents/icons.js'
import type { AddressBookEntry } from '../../types/addressBookTypes.js'
import { bytes32String, dataStringWith0xStart } from '../../utils/bigint.js'
import { EnrichedSolidityTypeComponentWithAddressBook, StringElement } from '../subcomponents/solidityType.js'
import { getAddressBookEntryOrAFiller } from '../ui-utils.js'
import { extractTokenEvents } from '../../background/metadataUtils.js'
import { type EditEnsNamedHashCallBack, EnsNamedHashComponent } from '../subcomponents/ens.js'
import { insertBetweenElements } from '../subcomponents/misc.js'
import type { EnrichedEthereumEventWithMetadata, TokenVisualizerResultWithMetadata } from '../../types/EnrichedEthereumData.js'
import type { ReadonlySignal } from '@preact/signals'

function isPositiveEvent(visResult: TokenVisualizerResultWithMetadata, ourAddressInReferenceFrame: bigint) {
	if (visResult.type === 'ERC20') {
		if (!visResult.isApproval) {
			return visResult.amount >= 0 // simple transfer
		}
		return visResult.amount === 0n // zero is only positive approve event
	}

	// nfts
	if (visResult.type === 'NFT All approval') { // all approval is only positive if someone all approves us, or all approval is removed from us
		return (visResult.allApprovalAdded && visResult.to.address === ourAddressInReferenceFrame) || (!visResult.allApprovalAdded && visResult.from.address === ourAddressInReferenceFrame)
	}

	if (visResult.isApproval) {
		return visResult.to.address === ourAddressInReferenceFrame // approval is only positive if we are getting approved
	}

	return visResult.to.address === ourAddressInReferenceFrame // send is positive if we are receiving
}

type TokenLogEventParams = {
	tokenVisualizerResult: TokenVisualizerResultWithMetadata
	ourAddressInReferenceFrame: bigint,
	renameAddressCallBack: RenameAddressCallBack,
}

function TokenLogEvent(params: TokenLogEventParams ) {
	const style = { color: isPositiveEvent(params.tokenVisualizerResult, params.ourAddressInReferenceFrame) ? 'var(--dim-text-color)' : 'var(--danger-dim-color)' }

	return <>
		<div class = 'log-cell' style = 'justify-content: right;'>
			{ params.tokenVisualizerResult.type === 'NFT All approval' ?
				<AllApproval
					{ ...params.tokenVisualizerResult }
					style = { style }
					fontSize = 'normal'
				/>
			: <> { 'amount' in params.tokenVisualizerResult && params.tokenVisualizerResult.amount >= (2n ** 96n - 1n ) && params.tokenVisualizerResult.isApproval ?
					<p class = 'ellipsis' style = { `color: ${ style.color }` }><b>ALL</b></p>
				:
					'amount' in params.tokenVisualizerResult ?
						<TokenAmount
							amount = { params.tokenVisualizerResult.amount }
							tokenEntry = { params.tokenVisualizerResult.token }
							style = { style }
							fontSize = 'normal'
						/>
					: <></>
				} </>
			}
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em'>
			<TokenSymbol
				{ ...tokenEventToTokenSymbolParams(params.tokenVisualizerResult) }
				style = { style }
				useFullTokenName = { false }
				renameAddressCallBack = { params.renameAddressCallBack }
				fontSize = 'normal'
			/>
		</div>
		<div class = 'log-cell-flexless' style = 'margin: 2px;'>
			<SmallAddress
				addressBookEntry = { params.tokenVisualizerResult.from }
				textColor = { style.color }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
		<div class = 'log-cell' style = 'padding-right: 0.2em; padding-left: 0.2em'>
			{ params.tokenVisualizerResult.isApproval ? <ApproveIcon color = { style.color } /> : <ArrowIcon color = { style.color } /> }
		</div>
		<div class = 'log-cell-flexless' style = 'margin: 2px;'>
			<SmallAddress
				addressBookEntry = { params.tokenVisualizerResult.to }
				textColor = { style.color }
				renameAddressCallBack = { params.renameAddressCallBack }
			/>
		</div>
	</>
}

export function TokenLogAnalysis(param: LogAnalysisParams) {
	const tokenEvents = extractTokenEvents(param.simulatedAndVisualizedTransaction.events)

	if (tokenEvents.length === 0) return <p class = 'paragraph'> No token events </p>
	const routes = identifyRoutes(param.simulatedAndVisualizedTransaction, param.identifiedSwap)
	return <span class = 'log-table' style = 'justify-content: center; column-gap: 5px;'> { routes ?
		routes.map((tokenVisualizerResult, index) => (
			<TokenLogEvent
				key = { index }
				tokenVisualizerResult = { tokenVisualizerResult }
				ourAddressInReferenceFrame = { param.simulatedAndVisualizedTransaction.transaction.from.address }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		))
	:
		tokenEvents.map((tokenEvent, index) => (
			<TokenLogEvent
				key = { index }
				tokenVisualizerResult = { tokenEvent }
				ourAddressInReferenceFrame = { param.simulatedAndVisualizedTransaction.transaction.from.address }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		))
	} </span>
}

type NonTokenLogEventParams = {
	nonTokenLog: EnrichedEthereumEventWithMetadata
	addressMetaData: ReadonlySignal<readonly AddressBookEntry[]>
	renameAddressCallBack: RenameAddressCallBack
	readonly editEnsNamedHashCallBack: EditEnsNamedHashCallBack
}

function NonTokenLogEvent(params: NonTokenLogEventParams) {
	const cellStyle = 'align-items: normal;'
	const textStyle = 'text-overflow: ellipsis; overflow: hidden;'
	if (params.nonTokenLog.isParsed === 'NonParsed') {
		return <>
			<div class = 'log-cell' style = { cellStyle }>
				<SmallAddress
					addressBookEntry = { getAddressBookEntryOrAFiller(params.addressMetaData.value, params.nonTokenLog.address) }
					renameAddressCallBack = { params.renameAddressCallBack }
				/>
			</div>
			<div class = 'log-cell' style = { cellStyle }>
				<p class = 'paragraph' style = { textStyle }> { dataStringWith0xStart(params.nonTokenLog.data) } </p>
			</div>
			<div class = 'log-cell' style = { 'grid-column: 2 / 4; display: flex; flex-wrap: wrap;' } >
				{ params.nonTokenLog.topics.map((topic, index) => <p key = { `${ bytes32String(topic) }-${ index }` } class = 'paragraph' style = { textStyle }> { bytes32String(topic) } </p>) }
			</div>
		</>
	}
	return <>
			<div class = 'log-cell' style = { cellStyle }>
				<SmallAddress
					addressBookEntry = { getAddressBookEntryOrAFiller(params.addressMetaData.value, params.nonTokenLog.address) }
					renameAddressCallBack = { params.renameAddressCallBack }
				/>
		</div>
		<div style = 'display: contents;'/>
		<div class = 'log-cell' style = { { 'grid-column-start': 2, 'grid-column-end': 4, display: 'flex', 'flex-wrap': 'wrap' } }>
			<p class = 'paragraph' style = { textStyle }> { `${ params.nonTokenLog.name }(` } </p>
			{ insertBetweenElements(params.nonTokenLog.args.map((arg) => {
				if (arg.paramName === 'node' && 'logInformation' in params.nonTokenLog && 'node' in params.nonTokenLog.logInformation) {
					return <>
						<p style = { textStyle } class = 'paragraph'> { `${ arg.paramName } =` }&nbsp;</p>
						<EnsNamedHashComponent type = 'nameHash' nameHash = { params.nonTokenLog.logInformation.node.nameHash } name = { params.nonTokenLog.logInformation.node.name } editEnsNamedHashCallBack = { params.editEnsNamedHashCallBack }/>
					</>
				}
				if ((arg.paramName === 'id' || arg.paramName === 'label') && 'logInformation' in params.nonTokenLog && 'labelHash' in params.nonTokenLog.logInformation) {
					return <>
						<p style = { textStyle } class = 'paragraph'> { `${ arg.paramName } =` }&nbsp;</p>
						<EnsNamedHashComponent type = 'labelHash' nameHash = { params.nonTokenLog.logInformation.labelHash.labelHash } name = { params.nonTokenLog.logInformation.labelHash.label } editEnsNamedHashCallBack = { params.editEnsNamedHashCallBack }/>
					</>
				}
				if (arg.paramName === 'fuses' && 'logInformation' in params.nonTokenLog && 'fuses' in params.nonTokenLog.logInformation) {
					return <>
						<p style = { textStyle } class = 'paragraph'> { `${ arg.paramName } = [` }</p>
						<StringElement text = { params.nonTokenLog.logInformation.fuses.join(', ') } />
						<p style = { textStyle } class = 'paragraph'>]</p>
					</>
				}
				return <>
					<p style = { textStyle } class = 'paragraph'> { `${ arg.paramName } =` }&nbsp;</p>
					<EnrichedSolidityTypeComponentWithAddressBook valueType = { arg.typeValue } addressMetaData = { params.addressMetaData } renameAddressCallBack = { params.renameAddressCallBack } />
				</>
			}), <p style = { textStyle } class = 'paragraph'>,&nbsp;</p>) }
			<p class = 'paragraph' style = { textStyle }> { ')' } </p>
		</div>
	</>
}

export function NonTokenLogAnalysis(param: NonLogAnalysisParams) {
	if (param.nonTokenLogs.length === 0) return <p class = 'paragraph'> No non-token events </p>
	return <span class = 'nontoken-log-table' style = 'justify-content: center; column-gap: 5px; row-gap: 5px;'>
		{ param.nonTokenLogs.map((nonTokenLog, index) => <NonTokenLogEvent key = { index } nonTokenLog = { nonTokenLog } addressMetaData = { param.addressMetaData } renameAddressCallBack = { param.renameAddressCallBack } editEnsNamedHashCallBack = { param.editEnsNamedHashCallBack }/> ) }
	</span>
}
