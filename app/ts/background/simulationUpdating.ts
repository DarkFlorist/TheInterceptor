import type { Settings } from '../types/interceptor-messages.js'
import type { RpcNetwork } from '../types/rpc.js'
import { isSignerOnlyNetwork } from '../utils/rpcNetworkChange.js'
import { prepareSafeDelegateSimulationInput, prepareSafeDelegateStateOverrides, ORIGINAL_GNOSIS_SAFE, SAFE_DELEGATE_EXECUTE_ABI } from '../safe/safeSimulation.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionToInputAndSimulate, createExecutionSimulationState, createSimulationState, getBaseFeeAdjustmentBalances, getNonceFixedSimulationStateInput, getSimulatedCode, getTokenBalancesAfterForTransaction, getWebsiteCreatedEthereumTransactions, selectAddressToMakeRich, simulateEstimateGasFromInput, sliceSimulationState } from '../simulation/services/SimulationModeEthereumClientService.js'
import { calculateRealizedEffectiveGasPrice } from '../simulation/services/simulationBlockParameters.js'
import { mockSignTransaction } from '../simulation/services/simulationTransactionSigning.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../config/defaults.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { parseEvents, parseInputData } from '../simulation/parsing.js'
import { runProtectorsForTransaction } from '../simulation/protectorRunner.js'
import type { EnrichedEthereumEvents, EnrichedEthereumInputData } from '../types/EnrichedEthereumData.js'
import type { PendingTransaction } from '../types/accessRequest.js'
import type { AddressBookEntry, Erc20TokenEntry } from '../types/addressBookTypes.js'
import type { SimulateExecutionReplyData } from '../types/interceptor-messages.js'
import { PASSTHROUGH_STATE, type BlockTimeManipulation, type ExecutionSimulationState, type InterceptorStackOperation, InterceptorTransactionStack, type NonSimulatedAndVisualizedTransaction, type PreSimulationTransaction, type SignedMessageTransaction, type SimulationState, type SimulationStateInput, type SimulationStateInputBlock, type VisualizedSimulatorState, toResolvedSimulationInput, toResolvedSimulationState } from '../types/visualizer-types.js'
import { get4Byte, get4ByteString } from '../utils/calldata.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, FourByteExplanations, MAKE_YOU_RICH_TRANSACTION } from '../utils/constants.js'
import { type DistributiveOmit, assertNever, modifyObject } from '../utils/typescript.js'
import { getAddressBookEntriesForVisualiserFromTransactions, identifyAddress, nameTokenIds, retrieveEnsNodeAndLabelHashes } from './metadataUtils.js'
import { getSettings, getSimulationSettingsSnapshot, getWethForChainId, type SimulationSettingsSnapshot } from './settings.js'
import { addressString, dataStringWith0xStart, dateToBigintSeconds, stringifyJSONWithBigInts, stringToUint8Array } from '../utils/bigint.js'
import { simulateCompoundGovernanceExecution } from '../simulation/compoundGovernanceFaking.js'
import { CompoundGovernanceAbi } from '../utils/abi.js'
import type { VisualizedPersonalSignRequestSafeTx } from '../types/personal-message-definitions.js'
import { getGnosisSafeProxyProxy } from '../utils/ethereumByteCodes.js'
import { getInterceptorTransactionStack, updatePopupVisualisationWithCallBack } from './storageVariables.js'
import { keccak256, stringToBytes } from '../utils/ethereumPrimitives.js'
import { serialize } from '../types/wire-types.js'
import { JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, getErrorMessage } from '../utils/errors.js'
import { craftPersonalSignPopupMessage } from './windows/personalSign.js'
import { formSimulatedAndVisualizedTransactions, getFromAndToMetadata } from '../components/formVisualizerResults.js'
import { promiseAllMapAbortSafe, silenceChromeUnCaughtPromise } from '../utils/requests.js'
import * as funtypes from 'funtypes'
import { decodeCallDataLoose, encodeFunctionCall } from '../utils/abiRuntime.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'
import { type ActiveStackContext, getActiveStackContext, getOperationsForActiveStackContext } from '../utils/activeStackContext.js'

const getMakeCurrentAddressRichStateOverride = (addressesToMakeRich: readonly bigint[]) => {
	if (addressesToMakeRich.length === 0) return {}
	return Object.fromEntries(
		addressesToMakeRich.map(currentAddress => {
			const addressKey = addressString(currentAddress)
			return [addressKey, { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value }]
		})
	)
}

const selectAddressesBeingMadeRich = (settings: Settings, makeCurrentAddressRich: boolean, fixedAddressRichList: SimulationSettingsSnapshot['fixedAddressRichList']) => {
	if (!settings.simulationMode) return []
	const currentAddressBeingRich = selectAddressToMakeRich(settings, makeCurrentAddressRich)
	return [...fixedAddressRichList.filter((x) => x.makingRich).map((x) => x.address), ...currentAddressBeingRich === undefined ? [] : [currentAddressBeingRich]]
}

