import { SimulatedAndVisualizedTransaction, TokenVisualizerResult, TokenVisualizerResultWithMetadata } from '../../utils/visualizer-types.js'
import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity } from '../../utils/wire-types.js'
import { abs, addressString } from '../../utils/bigint.js'
import { ERC721Token, Ether, Token } from '../subcomponents/coins.js'
import { AddressBookEntry, CHAIN, NFTEntry, TokenEntry } from '../../utils/user-interface-types.js'

export type IdentifiedSwap = funtypes.Static<typeof IdentifiedSwap>
export const IdentifiedSwap = funtypes.Union(
	funtypes.Literal(false), // not a swap
	funtypes.Intersect(
		funtypes.Object({
			type: funtypes.Literal('TokenToToken'),
			sender: EthereumAddress,
			tokenAddressSent: EthereumAddress,
			tokenAddressReceived: EthereumAddress,
		} ),
		funtypes.Union(
			funtypes.Object( { tokenAmountSent: EthereumQuantity } ),
			funtypes.Object( { tokenIdSent: EthereumQuantity } )
		),
		funtypes.Union(
			funtypes.Object( { tokenAmountReceived: EthereumQuantity } ),
			funtypes.Object( { tokenIdReceived: EthereumQuantity } )
		),
	),
	funtypes.Intersect(
		funtypes.Object({
			type: funtypes.Literal('TokenToETH'),
			sender: EthereumAddress,
			tokenAddressSent: EthereumAddress,
			ethAmountReceived: EthereumQuantity,
		}),
		funtypes.Union(
			funtypes.Object( { tokenAmountSent: EthereumQuantity } ),
			funtypes.Object( { tokenIdSent: EthereumQuantity } )
		),
	),
	funtypes.Intersect(
		funtypes.Object({
			type: funtypes.Literal('ETHToToken'),
			sender: EthereumAddress,
			tokenAddressReceived: EthereumAddress,
			ethAmountSent: EthereumQuantity
		}),
		funtypes.Union(
			funtypes.Object( { tokenAmountReceived: EthereumQuantity } ),
			funtypes.Object( { tokenIdReceived: EthereumQuantity } )
		),
	)
)

export type IdentifiedSwapWithMetadata = funtypes.Static<typeof IdentifiedSwapWithMetadata>
export const IdentifiedSwapWithMetadata = funtypes.Union(
	funtypes.Literal(false), // not a swap
	funtypes.Intersect(
		funtypes.Object({
			type: funtypes.Literal('TokenToToken'),
			sender: AddressBookEntry,
			tokenAddressSent: EthereumAddress,
			tokenAddressReceived: EthereumAddress,
		} ),
		funtypes.Union(
			funtypes.Object( { tokenAmountSent: EthereumQuantity, tokenAddressSent: TokenEntry } ),
			funtypes.Object( { tokenIdSent: EthereumQuantity, tokenAddressSent: NFTEntry } )
		),
		funtypes.Union(
			funtypes.Object( { tokenAmountReceived: EthereumQuantity, tokenAddressReceived: TokenEntry } ),
			funtypes.Object( { tokenIdReceived: EthereumQuantity, tokenAddressReceived: NFTEntry } )
		),
	),
	funtypes.Intersect(
		funtypes.Object({
			type: funtypes.Literal('TokenToETH'),
			sender: AddressBookEntry,
			ethAmountReceived: EthereumQuantity,
		}),
		funtypes.Union(
			funtypes.Object( { tokenAmountSent: EthereumQuantity, tokenAddressSent: TokenEntry } ),
			funtypes.Object( { tokenIdSent: EthereumQuantity, tokenAddressSent: NFTEntry } )
		),
	),
	funtypes.Intersect(
		funtypes.Object({
			type: funtypes.Literal('ETHToToken'),
			sender: AddressBookEntry,
			ethAmountSent: EthereumQuantity
		}),
		funtypes.Union(
			funtypes.Object( { tokenAmountReceived: EthereumQuantity, tokenAddressReceived: TokenEntry } ),
			funtypes.Object( { tokenIdReceived: EthereumQuantity, tokenAddressReceived: NFTEntry } )
		),
	)
)

