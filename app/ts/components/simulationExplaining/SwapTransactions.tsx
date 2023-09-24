import { SimulatedAndVisualizedTransaction, TokenVisualizerResultWithMetadata } from '../../types/visualizer-types.js'
import * as funtypes from 'funtypes'
import { EthereumQuantity } from '../../types/wire-types.js'
import { abs, addressString } from '../../utils/bigint.js'
import { EtherAmount, EtherSymbol, TokenAmount, TokenOrEthValue, TokenSymbol } from '../subcomponents/coins.js'
import { AddressBookEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../../types/addressBookTypes.js'
import { assertNever, getWithDefault } from '../../utils/typescript.js'
import { RpcNetwork } from '../../types/rpc.js'
import { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { BIG_FONT_SIZE } from '../../utils/constants.js'

export type BeforeAfterBalance = funtypes.Static<typeof SwapAsset>
export const BeforeAfterBalance = funtypes.ReadonlyObject({
	beforeBalance: EthereumQuantity,
	afterBalance: EthereumQuantity,
})

const getUniqueSwapAssetIdentifier = (metadata: TokenVisualizerResultWithMetadata) => {
	return `${ metadata.token.type }|${ metadata.token.address }|${ 'tokenId' in metadata.token ? metadata.token.tokenId : 'noTokenid'}`
}

export type SwapAsset = funtypes.Static<typeof SwapAsset>
export const SwapAsset = funtypes.Union(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('ERC1155'),
		token: Erc1155Entry,
		amount: EthereumQuantity,
		tokenId: funtypes.Union(funtypes.Undefined, EthereumQuantity),
		tokenIdName: funtypes.Union(funtypes.Undefined, funtypes.String),
		beforeAfterBalance: funtypes.Union(BeforeAfterBalance, funtypes.Undefined),
	}),
	funtypes.Intersect(
		funtypes.Union(
			funtypes.ReadonlyObject({ type: funtypes.Literal('ERC20'), token: Erc20TokenEntry }),
			funtypes.ReadonlyObject({ type: funtypes.Literal('ERC721'), token: Erc721Entry }),
			funtypes.ReadonlyObject({ type: funtypes.Literal('Ether'), token: funtypes.Undefined }),
		),
		funtypes.ReadonlyObject({
			amount: EthereumQuantity,
			tokenId: funtypes.Union(funtypes.Undefined, EthereumQuantity),
			beforeAfterBalance: funtypes.Union(BeforeAfterBalance, funtypes.Undefined),
		})
	)
)

export type IdentifiedSwapWithMetadata = funtypes.Static<typeof IdentifiedSwapWithMetadata>
export const IdentifiedSwapWithMetadata = funtypes.Union(
	funtypes.Literal(false), // not a swap
	funtypes.ReadonlyObject({
		sender: AddressBookEntry,
		sendAsset: SwapAsset,
		receiveAsset: SwapAsset
	}),
)

interface SwapVisualizationParams {
	identifiedSwap: IdentifiedSwapWithMetadata
	rpcNetwork: RpcNetwork
	renameAddressCallBack: RenameAddressCallBack
}

