import * as assert from 'assert'
import { test } from 'bun:test'
import { keccak_256 } from '@noble/hashes/sha3'
import type { SendRawTransactionParams, SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { GnosisSafeTx } from '../../app/ts/types/personal-message-definitions.js'
import { createGnosisSafeTxFromMessage } from '../../app/ts/gnosisSafe/gnosisSafeCore.js'
import { decodeGnosisSafeExecution } from '../../app/ts/gnosisSafe/gnosisSafeExecution.js'
import { InterceptorSimulationExport, InterceptorTransactionStack, PreSimulationTransaction, type SimulationInputTransaction, type SimulationStateInput, toResolvedExecutionSimulationState, toResolvedSimulationInput, toResolvedSimulationState, type SimulationStateInputMinimalData, toSimulationStateInputMinimalData, type TransactionSimulationOptions, type WebsiteCreatedEthereumTransactionOrFailed } from '../../app/ts/types/visualizer-types.js'
import { EthereumSendableSignedTransaction } from '../../app/ts/types/wire-types.js'
import { getSignedTransactionForSimulation } from '../../app/ts/simulation/services/simulationTransactionSigning.js'
import { isUnpreparedSimulationInputError } from '../../app/ts/simulation/services/EthereumClientService.js'
import { classifyCaughtError } from '../../app/ts/utils/errors.js'
import { createGnosisSafeNonceAfterInputReader, estimateGnosisSafeExecutionGas, prepareGnosisSafeExecutionSimulationInput, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR } from '../../app/ts/gnosisSafe/gnosisSafeExecutionSimulation.js'
import { describeGnosisSafeExecutionFailure, GNOSIS_SAFE_CALL_REVERTED_MESSAGE } from '../../app/ts/gnosisSafe/gnosisSafeExecutionFailure.js'
import { GNOSIS_SAFE_UNSUPPORTED_TRANSACTION_MESSAGES } from '../../app/ts/gnosisSafe/gnosisSafeExecutionRouting.js'
import { prepareGnosisSafeTransactionConfirmation } from '../../app/ts/background/gnosisSafeTransactionConfirmation.js'
import { createExecutionSimulationState, createSimulationState, getNonceFixedSimulationStateInput, getSimulatedTransactionByHashFromInput, getSimulatedTransactionCount, getSimulatedTransactionCountFromInput, getSimulatedTransactionReceipt } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { decodeEthereumError } from '../../app/ts/utils/errorDecoding.js'
import { dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { getGasFeePaidByTransactionSender } from '../../app/ts/utils/transactionGasAccounting.js'
import { activeAddress, addressString, created, pendingTransaction, createGnosisSafeAddressBookEntry, createGnosisSafeTx, createWebsitePort, ethereum, fakeRequestHandler, fakeRpcNetwork, fakeGnosisSafeContract, getGnosisSafeTxHash, hexToBytes, isRecord, makeFakeBlock, makeFakeEthSimulateResult, modules, recipientAddress, GNOSIS_SAFE_EXECUTION_ABI, simulator as confirmationSimulator, uniqueRequestIdentifier, withSilencedConsole, createAcceptConfirmation } from './confirmTransactionTestHarness.js'

// createSafeAddressBookEntry configures the Safe at activeAddress, the address the fake RPC gives code.
const GNOSIS_SAFE_ADDRESS = activeAddress
const ORDINARY_ACCOUNT = recipientAddress
const CALLED_CONTRACT = 0x6666666666666666666666666666666666666666n
const OWNERS = [0x3000000000000000000000000000000000000003n, 0x1000000000000000000000000000000000000001n, 0x2000000000000000000000000000000000000002n]
const SORTED_OWNERS = [0x1000000000000000000000000000000000000001n, 0x2000000000000000000000000000000000000002n, 0x3000000000000000000000000000000000000003n]
const GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS: TransactionSimulationOptions = { requiredChainId: fakeRpcNetwork.chainId, executeThroughSafe: true }
const BASE_FEE_PER_GAS = 1_000n
// What geth returns when a Safe's call fails inside execTransaction: Error("GS013").
const GS013_REVERT_DATA = '0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000054753303133000000000000000000000000000000000000000000000000000000'
const EXECUTOR_MAX_FEE_PER_GAS = BASE_FEE_PER_GAS * 2n + 10n ** 8n

// geth reports a revert in the message and the error data; other nodes may only return the revert data.
const revertResponses = [
	{ description: 'in the message', message: 'execution reverted: GS013', errorData: undefined, returnData: new Uint8Array() },
	{ description: 'only in the error data', message: 'execution reverted', errorData: GS013_REVERT_DATA, returnData: new Uint8Array() },
	{ description: 'only in the return data', message: 'execution reverted', errorData: undefined, returnData: hexToBytes(GS013_REVERT_DATA) },
]

const pad32 = (value: bigint) => value.toString(16).padStart(64, '0')
const keccak = (hex: string) => BigInt(`0x${ Buffer.from(keccak_256(hexToBytes(`0x${ hex }`))).toString('hex') }`)
// Solidity's slot for approvedHashes[owner][hash], with approvedHashes at slot 8, computed independently of the code under test.
const approvedHashSlot = (owner: bigint, safeTxHash: bigint) => `0x${ pad32(keccak(pad32(safeTxHash) + pad32(keccak(pad32(owner) + pad32(8n))))) }`
const prevalidatedSignature = (owner: bigint) => `${ pad32(owner) }${ pad32(0n) }01`

function createGnosisSafeCall(fields: { readonly value: bigint, readonly input: Uint8Array, readonly gas: bigint }, simulationOptions: PreSimulationTransaction['simulationOptions']): PreSimulationTransaction {
	return {
		signedTransaction: {
			type: '1559',
			from: GNOSIS_SAFE_ADDRESS,
			chainId: fakeRpcNetwork.chainId,
			nonce: 0n,
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
			gas: fields.gas,
			to: CALLED_CONTRACT,
			value: fields.value,
			input: fields.input,
			accessList: [],
			r: 0n,
			s: 0n,
			yParity: 'even',
			hash: 0x1234n + fields.value,
		},
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		created,
		originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: GNOSIS_SAFE_ADDRESS, to: CALLED_CONTRACT, value: fields.value, input: fields.input }] },
		transactionIdentifier: fields.value,
		...(simulationOptions === undefined ? {} : { simulationOptions }),
	}
}

const createBlock = (transactions: readonly SimulationInputTransaction[], stateOverrides: SimulationStateInput[number]['stateOverrides'] = {}): SimulationStateInput[number] => ({
	stateOverrides,
	transactions,
	signedMessages: [],
	blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
	simulateWithZeroBaseFee: false,
})

const getGnosisSafeTxHashAt = (transaction: PreSimulationTransaction, nonce: bigint) => {
	const { to, value, input } = transaction.signedTransaction
	if (to === null) throw new Error('Expected a call')
	return BigInt(getGnosisSafeTxHash(createGnosisSafeTx(fakeRpcNetwork.chainId, GNOSIS_SAFE_ADDRESS, { to, value, input }, nonce)))
}

// Stands in for the node's simulation of the input before an execution: answers every Safe nonce read with nonceAfterInput and records what it was asked.
const createGnosisSafeNonceReader = (nonceAfterInput: bigint) => {
	const reads: { readonly preparedInputBefore: SimulationStateInput, readonly safeAddress: bigint }[] = []
	const read = async (preparedInputBefore: SimulationStateInput, safeAddress: bigint) => {
		reads.push({ preparedInputBefore, safeAddress })
		return nonceAfterInput
	}
	return { reads, read }
}

const approvedSlotsAt = (safeTxHash: bigint) => SORTED_OWNERS.map((owner) => approvedHashSlot(owner, safeTxHash))
const getProposalGnosisSafeTxHashAt = (proposal: PreSimulationTransaction, nonce: bigint) => {
	const safeTx = proposal.safeTransaction?.safeTx
	if (safeTx === undefined) throw new Error('Expected a Gnosis Safe proposal')
	return BigInt(getGnosisSafeTxHash(createGnosisSafeTxFromMessage(fakeRpcNetwork.chainId, GNOSIS_SAFE_ADDRESS, { ...safeTx.message, nonce })))
}

const configureGnosisSafe = () => {
	fakeGnosisSafeContract.owners = OWNERS
	fakeGnosisSafeContract.threshold = 2n
	fakeGnosisSafeContract.nonce = 5n
}

test('runs a Gnosis Safe execution as an executor calling execTransaction with real fees', async () => {
	configureGnosisSafe()
	const safeCall = createGnosisSafeCall({ value: 7n, input: Uint8Array.from([0x12, 0x34]), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const ordinaryTransaction = createGnosisSafeCall({ value: 1n, input: new Uint8Array(), gas: 21_000n }, undefined)
	const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([safeCall, ordinaryTransaction])], ethereum, 123n, BASE_FEE_PER_GAS)
	const [preparedSafeCall, preparedOrdinaryTransaction] = preparedBlock?.transactions ?? []
	assert.equal(preparedOrdinaryTransaction?.executedTransaction, undefined, 'an ordinary transaction runs as it is')
	assert.deepEqual(preparedSafeCall?.signedTransaction, safeCall.signedTransaction, 'the Gnosis Safe\'s call stays what the dialog shows and the protectors check')

	const executed = preparedSafeCall?.executedTransaction
	if (executed?.type !== '1559') throw new Error('Expected the executor\'s EIP-1559 call')
	assert.equal(executed.from, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR)
	assert.equal(executed.to, GNOSIS_SAFE_ADDRESS)
	assert.equal(executed.value, 0n)
	assert.equal(executed.nonce, 0n)
	assert.equal(executed.maxPriorityFeePerGas, 10n ** 8n)
	assert.equal(executed.maxFeePerGas, EXECUTOR_MAX_FEE_PER_GAS)
	assert.ok(executed.maxFeePerGas >= BASE_FEE_PER_GAS, 'the executor pays at least the base fee')
	assert.equal(executed.gas, 64_000n + 1_000_000n)
	// Every owner signs, sorted, with pre-validated signatures, so an execution passes whatever threshold the Safe has by then.
	const expectedSignatures = `0x${ SORTED_OWNERS.map(prevalidatedSignature).join('') }`
	assert.equal(dataStringWith0xStart(executed.input), encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [addressString(CALLED_CONTRACT), 7n, '0x1234', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), expectedSignatures]))

	const safeTxHash = getGnosisSafeTxHashAt(safeCall, 5n)
	assert.deepEqual(preparedBlock?.stateOverrides, {
		[addressString(GNOSIS_SAFE_ADDRESS)]: { stateDiff: Object.fromEntries(SORTED_OWNERS.map((owner) => [approvedHashSlot(owner, safeTxHash), 1n])) },
		[addressString(GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR)]: { balance: executed.gas * EXECUTOR_MAX_FEE_PER_GAS },
	})
})

