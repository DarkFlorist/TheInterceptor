import { LogSummarizer } from '../../simulation/services/LogSummarizer.js'
import { CHAIN, SimulationStateParam } from '../../utils/user-interface-types.js'
import { AddressMetadata, BalanceChangeSummary, SimulationAndVisualisationResults, TokenPriceEstimate } from '../../utils/visualizer-types.js'
import { BigAddress, SmallAddress } from '../subcomponents/address.js'
import { ERC721Token, Ether, Token, TokenAmount, TokenPrice, TokenSymbol } from '../subcomponents/coins.js'
import { Transactions } from './Transactions.js'
import { CopyToClipboard } from '../subcomponents/CopyToClipboard.js'
import { SomeTimeAgo } from '../subcomponents/SomeTimeAgo.js'

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

	const boxColor = param.etherResults.balanceAfter - param.etherResults.balanceBefore < 0n ? 'negative-box' : 'positive-box'
	return <div class = 'vertical-center' style = 'display: flex'>
		<div class = { param.isImportant ? `box token-box ${ boxColor }`: '' } style = 'display: flex'>
			<Ether
				amount = { param.etherResults.balanceAfter - param.etherResults.balanceBefore }
				textColor = { param.textColor }
				negativeColor = { param.negativeColor }
				showSign = { true }
				useFullTokenName = { true }
				chain = { param.chain }
			/>
		</div>
	</div>
}

type Erc20BalanceChangeParams = {
	addressMetadata: Map<string, AddressMetadata>,
	tokenBalanceChanges: Map<string, bigint>,
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
	tokenPriceEstimates: TokenPriceEstimate[],
	chain: CHAIN,
}

function Erc20BalanceChange(param: Erc20BalanceChangeParams) {
	if ( param.tokenBalanceChanges.size === 0 ) return <></>
	return <>
		{ Array.from(param.tokenBalanceChanges).map( ([tokenAddress, change]) => (
			<div class = 'vertical-center' style = 'display: flex'>
				<div class = { param.isImportant ? `box token-box ${ change < 0n ? 'negative-box' : 'positive-box' }`: '' } style = 'display: flex' >
					<Token
						amount = { change }
						token = { BigInt(tokenAddress) }
						showSign = { true }
						addressMetadata = { param.addressMetadata.get(tokenAddress) }
						textColor = { param.textColor }
						negativeColor = { param.negativeColor }
						useFullTokenName = { true }
					/>
					<TokenPrice
						amount = { change }
						tokenPriceEstimate = { param.tokenPriceEstimates.find( (x) => x.token === tokenAddress ) }
						textColor = { param.textColor }
						negativeColor = { param.negativeColor }
						chain = { param.chain }
					/>
				</div>
			</div>
		))}
	</>
}

type Erc20ApprovalChangeParams = {
	change: bigint,
	addressToApprove: string,
	tokenAddress: string,
	addressMetadata: Map<string, AddressMetadata>,
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
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
					address = { BigInt(param.addressToApprove) }
					addressMetaData = { param.addressMetadata.get(param.addressToApprove) }
					textColor = { textColor }
				/>
			</div>
			<div class = 'log-cell'>
				<p style = {`color: ${ textColor };` }> &nbsp;to spend&nbsp; </p>
			</div>
			<div class = 'log-cell' style = 'justify-content: right;'>
				{ param.change > 2n ** 100n ?
					<p class = 'ellipsis' style = {`color: ${ textColor };` }> <b>ALL</b>&nbsp;</p>
					:
					<TokenAmount
						amount = { param.change }
						addressMetadata = { param.addressMetadata.get(param.tokenAddress)}
						textColor = { textColor }
					/>
				}
			</div>
			<div class = 'log-cell'>
				<TokenSymbol
					token = { BigInt(param.tokenAddress) }
					addressMetadata = { param.addressMetadata.get(param.tokenAddress) }
					textColor = { textColor }
					useFullTokenName = { true }
				/>
			</div>
		</table>
	</div>
}