export function identifySwap(simTransaction: SimulatedAndVisualizedTransaction): IdentifiedSwapWithMetadata {
	const sender = simTransaction.transaction.from.address

	for (const tokenTransaction of simTransaction.tokenResults) {
		if (tokenTransaction.isApproval && tokenTransaction.from.address === sender) return false // if the transaction includes us approving something, its not a simple swap
	}

	// aggregate sent and received assets
	const aggregatedSentAssets = new Map<string, SwapAsset>()
	const aggregatedReceivedAssets = new Map<string, SwapAsset>()
	const aggregate = (aggregateTo: Map<string, SwapAsset>, logEntry: TokenVisualizerResultWithMetadata) => {
		if (logEntry.isApproval) throw new Error('the log entry included an approval even thought it never should as we check it before')
		const identifier = getUniqueSwapAssetIdentifier(logEntry)
		const previousValue = getWithDefault(aggregateTo, identifier, {
			...logEntry,
			amount: 0n,
			tokenId: 'tokenId' in logEntry ? logEntry.tokenId : undefined,
			...logEntry.type === 'ERC1155' ? { tokenIdName: logEntry.tokenIdName } : {},
			beforeAfterBalance: undefined,
		})
		aggregateTo.set(identifier, {
			...logEntry,
			amount: previousValue.amount + ('amount' in logEntry ? logEntry.amount : 1n),
			tokenId: 'tokenId' in logEntry ? logEntry.tokenId : undefined,
			...logEntry.type === 'ERC1155' ? { tokenIdName: logEntry.tokenIdName } : {},
			beforeAfterBalance: undefined,
		})
	}
	simTransaction.tokenResults.forEach((logEntry) => {
		if (logEntry.isApproval || logEntry.from.address !== sender) return
		aggregate(aggregatedSentAssets, logEntry)
	})
	simTransaction.tokenResults.forEach((logEntry) => {
		if (logEntry.isApproval || logEntry.to.address !== sender) return
		aggregate(aggregatedReceivedAssets, logEntry)
	})
	const sentAssets = Array.from(aggregatedSentAssets, function (entry) { return { identifier: entry[0], value: entry[1] } })
	const receivedAssets = Array.from(aggregatedReceivedAssets, function (entry) { return { identifier: entry[0], value: entry[1] } })

	if (aggregatedSentAssets.size > 1 || aggregatedReceivedAssets.size > 1) return false // its not a pure 1 to 1 swap if we receive or send multiple assets

	const etherChange = simTransaction.ethBalanceChanges.filter((x) => x.address.address === sender)
	const ethDiff = etherChange !== undefined && etherChange.length >= 1 ? etherChange[etherChange.length - 1].after - etherChange[0].before : 0n

	const transactionGasCost = simTransaction.realizedGasPrice * simTransaction.transaction.gas
	if (sentAssets.length === 1 && receivedAssets.length === 1 && -ethDiff <= transactionGasCost) {
		// user swapped one token to another and eth didn't change more than gas fees
		const sentToken = sentAssets[0]
		const receiveToken = receivedAssets[0]
		if (sentToken.identifier !== receiveToken.identifier) {
			const sendBalanceAfter = simTransaction.tokenBalancesAfter.find((balance) => balance.owner === simTransaction.transaction.from.address && balance.token === sentToken.value.token?.address && balance.tokenId === sentToken.value.tokenId)?.balance
			const receiveBalanceAfter = simTransaction.tokenBalancesAfter.find((balance) => balance.owner === simTransaction.transaction.from.address && balance.token === receiveToken.value.token?.address && balance.tokenId === receiveToken.value.tokenId)?.balance
			return {
				sender: simTransaction.transaction.from,
				sendAsset: { ...sentToken.value, beforeAfterBalance: sendBalanceAfter !== undefined
					? { beforeBalance: sendBalanceAfter - sentToken.value.amount, afterBalance: sendBalanceAfter }
					: undefined
				},
				receiveAsset: { ...receiveToken.value, beforeAfterBalance: receiveBalanceAfter !== undefined
					? { beforeBalance: receiveBalanceAfter - receiveToken.value.amount, afterBalance: receiveBalanceAfter }
					: undefined
				},
			}
		}
	}

	if (sentAssets.length === 1 && receivedAssets.length === 0 && ethDiff > 0n ) {
		// user sold token for eth
		const sentToken = sentAssets[0]
		const sendBalanceAfter = simTransaction.tokenBalancesAfter.find((balance) => balance.owner === simTransaction.transaction.from.address && balance.token === sentToken.value.token?.address && balance.tokenId === sentToken.value.tokenId)?.balance
		return {
			sender: simTransaction.transaction.from,
			sendAsset: { ...sentToken.value, beforeAfterBalance: sendBalanceAfter !== undefined
				? { beforeBalance: sendBalanceAfter - sentToken.value.amount, afterBalance: sendBalanceAfter }
				: undefined
			},
			receiveAsset: {
				type: 'Ether',
				amount: ethDiff,
				beforeAfterBalance: {
					beforeBalance: etherChange[0].before,
					afterBalance: etherChange[0].before + ethDiff
				},
				token: undefined,
				tokenId: undefined,
			},
		}
	}

	if (sentAssets.length === 0 && receivedAssets.length === 1 && ethDiff < transactionGasCost ) {
		// user bought token with eth
		const receiveToken = receivedAssets[0]
		const receiveBalanceAfter = simTransaction.tokenBalancesAfter.find((balance) => balance.owner === simTransaction.transaction.from.address && balance.token === receiveToken.value.token?.address && balance.tokenId === receiveToken.value.tokenId)?.balance
		return {
			sender: simTransaction.transaction.from,
			sendAsset: {
				type: 'Ether',
				amount: -ethDiff,
				beforeAfterBalance: {
					beforeBalance: etherChange[0].before,
					afterBalance: etherChange[0].before + ethDiff
				},
				token: undefined,
				tokenId: undefined,
			},
			receiveAsset: { ...receiveToken.value, beforeAfterBalance: receiveBalanceAfter !== undefined
				? { beforeBalance: receiveBalanceAfter - receiveToken.value.amount, afterBalance: receiveBalanceAfter }
				: undefined
			},
		}
	}
	return false
}