test('approves a later execution of the same Gnosis Safe only at the nonce the simulation of the earlier input gives the Gnosis Safe', async () => {
	configureGnosisSafe()
	const firstCall = createGnosisSafeCall({ value: 1n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const secondCall = createGnosisSafeCall({ value: 2n, input: new Uint8Array(), gas: 126_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const makeRichOverride = { [addressString(GNOSIS_SAFE_ADDRESS)]: { balance: 10n ** 18n } }
	// The first execution raises the Safe's nonce from 5 to 6.
	const nonceReader = createGnosisSafeNonceReader(6n)
	const [firstBlock, secondBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([firstCall], makeRichOverride), createBlock([secondCall])], ethereum, 123n, BASE_FEE_PER_GAS, nonceReader.read)
	const firstExecuted = firstBlock?.transactions[0]?.executedTransaction
	const secondExecuted = secondBlock?.transactions[0]?.executedTransaction
	if (firstExecuted === undefined || secondExecuted === undefined) throw new Error('Expected both Gnosis Safe executions to be prepared')
	assert.equal(secondExecuted.nonce, 1n, 'the executor sends its calls in order')
	assert.deepEqual(secondBlock?.stateOverrides, {}, 'every override is set at the start of the simulation')

	// The first execution needs no read: nothing before it can execute the Safe. The second reads the nonce after the prepared first block, which already carries the first execution, its approval and the executor's funding for it.
	assert.equal(nonceReader.reads.length, 1)
	const [read] = nonceReader.reads
	assert.equal(read?.safeAddress, GNOSIS_SAFE_ADDRESS)
	assert.equal(read?.preparedInputBefore.length, 2)
	assert.deepEqual(read?.preparedInputBefore[0]?.transactions[0]?.executedTransaction, firstExecuted)
	assert.deepEqual(read?.preparedInputBefore[0]?.stateOverrides, {
		[addressString(GNOSIS_SAFE_ADDRESS)]: { balance: 10n ** 18n, stateDiff: Object.fromEntries(approvedSlotsAt(getGnosisSafeTxHashAt(firstCall, 5n)).map((slot) => [slot, 1n])) },
		[addressString(GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR)]: { balance: firstExecuted.gas * EXECUTOR_MAX_FEE_PER_GAS },
	})
	assert.deepEqual(read?.preparedInputBefore[1]?.transactions, [])

	// Each execution is approved at exactly one nonce, so no approval exists that the owners could not also have made with approveHash.
	const approvedSlots = [...approvedSlotsAt(getGnosisSafeTxHashAt(firstCall, 5n)), ...approvedSlotsAt(getGnosisSafeTxHashAt(secondCall, 6n))]
	assert.deepEqual(firstBlock?.stateOverrides, {
		[addressString(GNOSIS_SAFE_ADDRESS)]: { balance: 10n ** 18n, stateDiff: Object.fromEntries(approvedSlots.map((slot) => [slot, 1n])) },
		[addressString(GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR)]: { balance: (firstExecuted.gas + secondExecuted.gas) * EXECUTOR_MAX_FEE_PER_GAS },
	})
})

test('reads the Gnosis Safe\'s nonce from the simulation after a stacked execTransaction call to it', async () => {
	configureGnosisSafe()
	const directExecution = { ...createGnosisSafeCall({ value: 0n, input: hexToBytes(encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [addressString(CALLED_CONTRACT), 0n, '0x', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), '0x'])), gas: 100_000n }, undefined) }
	const directExecutionToSafe = { ...directExecution, signedTransaction: { ...directExecution.signedTransaction, from: ORDINARY_ACCOUNT, to: GNOSIS_SAFE_ADDRESS } }
	const safeCall = createGnosisSafeCall({ value: 2n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const nonceReader = createGnosisSafeNonceReader(6n)
	const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([directExecutionToSafe, safeCall])], ethereum, 123n, BASE_FEE_PER_GAS, nonceReader.read)
	assert.deepEqual(nonceReader.reads.map((read) => read.preparedInputBefore[0]?.transactions), [[directExecutionToSafe]], 'the nonce is read after the stacked call, before the execution')
	assert.deepEqual(Object.keys(preparedBlock?.stateOverrides[addressString(GNOSIS_SAFE_ADDRESS)]?.stateDiff ?? {}).sort(), approvedSlotsAt(getGnosisSafeTxHashAt(safeCall, 6n)).sort())
	assert.equal(preparedBlock?.transactions[0]?.executedTransaction, undefined, 'the stacked execTransaction call runs as it is')
})

test('estimates a Gnosis Safe\'s call as its executor\'s execTransaction call', async () => {
	configureGnosisSafe()
	const simulator = createRecordingSimulator()
	const safeCall = createGnosisSafeCall({ value: 7n, input: new Uint8Array(), gas: 0n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const { gas: _gas, hash: _hash, r: _r, s: _s, yParity: _yParity, ...safeCallWithoutGas } = safeCall.signedTransaction
	const estimate = await estimateGnosisSafeExecutionGas(simulator.ethereum, undefined, [], safeCallWithoutGas, { website: safeCall.website, created: safeCall.created, originalRequestParameters: safeCall.originalRequestParameters, transactionIdentifier: safeCall.transactionIdentifier })
	if ('error' in estimate) throw new Error(estimate.error.message)
	assert.ok(estimate.gas > 0n)
	assert.ok(simulator.simulatedCalls.length > 0)
	assert.ok(simulator.simulatedCalls.every((call) => call.from === GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR && call.to === GNOSIS_SAFE_ADDRESS && call.baseFeePerGas > 0n), 'every estimate run is the executor\'s call in a block with the real base fee')
})


for (const { description, message, errorData, returnData } of revertResponses) {
	test(`explains a Gnosis Safe's call that reverts while its gas is estimated, reported ${ description }`, async () => {
		configureGnosisSafe()
		const revertingRequestHandler = {
			rpcUrl: fakeRpcNetwork.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
				if (rpcRequest.method !== 'eth_simulateV1') return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
				const simulationParams = rpcRequest.params?.[0]
				const blockStateCalls = isRecord(simulationParams) && Array.isArray(simulationParams.blockStateCalls) ? simulationParams.blockStateCalls : []
				return modules.serialize(modules.EthSimulateV1Result, blockStateCalls.map((blockStateCall) => ({
					...makeFakeEthSimulateResult(0n, modules.Multicall3ABI, []),
					calls: blockStateCall.calls.map(() => ({ status: 'failure', gasUsed: 75_370n, returnData, error: { code: 3, message, ...(errorData === undefined ? {} : { data: errorData }) } })),
				})))
			},
		}
		const revertingEthereum = new modules.EthereumClientService(revertingRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
		const safeCall = createGnosisSafeCall({ value: 7n, input: new Uint8Array(), gas: 0n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
		const { gas: _gas, hash: _hash, r: _r, s: _s, yParity: _yParity, ...safeCallWithoutGas } = safeCall.signedTransaction
		const estimate = await estimateGnosisSafeExecutionGas(revertingEthereum, undefined, [], safeCallWithoutGas, { website: safeCall.website, created: safeCall.created, originalRequestParameters: safeCall.originalRequestParameters, transactionIdentifier: safeCall.transactionIdentifier })
		if (!('error' in estimate)) throw new Error('Expected the estimate to fail')
		assert.equal(estimate.error.safeCallRevertedMessage, GNOSIS_SAFE_CALL_REVERTED_MESSAGE)
		assert.equal(estimate.error.message, message, 'the node\'s message stays, so the displayed explanation can only come from the field')

		// The estimate keeps the encoded GS013 as its data, which the confirmation must not show as a bare GS013 in place of the Safe's explanation.
		const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
		const popupVisualisation = await refreshConfirmTransactionSimulation(confirmationSimulator.ethereum, confirmationSimulator.tokenPriceService, GNOSIS_SAFE_ADDRESS, true, uniqueRequestIdentifier, {
			website: safeCall.website,
			created: safeCall.created,
			originalRequestParameters: safeCall.originalRequestParameters,
			transactionIdentifier: safeCall.transactionIdentifier,
			success: false,
			error: estimate.error,
		})
		if (popupVisualisation === undefined) throw new Error('The confirmation simulation did not complete')
		assert.equal(popupVisualisation.data.transactionCreationFailureReason, GNOSIS_SAFE_CALL_REVERTED_MESSAGE)
	})
}

test('reads the Gnosis Safe\'s nonce from the simulation after an execution whose own call executes a Gnosis Safe', async () => {
	configureGnosisSafe()
	// A Safe execution can call a Safe's execTransaction, here its own, which raises that Safe's nonce once more.
	const nestedExecution = createGnosisSafeCall({ value: 0n, input: hexToBytes(encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [addressString(CALLED_CONTRACT), 0n, '0x', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), '0x'])), gas: 100_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const nestedExecutionOfSafe = { ...nestedExecution, signedTransaction: { ...nestedExecution.signedTransaction, to: GNOSIS_SAFE_ADDRESS } }
	const safeCall = createGnosisSafeCall({ value: 2n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const nonceReader = createGnosisSafeNonceReader(7n)
	const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([nestedExecutionOfSafe, safeCall])], ethereum, 123n, BASE_FEE_PER_GAS, nonceReader.read)
	assert.equal(nonceReader.reads.length, 1)
	const stateDiff = preparedBlock?.stateOverrides[addressString(GNOSIS_SAFE_ADDRESS)]?.stateDiff ?? {}
	assert.deepEqual(Object.keys(stateDiff).sort(), [...approvedSlotsAt(getGnosisSafeTxHashAt(nestedExecutionOfSafe, 5n)), ...approvedSlotsAt(getGnosisSafeTxHashAt(safeCall, 7n))].sort(), 'the later execution is approved only at the nonce after both executions of the first transaction')
})

// A Safe proposal of the signing-mode stack: the Safe's call is shown, and its SafeTx is what the Safe executes.
function createGnosisSafeProposal(message: Partial<GnosisSafeTx['message']>): PreSimulationTransaction {
	const safeTx = { ...createGnosisSafeTx(fakeRpcNetwork.chainId, GNOSIS_SAFE_ADDRESS, { to: CALLED_CONTRACT, value: 3n, input: Uint8Array.from([0x56]) }, 4n), }
	const proposalSafeTx = { ...safeTx, message: { ...safeTx.message, ...message } }
	const shownCall = createGnosisSafeCall({ value: 3n, input: Uint8Array.from([0x56]), gas: 63_000n }, undefined)
	return {
		...shownCall,
		simulationOptions: { requiredChainId: fakeRpcNetwork.chainId },
		safeTransaction: { safeTx: proposalSafeTx, safeTxHash: BigInt(getGnosisSafeTxHash(proposalSafeTx)), created, websiteOrigin: 'https://example.com', transactionIdentifier: 3n, signatures: [] },
	}
}

test('runs a Gnosis Safe proposal as the executor executing its SafeTx, refund fields included, at the Gnosis Safe\'s nonce', async () => {
	configureGnosisSafe()
	const proposal = createGnosisSafeProposal({ safeTxGas: 7n, baseGas: 9n, gasPrice: 5n, gasToken: 0n, refundReceiver: ORDINARY_ACCOUNT })
	const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([proposal])], ethereum, 123n, BASE_FEE_PER_GAS)
	const executed = preparedBlock?.transactions[0]?.executedTransaction
	if (executed === undefined) throw new Error('Expected the proposal to run through the Gnosis Safe')
	assert.equal(executed.from, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR)
	assert.equal(executed.to, GNOSIS_SAFE_ADDRESS)
	const proposalSafeTx = proposal.safeTransaction?.safeTx
	if (proposalSafeTx === undefined) throw new Error('Expected a Gnosis Safe proposal')
	// The proposal's nonce 4 is signed off-chain; the Safe executes the same SafeTx at its own nonce 5.
	const executedSafeTx = decodeGnosisSafeExecution(fakeRpcNetwork.chainId, GNOSIS_SAFE_ADDRESS, proposalSafeTx.message.nonce, executed.input).safeTx
	assert.deepEqual(executedSafeTx, proposalSafeTx)
	const safeTxHashAtSafeNonce = BigInt(getGnosisSafeTxHash(createGnosisSafeTxFromMessage(fakeRpcNetwork.chainId, GNOSIS_SAFE_ADDRESS, { ...proposalSafeTx.message, nonce: 5n })))
	assert.deepEqual(preparedBlock?.stateOverrides[addressString(GNOSIS_SAFE_ADDRESS)]?.stateDiff, Object.fromEntries(SORTED_OWNERS.map((owner) => [approvedHashSlot(owner, safeTxHashAtSafeNonce), 1n])))
})

test('reads the Gnosis Safe\'s nonce from the simulation after a Gnosis Safe proposal whose MultiSend batch executes the Gnosis Safe', async () => {
	configureGnosisSafe()
	const { encodeGnosisSafeBatch, GNOSIS_SAFE_MULTI_SEND_CALL_ONLY } = await import('../../app/ts/gnosisSafe/gnosisSafeDelegateCalls.js')
	const selfExecution = hexToBytes(encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [addressString(CALLED_CONTRACT), 0n, '0x', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), '0x']))
	const batch = createGnosisSafeProposal({ to: GNOSIS_SAFE_MULTI_SEND_CALL_ONLY, value: 0n, operation: 1n, data: encodeGnosisSafeBatch([{ to: GNOSIS_SAFE_ADDRESS, value: 0n, data: selfExecution }, { to: CALLED_CONTRACT, value: 0n, data: new Uint8Array([1]) }]) })
	const laterProposal = createGnosisSafeProposal({ value: 9n })
	// The batch's own execution and the execution its batch makes raise the nonce from 5 to 7.
	const nonceReader = createGnosisSafeNonceReader(7n)
	const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([batch, laterProposal])], ethereum, 123n, BASE_FEE_PER_GAS, nonceReader.read)
	assert.equal(nonceReader.reads.length, 1)
	const stateDiff = preparedBlock?.stateOverrides[addressString(GNOSIS_SAFE_ADDRESS)]?.stateDiff ?? {}
	assert.ok(approvedSlotsAt(getProposalGnosisSafeTxHashAt(laterProposal, 7n)).every((slot) => stateDiff[slot] === 1n))
	assert.ok(approvedSlotsAt(getProposalGnosisSafeTxHashAt(laterProposal, 6n)).every((slot) => stateDiff[slot] === undefined), 'no approval at a nonce the Gnosis Safe does not have at execution')
})