type Erc20ApprovalChangesParams = {
	tokenApprovalChanges: Map<string, Map<string, bigint > >,
	addressMetadata: Map<string, AddressMetadata>,
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
}

export function Erc20ApprovalChanges(param: Erc20ApprovalChangesParams ) {
	if ( param.tokenApprovalChanges.size === 0 ) return <></>
	return <>
		{ Array.from(param.tokenApprovalChanges).map( ([tokenAddress, approvals]) => (
			Array.from(approvals).map( ([addressToApprove, change]) => (
				<Erc20ApprovalChange
					addressToApprove = { addressToApprove }
					change = { change }
					tokenAddress = { tokenAddress }
					addressMetadata = { param.addressMetadata }
					textColor = { param.textColor }
					negativeColor = { param.negativeColor }
					isImportant = { param.isImportant }
				/>
			))
		)) }
	</>
}

type ERC721TokenChangesParams = {
	ERC721TokenBalanceChanges: Map<string, Map<string, boolean > >,
	addressMetadata: Map<string, AddressMetadata>,
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
}

function ERC721TokenChanges(param: ERC721TokenChangesParams ) {
	if ( param.ERC721TokenBalanceChanges.size == 0 ) return <></>

	return <> { param.ERC721TokenBalanceChanges.size > 0 ? <>
			{ Array.from(param.ERC721TokenBalanceChanges).map( ([tokenAddress, tokenIds]) => (
				Array.from(tokenIds).map( ([tokenId, received]) => (
					<div class = 'vertical-center' style = 'display: flex'>
						<div class = { param.isImportant ? `box token-box ${ !received ? 'negative-box' : 'positive-box' }`: '' } style = 'display: flex'>
							<ERC721Token
								tokenId = { BigInt(tokenId) }
								token = { BigInt(tokenAddress) }
								received = { received }
								addressMetadata = { param.addressMetadata.get(tokenAddress) }
								textColor = { param.textColor }
								useFullTokenName = { true }
								showSign = { true }
							/>
						</div>
					</div>
				))
			)) }
		</>
	: <></> } </>
}

type ERC721OperatorChangesParams = {
	ERC721OperatorChanges: Map<string, string | undefined>,
	addressMetadata: Map<string, AddressMetadata>,
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
}

