import { AddressMetadata, SimulatedAndVisualizedTransaction, TokenVisualizerResult } from '../../utils/visualizer-types.js'
import * as funtypes from 'funtypes'
import { EthereumAddress, EthereumQuantity } from '../../utils/wire-types.js'
import { abs, addressString } from '../../utils/bigint.js'
import { ERC721Token, Ether, getTokenData, Token } from '../subcomponents/coins.js'
import { CHAIN } from '../../utils/user-interface-types.js'

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

interface SwapVisualizationParams {
	identifiedSwap: IdentifiedSwap,
	addressMetadata: Map<string, AddressMetadata>,
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

type Graph = Map<string, Map<string | undefined, {to: string, tokenResultIndex: number | undefined } > > // from, tokenaddress (undefined for ether), to
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

export function identifyRoutes(simulatedAndVisualizedTransaction: SimulatedAndVisualizedTransaction, identifiedSwap: IdentifiedSwap) {
	if ( identifiedSwap === false ) return false
	if (simulatedAndVisualizedTransaction.simResults?.visualizerResults === undefined) return false
	const tokenResults = simulatedAndVisualizedTransaction.simResults.visualizerResults.tokenResults
	const ethBalanceChanges = simulatedAndVisualizedTransaction.simResults.visualizerResults.ethBalanceChanges
	console.log(tokenResults)
	console.log(ethBalanceChanges)
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
			console.log('token multihop!')
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
			console.log('eth multihop!')
			return false
		}
	}
	Map<string, Map<string | undefined, {to: string, tokenResultIndex: number | undefined } > >
	// traverse chain
	const startToken = 'tokenAddressSent' in identifiedSwap ? addressString(identifiedSwap.tokenAddressSent) : undefined
	const endToken = 'tokenAddressReceived' in identifiedSwap ? addressString(identifiedSwap.tokenAddressReceived) : undefined
	const lastIndex = endToken !== undefined ? tokenResults.findIndex( ( x ) => (x.to === identifiedSwap.sender && x.tokenAddress === BigInt(endToken) ) ) : -1
	const routes = [...findSwapRoutes(graph,
		{
			fromAddress: addressString(identifiedSwap.sender),
			toAddress: addressString(identifiedSwap.sender),
			tokenResultIndex: graph.get(addressString(identifiedSwap.sender))?.get(startToken)?.tokenResultIndex,
			currentTokenAddress: startToken
		},
		{
			fromAddress: addressString(identifiedSwap.sender),
			toAddress: addressString(identifiedSwap.sender),
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
	console.log(tokenResults)
	const route = uniqByKeepFirst(routes.flat())
	route.forEach( function(x) {
		console.log(x.fromAddress + ' : ' + x.toAddress +' via ' + x.currentTokenAddress)
	})

	if ( route.length === 0) return false

	function sortAccordingArrayIfNotMaintainOrder(a: TokenVisualizerResult, b: TokenVisualizerResult) {
		const indexOfA = route.findIndex( (x) => a.from === BigInt(x.fromAddress) && BigInt(x.toAddress) === a.to && addressString(a.tokenAddress) === x.currentTokenAddress )
		const indexOfB = route.findIndex( (x) => b.from === BigInt(x.fromAddress) && BigInt(x.toAddress) === b.to && addressString(b.tokenAddress) === x.currentTokenAddress )
		const v =  (indexOfA >= 0 ? indexOfA : route.length + tokenResults.indexOf(a) ) - (indexOfB >= 0 ? indexOfB : route.length + tokenResults.indexOf(b))

		console.log('search')
		console.log(addressString(a.from) + ' : ' + addressString(a.to) +' via ' + addressString(a.tokenAddress))
		console.log(addressString(b.from) + ' : ' + addressString(b.to) +' via ' + addressString(b.tokenAddress))
		console.log(indexOfA)
		console.log(indexOfB)
		console.log(v)

		return v
	}

	const sorted = [ ...tokenResults ].sort(sortAccordingArrayIfNotMaintainOrder)
	console.log(sorted)

	return sorted
}

export function getSwapName(identifiedSwap: IdentifiedSwap, addressMetaData: Map<string, AddressMetadata>) {
	if ( identifiedSwap === false ) return undefined
	const SwapFrom = identifiedSwap.type === 'TokenToToken' || identifiedSwap.type === 'TokenToETH' ? getTokenData(identifiedSwap.tokenAddressSent, addressMetaData.get(addressString(identifiedSwap.tokenAddressSent))).symbol : 'ETH'
	const SwapTo = identifiedSwap.type === 'TokenToToken' || identifiedSwap.type === 'ETHToToken' ? getTokenData(identifiedSwap.tokenAddressReceived, addressMetaData.get(addressString(identifiedSwap.tokenAddressReceived))).symbol : 'ETH'
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
							token = { param.identifiedSwap.tokenAddressSent }
							addressMetadata = { param.addressMetadata.get(addressString(param.identifiedSwap.tokenAddressSent)) }
							useFullTokenName = { false }
							received = { false }
						/>
						:
						<Token
							amount = { param.identifiedSwap.tokenAmountSent }
							token = { param.identifiedSwap.tokenAddressSent }
							addressMetadata = { param.addressMetadata.get(addressString(param.identifiedSwap.tokenAddressSent)) }
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
							token = { param.identifiedSwap.tokenAddressReceived }
							addressMetadata = { param.addressMetadata.get(addressString(param.identifiedSwap.tokenAddressReceived)) }
							useFullTokenName = { false }
							received = { false }
						/>
						:
						<Token
							amount = { param.identifiedSwap.tokenAmountReceived }
							token = { param.identifiedSwap.tokenAddressReceived }
							addressMetadata = { param.addressMetadata.get(addressString(param.identifiedSwap.tokenAddressReceived)) }
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
