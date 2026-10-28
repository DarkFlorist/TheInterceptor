import { parseEvents, parseInputData } from '../../simulation/parsing.js'
import type { EthereumClientService } from '../../simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../../simulation/services/priceEstimator.js'
import { getWebsiteCreatedEthereumTransactions } from '../../simulation/services/SimulationModeEthereumClientService.js'
import type { SimulationServicesOwner } from '../../simulation/serviceLifecycle.js'
import type { ChangePreSimulationBlockTimeManipulation, EnableSimulationMode, FetchSimulationStackRequestConfirmation, ForceSetGasLimitForTransaction, ImportSimulationStack, RemoveTransaction, SetTransactionOrMessageBlockTimeManipulator } from '../../types/interceptor-messages.js'
import type { ImportSimulationStackReply } from '../../types/interceptor-reply-messages.js'
import type { WebsiteTabConnections } from '../../types/user-interface-types.js'
import { CompleteVisualizedSimulation, type InterceptorStackOperation, InterceptorSimulationExport, InterceptorTransactionStack } from '../../types/visualizer-types.js'
import type { Website } from '../../types/websiteAccessTypes.js'
import { type ActiveAddressSelection, getActiveAddressSelection } from '../../utils/activeAddressSelection.js'
import { getOperationsForActiveStackContext, SIMULATION_STACK_CONTEXT } from '../../utils/activeStackContext.js'
import { generate256BitRandomBigInt } from '../../utils/bigint.js'
import { getErrorMessage } from '../../utils/errors.js'
import { estimateSerializedStateBytes, formatEstimatedBytes } from '../../utils/largeStateStore.js'
import { silenceChromeUnCaughtPromise } from '../../utils/requests.js'
import { normalizeConsecutiveTimeManipulations } from '../../utils/transactionStack.js'
import { assertNever, modifyObject } from '../../utils/typescript.js'
import { activateAddressSelection, changeActiveAddressAndChain } from '../activeSettings.js'
import { getCurrentTabSignerAccount, getLastKnownCurrentTabId } from '../currentTab.js'
import { updatePopupVisualisationIfNeeded, updatePopupVisualisationState } from '../popupVisualisationUpdater.js'
import { getSettings, getWebsiteAccess, setPreSimulationBlockTimeManipulation } from '../settings.js'
import { sendCallbackToConfirmedSignerOwner } from '../signerStateOwnership.js'
import { getConfiguredSigningSafeForChain } from '../signingAddressSelection.js'
import { captureSimulationSnapshot, getCurrentSimulationInput, getMetadataForSimulation, getUpdatedSimulationStackSnapshot, getUpdatedSimulationState } from '../simulationUpdating.js'
import { getFetchSimulationStackRequestPromise, getInterceptorTransactionStack, getPopupVisualisationState, getPrimaryRpcForChain, getRpcList, getTabState, getUserAddressBookEntriesForChainIdMorePreciseFirst, updateInterceptorTransactionStack, updateTransactionState } from '../storageVariables.js'
import { setGasLimitForTransaction } from '../windows/confirmTransaction.js'
import { resolveFetchSimulationStackRequest } from '../windows/fetchSimulationStack.js'
import { refreshSignerAccountsForTab, type SignerAccountRefreshOptions } from '../windows/interceptorAccess.js'
import { refreshPopupConfirmTransactionSimulation } from './confirmation.js'

const formatCaughtErrorMessage = (error: unknown) => getErrorMessage(error) ?? 'Unknown error'

const importSimulationStackSuccess = (): ImportSimulationStackReply => ({ type: 'ImportSimulationStackReply', ok: true })
const importSimulationStackFailure = (message: string): ImportSimulationStackReply => ({ type: 'ImportSimulationStackReply', ok: false, message })