test('reads the Gnosis Safe\'s nonce from the simulation after a stacked execTransaction call whose MultiSend batch executes the Gnosis Safe again', async () => {
	configureGnosisSafe()
	const { encodeGnosisSafeBatch, GNOSIS_SAFE_MULTI_SEND_CALL_ONLY } = await import('../../app/ts/gnosisSafe/gnosisSafeDelegateCalls.js')
	const encodeExecTransaction = (to: bigint, data: string, operation: bigint) => encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [addressString(to), 0n, data, operation, 0n, 0n, 0n, addressString(0n), addressString(0n), '0x'])
	const batch = encodeGnosisSafeBatch([{ to: GNOSIS_SAFE_ADDRESS, value: 0n, data: hexToBytes(encodeExecTransaction(CALLED_CONTRACT, '0x', 0n)) }, { to: CALLED_CONTRACT, value: 0n, data: new Uint8Array([1]) }])
	const stackedCall = createGnosisSafeCall({ value: 0n, input: hexToBytes(encodeExecTransaction(GNOSIS_SAFE_MULTI_SEND_CALL_ONLY, dataStringWith0xStart(batch), 1n)), gas: 200_000n }, undefined)
	const stackedExecution = { ...stackedCall, signedTransaction: { ...stackedCall.signedTransaction, from: ORDINARY_ACCOUNT, to: GNOSIS_SAFE_ADDRESS } }
	const laterProposal = createGnosisSafeProposal({ value: 9n })
	// The stacked execution and the execution its batch makes raise the nonce from 5 to 7.
	const nonceReader = createGnosisSafeNonceReader(7n)
	const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([stackedExecution, laterProposal])], ethereum, 123n, BASE_FEE_PER_GAS, nonceReader.read)
	assert.equal(nonceReader.reads.length, 1)
	assert.deepEqual(Object.keys(preparedBlock?.stateOverrides[addressString(GNOSIS_SAFE_ADDRESS)]?.stateDiff ?? {}).sort(), approvedSlotsAt(getProposalGnosisSafeTxHashAt(laterProposal, 7n)).sort())
})

test('reads the Gnosis Safe\'s nonce from the simulation after a Gnosis Safe execution that another Gnosis Safe or any contract relays', async () => {
	configureGnosisSafe()
	const OTHER_SAFE = 0x7777777777777777777777777777777777777777n
	const encodeExecTransaction = (to: bigint, data: string) => encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [addressString(to), 0n, data, 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), '0x'])
	// Another Safe, which the input doesn't otherwise execute, executes this Safe through its own execTransaction.
	const relayedThroughOtherSafe = createGnosisSafeCall({ value: 0n, input: hexToBytes(encodeExecTransaction(OTHER_SAFE, encodeExecTransaction(GNOSIS_SAFE_ADDRESS, '0x'))), gas: 200_000n }, undefined)
	const throughOtherSafe = { ...relayedThroughOtherSafe, signedTransaction: { ...relayedThroughOtherSafe.signedTransaction, from: ORDINARY_ACCOUNT, to: OTHER_SAFE } }
	// Any contract can relay an execution it is handed in its calldata.
	const relayedByContract = createGnosisSafeCall({ value: 0n, input: hexToBytes(encodeFunctionCall([{ type: 'function', name: 'relay', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }], outputs: [] }], 'relay', [addressString(GNOSIS_SAFE_ADDRESS), encodeExecTransaction(CALLED_CONTRACT, '0x')])), gas: 200_000n }, undefined)
	const byContract = { ...relayedByContract, signedTransaction: { ...relayedByContract.signedTransaction, from: ORDINARY_ACCOUNT, to: CALLED_CONTRACT } }
	for (const relay of [throughOtherSafe, byContract]) {
		const laterProposal = createGnosisSafeProposal({ value: 9n })
		const nonceReader = createGnosisSafeNonceReader(6n)
		const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([relay, laterProposal])], ethereum, 123n, BASE_FEE_PER_GAS, nonceReader.read)
		assert.deepEqual(nonceReader.reads.map((read) => read.preparedInputBefore[0]?.transactions), [[relay]])
		assert.deepEqual(Object.keys(preparedBlock?.stateOverrides[addressString(GNOSIS_SAFE_ADDRESS)]?.stateDiff ?? {}).sort(), approvedSlotsAt(getProposalGnosisSafeTxHashAt(laterProposal, 6n)).sort())
	}
})

test('reads a Gnosis Safe\'s nonce in a simulation on top of the parent block the input was prepared for, not a newer latest block', async () => {
	configureGnosisSafe()
	const parentBlockNumber = 120n
	// A newer block arrived after the input was prepared for block 120.
	const newerLatestBlockNumber = 130n
	const simulatedOnBlockTags: unknown[] = []
	const recordingRequestHandler = {
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			if (rpcRequest.method === 'eth_getBlockByNumber') {
				const blockTag = rpcRequest.params?.[0]
				return modules.serialize(modules.EthereumBlockHeader, { ...makeFakeBlock(), number: typeof blockTag === 'bigint' ? blockTag : newerLatestBlockNumber })
			}
			if (rpcRequest.method === 'eth_simulateV1') simulatedOnBlockTags.push(rpcRequest.params?.[1])
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}
	const recordingEthereum = new modules.EthereumClientService(recordingRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
	const ordinaryTransaction = createGnosisSafeCall({ value: 1n, input: new Uint8Array(), gas: 21_000n }, undefined)
	const preparedInputBefore = [createBlock([{ ...ordinaryTransaction, signedTransaction: { ...ordinaryTransaction.signedTransaction, from: ORDINARY_ACCOUNT } }])]

	assert.equal(await createGnosisSafeNonceAfterInputReader(recordingEthereum)(preparedInputBefore, GNOSIS_SAFE_ADDRESS, parentBlockNumber), fakeGnosisSafeContract.nonce)
	assert.ok(simulatedOnBlockTags.length > 0, 'the nonce is read through a simulation')
	assert.deepEqual(simulatedOnBlockTags, simulatedOnBlockTags.map(() => parentBlockNumber), 'every simulation the read runs builds on the parent block')
})

test('approves a Gnosis Safe execution at one nonce however many execTransaction selectors a page stuffs into calldata', async () => {
	configureGnosisSafe()
	const stuffedCalldata = new Uint8Array(4 * 10_000)
	for (let index = 0; index < stuffedCalldata.length; index += 4) stuffedCalldata.set([0x6a, 0x76, 0x12, 0x02], index)
	const stuffedTransaction = createGnosisSafeCall({ value: 0n, input: stuffedCalldata, gas: 1_000_000n }, undefined)
	const laterProposal = createGnosisSafeProposal({ value: 9n })
	// Stuffed selectors execute nothing, so the simulation leaves the Safe's nonce at 5.
	const nonceReader = createGnosisSafeNonceReader(5n)
	const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([{ ...stuffedTransaction, signedTransaction: { ...stuffedTransaction.signedTransaction, from: ORDINARY_ACCOUNT } }, laterProposal])], ethereum, 123n, BASE_FEE_PER_GAS, nonceReader.read)
	assert.equal(nonceReader.reads.length, 1)
	assert.deepEqual(Object.keys(preparedBlock?.stateOverrides[addressString(GNOSIS_SAFE_ADDRESS)]?.stateDiff ?? {}).sort(), approvedSlotsAt(getProposalGnosisSafeTxHashAt(laterProposal, 5n)).sort())
})

test('approves a Gnosis Safe execution at the Gnosis Safe\'s nonce at the parent block, without simulating, when no earlier transaction can execute a Gnosis Safe', async () => {
	configureGnosisSafe()
	const ordinaryTransaction = createGnosisSafeCall({ value: 1n, input: Uint8Array.from([0x12, 0x34]), gas: 21_000n }, undefined)
	const laterProposal = createGnosisSafeProposal({ value: 9n })
	const nonceReader = createGnosisSafeNonceReader(99n)
	const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([ordinaryTransaction, laterProposal])], ethereum, 123n, BASE_FEE_PER_GAS, nonceReader.read)
	assert.equal(nonceReader.reads.length, 0)
	assert.deepEqual(Object.keys(preparedBlock?.stateOverrides[addressString(GNOSIS_SAFE_ADDRESS)]?.stateDiff ?? {}).sort(), approvedSlotsAt(getProposalGnosisSafeTxHashAt(laterProposal, 5n)).sort())
})

test('drops the zero base fee flag of a Gnosis Safe proposal stored by an earlier version and runs it with the real base fee', async () => {
	configureGnosisSafe()
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork, activeSigningSafeAddress: GNOSIS_SAFE_ADDRESS })
	const serializedProposal = modules.serialize(PreSimulationTransaction, createGnosisSafeProposal({}))
	// Earlier versions stored Safe proposals for a zero base fee block.
	const storedByEarlierVersion = { operations: [{ type: 'Transaction', preSimulationTransaction: { ...serializedProposal, simulationOptions: { ...serializedProposal.simulationOptions, simulateWithZeroBaseFee: true } } }] }
	// Loading the stack from storage parses it with InterceptorTransactionStack.
	const loadedStack = InterceptorTransactionStack.parse(storedByEarlierVersion)
	const [loadedOperation] = loadedStack.operations
	if (loadedOperation?.type !== 'Transaction') throw new Error('Expected the stored proposal')
	assert.deepEqual(loadedOperation.preSimulationTransaction.simulationOptions, { requiredChainId: fakeRpcNetwork.chainId })
	await modules.updateInterceptorTransactionStack(() => loadedStack)
	const { getCurrentSimulationInput, prepareGnosisSafeExecutionsForRpc } = await import('../../app/ts/background/simulationUpdating.js')
	const stackInput = await getCurrentSimulationInput()
	assert.equal(stackInput.at(-1)?.simulateWithZeroBaseFee, false)
	const preparedInput = await prepareGnosisSafeExecutionsForRpc(stackInput, ethereum)
	assert.equal(preparedInput.at(-1)?.transactions.at(-1)?.executedTransaction?.from, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR)
})

