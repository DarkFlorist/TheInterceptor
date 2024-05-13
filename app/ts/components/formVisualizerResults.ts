import { addressString, dataStringWith0xStart } from '../utils/bigint.js'
import { EnrichedEthereumEventWithMetadata, EnrichedEthereumEvents, NamedTokenId, ProtectorResults, SimulatedAndVisualizedTransaction, SimulationState } from '../types/visualizer-types.js'
import { AddressBookEntry } from '../types/addressBookTypes.js'
import { Interface } from 'ethers'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { MaybeENSLabelHashes, MaybeENSNameHashes } from '../types/ens.js'

export function formSimulatedAndVisualizedTransaction(simState: SimulationState, eventsForEachTransaction: readonly EnrichedEthereumEvents[], protectorResults: readonly ProtectorResults[], addressBookEntries: readonly AddressBookEntry[], namedTokenIds: readonly NamedTokenId[], ens: { ensNameHashes: MaybeENSNameHashes, ensLabelHashes: MaybeENSLabelHashes }): readonly SimulatedAndVisualizedTransaction[] {
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

		// if we have identified a token event, but its emitted by non-token contract, do not parse it as token event
		const modifiedTransactionEvents: EnrichedEthereumEventWithMetadata[] = transactionEvents.map((event): EnrichedEthereumEventWithMetadata => {
			switch(event.type) {
				case 'TokenEvent': {
					const tokenInfo = event.logInformation
					const fromEntry = addressMetaData.get(addressString(tokenInfo.from))
					const toEntry = addressMetaData.get(addressString(tokenInfo.to))
					const tokenEntry = addressMetaData.get(addressString(tokenInfo.tokenAddress))
					if (fromEntry === undefined || toEntry === undefined || tokenEntry === undefined) throw new Error('missing metadata')
					if (tokenInfo.type === 'ERC721' && tokenEntry.type === 'ERC721') return { ...event, logInformation: {...tokenInfo, logObject: event, from: fromEntry, to: toEntry, token: tokenEntry } }
					if (tokenInfo.type === 'ERC20' && tokenEntry.type === 'ERC20') return { ...event, logInformation: {...tokenInfo, logObject: event, from: fromEntry, to: toEntry, token: tokenEntry } }
					if (tokenInfo.type === 'NFT All approval' && (tokenEntry.type === 'ERC1155' || tokenEntry.type === 'ERC721')) return { ...event, logInformation: {...tokenInfo, logObject: event, from: fromEntry, to: toEntry, token: tokenEntry } }
					if (tokenInfo.type === 'ERC1155' && tokenEntry.type === 'ERC1155') {
						return { ...event,
							logInformation: {
								...tokenInfo,
								logObject: event,
								from: fromEntry,
								to: toEntry,
								token: tokenEntry,
								tokenIdName: namedTokenIds.find((namedTokenId) => namedTokenId.tokenAddress === tokenInfo.tokenAddress && namedTokenId.tokenId === tokenInfo.tokenId)?.tokenIdName
							}
						}
					}
					return({ ...event, type: 'Parsed' })
				}
				case 'ENSNewResolver':
				case 'ENSTransfer':
				case 'ENSTextChanged': {
					const node = ens.ensNameHashes.find((nameHash) => nameHash.nameHash === event.logInformation.node) ?? { nameHash: event.logInformation.node, name: undefined }
					return { ...event, logInformation: { ...event.logInformation, node } }
				}
				case 'ENSNewOwner': {
					const labelHash = ens.ensLabelHashes.find((nameHash) => nameHash.labelHash === event.logInformation.labelHash) ?? { labelHash: event.logInformation.labelHash, label: undefined }
					const node = ens.ensNameHashes.find((nameHash) => nameHash.nameHash === event.logInformation.node) ?? { nameHash: event.logInformation.node, name: undefined }
					return { ...event, logInformation: { ...event.logInformation, node, labelHash } }
				}
				case 'ENSAddrChanged': {
					const to = addressMetaData.get(addressString(event.logInformation.to))
					if (to === undefined) throw new Error('missing metadata')
					const node = ens.ensNameHashes.find((nameHash) => nameHash.nameHash === event.logInformation.node) ?? { nameHash: event.logInformation.node, name: undefined }
					return { ...event, logInformation: { ...event.logInformation, to, node } }
				}
				case 'ENSAddressChanged': {
					const node = ens.ensNameHashes.find((nameHash) => nameHash.nameHash === event.logInformation.node) ?? { nameHash: event.logInformation.node, name: undefined }
					return { ...event, logInformation: { ...event.logInformation, node } }
				}
				case 'ENSRegistrarNameRenewed': {
					const labelHash = ens.ensLabelHashes.find((nameHash) => nameHash.labelHash === event.logInformation.labelHash) ?? { labelHash: event.logInformation.labelHash, label: undefined }
					return { ...event, logInformation: { ...event.logInformation, labelHash } }
				}
				case 'ENSNameRenewed': {
					const labelHash = ens.ensLabelHashes.find((nameHash) => nameHash.labelHash === event.logInformation.labelHash) ?? { labelHash: event.logInformation.labelHash, label: undefined }
					return { ...event, logInformation: { ...event.logInformation, labelHash } }
				}
				default: return event
			}
		})
		
		const removeFromAndToFromSignedTransaction = () => {
			const { from, to, ...otherFields } = simulatedTx.signedTransaction
			return otherFields
		}
		const otherFields = removeFromAndToFromSignedTransaction()
		const availableAbis = addressBookEntries.map((entry) => 'abi' in entry && entry.abi !== undefined && entry.abi !== '' ?  new Interface(entry.abi) : undefined).filter((abiOrUndefined): abiOrUndefined is Interface => abiOrUndefined !== undefined)
		return {
			transaction: { from, to, rpcNetwork: simState.rpcNetwork, ...otherFields },
			...(to !== undefined ? { to } : {}),
			realizedGasPrice: simulatedTx.realizedGasPrice,
			events: modifiedTransactionEvents,
			tokenBalancesAfter: simulatedTx.tokenBalancesAfter,
			gasSpent: simulatedTx.ethSimulateV1CallResult.gasUsed,
			quarantine: protectorResult.quarantine,
			quarantineReasons: protectorResult.quarantineReasons,
			...(simulatedTx.ethSimulateV1CallResult.status === 'failure'
				? {
					error: {
						...simulatedTx.ethSimulateV1CallResult.error,
						decodedErrorMessage: decodeEthereumError(availableAbis, { ...simulatedTx.ethSimulateV1CallResult.error, data: dataStringWith0xStart(simulatedTx.ethSimulateV1CallResult.returnData)}).reason,
					},
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