export async function removeTransactionOrSignedMessage(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, params: RemoveTransaction) {
	if (params.data.type === 'Transaction') {
		const currentStack = await getInterceptorTransactionStack()
		const transactionIdentifier = params.data.transactionIdentifier
		const safeOperation = currentStack.operations.find((operation): operation is Extract<InterceptorStackOperation, { type: 'Transaction' }> =>
			operation.type === 'Transaction'
			&& operation.preSimulationTransaction.transactionIdentifier === transactionIdentifier
		)
		const safeTransactionToRemove = safeOperation?.preSimulationTransaction.safeTransaction
		if (safeTransactionToRemove !== undefined) {
			await updateTransactionState((previousState) => {
				const identifiersToRemove = new Set<bigint>()
				const safeTransactionStacks = previousState.safeTransactionStacks.map((stack) => {
					const transactionIndex = stack.transactions.findIndex((transaction) => transaction.safeTxHash === safeTransactionToRemove.safeTxHash)
					if (transactionIndex === -1) return stack
					for (const transaction of stack.transactions.slice(transactionIndex)) identifiersToRemove.add(transaction.transactionIdentifier)
					return { ...stack, transactions: stack.transactions.slice(0, transactionIndex) }
				}).filter((stack) => stack.transactions.length > 0)
				return {
					safeTransactionStacks,
					interceptorTransactionStack: {
						operations: normalizeConsecutiveTimeManipulations(previousState.interceptorTransactionStack.operations.filter((operation) =>
							operation.type !== 'Transaction' || !identifiersToRemove.has(operation.preSimulationTransaction.transactionIdentifier)
						)),
					},
				}
			})
			await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { invalidateOldState: true })
			return
		}
	}
	await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
		switch (params.data.type) {
			case 'Transaction': {
				const transactionIdentifier = params.data.transactionIdentifier
				const transactionToBeRemoved = prevStack.operations.find((transaction): transaction is Extract<InterceptorStackOperation, { type: 'Transaction' }> => transaction.type === 'Transaction' && transaction.preSimulationTransaction.transactionIdentifier === transactionIdentifier)
				if (transactionToBeRemoved === undefined) return prevStack
				const removedTransaction = transactionToBeRemoved.preSimulationTransaction
				const shouldShiftNonceAfterRemoval = (transaction: typeof removedTransaction) => {
					return transactionWasFound
						&& transaction.originalRequestParameters.method === 'eth_sendTransaction'
						&& transaction.signedTransaction.from === removedTransaction.signedTransaction.from
						&& transaction.signedTransaction.nonce > removedTransaction.signedTransaction.nonce
				}

				const newOperations: InterceptorStackOperation[] = []
				let transactionWasFound = false
				for (const operation of prevStack.operations) {
					if (operation.type === 'Transaction' && transactionIdentifier === operation.preSimulationTransaction.transactionIdentifier) {
						transactionWasFound = true
						continue
					}
					if (operation.type === 'Transaction') {
						const transaction = operation.preSimulationTransaction
						const shouldUpdateNonce = shouldShiftNonceAfterRemoval(transaction)
						const newTransaction = shouldUpdateNonce ? modifyObject(transaction.signedTransaction, { nonce: transaction.signedTransaction.nonce - 1n }) : transaction.signedTransaction
						newOperations.push({ type: operation.type, preSimulationTransaction: modifyObject(transaction, { signedTransaction: newTransaction }) })
						continue
					}
					newOperations.push(operation)
				}
				return { operations: normalizeConsecutiveTimeManipulations(newOperations) }
			}
			case 'Message': {
				const messageIdentifier = params.data.messageIdentifier
				return {
					operations: normalizeConsecutiveTimeManipulations(prevStack.operations)
						.filter((operation) => !(operation.type === 'Message' && messageIdentifier === operation.signedMessageTransaction.messageIdentifier))
				}
			}
			default: assertNever(params.data)
		}
	})

	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { invalidateOldState: true })
}

export async function enableSimulationMode(
	simulationServicesOwner: SimulationServicesOwner,
	websiteTabConnections: WebsiteTabConnections,
	params: EnableSimulationMode,
	signerAccountRefreshOptions: SignerAccountRefreshOptions = {},
) {
	const settings = await getSettings()
	if (settings.simulationMode === params.data) return
	// if we are on unsupported chain, force change to a supported one
	if (settings.useSignersAddressAsActiveAddress || params.data === false) {
		const tabId = await getLastKnownCurrentTabId()
		if (tabId !== undefined) await refreshSignerAccountsForTab(websiteTabConnections, tabId, false, signerAccountRefreshOptions)
		if (tabId !== undefined) sendCallbackToConfirmedSignerOwner(websiteTabConnections, tabId, { method: 'request_signer_chainId', result: [] })
		const chainToSwitch = tabId === undefined ? undefined : (await getTabState(tabId)).signerChain
		const networkToSwitch = chainToSwitch === undefined ? (await getRpcList())[0] : await getPrimaryRpcForChain(chainToSwitch)
		const signerAccount = await getCurrentTabSignerAccount()
		if (!params.data) {
			const targetChainId = networkToSwitch?.chainId ?? settings.activeRpcNetwork.chainId
			const activeChainEntries = await getUserAddressBookEntriesForChainIdMorePreciseFirst(targetChainId)
			const configuredSigningSafe = await getConfiguredSigningSafeForChain(
				settings.activeSigningSafeAddress,
				targetChainId,
				signerAccount === undefined ? [] : [signerAccount],
			)
			const signingSelection: ActiveAddressSelection | undefined = configuredSigningSafe === undefined
				? signerAccount === undefined ? undefined : getActiveAddressSelection('signer', activeChainEntries, false, targetChainId, [signerAccount])
				: { type: 'addressBookEntry', entry: configuredSigningSafe }
			await activateAddressSelection(simulationServicesOwner, websiteTabConnections, signingSelection, {
				simulationMode: false,
				signerAddress: signerAccount,
				...(chainToSwitch === undefined || networkToSwitch === undefined ? {} : { rpcNetwork: networkToSwitch }),
			})
			return
		}
		await changeActiveAddressAndChain(simulationServicesOwner, websiteTabConnections, {
			simulationMode: params.data,
			activeAddress: signerAccount,
			...chainToSwitch === undefined ? {} : { rpcNetwork: networkToSwitch },
		})
	} else {
		const selectedNetworkToSwitch = settings.activeRpcNetwork.httpsRpc !== undefined ? settings.activeRpcNetwork : (await getRpcList())[0]
		await changeActiveAddressAndChain(simulationServicesOwner, websiteTabConnections, {
			simulationMode: params.data,
			...settings.activeRpcNetwork === selectedNetworkToSwitch ? {} : { rpcNetwork: selectedNetworkToSwitch }
		})
	}
}