type Graph = Map<string, Map<string | undefined, { to: string, tokenResultIndex: number | undefined } > > // from, tokenaddress (undefined for ether), to
interface State {
	fromAddress: string,
	toAddress: string,
	currentTokenAddress: string | undefined, // undefined for ether
	tokenResultIndex: number | undefined,
}

interface EthTradePair {
	fromAddress: string,
	toAddress: string,
	amount: bigint
}

function *findSwapRoutes(graph: Graph, currentState: State, goalState: State, path: State[] = []): IterableIterator<State[]> {
	if ( path.length > 10) {
		return []
	}
	if (currentState.toAddress === goalState.toAddress && currentState.currentTokenAddress === goalState.currentTokenAddress) {
		yield path.concat(goalState);
	} else {
		const neighbours = graph.get(currentState.toAddress)
		if (neighbours) {
			path.push(currentState);
			for (const [tokenaddress, toAndAmount] of neighbours.entries()) {
				yield *findSwapRoutes(graph, {
					toAddress: toAndAmount.to,
					currentTokenAddress: tokenaddress,
					tokenResultIndex: toAndAmount.tokenResultIndex,
					fromAddress: currentState.toAddress,
				}, goalState, path);
			}
			path.pop()
		}
	}
}

export function identifyRoutes(simulatedAndVisualizedTransaction: SimulatedAndVisualizedTransaction, identifiedSwap: IdentifiedSwapWithMetadata) : false | TokenVisualizerResultWithMetadata[] {
	if ( identifiedSwap === false ) return false
	const tokenResults = simulatedAndVisualizedTransaction.tokenResults
	const ethBalanceChanges = simulatedAndVisualizedTransaction.ethBalanceChanges
	if ( tokenResults.length > 10 ) return false // too complex

	const graph: Graph = new Map()
	const transactionGasCost = simulatedAndVisualizedTransaction.realizedGasPrice * simulatedAndVisualizedTransaction.transaction.gas

	// build search graph
	for (const [tokenResultIndex, result] of tokenResults.entries()) {
		const fromAddress = addressString(result.from.address)
		const toAddress = addressString(result.to.address)
		const tokenAddress = addressString(result.token.address)
		if(!graph.has(fromAddress)) graph.set(fromAddress, new Map() )

		if (!('amount' in result)) return false // cannot deal with nft's

		const from = graph.get(fromAddress)
		if(!from!.has(tokenAddress)) {
			from!.set(tokenAddress, { to: toAddress, tokenResultIndex: tokenResultIndex } )
		} else {
			return false
		}
	}

	// from eth delta's try to figure out how the eth has flowed in the transaction chain.
	// this works if account is not sending eth to multiple places
	// we do this figuring out by trying to find an account that has its delta eth balance go up the amount we sent, with error of transactiongascost
	let matchedEthPairs: EthTradePair[] = []
	for (const result of ethBalanceChanges) {
		const address = addressString(result.address.address)
		const delta = result.after - result.before
		for (const compareTo of ethBalanceChanges) {
			const compareToAddress = addressString(compareTo.address.address)
			const compareToDelta = compareTo.after - compareTo.before
			if(compareToAddress !== address) {
				if( abs(delta+compareToDelta) <= transactionGasCost && abs(delta) >= transactionGasCost && abs(compareToDelta) >= transactionGasCost ) {
					if (matchedEthPairs.find( (matchedPair) => matchedPair.fromAddress === compareToAddress || matchedPair.toAddress === compareToAddress ) === undefined) {
						matchedEthPairs.push( {
							fromAddress: delta < 0n ? address : compareToAddress,
							toAddress: delta < 0n ? compareToAddress : address,
							amount: abs(delta),
						})
					}
				}
			}
		}
	}
	for (const matchedPair of matchedEthPairs) {
		if(!graph.has(matchedPair.fromAddress)) graph.set(matchedPair.fromAddress, new Map() )

		const from = graph.get(matchedPair.fromAddress)
		if(!from!.has(undefined)) {
			from!.set(undefined, { to: matchedPair.toAddress, tokenResultIndex: undefined } )
		} else {
			return false
		}
	}
	Map<string, Map<string | undefined, {to: string, tokenResultIndex: number | undefined } > >
	// traverse chain
	const startToken = identifiedSwap.sendAsset.type !== 'Ether' ? addressString(identifiedSwap.sendAsset.token.address) : undefined
	const endToken = identifiedSwap.receiveAsset.type !== 'Ether' ? addressString(identifiedSwap.receiveAsset.token.address) : undefined
	const lastIndex = endToken !== undefined ? tokenResults.findIndex((x) => (x.to.address === identifiedSwap.sender.address && addressString(x.token.address) === endToken ) ) : -1
	const routes = [...findSwapRoutes(graph,
		{
			fromAddress: addressString(identifiedSwap.sender.address),
			toAddress: addressString(identifiedSwap.sender.address),
			tokenResultIndex: graph.get(addressString(identifiedSwap.sender.address))?.get(startToken)?.tokenResultIndex,
			currentTokenAddress: startToken,
		},
		{
			fromAddress: addressString(identifiedSwap.sender.address),
			toAddress: addressString(identifiedSwap.sender.address),
			tokenResultIndex: lastIndex >= 0 ? lastIndex : undefined,
			currentTokenAddress: endToken
		}
	)]

	function uniqByKeepFirst(a: State[]) {
		let seen = new Set();
		return a.filter(item => {
			return seen.has(item) ? false : seen.add(item);
		})
	}
	const route = uniqByKeepFirst(routes.flat())

	if ( route.length === 0) return false

	function sortAccordingArrayIfNotMaintainOrder(a: TokenVisualizerResultWithMetadata, b: TokenVisualizerResultWithMetadata) {
		const indexOfA = route.findIndex( (x) => a.from.address === BigInt(x.fromAddress) && BigInt(x.toAddress) === a.to.address && addressString(a.token.address) === x.currentTokenAddress )
		const indexOfB = route.findIndex( (x) => b.from.address === BigInt(x.fromAddress) && BigInt(x.toAddress) === b.to.address && addressString(b.token.address) === x.currentTokenAddress )
		const v = (indexOfA >= 0 ? indexOfA : route.length + tokenResults.indexOf(a) ) - (indexOfB >= 0 ? indexOfB : route.length + tokenResults.indexOf(b))
		return v
	}

	const sorted = [ ...tokenResults ].sort(sortAccordingArrayIfNotMaintainOrder)

	return sorted
}

