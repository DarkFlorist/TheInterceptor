import { LogSummarizer, SummaryOutcome } from '../../simulation/services/LogSummarizer.js'
import { AddressBookEntry, CHAIN, RenameAddressCallBack } from '../../utils/user-interface-types.js'
import { ERC721TokenApprovalChange, ERC721TokenDefinitionParams, SimulatedAndVisualizedTransaction, SimulationAndVisualisationResults, TokenApprovalChange, TokenBalanceChange, TokenDefinitionParams } from '../../utils/visualizer-types.js'
import { BigAddress, SmallAddress } from '../subcomponents/address.js'
import { ERC721Token, Ether, EtherAmount, EtherSymbol, Token, TokenAmount, TokenPrice, TokenSymbol } from '../subcomponents/coins.js'
import { LogAnalysis } from './Transactions.js'
import { CopyToClipboard } from '../subcomponents/CopyToClipboard.js'
import { SomeTimeAgo } from '../subcomponents/SomeTimeAgo.js'
import { CHAINS, MAKE_YOU_RICH_TRANSACTION } from '../../utils/constants.js'
import { addressString } from '../../utils/bigint.js'
import { identifyTransaction } from './identifyTransaction.js'
import { sendPopupMessageToBackgroundPage } from '../../background/backgroundUtils.js'
import { identifySwap } from './SwapTransactions.js'
import { useState } from 'preact/hooks'
import { convertNumberToCharacterRepresentationIfSmallEnough, upperCaseFirstCharacter } from '../ui-utils.js'

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

export type ERC721OperatorChange = Omit<ERC721TokenDefinitionParams, 'id'> & { operator: AddressBookEntry | undefined }

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

