import type { Settings } from '../types/interceptor-messages.js'
import type { RpcNetwork } from '../types/rpc.js'
import { isSignerOnlyNetwork } from '../utils/rpcNetworkChange.js'
import { prepareSafeDelegateSimulationInput, prepareSafeDelegateStateOverrides, ORIGINAL_GNOSIS_SAFE, SAFE_DELEGATE_EXECUTE_ABI } from '../safe/safeSimulation.js'
import { assertSafeTxPreviewAllowed } from '../safe/safeCore.js'
import { createSafeExecutionCallFormation, prepareSafeExecutionSimulationInput } from '../safe/safeExecutionSimulation.js'
import { type EthereumClientService, getDelegateFromCode, getExecutedTransaction } from '../simulation/services/EthereumClientService.js'
import { appendTransactionToInputAndSimulate, createExecutionSimulationState, createSimulationState, getAddressToMakeRich, getBaseFeeAdjustmentBalances, getNonceFixedSimulationStateInput, getSimulatedCode, getSimulatedCodeFromInput, getWebsiteCreatedEthereumTransactions, simulateEstimateGasFromInput, sliceSimulationState } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getSimulatedBlockBaseFeePerGas } from '../simulation/services/simulationBlockParameters.js'
import { mockSignTransaction } from '../simulation/services/simulationTransactionSigning.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../config/defaults.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { parseEvents, parseInputData } from '../simulation/parsing.js'
import { runProtectorsForTransaction } from '../simulation/protectorRunner.js'
import type { EnrichedEthereumEvents, EnrichedEthereumInputData } from '../types/EnrichedEthereumData.js'
import type { PendingTransaction } from '../types/accessRequest.js'
import type { AddressBookEntry, Erc20TokenEntry } from '../types/addressBookTypes.js'
import type { SimulateExecutionReplyData } from '../types/interceptor-messages.js'
import { PASSTHROUGH_STATE, type BlockTimeManipulation, type ExecutionSimulationState, type NonSimulatedAndVisualizedTransaction, type PreSimulationTransaction, type SignedMessageTransaction, type TransactionGasPayment, type SimulationState, type SimulationExecutionInput, type SimulationStateInput, type SimulationStateInputBlock, type VisualizedSimulatorState, createSimulatedExecutionInput, getSimulationExecutionInputFromState, toResolvedSimulationState } from '../types/visualizer-types.js'
import { get4Byte, get4ByteString } from '../utils/calldata.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, FourByteExplanations, MAKE_YOU_RICH_TRANSACTION } from '../utils/constants.js'
import { type DistributiveOmit, assertNever, modifyObject } from '../utils/typescript.js'
import { getAddressBookEntriesForVisualiserFromTransactions, identifyAddress, nameTokenIds, retrieveEnsNodeAndLabelHashes } from './metadataUtils.js'
import { getFixedAddressRichList, getPreSimulationBlockTimeManipulation, getSettings, getWethForChainId } from './settings.js'
import { addressString, dataStringWith0xStart, stringToUint8Array } from '../utils/bigint.js'
import { getGovernanceExecutionSimulationInput, simulateCompoundGovernanceExecution } from '../simulation/compoundGovernanceFaking.js'
import { CompoundGovernanceAbi } from '../utils/abi.js'
import type { VisualizedPersonalSignRequestSafeTx } from '../types/personal-message-definitions.js'
import { getGnosisSafeProxyProxy } from '../utils/ethereumByteCodes.js'
import { getInterceptorTransactionStack, updatePopupVisualisationWithCallBack } from './storageVariables.js'
import { JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, getErrorMessage } from '../utils/errors.js'
import { craftPersonalSignPopupMessage } from './windows/personalSign.js'
import { formSimulatedAndVisualizedTransactions, getFromAndToMetadata } from '../components/formVisualizerResults.js'
import { promiseAllMapAbortSafe, silenceChromeUnCaughtPromise } from '../utils/requests.js'
import * as funtypes from 'funtypes'
import { decodeCallDataLoose, encodeFunctionCall } from '../utils/abiRuntime.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'
import { getActiveStackContext, getOperationsForActiveStackContext } from '../utils/activeStackContext.js'
import { getSimulationOverridesForPreview, type SimulationPreviewContext } from './delegateClearingPolicy.js'
import { getAppendedBlockStateOverrides } from '../utils/simulationStateOverrides.js'