export function getSwapName(identifiedSwap: IdentifiedSwapWithMetadata, rpcNetwork: RpcNetwork) {
	if (identifiedSwap === false) return undefined
	const sent = identifiedSwap.sendAsset.type !== 'Ether' ? identifiedSwap.sendAsset.token.symbol : rpcNetwork.currencyTicker
	const to = identifiedSwap.receiveAsset.type !== 'Ether' ? identifiedSwap.receiveAsset.token.symbol : rpcNetwork.currencyTicker
	return `Swap ${ sent } for ${ to }`
}

export function VisualizeSwapAsset({ swapAsset, rpcNetwork, renameAddressCallBack }: { swapAsset: SwapAsset, rpcNetwork: RpcNetwork, renameAddressCallBack: RenameAddressCallBack }) {
	const tokenStyle = { 'font-size': BIG_FONT_SIZE, 'font-weight': '500' }
	const balanceTextStyle = { 'font-size': '14px', 'color': 'var(--subtitle-text-color)' }

	switch (swapAsset.type) {
		case 'Ether': {
			return <>
				<span class = 'grid swap-grid'>
					<div class = 'log-cell' style = 'justify-content: left;'>
						<EtherAmount
							amount = { swapAsset.amount }
							style = { tokenStyle }
						/>
					</div>
					<div class = 'log-cell' style = 'justify-content: right;'>
						<EtherSymbol
							rpcNetwork = { rpcNetwork }
							useFullTokenName = { false }
							style = { tokenStyle}
						/>
					</div>
				</span>
				<span class = 'grid swap-grid'>
					<div class = 'log-cell'/>
					{ swapAsset.beforeAfterBalance !== undefined ? <div class = 'log-cell' style = 'justify-content: right;'>
						<p class = 'paragraph' style = { balanceTextStyle }>Balance:&nbsp;</p>
						<TokenOrEthValue amount = { swapAsset.beforeAfterBalance?.beforeBalance } style = { balanceTextStyle } />
						<p class = 'paragraph' style = { balanceTextStyle }>&nbsp;{'->'}&nbsp;</p>
						<TokenOrEthValue amount = { swapAsset.beforeAfterBalance?.afterBalance } style = { balanceTextStyle } />
						</div> : <></>
					}
				</span>
			</>
		}
		case 'ERC721': {
			return <span class = 'grid swap-grid-1'>
				<div class = 'log-cell-flexless' style = 'justify-content: center; display: flex;'>
					<TokenSymbol
						tokenEntry = { swapAsset.token }
						tokenId = { swapAsset.tokenId }
						useFullTokenName = { false }
						style = { tokenStyle }
						renameAddressCallBack = { renameAddressCallBack }
					/>
				</div>
			</span>
		}
		case 'ERC1155': {
			return <>
				<span class = 'grid swap-grid-1'>
					<div class = 'log-cell-flexless' style = 'justify-content: center; display: flex;'>
						<TokenSymbol
							tokenEntry = { swapAsset.token }
							tokenId = { swapAsset.tokenId }
							tokenIdName = { swapAsset.tokenIdName }
							useFullTokenName = { false }
							style = { tokenStyle }
							renameAddressCallBack = { renameAddressCallBack }
						/>
					</div>
				</span>
				<span class = 'grid swap-grid'>
					<div class = 'log-cell'/>
					{ swapAsset.beforeAfterBalance !== undefined ? <div class = 'log-cell' style = 'justify-content: right;'>
						<p class = 'paragraph' style = { balanceTextStyle }>Balance:&nbsp;</p>
						<TokenOrEthValue { ...swapAsset.token } amount = { swapAsset.beforeAfterBalance?.beforeBalance } style = { balanceTextStyle } />
						<p class = 'paragraph' style = { balanceTextStyle }>&nbsp;{'->'}&nbsp;</p>
						<TokenOrEthValue { ...swapAsset.token } amount = { swapAsset.beforeAfterBalance?.afterBalance } style = { balanceTextStyle } />
						</div> : <></>
					}
				</span>
			</>
		}
		case 'ERC20': {
			return <>
				<span class = 'grid swap-grid'>
					<div class = 'log-cell' style = 'justify-content: left;'>
						<TokenAmount
							amount = { swapAsset.amount }
							tokenEntry = { swapAsset.token }
							style = { tokenStyle }
						/>
					</div>
					<div class = 'log-cell' style = 'justify-content: right;'>
						<TokenSymbol
							tokenEntry = { swapAsset.token }
							useFullTokenName = { false }
							style = { tokenStyle }
							renameAddressCallBack = { renameAddressCallBack }
						/>
					</div>
				</span>
				<span class = 'grid swap-grid'>
					<div class = 'log-cell'/>
					{ swapAsset.beforeAfterBalance !== undefined ? <div class = 'log-cell' style = 'justify-content: right;'>
						<p class = 'paragraph' style = { balanceTextStyle }>Balance:&nbsp;</p>
						<TokenOrEthValue { ...swapAsset.token } amount = { swapAsset.beforeAfterBalance?.beforeBalance } style = { balanceTextStyle } />
						<p class = 'paragraph' style = { balanceTextStyle }>&nbsp;{'->'}&nbsp;</p>
						<TokenOrEthValue { ...swapAsset.token } amount = { swapAsset.beforeAfterBalance?.afterBalance } style = { balanceTextStyle } />
						</div> : <></>
					}
				</span>
			</>
		}
		default: assertNever(swapAsset)
	}
}

export function SwapVisualization(param: SwapVisualizationParams) {
	if ( param.identifiedSwap === false ) return <></>

	return <div class = 'notification transaction-importance-box'>
		<div style = 'display: grid; grid-template-rows: max-content max-content max-content max-content;'>
			<p class = 'paragraph'> Swap </p>
			<div class = 'box swap-box'>
				<VisualizeSwapAsset swapAsset = { param.identifiedSwap.sendAsset } rpcNetwork = { param.rpcNetwork } renameAddressCallBack = { param.renameAddressCallBack } />
			</div>
			<p class = 'paragraph'> For </p>
			<div class = 'box swap-box'>
				<VisualizeSwapAsset swapAsset = { param.identifiedSwap.receiveAsset } rpcNetwork = { param.rpcNetwork } renameAddressCallBack = { param.renameAddressCallBack } />
			</div>
		</div>
	</div>
}
