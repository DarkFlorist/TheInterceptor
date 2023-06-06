import { SimulatedAndVisualizedTransaction, TokenVisualizerERC20Event, TokenVisualizerERC721Event, TokenVisualizerResultWithMetadata } from '../../utils/visualizer-types.js'
import * as funtypes from 'funtypes'
import { EthereumQuantity } from '../../utils/wire-types.js'
import { abs, addressString } from '../../utils/bigint.js'
import { ERC721TokenNumber, EtherAmount, EtherSymbol, TokenAmount, TokenOrEthValue, TokenSymbol } from '../subcomponents/coins.js'
import { AddressBookEntry, CHAIN, NFTEntry, TokenEntry } from '../../utils/user-interface-types.js'
import { CHAINS } from '../../utils/constants.js'
import { assertNever } from '../../utils/typescript.js'

export type BeforeAfterBalance = funtypes.Static<typeof SwapAsset>
export const BeforeAfterBalance = funtypes.ReadonlyObject({
	previousBalance: EthereumQuantity,
	afterBalance: EthereumQuantity,
})

export type SwapAsset = funtypes.Static<typeof SwapAsset>
export const SwapAsset = funtypes.Intersect(
	funtypes.Union(
		funtypes.ReadonlyObject({
			type: funtypes.Literal('Token'),
			amount: EthereumQuantity,
			tokenAddress: TokenEntry,
			beforeAfterBalance: funtypes.Union(BeforeAfterBalance, funtypes.Undefined),
		}),
		funtypes.ReadonlyObject({
			type: funtypes.Literal('NFT'),
			tokenId: EthereumQuantity,
			tokenAddress: NFTEntry,
		}),
		funtypes.ReadonlyObject({
			type: funtypes.Literal('Ether'),
			amount: EthereumQuantity,
			beforeAfterBalance: funtypes.Union(BeforeAfterBalance, funtypes.Undefined),
		}),
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
export function formSwapAsset(tokenResult: TokenVisualizerERC20Event[] | TokenVisualizerERC721Event, sendBalanceAfter: bigint | undefined): SwapAsset {
	if (Array.isArray(tokenResult)) {
		const total = tokenResult.reduce((total, current) => total + current.amount, 0n)
		return {
			type: 'Token',
			tokenAddress: tokenResult[0].token,
			amount: total,
			beforeAfterBalance: sendBalanceAfter !== undefined
				? {
					previousBalance: sendBalanceAfter - total,
					afterBalance: sendBalanceAfter
				}
				: undefined
		}
	} else {
		return {
			type: 'NFT',
			tokenAddress: tokenResult.token,
			tokenId: tokenResult.tokenId
		}
	}
}

export function identifySwap(simTransaction: SimulatedAndVisualizedTransaction): IdentifiedSwapWithMetadata {
	const sender = simTransaction.transaction.from.address

	for (const tokenTransaction of simTransaction.tokenResults) {
		if (tokenTransaction.isApproval && tokenTransaction.from.address === sender) return false // if the transaction includes us approving something, its not a simple swap
	}

	// check if sender sends one token type/ether and receives one token type/ether

	const tokensSent = simTransaction.tokenResults.filter((token): token is TokenVisualizerERC20Event | TokenVisualizerERC721Event => token.from.address === sender && !token.isApproval)
	const tokensReceived = simTransaction.tokenResults.filter((token): token is TokenVisualizerERC20Event | TokenVisualizerERC721Event => token.to.address === sender && !token.isApproval)

	const nftsSent = tokensSent.reduce((total, current) => total + (current.type === 'NFT' ? 1 : 0), 0)
	const nftsReceived = tokensSent.reduce((total, current) => total + (current.type === 'NFT' ? 1 : 0), 0)
	if (nftsSent > 1 || nftsReceived > 1) return false //its not a pure 1 to 1 swap if we get multiple NFT's

	const isSameTokenAddress = (a: TokenVisualizerResultWithMetadata, b: TokenVisualizerResultWithMetadata) => a.token.address === b.token.address

	const tokenAddressesSent = dropDuplicates<TokenVisualizerResultWithMetadata>(tokensSent, isSameTokenAddress).map((x) => x.token)
	const tokenAddressesReceived = dropDuplicates<TokenVisualizerResultWithMetadata>(tokensReceived, isSameTokenAddress).map((x) => x.token)

	const etherChange = simTransaction.ethBalanceChanges.filter((x) => x.address.address === sender)
	const ethDiff = etherChange !== undefined && etherChange.length >= 1 ? etherChange[etherChange.length - 1].after - etherChange[0].before : 0n

	const transactionGasCost = simTransaction.realizedGasPrice * simTransaction.transaction.gas

	if (tokenAddressesSent.length === 1 && tokenAddressesReceived.length === 1 && -ethDiff <= transactionGasCost) {
		// user swapped one token to another and eth didn't change more than gas fees
		const sentToken = tokenAddressesSent[0]
		const receiveToken = tokenAddressesReceived[0]
		if (sentToken.address !== receiveToken.address) {
			const sendBalanceAfter = simTransaction.tokenBalancesAfter.find((balance) => balance.owner === simTransaction.transaction.from.address && balance.token === sentToken.address)?.balance
			const receiveBalanceAfter = simTransaction.tokenBalancesAfter.find((balance) => balance.owner === simTransaction.transaction.from.address && balance.token === receiveToken.address)?.balance
			return {
				sender: simTransaction.transaction.from,
				sendAsset: formSwapAsset(tokensSent[0].type === 'NFT' ? tokensSent[0] : tokensSent.filter((token): token is TokenVisualizerERC20Event => token.type === 'Token'), sendBalanceAfter),
				receiveAsset: formSwapAsset(tokensReceived[0].type === 'NFT' ? tokensReceived[0] : tokensReceived.filter((token): token is TokenVisualizerERC20Event => token.type === 'Token'), receiveBalanceAfter),
			}
		}
	}

	if (tokenAddressesSent.length === 1 && tokenAddressesReceived.length === 0 && ethDiff > 0n ) {
		// user sold token for eth
		const tokenAddressSent = Array.from(tokenAddressesSent.values())[0]
		const sendBalanceAfter = simTransaction.tokenBalancesAfter.find((balance) => balance.owner === simTransaction.transaction.from.address && balance.token === tokenAddressSent.address)?.balance
		return {
			sender: simTransaction.transaction.from,
			sendAsset: formSwapAsset(tokensSent[0].type === 'NFT' ? tokensSent[0] : tokensSent.filter((token): token is TokenVisualizerERC20Event => token.type === 'Token'), sendBalanceAfter),
			receiveAsset: {
				type: 'Ether',
				amount: ethDiff,
				beforeAfterBalance: {
					previousBalance: etherChange[0].before,
					afterBalance: etherChange[0].before + ethDiff
				}
			},
		}
	}

	if (tokenAddressesSent.length === 0 && tokenAddressesReceived.length === 1 && ethDiff < transactionGasCost ) {
		// user bought token with eth
		const receiveToken = tokenAddressesReceived[0]
		const receiveBalanceAfter = simTransaction.tokenBalancesAfter.find((balance) => balance.owner === simTransaction.transaction.from.address && balance.token === receiveToken.address)?.balance
		return {
			sender: simTransaction.transaction.from,
			sendAsset: {
				type: 'Ether',
				amount: -ethDiff,
				beforeAfterBalance: {
					previousBalance: etherChange[0].before,
					afterBalance: etherChange[0].before + ethDiff
				}
			},
			receiveAsset: formSwapAsset(tokensReceived[0].type === 'NFT' ? tokensReceived[0] : tokensReceived.filter((token): token is TokenVisualizerERC20Event => token.type === 'Token'), receiveBalanceAfter),
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
	const startToken = identifiedSwap.sendAsset.type !== 'Ether' ? addressString(identifiedSwap.sendAsset.tokenAddress.address) : undefined
	const endToken = identifiedSwap.receiveAsset.type !== 'Ether' ? addressString(identifiedSwap.receiveAsset.tokenAddress.address) : undefined
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

export function getSwapName(identifiedSwap: IdentifiedSwapWithMetadata, chain: CHAIN) {
	if (identifiedSwap === false) return undefined
	const sent = identifiedSwap.sendAsset.type !== 'Ether' ? identifiedSwap.sendAsset.tokenAddress.symbol : CHAINS[chain].currencyTicker
	const to = identifiedSwap.receiveAsset.type !== 'Ether' ? identifiedSwap.receiveAsset.tokenAddress.symbol : CHAINS[chain].currencyTicker
	return `Swap ${ sent } for ${ to }`
}

export function VisualizeSwapAsset({ swapAsset, chain }: { swapAsset: SwapAsset, chain: CHAIN }) {
	const tokenStyle = { 'font-size': '28px', 'font-weight': '500' }
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
							chain = { chain }
							useFullTokenName = { false }
							style = { tokenStyle}
						/>
					</div>
				</span>
				<span class = 'grid swap-grid'>
					<div class = 'log-cell'/>
					{ swapAsset.beforeAfterBalance !== undefined ? <div class = 'log-cell' style = 'justify-content: right;'>
						<p class = 'paragraph' style = { balanceTextStyle }>Balance:&nbsp;</p>
						<TokenOrEthValue amount = { swapAsset.beforeAfterBalance?.previousBalance } style = { balanceTextStyle } />
						<p class = 'paragraph' style = { balanceTextStyle }>&nbsp;{'->'}&nbsp;</p>
						<TokenOrEthValue amount = { swapAsset.beforeAfterBalance?.afterBalance } style = { balanceTextStyle } />
						</div> : <></>
					}
				</span>
			</>
		}
		case 'NFT': {
			return <span class = 'grid swap-grid'>
				<div class = 'log-cell' style = 'justify-content: left;'>
					<ERC721TokenNumber
						id = { swapAsset.tokenId }
						received = { false }
						style = { tokenStyle }
					/>
				</div>
				<div class = 'log-cell' style = 'justify-content: right;'>
					<TokenSymbol
						{ ...swapAsset.tokenAddress }
						useFullTokenName = { false }
						style = { tokenStyle }
					/>
				</div>
			</span>
		}
		case 'Token': {
			return <>
				<span class = 'grid swap-grid'>
					<div class = 'log-cell' style = 'justify-content: left;'>
						<TokenAmount
							amount = { swapAsset.amount }
							decimals = { swapAsset.tokenAddress.decimals }
							style = { tokenStyle }
						/>
					</div>
					<div class = 'log-cell' style = 'justify-content: right;'>
						<TokenSymbol
							{ ...swapAsset.tokenAddress }
							useFullTokenName = { false }
							style = { tokenStyle }
						/>
					</div>
				</span>
				<span class = 'grid swap-grid'>
					<div class = 'log-cell'/>
					{ swapAsset.beforeAfterBalance !== undefined ? <div class = 'log-cell' style = 'justify-content: right;'>
						<p class = 'paragraph' style = { balanceTextStyle }>Balance:&nbsp;</p>
						<TokenOrEthValue { ...swapAsset.tokenAddress } amount = { swapAsset.beforeAfterBalance?.previousBalance } style = { balanceTextStyle } />
						<p class = 'paragraph' style = { balanceTextStyle }>&nbsp;{'->'}&nbsp;</p>
						<TokenOrEthValue { ...swapAsset.tokenAddress } amount = { swapAsset.beforeAfterBalance?.afterBalance } style = { balanceTextStyle } />
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
				<VisualizeSwapAsset swapAsset = { param.identifiedSwap.sendAsset } chain = { param.chain } />
			</div>
			<p class = 'paragraph'> For </p>
			<div class = 'box swap-box'>
				<VisualizeSwapAsset swapAsset = { param.identifiedSwap.receiveAsset } chain = { param.chain } />
			</div>
		</div>
	</div>
}
