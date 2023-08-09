import { Erc1155TokenBalanceChange, LogSummarizer, SummaryOutcome } from '../../simulation/services/LogSummarizer.js'
import { AddressBookEntry, RenameAddressCallBack, Website } from '../../utils/user-interface-types.js'
import { Erc721TokenApprovalChange, Erc721Definition, SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, ERC20TokenApprovalChange, Erc20TokenBalanceChange, Erc20Definition, TransactionWithAddressBookEntries, Erc1155Definition } from '../../utils/visualizer-types.js'
import { BigAddress, SmallAddress, WebsiteOriginText } from '../subcomponents/address.js'
import { Erc721Token, Ether, EtherAmount, EtherSymbol, TokenWithAmount, TokenAmount, TokenPrice, TokenSymbol } from '../subcomponents/coins.js'
import { LogAnalysis } from './Transactions.js'
import { CopyToClipboard } from '../subcomponents/CopyToClipboard.js'
import { SomeTimeAgo, humanReadableDateDeltaLessDetailed } from '../subcomponents/SomeTimeAgo.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../../utils/constants.js'
import { addressString, bytes32String, dataStringWith0xStart, nanoString } from '../../utils/bigint.js'
import { identifyTransaction } from './identifyTransaction.js'
import { identifySwap } from './SwapTransactions.js'
import { useState } from 'preact/hooks'
import { CellElement, convertNumberToCharacterRepresentationIfSmallEnough, upperCaseFirstCharacter } from '../ui-utils.js'
import { RpcConnectionStatus } from '../../utils/interceptor-messages.js'
import { EthereumTimestamp } from '../../utils/wire-types.js'
import { getEthDonator } from '../../background/storageVariables.js'
import { RpcNetwork } from '../../utils/visualizer-types.js'

type EtherChangeParams = {
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	etherResults: {
		balanceBefore: bigint;
		balanceAfter: bigint;
	} | undefined,
	rpcNetwork: RpcNetwork,
}

function EtherChange(param: EtherChangeParams) {
	if ( param.etherResults === undefined ) return <></>
	const amount = param.etherResults.balanceAfter - param.etherResults.balanceBefore
	const boxColor = amount < 0n ? 'negative-box' : 'positive-box'
	return <div class = 'vertical-center' style = 'display: flex'>
		<div class = { param.isImportant ? `box token-box ${ boxColor }`: '' } style = 'display: flex'>
			<Ether
				amount = { amount }
				textColor = { amount >= 0 ? param.textColor : param.negativeColor }
				showSign = { true }
				useFullTokenName = { true }
				rpcNetwork = { param.rpcNetwork }
			/>
		</div>
	</div>
}

type Erc20BalanceChangeParams = {
	erc20TokenBalanceChanges: Erc20TokenBalanceChange[]
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	rpcNetwork: RpcNetwork,
}

function Erc20BalanceChange(param: Erc20BalanceChangeParams) {
	if ( param.erc20TokenBalanceChanges.length === 0 ) return <></>
	return <>
		{ Array.from(param.erc20TokenBalanceChanges).map((Erc20TokenBalanceChange) => (
			<div class = 'vertical-center' style = 'display: flex'>
				<div class = { param.isImportant ? `box token-box ${ Erc20TokenBalanceChange.changeAmount < 0n ? 'negative-box' : 'positive-box' }`: '' } style = 'display: flex' >
					<TokenWithAmount
						{ ...Erc20TokenBalanceChange }
						amount = { Erc20TokenBalanceChange.changeAmount }
						showSign = { true }
						textColor = { Erc20TokenBalanceChange.changeAmount > 0n ? param.textColor : param.negativeColor }
						useFullTokenName = { true }
					/>
					<TokenPrice
						amount = { Erc20TokenBalanceChange.changeAmount }
						tokenPriceEstimate = { Erc20TokenBalanceChange.tokenPriceEstimate }
						textColor = { Erc20TokenBalanceChange.changeAmount > 0n ? param.textColor : param.negativeColor }
						rpcNetwork = { param.rpcNetwork }
					/>
				</div>
			</div>
		))}
	</>
}

type Erc20ApprovalChangeParams = Erc20Definition & {
	change: bigint,
	entryToApprove: AddressBookEntry,
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	renameAddressCallBack: RenameAddressCallBack,
}

