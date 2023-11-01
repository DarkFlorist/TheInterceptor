import { addressString } from '../utils/bigint.js'
import { EthBalanceChangesWithMetadata, MaybeParsedEvent, NamedTokenId, ProtectorResults, SimulatedAndVisualizedTransaction, SimulatedTransaction, SimulationState, TokenVisualizerResultWithMetadata, VisualizerResult } from '../types/visualizer-types.js'
import { AddressBookEntry } from '../types/addressBookTypes.js'
import { getArtificialERC20ForEth } from './ui-utils.js'
import { Interface } from 'ethers'
import { parseEventIfPossible } from '../simulation/services/SimulationModeEthereumClientService.js'
import { extractFunctionArgumentTypes, removeTextBetweenBrackets } from '../utils/abi.js'
import { parseSolidityValueByTypePure } from '../utils/solidityTypes.js'
import { SolidityType } from '../types/solidityType.js'

const parseEvents = (simulatedTx: SimulatedTransaction, addressBookEntries: readonly AddressBookEntry[]): readonly MaybeParsedEvent[] => {
	if (simulatedTx.multicallResponse.statusCode !== 'success' ) return []
	const addressMetaData = new Map(addressBookEntries.map((x) => [addressString(x.address), x]))
	return simulatedTx.multicallResponse.events.map((event) => {
		// todo, we should do this parsing earlier, to be able to add possible addresses to addressMetaData set 
		const logger = addressMetaData.get(addressString(event.loggersAddress))
		const nonParsed = { ...event, type: 'NonParsed' as const }
		if (logger === undefined || !('abi' in logger) || logger.abi === undefined) return nonParsed
		const parsed = parseEventIfPossible(new Interface(logger.abi), event)
		console.log(parsed)
		if (parsed === null) return nonParsed
		const argTypes = extractFunctionArgumentTypes(parsed.signature)
		if (argTypes === undefined) return nonParsed
		if (parsed.args.length !== argTypes.length) return nonParsed
		
		const valuesWithTypes = parsed.args.map((value, index) => {
			const solidityType = argTypes[index]
			const paramName = parsed.fragment.inputs[index]?.name
			if (paramName === undefined) throw new Error(`missing parameter name`)
			if (solidityType === undefined) throw new Error(`unknown solidity type: ${ solidityType }`)
			const isArray = solidityType.includes('[')
			const verifiedSolidityType = SolidityType.safeParse(removeTextBetweenBrackets(solidityType))
			if (verifiedSolidityType.success === false) throw new Error(`unknown solidity type: ${ solidityType }`)
			return { paramName: paramName, typeValue: parseSolidityValueByTypePure(verifiedSolidityType.value, value, isArray) }
		})
		return {
			...event,
			type: 'Parsed' as const,
			name: parsed.name,
			signature: parsed.signature,
			args: valuesWithTypes,
		}
	})
}

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
		const tokenResults: TokenVisualizerResultWithMetadata[] = visualizerResult === undefined ? [] : visualizerResult.tokenResults.map((change): TokenVisualizerResultWithMetadata | undefined => {
			const fromEntry = addressMetaData.get(addressString(change.from))
			const toEntry = addressMetaData.get(addressString(change.to))
			const tokenEntry = addressMetaData.get(addressString(change.tokenAddress))
			if (fromEntry === undefined || toEntry === undefined || tokenEntry === undefined) throw new Error('missing metadata')
			if ((change.type === 'ERC721' && tokenEntry.type === 'ERC721')) {
				return {
					...change,
					from: fromEntry,
					to: toEntry,
					token: tokenEntry
				}
			}
			if (tokenEntry.address === 0n && change.type === 'ERC20') {
				simState.rpcNetwork.chainId
				return {
					...change,
					from: fromEntry,
					to: toEntry,
					token: getArtificialERC20ForEth(simState.rpcNetwork),
				}	
			}
			if ((change.type === 'ERC20' && tokenEntry.type === 'ERC20')) {
				return {
					...change,
					from: fromEntry,
					to: toEntry,
					token: tokenEntry
				}
			}
			if (change.type === 'ERC1155' && tokenEntry.type === 'ERC1155') {
				return {
					...change,
					from: fromEntry,
					to: toEntry,
					token: tokenEntry,
					tokenIdName: namedTokenIds.find((namedTokenId) => namedTokenId.tokenAddress === change.tokenAddress && namedTokenId.tokenId === change.tokenId)?.tokenIdName
				}
			}
			if (change.type === 'NFT All approval' && (tokenEntry.type === 'ERC1155' || tokenEntry.type === 'ERC721')) {
				return {
					...change,
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
			events: parseEvents(simulatedTx, addressBookEntries),
			tokenBalancesAfter: simulatedTx.tokenBalancesAfter,
			gasSpent: simulatedTx.multicallResponse.gasSpent,
			quarantine: protectorResult.quarantine,
			quarantineCodes: protectorResult.quarantineCodes,
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
		}
	})
}
