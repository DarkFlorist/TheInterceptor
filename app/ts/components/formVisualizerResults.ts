import { addressString } from '../utils/bigint.js'
import { EthBalanceChangesWithMetadata, SimResults, SimulatedAndVisualizedTransaction, SimulationState, TokenVisualizerResultWithMetadata } from '../utils/visualizer-types.js'
import { AddressBookEntry } from '../utils/user-interface-types.js'

// todo, move this to background page (and refacor hard) to form when simulation is made and we can get rid of most of the validations done here
export function formSimulatedAndVisualizedTransaction(simState: SimulationState, visualizerResults: readonly SimResults[], addressBookEntries: readonly AddressBookEntry[] ): readonly SimulatedAndVisualizedTransaction[] {
	const addressMetaData = new Map(addressBookEntries.map((x) => [addressString(x.address), x]))
	return simState.simulatedTransactions.map((simulatedTx, index) => {

		const from = addressMetaData.get(addressString(simulatedTx.signedTransaction.from))
		if (from === undefined) throw new Error('missing metadata')

		const to = simulatedTx.signedTransaction.to !== null ? addressMetaData.get(addressString(simulatedTx.signedTransaction.to)) : undefined
		if (simulatedTx.signedTransaction.to !== null && to === undefined) throw new Error('missing metadata')
		const visualiser = visualizerResults[index].visualizerResults

		const ethBalanceChanges: EthBalanceChangesWithMetadata[] = visualiser === undefined ? [] : visualiser.ethBalanceChanges.map((change) => {
			const entry = addressMetaData.get(addressString(change.address))
			if (entry === undefined) throw new Error('missing metadata')
			return {
				...change,
				address: entry,
			}
		})
		const tokenResults: TokenVisualizerResultWithMetadata[] = visualiser === undefined ? [] : visualiser.tokenResults.map((change): TokenVisualizerResultWithMetadata | undefined => {
			const fromEntry = addressMetaData.get(addressString(change.from))
			const toEntry = addressMetaData.get(addressString(change.to))
			const erc20TokenEntry = addressMetaData.get(addressString(change.tokenAddress))
			if (fromEntry === undefined || toEntry === undefined || erc20TokenEntry === undefined) throw new Error('missing metadata')
			if (change.type === 'ERC721' && erc20TokenEntry.type === 'ERC721') {
				return {
					...change,
					from: fromEntry,
					to: toEntry,
					token: erc20TokenEntry
				}
			}
			if (change.type === 'ERC20' && erc20TokenEntry.type === 'ERC20') {
				return {
					...change,
					from: fromEntry,
					to: toEntry,
					token: erc20TokenEntry
				}
			}
			return undefined // a token that is not NFT, but does not have decimals either, let's just not visualize them
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
			tokenBalancesAfter: simulatedTx.tokenBalancesAfter,
			gasSpent: simulatedTx.multicallResponse.gasSpent,
			quarantine: visualizerResults[index].quarantine,
			quarantineCodes: visualizerResults[index].quarantineCodes,
			...(simulatedTx.multicallResponse.statusCode === 'failure'
				? {
					error: simulatedTx.multicallResponse.error,
					statusCode: simulatedTx.multicallResponse.statusCode,
				}
				: {
					statusCode: simulatedTx.multicallResponse.statusCode,
				}
			),
			website: visualizerResults[index].website,
			transactionCreated: simulatedTx.transactionCreated,
		}
	})
}