// Opens a confirmation's Gnosis Safe preparation and stores its flow in the pending transaction as openConfirmTransactionDialogForTransaction does, then returns the fee mode the confirmation formed the transaction with and the one every refresh reads back from the pending transaction.
async function getOpenedAndRefreshedGasPayments(transactionParams: SendTransactionParams, simulationMode: boolean, selectedActiveAddress: bigint) {
	const { getPendingTransactionGasPayment } = await import('../../app/ts/gnosisSafe/gnosisSafePendingFlow.js')
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry()])
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: selectedActiveAddress })
	const preparation = await prepareGnosisSafeTransactionConfirmation(ethereum, { kind: 'transaction', parameters: transactionParams }, simulationMode, selectedActiveAddress, undefined)
	if (preparation.effectiveTransactionParams.method !== 'eth_sendTransaction') throw new Error('Expected an eth_sendTransaction request')
	const website = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }
	// As the confirmation does, a preparation failure is shown instead of forming the transaction.
	const transactionToSimulate = preparation.preparationMessage !== undefined
		? { website, created, originalRequestParameters: preparation.effectiveTransactionParams, transactionIdentifier: 1n, success: false as const, error: { code: -32700, message: preparation.preparationMessage } }
		: await modules.formEthSendTransaction(ethereum, undefined, preparation.transactionExecutor, website, preparation.effectiveTransactionParams, created, 1n, simulationMode, preparation.gasPayment)
	const { safeFlow } = await preparation.finalize(transactionToSimulate, uniqueRequestIdentifier.requestSocket.tabId)
	const pending = { ...pendingTransaction, safeFlow }
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
	return { opened: preparation.gasPayment, refreshed: getPendingTransactionGasPayment(pending) }
}

const flowGasPaymentCases = [
	{ description: 'an ordinary transaction', simulationMode: true, selectedActiveAddress: ORDINARY_ACCOUNT, createParams: async () => await createTransferParams({}), expected: 'transaction-sender' },
	{ description: 'a Gnosis Safe\'s own call in simulation mode', simulationMode: true, selectedActiveAddress: GNOSIS_SAFE_ADDRESS, createParams: async () => await createTransferParams({}), expected: 'simulated-safe-executor' },
	{ description: 'a Gnosis Safe proposal', simulationMode: false, selectedActiveAddress: GNOSIS_SAFE_ADDRESS, createParams: async () => await createTransferParams({ from: addressString(GNOSIS_SAFE_ADDRESS), gas: '0x5208' }), expected: 'simulated-safe-executor' },
	{ description: 'a direct Gnosis Safe execution', simulationMode: false, selectedActiveAddress: GNOSIS_SAFE_ADDRESS, createParams: async () => await createTransferParams({ from: addressString(GNOSIS_SAFE_ADDRESS), to: addressString(GNOSIS_SAFE_ADDRESS), data: encodeFunctionCall(GNOSIS_SAFE_EXECUTION_ABI, 'execTransaction', [addressString(CALLED_CONTRACT), 0n, '0x', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), '0x']) }), expected: 'external-executor' },
] as const

for (const { description, simulationMode, selectedActiveAddress, createParams, expected } of flowGasPaymentCases) {
	test(`forms ${ description } with the same fee mode when its confirmation opens and on every refresh`, async () => {
		configureGnosisSafe()
		// The Safe's hash of the proposal's SafeTx, the transfer at the Safe's nonce, which the proposal is checked against.
		fakeGnosisSafeContract.transactionHash = BigInt(getGnosisSafeTxHash(createGnosisSafeTx(fakeRpcNetwork.chainId, GNOSIS_SAFE_ADDRESS, { to: CALLED_CONTRACT, value: 0n, input: new Uint8Array() }, fakeGnosisSafeContract.nonce)))
		const { opened, refreshed } = await withSilencedConsole(async () => await getOpenedAndRefreshedGasPayments(await createParams(), simulationMode, selectedActiveAddress))
		assert.deepEqual({ opened, refreshed }, { opened: expected, refreshed: expected })
	})
}

// The fake Safe reports a SafeTx hash that matches no proposal, so creating the proposal fails.
const GNOSIS_SAFE_PROPOSAL_CREATION_FAILURE = /locally computed Gnosis Safe transaction hash does not match/u

test('forms a Gnosis Safe proposal whose creation fails with the same fee mode when its confirmation opens and on every refresh', async () => {
	configureGnosisSafe()
	const { opened, refreshed } = await withSilencedConsole(async () => await getOpenedAndRefreshedGasPayments(await createTransferParams({ from: addressString(GNOSIS_SAFE_ADDRESS), gas: '0x5208' }), false, GNOSIS_SAFE_ADDRESS))
	assert.deepEqual({ opened, refreshed }, { opened: 'simulated-safe-executor', refreshed: 'simulated-safe-executor' })
})

type PendingTransaction = Extract<Awaited<ReturnType<typeof modules.getPendingTransactionsAndMessages>>[number], { readonly type: 'Transaction' }>

// Opens a signing-mode confirmation of the configured Gnosis Safe.
async function openSigningModeGnosisSafeConfirmation(simulator: ReturnType<typeof createRecordingSimulator>, transactionParams: SendTransactionParams, safeRequestContext?: { readonly operation: 0 | 1 }) {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry()])
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork })
	assert.deepEqual(await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{ interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, method: transactionParams.method, params: transactionParams.params },
		{ kind: 'transaction', parameters: transactionParams, ...(safeRequestContext === undefined ? {} : { safeTransaction: safeRequestContext }) },
		false,
		GNOSIS_SAFE_ADDRESS,
		GNOSIS_SAFE_CALL_WEBSITE,
		createWebsiteTabConnections([]),
	)), { type: 'doNotReply' })
}

const getFirstPendingTransaction = async (stage: string) => {
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'Transaction' || !('transactionToSimulate' in pending)) throw new Error(`Expected the pending transaction ${ stage }`)
	return pending
}

// Opens a signing-mode confirmation of the configured Gnosis Safe, refreshes it, and checks the failure the pending transaction holds when it opens and after the refresh.
async function assertGnosisSafeFailureKeptThroughRefresh(transactionParams: SendTransactionParams, assertPending: (pending: PendingTransaction, stage: string) => void, simulator = createRecordingSimulator()) {
	await openSigningModeGnosisSafeConfirmation(simulator, transactionParams)
	const assertFailure = async (stage: string) => {
		const pending = await getFirstPendingTransaction(stage)
		assert.equal(pending.transactionOrMessageCreationStatus, 'FailedToSimulate', stage)
		assert.equal(pending.transactionToSimulate.success, false, stage)
		assertPending(pending, stage)
	}
	await assertFailure('when the confirmation opens')
	await withSilencedConsole(async () => await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService))
	await assertFailure('after a refresh')
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
	return simulator
}

const getFailureMessage = (transaction: WebsiteCreatedEthereumTransactionOrFailed) => transaction.success ? undefined : transaction.error.message

test('keeps a Gnosis Safe proposal whose transaction formed but whose Gnosis Safe transaction could not be made a failure through refresh instead of an ordinary transaction from the Gnosis Safe', async () => {
	configureGnosisSafe()
	const simulator = await assertGnosisSafeFailureKeptThroughRefresh(await createTransferParams({ from: addressString(GNOSIS_SAFE_ADDRESS), gas: '0x5208' }), (pending, stage) => {
		assert.deepEqual(pending.safeFlow, { kind: 'proposal', state: 'creationFailed' }, stage)
		assert.match(getFailureMessage(pending.transactionToSimulate) ?? '', GNOSIS_SAFE_PROPOSAL_CREATION_FAILURE, stage)
	})
	assert.equal(simulator.simulatedCalls.some((call) => call.from === GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR), false, 'the refresh neither forms nor simulates the transaction again')
})

// What fails while the proposal's transaction forms when its confirmation opens: its gas estimate, the Safe executor's execTransaction call, reverts or meets a network error.
const safeProposalFormationFailures = [
	{ description: 'a gas estimate that reverts', outcome: 'revert' },
	{ description: 'a network error', outcome: 'network-error' },
] as const

for (const { description, outcome } of safeProposalFormationFailures) {
	test(`retries a Gnosis Safe proposal whose transaction did not form because of ${ description } as a proposal on every refresh, and creates the proposal once it forms`, async () => {
		configureGnosisSafe()
		const { getPendingTransactionGasPayment } = await import('../../app/ts/gnosisSafe/gnosisSafePendingFlow.js')
		// The Safe's hash of the proposal's SafeTx, the transfer at the Safe's nonce, which the proposal is checked against.
		const safeTxHash = BigInt(getGnosisSafeTxHash(createGnosisSafeTx(fakeRpcNetwork.chainId, GNOSIS_SAFE_ADDRESS, { to: CALLED_CONTRACT, value: 0n, input: new Uint8Array() }, fakeGnosisSafeContract.nonce)))
		fakeGnosisSafeContract.transactionHash = safeTxHash
		const executorCall: { outcome: SimulationOutcome } = { outcome }
		const simulator = createRecordingSimulator('fake-node', () => executorCall.outcome)
		// Without a gas limit, so forming the transaction estimates its gas.
		await openSigningModeGnosisSafeConfirmation(simulator, await createTransferParams({ from: addressString(GNOSIS_SAFE_ADDRESS) }), { operation: 0 })
		const refresh = async () => await withSilencedConsole(async () => await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService))
		const assertProposalRetried = async (stage: string) => {
			const pending = await getFirstPendingTransaction(stage)
			assert.equal(pending.transactionOrMessageCreationStatus, 'FailedToSimulate', stage)
			assert.deepEqual(pending.safeFlow, { kind: 'proposal', state: 'formationFailed', safeRequestContext: { operation: 0 } }, stage)
			assert.equal(getPendingTransactionGasPayment(pending), 'simulated-safe-executor', `${ stage }: formed as a proposal, not as an ordinary transaction from the Gnosis Safe`)
		}
		await assertProposalRetried('when the confirmation opens')
		await refresh()
		await assertProposalRetried('after a refresh whose transaction does not form either')
		executorCall.outcome = 'fake-node'
		await refresh()
		const formed = await getFirstPendingTransaction('after a refresh whose transaction forms')
		assert.equal(formed.transactionOrMessageCreationStatus, 'Simulated')
		if (formed.safeFlow.kind !== 'proposal' || formed.safeFlow.state !== 'created') throw new Error(`Expected a created Gnosis Safe proposal, got ${ JSON.stringify(formed.safeFlow.kind) }`)
		assert.equal(formed.safeFlow.safeTransaction.safeTxHash, safeTxHash)
		assert.equal(formed.safeFlow.safeTransaction.safeTx.message.operation, 0n)
		assert.equal(getPendingTransactionGasPayment(formed), 'simulated-safe-executor')
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
		await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
	})
}

test('keeps a Gnosis Safe proposal whose transaction did not form as it is when a refresh finds its Gnosis Safe is no longer configured, instead of forming it as an ordinary transaction from the Gnosis Safe', async () => {
	configureGnosisSafe()
	const simulator = createRecordingSimulator('fake-node', () => 'revert')
	await openSigningModeGnosisSafeConfirmation(simulator, await createTransferParams({ from: addressString(GNOSIS_SAFE_ADDRESS) }))
	const opened = await getFirstPendingTransaction('when the confirmation opens')
	assert.deepEqual(opened.safeFlow, { kind: 'proposal', state: 'formationFailed' })
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
	const simulatedCallCount = simulator.simulatedCalls.length
	await withSilencedConsole(async () => await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService))
	assert.deepEqual(await getFirstPendingTransaction('after the refresh'), opened)
	assert.equal(simulator.simulatedCalls.length, simulatedCallCount, 'nothing is formed or simulated')
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
})

