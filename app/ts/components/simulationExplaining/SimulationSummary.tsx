import { Erc1155TokenBalanceChange, Erc721and1155OperatorChange, LogSummarizer, SummaryOutcome } from '../../simulation/services/LogSummarizer.js'
import { RenameAddressCallBack, RpcConnectionStatus } from '../../types/user-interface-types.js'
import { Erc721TokenApprovalChange, SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, ERC20TokenApprovalChange, Erc20TokenBalanceChange, TransactionWithAddressBookEntries, NamedTokenId } from '../../types/visualizer-types.js'
import { BigAddress, SmallAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { Ether, EtherAmount, EtherSymbol, TokenWithAmount, TokenAmount, TokenPrice, TokenSymbol, TokenOrEth } from '../subcomponents/coins.js'
import { NonTokenLogAnalysis, TokenLogAnalysis } from './Transactions.js'
import { CopyToClipboard } from '../subcomponents/CopyToClipboard.js'
import { SomeTimeAgo, humanReadableDateDeltaLessDetailed } from '../subcomponents/SomeTimeAgo.js'
import { addressString, bytes32String, nanoString } from '../../utils/bigint.js'
import { identifyTransaction } from './identifyTransaction.js'
import { identifySwap } from './SwapTransactions.js'
import { useState } from 'preact/hooks'
import { convertNumberToCharacterRepresentationIfSmallEnough, upperCaseFirstCharacter } from '../ui-utils.js'
import { EthereumTimestamp } from '../../types/wire-types.js'
import { RpcNetwork } from '../../types/rpc.js'
import { AddressBookEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../../types/addressBookTypes.js'
import { Website } from '../../types/websiteAccessTypes.js'
import { extractTokenEvents } from '../../background/metadataUtils.js'
import { EditEnsNamedHashCallBack } from '../subcomponents/ens.js'
import { EnrichedEthereumInputData } from '../../types/EnrichedEthereumData.js'
import { ChevronIcon, ExportIcon, XMarkIcon } from '../subcomponents/icons.js'
import { TransactionInput } from '../subcomponents/ParsedInputData.js'
import { sendPopupMessageToBackgroundPage, sendPopupMessageToBackgroundPageWithReply } from '../../background/backgroundUtils.js'
import { IntegerInput } from '../subcomponents/AutosizingInput.js'
import { useOptionalSignal } from '../../utils/OptionalSignal.js'
import { Signal, useComputed } from '@preact/signals'

type Erc20BalanceChangeParams = {
	erc20TokenBalanceChanges: Erc20TokenBalanceChange[]
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	renameAddressCallBack: RenameAddressCallBack
}

function Erc20BalanceChange(param: Erc20BalanceChangeParams) {
	if ( param.erc20TokenBalanceChanges.length === 0 ) return <></>
	return <>
		{ Array.from(param.erc20TokenBalanceChanges).map((erc20TokenBalanceChange) => {
			const style =  { color: erc20TokenBalanceChange.changeAmount > 0n ? param.textColor : param.negativeColor }
			return <div class = 'vertical-center' style = 'display: flex'>
				<div class = { param.isImportant ? `box token-box ${ erc20TokenBalanceChange.changeAmount < 0n ? 'negative-box' : 'positive-box' }`: '' } style = 'display: flex' >
					<TokenWithAmount
						tokenEntry = { erc20TokenBalanceChange }
						amount = { erc20TokenBalanceChange.changeAmount }
						showSign = { true }
						style = { style }
						useFullTokenName = { true }
						renameAddressCallBack = { param.renameAddressCallBack }
						fontSize = 'normal'
					/>
					{ erc20TokenBalanceChange.tokenPriceEstimate !== undefined && erc20TokenBalanceChange.tokenPriceEstimateQuoteToken !== undefined ? <>
						<p style = { style }>&nbsp;(</p>
						<TokenPrice
							amount = { erc20TokenBalanceChange.changeAmount }
							tokenPriceEstimate = { erc20TokenBalanceChange.tokenPriceEstimate }
							style = { style }
							quoteTokenEntry = { erc20TokenBalanceChange.tokenPriceEstimateQuoteToken }
							renameAddressCallBack = { param.renameAddressCallBack }
						/>
						<p style = { style }>)</p>
					</> : <></> }
				</div>
			</div>
		})}
	</>
}

type Erc20ApprovalChangeParams = Erc20TokenEntry & {
	change: bigint,
	entryToApprove: AddressBookEntry,
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	renameAddressCallBack: RenameAddressCallBack,
}

function Erc20ApprovalChange(param: Erc20ApprovalChangeParams) {
	const textColor = param.change > 0 ? param.negativeColor : param.textColor

	return <div class = { param.isImportant ? `box token-box ${ param.change > 0 ? 'negative-box' : 'positive-box' }`: '' } style = 'display: inline-flex'>
		<table class = 'log-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis' style = { `color: ${ textColor };` }> Allow</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress
					addressBookEntry = { param.entryToApprove }
					textColor = { textColor }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis' style = { `color: ${ textColor };` }> to spend </p>
			</div>
			<div class = 'log-cell' style = 'justify-content: right;'>
				{ param.change > 2n ** 100n ?
					<p class = 'ellipsis' style = { `color: ${ textColor };` }> <b>ALL</b></p>
					:
					<TokenAmount
						tokenEntry = { param }
						amount = { param.change }
						style = { { color: textColor } }
						fontSize = 'normal'
					/>
				}
			</div>
			<div class = 'log-cell'>
				<TokenSymbol
					tokenEntry = { param }
					style = { { color: textColor } }
					useFullTokenName = { true }
					renameAddressCallBack = { param.renameAddressCallBack }
					fontSize = 'normal'
				/>
			</div>
		</table>
	</div>
}

type Erc20ApprovalChangesParams = {
	erc20TokenApprovalChanges: ERC20TokenApprovalChange[]
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	renameAddressCallBack: RenameAddressCallBack,
}

export function Erc20ApprovalChanges(param: Erc20ApprovalChangesParams ) {
	if (param.erc20TokenApprovalChanges.length === 0) return <></>
	return <>
		{ param.erc20TokenApprovalChanges.map((token) => (
			token.approvals.map((entryToApprove) => (
				<Erc20ApprovalChange { ...{
					...token,
					entryToApprove: entryToApprove,
					change: entryToApprove.change,
					address: token.address,
					textColor: param.textColor,
					negativeColor: param.negativeColor,
					isImportant: param.isImportant,
					renameAddressCallBack: param.renameAddressCallBack,
				} } />
			))
		)) }
	</>
}

type Erc721TokenBalanceChange = (Erc721Entry & { received: boolean, tokenId: bigint })

type Erc721TokenChangesParams = {
	Erc721TokenBalanceChanges: Erc721TokenBalanceChange[],
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	renameAddressCallBack: RenameAddressCallBack,
}

function Erc721TokenChanges(param: Erc721TokenChangesParams ) {
	if ( param.Erc721TokenBalanceChanges.length === 0 ) return <></>
	return <>
		{ param.Erc721TokenBalanceChanges.map((tokenChange) => (
			<div class = 'vertical-center' style = 'display: flex'>
				<div class = { param.isImportant ? `box token-box ${ !tokenChange.received ? 'negative-box' : 'positive-box' }`: '' } style = 'display: flex'>
					<p class = 'noselect nopointer' style = { `color: ${ param.textColor }; align-items: center` }>
						&nbsp;{ `${ tokenChange.received ? '+' : '-' }` }&nbsp;
					</p>
					<TokenOrEth
						tokenEntry = { tokenChange }
						tokenId = { tokenChange.tokenId }
						style = { { color: param.textColor } }
						useFullTokenName = { true }
						showSign = { true }
						renameAddressCallBack = { param.renameAddressCallBack }
						fontSize = 'normal'
					/>
				</div>
			</div>
		)) }
	</>
}

export type Erc721OperatorChange = Erc721Entry & { operator: AddressBookEntry | undefined }
export type Erc1155OperatorChange = (Erc1155Entry & { operator: AddressBookEntry | undefined })

type Erc721Or1155OperatorChangesParams = {
	erc721or1155OperatorChanges: Erc721and1155OperatorChange[]
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	renameAddressCallBack: RenameAddressCallBack,
}

export function Erc721or1155OperatorChanges(param: Erc721Or1155OperatorChangesParams) {
	if (param.erc721or1155OperatorChanges.length === 0) return <></>
	return <>
		{ param.erc721or1155OperatorChanges.map((token) => (
			<div class = 'vertical-center' style = 'display: flex'>
				{ token.operator !== undefined ?
					<div class = { param.isImportant ? 'box token-box negative-box': '' } style = 'display: flex'>
						<table class = 'log-table'>
							<div class = 'log-cell'>
								<p class = 'ellipsis' style = { `color: ${ param.negativeColor }` }> Allow</p>
							</div>
							<div class = 'log-cell'>
								<SmallAddress
									addressBookEntry = { token.operator }
									textColor = { param.negativeColor }
									renameAddressCallBack = { param.renameAddressCallBack }
								/>
							</div>
							<div class = 'log-cell'>
								<p class = 'ellipsis'  style = { `color: ${ param.negativeColor }` }>to spend <b>ALL</b></p>
							</div>
							<div class = 'log-cell'>
								<TokenSymbol
									tokenEntry = { token }
									tokenId = { undefined }
									style = { { color: param.negativeColor } }
									useFullTokenName = { true }
									renameAddressCallBack = { param.renameAddressCallBack }
									fontSize = 'normal'
								/>
							</div>
						</table>
					</div>
					:
					<div class = { param.isImportant ? 'box token-box positive-box': '' } >
						<table class = 'log-table'>
							<div class = 'log-cell'>
								<p class = 'ellipsis' style = { `color: ${ param.textColor };` }> to NOT spend ANY</p>
							</div>
							<div class = 'log-cell'>
								<TokenSymbol
									tokenEntry = { token }
									tokenId = { undefined }
									style = { { color: param.textColor } }
									useFullTokenName = { true }
									renameAddressCallBack = { param.renameAddressCallBack }
									fontSize = 'normal'
								/>
							</div>
						</table>
					</div>
				}
			</div>
		)) }
	</>
}

type Erc721TokenIdApprovalChangesParams = {
	Erc721TokenIdApprovalChanges: Erc721TokenApprovalChange[]
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	renameAddressCallBack: RenameAddressCallBack,
}

export function Erc721TokenIdApprovalChanges(param: Erc721TokenIdApprovalChangesParams ) {
	return <> { param.Erc721TokenIdApprovalChanges.length > 0 ?
		<>
			{ param.Erc721TokenIdApprovalChanges.map( (approvalsChange) => (
				<div class = 'vertical-center' style = 'display: flex'>
					<div class = { param.isImportant ? 'box token-box negative-box': '' } style = 'display: flex'>
						<table class = 'log-table'>
							<div class = 'log-cell'>
								<p class = 'ellipsis' style = { `color: ${ param.negativeColor }` }> Approve</p>
							</div>
							<div class = 'log-cell'>
								<SmallAddress
									addressBookEntry = { approvalsChange.approvedEntry }
									textColor = { param.negativeColor }
									renameAddressCallBack = { param.renameAddressCallBack }
								/>
							</div>
							<div class = 'log-cell'>
								<p class = 'ellipsis' style = { `color: ${ param.negativeColor }` }>for</p>
							</div>
							<div class = 'log-cell'>
								<TokenOrEth
									tokenEntry = { approvalsChange.tokenEntry }
									tokenId = { approvalsChange.tokenId }
									style = { { color: param.negativeColor } }
									useFullTokenName = { true }
									renameAddressCallBack = { param.renameAddressCallBack }
									fontSize = 'normal'
								/>
							</div>
						</table>
					</div>
				</div>
			)) }
		</>
	: <></> } </>
}


type Erc1155TokenChangesParams = {
	Erc1155TokenBalanceChanges: Erc1155TokenBalanceChange[],
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	renameAddressCallBack: RenameAddressCallBack,
	namedTokenIds: readonly NamedTokenId[],
}

function Erc1155TokenChanges(param: Erc1155TokenChangesParams ) {
	if (param.Erc1155TokenBalanceChanges.length === 0) return <></>

	return <>
		{ param.Erc1155TokenBalanceChanges.map((tokenChange) => (
			<div class = 'vertical-center' style = 'display: flex'>
				<div class = { param.isImportant ? `box token-box ${ tokenChange.changeAmount < 0n ? 'negative-box' : 'positive-box' }`: '' } style = 'display: flex'>
					<TokenWithAmount
						tokenEntry = { tokenChange }
						tokenId = { tokenChange.tokenId }
						tokenIdName = { param.namedTokenIds.find((namedTokenId) => namedTokenId.tokenAddress === tokenChange.address && namedTokenId.tokenId === tokenChange.tokenId)?.tokenIdName }
						amount = { tokenChange.changeAmount }
						style = { { color: param.textColor } }
						useFullTokenName = { true }
						showSign = { true }
						renameAddressCallBack = { param.renameAddressCallBack }
						fontSize = 'normal'
					/>
				</div>
			</div>
		)) }
	</>
}


type SummarizeAddressParams = {
	balanceSummary: SummaryOutcome,
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	renameAddressCallBack: RenameAddressCallBack,
}

function SummarizeAddress(param: SummarizeAddressParams) {
	const isOwnAddress = param.balanceSummary.summaryFor.useAsActiveAddress || param.balanceSummary.summaryFor.address === param.simulationAndVisualisationResults.activeAddress
	const positiveNegativeColors = isOwnAddress
		? {
			textColor: 'var(--text-color)',
			negativeColor: 'var(--text-color)'
		}
		: {
			textColor: 'var(--disabled-text-color)',
			negativeColor: 'var(--negative-dim-color)'
		}

	return <div>
		{ isOwnAddress ?
			<BigAddress
				addressBookEntry = { param.balanceSummary.summaryFor }
				renameAddressCallBack = { param.renameAddressCallBack }
				style = { { '--bg-color': '#6d6d6d' } }
			/> :
			<SmallAddress
				textColor = { positiveNegativeColors.textColor }
				addressBookEntry = { param.balanceSummary.summaryFor }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		}

		<div class = 'content' style = 'margin-bottom: 0px;'>
			<Erc20BalanceChange
				erc20TokenBalanceChanges = { param.balanceSummary.erc20TokenBalanceChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
			<Erc20ApprovalChanges
				erc20TokenApprovalChanges = { param.balanceSummary.erc20TokenApprovalChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
			<Erc721TokenChanges
				Erc721TokenBalanceChanges = { param.balanceSummary.erc721TokenBalanceChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
			<Erc721or1155OperatorChanges
				erc721or1155OperatorChanges = { param.balanceSummary.erc721and1155OperatorChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
			<Erc721TokenIdApprovalChanges
				Erc721TokenIdApprovalChanges = { param.balanceSummary.erc721TokenIdApprovalChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
			<Erc1155TokenChanges
				Erc1155TokenBalanceChanges = { param.balanceSummary.erc1155TokenBalanceChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
				namedTokenIds = { param.simulationAndVisualisationResults.namedTokenIds }
			/>
		</div>
	</div>
}

type TokenLogAnalysisCardParams = {
	simTx: SimulatedAndVisualizedTransaction
	renameAddressCallBack: RenameAddressCallBack
}

export function TokenLogAnalysisCard({ simTx, renameAddressCallBack }: TokenLogAnalysisCardParams) {
	const [showLogs, setShowLogs] = useState<boolean>(false)
	const identifiedSwap = identifySwap(simTx)
	if (simTx === undefined) return <></>
	const tokenEventsPlural = 'token events or ETH transactions'
	const tokenEventsSingular = 'One token event or an ETH transaction'
	const tokenResults = extractTokenEvents(simTx.events)
	return <>
		<div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
			<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowLogs((prevValue) => !prevValue) }>
				<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
					{ tokenResults.length === 0 ? `No ${ tokenEventsPlural }` : `${ tokenResults.length > 1 ? `${ upperCaseFirstCharacter(convertNumberToCharacterRepresentationIfSmallEnough(tokenResults.length)) } ${ tokenEventsPlural }` : tokenEventsSingular }` }
				</p>
				<div class = 'card-header-icon'>
					<span class = 'icon'><ChevronIcon /></span>
				</div>
			</header>
			{ !showLogs
				? <></>
				: <div class = 'card-content' style = 'border-bottom-left-radius: 0.25rem; border-bottom-right-radius: 0.25rem; border-left: 2px solid var(--card-bg-color); border-right: 2px solid var(--card-bg-color); border-bottom: 2px solid var(--card-bg-color);'>
					<TokenLogAnalysis
						simulatedAndVisualizedTransaction = { simTx }
						identifiedSwap = { identifiedSwap }
						renameAddressCallBack = { renameAddressCallBack }
					/>
				</div>
			}
		</div>
	</>
}

type NonTokenLogAnalysisCardParams = {
	simTx: SimulatedAndVisualizedTransaction
	renameAddressCallBack: RenameAddressCallBack
	editEnsNamedHashCallBack: EditEnsNamedHashCallBack
	addressMetaData: readonly AddressBookEntry[]
}

export function NonTokenLogAnalysisCard({ simTx, addressMetaData, renameAddressCallBack, editEnsNamedHashCallBack }: NonTokenLogAnalysisCardParams) {
	const [showLogs, setShowLogs] = useState<boolean>(false)
	if (simTx === undefined) return <></>
	const nonTokenLogs = simTx.events.filter((event) => event.type !== 'TokenEvent')
	return <>
		<div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
			<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowLogs((prevValue) => !prevValue) }>
				<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
					{ nonTokenLogs.length === 0 ? 'No non-token events' : `${ upperCaseFirstCharacter(convertNumberToCharacterRepresentationIfSmallEnough(nonTokenLogs.length)) } non-token event${ nonTokenLogs.length > 1 ? 's' : '' }` }
				</p>
				<div class = 'card-header-icon'>
					<span class = 'icon'><ChevronIcon /></span>
				</div>
			</header>
			{ !showLogs
				? <></>
				: <div class = 'card-content' style = 'border-bottom-left-radius: 0.25rem; border-bottom-right-radius: 0.25rem; border-left: 2px solid var(--card-bg-color); border-right: 2px solid var(--card-bg-color); border-bottom: 2px solid var(--card-bg-color);'>
					<NonTokenLogAnalysis nonTokenLogs = { nonTokenLogs } addressMetaData = { addressMetaData } renameAddressCallBack = { renameAddressCallBack } editEnsNamedHashCallBack = { editEnsNamedHashCallBack }/>
				</div>
			}
		</div>
	</>
}

function splitToOwnAndNotOwnAndCleanSummary(summary: SummaryOutcome[], activeAddress: bigint) {
	const ownAddresses = Array.from(summary.entries()).filter( ([_index, balanceSummary]) =>
		balanceSummary.summaryFor.useAsActiveAddress || balanceSummary.summaryFor.address === activeAddress
	)
	const notOwnAddresses = Array.from(summary.entries()).filter( ([_index, balanceSummary]) =>
		!(balanceSummary.summaryFor.useAsActiveAddress || balanceSummary.summaryFor.address === activeAddress)
	)
	return [ownAddresses, notOwnAddresses]
}

type AccountChangesCardParams = {
	simTx: SimulatedAndVisualizedTransaction
	simulationAndVisualisationResults: SimulationAndVisualisationResults
	renameAddressCallBack: RenameAddressCallBack
	addressMetaData: readonly AddressBookEntry[]
	namedTokenIds: readonly NamedTokenId[]
}

export function TransactionsAccountChangesCard({ simTx, renameAddressCallBack, addressMetaData, simulationAndVisualisationResults, namedTokenIds }: AccountChangesCardParams) {
	const logSummarizer = new LogSummarizer([simTx])
	const addressMetaDataMap = new Map(addressMetaData.map((x) => [addressString(x.address), x]))
	const originalSummary = logSummarizer.getSummary(addressMetaDataMap, simulationAndVisualisationResults.tokenPriceEstimates, namedTokenIds)
	const [showSummary, setShowSummary] = useState<boolean>(false)
	const [ownAddresses, notOwnAddresses] = splitToOwnAndNotOwnAndCleanSummary(originalSummary, simulationAndVisualisationResults.activeAddress)

	if (notOwnAddresses === undefined || ownAddresses === undefined) throw new Error('addresses were undefined')
	const numberOfChanges = notOwnAddresses.length + ownAddresses.length

	return <div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
		<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowSummary((prevValue) => !prevValue) }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
				{ numberOfChanges === 0 ? 'No changes in accounts' : `${  upperCaseFirstCharacter(convertNumberToCharacterRepresentationIfSmallEnough(numberOfChanges)) } account${ numberOfChanges > 1 ? 's' : '' } changing` }
			</p>
			<div class = 'card-header-icon'>
				<span class = 'icon'><ChevronIcon /></span>
			</div>
		</header>
		{ !showSummary
			? <></>
			: <div class = 'card-content'>
				<div class = 'container' style = 'margin-bottom: 10px;'>
					{ ownAddresses.length === 0 ? <p class = 'paragraph'> No changes to your accounts </p>
						: <div class = 'notification transaction-importance-box'>
							{ ownAddresses.map( ([_index, balanceSummary], index) => <>
								<SummarizeAddress
									balanceSummary = { balanceSummary }
									simulationAndVisualisationResults = { simulationAndVisualisationResults }
									renameAddressCallBack = { renameAddressCallBack }
								/>
								{ index + 1 !== ownAddresses.length ? <div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/> : <></> }
							</> ) }
						</div>
					}
				</div>

				{ notOwnAddresses.length === 0
					? <></>
					: <div class = 'container'>
						{ notOwnAddresses.map( ([_index, balanceSummary]) => {
							return <>
								<SummarizeAddress
									balanceSummary = { balanceSummary }
									simulationAndVisualisationResults = { simulationAndVisualisationResults }
									renameAddressCallBack = { renameAddressCallBack }
								/>
								<div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/>
							</>
						})}
					</div>
				}
			</div>
		}
	</div>
}

export type TransactionGasses = {
	gasSpent: bigint
	realizedGasPrice: bigint
}

export function GasFee({ tx, rpcNetwork }: { tx: TransactionGasses, rpcNetwork: RpcNetwork } ) {
	return <>
		<div class = 'log-cell'>
			<p class = 'ellipsis' style = { 'color: var(--subtitle-text-color); margin-bottom: 0px' }> Gas fee:</p>
		</div>
		<div class = 'log-cell'>
			<EtherAmount
				amount = { tx.gasSpent * tx.realizedGasPrice  }
				style = { { color: 'var(--subtitle-text-color)' } }
				fontSize = 'normal'
			/>
		</div>
		<div class = 'log-cell'>
			<EtherSymbol
				style = { { color: 'var(--subtitle-text-color)' } }
				rpcNetwork = { rpcNetwork }
				fontSize = 'normal'
			/>
		</div>
	</>
}

type TransactionHeaderParams = {
	simTx: SimulatedAndVisualizedTransaction
	removeTransactionOrSignedMessage?: () => void
}

export function TransactionHeader({ simTx, removeTransactionOrSignedMessage } : TransactionHeaderParams) {
	return <header class = 'card-header'>
		<div class = 'card-header-icon unset-cursor'>
			<span class = 'icon'>
				<img src = { simTx.statusCode === 'success' ? ( simTx.quarantine ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
			</span>
		</div>
		<p class = 'card-header-title' style = 'white-space: nowrap;'>
			{ identifyTransaction(simTx).title }
		</p>
		{ simTx.transaction.to === undefined
			? <></>
			: <p class = 'card-header-icon unsetcursor' style = { `margin-left: auto; margin-right: 0; overflow: hidden; ${ removeTransactionOrSignedMessage !== undefined ? 'padding: 0' : ''}` }>
				<WebsiteOriginText { ...simTx.website } />
			</p>
		}
		{ removeTransactionOrSignedMessage !== undefined
			? <button class = 'card-header-icon' aria-label = 'remove' onClick = { removeTransactionOrSignedMessage }><XMarkIcon /></button>
			: <></>
		}
	</header>
}

export function TransactionHeaderForFailedToSimulate({ website } : { website: Website }) {
	return <header class = 'card-header'>
		<div class = 'card-header-icon unset-cursor'>
			<span class = 'icon'>
				<img src = { '../img/error-icon.svg' } />
			</span>
		</div>
		<p class = 'card-header-title' style = 'white-space: nowrap;'> Not simulated </p>
		<p class = 'card-header-icon unsetcursor' style = 'margin-left: auto; margin-right: 0; overflow: hidden;'>
			<WebsiteOriginText { ...website } />
		</p>
	</header>
}

export function TransactionCreated({ created } : { created: EthereumTimestamp }) {
	return <p style = 'color: var(--subtitle-text-color); text-align: right; display: inline; text-overflow: ellipsis; overflow: hidden;'>
		{ 'Created ' }
		<SomeTimeAgo priorTimestamp = { created } diffToText = { humanReadableDateDeltaLessDetailed }/>
	</p>
}

export function SimulatedInBlockNumber({ simulationBlockNumber, currentBlockNumber, simulationConductedTimestamp, rpcConnectionStatus } : { simulationBlockNumber: bigint, currentBlockNumber: bigint | undefined, simulationConductedTimestamp: Date, rpcConnectionStatus: Signal<RpcConnectionStatus> }) {
	return <CopyToClipboard
		content = { simulationBlockNumber.toString() }
		contentDisplayOverride = { `Simulated in block number ${ simulationBlockNumber }` }
		copyMessage = 'Block number copied!'
	>
		<p style = 'color: var(--subtitle-text-color); text-align: right; display: inline; text-overflow: ellipsis; overflow: hidden;'>
			{ 'Simulated ' }
			<span style = { `font-weight: bold; font-family: monospace; color: ${
				simulationBlockNumber === currentBlockNumber && (rpcConnectionStatus.value?.isConnected || rpcConnectionStatus === undefined) ? 'var(--positive-color)' :
					currentBlockNumber !== undefined && simulationBlockNumber + 1n === currentBlockNumber ? 'var(--warning-color)' : 'var(--negative-color)'
			} ` }>
				<SomeTimeAgo priorTimestamp = { simulationConductedTimestamp }/>
			</span>
			{ ' ago' }
		</p>
	</CopyToClipboard>
}

type SimulationSummaryParams = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	currentBlockNumber: bigint | undefined,
	renameAddressCallBack: RenameAddressCallBack,
	rpcConnectionStatus: Signal<RpcConnectionStatus>,
}

export function SimulationSummary(param: SimulationSummaryParams) {
	if (param.simulationAndVisualisationResults === undefined || param.simulationAndVisualisationResults.visualizedSimulationState.visualizedBlocks.length === 0) return <></>
	const simulatedAndVisualizedTransactions = param.simulationAndVisualisationResults.visualizedSimulationState.visualizedBlocks.flatMap((block) => block.simulatedAndVisualizedTransactions)
	const logSummarizer = new LogSummarizer(simulatedAndVisualizedTransactions)
	const addressMetaData = new Map(param.simulationAndVisualisationResults.addressBookEntries.map((x) => [addressString(x.address), x]))
	const originalSummary = logSummarizer.getSummary(addressMetaData, param.simulationAndVisualisationResults.tokenPriceEstimates, param.simulationAndVisualisationResults.namedTokenIds)
	const [ownAddresses, notOwnAddresses] = splitToOwnAndNotOwnAndCleanSummary(originalSummary, param.simulationAndVisualisationResults.activeAddress)
	const [showOtherAccountChanges, setShowOtherAccountChange] = useState<boolean>(false)

	if (ownAddresses === undefined || notOwnAddresses === undefined) throw new Error('addresses were undefined')

	const icon = useComputed(() => {
		const transactions = param.simulationAndVisualisationResults.visualizedSimulationState.visualizedBlocks.flatMap((block) => block.simulatedAndVisualizedTransactions)
		if (transactions.some((transaction) => transaction.statusCode !== 'success')) return '../img/error-icon.svg'
		if (transactions.some((transaction) => transaction.quarantine)) return '../img/warning-sign.svg'
		return '../img/success-icon.svg'
	})

	const exportEthSimulateInput = async () => {
		const reply = await sendPopupMessageToBackgroundPageWithReply({ method: 'popup_requestInterceptorSimulateInput' })
		if (reply === undefined) return
		return reply.ethSimulateV1InputString
	}

	return (
		<div class = 'card' style = 'background-color: var(--card-bg-color); margin: 10px;'>
			<header class = 'card-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = { icon } />
					</span>
				</div>
				<div class = 'card-header-title'>
					<p className = 'paragraph'> Simulation Outcome </p>
				</div>
			</header>
			<div class = 'card-content'>
				<div class = 'container' style = 'margin-bottom: 10px'>
					{ ownAddresses.length === 0 ? <p class = 'paragraph'> No changes to your accounts </p>
						: <div class = 'notification transaction-importance-box'>
							{ ownAddresses.map( ([_index, balanceSummary], index) => <>
								<SummarizeAddress
									balanceSummary = { balanceSummary }
									simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
									renameAddressCallBack = { param.renameAddressCallBack }
								/>
								{ index + 1 !== ownAddresses.length ? <div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/> : <></> }
							</> ) }
						</div>
					}
				</div>
				<div class = 'card'>
					<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowOtherAccountChange((prevValue) => !prevValue) }>
						<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
							{ notOwnAddresses.length === 0 ? 'No changes in other accounts' : `${ upperCaseFirstCharacter(convertNumberToCharacterRepresentationIfSmallEnough(notOwnAddresses.length)) } other account${ notOwnAddresses.length > 1 ? 's' : '' } changing` }
						</p>
						<div class = 'card-header-icon'>
							<span class = 'icon'><ChevronIcon /></span>
						</div>
					</header>
					{ !showOtherAccountChanges
						? <></>
						: <div class = 'card-content'>
							<div class = 'container'>
								{ notOwnAddresses.length === 0 ? <p class = 'paragraph'>No changes to other accounts</p> : notOwnAddresses.map( ([_index, balanceSummary]) => (<>
									<SummarizeAddress
										balanceSummary = { balanceSummary }
										simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
										renameAddressCallBack = { param.renameAddressCallBack }
									/>
									<div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/>
								</>) ) }
							</div>
						</div>
					}
				</div>

				<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: max-content auto auto; grid-column-gap: 5px;'>
					<div class = 'log-cell'>
						<CopyToClipboard
							copyFunction = { exportEthSimulateInput }
							copyMessage = 'eth_simulateV1 input query copied!'
							classNames = { 'btn btn--outline is-small' }
						>
							<p className = 'paragraph noselect nopointer' style = 'text-overflow: ellipsis; overflow: hidden; white-space: nowrap; display: block;'>
								<span style = { { marginRight: '0.25rem', fontSize: '1rem' } }>
									<ExportIcon/>
								</span>
								<span>Export Simulate Stack</span>
							</p>
						</CopyToClipboard>
					</div>

					<div class = 'log-cell' style = 'justify-content: center;'> </div>
					<div class = 'log-cell' style = 'justify-content: right;'>
						<SimulatedInBlockNumber
							simulationBlockNumber = { param.simulationAndVisualisationResults.blockNumber }
							currentBlockNumber = { param.currentBlockNumber }
							simulationConductedTimestamp = { param.simulationAndVisualisationResults.simulationConductedTimestamp }
							rpcConnectionStatus = { param.rpcConnectionStatus }
						/>
					</div>
				</span>
			</div>
		</div>
	)
}

type RawTransactionDetailsCardParams = {
	addressMetaData: readonly AddressBookEntry[]
	parsedInputData: EnrichedEthereumInputData
	transaction: TransactionWithAddressBookEntries
	renameAddressCallBack: RenameAddressCallBack
	gasSpent: bigint
	transactionIdentifier: bigint
}
export function RawTransactionDetailsCard({ transaction, renameAddressCallBack, gasSpent, parsedInputData, addressMetaData, transactionIdentifier }: RawTransactionDetailsCardParams) {
	const [showSummary, setShowSummary] = useState<boolean>(false)
	const gasLimit = useOptionalSignal<bigint>(transaction.gas)

	async function forceSetGasLimitForTransaction() {
		const gas = gasLimit.deepPeek()
		if (gas === undefined || gas === transaction.gas) return
		await sendPopupMessageToBackgroundPage({ method: 'popup_forceSetGasLimitForTransaction', data: { gasLimit: gas, transactionIdentifier: transactionIdentifier } })
	}

	return <div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
		<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowSummary((prevValue) => !prevValue) }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
				Raw transaction information
			</p>
			<div class = 'card-header-icon'>
				<span class = 'icon'><ChevronIcon /></span>
			</div>
		</header>
		{ !showSummary
			? <></>
			: <div class = 'card-content'>
				<div style = { { display: 'flex', flexDirection: 'column', rowGap: '1rem' } } >
					<dl class = 'grid key-value-pair'>
						<dt>Transaction type</dt>
						<dd>{ transaction.type }</dd>
						<dt>From</dt>
						<dd>{ <SmallAddress addressBookEntry = { transaction.from } renameAddressCallBack = { renameAddressCallBack }/> }</dd>
						<dt>To</dt>
						<dd>{ transaction.to === undefined ? 'No receiving Address' : <SmallAddress addressBookEntry = { transaction.to } renameAddressCallBack = { renameAddressCallBack }/> }</dd>
						<dt>Value</dt>
						<dd>{ <Ether amount = { transaction.value } useFullTokenName = { true } rpcNetwork = { transaction.rpcNetwork } fontSize = 'normal'/> }</dd>
						<dt>Gas used</dt>
						<dd>{ `${ gasSpent.toString(10) } gas (${ Number(gasSpent * 10000n / transaction.gas) / 100 }%)` }</dd>
						<dt>Gas limit </dt>
						<dd style = 'display: flex; align-items: center; justify-content: center;'>
							<span style = 'padding: 2px; background: rgba(255, 255, 255, 0.1); border-bottom: 1.5px solid var(--text-color);'>
								<IntegerInput
									autoSize = { true }
									value = { gasLimit }
									placeholder = { transaction.gas.toString(10) }
								/>
							</span>
							&nbsp;gas&nbsp;
							<button disabled = { gasLimit.deepValue === transaction.gas } class = 'button is-primary is-small' onClick = { forceSetGasLimitForTransaction }>Change</button>
						</dd>
						<dt>Nonce: </dt>
						<dd>{ transaction.nonce.toString(10) }</dd>
						<dt>Chain</dt>
						<dd>{ transaction.rpcNetwork.name }</dd>
						<dt>Unsigned transaction hash</dt>
						<dd><span class = 'text-legible truncate'>{ bytes32String(transaction.hash) }</span></dd>


						{ transaction.type !== '1559'
							? <></>
							: <>
								<dt>Max Fee Per Gas</dt>
								<dd>{ `${ nanoString(transaction.maxFeePerGas) } nanoeth/gas` }</dd>
								<dt>Max Priority Fee Per Gas</dt>
								<dd>{ `${ nanoString(transaction.maxPriorityFeePerGas) } nanoeth/gas` }</dd>
							</>
						}
					</dl>

					<div>
						<p class = 'paragraph' style = { {  color: 'var(--subtitle-text-color)', marginBottom: '0.25rem'} }>Transaction Input</p>
						<TransactionInput parsedInputData = { parsedInputData } input = { transaction.input } to = { transaction.to } addressMetaData = { addressMetaData } renameAddressCallBack = { renameAddressCallBack } />
					</div>
				</div>
			</div>
		}
	</div>
}
