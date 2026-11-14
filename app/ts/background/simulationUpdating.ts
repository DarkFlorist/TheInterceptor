import { getRpcNetworkChange, isSignerOnlyNetwork } from '../utils/rpcNetworkChange.js'
import { prepareSafeDelegateSimulationInput, prepareSafeDelegateStateOverrides, ORIGINAL_GNOSIS_SAFE, SAFE_DELEGATE_EXECUTE_ABI } from '../safe/safeSimulation.js'
import { assertSafeTxPreviewAllowed } from '../safe/safeCore.js'
import { createSafeExecutionCallFormation, prepareSafeExecutionSimulationInput } from '../safe/safeExecutionSimulation.js'
import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { appendTransactionToInputAndSimulate, createExecutionSimulationState, createSimulationState, getBaseFeeAdjustmentBalances, getNonceFixedSimulationStateInput, getSimulatedCode, getTokenBalancesAfterForTransaction, getWebsiteCreatedEthereumTransactions, simulateEstimateGasFromInput, sliceSimulationState } from '../simulation/services/SimulationModeEthereumClientService.js'
import { calculateRealizedEffectiveGasPrice, getSimulatedBlockBaseFeePerGas } from '../simulation/services/simulationBlockParameters.js'
import { mockSignTransaction } from '../simulation/services/simulationTransactionSigning.js'
import type { TokenPriceService } from '../simulation/services/priceEstimator.js'
import { parseEvents, parseInputData } from '../simulation/parsing.js'
import { runProtectorsForTransaction } from '../simulation/protectorRunner.js'
import type { EnrichedEthereumEvents, EnrichedEthereumInputData } from '../types/EnrichedEthereumData.js'
import type { PendingTransaction } from '../types/accessRequest.js'
import type { AddressBookEntry, Erc20TokenEntry } from '../types/addressBookTypes.js'
import type { SimulateExecutionReplyData } from '../types/interceptor-messages.js'
import { PASSTHROUGH_STATE, type ExecutionSimulationState, type NonSimulatedAndVisualizedTransaction, type PreSimulationTransaction, type TransactionGasPayment, type SimulationState, type SimulationStateInput, type SimulationStateInputBlock, type VisualizedSimulatorState, toResolvedSimulationInput, toResolvedSimulationState } from '../types/visualizer-types.js'
import { get4Byte, get4ByteString } from '../utils/calldata.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, FourByteExplanations } from '../utils/constants.js'
import { type DistributiveOmit, modifyObject } from '../utils/typescript.js'
import { getAddressBookEntriesForVisualiserFromTransactions, identifyAddress, nameTokenIds, retrieveEnsNodeAndLabelHashes } from './metadataUtils.js'
import { getWethForChainId } from './settings.js'
import { addressString, dataStringWith0xStart, dateToBigintSeconds, stringToUint8Array } from '../utils/bigint.js'
import { simulateCompoundGovernanceExecution } from '../simulation/compoundGovernanceFaking.js'
import { CompoundGovernanceAbi } from '../utils/abi.js'
import type { VisualizedPersonalSignRequestSafeTx } from '../types/personal-message-definitions.js'
import { getGnosisSafeProxyProxy } from '../utils/ethereumByteCodes.js'
import { updatePopupVisualisationWithCallBack } from './storageVariables.js'
import { snapshotNetworkIsActive } from './networkChangeGeneration.js'
import { JsonRpcResponseError, reportUnexpectedError, isExpectedInfrastructureError, getErrorMessage } from '../utils/errors.js'
import { craftPersonalSignPopupMessage } from './windows/personalSign.js'
import { formSimulatedAndVisualizedTransactions, getFromAndToMetadata } from '../components/formVisualizerResults.js'
import { promiseAllMapAbortSafe, silenceChromeUnCaughtPromise } from '../utils/requests.js'
import * as funtypes from 'funtypes'
import { decodeCallDataLoose, encodeFunctionCall } from '../utils/abiRuntime.js'
import type { StateOverrides } from '../types/ethSimulate-types.js'
import type { NetworkSnapshot, SimulationRead, SimulationSnapshot } from './networkTransitionLock.js'

