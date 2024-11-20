import { SimulatedAndVisualizedTransaction, TokenPriceEstimate } from '../../types/visualizer-types.js'
import * as funtypes from 'funtypes'
import { EthereumQuantity } from '../../types/wire-types.js'
import { addressString } from '../../utils/bigint.js'
import { TokenAmount, TokenOrEthValue, TokenPrice, TokenSymbol } from '../subcomponents/coins.js'
import { AddressBookEntry, Erc1155Entry, Erc20TokenEntry, Erc721Entry } from '../../types/addressBookTypes.js'
import { assertNever } from '../../utils/typescript.js'
import { RenameAddressCallBack } from '../../types/user-interface-types.js'
import { extractTokenEvents } from '../../background/metadataUtils.js'
import { TokenVisualizerResultWithMetadata } from '../../types/EnrichedEthereumData.js'

type BeforeAfterBalance = funtypes.Static<typeof SwapAsset>
const BeforeAfterBalance = funtypes.ReadonlyObject({
	beforeBalance: EthereumQuantity,
	afterBalance: EthereumQuantity,
})

const getUniqueSwapAssetIdentifier = (metadata: TokenVisualizerResultWithMetadata) => {
	return `${ metadata.token.type }|${ metadata.token.address }|${ 'tokenId' in metadata.token ? metadata.token.tokenId : 'noTokenid'}`
}

type SwapAsset = funtypes.Static<typeof SwapAsset>
const SwapAsset = funtypes.Union(
	funtypes.ReadonlyObject({
		type: funtypes.Literal('ERC1155'),
		token: Erc1155Entry,
		amount: EthereumQuantity,
		tokenId: funtypes.Union(funtypes.Undefined, EthereumQuantity),
		tokenIdName: funtypes.Union(funtypes.Undefined, funtypes.String),
		beforeAfterBalance: funtypes.Union(BeforeAfterBalance, funtypes.Undefined),
	}),
	funtypes.ReadonlyObject({
		type: funtypes.Literal('ERC721'),
		token: Erc721Entry,
		amount: EthereumQuantity,
		tokenId: funtypes.Union(funtypes.Undefined, EthereumQuantity),
		beforeAfterBalance: funtypes.Union(BeforeAfterBalance, funtypes.Undefined),
	}),
	funtypes.ReadonlyObject({
		type: funtypes.Literal('ERC20'),
		token: Erc20TokenEntry,
		amount: EthereumQuantity,
		tokenId: funtypes.Union(funtypes.Undefined, EthereumQuantity),
		beforeAfterBalance: funtypes.Union(BeforeAfterBalance, funtypes.Undefined),
		tokenPriceEstimateQuoteToken: funtypes.Union(Erc20TokenEntry, funtypes.Undefined),
		tokenPriceEstimate: funtypes.Union(TokenPriceEstimate,funtypes.Undefined),
	})
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
	renameAddressCallBack: RenameAddressCallBack
}