// A contract creation from the configured Safe, which it can't make through execTransaction, with or without the page's gas.
const createGnosisSafeContractCreationParams = async (gas: Record<string, string>) => (await import('../../app/ts/types/JsonRpc-types.js')).SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [{ from: addressString(GNOSIS_SAFE_ADDRESS), value: '0x0', data: '0x00', ...gas }] })
const safeContractCreationCases = [
	{ description: 'without gas', gas: {}, contractCreationSimulationOutcome: 'fake-node' },
	{ description: 'with gas', gas: { gas: '0x30d40' }, contractCreationSimulationOutcome: 'fake-node' },
	{ description: 'without gas whose estimate would revert', gas: {}, contractCreationSimulationOutcome: 'revert' },
	{ description: 'without gas whose estimate would fail with a network error', gas: {}, contractCreationSimulationOutcome: 'network-error' },
] as const

for (const { description, gas, contractCreationSimulationOutcome } of safeContractCreationCases) {
	test(`forms a contract creation from a configured Gnosis Safe ${ description } with the same fee mode when its confirmation opens and on every refresh`, async () => {
		configureGnosisSafe()
		const { opened, refreshed } = await withSilencedConsole(async () => await getOpenedAndRefreshedGasPayments(await createGnosisSafeContractCreationParams(gas), false, GNOSIS_SAFE_ADDRESS))
		assert.deepEqual({ opened, refreshed }, { opened: 'external-executor', refreshed: 'external-executor' })
	})

	test(`shows a contract creation from a configured Gnosis Safe ${ description } as the request-shape rejection, not a failed proposal, through refresh`, async () => {
		configureGnosisSafe()
		const simulator = await assertGnosisSafeFailureKeptThroughRefresh(await createGnosisSafeContractCreationParams(gas), (pending, stage) => {
			assert.equal(getFailureMessage(pending.transactionToSimulate), GNOSIS_SAFE_UNSUPPORTED_TRANSACTION_MESSAGES['contract-creation'], stage)
			assert.deepEqual(pending.safeFlow, { kind: 'unsupportedSafeRequest' }, stage)
		}, createRecordingSimulator(contractCreationSimulationOutcome))
		assert.equal(simulator.simulatedCalls.some((call) => call.to === undefined), false, 'the unsupported request is neither estimated nor simulated')
	})
}

test('leaves an input without Gnosis Safe executions as it is, without reading any Gnosis Safe', async () => {
	const input = [createBlock([createGnosisSafeCall({ value: 1n, input: new Uint8Array(), gas: 21_000n }, undefined)])]
	fakeGnosisSafeContract.requestedRpcMethods.length = 0
	assert.equal(await prepareGnosisSafeExecutionSimulationInput(input, ethereum, 123n, BASE_FEE_PER_GAS), input)
	assert.deepEqual(fakeGnosisSafeContract.requestedRpcMethods, [])
})

test('sends the executor\'s call to the node in place of the Gnosis Safe\'s call', async () => {
	configureGnosisSafe()
	const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([createGnosisSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)])], ethereum, 123n, BASE_FEE_PER_GAS)
	if (preparedBlock === undefined) throw new Error('Expected a prepared block')
	const request = await ethereum.ethSimulateV1Input(toSimulationStateInputMinimalData([preparedBlock]), 123n, undefined)
	const [call] = request.params[0].blockStateCalls[0]?.calls ?? []
	assert.equal(call?.from, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR)
	assert.equal(call?.to, GNOSIS_SAFE_ADDRESS)
	assert.equal(call?.maxFeePerGas, EXECUTOR_MAX_FEE_PER_GAS)
})

test('rejects a Gnosis Safe execution or Gnosis Safe proposal that reaches the node without its executor\'s call', async () => {
	for (const unpreparedExecution of [createGnosisSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS), createGnosisSafeProposal({})]) {
		// A distinctly named error that is still reported as an unexpected one, since a caller skipped preparing its input.
		await assert.rejects(ethereum.ethSimulateV1Input(toSimulationStateInputMinimalData([createBlock([unpreparedExecution])]), 123n, undefined), (error: unknown) => isUnpreparedSimulationInputError(error)
			&& error.name === 'UnpreparedSimulationInputError'
			&& error.violation === 'missing-executed-call'
			&& /requires a prepared executed call reached the node without one/u.test(error.message)
			&& classifyCaughtError(error) === 'unexpected')
	}
})

test('rejects a transaction that is not a Gnosis Safe execution but reaches the node with another call to run', async () => {
	const shownCall = createGnosisSafeCall({ value: 7n, input: Uint8Array.from([0x12, 0x34]), gas: 63_000n }, undefined)
	const otherCall = createGnosisSafeCall({ value: 0n, input: new Uint8Array(), gas: 21_000n }, undefined).signedTransaction
	await assert.rejects(ethereum.ethSimulateV1Input(toSimulationStateInputMinimalData([createBlock([{ ...shownCall, executedTransaction: otherCall }])]), 123n, undefined), (error: unknown) => isUnpreparedSimulationInputError(error)
		&& error.violation === 'unauthorized-executed-call'
		&& /reached the node with an executed call other than its signed transaction, which it does not authorize/u.test(error.message))
})

test('projects a Gnosis Safe proposal and a simulation-mode Gnosis Safe execution into the RPC input as authorized executed calls, without their Gnosis Safe data', () => {
	const ordinaryCall = createGnosisSafeCall({ value: 1n, input: new Uint8Array(), gas: 21_000n }, undefined)
	const [projectedBlock] = toSimulationStateInputMinimalData([createBlock([createGnosisSafeProposal({}), createGnosisSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS), ordinaryCall])])
	assert.deepEqual(projectedBlock?.transactions.map((transaction) => transaction.executedCallAuthorized), [true, true, false])
	for (const transaction of projectedBlock?.transactions ?? []) assert.deepEqual(Object.keys(transaction).sort(), ['executedCallAuthorized', 'signedTransaction'])
	assert.deepEqual(projectedBlock?.transactions[2]?.signedTransaction, ordinaryCall.signedTransaction)
})

test('decides the RPC boundary checks from the executed-call marker alone', async () => {
	const shownCall = createGnosisSafeCall({ value: 7n, input: Uint8Array.from([0x12, 0x34]), gas: 63_000n }, undefined).signedTransaction
	const otherCall = createGnosisSafeCall({ value: 0n, input: new Uint8Array(), gas: 21_000n }, undefined).signedTransaction
	const createMinimalInput = (transaction: SimulationStateInputMinimalData[number]['transactions'][number]): SimulationStateInputMinimalData => [{ ...createBlock([]), transactions: [transaction] }]
	await assert.rejects(ethereum.ethSimulateV1Input(createMinimalInput({ signedTransaction: shownCall, executedCallAuthorized: true }), 123n, undefined), (error: unknown) => isUnpreparedSimulationInputError(error) && error.violation === 'missing-executed-call')
	await assert.rejects(ethereum.ethSimulateV1Input(createMinimalInput({ signedTransaction: shownCall, executedTransaction: otherCall, executedCallAuthorized: false }), 123n, undefined), (error: unknown) => isUnpreparedSimulationInputError(error) && error.violation === 'unauthorized-executed-call')
	const request = await ethereum.ethSimulateV1Input(createMinimalInput({ signedTransaction: shownCall, executedTransaction: otherCall, executedCallAuthorized: true }), 123n, undefined)
	assert.equal(request.params[0].blockStateCalls[0]?.calls[0]?.value, otherCall.value, 'the node runs the authorized executed call')
})

const staleExecutionCases = [
	{ description: 'in an input without Gnosis Safe executions', createOtherTransactions: (): readonly PreSimulationTransaction[] => [] },
	{ description: 'next to a Gnosis Safe execution', createOtherTransactions: (): readonly PreSimulationTransaction[] => [createGnosisSafeCall({ value: 9n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)] },
]

for (const { description, createOtherTransactions } of staleExecutionCases) {
	test(`clears another call to run from a transaction that is not a Gnosis Safe execution, ${ description }`, async () => {
		configureGnosisSafe()
		const shownCall = createGnosisSafeCall({ value: 7n, input: Uint8Array.from([0x12, 0x34]), gas: 63_000n }, undefined)
		const otherCall = createGnosisSafeCall({ value: 0n, input: new Uint8Array(), gas: 21_000n }, undefined).signedTransaction
		const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([{ ...shownCall, executedTransaction: otherCall }, ...createOtherTransactions()])], ethereum, 123n, BASE_FEE_PER_GAS)
		const [preparedShownCall] = preparedBlock?.transactions ?? []
		assert.deepEqual(preparedShownCall, shownCall)
		if (preparedBlock === undefined) throw new Error('Expected a prepared block')
		const request = await ethereum.ethSimulateV1Input(toSimulationStateInputMinimalData([preparedBlock]), 123n, undefined)
		const [call] = request.params[0].blockStateCalls[0]?.calls ?? []
		assert.equal(call?.value, shownCall.signedTransaction.value, 'the node runs the call the transaction shows')
	})
}

const preparedExecutionCases = [
	{ description: 'a Gnosis Safe execution', createExecution: () => createGnosisSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS) },
	{ description: 'a Gnosis Safe proposal', createExecution: () => createGnosisSafeProposal({}) },
]

for (const { description, createExecution } of preparedExecutionCases) {
	test(`passes both RPC boundary checks with ${ description } prepared to run through the Gnosis Safe, again from the gas-limited blocks`, async () => {
		configureGnosisSafe()
		const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([createExecution()])], ethereum, 123n, BASE_FEE_PER_GAS)
		if (preparedBlock === undefined) throw new Error('Expected a prepared block')
		const prepared = await ethereum.prepareEthSimulateV1Input(toSimulationStateInputMinimalData([preparedBlock]), 123n, undefined)
		// The simulated balances simulate the gas-limited blocks again, so they must still carry the executed-call marker, and only it.
		const reprepared = await ethereum.prepareEthSimulateV1Input(prepared.rpcBlocks, 123n, undefined)
		const repreparedTransaction = reprepared.rpcBlocks[0]?.transactions[0]
		assert.equal(repreparedTransaction?.executedTransaction?.from, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR)
		assert.deepEqual(Object.keys(repreparedTransaction ?? {}).sort(), ['executedCallAuthorized', 'executedTransaction', 'signedTransaction'])
		assert.equal(repreparedTransaction?.executedCallAuthorized, true)
	})
}

test('rejects and clears the executor\'s call of a Gnosis Safe proposal\'s shown call that is no longer a Gnosis Safe proposal', async () => {
	configureGnosisSafe()
	const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([createGnosisSafeProposal({})])], ethereum, 123n, BASE_FEE_PER_GAS)
	const preparedProposal = preparedBlock?.transactions[0]
	if (preparedProposal?.executedTransaction === undefined) throw new Error('Expected a prepared Gnosis Safe proposal')
	const { safeTransaction: _safeTransaction, ...shownCallWithExecutorCall } = preparedProposal
	await assert.rejects(ethereum.ethSimulateV1Input(toSimulationStateInputMinimalData([createBlock([shownCallWithExecutorCall])]), 123n, undefined), (error: unknown) => isUnpreparedSimulationInputError(error) && error.violation === 'unauthorized-executed-call')
	const [clearedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([shownCallWithExecutorCall])], ethereum, 123n, BASE_FEE_PER_GAS)
	assert.equal(clearedBlock?.transactions[0]?.executedTransaction, undefined)
})

