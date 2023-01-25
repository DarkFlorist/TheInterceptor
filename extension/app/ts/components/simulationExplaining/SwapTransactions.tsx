import { SimulatedAndVisualizedTransaction, TokenVisualizerResult, TokenVisualizerResultWithMetadata } from '../../utils/visualizer-types.js'
import * as funtypes from 'funtypes'
import { EthereumQuantity } from '../../utils/wire-types.js'
import { abs, addressString } from '../../utils/bigint.js'
import { ERC721Token, Ether, Token } from '../subcomponents/coins.js'
import { AddressBookEntry, CHAIN, NFTEntry, TokenEntry } from '../../utils/user-interface-types.js'
import { CHAINS } from '../../utils/constants.js'

export type IdentifiedSwapWithMetadata = funtypes.Static<typeof IdentifiedSwapWithMetadata>
export const IdentifiedSwapWithMetadata = funtypes.Union(
	funtypes.Literal(false), // not a swap
	funtypes.Intersect(
		funtypes.Object({
			type: funtypes.Literal('TokenToToken'),
			sender: AddressBookEntry,
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

function dropDuplicates<T>(array: T[], isEqual: (a: T, b: T) => boolean): T[] {
    const result: T[] = [];
    for (const item of array) {
        const found = result.some((value) => isEqual(value, item));
        if (!found) {
            result.push(item);
        }
    }
    return result;
}

export function identifySwap(transaction: SimulatedAndVisualizedTransaction): IdentifiedSwapWithMetadata {
	const sender = transaction.from.address

	for (const tokenTransaction of transaction.tokenResults) {
		if (tokenTransaction.isApproval && tokenTransaction.from.address === sender) return false // if the transaction includes us approving something, its not a simple swap
	}

	// check if sender sends one token type/ether and receives one token type/ether

	const tokensSent = transaction.tokenResults.filter( (token) => token.from.address === sender)
	const tokensReceived = transaction.tokenResults.filter( (token) => token.to.address === sender)

	if (tokensReceived.length > 1) return false // received more than one token
	if (tokensSent.length > 1) return false // sent more than one token

	const isSameTokenAddress = (a: TokenVisualizerResultWithMetadata, b: TokenVisualizerResultWithMetadata) => a.token.address === b.token.address

	const tokenAddressesSent = dropDuplicates<TokenVisualizerResultWithMetadata>(tokensSent, isSameTokenAddress).map((x) => x.token)
	const tokenAddressesReceived = dropDuplicates<TokenVisualizerResultWithMetadata>(tokensReceived, isSameTokenAddress).map((x) => x.token)

	const etherChange = transaction.ethBalanceChanges.filter( (x) => x.address.address === sender)
	const ethDiff = etherChange !== undefined && etherChange.length >= 1 ? etherChange[etherChange.length - 1].after - etherChange[0].before : 0n

	const transactionGasCost = transaction.realizedGasPrice * transaction.gas

	if (tokenAddressesSent.length === 1 && tokenAddressesReceived.length === 1 && -ethDiff <= transactionGasCost) {
		// user swapped one token to another and eth didn't change more than gas fees
		const tokenAddressSent = Array.from(tokenAddressesSent.values())[0]
		const tokenAddressReceived = Array.from(tokenAddressesReceived.values())[0]
		if (tokenAddressSent !== tokenAddressReceived ) {
			const sentData = tokensSent.filter( (x) => x.token.address === tokenAddressSent.address )[0]
			const receivedData = tokensReceived.filter( (x) => x.token.address === tokenAddressReceived.address )[0]
			return {
				type: 'TokenToToken' as const,
				sender: transaction.from,
				...(tokenAddressSent.type === 'NFT' ? {
					tokenAddressSent: tokenAddressSent,
					tokenIdSent: 'tokenId' in sentData ? sentData.tokenId : 0x0n,
				} : {
					tokenAddressSent: tokenAddressSent,
					tokenAmountSent: 'amount' in sentData ?  sentData.amount : 0x0n,
				}),
				...(tokenAddressReceived.type === 'NFT' ? {
					tokenAddressReceived: tokenAddressReceived,
					tokenIdReceived: 'tokenId' in receivedData ? receivedData.tokenId : 0x0n,
				} : {
					tokenAddressReceived: tokenAddressReceived,
					tokenAmountReceived: 'amount' in receivedData ? receivedData.amount : 0x0n,
				}),
			}
		}
	}

	if (tokenAddressesSent.length === 1 && tokenAddressesReceived.length === 0 && ethDiff > 0n ) {
		// user sold token for eth
		const tokenAddressSent = Array.from(tokenAddressesSent.values())[0]
		const sentData = tokensSent.filter( (x) => x.token.address === tokenAddressSent.address )[0]
		return {
			type: 'TokenToETH' as const,
			sender: transaction.from,
			...(tokenAddressSent.type === 'NFT' ? {
				tokenIdSent: 'tokenId' in sentData ? sentData.tokenId : 0x0n,
				tokenAddressSent,
			} : {
				tokenAmountSent: 'amount' in sentData ? sentData.amount : 0x0n,
				tokenAddressSent,
			}),
			ethAmountReceived: ethDiff,
		}
	}

	if( tokenAddressesSent.length === 0 && tokenAddressesReceived.length === 1 && ethDiff < transactionGasCost ) {
		// user bought token with eth
		const tokenAddressReceived = Array.from(tokenAddressesReceived.values())[0]
		const receivedData = tokensReceived.filter( (x) => x.token.address === tokenAddressReceived.address )[0]
		return {
			type: 'ETHToToken' as const,
			sender: transaction.from,
			ethAmountSent: -ethDiff,
			tokenAmountReceived: 'amount' in receivedData ? receivedData.amount : 0n,
			...(tokenAddressReceived.type === 'NFT' ? {
				tokenIdReceived: 'tokenId' in receivedData ? receivedData.tokenId : 0x0n,
				tokenAddressReceived,
			} : {
				tokenAmountReceived: 'amount' in receivedData ? receivedData.amount : 0x0n,
				tokenAddressReceived,
			}),
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
	const tokenResults = simulatedAndVisualizedTransaction.tokenResults
	const ethBalanceChanges = simulatedAndVisualizedTransaction.ethBalanceChanges
	if ( tokenResults.length > 10 ) return false // too complex

	const graph: Graph = new Map()
	const transactionGasCost = simulatedAndVisualizedTransaction.realizedGasPrice * simulatedAndVisualizedTransaction.gas

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

export function getSwapName(identifiedSwap: IdentifiedSwapWithMetadata, chain: CHAIN) {
	if ( identifiedSwap === false ) return undefined
	const sent = 'tokenAddressSent' in identifiedSwap ? identifiedSwap.tokenAddressSent.symbol : CHAINS[chain].currencyTicker
	const to = 'tokenAddressReceived' in identifiedSwap ? identifiedSwap.tokenAddressReceived.symbol : CHAINS[chain].currencyTicker
	return `Swap ${ sent } for ${ to }`
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
