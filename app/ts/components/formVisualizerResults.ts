import { addressString } from '../utils/bigint.js'
import { EnrichedEthereumEvent, GeneralEnrichedEthereumEvents, NamedTokenId, ProtectorResults, SimulatedAndVisualizedTransaction, SimulationState } from '../types/visualizer-types.js'
import { AddressBookEntry } from '../types/addressBookTypes.js'

export function formSimulatedAndVisualizedTransaction(simState: SimulationState, eventsForEachTransaction: readonly GeneralEnrichedEthereumEvents[], protectorResults: readonly ProtectorResults[], addressBookEntries: readonly AddressBookEntry[], namedTokenIds: readonly NamedTokenId[]): readonly SimulatedAndVisualizedTransaction[] {
	const addressMetaData = new Map(addressBookEntries.map((x) => [addressString(x.address), x]))
	return simState.simulatedTransactions.map((simulatedTx, index) => {
		const from = addressMetaData.get(addressString(simulatedTx.signedTransaction.from))
		if (from === undefined) throw new Error('missing metadata')

		const to = simulatedTx.signedTransaction.to !== null ? addressMetaData.get(addressString(simulatedTx.signedTransaction.to)) : undefined
		if (simulatedTx.signedTransaction.to !== null && to === undefined) throw new Error('missing metadata')
		const transactionEvents = eventsForEachTransaction[index]
		if (transactionEvents === undefined) throw new Error('visualizer result was undefined')
		const protectorResult = protectorResults[index]
		if (protectorResult === undefined) throw new Error('protector result was undefined')

		const tokenResults = transactionEvents === undefined ? [] : transactionEvents.map((change) => {
			if (change.type !== 'TokenEvent') return undefined
			const tokenInfo = change.tokenInformation
			const fromEntry = addressMetaData.get(addressString(tokenInfo.from))
			const toEntry = addressMetaData.get(addressString(tokenInfo.to))
			const tokenEntry = addressMetaData.get(addressString(tokenInfo.tokenAddress))
			if (fromEntry === undefined || toEntry === undefined || tokenEntry === undefined) throw new Error('missing metadata')
			if (tokenInfo.type === 'ERC721' && tokenEntry.type === 'ERC721') return { ...tokenInfo, logObject: change, from: fromEntry, to: toEntry, token: tokenEntry }
			if (tokenInfo.type === 'ERC20' && tokenEntry.type === 'ERC20') return { ...tokenInfo, logObject: change, from: fromEntry, to: toEntry, token: tokenEntry }
			if (tokenInfo.type === 'NFT All approval' && (tokenEntry.type === 'ERC1155' || tokenEntry.type === 'ERC721')) return { ...tokenInfo, logObject: change, from: fromEntry, to: toEntry, token: tokenEntry }
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
			return undefined
		})

		// if we have identified a token event, but its emitted by non-token contract, do not parse it as token event
		const modifiedTransactionEvents: EnrichedEthereumEvent[] = []
		
		for (const [index, event] of transactionEvents.entries()) {
			if (event.type === 'TokenEvent' && tokenResults[index] === undefined) {
				modifiedTransactionEvents.push({ ...event, type: 'Parsed' })
			} else {
				modifiedTransactionEvents.push(event)
			}
		}
		
		const removeFromAndToFromSignedTransaction = () => {
			const { from, to, ...otherFields} = simulatedTx.signedTransaction
			return otherFields
		}
		const otherFields = removeFromAndToFromSignedTransaction()
		return {
			transaction: { from, to, rpcNetwork: simState.rpcNetwork, ...otherFields },
			...(to !== undefined ? { to } : {}),
			realizedGasPrice: simulatedTx.realizedGasPrice,
			tokenResults: tokenResults.filter(<T>(x: T | undefined): x is T => x !== undefined),
			events: modifiedTransactionEvents,
			tokenBalancesAfter: simulatedTx.tokenBalancesAfter,
			gasSpent: simulatedTx.ethSimulateV1CallResult.gasUsed,
			quarantine: protectorResult.quarantine,
			quarantineReasons: protectorResult.quarantineReasons,
			...(simulatedTx.ethSimulateV1CallResult.status === 'failure'
				? {
					error: simulatedTx.ethSimulateV1CallResult.error,
					statusCode: simulatedTx.ethSimulateV1CallResult.status,
				}
				: {
					statusCode: simulatedTx.ethSimulateV1CallResult.status,
				}
			),
			website: simulatedTx.website,
			created: simulatedTx.created,
			transactionIdentifier: simulatedTx.transactionIdentifier,
		}
	})
}