test('replaces another call to run that a Gnosis Safe proposal carries with its executor\'s execution of the SafeTx', async () => {
	configureGnosisSafe()
	const proposal = createGnosisSafeProposal({})
	const otherCall = createGnosisSafeCall({ value: 0n, input: new Uint8Array(), gas: 21_000n }, undefined).signedTransaction
	const [preparedBlock] = await prepareGnosisSafeExecutionSimulationInput([createBlock([{ ...proposal, executedTransaction: otherCall }])], ethereum, 123n, BASE_FEE_PER_GAS)
	const executed = preparedBlock?.transactions[0]?.executedTransaction
	const proposalSafeTx = proposal.safeTransaction?.safeTx
	if (executed === undefined || proposalSafeTx === undefined) throw new Error('Expected a prepared Gnosis Safe proposal')
	assert.equal(executed.from, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR)
	assert.deepEqual(decodeGnosisSafeExecution(fakeRpcNetwork.chainId, GNOSIS_SAFE_ADDRESS, proposalSafeTx.message.nonce, executed.input).safeTx, proposalSafeTx)
})

test('drops an execution override from an imported simulation stack, so a stacked transaction runs the call it shows', () => {
	const shownCall = createGnosisSafeCall({ value: 7n, input: Uint8Array.from([0x12, 0x34]), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const harmlessCall = createGnosisSafeCall({ value: 0n, input: new Uint8Array(), gas: 21_000n }, undefined)
	const importedStack = InterceptorTransactionStack.parse({ operations: [{
		type: 'Transaction',
		preSimulationTransaction: { ...modules.serialize(PreSimulationTransaction, shownCall), executedTransaction: modules.serialize(EthereumSendableSignedTransaction, harmlessCall.signedTransaction) },
	}] })
	const [operation] = importedStack.operations
	if (operation?.type !== 'Transaction') throw new Error('Expected the imported transaction')
	assert.equal('executedTransaction' in operation.preSimulationTransaction, false)
	assert.deepEqual(operation.preSimulationTransaction, shownCall)
})

test('looks up a simulated Gnosis Safe execution as the Gnosis Safe\'s own call, as its receipt shows it', async () => {
	configureGnosisSafe()
	const safeCall = createGnosisSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const preparedInput = await prepareGnosisSafeExecutionSimulationInput([createBlock([safeCall])], ethereum, 123n, BASE_FEE_PER_GAS)
	const lookedUp = await getSimulatedTransactionByHashFromInput(ethereum, undefined, { kind: 'simulated', value: preparedInput }, safeCall.signedTransaction.hash)
	assert.equal(lookedUp?.from, GNOSIS_SAFE_ADDRESS)
	assert.equal(lookedUp?.to, CALLED_CONTRACT)
	assert.equal(lookedUp?.value, 7n)
})

// Two stacked Gnosis Safe executions and an ordinary transaction from the Safe. The fake node reports a nonce of 0 for every account.
const createGnosisSafeExecutionsAndOrdinaryGnosisSafeTransactionInput = async () => {
	configureGnosisSafe()
	const firstSafeCall = createGnosisSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const secondSafeCall = createGnosisSafeCall({ value: 8n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const ordinarySafeTransaction = createGnosisSafeCall({ value: 1n, input: new Uint8Array(), gas: 21_000n }, undefined)
	return await prepareGnosisSafeExecutionSimulationInput([createBlock([firstSafeCall, secondSafeCall, ordinarySafeTransaction])], ethereum, 123n, BASE_FEE_PER_GAS)
}

test('counts a simulated Gnosis Safe execution toward its executor\'s nonce, not the Gnosis Safe\'s, in a lookup on the simulation input', async () => {
	const preparedInput = await createGnosisSafeExecutionsAndOrdinaryGnosisSafeTransactionInput()
	assert.deepEqual(preparedInput[0]?.transactions.map((transaction) => transaction.executedTransaction?.nonce), [0n, 1n, undefined], 'the executor sends its calls in order')
	const resolvedInput = { kind: 'simulated' as const, value: preparedInput }
	assert.equal(await getSimulatedTransactionCountFromInput(ethereum, undefined, resolvedInput, GNOSIS_SAFE_ADDRESS), 1n, 'only the Gnosis Safe\'s ordinary transaction raises its nonce')
	assert.equal(await getSimulatedTransactionCountFromInput(ethereum, undefined, resolvedInput, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR), 2n, 'the executor\'s next call follows its execTransaction calls')
})

test('counts a simulated Gnosis Safe execution toward its executor\'s nonce, not the Gnosis Safe\'s, on the simulated stack', async () => {
	const simulationState = await createSimulationState(ethereum, undefined, await createGnosisSafeExecutionsAndOrdinaryGnosisSafeTransactionInput())
	if (simulationState.success === false) throw new Error('Expected the simulation to succeed')
	const resolvedState = toResolvedSimulationState(simulationState)
	assert.equal(await getSimulatedTransactionCount(ethereum, undefined, resolvedState, GNOSIS_SAFE_ADDRESS), 1n, 'a later transaction from the Gnosis Safe gets the nonce after its ordinary transaction only')
	assert.equal(await getSimulatedTransactionCount(ethereum, undefined, resolvedState, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR), 2n)
})

test('counts a Gnosis Safe proposal toward its executor\'s nonce, not the Gnosis Safe\'s', async () => {
	configureGnosisSafe()
	const input = [createBlock([createGnosisSafeProposal({}), createGnosisSafeCall({ value: 1n, input: new Uint8Array(), gas: 21_000n }, undefined)])]
	const preparedInput = { kind: 'simulated' as const, value: await prepareGnosisSafeExecutionSimulationInput(input, ethereum, 123n, BASE_FEE_PER_GAS) }
	assert.equal(await getSimulatedTransactionCountFromInput(ethereum, undefined, preparedInput, GNOSIS_SAFE_ADDRESS), 1n, 'only the Gnosis Safe\'s ordinary transaction raises its nonce')
	assert.equal(await getSimulatedTransactionCountFromInput(ethereum, undefined, preparedInput, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR), 1n, 'the executor sends the proposal\'s execTransaction call')
})

test('repairs a wrong nonce of an ordinary transaction from a Gnosis Safe without counting the Gnosis Safe\'s executions', async () => {
	configureGnosisSafe()
	// The node rejects every call but the executor's for its nonce.
	const nonceRejectingEthereum = new modules.EthereumClientService({
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			if (rpcRequest.method !== 'eth_simulateV1') return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
			const simulationParams = rpcRequest.params?.[0]
			const blockStateCalls = isRecord(simulationParams) && Array.isArray(simulationParams.blockStateCalls) ? simulationParams.blockStateCalls : []
			return modules.serialize(modules.EthSimulateV1Result, blockStateCalls.map((blockStateCall) => ({
				...makeFakeEthSimulateResult(0n, modules.Multicall3ABI, []),
				calls: blockStateCall.calls.map((call: { readonly from: string }) => BigInt(call.from) === GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR
					? { status: 'success' as const, gasUsed: 21_000n, logs: [], returnData: new Uint8Array() }
					: { status: 'failure' as const, gasUsed: 21_000n, returnData: new Uint8Array(), error: { code: -32000, message: 'wrong transaction nonce' } }),
			})))
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	const safeCall = createGnosisSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const staleSafeCall = { ...safeCall, signedTransaction: { ...safeCall.signedTransaction, nonce: 5n } }
	const ordinarySafeTransaction = createGnosisSafeCall({ value: 1n, input: new Uint8Array(), gas: 21_000n }, undefined)
	const wrongNonceTransaction = { ...ordinarySafeTransaction, signedTransaction: { ...ordinarySafeTransaction.signedTransaction, nonce: 9n } }
	const preparedInput = await prepareGnosisSafeExecutionSimulationInput([createBlock([staleSafeCall, wrongNonceTransaction])], nonceRejectingEthereum, 123n, BASE_FEE_PER_GAS)
	const repaired = await getNonceFixedSimulationStateInput(nonceRejectingEthereum, undefined, preparedInput)
	assert.equal(repaired.nonceFixed, true)
	assert.deepEqual(repaired.simulationStateInput[0]?.transactions.map((transaction) => transaction.signedTransaction.nonce), [5n, 0n], 'the ordinary transaction gets the Gnosis Safe\'s nonce from the node, which the execution before it did not raise')
})

for (const { description, message, errorData, returnData } of revertResponses) {
	test(`explains why a simulated Gnosis Safe execution failed without its call's revert reason, reported ${ description }`, () => {
		const failure = { error: { code: 3, message, ...(errorData === undefined ? {} : { data: errorData }) }, returnData }
		const decodedErrorMessage = decodeEthereumError([], failure.error).reason
		assert.match(describeGnosisSafeExecutionFailure({ simulationOptions: GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS }, failure, decodedErrorMessage), /Gnosis Safe's call reverted \(GS013\)/u)
		assert.equal(describeGnosisSafeExecutionFailure({}, failure, decodedErrorMessage), decodedErrorMessage, 'only a simulated Gnosis Safe execution hides its call\'s reason behind GS013')
	})
}

test('keeps the reason of a simulated Gnosis Safe execution that fails for another reason', () => {
	const failure = { error: { code: 3, message: 'execution reverted: GS025', data: '0x' }, returnData: new Uint8Array() }
	assert.equal(describeGnosisSafeExecutionFailure({ simulationOptions: GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS }, failure, 'GS025'), 'GS025')
})

test('charges no gas to a Gnosis Safe whose execution the simulation runs', () => {
	assert.equal(getGasFeePaidByTransactionSender({ gasSpent: 50_000n, realizedGasPrice: 3n, simulationOptions: GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS }), 0n)
	assert.equal(getGasFeePaidByTransactionSender({ gasSpent: 50_000n, realizedGasPrice: 3n }), 150_000n)
})

const createTransferParams = async (fields: Record<string, unknown>) => (await import('../../app/ts/types/JsonRpc-types.js')).SendTransactionParams.parse({
	method: 'eth_sendTransaction',
	params: [{ to: addressString(CALLED_CONTRACT), value: '0x0', data: '0x', ...fields }],
})

function createWebsiteTabConnections(postedMessages: unknown[]) {
	return new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port: createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages),
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
}

// How the recording simulator answers a simulation: as the fake node does, with every call reverting, or with a network error.
type SimulationOutcome = 'fake-node' | 'revert' | 'network-error'

// Like geth's eth_simulateV1 without validation: a call that pays fees must cover its block's base fee, and a call without fees skips the check. Records every simulated call. A simulation with a contract creation gets contractCreationSimulationOutcome, and one with the Safe executor's call the outcome getExecutorCallSimulationOutcome returns when it runs, so a test can change it between opening a confirmation and refreshing it.
function createRecordingSimulator(contractCreationSimulationOutcome: SimulationOutcome = 'fake-node', getExecutorCallSimulationOutcome: () => SimulationOutcome = () => 'fake-node') {
	// A contract creation's call has no recipient.
	const simulatedCalls: { readonly from: bigint, readonly to: bigint | undefined, readonly maxFeePerGas: bigint, readonly baseFeePerGas: bigint }[] = []
	const requestHandler = {
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			if (rpcRequest.method === 'eth_simulateV1') {
				const simulationParams = rpcRequest.params?.[0]
				const blockStateCalls = isRecord(simulationParams) && Array.isArray(simulationParams.blockStateCalls) ? simulationParams.blockStateCalls : []
				let simulatesContractCreation = false
				let simulatesExecutorCall = false
				for (const blockStateCall of blockStateCalls) {
					const baseFeePerGas = BigInt(blockStateCall.blockOverrides?.baseFeePerGas ?? 0n)
					for (const call of blockStateCall.calls) {
						const maxFeePerGas = BigInt(call.maxFeePerGas ?? 0n)
						if (maxFeePerGas !== 0n && maxFeePerGas < baseFeePerGas) throw new Error('max fee per gas less than block base fee')
						const to = call.to === undefined || call.to === null ? undefined : BigInt(call.to)
						if (to === undefined) simulatesContractCreation = true
						if (BigInt(call.from) === GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR) simulatesExecutorCall = true
						simulatedCalls.push({ from: BigInt(call.from), to, maxFeePerGas, baseFeePerGas })
					}
				}
				const outcome = simulatesContractCreation ? contractCreationSimulationOutcome : simulatesExecutorCall ? getExecutorCallSimulationOutcome() : 'fake-node'
				if (outcome === 'network-error') throw new Error('fetch failed')
				if (outcome === 'revert') {
					return modules.serialize(modules.EthSimulateV1Result, blockStateCalls.map((blockStateCall) => ({
						...makeFakeEthSimulateResult(0n, modules.Multicall3ABI, []),
						calls: blockStateCall.calls.map(() => ({ status: 'failure' as const, gasUsed: 21_000n, returnData: new Uint8Array(), error: { code: 3, message: 'execution reverted' } })),
					})))
				}
			}
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}
	const recordingEthereum = new modules.EthereumClientService(requestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
	return { simulatedCalls, ethereum: recordingEthereum, tokenPriceService: new modules.TokenPriceService(recordingEthereum, 60_000) }
}

async function openSimulationModeConfirmation(simulator: ReturnType<typeof createRecordingSimulator>, selectedActiveAddress: bigint, transactionParams: SendTransactionParams, websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>) {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry()])
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: selectedActiveAddress })
	assert.deepEqual(await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{ interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, method: transactionParams.method, params: transactionParams.params },
		{ kind: 'transaction', parameters: transactionParams },
		true,
		selectedActiveAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	)), { type: 'doNotReply' })
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error(`Expected a simulated transaction, got ${ pending?.transactionOrMessageCreationStatus }`)
	return pending
}

test('simulates a configured Gnosis Safe\'s transaction in simulation mode as the Gnosis Safe executing it, through refresh and the stack', async () => {
	configureGnosisSafe()
	const simulator = createRecordingSimulator()
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const pending = await openSimulationModeConfirmation(simulator, GNOSIS_SAFE_ADDRESS, await createTransferParams({}), websiteTabConnections)

	assert.deepEqual(pending.safeFlow, { kind: 'simulationModeSafeExecution' }, 'simulation mode stacks the transaction instead of proposing it to the Gnosis Safe')
	assert.equal(pending.transactionToSimulate.transaction.from, GNOSIS_SAFE_ADDRESS)
	assert.equal(pending.transactionToSimulate.transaction.maxFeePerGas, 0n, 'the Gnosis Safe pays no fees')
	assert.deepEqual(pending.transactionToSimulate.simulationOptions, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	if (pending.popupVisualisation.statusCode !== 'success') throw new Error(`Gnosis Safe execution simulation failed: ${ pending.popupVisualisation.data.error.message }`)
	const simulatedSafeCall = pending.popupVisualisation.data.simulationState.simulationStateInput.at(-1)?.transactions.at(-1)
	assert.equal(simulatedSafeCall?.signedTransaction.maxFeePerGas, 0n, 'the base-fee repair leaves the Gnosis Safe\'s own call without fees')
	assert.equal(simulatedSafeCall?.executedTransaction?.from, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR)
	const executorCalls = simulator.simulatedCalls.filter((call) => call.from === GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR)
	assert.ok(executorCalls.length > 0, 'the node runs the executor\'s call')
	for (const call of executorCalls) {
		assert.equal(call.to, GNOSIS_SAFE_ADDRESS)
		assert.ok(call.baseFeePerGas > 0n, 'in a block with the real base fee')
		assert.ok(call.maxFeePerGas >= call.baseFeePerGas)
	}
	assert.equal(simulator.simulatedCalls.some((call) => call.from === GNOSIS_SAFE_ADDRESS), false, 'the Gnosis Safe never sends a transaction itself, not even to estimate gas')
	const visualizedTransaction = pending.popupVisualisation.data.visualizedSimulationState.visualizedBlocks.at(-1)?.simulatedAndVisualizedTransactions.at(-1)
	assert.deepEqual(visualizedTransaction?.simulationOptions, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	if (refreshedPending?.type !== 'Transaction' || refreshedPending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected the refreshed transaction to stay simulated')
	assert.deepEqual(refreshedPending.transactionToSimulate.simulationOptions, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS, 'a refresh forms the transaction as a Gnosis Safe execution again')

	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createAcceptConfirmation())
	const [stackedOperation] = (await modules.getInterceptorTransactionStack()).operations
	if (stackedOperation?.type !== 'Transaction') throw new Error('Expected the Gnosis Safe transaction on the simulation stack')
	assert.deepEqual(stackedOperation.preSimulationTransaction.simulationOptions, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const { getCurrentSimulationInput, prepareSimulationInputForRpc } = await import('../../app/ts/background/simulationUpdating.js')
	const stackInput = await getCurrentSimulationInput()
	assert.equal(stackInput.at(-1)?.simulateWithZeroBaseFee, false)
	const preparedStackInput = await prepareSimulationInputForRpc(stackInput, simulator.ethereum)
	assert.equal(preparedStackInput.at(-1)?.transactions.at(-1)?.executedTransaction?.from, GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR, 'the stacked transaction keeps running through the Gnosis Safe')
	const { requestInterceptorSimulationInput } = await import('../../app/ts/background/popupMessageHandlers.js')
	const simulationExport = await requestInterceptorSimulationInput(simulator.ethereum)
	if (!simulationExport.ok) throw new Error(simulationExport.message)
	const exportedRequest: unknown = JSON.parse(simulationExport.ethSimulateV1InputString)
	const exportedSimulation = isRecord(exportedRequest) && isRecord(exportedRequest.eth_simulateV1) && Array.isArray(exportedRequest.eth_simulateV1.params) ? exportedRequest.eth_simulateV1.params[0] : undefined
	const exportedCalls = isRecord(exportedSimulation) && Array.isArray(exportedSimulation.blockStateCalls) ? exportedSimulation.blockStateCalls.flatMap((blockStateCall) => blockStateCall.calls) : []
	assert.deepEqual(exportedCalls.map((call) => BigInt(call.from)), [GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR], 'the exported request runs the stacked Gnosis Safe execution as the preview does')
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
})

const GNOSIS_SAFE_CALL_WEBSITE = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }

// Forms a transaction the way the confirmation does and stacks it as accepting it does, through getSignedTransactionForSimulation.
async function stackFormedTransaction(simulator: ReturnType<typeof createRecordingSimulator>, transactionParams: SendTransactionParams, transactionIdentifier: bigint, gasPayment: 'simulated-safe-executor' | 'transaction-sender') {
	const formed = await modules.formEthSendTransaction(simulator.ethereum, undefined, GNOSIS_SAFE_ADDRESS, GNOSIS_SAFE_CALL_WEBSITE, transactionParams, created, transactionIdentifier, true, gasPayment)
	if (!formed.success) throw new Error(`Forming the transaction failed: ${ formed.error.message }`)
	const preSimulationTransaction: PreSimulationTransaction = {
		signedTransaction: getSignedTransactionForSimulation(formed),
		website: formed.website,
		created: formed.created,
		originalRequestParameters: formed.originalRequestParameters,
		transactionIdentifier,
		...(formed.simulationOptions === undefined ? {} : { simulationOptions: formed.simulationOptions }),
	}
	await modules.updateInterceptorTransactionStack((stack) => ({ operations: [...stack.operations, { type: 'Transaction', preSimulationTransaction }] }))
	return preSimulationTransaction
}

async function startGnosisSafeExecutionStack() {
	configureGnosisSafe()
	const simulator = createRecordingSimulator()
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: GNOSIS_SAFE_ADDRESS })
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	return simulator
}

// Checks that every stacked transaction is found by its own hash, both as a transaction and as a receipt.
async function assertEachFoundByOwnHash(simulator: ReturnType<typeof createRecordingSimulator>, stackedTransactions: readonly PreSimulationTransaction[]) {
	assert.equal(new Set(stackedTransactions.map((transaction) => transaction.signedTransaction.hash)).size, stackedTransactions.length, 'every stacked transaction has its own hash')
	const { getCurrentSimulationInput, prepareSimulationInputForRpc } = await import('../../app/ts/background/simulationUpdating.js')
	const preparedInput = await prepareSimulationInputForRpc(await getCurrentSimulationInput(), simulator.ethereum)
	const executionState = await createExecutionSimulationState(simulator.ethereum, undefined, preparedInput)
	for (const stacked of stackedTransactions) {
		const lookedUp = await getSimulatedTransactionByHashFromInput(simulator.ethereum, undefined, toResolvedSimulationInput(preparedInput), stacked.signedTransaction.hash)
		assert.equal(lookedUp?.nonce, stacked.signedTransaction.nonce)
		assert.equal(lookedUp?.s, stacked.signedTransaction.s)
		const receipt = await getSimulatedTransactionReceipt(simulator.ethereum, undefined, toResolvedExecutionSimulationState(executionState), stacked.signedTransaction.hash)
		assert.equal(receipt?.transactionHash, stacked.signedTransaction.hash)
		assert.equal(receipt?.transactionIndex, BigInt(stackedTransactions.indexOf(stacked)), 'the receipt is the transaction\'s own')
	}
	return preparedInput
}

test('gives identical stacked Gnosis Safe executions distinct nonce fields and hashes without raising the Gnosis Safe\'s account nonce', async () => {
	const simulator = await startGnosisSafeExecutionStack()
	const transactionParams = await createTransferParams({})
	const first = await stackFormedTransaction(simulator, transactionParams, 1n, 'simulated-safe-executor')
	const second = await stackFormedTransaction(simulator, transactionParams, 2n, 'simulated-safe-executor')
	assert.deepEqual(second.simulationOptions, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	assert.deepEqual([first.signedTransaction.nonce, second.signedTransaction.nonce], [0n, 1n], 'the nonce field is a display sequence of the Gnosis Safe\'s executions')
	const preparedInput = await assertEachFoundByOwnHash(simulator, [first, second])
	assert.equal(await getSimulatedTransactionCountFromInput(simulator.ethereum, undefined, toResolvedSimulationInput(preparedInput), GNOSIS_SAFE_ADDRESS), 0n, 'the Gnosis Safe\'s account nonce stays the node\'s')
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
})

test('keeps the hashes of identical Gnosis Safe executions distinct after one is removed and another appended', async () => {
	const simulator = await startGnosisSafeExecutionStack()
	const transactionParams = await createTransferParams({})
	await stackFormedTransaction(simulator, transactionParams, 1n, 'simulated-safe-executor')
	await stackFormedTransaction(simulator, transactionParams, 2n, 'simulated-safe-executor')
	await (await import('../../app/ts/background/popupMessageHandlers.js')).removeTransactionOrSignedMessage(simulator.ethereum, simulator.tokenPriceService, { method: 'popup_removeTransactionOrSignedMessage', data: { type: 'Transaction', transactionIdentifier: 1n } })
	const [survivorOperation] = (await modules.getInterceptorTransactionStack()).operations
	if (survivorOperation?.type !== 'Transaction') throw new Error('Expected the surviving Gnosis Safe execution')
	const survivor = survivorOperation.preSimulationTransaction
	assert.equal(survivor.signedTransaction.nonce, 1n, 'removal does not renumber a Gnosis Safe execution, whose hash the page already has')
	const appended = await stackFormedTransaction(simulator, transactionParams, 3n, 'simulated-safe-executor')
	assert.equal(appended.signedTransaction.nonce, 2n)
	await assertEachFoundByOwnHash(simulator, [survivor, appended])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
})

test('keeps a Gnosis Safe execution\'s hash apart from an ordinary transaction from the Gnosis Safe with the same fields, fees and nonce', async () => {
	const simulator = await startGnosisSafeExecutionStack()
	const transactionParams = await createTransferParams({ gas: '0x5208', maxFeePerGas: '0x0', maxPriorityFeePerGas: '0x0' })
	const gnosisSafeExecution = await stackFormedTransaction(simulator, transactionParams, 1n, 'simulated-safe-executor')
	const ordinaryTransaction = await stackFormedTransaction(simulator, transactionParams, 2n, 'transaction-sender')
	assert.equal(ordinaryTransaction.simulationOptions, undefined)
	const { hash: _safeExecutionHash, s: _safeExecutionS, ...safeExecutionFields } = gnosisSafeExecution.signedTransaction
	const { hash: _ordinaryHash, s: _ordinaryS, ...ordinaryFields } = ordinaryTransaction.signedTransaction
	assert.deepEqual(safeExecutionFields, ordinaryFields, 'the two transactions differ only in their mock signature')
	await assertEachFoundByOwnHash(simulator, [gnosisSafeExecution, ordinaryTransaction])
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
})

test('simulates a configured Gnosis Safe that the page names as the sender, while another account is active, as an ordinary transaction from the Gnosis Safe, through refresh', async () => {
	configureGnosisSafe()
	const simulator = createRecordingSimulator()
	const pending = await openSimulationModeConfirmation(simulator, ORDINARY_ACCOUNT, await createTransferParams({ from: addressString(GNOSIS_SAFE_ADDRESS) }), createWebsiteTabConnections([]))

	assert.deepEqual(pending.safeFlow, { kind: 'ordinary' }, 'owner approval is only assumed for the Gnosis Safe the user is simulating as')
	assert.equal(pending.transactionToSimulate.transaction.from, GNOSIS_SAFE_ADDRESS, 'the page\'s sender is simulated as before')
	assert.equal(pending.transactionToSimulate.simulationOptions?.executeThroughSafe, undefined)
	assert.equal(simulator.simulatedCalls.some((call) => call.from === GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR), false, 'no executor calls the Gnosis Safe\'s execTransaction')

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	if (refreshedPending?.type !== 'Transaction' || refreshedPending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected the refreshed transaction to stay simulated')
	assert.equal(refreshedPending.transactionToSimulate.simulationOptions?.executeThroughSafe, undefined, 'a refresh keeps the ordinary simulation')
	assert.equal(simulator.simulatedCalls.some((call) => call.from === GNOSIS_SAFE_EXECUTION_SIMULATION_EXECUTOR), false)
})

const isSimulationModeGnosisSafeExecution = async (selectedActiveAddress: bigint, transactionParams: SendTransactionParams | SendRawTransactionParams) => {
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry()])
	const preparation = await prepareGnosisSafeTransactionConfirmation(ethereum, { kind: 'transaction', parameters: transactionParams }, true, selectedActiveAddress, undefined)
	return preparation.gasPayment === 'simulated-safe-executor'
}

const simulationModeCases = [
	{ description: 'the active Gnosis Safe sends without naming a sender', selectedActiveAddress: GNOSIS_SAFE_ADDRESS, createParams: async () => await createTransferParams({}), expected: true },
	{ description: 'the page names the active Gnosis Safe as the sender', selectedActiveAddress: GNOSIS_SAFE_ADDRESS, createParams: async () => await createTransferParams({ from: addressString(GNOSIS_SAFE_ADDRESS) }), expected: true },
	{ description: 'the page names a configured Gnosis Safe that is not the active address', selectedActiveAddress: ORDINARY_ACCOUNT, createParams: async () => await createTransferParams({ from: addressString(GNOSIS_SAFE_ADDRESS) }), expected: false },
	{ description: 'the page names another sender while the Gnosis Safe is active', selectedActiveAddress: GNOSIS_SAFE_ADDRESS, createParams: async () => await createTransferParams({ from: addressString(ORDINARY_ACCOUNT) }), expected: false },
	{ description: 'the Gnosis Safe\'s request carries EIP-7702 authorizations', selectedActiveAddress: GNOSIS_SAFE_ADDRESS, createParams: async () => await createTransferParams({ authorizationList: [{ chainId: '0x1', address: addressString(CALLED_CONTRACT), nonce: '0x0' }] }), expected: false },
	{ description: 'the Gnosis Safe\'s request creates a contract', selectedActiveAddress: GNOSIS_SAFE_ADDRESS, createParams: async () => (await import('../../app/ts/types/JsonRpc-types.js')).SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [{ value: '0x0', data: '0x00' }] }), expected: false },
	{ description: 'the request is a raw signed transaction', selectedActiveAddress: GNOSIS_SAFE_ADDRESS, createParams: async (): Promise<SendRawTransactionParams> => ({ method: 'eth_sendRawTransaction', params: [new Uint8Array([1])] }), expected: false },
]