interface SwapVisualizationParams {
	identifiedSwap: IdentifiedSwapWithMetadata,
	chain: CHAIN
}

export function identifySwap(simulatedAndVisualizedTransaction: SimulatedAndVisualizedTransaction): IdentifiedSwap {
	if (simulatedAndVisualizedTransaction.simResults === undefined) return false
	if (simulatedAndVisualizedTransaction.simResults.visualizerResults === undefined) return false
	const visualizerResults = simulatedAndVisualizedTransaction.simResults.visualizerResults

	const sender = simulatedAndVisualizedTransaction.unsignedTransaction.from

	for (const tokenTransaction of visualizerResults.tokenResults) {
		if (tokenTransaction.isApproval && tokenTransaction.from === sender) return false // if the transaction includes us approving something, its not a simple swap
	}

	// check if sender sends one token type/ether and receives one token type/ether

	const tokensSent = visualizerResults.tokenResults.filter( (token) => token.from === sender)
	const tokensReceived = visualizerResults.tokenResults.filter( (token) => token.to === sender)

	if (tokensReceived.length > 1) return false // received more than one token
	if (tokensSent.length > 1) return false // sent more than one token

	const tokenAddressesSent = new Set(tokensSent.map( (token) => token.tokenAddress))
	const tokenAddressesReceived = new Set(tokensReceived.map( (token) => token.tokenAddress))

	const etherChange = visualizerResults.ethBalanceChanges.filter( (x) => x.address === sender)
	const ethDiff = etherChange !== undefined && etherChange.length >= 1 ? etherChange[etherChange.length - 1].after - etherChange[0].before : 0n

	const transactionGasCost = simulatedAndVisualizedTransaction.realizedGasPrice * simulatedAndVisualizedTransaction.unsignedTransaction.gas

	if( tokenAddressesSent.size === 1 && tokenAddressesReceived.size === 1 && -ethDiff <= transactionGasCost) {
		// user swapped one token to another and eth didn't change more than gas fees
		const tokenAddressSent = Array.from(tokenAddressesSent.values())[0]
		const tokenAddressReceived = Array.from(tokenAddressesReceived.values())[0]
		if(tokenAddressSent !== tokenAddressReceived ) {
			const sentData = tokensSent.filter( (x) => x.tokenAddress === tokenAddressSent )[0]
			const receivedData = tokensReceived.filter( (x) => x.tokenAddress === tokenAddressReceived )[0]
			return {
				type: 'TokenToToken' as const,
				sender: sender,
				tokenAddressSent,
				...(sentData.is721 ? { tokenIdSent: 'tokenId' in sentData ? sentData.tokenId : 0x0n } : { tokenAmountSent: 'amount' in sentData ?  sentData.amount : 0x0n }),
				tokenAddressReceived,
				...(receivedData.is721 ? { tokenIdReceived: 'tokenId' in receivedData ? receivedData.tokenId : 0x0n } : { tokenAmountReceived: 'amount' in receivedData ? receivedData.amount : 0x0n }),
			}
		}
	}

	if( tokenAddressesSent.size === 1 && tokenAddressesReceived.size === 0 && ethDiff > 0n ) {
		// user sold token for eth
		const tokenAddressSent = Array.from(tokenAddressesSent.values())[0]
		const sentData = tokensSent.filter( (x) => x.tokenAddress === tokenAddressSent )[0]
		return {
			type: 'TokenToETH' as const,
			sender: sender,
			tokenAddressSent,
			...(sentData.is721 ? { tokenIdSent: 'tokenId' in sentData ? sentData.tokenId : 0x0n } : { tokenAmountSent: 'amount' in sentData ?  sentData.amount : 0x0n }),
			ethAmountReceived: ethDiff,
		}
	}

	if( tokenAddressesSent.size === 0 && tokenAddressesReceived.size === 1 && ethDiff < transactionGasCost ) {
		// user bought token with eth
		const tokenAddressReceived = Array.from(tokenAddressesReceived.values())[0]
		const receivedData = tokensReceived.filter( (x) => x.tokenAddress === tokenAddressReceived )[0]
		return {
			type: 'ETHToToken' as const,
			sender: sender,
			tokenAddressReceived,
			ethAmountSent: -ethDiff,
			tokenAmountReceived: 'amount' in receivedData ? receivedData.amount : 0n,
			...(receivedData.is721 ? { tokenIdReceived: 'tokenId' in receivedData ? receivedData.tokenId : 0x0n } : { tokenAmountReceived: 'amount' in receivedData ? receivedData.amount : 0x0n }),
		}
	}

	return false
}

