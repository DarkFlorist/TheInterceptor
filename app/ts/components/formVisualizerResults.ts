import { addressString, dataStringWith0xStart } from '../utils/bigint.js'
import { NamedTokenId, ProtectorResults, SimulatedAndVisualizedTransaction, SimulationState, TokenPriceEstimate } from '../types/visualizer-types.js'
import { AddressBookEntry, Erc20TokenEntry } from '../types/addressBookTypes.js'
import { Interface } from 'ethers'
import { decodeEthereumError } from '../utils/errorDecoding.js'
import { MaybeENSLabelHashes, MaybeENSNameHashes } from '../types/ens.js'
import { assertNever } from '../utils/typescript.js'
import { EnrichedEthereumEventWithMetadata, EnrichedEthereumEvents, EnrichedEthereumInputData, ParsedEnsEvent } from '../types/EnrichedEthereumData.js'

const enrichEnsEvent = (event: ParsedEnsEvent, ens: { ensNameHashes: MaybeENSNameHashes, ensLabelHashes: MaybeENSLabelHashes }, addressMetaData: Map<string, AddressBookEntry>) => {
	const getNameHash = (node: bigint) => ens.ensNameHashes.find((nameHash) => nameHash.nameHash === node) ?? { nameHash: node, name: undefined }
	const getLabelHash = (labelHash: bigint) => ens.ensLabelHashes.find((nameHash) => nameHash.labelHash === labelHash) ?? { labelHash: labelHash, label: undefined }
	
	switch (event.subType) {
		case 'ENSNameWrapped': {
			const owner = addressMetaData.get(addressString(event.logInformation.owner))
			if (owner === undefined) throw new Error('missing metadata')
			return { ...event, logInformation: { ...event.logInformation, owner, node: getNameHash(event.logInformation.node) } }
		}
		case 'ENSFusesSet': return { ...event, logInformation: { ...event.logInformation, node: getNameHash(event.logInformation.node) } }
		case 'ENSExpiryExtended': return { ...event, logInformation: { ...event.logInformation, node: getNameHash(event.logInformation.node) } }
		case 'ENSNameChanged': return { ...event, logInformation: { ...event.logInformation, node: getNameHash(event.logInformation.node) } }
		case 'ENSNewTTL': return { ...event, logInformation: { ...event.logInformation, node: getNameHash(event.logInformation.node) } }
		case 'ENSNewResolver': {
			const address = addressMetaData.get(addressString(event.logInformation.address))
			if (address === undefined) throw new Error('missing metadata')
			return { ...event, logInformation: { ...event.logInformation, node: getNameHash(event.logInformation.node), address } }
		}
		case 'ENSReverseClaimed': {
			const address = addressMetaData.get(addressString(event.logInformation.address))
			if (address === undefined) throw new Error('missing metadata')
			return { ...event, logInformation: { ...event.logInformation, node: getNameHash(event.logInformation.node), address } }
		}
		case 'ENSTextChangedKeyValue': return { ...event, logInformation: { ...event.logInformation, node: getNameHash(event.logInformation.node) } }
		case 'ENSContentHashChanged': return { ...event, logInformation: { ...event.logInformation, node: getNameHash(event.logInformation.node) } }
		case 'ENSTextChanged': return { ...event, logInformation: { ...event.logInformation, node: getNameHash(event.logInformation.node) } }
		case 'ENSTransfer': {
			const owner = addressMetaData.get(addressString(event.logInformation.owner))
			if (owner === undefined) throw new Error('missing metadata')
			return { ...event, logInformation: { ...event.logInformation, node: getNameHash(event.logInformation.node), owner } }
		}
		case 'ENSNewOwner': {
			const owner = addressMetaData.get(addressString(event.logInformation.owner))
			if (owner === undefined) throw new Error('missing metadata')
			return { ...event, logInformation: { ...event.logInformation, node: getNameHash(event.logInformation.node), labelHash: getLabelHash(event.logInformation.labelHash), owner } }
		}
		case 'ENSAddressChanged': return { ...event, logInformation: { ...event.logInformation, node: getNameHash(event.logInformation.node) } }
		case 'ENSNameUnwrapped': {
			const owner = addressMetaData.get(addressString(event.logInformation.owner))
			if (owner === undefined) throw new Error('missing metadata')
			return { ...event, logInformation: { ...event.logInformation, owner, node: getNameHash(event.logInformation.node) } }
		}
		case 'ENSAddrChanged': {
			const to = addressMetaData.get(addressString(event.logInformation.to))
			if (to === undefined) throw new Error('missing metadata')
			return { ...event, logInformation: { ...event.logInformation, to, node: getNameHash(event.logInformation.node) } }
		}
		case 'ENSControllerNameRegistered': {
			const owner = addressMetaData.get(addressString(event.logInformation.owner))
			if (owner === undefined) throw new Error('missing metadata')
			return { ...event, logInformation: { ...event.logInformation, owner, labelHash: getLabelHash(event.logInformation.labelHash)} }
		}
		case 'ENSControllerNameRenewed': return { ...event, logInformation: { ...event.logInformation, labelHash: getLabelHash(event.logInformation.labelHash) } }
		case 'ENSBaseRegistrarNameRegistered': {
			const owner = addressMetaData.get(addressString(event.logInformation.owner))
			if (owner === undefined) throw new Error('missing metadata')
			return { ...event, logInformation: { ...event.logInformation, owner, labelHash: getLabelHash(event.logInformation.labelHash) } }
		}
		case 'ENSBaseRegistrarNameRenewed': return { ...event, logInformation: { ...event.logInformation, labelHash: getLabelHash(event.logInformation.labelHash) } }
		default: assertNever(event)
	}
}