// Everything getSimulationInputForStack reads: the stack and the values derived from one settings snapshot that decide the input. It holds nothing else, so unrelated settings such as website access stay out of it, and its fingerprint covers every field it has.
export type StackSimulationContext = {
	readonly stack: InterceptorTransactionStack
	readonly chainId: bigint
	readonly activeStackContext: ActiveStackContext
	readonly preSimulationBlockTimeManipulation: BlockTimeManipulation
	readonly richAddresses: readonly bigint[]
}

export const toStackSimulationContext = (snapshot: SimulationSettingsSnapshot, stack: InterceptorTransactionStack): StackSimulationContext => ({
	stack,
	chainId: snapshot.settings.activeRpcNetwork.chainId,
	activeStackContext: getActiveStackContext(snapshot.settings),
	preSimulationBlockTimeManipulation: snapshot.preSimulationBlockTimeManipulation,
	richAddresses: selectAddressesBeingMadeRich(snapshot.settings, snapshot.makeCurrentAddressRich, snapshot.fixedAddressRichList),
})

// Every simulation input is built this way: the settings in one storage call, then the stack. The snapshot is returned too, for callers that need more of the settings than the input does.
export const captureStackSimulationContext = async () => {
	const snapshot = await getSimulationSettingsSnapshot()
	return { snapshot, context: toStackSimulationContext(snapshot, await getInterceptorTransactionStack()) }
}

// Hashes every field of the context, so it changes whenever the input simulated from the context could change, including through a field added to the context later.
export function getStackSimulationContextFingerprint(context: StackSimulationContext) {
	return keccak256(stringToBytes(stringifyJSONWithBigInts({ ...context, stack: serialize(InterceptorTransactionStack, context.stack) })))
}