export function identifySwap(simTransaction: SimulatedAndVisualizedTransaction): IdentifiedSwapWithMetadata {
	const sender = simTransaction.transaction.from.address
	const tokenEvents = extractTokenEvents(simTransaction.events)
	// aggregate sent and received assets
	const aggregatedAssets = new Map<string, SwapAsset>()
	const aggregate = (logEntry: TokenVisualizerResultWithMetadata, toUs: boolean) => {
		if (logEntry.isApproval) throw new Error('the log entry included an approval even thought it never should as we check it before')
		const identifier = getUniqueSwapAssetIdentifier(logEntry)
		const perviousAmount = aggregatedAssets.get(identifier)?.amount ?? 0n
		const multiplier = toUs ? 1n : -1n
		if (logEntry.type === 'ERC20') {
			aggregatedAssets.set(identifier, {
				...logEntry,
				amount: perviousAmount + ('amount' in logEntry ? logEntry.amount : 1n) * multiplier,
				tokenId: undefined,
				beforeAfterBalance: undefined,
				tokenPriceEstimate: simTransaction.tokenPriceEstimates.find((tokenPrice) => tokenPrice.token.address === logEntry.token.address),
				tokenPriceEstimateQuoteToken: simTransaction.tokenPriceQuoteToken,
			})
		} else {
			aggregatedAssets.set(identifier, {
				...logEntry,
				amount: perviousAmount + ('amount' in logEntry ? logEntry.amount : 1n) * multiplier,
				tokenId: 'tokenId' in logEntry ? logEntry.tokenId : undefined,
				...logEntry.type === 'ERC1155' ? { tokenIdName: logEntry.tokenIdName } : {},
				beforeAfterBalance: undefined,
			})
		}
	}

	for (const logEntry of tokenEvents) {
		if (logEntry.isApproval) return false // if there's approvals its not a swap

		if (logEntry.from.address === sender) {
			aggregate(logEntry, false)
		} else if (logEntry.to.address === sender) {
			aggregate(logEntry, true)
		}
	}

	const sentAssets = Array.from(aggregatedAssets).filter((asset) => asset[1].amount < 0).map((entry) => { return { identifier: entry[0], value: entry[1] } })
	const receivedAssets = Array.from(aggregatedAssets).filter((asset) => asset[1].amount > 0).map((entry) => { return { identifier: entry[0], value: entry[1] } })

	if (sentAssets.length !== 1 || receivedAssets.length !== 1) return false // its not a pure 1 to 1 swap if we receive or send multiple assets
	const sentToken = sentAssets[0]
	const receiveToken = receivedAssets[0]
	if (sentToken === undefined || receiveToken === undefined) throw new Error('sent token or receive token was undefined')
	if (sentToken.identifier !== receiveToken.identifier) {
		const sendBalanceAfter = simTransaction.tokenBalancesAfter.find((balance) => balance.owner === simTransaction.transaction.from.address && balance.token === sentToken.value.token?.address && balance.tokenId === sentToken.value.tokenId)?.balance
		const receiveBalanceAfter = simTransaction.tokenBalancesAfter.find((balance) => balance.owner === simTransaction.transaction.from.address && balance.token === receiveToken.value.token?.address && balance.tokenId === receiveToken.value.tokenId)?.balance
		return {
			sender: simTransaction.transaction.from,
			sendAsset: {
				...sentToken.value,
				amount: sentToken.value.amount * -1n,
				beforeAfterBalance: sendBalanceAfter !== undefined ? { beforeBalance: sendBalanceAfter - sentToken.value.amount, afterBalance: sendBalanceAfter } : undefined
			},
			receiveAsset: {
				...receiveToken.value,
				beforeAfterBalance: receiveBalanceAfter !== undefined ? { beforeBalance: receiveBalanceAfter - receiveToken.value.amount, afterBalance: receiveBalanceAfter } : undefined
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

function *findSwapRoutes(graph: Graph, currentState: State, goalState: State, path: State[] = []): IterableIterator<State[]> {
	if (path.length > 10) return
	if (currentState.toAddress === goalState.toAddress && currentState.currentTokenAddress === goalState.currentTokenAddress) {
		yield path.concat(goalState)
	} else {
		const neighbours = graph.get(currentState.toAddress)
		if (neighbours) {
			path.push(currentState)
			for (const [tokenaddress, toAndAmount] of neighbours.entries()) {
				yield *findSwapRoutes(graph, {
					toAddress: toAndAmount.to,
					currentTokenAddress: tokenaddress,
					tokenResultIndex: toAndAmount.tokenResultIndex,
					fromAddress: currentState.toAddress,
				}, goalState, path)
			}
			path.pop()
		}
	}
	return
}

export function identifyRoutes(simulatedAndVisualizedTransaction: SimulatedAndVisualizedTransaction, identifiedSwap: IdentifiedSwapWithMetadata) : false | TokenVisualizerResultWithMetadata[] {
	if (identifiedSwap === false) return false
	const tokenEvents = extractTokenEvents(simulatedAndVisualizedTransaction.events)
	if (tokenEvents.length > 10) return false // too complex

	const graph: Graph = new Map()

	// build search graph
	for (const [tokenResultIndex, result] of tokenEvents.entries()) {
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

	// traverse chain
	const startToken = addressString(identifiedSwap.sendAsset.token.address)
	const endToken = addressString(identifiedSwap.receiveAsset.token.address)
	const lastIndex = endToken !== undefined ? tokenEvents.findIndex((x) => (x.to.address === identifiedSwap.sender.address && addressString(x.token.address) === endToken)) : -1
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

	function uniqueByKeepFirst(a: State[]) {
		const seen = new Set()
		return a.filter((item) => {
			if (seen.has(item)) return false
			seen.add(item)
			return true
		})
	}
	const route = uniqueByKeepFirst(routes.flat())

	if (route.length === 0) return false

	function sortAccordingArrayIfNotMaintainOrder(a: TokenVisualizerResultWithMetadata, b: TokenVisualizerResultWithMetadata) {
		const indexOfA = route.findIndex((x) => a.from.address === BigInt(x.fromAddress) && BigInt(x.toAddress) === a.to.address && addressString(a.token.address) === x.currentTokenAddress)
		const indexOfB = route.findIndex((x) => b.from.address === BigInt(x.fromAddress) && BigInt(x.toAddress) === b.to.address && addressString(b.token.address) === x.currentTokenAddress)
		const v = (indexOfA >= 0 ? indexOfA : route.length + tokenEvents.indexOf(a) ) - (indexOfB >= 0 ? indexOfB : route.length + tokenEvents.indexOf(b))
		return v
	}

	const sorted = [ ...tokenEvents ].sort(sortAccordingArrayIfNotMaintainOrder)

	return sorted
}

export function getSwapName(identifiedSwap: IdentifiedSwapWithMetadata) {
	if (identifiedSwap === false) return undefined
	const sent = identifiedSwap.sendAsset.token.symbol
	const to = identifiedSwap.receiveAsset.token.symbol
	return `Swap ${ sent } for ${ to }`
}

function VisualizeSwapAsset({ swapAsset, renameAddressCallBack }: { swapAsset: SwapAsset, renameAddressCallBack: RenameAddressCallBack }) {
	const tokenStyle = { 'font-weight': '500' }
	const balanceTextStyle = { 'font-size': '14px', color: 'var(--subtitle-text-color)' }

	switch (swapAsset.type) {
		case 'ERC721': {
			return <span class = 'grid swap-grid-1'>
				<div class = 'log-cell-flexless' style = 'justify-content: center; display: flex;'>
					<TokenSymbol
						tokenEntry = { swapAsset.token }
						tokenId = { swapAsset.tokenId }
						useFullTokenName = { false }
						style = { tokenStyle }
						renameAddressCallBack = { renameAddressCallBack }
						fontSize = 'big'
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
							fontSize = 'big'
						/>
					</div>
				</span>
				<span class = 'grid swap-grid'>
					<div class = 'log-cell'/>
					{ swapAsset.beforeAfterBalance !== undefined ? <div class = 'log-cell' style = 'justify-content: right;'>
						<p class = 'paragraph' style = { balanceTextStyle }>Balance:&nbsp;</p>
						<TokenOrEthValue tokenEntry = { swapAsset.token } amount = { swapAsset.beforeAfterBalance?.beforeBalance } style = { balanceTextStyle } fontSize = 'normal'/>
						<p class = 'paragraph' style = { balanceTextStyle }>&nbsp;{'->'}&nbsp;</p>
						<TokenOrEthValue tokenEntry = { swapAsset.token } amount = { swapAsset.beforeAfterBalance?.afterBalance } style = { balanceTextStyle } fontSize = 'normal'/>
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
							fontSize = 'big'
						/>
					</div>
					<div class = 'log-cell' style = 'justify-content: right;'>
						<TokenSymbol
							tokenEntry = { swapAsset.token }
							useFullTokenName = { false }
							style = { tokenStyle }
							renameAddressCallBack = { renameAddressCallBack }
							fontSize = 'big'
						/>
					</div>
				</span>
				<span class = 'grid swap-grid'>
					<div style = { { display: 'flex', justifyContent: 'left' } }>
						{ swapAsset.tokenPriceEstimate !== undefined && swapAsset.tokenPriceEstimateQuoteToken !== undefined ? <>
							<p style = { balanceTextStyle }>(</p>
							<TokenPrice
								amount = { swapAsset.amount }
								tokenPriceEstimate = { swapAsset.tokenPriceEstimate }
								style = { balanceTextStyle }
								quoteTokenEntry = { swapAsset.tokenPriceEstimateQuoteToken }
								renameAddressCallBack = { renameAddressCallBack }
							/>
							<p style = { balanceTextStyle }>)</p>
						</> : <></> }
					</div>
					{ swapAsset.beforeAfterBalance !== undefined ? <div class = 'log-cell' style = 'justify-content: right;'>
						<p class = 'paragraph' style = { balanceTextStyle }>Balance:&nbsp;</p>
						<TokenOrEthValue tokenEntry = { swapAsset.token } amount = { swapAsset.beforeAfterBalance?.beforeBalance } style = { balanceTextStyle } fontSize = 'normal'/>
						<p class = 'paragraph' style = { balanceTextStyle }>&nbsp;{'->'}&nbsp;</p>
						<TokenOrEthValue tokenEntry = { swapAsset.token } amount = { swapAsset.beforeAfterBalance?.afterBalance } style = { balanceTextStyle } fontSize = 'normal'/>
					</div> : <></>
					}
				</span>
			</>
		}
		default: assertNever(swapAsset)
	}
}

export function SwapVisualization(param: SwapVisualizationParams) {
	if (param.identifiedSwap === false) return <></>

	return <div class = 'notification transaction-importance-box'>
		<div style = 'display: grid; grid-template-rows: max-content max-content max-content max-content;'>
			<p class = 'paragraph'> Swap </p>
			<div class = 'box swap-box'>
				<VisualizeSwapAsset swapAsset = { param.identifiedSwap.sendAsset } renameAddressCallBack = { param.renameAddressCallBack } />
			</div>
			<p class = 'paragraph'> For </p>
			<div class = 'box swap-box'>
				<VisualizeSwapAsset swapAsset = { param.identifiedSwap.receiveAsset } renameAddressCallBack = { param.renameAddressCallBack } />
			</div>
		</div>
	</div>
}