export function ERC721OperatorChanges(param: ERC721OperatorChangesParams) {
	if (param.ERC721OperatorChanges.size === 0) return <></>
	return <>
		{ Array.from(param.ERC721OperatorChanges).map( ([tokenAddress, operator]) => (
			<div class = 'vertical-center' style = 'display: flex'>
				{ operator !== undefined ?
					<div class = { param.isImportant ? 'box token-box negative-box': '' } style = 'display: flex'>
						<table class = 'log-table'>
							<div class = 'log-cell'>
								<p class = 'ellipsis' style = { `color: ${ param.negativeColor }` }> Allow&nbsp;</p>
							</div>
							<div class = 'log-cell'>
								<SmallAddress
									address = { BigInt(operator) }
									addressMetaData = { param.addressMetadata.get(operator) }
									textColor = { param.negativeColor }
								/>
							</div>
							<div class = 'log-cell'>
								<p class = 'ellipsis'  style = { `color: ${ param.negativeColor }` }>&nbsp;to spend <b>ALL</b>&nbsp;</p>
							</div>
							<div class = 'log-cell'>
								<TokenSymbol
									token = { BigInt(tokenAddress) }
									addressMetadata = { param.addressMetadata.get(tokenAddress) }
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
									token = { BigInt(tokenAddress) }
									addressMetadata = { param.addressMetadata.get(tokenAddress) }
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
	ERC721TokenIdApprovalChanges: Map<string, Map<string, string > >,
	addressMetadata: Map<string, AddressMetadata>,
	textColor: string,
	negativeColor: string,
	isImportant: boolean,
}

export function ERC721TokenIdApprovalChanges(param: ERC721TokenIdApprovalChangesParams ) {
	return <> { param.ERC721TokenIdApprovalChanges.size > 0 ?
		<>
			{ Array.from(param.ERC721TokenIdApprovalChanges).map( ([tokenAddress, approvals]) => (
				Array.from(approvals).map( ([tokenId, approvedAddress]) => (
					<div class = 'vertical-center' style = 'display: flex'>
						<div class = { param.isImportant ? 'box token-box negative-box': '' } style = 'display: flex'>
							<table class = 'log-table'>
								<div class = 'log-cell'>
									<p class = 'ellipsis' style = {`color: ${ param.negativeColor }` }> Approve&nbsp;</p>
								</div>
								<div class = 'log-cell'>
									<SmallAddress
										address = { BigInt(approvedAddress) }
										addressMetaData = { param.addressMetadata.get(approvedAddress) }
										textColor = { param.negativeColor }
									/>
								</div>
								<div class = 'log-cell'>
									<p class = 'ellipsis' style = {`color: ${ param.negativeColor }` }>&nbsp;for&nbsp;</p>
								</div>
								<div class = 'log-cell'>
									<ERC721Token
										tokenId = { BigInt(tokenId) }
										received = { true }
										token = { BigInt(tokenAddress) }
										addressMetadata = { param.addressMetadata.get(tokenAddress) }
										textColor = { param.negativeColor }
										useFullTokenName = { true }
									/>
								</div>
							</table>
						</div>
					</div>
				))
			)) }
		</>
	: <></> } </>
}


type SummarizeAddressParams = {
	address: string,
	balanceSummary: BalanceChangeSummary,
	simulationAndVisualisationResults: SimulationAndVisualisationResults
}

export function SummarizeAddress(param: SummarizeAddressParams) {
	const isOwnAddress = param.simulationAndVisualisationResults.addressMetadata.get(param.address)?.metadataSource === 'addressBook' || BigInt(param.address) === param.simulationAndVisualisationResults.activeAddress
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
				address = { BigInt(param.address) }
				title = { param.simulationAndVisualisationResults.addressMetadata.get(param.address)?.name }
			/> :
			<SmallAddress
				textColor = { positiveNegativeColors.textColor }
				address = { BigInt(param.address) }
				addressMetaData = { param.simulationAndVisualisationResults.addressMetadata.get(param.address)}
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
				addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
				tokenBalanceChanges = { param.balanceSummary.tokenBalanceChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
				tokenPriceEstimates = { param.simulationAndVisualisationResults.tokenPrices }
				chain = { param.simulationAndVisualisationResults.chain }
			/>
			<Erc20ApprovalChanges
				addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
				tokenApprovalChanges = { param.balanceSummary.tokenApprovalChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
			/>
			<ERC721TokenChanges
				addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
				ERC721TokenBalanceChanges = { param.balanceSummary.ERC721TokenBalanceChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
			/>
			<ERC721OperatorChanges
				addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
				ERC721OperatorChanges = { param.balanceSummary.ERC721OperatorChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
			/>
			<ERC721TokenIdApprovalChanges
				addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
				ERC721TokenIdApprovalChanges = { param.balanceSummary.ERC721TokenIdApprovalChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isOwnAddress }
			/>
		</div>
	</div>
}

export function SimulationResults(param: SimulationStateParam) {
	if ( param.simulationAndVisualisationResults === undefined ) return <></>

	return (
		<div>
			{	param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length === 0 ? <>
					<div class = 'vertical-center'>
						<img style = 'padding-right: 10px; transform: scaleX(-1);' src = '../img/LOGOA.svg' width = '32'/>
						<span class = 'paragraph' style = 'padding-left: 0.2em'> - Give me some transactions to munch on! </span>
					</div>
				</> : <>
					<p className = 'h1' style = 'padding-left: 10px'> Simulation Results </p>
					<Transactions
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						removeTransaction = { param.removeTransaction }
						activeAddress = { param.simulationAndVisualisationResults.activeAddress }
					/>
					<SimulationSummary
						simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
						resetButton = { true }
						refreshSimulation =  { param.refreshSimulation }
						currentBlockNumber = { param.currentBlockNumber }
					/>
				</>
			}
			<div class = 'content' style = 'height: 0.1px'/>
	</div>)
}

type SimulationSummaryParams = {
	simulationAndVisualisationResults: SimulationAndVisualisationResults,
	summarizeOnlyLastTransaction?: boolean,
	resetButton: boolean,
	refreshSimulation: () => void,
	currentBlockNumber: bigint | undefined,
}

export function SimulationSummary(param: SimulationSummaryParams) {
	if (param.simulationAndVisualisationResults === undefined) return <></>

	const VisResults = param.summarizeOnlyLastTransaction && param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length > 0 ?
		[param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(-1)?.simResults?.visualizerResults] :
		param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.map( (x) => (x.simResults?.visualizerResults) )

	const logSummarizer = new LogSummarizer( VisResults )
	const summary = logSummarizer.getSummary()

	const ownAddresses = Array.from(summary.entries()).filter( ([address, _balanceSummary]) =>
		param.simulationAndVisualisationResults.addressMetadata.get(address)?.metadataSource === 'addressBook' || BigInt(address) === param.simulationAndVisualisationResults.activeAddress
	)
	const notOwnAddresses = Array.from(summary.entries()).filter( ([address, _balanceSummary]) =>
		param.simulationAndVisualisationResults.addressMetadata.get(address)?.metadataSource !== 'addressBook' && BigInt(address) !== param.simulationAndVisualisationResults.activeAddress
	)

	function resetSimulation() {
		browser.runtime.sendMessage( { method: 'popup_resetSimulation' } );
	}

	return (
		<div className = 'block' style = 'margin-bottom: 0px'>
			<div style = 'margin: 10px;'>
				<div class = 'block' style = 'background-color: var(--card-bg-color)'>
					<header class = 'card-header'>
						<div class = 'card-header-icon unset-cursor'>
							<span class = 'icon'>
								{ param.summarizeOnlyLastTransaction ?
									<img src = { param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions[param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1].multicallResponse.statusCode === 'success' ? ( param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions[param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length - 1].simResults?.quarantine === true ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } /> :
									<img src = { param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.find( (x) => x.multicallResponse.statusCode !== 'success') === undefined ? ( param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.find( (x) => x.simResults && x.simResults.quarantine ) !== undefined ? '../img/warning-sign.svg' : '../img/success-icon.svg' ) : '../img/error-icon.svg' } />
								}
							</span>
						</div>
						<p class = 'card-header-title'>
							<p className = 'paragraph'> { param.summarizeOnlyLastTransaction ? 'Transaction Outcome' : 'Simulation Outcome' } </p>
						</p>
					</header>
					<div class = 'card-content'>
						<div class = 'container'>
							<div class = 'notification' style = 'background-color: var(--unimportant-text-color); padding: 10px; margin-bottom: 10px; color: var(--text-color)'>
								{ ownAddresses.length == 0 ? <p> No changes to your accounts </p>
									: ownAddresses.map( ([address, balanceSummary], index) => (
										<>
											<SummarizeAddress
												address = { address }
												balanceSummary = { balanceSummary }
												simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
											/>
											{ index + 1 !== ownAddresses.length ? <div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/> : <></> }
										</>
								)) }
							</div>
						</div>
						<div class = 'container'>
							{ notOwnAddresses.length == 0 ? <p> No token or NFT changes to other accounts</p>
								: notOwnAddresses.map( ([address, balanceSummary]) => (
								<>
									<SummarizeAddress
										address = { address }
										balanceSummary = { balanceSummary }
										simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
									/>
									<div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/>
								</>
							)) }
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
								<button class = 'button is-primary is-small' disabled = { param.simulationAndVisualisationResults.isComputingSimulation || param.simulationAndVisualisationResults.blockNumber === param.currentBlockNumber || param.currentBlockNumber === undefined}  style = 'margin-left: 5px;' onClick = { param.refreshSimulation } >
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