export function formSimulatedAndVisualizedTransaction(simState: SimulationState, eventsForEachTransaction: readonly EnrichedEthereumEvents[], parsedInputData: readonly EnrichedEthereumInputData[], protectorResults: readonly ProtectorResults[], addressBookEntries: readonly AddressBookEntry[], namedTokenIds: readonly NamedTokenId[], ens: { ensNameHashes: MaybeENSNameHashes, ensLabelHashes: MaybeENSLabelHashes }, tokenPriceEstimates: readonly TokenPriceEstimate[], tokenPriceQuoteToken: Erc20TokenEntry | undefined): readonly SimulatedAndVisualizedTransaction[] {
	const addressMetaData = new Map(addressBookEntries.map((x) => [addressString(x.address), x]))
	return simState.simulatedTransactions.map((simulatedTx, index) => {
		const from = addressMetaData.get(addressString(simulatedTx.preSimulationTransaction.signedTransaction.from))
		if (from === undefined) throw new Error('missing metadata')

		const to = simulatedTx.preSimulationTransaction.signedTransaction.to !== null ? addressMetaData.get(addressString(simulatedTx.preSimulationTransaction.signedTransaction.to)) : undefined
		if (simulatedTx.preSimulationTransaction.signedTransaction.to !== null && to === undefined) throw new Error('missing metadata')
		const transactionEvents = eventsForEachTransaction[index]
		if (transactionEvents === undefined) throw new Error('visualizer result was undefined')
		const protectorResult = protectorResults[index]
		if (protectorResult === undefined) throw new Error('protector result was undefined')
		const singleParsedInputData	= parsedInputData[index]
		if (singleParsedInputData === undefined) throw new Error('parsedInputData was undefined')

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
				case 'ENS': return enrichEnsEvent(event, ens, addressMetaData)
				case 'Parsed': return({ ...event, type: 'Parsed' })
				case 'NonParsed': return({ ...event, type: 'NonParsed' })
				default: assertNever(event)
			}
		})
		
		const removeFromAndToFromSignedTransaction = () => {
			const { from, to, ...otherFields } = simulatedTx.preSimulationTransaction.signedTransaction
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
			tokenPriceEstimates,
			tokenPriceQuoteToken,
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
			website: simulatedTx.preSimulationTransaction.website,
			created: simulatedTx.preSimulationTransaction.created,
			transactionIdentifier: simulatedTx.preSimulationTransaction.transactionIdentifier,
			parsedInputData: singleParsedInputData,
		}
	})
}