export async function forceSetGasLimitForTransaction(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, parsedRequest: ForceSetGasLimitForTransaction) {
	await setGasLimitForTransaction(parsedRequest.data.transactionIdentifier, parsedRequest.data.gasLimit)
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { invalidateOldState: true })
	await refreshPopupConfirmTransactionSimulation(ethereum, tokenPriceService)
}

export async function changePreSimulationBlockTimeManipulation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, parsedRequest: ChangePreSimulationBlockTimeManipulation) {
	await setPreSimulationBlockTimeManipulation(parsedRequest.data.blockTimeManipulation)
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { invalidateOldState: true, onlyIfNotAlreadyUpdating: true })
}

export async function setTransactionOrMessageBlockTimeManipulator(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, parsedRequest: SetTransactionOrMessageBlockTimeManipulator) {
	const newStack = await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
		const normalizedPrevStack = { operations: normalizeConsecutiveTimeManipulations(prevStack.operations) }
		const identifier = parsedRequest.data.transactionOrMessageIdentifier
		const appendAfterIndex = normalizedPrevStack.operations.findIndex((operation) => {
			switch(operation.type) {
				case 'Transaction': return identifier.type === operation.type && identifier.transactionIdentifier === operation.preSimulationTransaction.transactionIdentifier
				case 'Message': return identifier.type === operation.type && identifier.messageIdentifier === operation.signedMessageTransaction.messageIdentifier
				case 'TimeManipulation': return false
				default: return assertNever(operation)
			}
		})
		if (appendAfterIndex < 0) return normalizedPrevStack
		const indexOfMaybeManipulator = appendAfterIndex + 1
		const maybeExistingManipulator = normalizedPrevStack.operations[indexOfMaybeManipulator]
		if (maybeExistingManipulator?.type === 'TimeManipulation') {
			// no delay, so we can remove the manipulator
			if (parsedRequest.data.blockTimeManipulation.type === 'No Delay') return { operations: normalizeConsecutiveTimeManipulations([...normalizedPrevStack.operations.slice(0, indexOfMaybeManipulator), ...normalizedPrevStack.operations.slice(indexOfMaybeManipulator + 1)]) }
			const newManipulator = { type: 'TimeManipulation', blockTimeManipulation: parsedRequest.data.blockTimeManipulation } as const
			// replace manipulator
			return { operations: normalizeConsecutiveTimeManipulations(normalizedPrevStack.operations.map((operation, index) => index === indexOfMaybeManipulator ? newManipulator : operation)) }
		}
		// insert new manipulator
		if (parsedRequest.data.blockTimeManipulation.type === 'No Delay') return normalizedPrevStack
		const newManipulator = { type: 'TimeManipulation', blockTimeManipulation: parsedRequest.data.blockTimeManipulation } as const
		return { operations: normalizeConsecutiveTimeManipulations([...normalizedPrevStack.operations.slice(0, indexOfMaybeManipulator), newManipulator, ...normalizedPrevStack.operations.slice(indexOfMaybeManipulator)]) }
	})
	const secondToLastOperation = newStack.operations[newStack.operations.length - 2]
	if (secondToLastOperation === undefined || secondToLastOperation.type === 'TimeManipulation') {
		await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { invalidateOldState: true, onlyIfNotAlreadyUpdating: true })
		return
	}
	const appendIdentifier = parsedRequest.data.transactionOrMessageIdentifier.type === 'Transaction' ? parsedRequest.data.transactionOrMessageIdentifier.transactionIdentifier : parsedRequest.data.transactionOrMessageIdentifier.messageIdentifier
	const operationIdentifier = secondToLastOperation.type === 'Transaction' ? secondToLastOperation.preSimulationTransaction.transactionIdentifier : secondToLastOperation.signedMessageTransaction.messageIdentifier
	const appendedToEnd = appendIdentifier === operationIdentifier
	await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService, { invalidateOldState: !appendedToEnd, onlyIfNotAlreadyUpdating: true })
}