export { getGovernanceExecutionSimulationInput } from '../simulation/compoundGovernanceFaking.js'

const getMakeCurrentAddressRichStateOverride = (addressesToMakeRich: readonly bigint[]) => {
	if (addressesToMakeRich.length === 0) return {}
	return Object.fromEntries(
		addressesToMakeRich.map(currentAddress => {
			const addressKey = addressString(currentAddress)
			return [addressKey, { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value }]
		})
	)
}

export const getAddressesbeingMadeRich = async (settingsSnapshot?: Settings) => {
	const settings = settingsSnapshot ?? await getSettings()
	if (!settings.simulationMode) return []
	const currentAddressBeingRich = await getAddressToMakeRich(settings)
	const makeRichAddressList = await getFixedAddressRichList()
	return [...makeRichAddressList.filter((x) => x.makingRich).map((x) => x.address), ...currentAddressBeingRich === undefined ? [] : [currentAddressBeingRich]]
}

export const getCurrentSimulationInput = async (richAddresses?: readonly bigint[], settingsSnapshot?: Settings): Promise<SimulationStateInput> => {
	const [settings, preSimulationBlockTimeManipulation] = await Promise.all([
		settingsSnapshot ?? getSettings(),
		getPreSimulationBlockTimeManipulation()
	])
	const richListPromise = silenceChromeUnCaughtPromise(richAddresses === undefined ? getAddressesbeingMadeRich(settings) : Promise.resolve(richAddresses))
	const stack = await getInterceptorTransactionStack()
	const inputBlocks: SimulationStateInputBlock[] = []
	let currentBlockTransactions: PreSimulationTransaction[] = []
	let currentBlockSignedMessages: SignedMessageTransaction[] = []
	let currentBlockStateOverrides: StateOverrides = getMakeCurrentAddressRichStateOverride(await richListPromise)
	let previousBlockTimeManipulation = settings.simulationMode ? preSimulationBlockTimeManipulation : DEFAULT_BLOCK_MANIPULATION
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

	const operations = getOperationsForActiveStackContext(stack, getActiveStackContext(settings))
	for (const operation of operations) {
		switch(operation.type) {
			case 'Transaction': {
				const simulationOptions = operation.preSimulationTransaction.simulationOptions
				if (
					simulationOptions?.requiredChainId !== undefined
					&& simulationOptions.requiredChainId !== settings.activeRpcNetwork.chainId
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
			simulateWithZeroBaseFee: currentBlockSimulateWithZeroBaseFee,
		})
	}
	return inputBlocks
}

export const getSimulationInputForPreview = async (preview: SimulationPreviewContext, settings: Settings, richAddresses?: readonly bigint[]): Promise<SimulationExecutionInput> =>
	createSimulatedExecutionInput(await getCurrentSimulationInput(richAddresses, settings), getSimulationOverridesForPreview(preview, settings))

export type SimulationSnapshot = {
	readonly activeRpcNetwork: RpcNetwork
	readonly activeStackContext: ReturnType<typeof getActiveStackContext>
	readonly simulationInput: SimulationExecutionInput
	readonly numberOfAddressesMadeRich: number
}

// Capture selection and input at the storage boundary. An unreadable stack must abort before publishing any fallback.
export async function captureSimulationSnapshotForPreview(preview: SimulationPreviewContext): Promise<SimulationSnapshot> {
	const settings = await getSettings()
	const richAddresses = await getAddressesbeingMadeRich(settings)
	return {
		activeRpcNetwork: settings.activeRpcNetwork,
		activeStackContext: getActiveStackContext(settings),
		simulationInput: await getSimulationInputForPreview(preview, settings, richAddresses),
		numberOfAddressesMadeRich: richAddresses.length,
	}
}

export const captureSimulationStackSnapshot = async () => await captureSimulationSnapshotForPreview({ kind: 'simulation-stack' })

export const getSimulationProviderForSnapshot = (ethereum: EthereumClientService, snapshot: SimulationSnapshot) => (
	isSignerOnlyNetwork(snapshot.activeRpcNetwork) ? undefined : ethereum
)

export async function getUpdatedSimulationState(ethereum: EthereumClientService, snapshot: SimulationSnapshot) {
	const provider = getSimulationProviderForSnapshot(ethereum, snapshot)
	if (provider === undefined) return PASSTHROUGH_STATE
	try {
		return toResolvedSimulationState(await createSimulationStateWithNonceAndBaseFeeFixing(snapshot.simulationInput, provider))
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) return PASSTHROUGH_STATE
		await reportUnexpectedError(error, { code: 'simulation_state_refresh_failed' })
	}
	return PASSTHROUGH_STATE
}