// Converts the stack, followed by appendedOperations, into simulation input: consecutive transactions share a block until a message, a time manipulation or a change of base fee mode starts the next one. Operations previewed as appendedOperations therefore land exactly where approval adds them to the stack. With openBlockForNextTransaction the input ends with the block that a further transaction would join, even while that block is still empty, so the transaction can be estimated where approval would add it.
export function getSimulationInputForStack(context: StackSimulationContext, appendedOperations: readonly InterceptorStackOperation[] = [], openBlockForNextTransaction = false): SimulationStateInput {
	const inputBlocks: SimulationStateInputBlock[] = []
	let currentBlockTransactions: PreSimulationTransaction[] = []
	let currentBlockSignedMessages: SignedMessageTransaction[] = []
	let currentBlockStateOverrides = getMakeCurrentAddressRichStateOverride(context.richAddresses)
	let previousBlockTimeManipulation = context.activeStackContext.simulationMode ? context.preSimulationBlockTimeManipulation : DEFAULT_BLOCK_MANIPULATION
	let currentBlockSimulateWithZeroBaseFee = false

	const pushBlock = (blockTimeManipulation: BlockTimeManipulation) => {
		inputBlocks.push({
			stateOverrides: currentBlockStateOverrides,
			transactions: currentBlockTransactions,
			signedMessages: currentBlockSignedMessages,
			blockTimeManipulation: previousBlockTimeManipulation,
			simulateWithZeroBaseFee: currentBlockSimulateWithZeroBaseFee,
		})
		previousBlockTimeManipulation = blockTimeManipulation
		currentBlockSignedMessages = []
		currentBlockStateOverrides = {}
		currentBlockTransactions = []
		currentBlockSimulateWithZeroBaseFee = false
	}

	const operations = getOperationsForActiveStackContext({ operations: [...context.stack.operations, ...appendedOperations] }, context.activeStackContext)
	for (const operation of operations) {
		switch(operation.type) {
			case 'Transaction': {
				const simulationOptions = operation.preSimulationTransaction.simulationOptions
				if (
					simulationOptions?.requiredChainId !== undefined
					&& simulationOptions.requiredChainId !== context.chainId
				) break
				const simulateWithZeroBaseFee = simulationOptions?.simulateWithZeroBaseFee ?? false
				if (currentBlockTransactions.length > 0 && currentBlockSimulateWithZeroBaseFee !== simulateWithZeroBaseFee) {
					pushBlock({ type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' })
				}
				currentBlockSimulateWithZeroBaseFee = simulateWithZeroBaseFee
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
	// A further transaction without simulation options closes a block of zero base fee transactions, as in the Transaction case above.
	if (openBlockForNextTransaction && currentBlockTransactions.length > 0 && currentBlockSimulateWithZeroBaseFee) pushBlock({ type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' })
	if (
		openBlockForNextTransaction
		|| currentBlockTransactions.length > 0
		|| currentBlockSignedMessages.length > 0
		|| Object.keys(currentBlockStateOverrides).length > 0
	) {
		inputBlocks.push({
			stateOverrides: currentBlockStateOverrides,
			transactions: currentBlockTransactions,
			signedMessages: currentBlockSignedMessages,
			blockTimeManipulation: previousBlockTimeManipulation,
			simulateWithZeroBaseFee: currentBlockSimulateWithZeroBaseFee,
		})
	}
	return inputBlocks
}

export const getCurrentSimulationInput = async (): Promise<SimulationStateInput> => getSimulationInputForStack((await captureStackSimulationContext()).context)

export type SimulationSnapshot = {
	readonly activeRpcNetwork: RpcNetwork
	readonly activeStackContext: ReturnType<typeof getActiveStackContext>
	readonly simulationStateInput: SimulationStateInput
	readonly numberOfAddressesMadeRich: number
}

// Capture selection and input at the storage boundary. An unreadable stack must abort before publishing any fallback.
export async function captureSimulationSnapshot(): Promise<SimulationSnapshot> {
	const { snapshot, context } = await captureStackSimulationContext()
	return {
		activeRpcNetwork: snapshot.settings.activeRpcNetwork,
		activeStackContext: context.activeStackContext,
		simulationStateInput: getSimulationInputForStack(context),
		numberOfAddressesMadeRich: context.richAddresses.length,
	}
}

export const getSimulationProviderForSnapshot = (ethereum: EthereumClientService, snapshot: SimulationSnapshot) => (
	isSignerOnlyNetwork(snapshot.activeRpcNetwork) ? undefined : ethereum
)

export async function getUpdatedSimulationState(ethereum: EthereumClientService, snapshot: SimulationSnapshot) {
	const provider = getSimulationProviderForSnapshot(ethereum, snapshot)
	if (provider === undefined) return PASSTHROUGH_STATE
	try {
		return toResolvedSimulationState(await createSimulationStateWithNonceAndBaseFeeFixing(snapshot.simulationStateInput, provider))
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return PASSTHROUGH_STATE
		await reportUnexpectedError(error, { code: 'simulation_state_refresh_failed' })
	}
	return PASSTHROUGH_STATE
}

/** Builds the simulation-stack overlay used by simulation mode and Gnosis Safe signing mode. */
export async function getUpdatedSimulationStackSnapshot(ethereum: EthereumClientService, simulationOverlayEnabled: boolean) {
	if (!simulationOverlayEnabled) return { simulationInput: PASSTHROUGH_STATE, simulationState: PASSTHROUGH_STATE }
	const snapshot = await captureSimulationSnapshot()
	return {
		simulationInput: toResolvedSimulationInput(snapshot.simulationStateInput),
		simulationState: await getUpdatedSimulationState(ethereum, snapshot),
	}
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
				suppressExpectedHandledErrors: false,
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
		executionTransaction.signedTransaction
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
			input: stringToUint8Array(encodeFunctionCall(SAFE_DELEGATE_EXECUTE_ABI, 'delegateCallExecute', [addressString(gnosisSafeMessage.to.address), dataStringWith0xStart(gnosisSafeMessage.parsedMessageData.input)]))
		} : {
			to: gnosisSafeMessage.to.address,
			input: gnosisSafeMessage.parsedMessageData.input
		} }
		const simulationState = await getUpdatedSimulationState(ethereumClientService, await captureSimulationSnapshot())
		if (simulationState.kind === 'passthrough') throw new Error('Failed to fetch simulation state for Gnosis Safe transaction.')
		if (simulationState.value.success === false) throw new JsonRpcResponseError(simulationState.value.jsonRpcError)
		const resolvedSimulationState = simulationState.value
		const getTemporaryAccountOverrides = async () => {
			if (!isDelegateCall) return {}
			let gnosisSafeCode = await getSimulatedCode(ethereumClientService, undefined, { kind: 'simulated', value: resolvedSimulationState }, gnosisSafeMessage.verifyingContract.address)
			if (gnosisSafeCode?.getCodeReturn !== undefined && dataStringWith0xStart(gnosisSafeCode.getCodeReturn) === dataStringWith0xStart(getGnosisSafeProxyProxy())) gnosisSafeCode = await getSimulatedCode(ethereumClientService, undefined, { kind: 'simulated', value: resolvedSimulationState }, ORIGINAL_GNOSIS_SAFE)
			if (gnosisSafeCode?.getCodeReturn === undefined) throw new Error('Failed to simulate gnosis safe transaction. Could not retrieve gnosis safe code.')
			return prepareSafeDelegateStateOverrides(gnosisSafeMessage.verifyingContract.address, gnosisSafeCode.getCodeReturn)
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
	if (simulationInput.some((block) => block.transactions.some((transaction) => transaction.safeTransaction?.safeTx.message.operation === 1n))) simulationInput = await prepareSafeDelegateSimulationInput(simulationInput, ethereum, await ethereum.getBlockNumber(undefined))
	// Base-fee and nonce repair only rewrite transactions. Signed-message and state-override blocks must still reach the RPC handler, but inspecting them here would run an extra eth_simulateV1 request without any transaction nonce to repair.
	if (simulationInput.every((block) => block.transactions.length === 0)) return simulationInput
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
				const eventsForTransactionPromise = eventsForEachBlockAndTransactionPromise.then((eventsForEachBlock) => {
					const eventsForBlock = eventsForEachBlock[blockIndex]
					const eventsForTransaction = eventsForBlock?.[transactionIndex]
					if (eventsForTransaction === undefined) throw new Error('Transaction event index overflow')
					return eventsForTransaction
				})
				return await runProtectorsForTransaction(slicedSimulationState, transaction, ethereum, requestAbortController, eventsForTransactionPromise)
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