export async function fetchSimulationStackRequestConfirmation(ethereumClientService: EthereumClientService, websiteTabConnections: WebsiteTabConnections, confirmation: FetchSimulationStackRequestConfirmation) {
	const pendingRequest = await getFetchSimulationStackRequestPromise()
	if (pendingRequest === undefined) throw new Error('The pending simulation stack request is unavailable.')
	const snapshot = await getUpdatedSimulationStackSnapshot(ethereumClientService, pendingRequest.simulationOverlayEnabled)
	await resolveFetchSimulationStackRequest(snapshot, websiteTabConnections, confirmation)
}

export async function requestInterceptorSimulationInput(ethereumClientService: EthereumClientService) {
	const stack = await getInterceptorTransactionStack()
	if (!(await getSettings()).simulationMode) {
		return {
			method: 'popup_requestInterceptorSimulationInput' as const,
			ok: false as const,
			message: 'Simulation stack export is available only in simulation mode.',
		}
	}
	const simulationStack = modifyObject(stack, { operations: getOperationsForActiveStackContext(stack, SIMULATION_STACK_CONTEXT) })
	const simulationInput = await getCurrentSimulationInput()
	const currentBlockNumberPromise = silenceChromeUnCaughtPromise(ethereumClientService.getBlockNumber(undefined))
	const eth_simulateV1 = await ethereumClientService.ethSimulateV1Input(simulationInput, await currentBlockNumberPromise, undefined)

	const interceptorSimulateStack = modifyObject(simulationStack, { operations: simulationStack.operations.map((operation) => {
		switch(operation.type) {
			case 'Message': return modifyObject(operation, { signedMessageTransaction: modifyObject(operation.signedMessageTransaction, { website: { ...operation.signedMessageTransaction.website, icon: undefined, title: undefined } }) })
			case 'TimeManipulation': return operation
			case 'Transaction': return modifyObject(operation, { preSimulationTransaction: modifyObject(operation.preSimulationTransaction, { website: { ...operation.preSimulationTransaction.website, icon: undefined, title: undefined } }) })
			default: return assertNever(operation)
		}
	}) })
	return { method: 'popup_requestInterceptorSimulationInput' as const, ok: true as const, ethSimulateV1InputString:
		JSON.stringify(
			InterceptorSimulationExport.serialize({
				name: 'Interceptor Simulation Export',
				version: '1.0.0',
				eth_simulateV1,
				interceptorSimulateStack,
			})
		, null, '\t')
	}
}

