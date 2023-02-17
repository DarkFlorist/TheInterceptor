import { LogSummarizer, SummaryOutcome } from '../../simulation/services/LogSummarizer.js'
import { AddressBookEntry, CHAIN, RenameAddressCallBack, SimulationStateParam } from '../../utils/user-interface-types.js'
import { ERC721TokenApprovalChange, ERC721TokenDefinitionParams, SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, TokenApprovalChange, TokenBalanceChange, TokenDefinitionParams } from '../../utils/visualizer-types.js'
import { BigAddress, SmallAddress } from '../subcomponents/address.js'
import { ERC721Token, Ether, EtherAmount, EtherSymbol, Token, TokenAmount, TokenPrice, TokenSymbol } from '../subcomponents/coins.js'
import { LogAnalysis, TransactionImportanceBlock, Transactions } from './Transactions.js'
import { CopyToClipboard } from '../subcomponents/CopyToClipboard.js'
import { SomeTimeAgo } from '../subcomponents/SomeTimeAgo.js'
import { CHAINS, MAKE_YOU_RICH_TRANSACTION } from '../../utils/constants.js'
import { addressString } from '../../utils/bigint.js'
import { identifyTransaction, nameTransaction } from './identifyTransaction.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { identifySwap } from './SwapTransactions.js'
import { useState } from 'preact/hooks'

type EtherChangeParams = {
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	etherResults: {
		balanceBefore: bigint;
		balanceAfter: bigint;
	} | undefined,
	chain: CHAIN,
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
				chain = { param.chain }
			/>
		</div>
	</div>
}

type Erc20BalanceChangeParams = {
	tokenBalanceChanges: TokenBalanceChange[]
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	chain: CHAIN,
}

function Erc20BalanceChange(param: Erc20BalanceChangeParams) {
	if ( param.tokenBalanceChanges.length === 0 ) return <></>
	return <>
		{ Array.from(param.tokenBalanceChanges).map((tokenBalanceChange) => (
			<div class = 'vertical-center' style = 'display: flex'>
				<div class = { param.isImportant ? `box token-box ${ tokenBalanceChange.changeAmount < 0n ? 'negative-box' : 'positive-box' }`: '' } style = 'display: flex' >
					<Token
						{ ...tokenBalanceChange }
						amount = { tokenBalanceChange.changeAmount }
						showSign = { true }
						textColor = { tokenBalanceChange.changeAmount > 0n ? param.textColor : param.negativeColor }
						useFullTokenName = { true }
					/>
					<TokenPrice
						amount = { tokenBalanceChange.changeAmount }
						tokenPriceEstimate = { tokenBalanceChange.tokenPriceEstimate }
						textColor = { tokenBalanceChange.changeAmount > 0n ? param.textColor : param.negativeColor }
						chain = { param.chain }
					/>
				</div>
			</div>
		))}
	</>
}

type Erc20ApprovalChangeParams = TokenDefinitionParams & {
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
	tokenApprovalChanges: TokenApprovalChange[]
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	renameAddressCallBack: RenameAddressCallBack,
}

export function Erc20ApprovalChanges(param: Erc20ApprovalChangesParams ) {
	if ( param.tokenApprovalChanges.length === 0 ) return <></>
	return <>
		{ param.tokenApprovalChanges.map( (token) => (
			token.approvals.map( (entryToApprove) => (
				<Erc20ApprovalChange { ...{
					...token,
					entryToApprove: entryToApprove,
					change: entryToApprove.change,
					tokenAddress: token.tokenAddress,
					textColor: param.textColor,
					negativeColor: param.negativeColor,
					isImportant: param.isImportant,
					renameAddressCallBack: param.renameAddressCallBack,
				} } />
			))
		)) }
	</>
}

export type ERC721TokenBalanceChange = (ERC721TokenDefinitionParams & { received: boolean })

type ERC721TokenChangesParams = {
	ERC721TokenBalanceChanges: ERC721TokenBalanceChange[],
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
}