/** Builds the simulation-stack overlay used by simulation mode and Gnosis Safe signing mode. */
export async function getUpdatedSimulationStackSnapshot(ethereum: EthereumClientService, simulationOverlayEnabled: boolean) {
	if (!simulationOverlayEnabled) return { simulationInput: PASSTHROUGH_STATE, simulationState: PASSTHROUGH_STATE }
	const snapshot = await captureSimulationStackSnapshot()
	return {
		simulationInput: snapshot.simulationInput,
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

async function withDelegationLookupReporting<T>(address: bigint, lookup: () => Promise<T>): Promise<T | undefined> {
	try {
		return await lookup()
	} catch(error: unknown) {
		if (isExpectedInfrastructureError(error)) throw error
		const addressText = addressString(address)
		const errorMessage = getErrorMessage(error) ?? 'Unknown error'
		await reportUnexpectedError(error, {
			displayMessage: `Failed to retrieve EIP-7702 delegation for ${ addressText }: ${ errorMessage }`,
			code: 'delegation_lookup_failed',
			details: { address: addressText },
			suppressExpectedHandledErrors: false,
		})
		return undefined
	}
}

// The delegate each transaction's sender runs with, read from executed state rather than re-derived from EIP-7702's rules. Code only changes through authorizations, so before the stack's first transaction that carries any, a sender has its initial delegate: what the first block's effective overrides (including delegate clearing) set, else its on-chain one. From such a transaction on, the sender's code is read by re-running the stack up to and including that transaction with the code reader appended in its own block (getSimulatedCodeFromInput), so the stack's own blocks run exactly as simulated. A failed read shows no delegate.
async function getDelegationEntriesForTransactions(
	simulationState: SimulationState,
	ethereum: EthereumClientService,
	requestAbortController: AbortController | undefined,
): Promise<readonly (readonly (AddressBookEntry | undefined)[])[]> {
	const executionInput = getSimulationExecutionInputFromState(simulationState)
	const blocks = executionInput.value
	const firstBlockOverrides = getAppendedBlockStateOverrides(0, blocks[0]?.stateOverrides ?? {}, executionInput.simulationOverrides)
	type DelegateSource = { readonly sender: bigint, readonly readAfter: { readonly blockIndex: number, readonly transactionIndex: number } | undefined }
	let lastAuthorizationTransaction: DelegateSource['readAfter']
	const sources: readonly (readonly DelegateSource[])[] = blocks.map((block, blockIndex) => block.transactions.map((transaction, transactionIndex) => {
		const executedCall = getExecutedTransaction(transaction)
		// A transaction's own call runs after its authorizations, so its sender's code is read after it.
		if (executedCall.type === '7702' && executedCall.authorizationList.length > 0) lastAuthorizationTransaction = { blockIndex, transactionIndex }
		return { sender: transaction.signedTransaction.from, readAfter: lastAuthorizationTransaction }
	}))
	const getSourceKey = ({ sender, readAfter }: DelegateSource) => readAfter === undefined ? `initial:${ addressString(sender) }` : `${ readAfter.blockIndex }:${ readAfter.transactionIndex }:${ addressString(sender) }`
	const uniqueSources = Array.from(new Map(sources.flat().map((source) => [getSourceKey(source), source] as const)).values())
	const readDelegate = async ({ sender, readAfter }: DelegateSource): Promise<bigint | undefined> => {
		if (readAfter === undefined) {
			const overriddenCode = firstBlockOverrides[addressString(sender)]?.code
			if (overriddenCode !== undefined) return getDelegateFromCode(overriddenCode)
			return await withDelegationLookupReporting(sender, async () => await ethereum.getDelegation(sender, 'latest', requestAbortController))
		}
		const block = blocks[readAfter.blockIndex]
		if (block === undefined) throw new Error('Delegate read block index overflow')
		const prefix = [...blocks.slice(0, readAfter.blockIndex), modifyObject(block, { transactions: block.transactions.slice(0, readAfter.transactionIndex + 1) })]
		const code = await withDelegationLookupReporting(sender, async () => await getSimulatedCodeFromInput(ethereum, requestAbortController, createSimulatedExecutionInput(prefix, executionInput.simulationOverrides), sender))
		return code?.statusCode === 'success' ? getDelegateFromCode(code.getCodeReturn) : undefined
	}
	const delegatesBySource = new Map(await promiseAllMapAbortSafe(uniqueSources, async (source) => [getSourceKey(source), await readDelegate(source)] as const))
	const delegates = Array.from(new Set(Array.from(delegatesBySource.values()).filter((delegate): delegate is bigint => delegate !== undefined)))
	const delegateEntries = new Map(await promiseAllMapAbortSafe(delegates, async (delegate) =>
		[addressString(delegate), await withDelegationLookupReporting(delegate, async () => await identifyAddress(ethereum, requestAbortController, delegate))] as const))
	return sources.map((blockSources) => blockSources.map((source) => {
		const delegate = delegatesBySource.get(getSourceKey(source))
		return delegate === undefined ? undefined : delegateEntries.get(addressString(delegate))
	}))
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
		const settingsSnapshot = await getSettings()
		// The execution preview continues the vote's own preview, so it shares its what-if state: the opt-in delegate clearing applies only in simulation mode, where nothing is signed, and getSimulationOverridesForPreview returns no override in signing mode.
		const simulationInput = await prepareSafeExecutionsOfSimulationInputForRpc(await getSimulationInputForPreview({ kind: 'governance-execution-on-stack' }, settingsSnapshot), ethereum)
		const executionTransactionMetadata = {
			website: pendingTransaction.transactionToSimulate.website,
			created: new Date(),
			originalRequestParameters: pendingTransaction.originalRequestParameters,
			transactionIdentifier: pendingTransaction.transactionIdentifier,
		}
		const contractExecutionResult = await simulateCompoundGovernanceExecution(ethereum, addr, proposalId, simulationInput, executionTransactionMetadata)
		if (contractExecutionResult === undefined) return returnError('Failed to simulate governance execution')
		const signedExecutionTransaction = mockSignTransaction({ ...contractExecutionResult.executingTransaction, gas: contractExecutionResult.executionGasLimit })
		const executionTransaction: PreSimulationTransaction = {
			...executionTransactionMetadata,
			signedTransaction: signedExecutionTransaction,
		}
		const governanceExecutionSimulationInput = getGovernanceExecutionSimulationInput(
			simulationInput.value,
			executionTransaction,
			contractExecutionResult.executionTimestamp,
			contractExecutionResult.executionStateOverrides,
		)
		// Keep the preceding stack in the result so visualization uses the execution RPC's state.
		const governanceContractSimulationState = await createSimulationState(ethereum, undefined, {
			...simulationInput,
			value: governanceExecutionSimulationInput,
			simulationOverrides: contractExecutionResult.executionSimulationOverrides,
		})
		return { success: true as const, result: await visualizeSimulatorState(governanceContractSimulationState, ethereum, tokenPriceService, undefined) }
	} catch(error) {
		console.warn(error)
		if (error instanceof Error) return returnError(error.message)
		return returnError('Unknown error occured')
	}
}

export const simulateGnosisSafeMetaTransaction = async (gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx, ethereumClientService: EthereumClientService, tokenPriceService: TokenPriceService): Promise<DistributiveOmit<SimulateExecutionReplyData, 'transactionOrMessageIdentifier'>> => {
	const returnError = (errorMessage: string) => ({ success: false as const, errorType: 'Other' as const, errorMessage })
	try {
		const signingSnapshot = await captureSimulationSnapshotForPreview({ kind: 'safe-transaction-signature' })
		const simulationInput = await prepareSafeExecutionsOfSimulationInputForRpc(signingSnapshot.simulationInput, ethereumClientService)
		await assertSafeTxPreviewAllowed(ethereumClientService, gnosisSafeMessage.verifyingContract.address, gnosisSafeMessage.activeAddress.address, gnosisSafeMessage.message.domain.chainId)
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
		const simulationState = await getUpdatedSimulationState(ethereumClientService, signingSnapshot)
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
			const estimateGas = await simulateEstimateGasFromInput(ethereumClientService, undefined, simulationInput, transactionWithoutGas, undefined, temporaryAccountOverrides)
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

// Gives every Gnosis Safe execution of the input the executor's call the node runs it as (prepareSafeExecutionSimulationInput). Everything that sends the simulation stack to the node prepares it with this: every simulation through prepareSimulationInputForRpc, the stack export, the Safe transaction preview and the governance execution preview on top of the stack. EthereumClientService.prepareEthSimulateV1Input rejects a Safe execution that wasn't prepared.
export const prepareSafeExecutionsForRpc = async (simulationInput: SimulationStateInput, ethereum: EthereumClientService) => {
	if (simulationInput.every((block) => block.transactions.length === 0)) return simulationInput
	const parentBlock = await ethereum.getBlock(undefined)
	if (parentBlock === null) throw new Error('The latest block is null')
	// The simulation reads the latest block again. If a newer block arrives in between, the executor's maximum fee of twice the base fee leaves room for the base fee to rise, as EIP-1559 wallets do.
	return await prepareSafeExecutionSimulationInput(simulationInput, ethereum, parentBlock.number, getSimulatedBlockBaseFeePerGas(parentBlock))
}

// prepareSafeExecutionsForRpc for a captured simulation input. The Safe executions' approvals and executor funding go into the first block's stateOverrides, while the captured initial account state (such as delegate clearing) stays in simulationOverrides; prepareEthSimulateV1Input merges both per account into the first block, so neither replaces the other.
export const prepareSafeExecutionsOfSimulationInputForRpc = async (simulationInput: SimulationExecutionInput, ethereum: EthereumClientService): Promise<SimulationExecutionInput> => ({ ...simulationInput, value: await prepareSafeExecutionsForRpc(simulationInput.value, ethereum) })

// The formation of a transaction with this gas payment that the simulation runs as an executor's call, or undefined for one it runs as itself. The Safe layer owns it (createSafeExecutionCallFormation); confirmTransaction.ts reaches it through this orchestration module, as it does the rest of the Safe execution simulation.
export const getExecutedCallFormation = (ethereum: EthereumClientService, gasPayment: TransactionGasPayment) => gasPayment === 'simulated-safe-executor' ? createSafeExecutionCallFormation(ethereum) : undefined

export const prepareSimulationInputForRpc = async (input: SimulationExecutionInput, ethereum: EthereumClientService): Promise<SimulationExecutionInput> => {
	let simulationInput = input.value
	const { simulationOverrides } = input
	if (simulationInput.some((block) => block.transactions.some((transaction) => transaction.safeTransaction?.safeTx.message.operation === 1n))) simulationInput = await prepareSafeDelegateSimulationInput(simulationInput, ethereum, await ethereum.getBlockNumber(undefined))
	// Base-fee and nonce repair only rewrite transactions. Signed-message and state-override blocks must still reach the RPC handler, but inspecting them here would run an extra eth_simulateV1 request without any transaction nonce to repair.
	if (simulationInput.every((block) => block.transactions.length === 0)) return { ...input, value: simulationInput }
	// Before the base-fee repair, whose balance lookups simulate the input up to each transaction, so those lookups run the Safe executions as the executor's calls too.
	simulationInput = await prepareSafeExecutionsForRpc(simulationInput, ethereum)
	const parentBlock = await ethereum.getBlock(undefined)
	const getBaseFeeFixedInputStateBlocks = async () => {
		if (parentBlock === undefined) return simulationInput
		const baseFeeFixedInputStateBlocks: SimulationStateInputBlock[] = []
		for (const block of simulationInput) {
			const { transactions } = await getBaseFeeAdjustmentBalances(ethereum, undefined, parentBlock, createSimulatedExecutionInput(baseFeeFixedInputStateBlocks, simulationOverrides), block)
			baseFeeFixedInputStateBlocks.push(modifyObject(block, { transactions }))
		}
		return baseFeeFixedInputStateBlocks
	}
	const baseFeeFixedInputStateBlocks = await getBaseFeeFixedInputStateBlocks()
	const nonceFixed = await getNonceFixedSimulationStateInput(ethereum, undefined, createSimulatedExecutionInput(baseFeeFixedInputStateBlocks, simulationOverrides))
	return nonceFixed.simulationInput
}

export const buildSimulationStateFromPreparedInput = async (preparedSimulationInput: SimulationExecutionInput, ethereum: EthereumClientService) => {
	return await createSimulationState(ethereum, undefined, preparedSimulationInput)
}

export const buildExecutionSimulationStateFromPreparedInput = async (preparedSimulationInput: SimulationExecutionInput, ethereum: EthereumClientService): Promise<ExecutionSimulationState> => {
	return await createExecutionSimulationState(ethereum, undefined, preparedSimulationInput)
}

export const createSimulationStateWithNonceAndBaseFeeFixing = async (simulationInput: SimulationExecutionInput, ethereum: EthereumClientService) => {
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
	const delegationEntriesByTransaction = await getDelegationEntriesForTransactions(simulationState, ethereum, requestAbortController)

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
			const blockDelegations = delegationEntriesByTransaction[blockIndex] ?? []
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
							...(blockDelegations[index] !== undefined ? { delegationAddress: blockDelegations[index] } : {}),
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
		const inputBlock = simulationState.simulationStateInput[blockIndex]
		if (eventsForEachTransaction === undefined || parsedInputDataForBlock === undefined || protectorsForBlock === undefined || inputBlock === undefined) throw new Error('Block index overflow')
		return {
			visualizedPersonalSignRequests: await promiseAllMapAbortSafe(block.signedMessages, (signedMessage) => silenceChromeUnCaughtPromise(craftPersonalSignPopupMessage(ethereum, requestAbortController, signedMessage, settings.activeRpcNetwork))),
			simulatedAndVisualizedTransactions: formSimulatedAndVisualizedTransactions(block.simulatedTransactions, eventsForEachTransaction, simulationState.rpcNetwork, parsedInputDataForBlock, protectorsForBlock, updatedMetadata.addressBookEntries, updatedMetadata.namedTokenIds, updatedMetadata.ens, tokenPriceEstimates, weth, delegationEntriesByTransaction[blockIndex] ?? []),
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
