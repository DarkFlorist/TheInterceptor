import { LogSummarizer } from '../../simulation/services/LogSummarizer'
import { CHAIN, SimulationStateParam } from '../../utils/user-interface-types'
import { AddressMetadata, BalanceChangeSummary, SimulationAndVisualisationResults, TokenPriceEstimate } from '../../utils/visualizer-types'
import { BigAddress, SmallAddress } from '../subcomponents/address'
import { ERC721Token, Ether, Token, TokenPrice, TokenSymbol } from '../subcomponents/coins'
import { Transactions } from './Transactions'
import { CopyToClipboard } from '../subcomponents/CopyToClipboard'
import { SomeTimeAgo } from '../subcomponents/SomeTimeAgo'

function EtherChange(
	param: {
		textColor: string,
		negativeColor: string,
		isImportant: boolean,
		etherResults: {
			balanceBefore: bigint;
			balanceAfter: bigint;
		} | undefined,
		chain: CHAIN
	}
) {
	if ( param.etherResults === undefined ) return <></>

	const boxColor = param.etherResults.balanceAfter - param.etherResults.balanceBefore < 0n ? 'negative-box' : 'positive-box'
	return <div class = 'vertical-center'>
		<div class = { param.isImportant ? `box token-box ${ boxColor }`: '' }>
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

function Erc20BalanceChange(
	param: {
		addressMetadata: Map<string, AddressMetadata>,
		tokenBalanceChanges: Map<string, bigint>,
		textColor: string,
		negativeColor: string,
		isImportant: boolean,
		tokenPriceEstimates: TokenPriceEstimate[],
		chain: CHAIN,
	}
) {
	if ( param.tokenBalanceChanges.size === 0 ) return <></>
	return <>
		{ Array.from(param.tokenBalanceChanges).map( ([tokenAddress, change]) => (
			<div class = 'vertical-center'>
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

export function Erc20ApprovalChanges(param: { tokenApprovalChanges: Map<string, Map<string, bigint > >, addressMetadata: Map<string, AddressMetadata>, textColor: string, negativeColor: string, isImportant: boolean } ) {
	if ( param.tokenApprovalChanges.size === 0 ) return <></>
	return <>
		{ Array.from(param.tokenApprovalChanges).map( ([tokenAddress, approvals]) => (
			Array.from(approvals).map( ([addressToApprove, change]) => (
				<div class = 'vertical-center'>
					<div class = { param.isImportant ? 'box token-box negative-box': '' } >
						<div class = 'vertical-center'>
							<p class = 'vertical-center' style = {`color: ${ param.negativeColor }; margin-bottom: 0px; margin-right: 8px; white-space: nowrap;`}> Approve </p>
							<SmallAddress
								address = { BigInt(addressToApprove) }
								addressMetaData = { param.addressMetadata.get(addressToApprove) }
								textColor = { param.negativeColor }
								downScale = { true }
							/>
							{ change > 2n ** 100n ?
								<>
									<p class = 'vertical-center' style = { `color: ${ param.negativeColor }; margin-bottom: 0px; margin-right: 8px; white-space: nowrap;` }> for ALL </p>
									<TokenSymbol
										token = { BigInt(tokenAddress) }
										addressMetadata = { param.addressMetadata.get(tokenAddress) }
										textColor = { param.negativeColor }
										useFullTokenName = { true }
									/>
								</> : <>
									<p class = 'vertical-center' style = { `color: ${ param.negativeColor }; margin-bottom: 0px; margin-right: 8px; white-space: nowrap;` }> for </p>
									<Token
										amount = { change }
										token = { BigInt(tokenAddress) }
										showSign = { false }
										addressMetadata = { param.addressMetadata.get(tokenAddress) }
										textColor = { param.negativeColor }
										useFullTokenName = { true }
									/>
								</>
							}
						</div>
					</div>
				</div>
			))
		)) }
	</>
}

function ERC721TokenChanges(param: { ERC721TokenBalanceChanges: Map<string, Map<string, boolean > >, addressMetadata: Map<string, AddressMetadata>, textColor: string, negativeColor: string, isImportant: boolean } ) {
	if ( param.ERC721TokenBalanceChanges.size == 0 ) return <></>

	return <> { param.ERC721TokenBalanceChanges.size > 0 ? <>
			{ Array.from(param.ERC721TokenBalanceChanges).map( ([tokenAddress, tokenIds]) => (
				Array.from(tokenIds).map( ([tokenId, received]) => (
					<div class = 'vertical-center'>
						<div class = { param.isImportant ? `box token-box ${ !received ? 'negative-box' : 'positive-box' }`: '' } >
							<ERC721Token
								tokenId = { BigInt(tokenId) }
								token = { BigInt(tokenAddress) }
								received = { received }
								addressMetadata = { param.addressMetadata.get(tokenAddress) }
								textColor = { param.textColor }
								sentTextColor = { param.negativeColor }
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

export function ERC721OperatorChanges(param: { ERC721OperatorChanges: Map<string, string | undefined>, addressMetadata: Map<string, AddressMetadata>, textColor: string, negativeColor: string, isImportant: boolean } ) {
	if (param.ERC721OperatorChanges.size === 0) return <></>
	return <>
		{ Array.from(param.ERC721OperatorChanges).map( ([tokenAddress, operator]) => (
			<div class = 'vertical-center'>
				{ operator !== undefined ? <>
					<div class = { param.isImportant ? 'box token-box negative-box': '' }>
						<p style = { `color: ${ param.negativeColor } margin-right: 8px` }> Set </p>
							<SmallAddress
								address = { BigInt(operator) }
								addressMetaData = { param.addressMetadata.get(operator) }
								textColor = { param.negativeColor }
								downScale = { true }
							/>
						<p style = { `color: ${ param.negativeColor } margin-bottom: 0px; margin-right: 8px` }> as Operator for </p>
						<TokenSymbol
							token = { BigInt(tokenAddress) }
							addressMetadata = { param.addressMetadata.get(tokenAddress) }
							textColor = { param.negativeColor }
							useFullTokenName = { true }
						/>
					</div>
				</> :
					<div class = { param.isImportant ? 'box token-box positive-box': '' } >
						<p style = { `color: ${ param.textColor }; margin-bottom: 0px; margin-right: 8px` }> Operator removed for </p>
						<TokenSymbol
							token = { BigInt(tokenAddress) }
							addressMetadata = { param.addressMetadata.get(tokenAddress) }
							textColor = { param.textColor }
							useFullTokenName = { true }
						/>
					</div>
				}
			</div>
		)) }
	</>
}

export function ERC721TokenIdApprovalChanges(param: { ERC721TokenIdApprovalChanges: Map<string, Map<string, string > >, addressMetadata: Map<string, AddressMetadata>, textColor: string, negativeColor: string, isImportant: boolean } ) {
	return <> { param.ERC721TokenIdApprovalChanges.size > 0 ?
		<>
			{ Array.from(param.ERC721TokenIdApprovalChanges).map( ([tokenAddress, approvals]) => (
				Array.from(approvals).map( ([tokenId, approvedAddress]) => (
					<div class = 'vertical-center'>
						<div class = { param.isImportant ? 'box token-box negative-box': '' } >
							<p style = {`color: ${ param.negativeColor } margin-right: 8px` }> Approve </p>
							<SmallAddress
								address = { BigInt(approvedAddress) }
								addressMetaData = { param.addressMetadata.get(approvedAddress) }
								textColor = { param.negativeColor }
								downScale = { true }
							/>
							<p style = {`color: ${ param.negativeColor } margin-bottom: 0px; margin-right: 8px` }> for </p>
							<ERC721Token
								tokenId = { BigInt(tokenId) }
								received = { true }
								token = { BigInt(tokenAddress) }
								addressMetadata = { param.addressMetadata.get(tokenAddress) }
								textColor = { param.negativeColor }
								useFullTokenName = { true }
							/>
						</div>
					</div>
				))
			)) }
		</>
	: <></> } </>
}

export function SummarizeAddress(
	param: {
		address: string,
		balanceSummary: BalanceChangeSummary,
		simulationAndVisualisationResults: SimulationAndVisualisationResults
	}
) {
	const isFromAddresBook = param.simulationAndVisualisationResults.addressMetadata.get(param.address)?.metadataSource === 'addressBook'
	const positiveNegativeColors = isFromAddresBook ? {
		textColor: 'var(--text-color)',
		negativeColor: 'FFFFFF'
	} : {
		textColor: 'var(--disabled-text-color)',
		negativeColor: 'rgba(246, 104, 94, 0.5)'
	}
	return <>
		{ isFromAddresBook ?
			<BigAddress
				address = { BigInt(param.address) }
				title = { param.simulationAndVisualisationResults.addressMetadata.get(param.address)?.name }
			/> :
			<SmallAddress
				textColor = { positiveNegativeColors.textColor }
				address = { BigInt(param.address) }
				addressMetaData = { param.simulationAndVisualisationResults.addressMetadata.get(param.address)}
				downScale = { true }
			/>
		}

		<div class = 'content' style = 'overflow-y: hidden; margin-bottom: 0px;'>
			<EtherChange
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isFromAddresBook }
				etherResults =  { param.balanceSummary.etherResults }
				chain = { param.simulationAndVisualisationResults.chain }
			/>
			<Erc20BalanceChange
				addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
				tokenBalanceChanges = { param.balanceSummary.tokenBalanceChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isFromAddresBook }
				tokenPriceEstimates = { param.simulationAndVisualisationResults.tokenPrices }
				chain = { param.simulationAndVisualisationResults.chain }
			/>
			<Erc20ApprovalChanges
				addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
				tokenApprovalChanges = { param.balanceSummary.tokenApprovalChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isFromAddresBook }
			/>
			<ERC721TokenChanges
				addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
				ERC721TokenBalanceChanges = { param.balanceSummary.ERC721TokenBalanceChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isFromAddresBook }
			/>
			<ERC721OperatorChanges
				addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
				ERC721OperatorChanges = { param.balanceSummary.ERC721OperatorChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isFromAddresBook }
			/>
			<ERC721TokenIdApprovalChanges
				addressMetadata = { param.simulationAndVisualisationResults.addressMetadata }
				ERC721TokenIdApprovalChanges = { param.balanceSummary.ERC721TokenIdApprovalChanges }
				textColor = { positiveNegativeColors.textColor }
				negativeColor = { positiveNegativeColors.negativeColor }
				isImportant = { isFromAddresBook }
			/>
		</div>
	</>
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

export function SimulationSummary(
	param: {
		simulationAndVisualisationResults: SimulationAndVisualisationResults,
		summarizeOnlyLastTransaction?: boolean,
		resetButton: boolean,
		refreshSimulation: () => void,
		currentBlockNumber: bigint | undefined,
	}
) {
	if (param.simulationAndVisualisationResults === undefined) return <></>

	const VisResults = param.summarizeOnlyLastTransaction && param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.length > 0 ?
		[param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.at(-1)?.simResults?.visualizerResults] :
		param.simulationAndVisualisationResults.simulatedAndVisualizedTransactions.map( (x) => (x.simResults?.visualizerResults) )

	const logSummarizer = new LogSummarizer( VisResults )
	const summary = logSummarizer.getSummary()

	const addressBookEntries =  Array.from(summary.entries()).filter( ([address, _balanceSummary]) =>
		param.simulationAndVisualisationResults.addressMetadata.get(address)?.metadataSource === 'addressBook'
	)
	const nonAddressBookEntries =  Array.from(summary.entries()).filter( ([address, _balanceSummary]) =>
		param.simulationAndVisualisationResults.addressMetadata.get(address)?.metadataSource !== 'addressBook'
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
								{ addressBookEntries.length == 0 ? <p> No changes to your accounts </p>
									: addressBookEntries.map( ([address, balanceSummary], index) => (
										<>
											<SummarizeAddress
												address = { address }
												balanceSummary = { balanceSummary }
												simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
											/>
											{ index + 1 !== addressBookEntries.length ? <div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/> : <></> }
										</>
								)) }
							</div>
						</div>
						{ nonAddressBookEntries.length == 0 ? <p> No token or NFT changes to other accounts</p>
							: nonAddressBookEntries.map( ([address, balanceSummary]) => (
							<>
								<SummarizeAddress
									address = { address }
									balanceSummary = { balanceSummary }
									simulationAndVisualisationResults = { param.simulationAndVisualisationResults }
								/>
								<div class = 'is-divider' style = 'margin-top: 8px; margin-bottom: 8px'/>
							</>
						)) }
							<p style = 'color: var(--subtitle-text-color); text-align: right; line-height: 28px;'>
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