// The snapshot for work that uses the stack. There is no later read to fall back on, because that read could describe another network.
export const requireSimulationSnapshot = (simulation: SimulationRead) => {
	if (simulation.kind === 'unavailable') throw simulation.error
	if (simulation.kind === 'replaced') throw new Error('These services no longer serve the active network')
	return simulation
}

// The client that simulates the snapshot; a signer-only network is not simulated, so it has none.
export const getSimulationProviderForSnapshot = (snapshot: SimulationSnapshot) => isSignerOnlyNetwork(snapshot.activeRpcNetwork) ? undefined : snapshot.services.ethereum

// Passthrough here means only that this network is not simulated or that the simulation could not be fetched. Services of another network cannot reach this function: their read has no snapshot.
export async function getUpdatedSimulationState(snapshot: SimulationSnapshot) {
	const provider = getSimulationProviderForSnapshot(snapshot)
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
export async function getUpdatedSimulationStackSnapshot(simulationOverlayEnabled: boolean, simulation: SimulationRead) {
	if (!simulationOverlayEnabled) return { simulationInput: PASSTHROUGH_STATE, simulationState: PASSTHROUGH_STATE, activeAddressMadeRich: undefined }
	const snapshot = requireSimulationSnapshot(simulation)
	return {
		simulationInput: toResolvedSimulationInput(snapshot.simulationStateInput),
		simulationState: await getUpdatedSimulationState(snapshot),
		activeAddressMadeRich: snapshot.activeAddressMadeRich,
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

export const simulateGovernanceContractExecution = async (pendingTransaction: PendingTransaction, network: NetworkSnapshot): Promise<DistributiveOmit<SimulateExecutionReplyData, 'transactionOrMessageIdentifier'>> => {
	const { ethereum, tokenPriceService } = network.services
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
		const simulation = requireSimulationSnapshot(network.simulation)
		const simulationInput = await prepareSafeExecutionsForRpc(simulation.simulationStateInput, ethereum)
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

export const simulateGnosisSafeMetaTransaction = async (gnosisSafeMessage: VisualizedPersonalSignRequestSafeTx, network: NetworkSnapshot): Promise<DistributiveOmit<SimulateExecutionReplyData, 'transactionOrMessageIdentifier'>> => {
	const { ethereum: ethereumClientService, tokenPriceService } = network.services
	const returnError = (errorMessage: string) => ({ success: false as const, errorType: 'Other' as const, errorMessage })
	try {
		// One snapshot provides both the stack state and the input the meta-transaction is appended to.
		const snapshot = requireSimulationSnapshot(network.simulation)
		const simulationInput = await prepareSafeExecutionsForRpc(snapshot.simulationStateInput, ethereumClientService)
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
		const simulationState = await getUpdatedSimulationState(snapshot)
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

// Adds metadata to the stored visualisation with the client of the refresh's snapshot. Returning undefined from the storage callback writes nothing, so a refresh whose network was replaced, or whose client does not serve the stored visualisation, leaves storage as it is; the storage update checks the generation again immediately before it starts the write. The checks are synchronous and need no transition lock.
export const updateSimulationMetadata = async (snapshot: SimulationSnapshot, requestAbortController: AbortController | undefined) => {
	const { ethereum } = snapshot.services
	const networkIsActive = () => snapshotNetworkIsActive(snapshot)
	return await updatePopupVisualisationWithCallBack(async (prevState) => {
		if (!networkIsActive()) return undefined
		if (prevState.simulationState.kind === 'passthrough') return undefined
		if (prevState.simulationState.value.success === false) return undefined
		// Not a network-change check, which networkIsActive makes: this compares where a stored result came from. The stored visualisation may describe a network installed after these services were read; only its own network's client may add metadata to it.
		if (getRpcNetworkChange(prevState.simulationState.value.rpcNetwork, ethereum.getRpcEntry()).endpointChanged) return undefined
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
			return networkIsActive() ? { ...prevState, ...metadata } : undefined
		} catch (error) {
			if (isExpectedInfrastructureError(error)) return undefined
			await reportUnexpectedError(error)
			return undefined
		}
	}, networkIsActive)
}

// Gives every Gnosis Safe execution of the input the executor's call the node runs it as (prepareSafeExecutionSimulationInput). Everything that sends the simulation stack to the node prepares it with this: every simulation through prepareSimulationInputForRpc, the stack export, the Safe transaction preview and the governance execution preview on top of the stack. EthereumClientService.prepareEthSimulateV1Input rejects a Safe execution that wasn't prepared.
export const prepareSafeExecutionsForRpc = async (simulationInput: SimulationStateInput, ethereum: EthereumClientService) => {
	if (simulationInput.every((block) => block.transactions.length === 0)) return simulationInput
	const parentBlock = await ethereum.getBlock(undefined)
	if (parentBlock === null) throw new Error('The latest block is null')
	// The simulation reads the latest block again. If a newer block arrives in between, the executor's maximum fee of twice the base fee leaves room for the base fee to rise, as EIP-1559 wallets do.
	return await prepareSafeExecutionSimulationInput(simulationInput, ethereum, parentBlock.number, getSimulatedBlockBaseFeePerGas(parentBlock))
}

// The formation of a transaction with this gas payment that the simulation runs as an executor's call, or undefined for one it runs as itself. The Safe layer owns it (createSafeExecutionCallFormation); confirmTransaction.ts reaches it through this orchestration module, as it does the rest of the Safe execution simulation.
export const getExecutedCallFormation = (ethereum: EthereumClientService, gasPayment: TransactionGasPayment) => gasPayment === 'simulated-safe-executor' ? createSafeExecutionCallFormation(ethereum) : undefined

export const prepareSimulationInputForRpc = async (simulationInput: SimulationStateInput, ethereum: EthereumClientService) => {
	if (simulationInput.some((block) => block.transactions.some((transaction) => transaction.safeTransaction?.safeTx.message.operation === 1n))) simulationInput = await prepareSafeDelegateSimulationInput(simulationInput, ethereum, await ethereum.getBlockNumber(undefined))
	// Base-fee and nonce repair only rewrite transactions. Signed-message and state-override blocks must still reach the RPC handler, but inspecting them here would run an extra eth_simulateV1 request without any transaction nonce to repair.
	if (simulationInput.every((block) => block.transactions.length === 0)) return simulationInput
	// Before the base-fee repair, whose balance lookups simulate the input up to each transaction, so those lookups run the Safe executions as the executor's calls too.
	simulationInput = await prepareSafeExecutionsForRpc(simulationInput, ethereum)
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

// Labels and quarantine checks describe the network the simulation ran on, which may no longer be the active one. Its signed messages were added on that network, and a chain change drops them from the active stack, so their quarantine compares their chain with that network. Pending messages are checked against the active chain when the confirmation refreshes.
export async function visualizeSimulatorState(simulationState: SimulationState, ethereum: EthereumClientService, tokenPriceService: TokenPriceService, requestAbortController: AbortController | undefined): Promise<VisualizedSimulatorState> {
	const simulatedNetwork = simulationState.rpcNetwork
	const getWeth = async (): Promise<Erc20TokenEntry | undefined> => {
		const wethAddr = getWethForChainId(simulatedNetwork.chainId)
		if (wethAddr === undefined) return undefined
		const entry = await identifyAddress(ethereum, requestAbortController, wethAddr)
		if (entry.type !== 'ERC20') return undefined
		return entry
	}
	const weth = await getWeth()
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
				visualizedPersonalSignRequests: await promiseAllMapAbortSafe(block.signedMessages, (signedMessage) => silenceChromeUnCaughtPromise(craftPersonalSignPopupMessage(ethereum, requestAbortController, signedMessage, simulatedNetwork))),
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
							rpcNetwork: simulatedNetwork,
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
			visualizedPersonalSignRequests: await promiseAllMapAbortSafe(block.signedMessages, (signedMessage) => silenceChromeUnCaughtPromise(craftPersonalSignPopupMessage(ethereum, requestAbortController, signedMessage, simulatedNetwork))),
			simulatedAndVisualizedTransactions: formSimulatedAndVisualizedTransactions(block.simulatedTransactions, eventsForEachTransaction, simulatedNetwork, parsedInputDataForBlock, protectorsForBlock, updatedMetadata.addressBookEntries, updatedMetadata.namedTokenIds, updatedMetadata.ens, tokenPriceEstimates, weth, delegationAddressBySender),
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