type Graph = Map<AddressBookEntry, Map<AddressBookEntry | undefined, {to: AddressBookEntry, tokenResultIndex: number | undefined } > > // from, tokenaddress (undefined for ether), to
interface State {
	fromAddress: AddressBookEntry,
	toAddress: AddressBookEntry,
	currentTokenAddress: AddressBookEntry | undefined, // undefined for ether
	tokenResultIndex: number | undefined,
}

interface EthTradePair {
	fromAddress: AddressBookEntry,
	toAddress: AddressBookEntry,
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
	if (simulatedAndVisualizedTransaction.simResults?.visualizerResults === undefined) return false
	const tokenResults = simulatedAndVisualizedTransaction.simResults.visualizerResults.tokenResults
	const ethBalanceChanges = simulatedAndVisualizedTransaction.simResults.visualizerResults.ethBalanceChanges
	if ( tokenResults.length > 10 ) return false // too complex

	const graph: Graph = new Map()
	const transactionGasCost = simulatedAndVisualizedTransaction.realizedGasPrice * simulatedAndVisualizedTransaction.unsignedTransaction.gas

	// build search graph
	for (const [tokenResultIndex, result] of tokenResults.entries()) {
		const fromAddress = addressString(result.from)
		const toAddress = addressString(result.to)
		const tokenAddress = addressString(result.tokenAddress)
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
		const address = addressString(result.address)
		const delta = result.after - result.before
		for (const compareTo of ethBalanceChanges) {
			const compareToAddress = addressString(compareTo.address)
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
	const startToken = 'tokenAddressSent' in identifiedSwap ? identifiedSwap.tokenAddressSent : undefined
	const endToken = 'tokenAddressReceived' in identifiedSwap ? identifiedSwap.tokenAddressReceived : undefined
	const lastIndex = endToken !== undefined ? tokenResults.findIndex( ( x ) => (x.to === identifiedSwap.sender.address && x.tokenAddress === BigInt(endToken.address) ) ) : -1
	const routes = [...findSwapRoutes(graph,
		{
			from: identifiedSwap.sender.address,
			to: identifiedSwap.sender,
			tokenResultIndex: graph.get(addressString(identifiedSwap.sender.address))?.get(startToken?.address)?.tokenResultIndex,
			currentTokenAddress: startToken?.address === undefined ? undefined : addressString(startToken.address)
		},
		{
			from: identifiedSwap.sender,
			to: identifiedSwap.sender,
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

	function sortAccordingArrayIfNotMaintainOrder(a: TokenVisualizerResult, b: TokenVisualizerResult) {
		const indexOfA = route.findIndex( (x) => a.from === BigInt(x.fromAddress) && BigInt(x.toAddress) === a.to && addressString(a.tokenAddress) === x.currentTokenAddress )
		const indexOfB = route.findIndex( (x) => b.from === BigInt(x.fromAddress) && BigInt(x.toAddress) === b.to && addressString(b.tokenAddress) === x.currentTokenAddress )
		const v =  (indexOfA >= 0 ? indexOfA : route.length + tokenResults.indexOf(a) ) - (indexOfB >= 0 ? indexOfB : route.length + tokenResults.indexOf(b))
		return v
	}

	const sorted = [ ...tokenResults ].sort(sortAccordingArrayIfNotMaintainOrder)

	return sorted
}

export function getSwapName(identifiedSwap: IdentifiedSwap, addressMetadata: Map<string, AddressBookEntry>) {
	if ( identifiedSwap === false ) return undefined
	const sentTokenMetadata = 'tokenAddressSent' in identifiedSwap ? addressMetadata.get(addressString(identifiedSwap.tokenAddressSent)) : undefined
	const receivedTokenMetadata = 'tokenAddressReceived' in identifiedSwap ? addressMetadata.get(addressString(identifiedSwap.tokenAddressReceived)) : undefined

	const SwapFrom = identifiedSwap.type === 'TokenToToken' || identifiedSwap.type === 'TokenToETH' ? (sentTokenMetadata !== undefined && 'symbol' in sentTokenMetadata ? sentTokenMetadata.symbol : '???' ) : 'ETH'
	const SwapTo = identifiedSwap.type === 'TokenToToken' || identifiedSwap.type === 'ETHToToken' ? (receivedTokenMetadata !== undefined && 'symbol' in receivedTokenMetadata ? receivedTokenMetadata.symbol : '???' ) : 'ETH'
	return `Swap ${ SwapFrom } for ${ SwapTo }`
}

export function SwapVisualization(param: SwapVisualizationParams) {

	if ( param.identifiedSwap === false ) return <></>
	return <div class = 'vertical-center' style = 'color: var(--text-color); padding-top: 5px; justify-content: center;' >
		<p style = { `color: var(--text-color); display: inline-block` }>
			Swap&nbsp;
			<div class = 'box' style = 'padding: 4px; background-color: var(--highlighted-primary-color); box-shadow: unset; margin-bottom: 0px; display: inherit;'>
				{ param.identifiedSwap.type === 'TokenToToken' || param.identifiedSwap.type === 'TokenToETH' ?
					'tokenIdSent' in param.identifiedSwap ?
						<ERC721Token
							tokenId = { param.identifiedSwap.tokenIdSent }
							tokenName = { param.identifiedSwap.tokenAddressSent.name }
							tokenAddress = { param.identifiedSwap.tokenAddressSent.address }
							tokenSymbol = { param.identifiedSwap.tokenAddressSent.symbol }
							tokenLogoUri = { param.identifiedSwap.tokenAddressSent.logoUri }
							useFullTokenName = { false }
							received = { false }
						/>
						:
						<Token
							amount = { param.identifiedSwap.tokenAmountSent }
							tokenName = { param.identifiedSwap.tokenAddressSent.name }
							tokenAddress = { param.identifiedSwap.tokenAddressSent.address }
							tokenSymbol = { param.identifiedSwap.tokenAddressSent.symbol }
							tokenLogoUri = { param.identifiedSwap.tokenAddressSent.logoUri }
							tokenDecimals = { param.identifiedSwap.tokenAddressSent.decimals }
							useFullTokenName = { false }
						/>
				: <Ether
					amount = { param.identifiedSwap.ethAmountSent }
					chain = { param.chain }
				/>
				}
			</div>
			&nbsp;for&nbsp;
			<div class = 'box' style = 'padding: 4px; background-color: var(--highlighted-primary-color); box-shadow: unset; display: inherit;'>
				{ param.identifiedSwap.type === 'TokenToToken' || param.identifiedSwap.type === 'ETHToToken' ?
					'tokenIdReceived' in param.identifiedSwap ?
						<ERC721Token
							tokenId = { param.identifiedSwap.tokenIdReceived }
							tokenName = { param.identifiedSwap.tokenAddressReceived.name }
							tokenAddress = { param.identifiedSwap.tokenAddressReceived.address }
							tokenSymbol = { param.identifiedSwap.tokenAddressReceived.symbol }
							tokenLogoUri = { param.identifiedSwap.tokenAddressReceived.logoUri }
							useFullTokenName = { false }
							received = { false }
						/>
						:
						<Token
							amount = { param.identifiedSwap.tokenAmountReceived }
							tokenName = { param.identifiedSwap.tokenAddressReceived.name }
							tokenAddress = { param.identifiedSwap.tokenAddressReceived.address }
							tokenSymbol = { param.identifiedSwap.tokenAddressReceived.symbol }
							tokenLogoUri = { param.identifiedSwap.tokenAddressReceived.logoUri }
							tokenDecimals = { param.identifiedSwap.tokenAddressReceived.decimals }
							useFullTokenName = { false }
						/>
				: <Ether
					amount = { param.identifiedSwap.ethAmountReceived }
					chain = { param.chain }
				/>
				}
			</div>
		</p>
	</div>
}