export async function importSimulationStack(ethereum: EthereumClientService, tokenPriceService: TokenPriceService, parsedRequest: ImportSimulationStack): Promise<ImportSimulationStackReply> {
	if (parsedRequest.data.version !== '1.0.0') return importSimulationStackFailure('Only simulation stack export version 1.0.0 is supported.')
	if (parsedRequest.data.interceptorSimulateStack.operations.length === 0) return importSimulationStackSuccess()
	if (parsedRequest.data.interceptorSimulateStack.operations.some((operation) =>
		operation.type === 'Transaction' && operation.preSimulationTransaction.safeTransaction !== undefined
	)) {
		return importSimulationStackFailure('Gnosis Safe transactions cannot be imported through simulation stack import. Use Import Gnosis Safe so Gnosis Safe proposals and signatures remain synchronized.')
	}

	const importedStackBytes = estimateSerializedStateBytes(InterceptorTransactionStack, parsedRequest.data.interceptorSimulateStack)
	console.info(`[simulation-stack import] received ${ parsedRequest.data.interceptorSimulateStack.operations.length } operations (${ formatEstimatedBytes(importedStackBytes) }).`)

	const websiteAccess = await getWebsiteAccess()
	const updateWebsiteDetails = (website: Website) => {
		const websiteData = websiteAccess.find((access) => access.website.websiteOrigin === website.websiteOrigin)?.website
		return websiteData ?? website
	}

	let updatedStack: InterceptorTransactionStack
	try {
		updatedStack = await updateInterceptorTransactionStack((prevStack: InterceptorTransactionStack) => {
			const newOperations = [...prevStack.operations, ...parsedRequest.data.interceptorSimulateStack.operations]
			// generate new ids for operations to prevent duplicated ids
			return { operations: normalizeConsecutiveTimeManipulations(newOperations.map((operation) => {
				switch(operation.type) {
					case 'Message': return modifyObject(operation, { signedMessageTransaction: modifyObject(operation.signedMessageTransaction, { messageIdentifier: generate256BitRandomBigInt(), website: updateWebsiteDetails(operation.signedMessageTransaction.website) }) })
					case 'TimeManipulation': return operation
					case 'Transaction': return modifyObject(operation, { preSimulationTransaction: modifyObject(operation.preSimulationTransaction, { transactionIdentifier: generate256BitRandomBigInt(), website: updateWebsiteDetails(operation.preSimulationTransaction.website) }) })
					default: return assertNever(operation)
				}
			})) }
		})
	} catch (error) {
		return importSimulationStackFailure(`Failed to store the imported simulation stack (${ formatEstimatedBytes(importedStackBytes) }): ${ formatCaughtErrorMessage(error) }`)
	}

	const updatedStackBytes = estimateSerializedStateBytes(InterceptorTransactionStack, updatedStack)
	console.info(`[simulation-stack import] persisted transaction stack at ${ formatEstimatedBytes(updatedStackBytes) }.`)

	try {
		await updatePopupVisualisationState(ethereum, tokenPriceService, undefined, true)
		const popupVisualisation = await getPopupVisualisationState()
		const popupVisualisationBytes = estimateSerializedStateBytes(CompleteVisualizedSimulation, popupVisualisation)
		console.info(`[simulation-stack import] persisted popup visualisation at ${ formatEstimatedBytes(popupVisualisationBytes) }.`)
	} catch (error) {
		return importSimulationStackFailure(`Imported stack was stored (${ formatEstimatedBytes(updatedStackBytes) }), but updating the visualized simulation failed: ${ formatCaughtErrorMessage(error) }`)
	}

	return importSimulationStackSuccess()
}

export async function requestCompleteVisualizedSimulation(ethereum: EthereumClientService, tokenPriceService: TokenPriceService) {
	const visualizedSimulatorState = await updatePopupVisualisationIfNeeded(ethereum, tokenPriceService)
	return { method: 'popup_requestCompleteVisualizedSimulation' as const, visualizedSimulatorState }
}

export async function requestSimulationMetadata(ethereumClientService: EthereumClientService) {
	const settings = await getSettings()
	const simulationState = settings.simulationMode ? await getUpdatedSimulationState(ethereumClientService, await captureSimulationSnapshot()) : { kind: 'passthrough' as const }
	if (simulationState.kind === 'passthrough' || simulationState.value.success === false) return {
		method: 'popup_requestSimulationMetadata' as const,
		metadata: {
			namedTokenIds: [], addressBookEntries: [], ens: { ensNameHashes: [], ensLabelHashes: [] }
		}
	}
	const eventsForEachBlockAndTransactionPromise = silenceChromeUnCaughtPromise(Promise.all(
		simulationState.value.simulatedBlocks.map((block) =>
			Promise.all(block.simulatedTransactions.map(
				async (simulatedTransaction) => simulatedTransaction.ethSimulateV1CallResult.status === 'failure' ? [] : await parseEvents(simulatedTransaction.ethSimulateV1CallResult.logs, ethereumClientService, undefined)
			))
		)
	))
	const parsedInputDataForEachBlockAndTransactionPromise = silenceChromeUnCaughtPromise(Promise.all(
		simulationState.value.simulatedBlocks.map((block) => {
			const transactions = getWebsiteCreatedEthereumTransactions(block.simulatedTransactions)
			return Promise.all(transactions.map((transaction) =>
				parseInputData({ to: transaction.transaction.to, input: transaction.transaction.input, value: transaction.transaction.value }, ethereumClientService, undefined)
			))
		})
	))
	const events = (await eventsForEachBlockAndTransactionPromise).flat()
	const inputData = (await parsedInputDataForEachBlockAndTransactionPromise).flat()

	const metadata = await getMetadataForSimulation(simulationState.value, ethereumClientService, undefined, events, inputData)
	return { method: 'popup_requestSimulationMetadata' as const, metadata }
}
