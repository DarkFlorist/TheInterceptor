import { Interface, ethers } from 'ethers'
import { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionToInputAndSimulate, calculateRealizedEffectiveGasPrice, createSimulationState, getBaseFeeAdjustedTransactions, getNonceFixedSimulationStateInput, getSimulatedCode, getTokenBalancesAfterForTransaction, getWebsiteCreatedEthereumUnsignedTransactions, mockSignTransaction, simulationGasLeft } from '../simulation/services/SimulationModeEthereumClientService.js'
import { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { parseEvents, parseInputData, runProtectorsForTransaction } from '../simulation/simulator.js'
import { EnrichedEthereumEvents, EnrichedEthereumInputData } from '../types/EnrichedEthereumData.js'
import { PendingTransaction } from '../types/accessRequest.js'
import { AddressBookEntry, Erc20TokenEntry } from '../types/addressBookTypes.js'
import { SimulateExecutionReplyData } from '../types/interceptor-messages.js'
import { PreSimulationTransaction, SimulationState, SimulationStateInput, VisualizedSimulatorState } from '../types/visualizer-types.js'
import { get4Byte, get4ByteString } from '../utils/calldata.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, FourByteExplanations } from '../utils/constants.js'
import { DistributiveOmit, modifyObject } from '../utils/typescript.js'
import { getAddressBookEntriesForVisualiserFromTransactions, identifyAddress, nameTokenIds, retrieveEnsNodeAndLabelHashes } from './metadataUtils.js'
import { getSettings, getWethForChainId } from './settings.js'
import { addressString, dataStringWith0xStart, stringToUint8Array } from '../utils/bigint.js'
import { simulateCompoundGovernanceExecution } from '../simulation/compoundGovernanceFaking.js'
import { CompoundGovernanceAbi } from '../utils/abi.js'
import { VisualizedPersonalSignRequestSafeTx } from '../types/personal-message-definitions.js'
import { getGnosisSafeProxyProxy } from '../utils/ethereumByteCodes.js'
import { updateSimulationResultsWithCallBack } from './storageVariables.js'
import { handleUnexpectedError, isFailedToFetchError, isNewBlockAbort } from '../utils/errors.js'
import { craftPersonalSignPopupMessage } from './windows/personalSign.js'
import { formSimulatedAndVisualizedTransactions } from '../components/formVisualizerResults.js'


async function updateMetadataForSimulation(
	simulationState: SimulationState,
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
	eventsForEachTransaction: readonly EnrichedEthereumEvents[],
	inputData: readonly EnrichedEthereumInputData[],
) {
	const allEvents = eventsForEachTransaction.flat()
	const addressBookEntryPromises = getAddressBookEntriesForVisualiserFromTransactions(ethereum, requestAbortController, allEvents, inputData, simulationState)
	const namedTokenIdPromises = nameTokenIds(ethereum, allEvents)
	const addressBookEntries = await addressBookEntryPromises
	const ensPromise = retrieveEnsNodeAndLabelHashes(ethereum, allEvents, addressBookEntries)
	const namedTokenIds = await namedTokenIdPromises
	return {
		namedTokenIds,
		addressBookEntries: addressBookEntries,
		ens: await ensPromise
	}
}

export const simulateGovernanceContractExecution = async (pendingTransaction: PendingTransaction, ethereum: EthereumClientService, tokenPriceService: TokenPriceService): Promise<DistributiveOmit<SimulateExecutionReplyData, 'transactionOrMessageIdentifier'>> => {
	const returnError = (errorMessage: string) => ({ success: false as const, errorType: 'Other' as const, errorMessage })
	try {
		// identifies compound governane call and performs simulation if the vote passes
		if (pendingTransaction.transactionOrMessageCreationStatus !== 'Simulated') return returnError('Still simulating the voting transaction')
		const pendingResults = pendingTransaction.simulationResults
		if (pendingResults.statusCode !== 'success') return returnError('Voting transaction failed')
		const fourByte = get4Byte(pendingTransaction.transactionToSimulate.transaction.input)
		const fourByteString = get4ByteString(pendingTransaction.transactionToSimulate.transaction.input)
		if (fourByte === undefined || fourByteString === undefined) return returnError('Could not identify the 4byte signature')
		const explanation = FourByteExplanations[fourByte]
		if ((explanation !== 'Cast Vote'
			&& explanation !== 'Submit Vote'
			&& explanation !== 'Cast Vote by Signature'
			&& explanation !== 'Cast Vote with Reason'
			&& explanation !== 'Cast Vote with Reason and Additional Info'
			&& explanation !== 'Cast Vote with Reason And Additional Info by Signature')
			|| pendingResults.data.visualizedSimulationState.visualizedBlocks[0]?.simulatedAndVisualizedTransactions[0]?.events.length !== 1) return returnError('Could not identify the transaction as a vote')

		const governanceContractInterface = new Interface(CompoundGovernanceAbi)
		const voteFunction = governanceContractInterface.getFunction(fourByteString)
		if (voteFunction === null) return returnError('Could not find the voting function')
		if (pendingTransaction.transactionToSimulate.transaction.to === null) return returnError('The transaction creates a contract instead of casting a vote')
		const params = governanceContractInterface.decodeFunctionData(voteFunction, dataStringWith0xStart(pendingTransaction.transactionToSimulate.transaction.input))
		const addr = await identifyAddress(ethereum, undefined, pendingTransaction.transactionToSimulate.transaction.to)
		if (!('abi' in addr) || addr.abi === undefined) return { success: false as const, errorType: 'MissingAbi' as const, errorMessage: 'ABi for the governance contract is missing', errorAddressBookEntry: addr }
		const contractExecutionResult = await simulateCompoundGovernanceExecution(ethereum, addr, params[0])
		if (contractExecutionResult === undefined) return returnError('Failed to simulate governance execution')
		const parentBlock = await ethereum.getBlock(undefined)
		if (parentBlock === null) throw new Error('The latest block is null')
		if (parentBlock.baseFeePerGas === undefined) return returnError('cannot build simulation from legacy block')
		const signedExecutionTransaction = mockSignTransaction({ ...contractExecutionResult.executingTransaction, gas: contractExecutionResult.ethSimulateV1CallResult.gasUsed })
		const tokenBalancesAfter = await getTokenBalancesAfterForTransaction(
			ethereum,
			undefined,
			{ blocks: [] }, // we are simulating on top of mainnet, not top of our stack. Fix to simulate on right place of the stack
			contractExecutionResult.ethSimulateV1CallResult,
			contractExecutionResult.executingTransaction.from
		)

		const governanceContractSimulationState: SimulationState = {
			simulatedBlocks: [{
				signedMessages: [],
				stateOverrides: {},
				timeIncreaseDelta: 1n,
				simulatedTransactions: [{
					preSimulationTransaction: {
						signedTransaction: signedExecutionTransaction,
						website: pendingTransaction.transactionToSimulate.website,
						created: new Date(),
						originalRequestParameters: pendingTransaction.originalRequestParameters,
						transactionIdentifier: pendingTransaction.transactionIdentifier,
					},
					realizedGasPrice: calculateRealizedEffectiveGasPrice(signedExecutionTransaction, parentBlock.baseFeePerGas),
					ethSimulateV1CallResult: contractExecutionResult.ethSimulateV1CallResult,
					tokenBalancesAfter,
				}],
			}],
			blockNumber: parentBlock.number,
			blockTimestamp: parentBlock.timestamp,
			baseFeePerGas: parentBlock.baseFeePerGas,
			rpcNetwork: ethereum.getRpcEntry(),
			simulationConductedTimestamp: new Date(),
		}
		return { success: true as const, result: await visualizeSimulatorState(governanceContractSimulationState, ethereum, tokenPriceService, undefined) }
	} catch(error) {
		console.warn(error)
		if (error instanceof Error) return returnError(error.message)
		return returnError('Unknown error occured')
	}
}

export const simulateGnosisSafeMetaTransaction = async (gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx, simulationState: SimulationState | undefined, ethereumClientService: EthereumClientService, tokenPriceService: TokenPriceService): Promise<DistributiveOmit<SimulateExecutionReplyData, 'transactionOrMessageIdentifier'>> => {
	const returnError = (errorMessage: string) => ({ success: false as const, errorType: 'Other' as const, errorMessage })
	try {
		const delegateCallExecuteInterface = new ethers.Interface(['function delegateCallExecute(address, bytes memory) payable external returns (bytes memory)'])

		// Call: 0x0, DelegateCall: 0x1
		// https://github.com/safe-global/safe-smart-account/blob/main/contracts/libraries/Enum.sol
		const isDelegateCall = gnosisSafeMessage.message.message.operation === 0x1n
		const ORIGINAL_GNOSIS_SAFE = 0x0000000000000000000000000000000000920515n // Gnosis in leetspeak (9=G, 2=N, 0=O, 5=S, 1=I)
		/*
		If we are doing a normal call, we send a transaction from gnosis safe to the callable address
		If we are doing a delegate call, we do a following operation:
			1) move safe (gnosisSafeMessage.verifyingContract.address) -> ORIGINAL_GNOSIS_SAFE
			2) replace safe with GnosisSafeProxyProxy (a contract that delegates everything to ORIGINAL_GNOSIS_SAFE, except calls to `delegateCallExecute`)
			3) call safe (which is our proxyproxy) with `delegateCallExecute(address target, bytes memory callData)`
		*/

		const transactionBase = {
			value: gnosisSafeMessage.message.message.value,
			maxPriorityFeePerGas: 0n,
			maxFeePerGas: 0n,
			type: '1559' as const,
			from: gnosisSafeMessage.verifyingContract.address,
			nonce: 0n,
			chainId: ethereumClientService.getChainId(),
		}

		const transactionWithoutGas = { ...transactionBase, ...isDelegateCall ? {
			to: gnosisSafeMessage.verifyingContract.address,
			input: stringToUint8Array(delegateCallExecuteInterface.encodeFunctionData('delegateCallExecute', [addressString(gnosisSafeMessage.to.address), gnosisSafeMessage.parsedMessageData.input]))
		} : {
			to: gnosisSafeMessage.to.address,
			input: gnosisSafeMessage.parsedMessageData.input
		} }
		const gasLimit = gnosisSafeMessage.message.message.baseGas !== 0n ? {
			gas: gnosisSafeMessage.message.message.baseGas
		} : {
			gas: simulationGasLeft(simulationState?.simulatedBlocks.at(-1), await ethereumClientService.getBlock(undefined))
		}
		const transaction = { ...transactionWithoutGas, gas: gasLimit.gas }
		const metaTransaction: PreSimulationTransaction = {
			signedTransaction: mockSignTransaction(transaction),
			website: gnosisSafeMessage.website,
			created: new Date(),
			originalRequestParameters: { method: 'eth_sendTransaction', params: [transaction] },
			transactionIdentifier: gnosisSafeMessage.messageIdentifier,
		}
		const getTemporaryAccountOverrides = async () => {
			if (!isDelegateCall) return {}
			const gnosisSafeCode = await getSimulatedCode(ethereumClientService, undefined, simulationState, gnosisSafeMessage.verifyingContract.address)
			if (gnosisSafeCode?.getCodeReturn === undefined) throw new Error('Failed to simulate gnosis safe transaction. Could not retrieve gnosis safe code.')
			return {
				[addressString(gnosisSafeMessage.verifyingContract.address)]: { code: getGnosisSafeProxyProxy() },
				[addressString(ORIGINAL_GNOSIS_SAFE)]: { code: gnosisSafeCode.getCodeReturn }
			}
		}
		const temporaryAccountOverrides = await getTemporaryAccountOverrides()
		const simulationStateAfterGnosisSafeMetaTransaction = await appendTransactionToInputAndSimulate(ethereumClientService, undefined, simulationState, [metaTransaction], undefined, temporaryAccountOverrides)
		return { success: true as const, result: await visualizeSimulatorState(simulationStateAfterGnosisSafeMetaTransaction, ethereumClientService, tokenPriceService, undefined) }
	} catch(error) {
		console.warn(error)
		if (error instanceof Error) return returnError(error.message)
		return returnError('Unknown error occured')
	}
}

export const updateSimulationMetadata = async (ethereum: EthereumClientService, requestAbortController: AbortController | undefined) => {
	return await updateSimulationResultsWithCallBack(async (prevState) => {
		if (prevState?.simulationState === undefined) return prevState
		try {
			const eventsForEachBlockAndTransactionPromise = Promise.all(
				prevState.simulationState.simulatedBlocks.map((block) =>
					Promise.all(block.simulatedTransactions.map(
						async (simulatedTransaction) => simulatedTransaction.ethSimulateV1CallResult.status === 'failure' ? [] : await parseEvents(simulatedTransaction.ethSimulateV1CallResult.logs, ethereum, requestAbortController)
					))
				)
			)
			const parsedInputDataForEachBlockAndTransactionPromise = Promise.all(
				prevState.simulationState.simulatedBlocks.map((block) => {
					const transactions = getWebsiteCreatedEthereumUnsignedTransactions(block.simulatedTransactions)
					return Promise.all(transactions.map((transaction) =>
						parseInputData({ to: transaction.transaction.to, input: transaction.transaction.input, value: transaction.transaction.value }, ethereum, requestAbortController)
					))
				})
			)
			const events = (await eventsForEachBlockAndTransactionPromise).flat()
			const inputData = (await parsedInputDataForEachBlockAndTransactionPromise).flat()

			//TODO, we should update signed messages here as well?

			const metadata = await updateMetadataForSimulation(prevState.simulationState, ethereum, requestAbortController, events, inputData)
			return { ...prevState, ...metadata }
		} catch (error) {
			if (error instanceof Error && isNewBlockAbort(error)) return prevState
			if (error instanceof Error && isFailedToFetchError(error)) return prevState
			handleUnexpectedError(error)
			return prevState
		}
	})
}

export const createSimulationStateWithNonceAndBaseFeeFixing = async (oldSimulationStateInput: SimulationStateInput, ethereum: EthereumClientService) => {
	const parentBlock = ethereum.getCachedBlock()
	const baseFeeFixedInputStateBlocks = parentBlock === undefined ? oldSimulationStateInput : { blocks: oldSimulationStateInput.blocks.map((block) => (
		modifyObject(block, { transactions: getBaseFeeAdjustedTransactions(parentBlock, block.transactions) })
	))}
	const newSimulationState = await createSimulationState(ethereum, undefined, baseFeeFixedInputStateBlocks)
	// rerun the simulation if nonce issues are found after fixing the nonce issues
	const nonceFixed = await getNonceFixedSimulationStateInput(ethereum, undefined, newSimulationState)
	if (nonceFixed.nonceFixed) return await createSimulationState(ethereum, undefined, nonceFixed.simulationStateInput)
	return newSimulationState
}

export async function visualizeSimulatorState(simulationState: SimulationState, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, requestAbortController: AbortController | undefined): Promise<VisualizedSimulatorState> {
	const getWeth = async (): Promise<Erc20TokenEntry | undefined> => {
		const wethAddr = getWethForChainId(ethereum.getRpcEntry().chainId)
		if (wethAddr === undefined) return undefined
		const entry = await identifyAddress(ethereum, requestAbortController, wethAddr)
		if (entry.type !== 'ERC20') return undefined
		return entry
	}
	const weth = await getWeth()
	const metadataRestructure = (metadata: AddressBookEntry & { type: 'ERC20', decimals: bigint }) => ({ address: metadata.address, decimals: metadata.decimals })
	function onlyTokensAndTokensWithKnownDecimals(metadata: AddressBookEntry): metadata is AddressBookEntry & { type: 'ERC20', decimals: `0x${ string }` } {
		return metadata.type === 'ERC20' && metadata.decimals !== undefined && metadata.address !== ETHEREUM_LOGS_LOGGER_ADDRESS
	}

	const settingsPromise = getSettings()
	const settings = await settingsPromise

	const eventsForEachBlockAndTransactionPromise = Promise.all(
		simulationState.simulatedBlocks.map((block) =>
			Promise.all(block.simulatedTransactions.map(
				async (simulatedTransaction) => simulatedTransaction.ethSimulateV1CallResult.status === 'failure' ? [] : await parseEvents(simulatedTransaction.ethSimulateV1CallResult.logs, ethereum, requestAbortController)
			))
		)
	)
	const protectorsForEachBlockAndTransactionPromise = Promise.all(
		simulationState.simulatedBlocks.map((block) => {
			const transactions = getWebsiteCreatedEthereumUnsignedTransactions(block.simulatedTransactions)
			return Promise.all(transactions.map((transaction) =>
				// TODO, we need to slice the simulation here!
				runProtectorsForTransaction(simulationState, transaction, ethereum, requestAbortController)
			))
		})
	)

	const parsedInputDataForEachBlockAndTransactionPromise = Promise.all(
		simulationState.simulatedBlocks.map((block) => {
			const transactions = getWebsiteCreatedEthereumUnsignedTransactions(block.simulatedTransactions)
			return Promise.all(transactions.map((transaction) =>
				parseInputData({ to: transaction.transaction.to, input: transaction.transaction.input, value: transaction.transaction.value }, ethereum, requestAbortController)
			))
		})
	)

	const eventsForEachBlockAndTransaction = await eventsForEachBlockAndTransactionPromise
	const parsedInputDataForEachBlockAndTransaction = await parsedInputDataForEachBlockAndTransactionPromise
	const updatedMetadata = await updateMetadataForSimulation(simulationState, ethereum, requestAbortController, eventsForEachBlockAndTransaction.flat(), parsedInputDataForEachBlockAndTransaction.flat())

	const tokenPriceEstimatesPromise = weth === undefined ? [] : tokenPriceService.estimateEthereumPricesForTokens(requestAbortController, weth, updatedMetadata.addressBookEntries.filter(onlyTokensAndTokensWithKnownDecimals).map(metadataRestructure))

	const protectorsForEachBlockAndTransaction = await protectorsForEachBlockAndTransactionPromise

	const tokenPriceEstimates = await tokenPriceEstimatesPromise
	const visualizedBlocks = await Promise.all(simulationState.simulatedBlocks.map(async(block, blockIndex) => {
		const eventsForEachTransaction = eventsForEachBlockAndTransaction[blockIndex]
		const parsedInputDataForBlock = parsedInputDataForEachBlockAndTransaction[blockIndex]
		const protectorsForBlock = protectorsForEachBlockAndTransaction[blockIndex]
		if (eventsForEachTransaction === undefined || parsedInputDataForBlock === undefined || protectorsForBlock === undefined) throw new Error('Block index overflow')
		return {
			visualizedPersonalSignRequests: await Promise.all(block.signedMessages.map((signedMessage) => craftPersonalSignPopupMessage(ethereum, requestAbortController, signedMessage, settings.activeRpcNetwork))),
			simulatedAndVisualizedTransactions: formSimulatedAndVisualizedTransactions(block.simulatedTransactions, eventsForEachTransaction, simulationState.rpcNetwork, parsedInputDataForBlock, protectorsForBlock, updatedMetadata.addressBookEntries, updatedMetadata.namedTokenIds, updatedMetadata.ens, tokenPriceEstimates, weth)
		}
	}))

	return {
		namedTokenIds: updatedMetadata.namedTokenIds,
		addressBookEntries: updatedMetadata.addressBookEntries,
		tokenPriceEstimates,
		tokenPriceQuoteToken: weth,
		//eventsForEachTransaction,
		//parsedInputData,
		//protectors,
		simulationState,
		visualizedSimulationState: { visualizedBlocks }
	}
}