function ERC721TokenChanges(param: ERC721TokenChangesParams ) {
	if ( param.ERC721TokenBalanceChanges.length == 0 ) return <></>

	return <>
		{ param.ERC721TokenBalanceChanges.map( (tokenChange) => (
			<div class = 'vertical-center' style = 'display: flex'>
				<div class = { param.isImportant ? `box token-box ${ !tokenChange.received ? 'negative-box' : 'positive-box' }`: '' } style = 'display: flex'>
					<ERC721Token
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

export type ERC721OperatorChange = Omit<ERC721TokenDefinitionParams, 'tokenId'> & { operator: AddressBookEntry | undefined }

type ERC721OperatorChangesParams = {
	ERC721OperatorChanges: ERC721OperatorChange[]
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	renameAddressCallBack: RenameAddressCallBack,
}

export function ERC721OperatorChanges(param: ERC721OperatorChangesParams) {
	if (param.ERC721OperatorChanges.length === 0) return <></>
	return <>
		{ param.ERC721OperatorChanges.map((token) => (
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

type ERC721TokenIdApprovalChangesParams = {
	ERC721TokenIdApprovalChanges: ERC721TokenApprovalChange[]
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	renameAddressCallBack: RenameAddressCallBack,
}

export function ERC721TokenIdApprovalChanges(param: ERC721TokenIdApprovalChangesParams ) {
	return <> { param.ERC721TokenIdApprovalChanges.length > 0 ?
		<>
			{ param.ERC721TokenIdApprovalChanges.map( (approvalsChange) => (
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
								<ERC721Token
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

type SummarizeAddressParams = {
	balanceSummary: SummaryOutcome,
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	renameAddressCallBack: RenameAddressCallBack,
}

export function SummarizeAddress(param: SummarizeAddressParams) {
	const isOwnAddress = param.balanceSummary.summaryFor.type === 'addressInfo' || param.balanceSummary.summaryFor.address === param.simulationAndVisualisationResults.activeAddress
	const positiveNegativeColors = isOwnAddress ? {
		textColor: 'var(--text-color)',
		negativeColor: 'var(--text-color)'
	} : {
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
				chain = { param.simulationAndVisualisationResults.chain }
			/>
			<Erc20BalanceChange
				tokenBalanceChanges = { param.balanceSummary.tokenBalanceChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				chain = { param.simulationAndVisualisationResults.chain }
			/>
			<Erc20ApprovalChanges
				tokenApprovalChanges = { param.balanceSummary.tokenApprovalChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
			<ERC721TokenChanges
				ERC721TokenBalanceChanges = { param.balanceSummary.erc721TokenBalanceChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
			/>
			<ERC721OperatorChanges
				ERC721OperatorChanges = { param.balanceSummary.erc721OperatorChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
			<ERC721TokenIdApprovalChanges
				ERC721TokenIdApprovalChanges = { param.balanceSummary.erc721TokenIdApprovalChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				renameAddressCallBack = { param.renameAddressCallBack }
			/>
		</div>
	</div>
}

export function SummarizeChangesForAddress(param: SummarizeAddressParams) {
	const isOwnAddress = param.balanceSummary.summaryFor.type === 'addressInfo' || param.balanceSummary.summaryFor.address === param.simulationAndVisualisationResults.activeAddress
	const positiveNegativeColors = isOwnAddress ? {
		textColor: 'var(--text-color)',
		negativeColor: 'var(--text-color)'
	} : {
		textColor: 'var(--disabled-text-color)',
		negativeColor: 'var(--negative-dim-color)'
	}

	return <div class = 'content' style = 'margin-bottom: 0px;'>
		<EtherChange
			textColor = { positiveNegativeColors.textColor }
			negativeColor = { positiveNegativeColors.negativeColor }
			isImportant = { isOwnAddress }
			etherResults =  { param.balanceSummary.etherResults }
			chain = { param.simulationAndVisualisationResults.chain }
		/>
		<Erc20BalanceChange
			tokenBalanceChanges = { param.balanceSummary.tokenBalanceChanges }
			textColor = { positiveNegativeColors.textColor }
			negativeColor = { positiveNegativeColors.negativeColor }
			isImportant = { isOwnAddress }
			chain = { param.simulationAndVisualisationResults.chain }
		/>
		<Erc20ApprovalChanges
			tokenApprovalChanges = { param.balanceSummary.tokenApprovalChanges }
			textColor = { positiveNegativeColors.textColor }
			negativeColor = { positiveNegativeColors.negativeColor }
			isImportant = { isOwnAddress }
			renameAddressCallBack = { param.renameAddressCallBack }
		/>
		<ERC721TokenChanges
			ERC721TokenBalanceChanges = { param.balanceSummary.erc721TokenBalanceChanges }
			textColor = { positiveNegativeColors.textColor }
			negativeColor = { positiveNegativeColors.negativeColor }
			isImportant = { isOwnAddress }
		/>
		<ERC721OperatorChanges
			ERC721OperatorChanges = { param.balanceSummary.erc721OperatorChanges }
			textColor = { positiveNegativeColors.textColor }
			negativeColor = { positiveNegativeColors.negativeColor }
			isImportant = { isOwnAddress }
			renameAddressCallBack = { param.renameAddressCallBack }
		/>
		<ERC721TokenIdApprovalChanges
			ERC721TokenIdApprovalChanges = { param.balanceSummary.erc721TokenIdApprovalChanges }
			textColor = { positiveNegativeColors.textColor }
			negativeColor = { positiveNegativeColors.negativeColor }
			isImportant = { isOwnAddress }
			renameAddressCallBack = { param.renameAddressCallBack }
		/>
	</div>
}

export function SimulationResults(param: SimulationStateParam) {
	if ( param.simulationAndVisualisationResults === undefined ) return <></>
	if (param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length === 0) {
		return <div class = 'vertical-center'>
			<img style = 'padding-right: 10px; transform: scaleX(-1);' src = '../img/LOGOA.svg' width = '32'/>
			<span class = 'paragraph' style = 'padding-left: 0.2em'> - Give me some transactions to munch on! </span>
		</div>
	}
	return <div>
		<p className = 'h1' style = 'padding-left: 10px'> Simulation Results </p>
		<Transactions
			simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
			removeTransaction = { param.removeTransaction }
			activeAddress = { param.simulationAndVisualisationResults.activeAddress }
			renameAddressCallBack = { param.renameAddressCallBack }
		/>
		<SimulationSummary
			simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
			resetButton = { true }
			refreshSimulation =  { param.refreshSimulation }
			currentBlockNumber = { param.currentBlockNumber }
			renameAddressCallBack = { param.renameAddressCallBack }
			refreshPressed = { param.refreshPressed }
		/>
		<div class = 'content' style = 'height: 0.1px'/>
	</div>
}

export function removeEthDonator(chain: CHAIN, summary: SummaryOutcome[]) {
	const donatorAddress = addressString(CHAINS[chain].eth_donator)
	const donatorSummary = summary.find((x) => addressString(x.summaryFor.address) === donatorAddress)
	if (donatorSummary === undefined) return summary
	if (donatorSummary.etherResults === undefined) return summary
	if (donatorSummary.etherResults.balanceAfter + MAKE_YOU_RICH_TRANSACTION.value === donatorSummary.etherResults.balanceBefore ) {
		if (donatorSummary.erc721OperatorChanges.length === 0 &&
			donatorSummary.erc721TokenBalanceChanges.length === 0 &&
			donatorSummary.erc721TokenIdApprovalChanges.length === 0 &&
			donatorSummary.tokenApprovalChanges.length === 0 &&
			donatorSummary.tokenBalanceChanges.length === 0
		) {
			summary.splice(summary.indexOf(donatorSummary))
			return summary
		}
		donatorSummary.etherResults = undefined
		return summary
	}
	donatorSummary.etherResults.balanceAfter = donatorSummary.etherResults.balanceAfter + MAKE_YOU_RICH_TRANSACTION.value
	return summary
}

type WebsiteOriginAndIcon = {
	websiteOrigin: string,
	websiteIcon: string | undefined,
}

type LogAnalysisCardParams = {
	tx: SimulatedAndVisualizedTransaction
	renameAddressCallBack: RenameAddressCallBack,
}

export function LogAnalysisCard({ tx, renameAddressCallBack }: LogAnalysisCardParams) {
	const [showLogs, setShowLogs] = useState<boolean>(false)
	const identifiedSwap = identifySwap(tx)
	if (tx === undefined) return <></>

	return <>
		<div class = 'card' style = 'margin-top: 10px;'>
			<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowLogs((prevValue) => !prevValue) }>
				<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
					{ tx.tokenResults.length === 0 ? 'No token events' : `${ tx.tokenResults.length } token event${ tx.tokenResults.length > 1 ? 's' : '' }` }
				</p>
				<div class = 'card-header-icon'>
					<span class = 'icon' style = 'color: var(--text-color); font-weight: unset; font-size: 0.8em;'> V </span>
				</div>
			</header>
			{ !showLogs ? <></> : <>
				<div class = 'card-content' style = 'border-bottom-left-radius: 0.25rem; border-bottom-right-radius: 0.25rem; border-left: 2px solid var(--card-bg-color); border-right: 2px solid var(--card-bg-color); border-bottom: 2px solid var(--card-bg-color);'>
					<LogAnalysis
						simulatedAndVisualizedTransaction = { tx }
						identifiedSwap = { identifiedSwap }
						renameAddressCallBack = { renameAddressCallBack }
					/>
				</div>
			</> }
		</div>
	</>
}

type AccountChangesCardParams = {
	tx: SimulatedAndVisualizedTransaction
	simulationAndVisualisationResults: SimulationAndVisualisationResults
	renameAddressCallBack: RenameAddressCallBack
	addressMetaData: readonly AddressBookEntry[]
}

export function TransactionsAccountChangesCard({ tx, renameAddressCallBack, addressMetaData, simulationAndVisualisationResults }: AccountChangesCardParams) {
	const logSummarizer = new LogSummarizer( [tx] )
	const addressMetaDataMap = new Map(addressMetaData.map( (x) => [addressString(x.address), x]))
	const originalSummary = logSummarizer.getSummary(addressMetaDataMap, simulationAndVisualisationResults.tokenPrices)
	//remove eth donator if we are in rich mode
	const summary = identifyTransaction(tx, simulationAndVisualisationResults.activeAddress) === 'MakeYouRichTransaction' ?
		removeEthDonator(simulationAndVisualisationResults.chain, originalSummary)
		: originalSummary

	const ownAddresses = Array.from(summary.entries()).filter( ([_index, balanceSummary]) =>
		balanceSummary.summaryFor.type === 'addressInfo' || balanceSummary.summaryFor.address === simulationAndVisualisationResults.activeAddress
	)
	const notOwnAddresses = Array.from(summary.entries()).filter( ([_index, balanceSummary]) => balanceSummary.summaryFor.type !== 'addressInfo' && balanceSummary.summaryFor.address !== simulationAndVisualisationResults.activeAddress)


	const [showSummary, setShowSumary] = useState<boolean>(false)

	return <div class = 'card'>
		<header class = 'card-header noselect' style = 'cursor: pointer; height: 30px;' onClick = { () => setShowSumary((prevValue) => !prevValue) }>
			<p class = 'card-header-title' style = 'font-weight: unset; font-size: 0.8em;'>
				{ summary.length === 0 ? 'No visible changes' : `${ summary.length } account${ summary.length > 1 ? 's' : '' } changing` }
			</p>
			<div class = 'card-header-icon'>
				<span class = 'icon' style = 'color: var(--text-color); font-weight: unset; font-size: 0.8em;'> V </span>
			</div>
		</header>
		{ !showSummary ? <></> : <>
			<div class = 'card-content'>
				<div class = 'container'>
					{ ownAddresses.length == 0 ? <p class = 'paragraph'> No changes to your accounts </p>
						: <div class = 'notification' style = 'background-color: var(--unimportant-text-color); padding: 10px; margin-bottom: 10px; color: var(--text-color)'>
							{ ownAddresses.map( ([_index, balanceSummary], index) => {
								return <>
									<SummarizeAddress
										balanceSummary = { balanceSummary }
										simulationAndVisualisationResults = { simulationAndVisualisationResults }
										renameAddressCallBack = { renameAddressCallBack }
									/>
									{ index + 1 !== ownAddresses.length ? <div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/> : <></> }
								</>
							} ) }
						</div>
					}
				</div>

				<div class = 'container'>
					{ notOwnAddresses.length == 0 ? <></>
						: notOwnAddresses.map( ([_index, balanceSummary]) => {
							return <>
								<SummarizeAddress
									balanceSummary = { balanceSummary }
									simulationAndVisualisationResults = { simulationAndVisualisationResults }
									renameAddressCallBack = { renameAddressCallBack }
								/>
								<div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/>
							</>
						})
					}
				</div>
			</div>
		</> }
	</div>
}

export function GasFee({ tx, chain }: { tx: SimulatedAndVisualizedTransaction, chain: CHAIN } ) {
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
				amount = { tx.gasSpent * tx.realizedGasPrice  }
				textColor = { 'var(--subtitle-text-color)' }
				chain = { chain }
			/>
		</div>
	</>
}

type TransactionHeaderParams = {
	tx: SimulatedAndVisualizedTransaction
	renameAddressCallBack: RenameAddressCallBack
	activeAddress: bigint
	removeTransaction?: () => void
}

export function TransactionHeader( {tx, renameAddressCallBack, activeAddress, removeTransaction } : TransactionHeaderParams) {
	return <header class = 'card-header' style = 'height: 40px;'>
		<div class = 'card-header-icon unset-cursor'>
			<span class = 'icon'>
				<img src = { tx.statusCode === 'success' ? ( tx.quarantine ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
			</span>
		</div>

		<p class = 'card-header-title' style = 'white-space: nowrap;'>
			{ nameTransaction(tx, activeAddress) }
		</p>
		{ tx.to  === undefined ? <></> :
			<p class = 'card-header-icon' style = 'margin-left: auto; margin-right: 0; padding-right: 10px; padding-left: 0px;'>
				<SmallAddress
					addressBookEntry = { tx.to }
					renameAddressCallBack = { renameAddressCallBack }
					style = { { 'background-color': 'unset' } }
				/>
			</p>
		}
		{ removeTransaction !== undefined ?
			<button class = 'card-header-icon' aria-label = 'remove' onClick = { removeTransaction }>
				<span class = 'icon' style = 'color: var(--text-color);'> X </span>
			</button>
		: <></> }
	</header>
}

type NewStyleTransactionCardParams = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults & WebsiteOriginAndIcon,
	renameAddressCallBack: (entry: AddressBookEntry) => void,
	activeAddress: bigint,
	resetButton: boolean,
	refreshSimulation: () => void,
	currentBlockNumber: bigint | undefined,
	refreshPressed: boolean,
}

export function NewStyleTransactionCard(param: NewStyleTransactionCardParams) {
	const tx = param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(-1)
	if (tx === undefined) return <></>

	return <>
		<div class = 'block' style = 'margin: 10px; margin-top: 10px; margin-bottom: 10px;'>
			<nav class = 'breadcrumb has-succeeds-separator is-small'>
				<ul>
					{ param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.map((tx, index) => (
						<li style = 'margin: 0px;'>
							<div class = 'card' style = { `padding: 5px;${ index !== param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ? 'background-color: var(--disabled-card-color)' : ''}` }>
								<p class = 'paragraph' style = {`margin: 0px;${ index !== param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1 ? 'color: var(--disabled-text-color)' : ''}` }>
									{ nameTransaction(tx, param.activeAddress) }
								</p>
							</div>
						</li>
					)) }
				</ul>
			</nav>
		</div>

		<div class = 'card' style = 'margin: 10px; margin-top: 0px; margin-bottom: 0px;'>
			<TransactionHeader
				tx = { tx }
				renameAddressCallBack =  {param.renameAddressCallBack }
				activeAddress = { param.activeAddress }
			/>
			<div class = 'card-content'>
				<div class = 'container'>
					<TransactionImportanceBlock
						tx = { tx }
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						renameAddressCallBack = { param.renameAddressCallBack }
					/>
				</div>

				<TransactionsAccountChangesCard
					tx = { tx }
					simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
					renameAddressCallBack = { param.renameAddressCallBack }
					addressMetaData = { param.simulationAndVisualisationResults.addressMetaData }
				/>

				<LogAnalysisCard
					tx = { tx }
					renameAddressCallBack = { param.renameAddressCallBack }
				/>

				<span class = 'log-table' style = 'margin-top: 10px; grid-template-columns: min-content min-content min-content auto;'>
					<GasFee
						tx = { tx }
						chain = { param.simulationAndVisualisationResults.chain }
					/>
					<div class = 'log-cell' style = 'justify-content: right;'>
						<CopyToClipboard
							content = { param.simulationAndVisualisationResults.blockNumber.toString() }
							contentDisplayOverride = { `Simulated in block number ${ param.simulationAndVisualisationResults.blockNumber }` }
							copyMessage = 'Block number copied!'
						>
							<p class = 'noselect nopointer' style = 'color: var(--subtitle-text-color);'>
								{ 'Simulated ' }
								<span style = { `font-weight: bold; font-family: monospace; color: ${
									param.simulationAndVisualisationResults.blockNumber === param.currentBlockNumber || param.currentBlockNumber === undefined ? 'var(--positive-color)' :
									param.simulationAndVisualisationResults.blockNumber + 1n === param.currentBlockNumber ? 'var(--warning-color)' : 'var(--negative-color)'
								} ` }>
									<SomeTimeAgo priorTimestamp = { param.simulationAndVisualisationResults.simulationConductedTimestamp }/>
								</span>
								{ ' ago' }
							</p>
						</CopyToClipboard>
					</div>
				</span>
			</div>
		</div>
	</>
}

type SimulationSummaryParams = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	summarizeOnlyLastTransaction?: boolean,
	resetButton: boolean,
	refreshSimulation: () => void,
	currentBlockNumber: bigint | undefined,
	renameAddressCallBack: RenameAddressCallBack,
	refreshPressed: boolean,
}

export function SimulationSummary(param: SimulationSummaryParams) {
	if (param.simulationAndVisualisationResults === undefined) return <></>

	const VisResults = param.summarizeOnlyLastTransaction && param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length > 0 ?
		[param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(-1)] :
		param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions

	const logSummarizer = new LogSummarizer( VisResults )
	const addressMetaData = new Map(param.simulationAndVisualisationResults.addressMetaData.map( (x) => [addressString(x.address), x]))
	const originalSummary = logSummarizer.getSummary(addressMetaData, param.simulationAndVisualisationResults.tokenPrices)
	//remove eth donator if we are in rich mode
	const firstTransaction = param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(0)
	const summary = firstTransaction && identifyTransaction(firstTransaction, param.simulationAndVisualisationResults.activeAddress) === 'MakeYouRichTransaction' ?
		removeEthDonator(param.simulationAndVisualisationResults.chain, originalSummary)
		: originalSummary

	const ownAddresses = Array.from(summary.entries()).filter( ([_index, balanceSummary]) =>
		balanceSummary.summaryFor.type === 'addressInfo' || balanceSummary.summaryFor.address === param.simulationAndVisualisationResults.activeAddress
	)
	const notOwnAddresses = Array.from(summary.entries()).filter( ([_index, balanceSummary]) => balanceSummary.summaryFor.type !== 'addressInfo' && balanceSummary.summaryFor.address !== param.simulationAndVisualisationResults.activeAddress)

	function resetSimulation() {
		sendPopupMessageToBackgroundPage( { method: 'popup_resetSimulation' } )
	}

	return (
		<div className = 'block' style = 'margin-bottom: 0px'>
			<div style = 'margin: 10px;'>
				<div class = 'block' style = 'background-color: var(--card-bg-color)'>
					<header class = 'card-header'>
						<div class = 'card-header-icon unset-cursor'>
							<span class = 'icon'>
								{ param.summarizeOnlyLastTransaction ?
									<img src = { param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions[param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1].statusCode === 'success' ? ( param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions[param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1].quarantine === true ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } /> :
									<img src = { param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.find( (x) => x.statusCode !== 'success') === undefined ? ( param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.find( (x) => x.quarantine ) !== undefined ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
								}
							</span>
						</div>
						<p class = 'card-header-title'>
							<p className = 'paragraph'> { param.summarizeOnlyLastTransaction ? 'Transaction Outcome' : 'Simulation Outcome' } </p>
						</p>
					</header>
					<div class = 'card-content'>
						<div class = 'container'>
							{ ownAddresses.length == 0 ? <p class = 'paragraph'> No changes to your accounts </p>
								: <div class = 'notification' style = 'background-color: var(--unimportant-text-color); padding: 10px; margin-bottom: 10px; color: var(--text-color)'>
									{ ownAddresses.map( ([_index, balanceSummary], index) => {
										return <>
											<SummarizeAddress
												balanceSummary = { balanceSummary }
												simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
												renameAddressCallBack = { param.renameAddressCallBack }
											/>
											{ index + 1 !== ownAddresses.length ? <div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/> : <></> }
										</>
									} ) }
								</div>
							}
						</div>
						<div class = 'container'>
							{ notOwnAddresses.length == 0 ? <></>
								: notOwnAddresses.map( ([_index, balanceSummary]) => {
									return <>
										<SummarizeAddress
											balanceSummary = { balanceSummary }
											simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
											renameAddressCallBack = { param.renameAddressCallBack }
										/>
										<div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/>
									</>
								})
							}
						</div>
							<p style = 'color: var(--subtitle-text-color); line-height: 28px; display: flex; margin: 0 0 0 auto; width: fit-content;'>
								<CopyToClipboard
									content = { param.simulationAndVisualisationResults.blockNumber.toString() }
									contentDisplayOverride = { `Simulated in block number ${ param.simulationAndVisualisationResults.blockNumber }` }
									copyMessage = 'Block number copied!'
								>
									<p class = 'noselect nopointer' style = 'color: var(--subtitle-text-color); text-align: right; display: inline'>
										{ 'Simulated ' }
										<span style = { `font-weight: bold; font-family: monospace; color: ${
											param.simulationAndVisualisationResults.blockNumber === param.currentBlockNumber || param.currentBlockNumber === undefined ? 'var(--positive-color)' :
											param.simulationAndVisualisationResults.blockNumber + 1n === param.currentBlockNumber ? 'var(--warning-color)' : 'var(--negative-color)'
										} ` }>
											<SomeTimeAgo priorTimestamp = { param.simulationAndVisualisationResults.simulationConductedTimestamp }/>
										</span>
										{ ' ago' }
									</p>
								</CopyToClipboard>
								<button class = 'button is-primary is-small' disabled = { param.refreshPressed || param.simulationAndVisualisationResults.blockNumber === param.currentBlockNumber || param.currentBlockNumber === undefined}  style = 'margin-left: 5px;' onClick = { param.refreshSimulation } >
									<span class = 'icon'>
										<img src = '../../img/refresh.svg'/>
									</span>
									<span>
										Refresh
									</span>
								</button>
								{ param.resetButton ?
									<button className = 'button is-primary is-small' style = 'margin-left: 5px; background-color: var(--negative-color);' onClick = { resetSimulation } >
										<span class = 'icon'>
											<img src = '../../img/broom.svg'/>
										</span>
										<span>
											Reset
										</span>
									</button>
									: <></>
								}
							</p>
					</div>
				</div>
			</div>
		</div>
	)
}
