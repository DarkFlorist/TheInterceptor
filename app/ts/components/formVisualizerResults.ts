import { addressString } from '../utils/bigint.js'
import { EthBalanceChangesWithMetadata, NamedTokenId, ProtectorResults, SimulatedAndVisualizedTransaction, SimulationState, TokenVisualizerResultWithMetadata, VisualizerResult } from '../types/visualizer-types.js'
import { AddressBookEntry } from '../types/addressBookTypes.js'

export function formSimulatedAndVisualizedTransaction(simState: SimulationState, visualizerResults: readonly VisualizerResult[], protectorResults: readonly ProtectorResults[], addressBookEntries: readonly AddressBookEntry[], namedTokenIds: readonly NamedTokenId[]): readonly SimulatedAndVisualizedTransaction[] {
	const addressMetaData = new Map(addressBookEntries.map((x) => [addressString(x.address), x]))
	return simState.simulatedTransactions.map((simulatedTx, index) => {
		const from = addressMetaData.get(addressString(simulatedTx.signedTransaction.from))
		if (from === undefined) throw new Error('missing metadata')

		const to = simulatedTx.signedTransaction.to !== null ? addressMetaData.get(addressString(simulatedTx.signedTransaction.to)) : undefined
		if (simulatedTx.signedTransaction.to !== null && to === undefined) throw new Error('missing metadata')
		const visualizerResult = visualizerResults[index]
		if (visualizerResult === undefined) throw new Error('visualizer result was undefined')
		const protectorResult = protectorResults[index]
		if (protectorResult === undefined) throw new Error('protecor result was undefined')

		const ethBalanceChanges: EthBalanceChangesWithMetadata[] = visualizerResult === undefined ? [] : visualizerResult.ethBalanceChanges.map((change) => {
			const entry = addressMetaData.get(addressString(change.address))
			if (entry === undefined) throw new Error('missing metadata')
			return {
				...change,
				address: entry,
			}
		})
		const tokenResults: TokenVisualizerResultWithMetadata[] = visualizerResult === undefined ? [] : visualizerResult.events.map((change) => {
			if (change.type !== 'TokenEvent') return undefined
			const tokenInfo = change.tokenInformation
			const fromEntry = addressMetaData.get(addressString(tokenInfo.from))
			const toEntry = addressMetaData.get(addressString(tokenInfo.to))
			const tokenEntry = addressMetaData.get(addressString(tokenInfo.tokenAddress))
			if (fromEntry === undefined || toEntry === undefined || tokenEntry === undefined) throw new Error('missing metadata')
			if ((tokenInfo.type === 'ERC721' && tokenEntry.type === 'ERC721')) {
				return {
					...tokenInfo,
					logObject: change,
					from: fromEntry,
					to: toEntry,
					token: tokenEntry
				}
			}
			if ((tokenInfo.type === 'ERC20' && tokenEntry.type === 'ERC20')) {
				return {
					...tokenInfo,
					logObject: change,
					from: fromEntry,
					to: toEntry,
					token: tokenEntry
				}
			}
			if (tokenInfo.type === 'ERC1155' && tokenEntry.type === 'ERC1155') {
				return {
					...tokenInfo,
					logObject: change,
					from: fromEntry,
					to: toEntry,
					token: tokenEntry,
					tokenIdName: namedTokenIds.find((namedTokenId) => namedTokenId.tokenAddress === tokenInfo.tokenAddress && namedTokenId.tokenId === tokenInfo.tokenId)?.tokenIdName
				}
			}
			if (tokenInfo.type === 'NFT All approval' && (tokenEntry.type === 'ERC1155' || tokenEntry.type === 'ERC721')) {
				return {
					...tokenInfo,
					logObject: change,
					from: fromEntry,
					to: toEntry,
					token: tokenEntry,
				}
			}
			console.warn('unknown token in token results:')
			console.log(change)
			console.log(tokenEntry)
			return undefined
		}).filter(<T>(x: T | undefined): x is T => x !== undefined)
		return {
			transaction: {
				from: from,
				to: to,
				value: simulatedTx.signedTransaction.value,
				rpcNetwork: simState.rpcNetwork,
				gas: simulatedTx.signedTransaction.gas,
				input: simulatedTx.signedTransaction.input,
				...(simulatedTx.signedTransaction.type === '1559'
					? {
						type: simulatedTx.signedTransaction.type,
						maxFeePerGas: simulatedTx.signedTransaction.maxFeePerGas,
						maxPriorityFeePerGas: simulatedTx.signedTransaction.maxPriorityFeePerGas,
					}
					: { type: simulatedTx.signedTransaction.type }
				),
				hash: simulatedTx.signedTransaction.hash,
				nonce: simulatedTx.signedTransaction.nonce,
			},
			...(to !== undefined ? { to } : {}),
			realizedGasPrice: simulatedTx.realizedGasPrice,
			ethBalanceChanges: ethBalanceChanges,
			tokenResults: tokenResults,
			events: visualizerResult.events,
			tokenBalancesAfter: simulatedTx.tokenBalancesAfter,
			gasSpent: simulatedTx.multicallResponse.gasSpent,
			quarantine: protectorResult.quarantine,
			quarantineReasons: protectorResult.quarantineReasons,
			...(simulatedTx.multicallResponse.statusCode === 'failure'
				? {
					error: simulatedTx.multicallResponse.error,
					statusCode: simulatedTx.multicallResponse.statusCode,
				}
				: {
					statusCode: simulatedTx.multicallResponse.statusCode,
				}
			),
			website: simulatedTx.website,
			created: simulatedTx.created,
			transactionIdentifier: simulatedTx.transactionIdentifier,
		}
	})
}
