import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { DEFAULT_BLOCK_MANIPULATION, appendTransactionToInputAndSimulate, calculateRealizedEffectiveGasPrice, createExecutionSimulationState, createSimulationState, getAddressToMakeRich, getBaseFeeAdjustmentBalances, getNonceFixedSimulationStateInput, getSimulatedCode, getTokenBalancesAfterForTransaction, getWebsiteCreatedEthereumTransactions, mockSignTransaction, simulateEstimateGasFromInput, sliceSimulationState } from '../simulation/services/SimulationModeEthereumClientService.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { parseEvents, parseInputData } from '../simulation/parsing.js'
import { runProtectorsForTransaction } from '../simulation/protectorRunner.js'
import type { EnrichedEthereumEvents, EnrichedEthereumInputData } from '../types/EnrichedEthereumData.js'
import type { PendingTransaction } from '../types/accessRequest.js'
import type { AddressBookEntry, Erc20TokenEntry } from '../types/addressBookTypes.js'
import type { SimulateExecutionReplyData } from '../types/interceptor-messages.js'
import { type BlockTimeManipulation, type ExecutionSimulationState, type NonSimulatedAndVisualizedTransaction, type PreSimulationTransaction, type SignedMessageTransaction, type SimulationState, type SimulationStateInput, type SimulationStateInputBlock, type VisualizedSimulatorState, toResolvedSimulationInput } from '../types/visualizer-types.js'
import { get4Byte, get4ByteString } from '../utils/calldata.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, FourByteExplanations, MAKE_YOU_RICH_TRANSACTION } from '../utils/constants.js'
import { type DistributiveOmit, assertNever, modifyObject } from '../utils/typescript.js'
import { getAddressBookEntriesForVisualiserFromTransactions, identifyAddress, nameTokenIds, retrieveEnsNodeAndLabelHashes } from './metadataUtils.js'
import { getFixedAddressRichList, getPreSimulationBlockTimeManipulation, getSettings, getWethForChainId } from './settings.js'
import { addressString, dataStringWith0xStart, dateToBigintSeconds, stringToUint8Array } from '../utils/bigint.js'
import { simulateCompoundGovernanceExecution } from '../simulation/compoundGovernanceFaking.js'
import { CompoundGovernanceAbi } from '../utils/abi.js'
import type { VisualizedPersonalSignRequestSafeTx } from '../types/personal-message-definitions.js'
import { getGnosisSafeProxyProxy } from '../utils/ethereumByteCodes.js'
import { getInterceptorTransactionStack, updatePopupVisualisationWithCallBack } from './storageVariables.js'
import { JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, getErrorMessage } from '../utils/errors.js'
import { craftPersonalSignPopupMessage } from './windows/personalSign.js'
import { formSimulatedAndVisualizedTransactions, getFromAndToMetadata } from '../components/formVisualizerResults.js'
import { promiseAllMapAbortSafe, silenceChromeUnCaughtPromise } from '../utils/requests.js'
import { getUpdatedSimulationState } from './background.js'
import type { Abi } from '../utils/ethereumPrimitives.js'
import * as funtypes from 'funtypes'
import { decodeCallDataLoose, encodeFunctionCall } from '../utils/abiRuntime.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'

const delegateCallExecuteAbi = [
	{
		type: 'function',
		name: 'delegateCallExecute',
		stateMutability: 'payable',
		inputs: [
			{ name: 'target', type: 'address' },
			{ name: 'callData', type: 'bytes' },
		],
		outputs: [{ name: 'returnData', type: 'bytes' }],
	},
] as const satisfies Abi

const getMakeCurrentAddressRichStateOverride = (addressesToMakeRich: bigint[]) => {
	if (addressesToMakeRich.length === 0) return {}
	return Object.fromEntries(
		addressesToMakeRich.map(currentAddress => {
			const addressKey = addressString(currentAddress)
			return [addressKey, { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value }]
		})
	)
}

export const getAddressesbeingMadeRich = async () => {
	const currentAddressBeingRich = await getAddressToMakeRich()
	const makeRichAddressList = await getFixedAddressRichList()
	return [...makeRichAddressList.filter((x) => x.makingRich).map((x) => x.address), ...currentAddressBeingRich === undefined ? [] : [currentAddressBeingRich]]
}