export function removeEthDonator(chain: CHAIN, summary: SummaryOutcome[]) {
	const donatorSummary = summary.find((x) => x.summaryFor.address === CHAINS[chain].eth_donator)
	if (donatorSummary === undefined || donatorSummary.etherResults === undefined) return
	if (donatorSummary.etherResults.balanceAfter + MAKE_YOU_RICH_TRANSACTION.transaction.value === donatorSummary.etherResults.balanceBefore) {
		if (donatorSummary.erc721OperatorChanges.length === 0 &&
			donatorSummary.erc721TokenBalanceChanges.length === 0 &&
			donatorSummary.erc721TokenIdApprovalChanges.length === 0 &&
			donatorSummary.tokenApprovalChanges.length === 0 &&
			donatorSummary.tokenBalanceChanges.length === 0
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
			{ !showLogs ? <></> : <>
				<div class = 'card-content' style = 'border-bottom-left-radius: 0.25rem; border-bottom-right-radius: 0.25rem; border-left: 2px solid var(--card-bg-color); border-right: 2px solid var(--card-bg-color); border-bottom: 2px solid var(--card-bg-color);'>
					<LogAnalysis
						simulatedAndVisualizedTransaction = { simTx }
						identifiedSwap = { identifiedSwap }
						renameAddressCallBack = { renameAddressCallBack }
					/>
				</div>
			</> }
		</div>
	</>
}

function splitToOwnAndNotOwnAndCleanSummary(firstTx: SimulatedAndVisualizedTransaction | undefined, summary: SummaryOutcome[], activeAddress: bigint, chain: CHAIN) {
	//remove eth donator if we are in rich mode
	if (firstTx && identifyTransaction(firstTx).type === 'MakeYouRichTransaction') {
		removeEthDonator(chain, summary)
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
	const [ownAddresses, notOwnAddresses] = splitToOwnAndNotOwnAndCleanSummary(simTx, originalSummary, simulationAndVisualisationResults.activeAddress, simulationAndVisualisationResults.chain)
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
		{ !showSummary ? <></> : <>
			<div class = 'card-content'>
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

				{ notOwnAddresses.length == 0 ? <></> :
					<div class = 'container'>
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
		</> }
	</div>
}

export type TransactionGasses = {
	gasSpent: bigint
	realizedGasPrice: bigint
}

export function GasFee({ tx, chain }: { tx: TransactionGasses, chain: CHAIN } ) {
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
	simTx: SimulatedAndVisualizedTransaction
	renameAddressCallBack: RenameAddressCallBack
	removeTransaction?: () => void
}

export function TransactionHeader( { simTx, renameAddressCallBack, removeTransaction } : TransactionHeaderParams) {
	return <header class = 'card-header' style = 'height: 40px;'>
		<div class = 'card-header-icon unset-cursor'>
			<span class = 'icon'>
				<img src = { simTx.statusCode === 'success' ? ( simTx.quarantine ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
			</span>
		</div>

		<p class = 'card-header-title' style = 'white-space: nowrap;'>
			{ identifyTransaction(simTx).title }
		</p>
		{ simTx.transaction.to  === undefined || identifyTransaction(simTx).type === 'MakeYouRichTransaction' ? <></> :
			<p class = 'card-header-icon' style = 'margin-left: auto; margin-right: 0; padding-right: 10px; padding-left: 0px; overflow: hidden'>
				<SmallAddress
					addressBookEntry = { simTx.transaction.to }
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

export function SimulatedInBlockNumber({ simulationBlockNumber, currentBlockNumber, simulationConductedTimestamp } : { simulationBlockNumber: bigint, currentBlockNumber: bigint | undefined, simulationConductedTimestamp: Date }) {
	return <CopyToClipboard
		content = { simulationBlockNumber.toString() }
		contentDisplayOverride = { `Simulated in block number ${ simulationBlockNumber }` }
		copyMessage = 'Block number copied!'
	>
		<p class = 'noselect nopointer' style = 'color: var(--subtitle-text-color); text-align: right; display: inline'>
			{ 'Simulated ' }
			<span style = { `font-weight: bold; font-family: monospace; color: ${
				simulationBlockNumber === currentBlockNumber || currentBlockNumber === undefined ? 'var(--positive-color)' :
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
	resetButton: boolean,
	currentBlockNumber: bigint | undefined,
	renameAddressCallBack: RenameAddressCallBack,
}

export function SimulationSummary(param: SimulationSummaryParams) {
	if (param.simulationAndVisualisationResults === undefined) return <></>

	const logSummarizer = new LogSummarizer( param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions )
	const addressMetaData = new Map(param.simulationAndVisualisationResults.addressMetaData.map( (x) => [addressString(x.address), x]))
	const originalSummary = logSummarizer.getSummary(addressMetaData, param.simulationAndVisualisationResults.tokenPrices)
	const [ownAddresses, notOwnAddresses] = splitToOwnAndNotOwnAndCleanSummary(param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(0), originalSummary, param.simulationAndVisualisationResults.activeAddress, param.simulationAndVisualisationResults.chain)

	const [showOtherAccountChanges, setShowOtherAccountChange] = useState<boolean>(false)
	const resetSimulation = () => sendPopupMessageToBackgroundPage( { method: 'popup_resetSimulation' } )

	return (
		<div class = 'card' style = 'background-color: var(--card-bg-color); margin: 10px;'>
			<header class = 'card-header'>
				<div class = 'card-header-icon unset-cursor'>
					<span class = 'icon'>
						<img src = { param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.find( (x) => x.statusCode !== 'success') === undefined ? ( param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.find( (x) => x.quarantine ) !== undefined ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
					</span>
				</div>
				<p class = 'card-header-title'>
					<p className = 'paragraph'> Simulation Outcome </p>
				</p>
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
					{ !showOtherAccountChanges ? <></> :
						<div class = 'card-content'>
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
				<p style = 'color: var(--subtitle-text-color); line-height: 28px; display: flex; margin: 0 0 0 auto; width: fit-content; margin-top: 10px'>
					<SimulatedInBlockNumber
						simulationBlockNumber = { param.simulationAndVisualisationResults.blockNumber }
						currentBlockNumber = { param.currentBlockNumber }
						simulationConductedTimestamp = { param.simulationAndVisualisationResults.simulationConductedTimestamp }
					/>
					<button className = 'button is-primary is-small' style = 'margin-left: 5px; background-color: var(--negative-color);' onClick = { resetSimulation } >
						<span class = 'icon'>
							<img src = '../../img/broom.svg'/>
						</span>
						<span>
							Reset
						</span>
					</button>
				</p>
			</div>
		</div>
	)
}