for (const { description, selectedActiveAddress, createParams, expected } of simulationModeCases) {
	test(`${ expected ? 'runs' : 'does not run' } a simulation-mode transaction through the Gnosis Safe when ${ description }`, async () => {
		assert.equal(await isSimulationModeGnosisSafeExecution(selectedActiveAddress, await createParams()), expected)
	})
}

test('keeps the ordinary simulation for a configured Gnosis Safe whose version Interceptor does not support', async () => {
	fakeGnosisSafeContract.version = '1.2.0'
	assert.equal(await withSilencedConsole(async () => await isSimulationModeGnosisSafeExecution(GNOSIS_SAFE_ADDRESS, await createTransferParams({}))), false)
})

async function importStackedTransaction(transaction: PreSimulationTransaction) {
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	const { importSimulationStack } = await import('../../app/ts/background/popupMessageHandlers.js')
	const eth_simulateV1 = await ethereum.ethSimulateV1Input([], 123n, undefined)
	// Storing the stack comes before visualizing it, whose result doesn't matter here.
	await withSilencedConsole(async () => await importSimulationStack(ethereum, new modules.TokenPriceService(ethereum, 60_000), {
		method: 'popup_importSimulationStack',
		data: InterceptorSimulationExport.parse(InterceptorSimulationExport.serialize({ name: 'Interceptor Simulation Export', version: '1.0.0', eth_simulateV1, interceptorSimulateStack: { operations: [{ type: 'Transaction', preSimulationTransaction: transaction }] } })),
	}))
	const [operation] = (await modules.getInterceptorTransactionStack()).operations
	if (operation?.type !== 'Transaction') throw new Error('Expected the imported transaction on the simulation stack')
	return operation.preSimulationTransaction.simulationOptions
}

