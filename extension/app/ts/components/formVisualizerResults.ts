import { addressString } from '../utils/bigint.js'
import { EthBalanceChangesWithMetadata, SimResults, SimulatedAndVisualizedTransaction, SimulationState, TokenVisualizerResultWithMetadata } from '../utils/visualizer-types.js'
import { AddressBookEntry } from '../utils/user-interface-types.js'

// todo, move this to background page (and refacor hard) to form when simulation is made and we can get rid of most of the validations done here
export function formSimulatedAndVisualizedTransaction(simState: SimulationState, visualizerResults: SimResults[], addressMetaData: Map<string, AddressBookEntry> ) : SimulatedAndVisualizedTransaction[] {
	return simState.simulatedTransactions.map( (simulatedTx, index) => {
		const from = addressMetaData.get(addressString(simulatedTx.unsignedTransaction.from))
		if (from === undefined) throw new Error('missing metadata')

		const to = simulatedTx.unsignedTransaction.to !== null ? addressMetaData.get(addressString(simulatedTx.unsignedTransaction.to)) : undefined
		if (simulatedTx.unsignedTransaction.to !== null && to === undefined ) throw new Error('missing metadata')
		const visualiser = visualizerResults[index].visualizerResults

		const ethBalanceChanges: EthBalanceChangesWithMetadata[] = visualiser === undefined ? [] : visualiser.ethBalanceChanges.map((change) => {
			const entry = addressMetaData.get(addressString(change.address))
			if (entry === undefined) throw new Error('missing metadata')
			return {
				...change,
				address: entry,
			}
		})
		const tokenResults: TokenVisualizerResultWithMetadata[] = visualiser === undefined ? [] : visualiser.tokenResults.map((change) => {
			const fromEntry = addressMetaData.get(addressString(change.from))
			const toEntry = addressMetaData.get(addressString(change.to))
			const tokenEntry = addressMetaData.get(addressString(change.tokenAddress))
			if (fromEntry === undefined || toEntry === undefined || tokenEntry === undefined) throw new Error('missing metadata')

			if (change.is721 && tokenEntry.type === 'NFT') {
				return {
					...change,
					from: fromEntry,
					to: toEntry,
					token: tokenEntry
				}
			}
			if (!change.is721 && tokenEntry.type === 'token') {
				return {
					...change,
					from: fromEntry,
					to: toEntry,
					token: tokenEntry
				}
			}
			throw new Error('wrong token type')
		})
		return {
			from: from,
			to: to,
			value: simulatedTx.unsignedTransaction.value,
			realizedGasPrice: simulatedTx.realizedGasPrice,
			ethBalanceChanges: ethBalanceChanges,
			tokenResults: tokenResults,
			gasSpent: simulatedTx.multicallResponse.gasSpent,
			quarantine: visualizerResults[index].quarantine,
			quarantineCodes: visualizerResults[index].quarantineCodes,
			chainId: simState.chain,
			gas: simulatedTx.unsignedTransaction.gas,
			input: simulatedTx.unsignedTransaction.input,
			...(simulatedTx.unsignedTransaction.type === '1559' ? {
				type: simulatedTx.unsignedTransaction.type,
				maxFeePerGas: simulatedTx.unsignedTransaction.maxFeePerGas,
				maxPriorityFeePerGas: simulatedTx.unsignedTransaction.maxPriorityFeePerGas,
			} : { type: simulatedTx.unsignedTransaction.type } ),
			hash: simulatedTx.signedTransaction.hash,
			...(simulatedTx.multicallResponse.statusCode === 'failure' ? {
				error: simulatedTx.multicallResponse.error,
				statusCode: simulatedTx.multicallResponse.statusCode,
			} : {
				statusCode: simulatedTx.multicallResponse.statusCode,
			}),
		}
	} )
}