export function Erc20ApprovalChange(param: Erc20ApprovalChangeParams) {
	const textColor = param.change > 0 ? param.negativeColor : param.textColor

	return <div class = { param.isImportant ? `box token-box ${ param.change > 0 ? 'negative-box' : 'positive-box' }`: '' } style = 'display: inline-flex'>
		<table class = 'log-table'>
			<div class = 'log-cell'>
				<p class = 'ellipsis' style = {`color: ${ textColor };` }> Allow&nbsp;</p>
			</div>
			<div class = 'log-cell'>
				<SmallAddress
					addressBookEntry = { param.entryToApprove }
					textColor = { textColor }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>
			</div>
			<div class = 'log-cell'>
				<p class = 'ellipsis' style = {`color: ${ textColor };` }> &nbsp;to spend&nbsp; </p>
			</div>
			<div class = 'log-cell' style = 'justify-content: right;'>
				{ param.change > 2n ** 100n ?
					<p class = 'ellipsis' style = {`color: ${ textColor };` }> <b>ALL</b>&nbsp;</p>
					:
					<TokenAmount
						{ ...param }
						amount = { param.change }
						textColor = { textColor }
					/>
				}
			</div>
			<div class = 'log-cell'>
				<TokenSymbol
					{ ...param }
					textColor = { textColor }
					useFullTokenName = { true }
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
	if ( param.erc20TokenApprovalChanges.length === 0 ) return <></>
	return <>
		{ param.erc20TokenApprovalChanges.map( (token) => (
			token.approvals.map( (entryToApprove) => (
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

export type Erc721TokenBalanceChange = (Erc721Definition & { received: boolean })

type Erc721TokenChangesParams = {
	Erc721TokenBalanceChanges: Erc721TokenBalanceChange[],
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
}

function Erc721TokenChanges(param: Erc721TokenChangesParams ) {
	if ( param.Erc721TokenBalanceChanges.length == 0 ) return <></>

	return <>
		{ param.Erc721TokenBalanceChanges.map( (tokenChange) => (
			<div class = 'vertical-center' style = 'display: flex'>
				<div class = { param.isImportant ? `box token-box ${ !tokenChange.received ? 'negative-box' : 'positive-box' }`: '' } style = 'display: flex'>
					<Erc721Token
						{ ...tokenChange }
						received = { tokenChange.received }
						textColor = { param.textColor }
						useFullTokenName = { true }
						showSign = { true }
					/>
				</div>
			</div>
		)) }
	</>
}

export type Erc721OperatorChange = Omit<Erc721Definition, 'tokenId'> & { operator: AddressBookEntry | undefined }
export type Erc1155OperatorChange = (Omit<Erc1155Definition, 'tokenId'> & { operator: AddressBookEntry | undefined })

type Erc721Or1155OperatorChangesParams = {
	erc721or1155OperatorChanges: (Erc721OperatorChange | Erc1155OperatorChange)[]
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
								<p class = 'ellipsis' style = { `color: ${ param.negativeColor }` }> Allow&nbsp;</p>
							</div>
							<div class = 'log-cell'>
								<SmallAddress
									addressBookEntry = { token.operator }
									textColor = { param.negativeColor }
									renameAddressCallBack = { param.renameAddressCallBack }
								/>
							</div>
							<div class = 'log-cell'>
								<p class = 'ellipsis'  style = { `color: ${ param.negativeColor }` }>&nbsp;to spend <b>ALL</b>&nbsp;</p>
							</div>
							<div class = 'log-cell'>
								<TokenSymbol
									{ ...token }
									textColor = { param.negativeColor }
									useFullTokenName = { true }
								/>
							</div>
						</table>
					</div>
				:
					<div class = { param.isImportant ? 'box token-box positive-box': '' } >
						<table class = 'log-table'>
							<div class = 'log-cell'>
								<p class = 'ellipsis' style = { `color: ${ param.textColor };` }> to NOT spend ANY&nbsp;</p>
							</div>
							<div class = 'log-cell'>
								<TokenSymbol
									{ ...token }
									textColor = { param.textColor }
									useFullTokenName = { true }
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
								<p class = 'ellipsis' style = {`color: ${ param.negativeColor }` }> Approve&nbsp;</p>
							</div>
							<div class = 'log-cell'>
								<SmallAddress
									addressBookEntry = { approvalsChange.approvedEntry }
									textColor = { param.negativeColor }
									renameAddressCallBack = { param.renameAddressCallBack }
								/>
							</div>
							<div class = 'log-cell'>
								<p class = 'ellipsis' style = {`color: ${ param.negativeColor }` }>&nbsp;for&nbsp;</p>
							</div>
							<div class = 'log-cell'>
								<Erc721Token
									{ ...approvalsChange.token }
									received = { true }
									textColor = { param.negativeColor }
									useFullTokenName = { true }
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
}

function Erc1155TokenChanges(param: Erc1155TokenChangesParams ) {
	if (param.Erc1155TokenBalanceChanges.length == 0) return <></>

	return <>
		{ param.Erc1155TokenBalanceChanges.map((tokenChange) => (
			<div class = 'vertical-center' style = 'display: flex'>
				<div class = { param.isImportant ? `box token-box ${ tokenChange.changeAmount < 0n ? 'negative-box' : 'positive-box' }`: '' } style = 'display: flex'>
					<TokenWithAmount
						{ ...tokenChange }
						amount = { tokenChange.changeAmount }
						textColor = { param.textColor }
						useFullTokenName = { true }
						showSign = { true }
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

export function SummarizeAddress(param: SummarizeAddressParams) {
	const isOwnAddress = param.balanceSummary.summaryFor.type === 'addressInfo' || param.balanceSummary.summaryFor.address === param.simulationAndVisualisationResults.activeAddress
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
			/> :
			<SmallAddress
				textColor = { positiveNegativeColors.textColor }
				addressBookEntry = { param.balanceSummary.summaryFor }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		}

		<div class = 'content' style = 'margin-bottom: 0px;'>
			<EtherChange
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				etherResults =  { param.balanceSummary.etherResults }
				rpcNetwork = { param.simulationAndVisualisationResults.rpcNetwork }
			/>
			<Erc20BalanceChange
				erc20TokenBalanceChanges = { param.balanceSummary.erc20TokenBalanceChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				rpcNetwork = { param.simulationAndVisualisationResults.rpcNetwork }
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
			/>
			<Erc721or1155OperatorChanges
				erc721or1155OperatorChanges = { param.balanceSummary.erc721OperatorChanges }
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
			/>
			<Erc721or1155OperatorChanges
				erc721or1155OperatorChanges = { param.balanceSummary.erc1155OperatorChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		</div>
	</div>
}

export function removeEthDonator(rpcNetwork: RpcNetwork, summary: SummaryOutcome[]) {
	const donatorSummary = summary.find((x) => x.summaryFor.address === getEthDonator(rpcNetwork.chainId))
	if (donatorSummary === undefined || donatorSummary.etherResults === undefined) return
	if (donatorSummary.etherResults.balanceAfter + MAKE_YOU_RICH_TRANSACTION.transaction.value === donatorSummary.etherResults.balanceBefore) {
		if (donatorSummary.erc721OperatorChanges.length === 0 &&
			donatorSummary.erc721TokenBalanceChanges.length === 0 &&
			donatorSummary.erc721TokenIdApprovalChanges.length === 0 &&
			donatorSummary.erc20TokenApprovalChanges.length === 0 &&
			donatorSummary.erc20TokenBalanceChanges.length === 0 &&
			donatorSummary.erc1155OperatorChanges.length === 0 &&
			donatorSummary.erc1155TokenBalanceChanges.length === 0
		) {
			summary.splice(summary.indexOf(donatorSummary), 1)
			return
		}
		donatorSummary.etherResults = undefined
		return
	}
	donatorSummary.etherResults.balanceAfter = donatorSummary.etherResults.balanceAfter + MAKE_YOU_RICH_TRANSACTION.transaction.value
	return
}

type LogAnalysisCardParams = {
	simTx: SimulatedAndVisualizedTransaction
	renameAddressCallBack: RenameAddressCallBack,
}

export function LogAnalysisCard({ simTx, renameAddressCallBack }: LogAnalysisCardParams) {
	const [showLogs, setShowLogs] = useState<boolean>(false)
	const identifiedSwap = identifySwap(simTx)
	if (simTx === undefined) return <></>

	return <>
		<div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
			<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowLogs((prevValue) => !prevValue) }>
				<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
					{ simTx.tokenResults.length === 0 ? 'No token events' : `${ upperCaseFirstCharacter(convertNumberToCharacterRepresentationIfSmallEnough(simTx.tokenResults.length)) } token event${ simTx.tokenResults.length > 1 ? 's' : '' }` }
				</p>
				<div class = 'card-header-icon'>
					<span class = 'icon' style = 'color: var(--text-color); font-weight: unset; font-size: 0.8em;'> V </span>
				</div>
			</header>
			{ !showLogs
				? <></>
				: <div class = 'card-content' style = 'border-bottom-left-radius: 0.25rem; border-bottom-right-radius: 0.25rem; border-left: 2px solid var(--card-bg-color); border-right: 2px solid var(--card-bg-color); border-bottom: 2px solid var(--card-bg-color);'>
					<LogAnalysis
						simulatedAndVisualizedTransaction = { simTx }
						identifiedSwap = { identifiedSwap }
						renameAddressCallBack = { renameAddressCallBack }
					/>
				</div>
			}
		</div>
	</>
}

function splitToOwnAndNotOwnAndCleanSummary(firstTx: SimulatedAndVisualizedTransaction | undefined, summary: SummaryOutcome[], activeAddress: bigint, rpcNetwork: RpcNetwork) {
	//remove eth donator if we are in rich mode
	if (firstTx && identifyTransaction(firstTx).type === 'MakeYouRichTransaction') {
		removeEthDonator(rpcNetwork, summary)
	}

	const ownAddresses = Array.from(summary.entries()).filter( ([_index, balanceSummary]) =>
		balanceSummary.summaryFor.type === 'addressInfo' || balanceSummary.summaryFor.address === activeAddress
	)
	const notOwnAddresses = Array.from(summary.entries()).filter( ([_index, balanceSummary]) =>
		balanceSummary.summaryFor.type !== 'addressInfo' && balanceSummary.summaryFor.address !== activeAddress
	)
	return [ownAddresses, notOwnAddresses]
}

type AccountChangesCardParams = {
	simTx: SimulatedAndVisualizedTransaction
	simulationAndVisualisationResults: SimulationAndVisualisationResults
	renameAddressCallBack: RenameAddressCallBack
	addressMetaData: readonly AddressBookEntry[]
}

export function TransactionsAccountChangesCard({ simTx, renameAddressCallBack, addressMetaData, simulationAndVisualisationResults }: AccountChangesCardParams) {
	const logSummarizer = new LogSummarizer([simTx])
	const addressMetaDataMap = new Map(addressMetaData.map( (x) => [addressString(x.address), x]))
	const originalSummary = logSummarizer.getSummary(addressMetaDataMap, simulationAndVisualisationResults.tokenPrices)
	const [showSummary, setShowSummary] = useState<boolean>(false)
	const [ownAddresses, notOwnAddresses] = splitToOwnAndNotOwnAndCleanSummary(simTx, originalSummary, simulationAndVisualisationResults.activeAddress, simulationAndVisualisationResults.rpcNetwork)
	const numberOfChanges = notOwnAddresses.length + ownAddresses.length

	return <div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
		<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowSummary((prevValue) => !prevValue) }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
				{ numberOfChanges === 0 ? 'No changes in accounts' : `${  upperCaseFirstCharacter(convertNumberToCharacterRepresentationIfSmallEnough(numberOfChanges)) } account${ numberOfChanges > 1 ? 's' : '' } changing` }
			</p>
			<div class = 'card-header-icon'>
				<span class = 'icon' style = 'color: var(--text-color); font-weight: unset; font-size: 0.8em;'> V </span>
			</div>
		</header>
		{ !showSummary
			? <></>
			: <div class = 'card-content'>
				<div class = 'container' style = 'margin-bottom: 10px;'>
					{ ownAddresses.length == 0 ? <p class = 'paragraph'> No changes to your accounts </p>
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

				{ notOwnAddresses.length == 0
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
			<p class = 'ellipsis' style = { `color: var(--subtitle-text-color); margin-bottom: 0px` }> Gas fee:&nbsp;</p>
		</div>
		<div class = 'log-cell'>
			<EtherAmount
				amount = { tx.gasSpent * tx.realizedGasPrice  }
				textColor = { 'var(--subtitle-text-color)' }
			/>
		</div>
		<div class = 'log-cell'>
			<EtherSymbol
				textColor = { 'var(--subtitle-text-color)' }
				rpcNetwork = { rpcNetwork }
			/>
		</div>
	</>
}

type TransactionHeaderParams = {
	simTx: SimulatedAndVisualizedTransaction
	removeTransaction?: () => void
}

export function TransactionHeader({ simTx, removeTransaction } : TransactionHeaderParams) {
	return <header class = 'card-header'>
		<div class = 'card-header-icon unset-cursor'>
			<span class = 'icon'>
				<img src = { simTx.statusCode === 'success' ? ( simTx.quarantine ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
			</span>
		</div>
		<p class = 'card-header-title' style = 'white-space: nowrap;'>
			{ identifyTransaction(simTx).title }
		</p>
		{ simTx.transaction.to  === undefined || identifyTransaction(simTx).type === 'MakeYouRichTransaction'
			? <></>
			: <p class = 'card-header-icon unsetcursor' style = { `margin-left: auto; margin-right: 0; overflow: hidden; ${ removeTransaction !== undefined ? 'padding: 0' : ''}` }>
				<WebsiteOriginText { ...simTx.website } />
			</p>
		}
		{ removeTransaction !== undefined
			? <button class = 'card-header-icon' aria-label = 'remove' onClick = { removeTransaction }>
				<span class = 'icon' style = 'color: var(--text-color);'> X </span>
			</button>
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

export function TransactionCreated({ transactionCreated } : { transactionCreated: EthereumTimestamp }) {
	return <p style = 'color: var(--subtitle-text-color); text-align: right; display: inline'>
		{ 'Created ' }
		<SomeTimeAgo priorTimestamp = { transactionCreated } diffToText = { humanReadableDateDeltaLessDetailed }/>
	</p>
}

export function SimulatedInBlockNumber({ simulationBlockNumber, currentBlockNumber, simulationConductedTimestamp, rpcConnectionStatus } : { simulationBlockNumber: bigint, currentBlockNumber: bigint | undefined, simulationConductedTimestamp: Date, rpcConnectionStatus: RpcConnectionStatus }) {
	return <CopyToClipboard
		content = { simulationBlockNumber.toString() }
		contentDisplayOverride = { `Simulated in block number ${ simulationBlockNumber }` }
		copyMessage = 'Block number copied!'
	>
		<p style = 'color: var(--subtitle-text-color); text-align: right; display: inline'>
			{ 'Simulated ' }
			<span style = { `font-weight: bold; font-family: monospace; color: ${
				(simulationBlockNumber === currentBlockNumber || currentBlockNumber === undefined) && (rpcConnectionStatus === undefined || rpcConnectionStatus.isConnected) ? 'var(--positive-color)' :
				simulationBlockNumber + 1n === currentBlockNumber ? 'var(--warning-color)' : 'var(--negative-color)'
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
	rpcConnectionStatus: RpcConnectionStatus,
}

export function SimulationSummary(param: SimulationSummaryParams) {
	if (param.simulationAndVisualisationResults === undefined) return <></>

	const logSummarizer = new LogSummarizer(param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions)
	const addressMetaData = new Map(param.simulationAndVisualisationResults.addressMetaData.map((x) => [addressString(x.address), x]))
	const originalSummary = logSummarizer.getSummary(addressMetaData, param.simulationAndVisualisationResults.tokenPrices)
	const [ownAddresses, notOwnAddresses] = splitToOwnAndNotOwnAndCleanSummary(param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(0), originalSummary, param.simulationAndVisualisationResults.activeAddress, param.simulationAndVisualisationResults.rpcNetwork)

	const [showOtherAccountChanges, setShowOtherAccountChange] = useState<boolean>(false)

	return (
		<div class = 'card' style = 'background-color: var(--card-bg-color); margin: 10px;'>
			<header class = 'card-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = { param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.find((x) => x.statusCode !== 'success') === undefined ? ( param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.find( (x) => x.quarantine ) !== undefined ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
					</span>
				</div>
				<div class = 'card-header-title'>
					<p className = 'paragraph'> Simulation Outcome </p>
				</div>
			</header>
			<div class = 'card-content'>
				<div class = 'container' style = 'margin-bottom: 10px'>
					{ ownAddresses.length == 0 ?<p class = 'paragraph'> No changes to your accounts </p>
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
							<span class = 'icon' style = 'color: var(--text-color); font-weight: unset; font-size: 0.8em;'> V </span>
						</div>
					</header>
					{ !showOtherAccountChanges
						? <></>
						: <div class = 'card-content'>
							<div class = 'container'>
								{ notOwnAddresses.length == 0 ? <p class = 'paragraph'>No changes to other accounts</p> : notOwnAddresses.map( ([_index, balanceSummary]) => (<>
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
				
				<span style = 'color: var(--subtitle-text-color); line-height: 28px; display: flex; margin: 0 0 0 auto; width: fit-content; margin-top: 10px'>
					<SimulatedInBlockNumber
						simulationBlockNumber = { param.simulationAndVisualisationResults.blockNumber }
						currentBlockNumber = { param.currentBlockNumber }
						simulationConductedTimestamp = { param.simulationAndVisualisationResults.simulationConductedTimestamp }
						rpcConnectionStatus = { param.rpcConnectionStatus }
					/>
				</span>
			</div>
		</div>
	)
}

type RawTransactionDetailsCardParams = {
	transaction: TransactionWithAddressBookEntries
	renameAddressCallBack: RenameAddressCallBack
	gasSpent: bigint
}
export function RawTransactionDetailsCard({ transaction, renameAddressCallBack, gasSpent }: RawTransactionDetailsCardParams) {
	const [showSummary, setShowSummary] = useState<boolean>(false)

	return <div class = 'card' style = 'margin-top: 10px; margin-bottom: 10px'>
		<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowSummary((prevValue) => !prevValue) }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
				Raw transaction information
			</p>
			<div class = 'card-header-icon'>
				<span class = 'icon' style = 'color: var(--text-color); font-weight: unset; font-size: 0.8em;'> V </span>
			</div>
		</header>
		{ !showSummary
			? <></>
			: <div class = 'card-content'>
				<div class = 'container' style = 'margin-bottom: 10px;'>
					<span class = 'log-table' style = 'justify-content: center; column-gap: 5px; row-gap: 5px; grid-template-columns: auto auto'>
						<CellElement text = 'Transaction type: '/>
						<CellElement text =  { transaction.type }/>
						<CellElement text = 'From: '/>
						<CellElement text = { <SmallAddress addressBookEntry = { transaction.from } renameAddressCallBack = { renameAddressCallBack } textColor = { 'var(--subtitle-text-color)' } /> } />
						<CellElement text = 'To: '/>
						<CellElement text = { transaction.to === undefined ? 'No receiving Address' : <SmallAddress addressBookEntry = { transaction.to } renameAddressCallBack = { renameAddressCallBack } textColor = { 'var(--subtitle-text-color)' }/> } />
						<CellElement text = 'Value: '/>
						<CellElement text = { <Ether amount = { transaction.value } useFullTokenName = { true } rpcNetwork = { transaction.rpcNetwork } textColor = { 'var(--subtitle-text-color)' }/> } />
						<CellElement text = 'Gas used: '/>
						<CellElement text = { `${ gasSpent.toString(10) } gas (${ Number(gasSpent * 10000n / transaction.gas) / 100 }%)` }/>
						<CellElement text = 'Gas limit: '/>
						<CellElement text = { `${ transaction.gas.toString(10) } gas` }/>
						<CellElement text = 'Nonce: '/>
						<CellElement text = { transaction.nonce.toString(10) }/>
						<CellElement text = 'Chain: '/>
						<CellElement text = { transaction.rpcNetwork.name }/>
						<CellElement text = 'Unsigned transaction hash: '/>
						<CellElement text = { bytes32String(transaction.hash) }/>
						

						{ transaction.type !== '1559'
							? <></>
							: <>
								<CellElement text = 'Max Fee Per Gas: '/>
								<CellElement text = { `${ nanoString(transaction.maxFeePerGas) } nanoeth/gas` }/>
								<CellElement text = 'Max Priority Fee Per Gas: '/>
								<CellElement text = { `${ nanoString(transaction.maxPriorityFeePerGas) } nanoeth/gas` }/>
							</>
						}
					</span>

					<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>Raw transaction input: </p>

					<div class = 'textbox'>
						<p class = 'paragraph' style = 'color: var(--subtitle-text-color)'>{ dataStringWith0xStart(transaction.input) }</p>
					</div>
				</div>
			</div>
		}
	</div>
}