const ORDINARY_SIMULATION_OPTIONS: TransactionSimulationOptions = { requiredChainId: fakeRpcNetwork.chainId }
const importCases = [
	{ description: 'drops imported Gnosis Safe approval assumptions at the admission boundary', imported: GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS },
	{ description: 'keeps an imported transaction of the active Gnosis Safe that does not ask to run through the Gnosis Safe as an ordinary transaction', imported: ORDINARY_SIMULATION_OPTIONS },
]

for (const { description, imported } of importCases) {
	test(description, async () => {
		await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry()])
		await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: GNOSIS_SAFE_ADDRESS })
		assert.deepEqual(await importStackedTransaction(createGnosisSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, imported)), ORDINARY_SIMULATION_OPTIONS)
	})
}


test('an imported Gnosis Safe call runs ordinarily and stays out of signing-mode simulation inputs', async () => {
	configureGnosisSafe()
	await modules.updateUserAddressBookEntries(() => [createGnosisSafeAddressBookEntry()])
	const { changeSimulationMode } = await import('../../app/ts/background/settings.js')
	const { getCurrentSimulationInput, prepareGnosisSafeExecutionsForRpc } = await import('../../app/ts/background/simulationUpdating.js')
	await changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: GNOSIS_SAFE_ADDRESS })
	await importStackedTransaction(createGnosisSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS))
	const hypotheticalInput = await getCurrentSimulationInput([])
	assert.equal(hypotheticalInput.flatMap((block) => block.transactions).length, 1)
	const preparedHypothetical = await prepareGnosisSafeExecutionsForRpc(hypotheticalInput, ethereum)
	assert.equal(preparedHypothetical.at(-1)?.transactions.at(-1)?.executedTransaction, undefined, 'imported calls cannot assume Gnosis Safe owner approvals')

	for (const activeSigningSafeAddress of [undefined, GNOSIS_SAFE_ADDRESS]) {
		await changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork, activeSigningSafeAddress })
		const signingInput = await getCurrentSimulationInput([])
		assert.deepEqual(signingInput, [], 'neither EOA nor Gnosis Safe signing uses imported hypothetical transactions as base state')
		assert.deepEqual(await prepareGnosisSafeExecutionsForRpc(signingInput, ethereum), [])
	}
	await changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: GNOSIS_SAFE_ADDRESS })
	assert.equal((await getCurrentSimulationInput([])).flatMap((block) => block.transactions).length, 1, 'switching back preserves the imported scenario')
})

for (const shape of ['access-list transaction', 'contract creation', 'EOA sender']) test(`import admission removes Gnosis Safe execution authority from an ${ shape } before RPC preparation`, async () => {
	const { admitImportedSimulationStackOperations } = await import('../../app/ts/background/importedSimulationStack.js')
	const { prepareGnosisSafeExecutionsForRpc } = await import('../../app/ts/background/simulationUpdating.js')
	const transaction = createGnosisSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, GNOSIS_SAFE_EXECUTION_SIMULATION_OPTIONS)
	const signed = transaction.signedTransaction
	if (signed.type !== '1559') throw new Error('Expected the EIP-1559 fixture')
	const signedTransaction: PreSimulationTransaction['signedTransaction'] = shape === 'access-list transaction'
		? { ...signed, type: '2930', gasPrice: 1n }
		: shape === 'contract creation' ? { ...signed, to: null } : { ...signed, from: ORDINARY_ACCOUNT }
	// Decode the untrusted wire shape first, exactly as import does; all three shapes are valid ordinary transactions but invalid Safe execution claims.
	const decoded = InterceptorTransactionStack.parse(InterceptorTransactionStack.serialize({ operations: [{ type: 'Transaction', preSimulationTransaction: { ...transaction, signedTransaction } }] }))
	const [decodedOperation] = decoded.operations
	if (decodedOperation?.type !== 'Transaction') throw new Error('Expected a decoded transaction')
	const decodedTransaction = decodedOperation.preSimulationTransaction.signedTransaction
	const admission = admitImportedSimulationStackOperations(decoded.operations)
	if (!admission.admitted) throw new Error(admission.rejection)
	const [operation] = admission.operations
	if (operation?.type !== 'Transaction') throw new Error('Expected an admitted ordinary transaction')
	assert.deepEqual(operation.preSimulationTransaction.signedTransaction, decodedTransaction)
	assert.deepEqual(operation.preSimulationTransaction.simulationOptions, ORDINARY_SIMULATION_OPTIONS)
	const prepared = await prepareGnosisSafeExecutionsForRpc([{
		stateOverrides: {}, transactions: [operation.preSimulationTransaction], signedMessages: [],
		blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 0n, deltaUnit: 'Seconds' }, simulateWithZeroBaseFee: false,
	}], ethereum)
	assert.equal(prepared[0]?.transactions[0]?.executedTransaction, undefined)
	assert.deepEqual(prepared[0]?.transactions[0]?.signedTransaction, decodedTransaction)
})