export const getCurrentSimulationInput = async (): Promise<SimulationStateInput> => {
	const [settings, preSimulationBlockTimeManipulation] = await Promise.all([
		getSettings(),
		getPreSimulationBlockTimeManipulation()
	])
	const richListPromise = silenceChromeUnCaughtPromise(getAddressesbeingMadeRich())
	const stack = await getInterceptorTransactionStack()
	const inputBlocks: SimulationStateInputBlock[] = []
	let currentBlockTransactions: PreSimulationTransaction[] = []
	let currentBlockSignedMessages: SignedMessageTransaction[] = []
	let currentBlockStateOverrides = getMakeCurrentAddressRichStateOverride(await richListPromise)
	let previousBlockTimeManipulation = settings.simulationMode ? preSimulationBlockTimeManipulation : DEFAULT_BLOCK_MANIPULATION

	const pushBlock = (blockTimeManipulation: BlockTimeManipulation) => {
		inputBlocks.push({
			stateOverrides: currentBlockStateOverrides,
			transactions: currentBlockTransactions,
			signedMessages: currentBlockSignedMessages,
			blockTimeManipulation: previousBlockTimeManipulation,
			simulateWithZeroBaseFee: false,
		})
		previousBlockTimeManipulation = blockTimeManipulation
		currentBlockSignedMessages = []
		currentBlockStateOverrides = {}
		currentBlockTransactions = []
	}

	for (const operation of stack.operations) {
		switch(operation.type) {
			case 'Transaction': {
				currentBlockTransactions.push(operation.preSimulationTransaction)
				break
			}
			case 'Message': {
				if (currentBlockTransactions.length > 0) {
					pushBlock({ type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' })
				}
				currentBlockSignedMessages.push(operation.signedMessageTransaction)
				break
			}
			case 'TimeManipulation': {
				pushBlock(operation.blockTimeManipulation)
				break
			}
			default: assertNever(operation)
		}
	}
	if (
		currentBlockTransactions.length > 0
		|| currentBlockSignedMessages.length > 0
		|| Object.keys(currentBlockStateOverrides).length > 0
	) {
		inputBlocks.push({
			stateOverrides: currentBlockStateOverrides,
			transactions: currentBlockTransactions,
			signedMessages: currentBlockSignedMessages,
			blockTimeManipulation: previousBlockTimeManipulation,
			simulateWithZeroBaseFee: false,
		})
	}
	return inputBlocks
}

export async function getMetadataForSimulation(
	simulationState: SimulationState,
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
	eventsForEachTransaction: readonly EnrichedEthereumEvents[],
	inputData: readonly EnrichedEthereumInputData[],
) {
	const allEvents = eventsForEachTransaction.flat()
	const addressBookEntryPromises = silenceChromeUnCaughtPromise(getAddressBookEntriesForVisualiserFromTransactions(ethereum, requestAbortController, allEvents, inputData, simulationState.simulationStateInput))
	const namedTokenIdPromises = silenceChromeUnCaughtPromise(nameTokenIds(ethereum, allEvents))
	const addressBookEntries = await addressBookEntryPromises
	const ensPromise = silenceChromeUnCaughtPromise(retrieveEnsNodeAndLabelHashes(ethereum, allEvents, addressBookEntries))
	const namedTokenIds = await namedTokenIdPromises
	return {
		namedTokenIds,
		addressBookEntries: addressBookEntries,
		ens: await ensPromise
	}
}

async function getDelegationAddressesForSimulation(
	simulationStateInput: SimulationStateInput,
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
) {
	const uniqueSenders = Array.from(new Set(simulationStateInput.flatMap((block) => block.transactions.map((transaction) => transaction.signedTransaction.from))))
	const resolvedDelegations = await promiseAllMapAbortSafe(uniqueSenders, async (senderAddress) => {
		try {
			const delegationAddress = await ethereum.getDelegation(senderAddress, 'latest', requestAbortController)
			if (delegationAddress === undefined) return undefined
			return {
				senderAddress,
				delegationEntry: await identifyAddress(ethereum, requestAbortController, delegationAddress),
			}
		} catch(error: unknown) {
			if (isExpectedInfrastructureError(error)) throw error
			const senderAddressString = addressString(senderAddress)
			const errorMessage = getErrorMessage(error) ?? 'Unknown error'
			await reportUnexpectedError(error, {
				displayMessage: `Failed to retrieve EIP-7702 delegation for ${ senderAddressString }: ${ errorMessage }`,
				code: 'delegation_lookup_failed',
				details: { senderAddress: senderAddressString },
				suppressExpectedInfrastructure: false,
			})
			return undefined
		}
	})
	return new Map(resolvedDelegations
		.filter((entry): entry is { senderAddress: bigint, delegationEntry: AddressBookEntry } => entry !== undefined)
		.map((entry) => [addressString(entry.senderAddress), entry.delegationEntry] as const))
}

export const getGovernanceExecutionSimulationInput = (
	simulationInput: SimulationStateInput,
	executionTransaction: PreSimulationTransaction,
	executionTimestamp: Date,
	executionStateOverrides: StateOverrides,
): SimulationStateInput => {
	return [
		...simulationInput,
		{
			stateOverrides: executionStateOverrides,
			transactions: [executionTransaction],
			signedMessages: [],
			blockTimeManipulation: { type: 'SetTimetamp', timeToSet: dateToBigintSeconds(executionTimestamp) },
			simulateWithZeroBaseFee: false,
		},
	]
}

export const getGovernanceExecutionTokenBalancesAfter = async (
	ethereum: EthereumClientService,
	simulationInput: SimulationStateInput,
	executionTransaction: PreSimulationTransaction,
	executionTimestamp: Date,
	executionStateOverrides: StateOverrides,
	callResult: Parameters<typeof getTokenBalancesAfterForTransaction>[3],
) => {
	const simulationInputAfterExecution = getGovernanceExecutionSimulationInput(
		simulationInput,
		executionTransaction,
		executionTimestamp,
		executionStateOverrides,
	)
	return await getTokenBalancesAfterForTransaction(
		ethereum,
		undefined,
		simulationInputAfterExecution,
		callResult,
		executionTransaction.signedTransaction.from
	)
}

export const simulateGovernanceContractExecution = async (pendingTransaction: PendingTransaction, ethereum: EthereumClientService, tokenPriceService: TokenPriceService): Promise<DistributiveOmit<SimulateExecutionReplyData, 'transactionOrMessageIdentifier'>> => {
	const returnError = (errorMessage: string) => ({ success: false as const, errorType: 'Other' as const, errorMessage })
	try {
		// identifies compound governane call and performs simulation if the vote passes
		if (pendingTransaction.transactionOrMessageCreationStatus !== 'Simulated') return returnError('Still simulating the voting transaction')
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
		) return returnError('Could not identify the transaction as a vote')

		if (pendingTransaction.transactionToSimulate.transaction.to === null) return returnError('The transaction creates a contract instead of casting a vote')
		const params = decodeCallDataLoose(CompoundGovernanceAbi, dataStringWith0xStart(pendingTransaction.transactionToSimulate.transaction.input))
		if (params === undefined) return returnError('Could not find the voting function')
		const { proposalId: rawProposalId } = params.namedArgs
		const proposalId = funtypes.BigInt.parse(rawProposalId)
		const addr = await identifyAddress(ethereum, undefined, pendingTransaction.transactionToSimulate.transaction.to)
		if (!('abi' in addr) || addr.abi === undefined) return { success: false as const, errorType: 'MissingAbi' as const, errorMessage: 'ABi for the governance contract is missing', errorAddressBookEntry: addr }
		const contractExecutionResult = await simulateCompoundGovernanceExecution(ethereum, addr, proposalId)
		if (contractExecutionResult === undefined) return returnError('Failed to simulate governance execution')
		const parentBlock = await ethereum.getBlock(undefined)
		if (parentBlock === null) throw new Error('The latest block is null')
		if (parentBlock.baseFeePerGas === undefined) return returnError('cannot build simulation from legacy block')
		const simulationInput = await getCurrentSimulationInput()
		const signedExecutionTransaction = mockSignTransaction({ ...contractExecutionResult.executingTransaction, gas: contractExecutionResult.ethSimulateV1CallResult.gasUsed })
		const executionTransaction: PreSimulationTransaction = {
			signedTransaction: signedExecutionTransaction,
			website: pendingTransaction.transactionToSimulate.website,
			created: new Date(),
			originalRequestParameters: pendingTransaction.originalRequestParameters,
			transactionIdentifier: pendingTransaction.transactionIdentifier,
		}
		const governanceExecutionSimulationInput = getGovernanceExecutionSimulationInput(
			simulationInput,
			executionTransaction,
			contractExecutionResult.executionTimestamp,
			contractExecutionResult.executionStateOverrides,
		)
		const tokenBalancesAfter = await getGovernanceExecutionTokenBalancesAfter(
			ethereum,
			simulationInput,
			executionTransaction,
			contractExecutionResult.executionTimestamp,
			contractExecutionResult.executionStateOverrides,
			contractExecutionResult.ethSimulateV1CallResult,
		)

		const governanceContractSimulationState: SimulationState = {
			success: true,
			simulationStateInput: governanceExecutionSimulationInput.slice(-1),
			simulatedBlocks: [{
				signedMessages: [],
				stateOverrides: contractExecutionResult.executionStateOverrides,
				blockTimestamp: contractExecutionResult.executionTimestamp,
				blockTimeManipulation: { type: 'SetTimetamp', timeToSet: dateToBigintSeconds(contractExecutionResult.executionTimestamp) },
				simulatedTransactions: [{
					preSimulationTransaction: executionTransaction,
					realizedGasPrice: calculateRealizedEffectiveGasPrice(signedExecutionTransaction, parentBlock.baseFeePerGas),
					ethSimulateV1CallResult: contractExecutionResult.ethSimulateV1CallResult,
					tokenBalancesAfter,
				}],
				blockBaseFeePerGas: parentBlock.baseFeePerGas,
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

export const simulateGnosisSafeMetaTransaction = async (gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx, simulationInput: SimulationStateInput, ethereumClientService: EthereumClientService, tokenPriceService: TokenPriceService): Promise<DistributiveOmit<SimulateExecutionReplyData, 'transactionOrMessageIdentifier'>> => {
	const returnError = (errorMessage: string) => ({ success: false as const, errorType: 'Other' as const, errorMessage })
	try {
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
			input: stringToUint8Array(encodeFunctionCall(delegateCallExecuteAbi, 'delegateCallExecute', [addressString(gnosisSafeMessage.to.address), dataStringWith0xStart(gnosisSafeMessage.parsedMessageData.input)]))
		} : {
			to: gnosisSafeMessage.to.address,
			input: gnosisSafeMessage.parsedMessageData.input
		} }
		const simulationState = await getUpdatedSimulationState(ethereumClientService)
		if (simulationState.kind === 'passthrough') throw new Error('Failed to fetch simulation state for Gnosis Safe transaction.')
		if (simulationState.value.success === false) throw new JsonRpcResponseError(simulationState.value.jsonRpcError)
		const resolvedSimulationState = simulationState.value
		const getTemporaryAccountOverrides = async () => {
			if (!isDelegateCall) return {}
			const gnosisSafeCode = await getSimulatedCode(ethereumClientService, undefined, { kind: 'simulated', value: resolvedSimulationState }, gnosisSafeMessage.verifyingContract.address)
			if (gnosisSafeCode?.getCodeReturn === undefined) throw new Error('Failed to simulate gnosis safe transaction. Could not retrieve gnosis safe code.')
			return {
				[addressString(gnosisSafeMessage.verifyingContract.address)]: { code: getGnosisSafeProxyProxy() },
				[addressString(ORIGINAL_GNOSIS_SAFE)]: { code: gnosisSafeCode.getCodeReturn }
			}
		}
		const temporaryAccountOverrides = await getTemporaryAccountOverrides()
		const gasLimit = gnosisSafeMessage.message.message.baseGas !== 0n ? {
			gas: gnosisSafeMessage.message.message.baseGas
		} : await (async () => {
			const estimateGas = await simulateEstimateGasFromInput(ethereumClientService, undefined, toResolvedSimulationInput(simulationInput), transactionWithoutGas, undefined, temporaryAccountOverrides)
			if ('error' in estimateGas) throw new Error(estimateGas.error.message)
			return { gas: estimateGas.gas }
		})()
		const transaction = { ...transactionWithoutGas, gas: gasLimit.gas }
		const metaTransaction: PreSimulationTransaction = {
			signedTransaction: mockSignTransaction(transaction),
			website: gnosisSafeMessage.website,
			created: new Date(),
			originalRequestParameters: { method: 'eth_sendTransaction', params: [transaction] },
			transactionIdentifier: gnosisSafeMessage.messageIdentifier,
		}
		const simulationStateAfterGnosisSafeMetaTransaction = await appendTransactionToInputAndSimulate(ethereumClientService, undefined, simulationInput, [metaTransaction], undefined, temporaryAccountOverrides)
		return { success: true as const, result: await visualizeSimulatorState(simulationStateAfterGnosisSafeMetaTransaction, ethereumClientService, tokenPriceService, undefined) }
	} catch(error) {
		console.warn(error)
		if (error instanceof Error) return returnError(error.message)
		return returnError('Unknown error occured')
	}
}

export const updateSimulationMetadata = async (ethereum: EthereumClientService, requestAbortController: AbortController | undefined) => {
	return await updatePopupVisualisationWithCallBack(async (prevState) => {
		if (prevState.simulationState.kind === 'passthrough') return prevState
		if (prevState.simulationState.value.success === false) return prevState
		try {
			const eventsForEachBlockAndTransactionPromise = silenceChromeUnCaughtPromise(promiseAllMapAbortSafe(
				prevState.simulationState.value.simulatedBlocks, async (block) =>
					promiseAllMapAbortSafe(block.simulatedTransactions,
						async (simulatedTransaction) => simulatedTransaction.ethSimulateV1CallResult.status === 'failure' ? [] : await parseEvents(simulatedTransaction.ethSimulateV1CallResult.logs, ethereum, requestAbortController)
					)
				)
			)
			const parsedInputDataForEachBlockAndTransactionPromise = silenceChromeUnCaughtPromise(promiseAllMapAbortSafe(
				prevState.simulationState.value.simulatedBlocks, async (block) => {
					const transactions = getWebsiteCreatedEthereumTransactions(block.simulatedTransactions)
					return promiseAllMapAbortSafe(transactions, (transaction) =>
						parseInputData({ to: transaction.transaction.to, input: transaction.transaction.input, value: transaction.transaction.value }, ethereum, requestAbortController)
					)
				}
			))
			const events = (await eventsForEachBlockAndTransactionPromise).flat()
			const inputData = (await parsedInputDataForEachBlockAndTransactionPromise).flat()

			const metadata = await getMetadataForSimulation(prevState.simulationState.value, ethereum, requestAbortController, events, inputData)
			return { ...prevState, ...metadata }
		} catch (error) {
			if (isExpectedInfrastructureError(error)) return prevState
			await reportUnexpectedError(error)
			return prevState
		}
	})
}

export const prepareSimulationInputForRpc = async (simulationInput: SimulationStateInput, ethereum: EthereumClientService) => {
	const parentBlock = await ethereum.getBlock(undefined)
	const getBaseFeeFixedInputStateBlocks = async () => {
		if (parentBlock === undefined) return simulationInput
		const baseFeeFixedInputStateBlocks: SimulationStateInputBlock[] = []
		for (const block of simulationInput) {
			const { transactions } = await getBaseFeeAdjustmentBalances(ethereum, undefined, parentBlock, baseFeeFixedInputStateBlocks, block)
			baseFeeFixedInputStateBlocks.push(modifyObject(block, { transactions }))
		}
		return baseFeeFixedInputStateBlocks
	}
	const baseFeeFixedInputStateBlocks = await getBaseFeeFixedInputStateBlocks()
	const nonceFixed = await getNonceFixedSimulationStateInput(ethereum, undefined, baseFeeFixedInputStateBlocks)
	return nonceFixed.nonceFixed ? nonceFixed.simulationStateInput : baseFeeFixedInputStateBlocks
}

export const buildSimulationStateFromPreparedInput = async (preparedSimulationInput: SimulationStateInput, ethereum: EthereumClientService) => {
	return await createSimulationState(ethereum, undefined, preparedSimulationInput)
}

export const buildExecutionSimulationStateFromPreparedInput = async (preparedSimulationInput: SimulationStateInput, ethereum: EthereumClientService): Promise<ExecutionSimulationState> => {
	return await createExecutionSimulationState(ethereum, undefined, preparedSimulationInput)
}

export const createSimulationStateWithNonceAndBaseFeeFixing = async (simulationInput: SimulationStateInput, ethereum: EthereumClientService) => {
	return await buildSimulationStateFromPreparedInput(await prepareSimulationInputForRpc(simulationInput, ethereum), ethereum)
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
	const settings = await getSettings()
	const delegationAddressBySender = await getDelegationAddressesForSimulation(simulationState.simulationStateInput, ethereum, requestAbortController)

	const parsedInputDataForEachBlockAndTransactionPromise = promiseAllMapAbortSafe(
		simulationState.simulationStateInput, async (block) => {
			return await promiseAllMapAbortSafe(block.transactions, async (transaction) =>
				await parseInputData({ to: transaction.signedTransaction.to, input: transaction.signedTransaction.input, value: transaction.signedTransaction.value }, ethereum, requestAbortController)
			)
		}
	)

	if (simulationState.success === false) {
		const parsedInputDataForEachBlockAndTransaction = await parsedInputDataForEachBlockAndTransactionPromise
		const updatedMetadata = await getMetadataForSimulation(simulationState, ethereum, requestAbortController, [], parsedInputDataForEachBlockAndTransaction.flat())
		const refreshedSimulationState = modifyObject(simulationState, { simulationConductedTimestamp: new Date() })

		const visualizedBlocks = await promiseAllMapAbortSafe(simulationState.simulationStateInput, async (block, blockIndex) => {
			const parsedInputDataForBlock = parsedInputDataForEachBlockAndTransaction[blockIndex]
			if (parsedInputDataForBlock === undefined) throw new Error('Block index overflow')

			return {
				visualizedPersonalSignRequests: await promiseAllMapAbortSafe(block.signedMessages, (signedMessage) => silenceChromeUnCaughtPromise(craftPersonalSignPopupMessage(ethereum, requestAbortController, signedMessage, settings.activeRpcNetwork))),
				simulatedAndVisualizedTransactions: block.transactions.map((transaction, index): NonSimulatedAndVisualizedTransaction => {
					const removeFromAndToFromSignedTransaction = () => {
						const { from, to, ...otherFields } = transaction.signedTransaction
						return otherFields
					}
					const otherFields = removeFromAndToFromSignedTransaction()
					const parsedInputData = parsedInputDataForBlock[index]
					if (parsedInputData === undefined) throw new Error('Transaction index overflow')
					return {
						...transaction,
						transactionStatus: 'Failed To Simulate',
						error: { code: -1000000, message: 'Could not simulate transaction', decodedErrorMessage: 'Could not simulate transaction' },
						parsedInputData,
						transaction: {
							...getFromAndToMetadata(transaction.signedTransaction, updatedMetadata.addressBookEntries),
							...(delegationAddressBySender.get(addressString(transaction.signedTransaction.from)) !== undefined ? { delegationAddress: delegationAddressBySender.get(addressString(transaction.signedTransaction.from)) } : {}),
							rpcNetwork: settings.activeRpcNetwork,
							...otherFields,
						},
					}
				}),
				blockTimeManipulation: block.blockTimeManipulation,
			}
		})

		return {
			addressBookEntries: updatedMetadata.addressBookEntries,
			tokenPriceEstimates: [],
			tokenPriceQuoteToken: weth,
			namedTokenIds: updatedMetadata.namedTokenIds,
			simulationState: refreshedSimulationState,
			visualizedSimulationState: { success: false, jsonRpcError: simulationState.jsonRpcError, visualizedBlocks }
		}
	}

	const metadataRestructure = (metadata: AddressBookEntry & { type: 'ERC20', decimals: bigint }) => ({ address: metadata.address, decimals: metadata.decimals })
	function onlyTokensAndTokensWithKnownDecimals(metadata: AddressBookEntry): metadata is AddressBookEntry & { type: 'ERC20', decimals: `0x${ string }` } {
		return metadata.type === 'ERC20' && metadata.decimals !== undefined && metadata.address !== ETHEREUM_LOGS_LOGGER_ADDRESS
	}

	const eventsForEachBlockAndTransactionPromise = promiseAllMapAbortSafe(simulationState.simulatedBlocks, async (block) =>
		await promiseAllMapAbortSafe(block.simulatedTransactions,
			async (simulatedTransaction) => simulatedTransaction.ethSimulateV1CallResult.status === 'failure' ? [] : await parseEvents(simulatedTransaction.ethSimulateV1CallResult.logs, ethereum, requestAbortController)
		)
	)
	const protectorsForEachBlockAndTransactionPromise = promiseAllMapAbortSafe(
		simulationState.simulatedBlocks, async (block, blockIndex) => {
			const transactions = getWebsiteCreatedEthereumTransactions(block.simulatedTransactions)
			return await promiseAllMapAbortSafe(transactions, async (transaction, transactionIndex) => {
				const slicedSimulationState = sliceSimulationState(simulationState, blockIndex, transactionIndex)
				return await runProtectorsForTransaction(slicedSimulationState, transaction, ethereum, requestAbortController)
			})
		}
	)

	const eventsForEachBlockAndTransaction = await eventsForEachBlockAndTransactionPromise
	const parsedInputDataForEachBlockAndTransaction = await parsedInputDataForEachBlockAndTransactionPromise
	const updatedMetadata = await getMetadataForSimulation(simulationState, ethereum, requestAbortController, eventsForEachBlockAndTransaction.flat(), parsedInputDataForEachBlockAndTransaction.flat())

	const tokenPriceEstimatesPromise = weth === undefined ? [] : silenceChromeUnCaughtPromise(tokenPriceService.estimateEthereumPricesForTokens(requestAbortController, weth, updatedMetadata.addressBookEntries.filter(onlyTokensAndTokensWithKnownDecimals).map(metadataRestructure)))

	const protectorsForEachBlockAndTransaction = await protectorsForEachBlockAndTransactionPromise

	const tokenPriceEstimates = await tokenPriceEstimatesPromise
	const refreshedSimulationState = modifyObject(simulationState, { simulationConductedTimestamp: new Date() })

	const visualizedBlocks = await promiseAllMapAbortSafe(simulationState.simulatedBlocks, async (block, blockIndex) => {
		const eventsForEachTransaction = eventsForEachBlockAndTransaction[blockIndex]
		const parsedInputDataForBlock = parsedInputDataForEachBlockAndTransaction[blockIndex]
		const protectorsForBlock = protectorsForEachBlockAndTransaction[blockIndex]
		if (eventsForEachTransaction === undefined || parsedInputDataForBlock === undefined || protectorsForBlock === undefined) throw new Error('Block index overflow')
		return {
			visualizedPersonalSignRequests: await promiseAllMapAbortSafe(block.signedMessages, (signedMessage) => silenceChromeUnCaughtPromise(craftPersonalSignPopupMessage(ethereum, requestAbortController, signedMessage, settings.activeRpcNetwork))),
			simulatedAndVisualizedTransactions: formSimulatedAndVisualizedTransactions(block.simulatedTransactions, eventsForEachTransaction, simulationState.rpcNetwork, parsedInputDataForBlock, protectorsForBlock, updatedMetadata.addressBookEntries, updatedMetadata.namedTokenIds, updatedMetadata.ens, tokenPriceEstimates, weth, delegationAddressBySender),
			blockTimeManipulation: block.blockTimeManipulation,
		}
	})

	return {
		namedTokenIds: updatedMetadata.namedTokenIds,
		addressBookEntries: updatedMetadata.addressBookEntries,
		tokenPriceEstimates,
		tokenPriceQuoteToken: weth,
		simulationState: refreshedSimulationState,
		visualizedSimulationState: { success: true, visualizedBlocks },
	}
}
