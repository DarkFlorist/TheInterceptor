import * as assert from 'assert'
import { test } from 'bun:test'
import { keccak_256 } from '@noble/hashes/sha3'
import type { SendRawTransactionParams, SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import type { SafeTx } from '../../app/ts/types/personal-message-definitions.js'
import { createSafeTxFromMessage } from '../../app/ts/safe/safeCore.js'
import { decodeSafeExecution } from '../../app/ts/safe/safeExecution.js'
import { InterceptorTransactionStack, PreSimulationTransaction, type SimulationInputTransaction, type SimulationStateInput, type TransactionSimulationOptions } from '../../app/ts/types/visualizer-types.js'
import { EthereumSendableSignedTransaction } from '../../app/ts/types/wire-types.js'
import { estimateSafeExecutionGas, prepareSafeExecutionSimulationInput, SAFE_EXECUTION_SIMULATION_EXECUTOR } from '../../app/ts/safe/safeExecutionSimulation.js'
import { describeSafeExecutionFailure } from '../../app/ts/safe/safeExecutionFailure.js'
import { prepareSafeTransactionConfirmation } from '../../app/ts/background/safeTransactionConfirmation.js'
import { getSimulatedTransactionByHashFromInput } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { encodeFunctionCall } from '../../app/ts/utils/abiRuntime.js'
import { decodeEthereumError } from '../../app/ts/utils/errorDecoding.js'
import { dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { getGasFeePaidByTransactionSender } from '../../app/ts/utils/transactionGasAccounting.js'
import { activeAddress, addressString, created, pendingTransaction, createSafeAddressBookEntry, createSafeTx, createWebsitePort, ethereum, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, hexToBytes, isRecord, makeFakeEthSimulateResult, modules, recipientAddress, SAFE_EXECUTION_ABI, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'

// createSafeAddressBookEntry configures the Safe at activeAddress, the address the fake RPC gives code.
const SAFE_ADDRESS = activeAddress
const ORDINARY_ACCOUNT = recipientAddress
const CALLED_CONTRACT = 0x6666666666666666666666666666666666666666n
const OWNERS = [0x3000000000000000000000000000000000000003n, 0x1000000000000000000000000000000000000001n, 0x2000000000000000000000000000000000000002n]
const SORTED_OWNERS = [0x1000000000000000000000000000000000000001n, 0x2000000000000000000000000000000000000002n, 0x3000000000000000000000000000000000000003n]
const SAFE_EXECUTION_SIMULATION_OPTIONS: TransactionSimulationOptions = { requiredChainId: fakeRpcNetwork.chainId, executeThroughSafe: true }
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

function createSafeCall(fields: { readonly value: bigint, readonly input: Uint8Array, readonly gas: bigint }, simulationOptions: PreSimulationTransaction['simulationOptions']): PreSimulationTransaction {
	return {
		signedTransaction: {
			type: '1559',
			from: SAFE_ADDRESS,
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
		originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: SAFE_ADDRESS, to: CALLED_CONTRACT, value: fields.value, input: fields.input }] },
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

const getSafeTxHashAt = (transaction: PreSimulationTransaction, nonce: bigint) => {
	const { to, value, input } = transaction.signedTransaction
	if (to === null) throw new Error('Expected a call')
	return BigInt(getSafeTxHash(createSafeTx(fakeRpcNetwork.chainId, SAFE_ADDRESS, { to, value, input }, nonce)))
}

const configureSafe = () => {
	fakeSafeContract.owners = OWNERS
	fakeSafeContract.threshold = 2n
	fakeSafeContract.nonce = 5n
}

test('runs a Gnosis Safe execution as an executor calling execTransaction with real fees', async () => {
	configureSafe()
	const safeCall = createSafeCall({ value: 7n, input: Uint8Array.from([0x12, 0x34]), gas: 63_000n }, SAFE_EXECUTION_SIMULATION_OPTIONS)
	const ordinaryTransaction = createSafeCall({ value: 1n, input: new Uint8Array(), gas: 21_000n }, undefined)
	const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([safeCall, ordinaryTransaction])], ethereum, 123n, BASE_FEE_PER_GAS)
	const [preparedSafeCall, preparedOrdinaryTransaction] = preparedBlock?.transactions ?? []
	assert.equal(preparedOrdinaryTransaction?.executedTransaction, undefined, 'an ordinary transaction runs as it is')
	assert.deepEqual(preparedSafeCall?.signedTransaction, safeCall.signedTransaction, 'the Safe\'s call stays what the dialog shows and the protectors check')

	const executed = preparedSafeCall?.executedTransaction
	if (executed?.type !== '1559') throw new Error('Expected the executor\'s EIP-1559 call')
	assert.equal(executed.from, SAFE_EXECUTION_SIMULATION_EXECUTOR)
	assert.equal(executed.to, SAFE_ADDRESS)
	assert.equal(executed.value, 0n)
	assert.equal(executed.nonce, 0n)
	assert.equal(executed.maxPriorityFeePerGas, 10n ** 8n)
	assert.equal(executed.maxFeePerGas, EXECUTOR_MAX_FEE_PER_GAS)
	assert.ok(executed.maxFeePerGas >= BASE_FEE_PER_GAS, 'the executor pays at least the base fee')
	assert.equal(executed.gas, 64_000n + 1_000_000n)
	// Every owner signs, sorted, with pre-validated signatures, so an execution passes whatever threshold the Safe has by then.
	const expectedSignatures = `0x${ SORTED_OWNERS.map(prevalidatedSignature).join('') }`
	assert.equal(dataStringWith0xStart(executed.input), encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(CALLED_CONTRACT), 7n, '0x1234', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), expectedSignatures]))

	const safeTxHash = getSafeTxHashAt(safeCall, 5n)
	assert.deepEqual(preparedBlock?.stateOverrides, {
		[addressString(SAFE_ADDRESS)]: { stateDiff: Object.fromEntries(SORTED_OWNERS.map((owner) => [approvedHashSlot(owner, safeTxHash), 1n])) },
		[addressString(SAFE_EXECUTION_SIMULATION_EXECUTOR)]: { balance: executed.gas * EXECUTOR_MAX_FEE_PER_GAS },
	})
})

test('approves a later execution of the same Gnosis Safe at every nonce the Safe can have by then', async () => {
	configureSafe()
	const firstCall = createSafeCall({ value: 1n, input: new Uint8Array(), gas: 63_000n }, SAFE_EXECUTION_SIMULATION_OPTIONS)
	const secondCall = createSafeCall({ value: 2n, input: new Uint8Array(), gas: 126_000n }, SAFE_EXECUTION_SIMULATION_OPTIONS)
	const makeRichOverride = { [addressString(SAFE_ADDRESS)]: { balance: 10n ** 18n } }
	const [firstBlock, secondBlock] = await prepareSafeExecutionSimulationInput([createBlock([firstCall], makeRichOverride), createBlock([secondCall])], ethereum, 123n, BASE_FEE_PER_GAS)
	const firstExecuted = firstBlock?.transactions[0]?.executedTransaction
	const secondExecuted = secondBlock?.transactions[0]?.executedTransaction
	if (firstExecuted === undefined || secondExecuted === undefined) throw new Error('Expected both Safe executions to be prepared')
	assert.equal(secondExecuted.nonce, 1n, 'the executor sends its calls in order')
	assert.deepEqual(secondBlock?.stateOverrides, {}, 'every override is set at the start of the simulation')

	const approvedSlots = [
		...[5n].map((nonce) => getSafeTxHashAt(firstCall, nonce)),
		// The first execution raises the Safe's nonce to 6 if it succeeds.
		...[5n, 6n].map((nonce) => getSafeTxHashAt(secondCall, nonce)),
	].flatMap((safeTxHash) => SORTED_OWNERS.map((owner) => approvedHashSlot(owner, safeTxHash)))
	assert.deepEqual(firstBlock?.stateOverrides, {
		[addressString(SAFE_ADDRESS)]: { balance: 10n ** 18n, stateDiff: Object.fromEntries(approvedSlots.map((slot) => [slot, 1n])) },
		[addressString(SAFE_EXECUTION_SIMULATION_EXECUTOR)]: { balance: (firstExecuted.gas + secondExecuted.gas) * EXECUTOR_MAX_FEE_PER_GAS },
	})
})

test('counts a stacked execTransaction call to the Gnosis Safe among the executions that raise its nonce', async () => {
	configureSafe()
	const directExecution = { ...createSafeCall({ value: 0n, input: hexToBytes(encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(CALLED_CONTRACT), 0n, '0x', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), '0x'])), gas: 100_000n }, undefined) }
	const directExecutionToSafe = { ...directExecution, signedTransaction: { ...directExecution.signedTransaction, from: ORDINARY_ACCOUNT, to: SAFE_ADDRESS } }
	const safeCall = createSafeCall({ value: 2n, input: new Uint8Array(), gas: 63_000n }, SAFE_EXECUTION_SIMULATION_OPTIONS)
	const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([directExecutionToSafe, safeCall])], ethereum, 123n, BASE_FEE_PER_GAS)
	const approvedSlots = [5n, 6n].flatMap((nonce) => SORTED_OWNERS.map((owner) => approvedHashSlot(owner, getSafeTxHashAt(safeCall, nonce))))
	assert.deepEqual(Object.keys(preparedBlock?.stateOverrides[addressString(SAFE_ADDRESS)]?.stateDiff ?? {}).sort(), approvedSlots.sort())
	assert.equal(preparedBlock?.transactions[0]?.executedTransaction, undefined, 'the stacked execTransaction call runs as it is')
})

test('estimates a Gnosis Safe\'s call as its executor\'s execTransaction call', async () => {
	configureSafe()
	const simulator = createRecordingSimulator()
	const safeCall = createSafeCall({ value: 7n, input: new Uint8Array(), gas: 0n }, SAFE_EXECUTION_SIMULATION_OPTIONS)
	const { gas: _gas, hash: _hash, r: _r, s: _s, yParity: _yParity, ...safeCallWithoutGas } = safeCall.signedTransaction
	const estimate = await estimateSafeExecutionGas(simulator.ethereum, undefined, [], safeCallWithoutGas, { website: safeCall.website, created: safeCall.created, originalRequestParameters: safeCall.originalRequestParameters, transactionIdentifier: safeCall.transactionIdentifier })
	if ('error' in estimate) throw new Error(estimate.error.message)
	assert.ok(estimate.gas > 0n)
	assert.ok(simulator.simulatedCalls.length > 0)
	assert.ok(simulator.simulatedCalls.every((call) => call.from === SAFE_EXECUTION_SIMULATION_EXECUTOR && call.to === SAFE_ADDRESS && call.baseFeePerGas > 0n), 'every estimate run is the executor\'s call in a block with the real base fee')
})


for (const { description, message, errorData, returnData } of revertResponses) {
	test(`explains a Gnosis Safe's call that reverts while its gas is estimated, reported ${ description }`, async () => {
		configureSafe()
		const revertingRequestHandler = {
			rpcUrl: fakeRpcNetwork.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
				if (rpcRequest.method !== 'eth_simulateV1') return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
				const simulationParams = rpcRequest.params?.[0]
				const blockStateCalls = isRecord(simulationParams) && Array.isArray(simulationParams.blockStateCalls) ? simulationParams.blockStateCalls : []
				return modules.serialize(modules.EthSimulateV1Result, blockStateCalls.map((blockStateCall) => ({
					...makeFakeEthSimulateResult(0n, modules.Multicall3ABI, 0),
					calls: blockStateCall.calls.map(() => ({ status: 'failure', gasUsed: 75_370n, returnData, error: { code: 3, message, ...(errorData === undefined ? {} : { data: errorData }) } })),
				})))
			},
		}
		const revertingEthereum = new modules.EthereumClientService(revertingRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
		const safeCall = createSafeCall({ value: 7n, input: new Uint8Array(), gas: 0n }, SAFE_EXECUTION_SIMULATION_OPTIONS)
		const { gas: _gas, hash: _hash, r: _r, s: _s, yParity: _yParity, ...safeCallWithoutGas } = safeCall.signedTransaction
		const estimate = await estimateSafeExecutionGas(revertingEthereum, undefined, [], safeCallWithoutGas, { website: safeCall.website, created: safeCall.created, originalRequestParameters: safeCall.originalRequestParameters, transactionIdentifier: safeCall.transactionIdentifier })
		if (!('error' in estimate)) throw new Error('Expected the estimate to fail')
		assert.match(estimate.error.message, /Gnosis Safe's call reverted \(GS013\)/u)
	})
}

test('counts a Gnosis Safe execution whose own call executes a Safe among the executions that raise that Safe\'s nonce', async () => {
	configureSafe()
	// A Safe execution can call a Safe's execTransaction, here its own, which raises that Safe's nonce once more.
	const nestedExecution = createSafeCall({ value: 0n, input: hexToBytes(encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(CALLED_CONTRACT), 0n, '0x', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), '0x'])), gas: 100_000n }, SAFE_EXECUTION_SIMULATION_OPTIONS)
	const nestedExecutionOfSafe = { ...nestedExecution, signedTransaction: { ...nestedExecution.signedTransaction, to: SAFE_ADDRESS } }
	const safeCall = createSafeCall({ value: 2n, input: new Uint8Array(), gas: 63_000n }, SAFE_EXECUTION_SIMULATION_OPTIONS)
	const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([nestedExecutionOfSafe, safeCall])], ethereum, 123n, BASE_FEE_PER_GAS)
	const approvedSlotsOfSafeCall = [5n, 6n, 7n].flatMap((nonce) => SORTED_OWNERS.map((owner) => approvedHashSlot(owner, getSafeTxHashAt(safeCall, nonce))))
	const stateDiff = preparedBlock?.stateOverrides[addressString(SAFE_ADDRESS)]?.stateDiff ?? {}
	assert.ok(approvedSlotsOfSafeCall.every((slot) => stateDiff[slot] === 1n), 'the later execution is approved at the nonce after both executions of the first transaction')
})

// A Safe proposal of the signing-mode stack: the Safe's call is shown, and its SafeTx is what the Safe executes.
function createSafeProposal(message: Partial<SafeTx['message']>): PreSimulationTransaction {
	const safeTx = { ...createSafeTx(fakeRpcNetwork.chainId, SAFE_ADDRESS, { to: CALLED_CONTRACT, value: 3n, input: Uint8Array.from([0x56]) }, 4n), }
	const proposalSafeTx = { ...safeTx, message: { ...safeTx.message, ...message } }
	const shownCall = createSafeCall({ value: 3n, input: Uint8Array.from([0x56]), gas: 63_000n }, undefined)
	return {
		...shownCall,
		simulationOptions: { requiredChainId: fakeRpcNetwork.chainId },
		safeTransaction: { safeTx: proposalSafeTx, safeTxHash: BigInt(getSafeTxHash(proposalSafeTx)), created, websiteOrigin: 'https://example.com', transactionIdentifier: 3n, signatures: [] },
	}
}

test('runs a Safe proposal as the executor executing its SafeTx, refund fields included, at the Safe\'s nonce', async () => {
	configureSafe()
	const proposal = createSafeProposal({ safeTxGas: 7n, baseGas: 9n, gasPrice: 5n, gasToken: 0n, refundReceiver: ORDINARY_ACCOUNT })
	const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([proposal])], ethereum, 123n, BASE_FEE_PER_GAS)
	const executed = preparedBlock?.transactions[0]?.executedTransaction
	if (executed === undefined) throw new Error('Expected the proposal to run through the Safe')
	assert.equal(executed.from, SAFE_EXECUTION_SIMULATION_EXECUTOR)
	assert.equal(executed.to, SAFE_ADDRESS)
	const proposalSafeTx = proposal.safeTransaction?.safeTx
	if (proposalSafeTx === undefined) throw new Error('Expected a Safe proposal')
	// The proposal's nonce 4 is signed off-chain; the Safe executes the same SafeTx at its own nonce 5.
	const executedSafeTx = decodeSafeExecution(fakeRpcNetwork.chainId, SAFE_ADDRESS, proposalSafeTx.message.nonce, executed.input).safeTx
	assert.deepEqual(executedSafeTx, proposalSafeTx)
	const safeTxHashAtSafeNonce = BigInt(getSafeTxHash(createSafeTxFromMessage(fakeRpcNetwork.chainId, SAFE_ADDRESS, { ...proposalSafeTx.message, nonce: 5n })))
	assert.deepEqual(preparedBlock?.stateOverrides[addressString(SAFE_ADDRESS)]?.stateDiff, Object.fromEntries(SORTED_OWNERS.map((owner) => [approvedHashSlot(owner, safeTxHashAtSafeNonce), 1n])))
})

test('counts an execTransaction call inside a Safe proposal\'s MultiSend batch among the executions that raise the Safe\'s nonce', async () => {
	configureSafe()
	const { encodeSafeBatch, SAFE_MULTI_SEND_CALL_ONLY } = await import('../../app/ts/safe/safeDelegateCalls.js')
	const selfExecution = hexToBytes(encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(CALLED_CONTRACT), 0n, '0x', 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), '0x']))
	const batch = createSafeProposal({ to: SAFE_MULTI_SEND_CALL_ONLY, value: 0n, operation: 1n, data: encodeSafeBatch([{ to: SAFE_ADDRESS, value: 0n, data: selfExecution }, { to: CALLED_CONTRACT, value: 0n, data: new Uint8Array([1]) }]) })
	const laterProposal = createSafeProposal({ value: 9n })
	const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([batch, laterProposal])], ethereum, 123n, BASE_FEE_PER_GAS)
	const laterSafeTx = laterProposal.safeTransaction?.safeTx
	if (laterSafeTx === undefined) throw new Error('Expected a Safe proposal')
	const stateDiff = preparedBlock?.stateOverrides[addressString(SAFE_ADDRESS)]?.stateDiff ?? {}
	// The batch's own execution and the execution its batch makes raise the nonce from 5 to 7.
	const approvedSlotsOfLaterProposal = [5n, 6n, 7n].flatMap((nonce) => SORTED_OWNERS.map((owner) => approvedHashSlot(owner, BigInt(getSafeTxHash(createSafeTxFromMessage(fakeRpcNetwork.chainId, SAFE_ADDRESS, { ...laterSafeTx.message, nonce }))))))
	assert.ok(approvedSlotsOfLaterProposal.every((slot) => stateDiff[slot] === 1n))
})

test('counts a Safe execution nested in a MultiSend batch that a stacked execTransaction call executes', async () => {
	configureSafe()
	const { encodeSafeBatch, SAFE_MULTI_SEND_CALL_ONLY } = await import('../../app/ts/safe/safeDelegateCalls.js')
	const encodeExecTransaction = (to: bigint, data: string, operation: bigint) => encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(to), 0n, data, operation, 0n, 0n, 0n, addressString(0n), addressString(0n), '0x'])
	const batch = encodeSafeBatch([{ to: SAFE_ADDRESS, value: 0n, data: hexToBytes(encodeExecTransaction(CALLED_CONTRACT, '0x', 0n)) }, { to: CALLED_CONTRACT, value: 0n, data: new Uint8Array([1]) }])
	const stackedCall = createSafeCall({ value: 0n, input: hexToBytes(encodeExecTransaction(SAFE_MULTI_SEND_CALL_ONLY, dataStringWith0xStart(batch), 1n)), gas: 200_000n }, undefined)
	const stackedExecution = { ...stackedCall, signedTransaction: { ...stackedCall.signedTransaction, from: ORDINARY_ACCOUNT, to: SAFE_ADDRESS } }
	const laterProposal = createSafeProposal({ value: 9n })
	const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([stackedExecution, laterProposal])], ethereum, 123n, BASE_FEE_PER_GAS)
	const laterSafeTx = laterProposal.safeTransaction?.safeTx
	if (laterSafeTx === undefined) throw new Error('Expected a Safe proposal')
	const stateDiff = preparedBlock?.stateOverrides[addressString(SAFE_ADDRESS)]?.stateDiff ?? {}
	// The stacked execution and the execution its batch makes raise the nonce from 5 to 7.
	const approvedSlotsOfLaterProposal = [5n, 6n, 7n].flatMap((nonce) => SORTED_OWNERS.map((owner) => approvedHashSlot(owner, BigInt(getSafeTxHash(createSafeTxFromMessage(fakeRpcNetwork.chainId, SAFE_ADDRESS, { ...laterSafeTx.message, nonce }))))))
	assert.ok(approvedSlotsOfLaterProposal.every((slot) => stateDiff[slot] === 1n))
})

test('counts a Safe execution that another Safe or any contract relays among the executions that raise the Safe\'s nonce', async () => {
	configureSafe()
	const OTHER_SAFE = 0x7777777777777777777777777777777777777777n
	const encodeExecTransaction = (to: bigint, data: string) => encodeFunctionCall(SAFE_EXECUTION_ABI, 'execTransaction', [addressString(to), 0n, data, 0n, 0n, 0n, 0n, addressString(0n), addressString(0n), '0x'])
	// Another Safe, which the input doesn't otherwise execute, executes this Safe through its own execTransaction.
	const relayedThroughOtherSafe = createSafeCall({ value: 0n, input: hexToBytes(encodeExecTransaction(OTHER_SAFE, encodeExecTransaction(SAFE_ADDRESS, '0x'))), gas: 200_000n }, undefined)
	const throughOtherSafe = { ...relayedThroughOtherSafe, signedTransaction: { ...relayedThroughOtherSafe.signedTransaction, from: ORDINARY_ACCOUNT, to: OTHER_SAFE } }
	// Any contract can relay an execution it is handed in its calldata.
	const relayedByContract = createSafeCall({ value: 0n, input: hexToBytes(encodeFunctionCall([{ type: 'function', name: 'relay', stateMutability: 'nonpayable', inputs: [{ name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }], outputs: [] }], 'relay', [addressString(SAFE_ADDRESS), encodeExecTransaction(CALLED_CONTRACT, '0x')])), gas: 200_000n }, undefined)
	const byContract = { ...relayedByContract, signedTransaction: { ...relayedByContract.signedTransaction, from: ORDINARY_ACCOUNT, to: CALLED_CONTRACT } }
	const laterProposal = createSafeProposal({ value: 9n })
	const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([throughOtherSafe, byContract, laterProposal])], ethereum, 123n, BASE_FEE_PER_GAS)
	const laterSafeTx = laterProposal.safeTransaction?.safeTx
	if (laterSafeTx === undefined) throw new Error('Expected a Safe proposal')
	const stateDiff = preparedBlock?.stateOverrides[addressString(SAFE_ADDRESS)]?.stateDiff ?? {}
	// Three execTransaction calls may each have executed this Safe, so the nonce may be anywhere from 5 to 8.
	const approvedSlotsOfLaterProposal = [5n, 6n, 7n, 8n].flatMap((nonce) => SORTED_OWNERS.map((owner) => approvedHashSlot(owner, BigInt(getSafeTxHash(createSafeTxFromMessage(fakeRpcNetwork.chainId, SAFE_ADDRESS, { ...laterSafeTx.message, nonce }))))))
	assert.ok(approvedSlotsOfLaterProposal.every((slot) => stateDiff[slot] === 1n))
})

test('counts at most 16 relayed executions, however many execTransaction selectors a page stuffs into calldata', async () => {
	configureSafe()
	const stuffedCalldata = new Uint8Array(4 * 10_000)
	for (let index = 0; index < stuffedCalldata.length; index += 4) stuffedCalldata.set([0x6a, 0x76, 0x12, 0x02], index)
	const stuffedTransaction = createSafeCall({ value: 0n, input: stuffedCalldata, gas: 1_000_000n }, undefined)
	const laterProposal = createSafeProposal({ value: 9n })
	const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([{ ...stuffedTransaction, signedTransaction: { ...stuffedTransaction.signedTransaction, from: ORDINARY_ACCOUNT } }, laterProposal])], ethereum, 123n, BASE_FEE_PER_GAS)
	// The Safe's nonce 5 plus at most 16 relayed executions: nonces 5 to 21.
	assert.equal(Object.keys(preparedBlock?.stateOverrides[addressString(SAFE_ADDRESS)]?.stateDiff ?? {}).length, 17 * SORTED_OWNERS.length)
})

test('approves a Safe execution only at the Safe\'s nonce when no earlier transaction can execute a Safe', async () => {
	configureSafe()
	const ordinaryTransaction = createSafeCall({ value: 1n, input: Uint8Array.from([0x12, 0x34]), gas: 21_000n }, undefined)
	const laterProposal = createSafeProposal({ value: 9n })
	const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([ordinaryTransaction, laterProposal])], ethereum, 123n, BASE_FEE_PER_GAS)
	assert.equal(Object.keys(preparedBlock?.stateOverrides[addressString(SAFE_ADDRESS)]?.stateDiff ?? {}).length, SORTED_OWNERS.length)
})

test('drops the zero base fee flag of a Safe proposal stored by an earlier version and runs it with the real base fee', async () => {
	configureSafe()
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: false, rpcNetwork: fakeRpcNetwork, activeSigningSafeAddress: SAFE_ADDRESS })
	const serializedProposal = modules.serialize(PreSimulationTransaction, createSafeProposal({}))
	// Earlier versions stored Safe proposals for a zero base fee block.
	const storedByEarlierVersion = { operations: [{ type: 'Transaction', preSimulationTransaction: { ...serializedProposal, simulationOptions: { ...serializedProposal.simulationOptions, simulateWithZeroBaseFee: true } } }] }
	// Loading the stack from storage parses it with InterceptorTransactionStack.
	const loadedStack = InterceptorTransactionStack.parse(storedByEarlierVersion)
	const [loadedOperation] = loadedStack.operations
	if (loadedOperation?.type !== 'Transaction') throw new Error('Expected the stored proposal')
	assert.deepEqual(loadedOperation.preSimulationTransaction.simulationOptions, { requiredChainId: fakeRpcNetwork.chainId })
	await modules.updateInterceptorTransactionStack(() => loadedStack)
	const { getCurrentSimulationInput, prepareSafeExecutionsForRpc } = await import('../../app/ts/background/simulationUpdating.js')
	const stackInput = await getCurrentSimulationInput()
	assert.equal(stackInput.at(-1)?.simulateWithZeroBaseFee, false)
	const preparedInput = await prepareSafeExecutionsForRpc(stackInput, ethereum)
	assert.equal(preparedInput.at(-1)?.transactions.at(-1)?.executedTransaction?.from, SAFE_EXECUTION_SIMULATION_EXECUTOR)
})

test('forms a Safe proposal, but not a direct Safe execution, as a call its executor runs', async () => {
	const { getPendingTransactionGasPayment } = await import('../../app/ts/safe/safePendingFlow.js')
	const proposal = createSafeProposal({})
	if (proposal.safeTransaction === undefined) throw new Error('Expected a Safe proposal')
	const pendingProposal = { ...pendingTransaction, safeTransaction: { safeAddress: SAFE_ADDRESS, safeTxHash: proposal.safeTransaction.safeTxHash, safeTx: proposal.safeTransaction.safeTx, safeVersion: '1.4.1', threshold: 2n } }
	assert.equal(getPendingTransactionGasPayment(pendingProposal), 'simulated-safe-executor')
	const pendingDirectExecution = { ...pendingTransaction, safeExecutionOriginalRequestParameters: await createTransferParams({}) }
	assert.equal(getPendingTransactionGasPayment(pendingDirectExecution), 'external-executor')
	assert.equal(getPendingTransactionGasPayment(pendingTransaction), 'transaction-sender')
})

test('leaves an input without Gnosis Safe executions as it is, without reading any Safe', async () => {
	const input = [createBlock([createSafeCall({ value: 1n, input: new Uint8Array(), gas: 21_000n }, undefined)])]
	fakeSafeContract.requestedRpcMethods.length = 0
	assert.equal(await prepareSafeExecutionSimulationInput(input, ethereum, 123n, BASE_FEE_PER_GAS), input)
	assert.deepEqual(fakeSafeContract.requestedRpcMethods, [])
})

test('sends the executor\'s call to the node in place of the Safe\'s call', async () => {
	configureSafe()
	const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([createSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, SAFE_EXECUTION_SIMULATION_OPTIONS)])], ethereum, 123n, BASE_FEE_PER_GAS)
	if (preparedBlock === undefined) throw new Error('Expected a prepared block')
	const request = await ethereum.ethSimulateV1Input([preparedBlock], 123n, undefined)
	const [call] = request.params[0].blockStateCalls[0]?.calls ?? []
	assert.equal(call?.from, SAFE_EXECUTION_SIMULATION_EXECUTOR)
	assert.equal(call?.to, SAFE_ADDRESS)
	assert.equal(call?.maxFeePerGas, EXECUTOR_MAX_FEE_PER_GAS)
})

test('rejects a Gnosis Safe execution or Safe proposal that reaches the node without its executor\'s call', async () => {
	for (const unpreparedExecution of [createSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, SAFE_EXECUTION_SIMULATION_OPTIONS), createSafeProposal({})]) {
		await assert.rejects(ethereum.ethSimulateV1Input([createBlock([unpreparedExecution])], 123n, undefined), /reached the node without its executor's call/u)
	}
})

test('rejects a transaction that is not a Gnosis Safe execution but reaches the node with another call to run', async () => {
	const shownCall = createSafeCall({ value: 7n, input: Uint8Array.from([0x12, 0x34]), gas: 63_000n }, undefined)
	const otherCall = createSafeCall({ value: 0n, input: new Uint8Array(), gas: 21_000n }, undefined).signedTransaction
	await assert.rejects(ethereum.ethSimulateV1Input([createBlock([{ ...shownCall, executedTransaction: otherCall }])], 123n, undefined), /not a Gnosis Safe execution reached the node with a call other than its own/u)
})

const staleExecutionCases = [
	{ description: 'in an input without Gnosis Safe executions', createOtherTransactions: (): readonly PreSimulationTransaction[] => [] },
	{ description: 'next to a Gnosis Safe execution', createOtherTransactions: (): readonly PreSimulationTransaction[] => [createSafeCall({ value: 9n, input: new Uint8Array(), gas: 63_000n }, SAFE_EXECUTION_SIMULATION_OPTIONS)] },
]

for (const { description, createOtherTransactions } of staleExecutionCases) {
	test(`clears another call to run from a transaction that is not a Gnosis Safe execution, ${ description }`, async () => {
		configureSafe()
		const shownCall = createSafeCall({ value: 7n, input: Uint8Array.from([0x12, 0x34]), gas: 63_000n }, undefined)
		const otherCall = createSafeCall({ value: 0n, input: new Uint8Array(), gas: 21_000n }, undefined).signedTransaction
		const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([{ ...shownCall, executedTransaction: otherCall }, ...createOtherTransactions()])], ethereum, 123n, BASE_FEE_PER_GAS)
		const [preparedShownCall] = preparedBlock?.transactions ?? []
		assert.deepEqual(preparedShownCall, shownCall)
		if (preparedBlock === undefined) throw new Error('Expected a prepared block')
		const request = await ethereum.ethSimulateV1Input([preparedBlock], 123n, undefined)
		const [call] = request.params[0].blockStateCalls[0]?.calls ?? []
		assert.equal(call?.value, shownCall.signedTransaction.value, 'the node runs the call the transaction shows')
	})
}

const preparedExecutionCases = [
	{ description: 'a Gnosis Safe execution', createExecution: () => createSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, SAFE_EXECUTION_SIMULATION_OPTIONS) },
	{ description: 'a Safe proposal', createExecution: () => createSafeProposal({}) },
]

for (const { description, createExecution } of preparedExecutionCases) {
	test(`passes both RPC boundary checks with ${ description } prepared to run through the Safe, again from the gas-limited blocks`, async () => {
		configureSafe()
		const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([createExecution()])], ethereum, 123n, BASE_FEE_PER_GAS)
		if (preparedBlock === undefined) throw new Error('Expected a prepared block')
		const prepared = await ethereum.prepareEthSimulateV1Input([preparedBlock], 123n, undefined)
		// The simulated balances simulate the gas-limited blocks again, so they must still mark the Safe execution.
		const reprepared = await ethereum.prepareEthSimulateV1Input(prepared.rpcBlocks, 123n, undefined)
		assert.equal(reprepared.rpcBlocks[0]?.transactions[0]?.executedTransaction?.from, SAFE_EXECUTION_SIMULATION_EXECUTOR)
	})
}

test('rejects and clears the executor\'s call of a Safe proposal\'s shown call that is no longer a Safe proposal', async () => {
	configureSafe()
	const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([createSafeProposal({})])], ethereum, 123n, BASE_FEE_PER_GAS)
	const preparedProposal = preparedBlock?.transactions[0]
	if (preparedProposal?.executedTransaction === undefined) throw new Error('Expected a prepared Safe proposal')
	const { safeTransaction: _safeTransaction, ...shownCallWithExecutorCall } = preparedProposal
	await assert.rejects(ethereum.ethSimulateV1Input([createBlock([shownCallWithExecutorCall])], 123n, undefined), /not a Gnosis Safe execution reached the node with a call other than its own/u)
	const [clearedBlock] = await prepareSafeExecutionSimulationInput([createBlock([shownCallWithExecutorCall])], ethereum, 123n, BASE_FEE_PER_GAS)
	assert.equal(clearedBlock?.transactions[0]?.executedTransaction, undefined)
})

test('replaces another call to run that a Safe proposal carries with its executor\'s execution of the SafeTx', async () => {
	configureSafe()
	const proposal = createSafeProposal({})
	const otherCall = createSafeCall({ value: 0n, input: new Uint8Array(), gas: 21_000n }, undefined).signedTransaction
	const [preparedBlock] = await prepareSafeExecutionSimulationInput([createBlock([{ ...proposal, executedTransaction: otherCall }])], ethereum, 123n, BASE_FEE_PER_GAS)
	const executed = preparedBlock?.transactions[0]?.executedTransaction
	const proposalSafeTx = proposal.safeTransaction?.safeTx
	if (executed === undefined || proposalSafeTx === undefined) throw new Error('Expected a prepared Safe proposal')
	assert.equal(executed.from, SAFE_EXECUTION_SIMULATION_EXECUTOR)
	assert.deepEqual(decodeSafeExecution(fakeRpcNetwork.chainId, SAFE_ADDRESS, proposalSafeTx.message.nonce, executed.input).safeTx, proposalSafeTx)
})

test('drops an execution override from an imported simulation stack, so a stacked transaction runs the call it shows', () => {
	const shownCall = createSafeCall({ value: 7n, input: Uint8Array.from([0x12, 0x34]), gas: 63_000n }, SAFE_EXECUTION_SIMULATION_OPTIONS)
	const harmlessCall = createSafeCall({ value: 0n, input: new Uint8Array(), gas: 21_000n }, undefined)
	const importedStack = InterceptorTransactionStack.parse({ operations: [{
		type: 'Transaction',
		preSimulationTransaction: { ...modules.serialize(PreSimulationTransaction, shownCall), executedTransaction: modules.serialize(EthereumSendableSignedTransaction, harmlessCall.signedTransaction) },
	}] })
	const [operation] = importedStack.operations
	if (operation?.type !== 'Transaction') throw new Error('Expected the imported transaction')
	assert.equal('executedTransaction' in operation.preSimulationTransaction, false)
	assert.deepEqual(operation.preSimulationTransaction, shownCall)
})

test('looks up a simulated Gnosis Safe execution as the Safe\'s own call, as its receipt shows it', async () => {
	configureSafe()
	const safeCall = createSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, SAFE_EXECUTION_SIMULATION_OPTIONS)
	const preparedInput = await prepareSafeExecutionSimulationInput([createBlock([safeCall])], ethereum, 123n, BASE_FEE_PER_GAS)
	const lookedUp = await getSimulatedTransactionByHashFromInput(ethereum, undefined, { kind: 'simulated', value: preparedInput }, safeCall.signedTransaction.hash)
	assert.equal(lookedUp?.from, SAFE_ADDRESS)
	assert.equal(lookedUp?.to, CALLED_CONTRACT)
	assert.equal(lookedUp?.value, 7n)
})

for (const { description, message, errorData, returnData } of revertResponses) {
	test(`explains why a simulated Gnosis Safe execution failed without its call's revert reason, reported ${ description }`, () => {
		const failure = { error: { code: 3, message, ...(errorData === undefined ? {} : { data: errorData }) }, returnData }
		const decodedErrorMessage = decodeEthereumError([], failure.error).reason
		assert.match(describeSafeExecutionFailure({ simulationOptions: SAFE_EXECUTION_SIMULATION_OPTIONS }, failure, decodedErrorMessage), /Gnosis Safe's call reverted \(GS013\)/u)
		assert.equal(describeSafeExecutionFailure({}, failure, decodedErrorMessage), decodedErrorMessage, 'only a simulated Safe execution hides its call\'s reason behind GS013')
	})
}

test('keeps the reason of a simulated Gnosis Safe execution that fails for another reason', () => {
	const failure = { error: { code: 3, message: 'execution reverted: GS025', data: '0x' }, returnData: new Uint8Array() }
	assert.equal(describeSafeExecutionFailure({ simulationOptions: SAFE_EXECUTION_SIMULATION_OPTIONS }, failure, 'GS025'), 'GS025')
})

test('charges no gas to a Gnosis Safe whose execution the simulation runs', () => {
	assert.equal(getGasFeePaidByTransactionSender({ gasSpent: 50_000n, realizedGasPrice: 3n, simulationOptions: SAFE_EXECUTION_SIMULATION_OPTIONS }), 0n)
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

// Like geth's eth_simulateV1 without validation: a call that pays fees must cover its block's base fee, and a call without fees skips the check. Records every simulated call.
function createRecordingSimulator() {
	const simulatedCalls: { readonly from: bigint, readonly to: bigint, readonly maxFeePerGas: bigint, readonly baseFeePerGas: bigint }[] = []
	const requestHandler = {
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			if (rpcRequest.method === 'eth_simulateV1') {
				const simulationParams = rpcRequest.params?.[0]
				const blockStateCalls = isRecord(simulationParams) && Array.isArray(simulationParams.blockStateCalls) ? simulationParams.blockStateCalls : []
				for (const blockStateCall of blockStateCalls) {
					const baseFeePerGas = BigInt(blockStateCall.blockOverrides?.baseFeePerGas ?? 0n)
					for (const call of blockStateCall.calls) {
						const maxFeePerGas = BigInt(call.maxFeePerGas ?? 0n)
						if (maxFeePerGas !== 0n && maxFeePerGas < baseFeePerGas) throw new Error('max fee per gas less than block base fee')
						simulatedCalls.push({ from: BigInt(call.from), to: BigInt(call.to), maxFeePerGas, baseFeePerGas })
					}
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
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry()])
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

test('simulates a configured Gnosis Safe\'s transaction in simulation mode as the Safe executing it, through refresh and the stack', async () => {
	configureSafe()
	const simulator = createRecordingSimulator()
	const postedMessages: unknown[] = []
	const websiteTabConnections = createWebsiteTabConnections(postedMessages)
	const pending = await openSimulationModeConfirmation(simulator, SAFE_ADDRESS, await createTransferParams({}), websiteTabConnections)

	assert.equal(pending.executeThroughSafe, true)
	assert.equal(pending.safeTransaction, undefined, 'simulation mode stacks the transaction instead of proposing it to the Safe')
	assert.equal(pending.transactionToSimulate.transaction.from, SAFE_ADDRESS)
	assert.equal(pending.transactionToSimulate.transaction.maxFeePerGas, 0n, 'the Safe pays no fees')
	assert.deepEqual(pending.transactionToSimulate.simulationOptions, SAFE_EXECUTION_SIMULATION_OPTIONS)
	if (pending.popupVisualisation.statusCode !== 'success') throw new Error(`Safe execution simulation failed: ${ pending.popupVisualisation.data.error.message }`)
	const simulatedSafeCall = pending.popupVisualisation.data.simulationState.simulationStateInput.at(-1)?.transactions.at(-1)
	assert.equal(simulatedSafeCall?.signedTransaction.maxFeePerGas, 0n, 'the base-fee repair leaves the Safe\'s own call without fees')
	assert.equal(simulatedSafeCall?.executedTransaction?.from, SAFE_EXECUTION_SIMULATION_EXECUTOR)
	const executorCalls = simulator.simulatedCalls.filter((call) => call.from === SAFE_EXECUTION_SIMULATION_EXECUTOR)
	assert.ok(executorCalls.length > 0, 'the node runs the executor\'s call')
	for (const call of executorCalls) {
		assert.equal(call.to, SAFE_ADDRESS)
		assert.ok(call.baseFeePerGas > 0n, 'in a block with the real base fee')
		assert.ok(call.maxFeePerGas >= call.baseFeePerGas)
	}
	assert.equal(simulator.simulatedCalls.some((call) => call.from === SAFE_ADDRESS), false, 'the Safe never sends a transaction itself, not even to estimate gas')
	const visualizedTransaction = pending.popupVisualisation.data.visualizedSimulationState.visualizedBlocks.at(-1)?.simulatedAndVisualizedTransactions.at(-1)
	assert.deepEqual(visualizedTransaction?.simulationOptions, SAFE_EXECUTION_SIMULATION_OPTIONS)

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	if (refreshedPending?.type !== 'Transaction' || refreshedPending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected the refreshed transaction to stay simulated')
	assert.deepEqual(refreshedPending.transactionToSimulate.simulationOptions, SAFE_EXECUTION_SIMULATION_OPTIONS, 'a refresh forms the transaction as a Safe execution again')

	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	})
	const [stackedOperation] = (await modules.getInterceptorTransactionStack()).operations
	if (stackedOperation?.type !== 'Transaction') throw new Error('Expected the Safe transaction on the simulation stack')
	assert.deepEqual(stackedOperation.preSimulationTransaction.simulationOptions, SAFE_EXECUTION_SIMULATION_OPTIONS)
	const { getCurrentSimulationInput, prepareSimulationInputForRpc } = await import('../../app/ts/background/simulationUpdating.js')
	const stackInput = await getCurrentSimulationInput()
	assert.equal(stackInput.at(-1)?.simulateWithZeroBaseFee, false)
	const preparedStackInput = await prepareSimulationInputForRpc(stackInput, simulator.ethereum)
	assert.equal(preparedStackInput.at(-1)?.transactions.at(-1)?.executedTransaction?.from, SAFE_EXECUTION_SIMULATION_EXECUTOR, 'the stacked transaction keeps running through the Safe')
	const { requestInterceptorSimulationInput } = await import('../../app/ts/background/popupMessageHandlers.js')
	const simulationExport = await requestInterceptorSimulationInput(simulator.ethereum)
	if (!simulationExport.ok) throw new Error(simulationExport.message)
	const exportedRequest: unknown = JSON.parse(simulationExport.ethSimulateV1InputString)
	const exportedSimulation = isRecord(exportedRequest) && isRecord(exportedRequest.eth_simulateV1) && Array.isArray(exportedRequest.eth_simulateV1.params) ? exportedRequest.eth_simulateV1.params[0] : undefined
	const exportedCalls = isRecord(exportedSimulation) && Array.isArray(exportedSimulation.blockStateCalls) ? exportedSimulation.blockStateCalls.flatMap((blockStateCall) => blockStateCall.calls) : []
	assert.deepEqual(exportedCalls.map((call) => BigInt(call.from)), [SAFE_EXECUTION_SIMULATION_EXECUTOR], 'the exported request runs the stacked Safe execution as the preview does')
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
})

test('simulates a configured Gnosis Safe that the page names as the sender, while another account is active, as an ordinary transaction from the Safe, through refresh', async () => {
	configureSafe()
	const simulator = createRecordingSimulator()
	const pending = await openSimulationModeConfirmation(simulator, ORDINARY_ACCOUNT, await createTransferParams({ from: addressString(SAFE_ADDRESS) }), createWebsiteTabConnections([]))

	assert.equal(pending.executeThroughSafe, undefined, 'owner approval is only assumed for the Safe the user is simulating as')
	assert.equal(pending.transactionToSimulate.transaction.from, SAFE_ADDRESS, 'the page\'s sender is simulated as before')
	assert.equal(pending.transactionToSimulate.simulationOptions?.executeThroughSafe, undefined)
	assert.equal(simulator.simulatedCalls.some((call) => call.from === SAFE_EXECUTION_SIMULATION_EXECUTOR), false, 'no executor calls the Safe\'s execTransaction')

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const [refreshedPending] = await modules.getPendingTransactionsAndMessages()
	if (refreshedPending?.type !== 'Transaction' || refreshedPending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Expected the refreshed transaction to stay simulated')
	assert.equal(refreshedPending.transactionToSimulate.simulationOptions?.executeThroughSafe, undefined, 'a refresh keeps the ordinary simulation')
	assert.equal(simulator.simulatedCalls.some((call) => call.from === SAFE_EXECUTION_SIMULATION_EXECUTOR), false)
})

const isSimulationModeSafeExecution = async (selectedActiveAddress: bigint, transactionParams: SendTransactionParams | SendRawTransactionParams) => {
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry()])
	const preparation = await prepareSafeTransactionConfirmation(ethereum, { kind: 'transaction', parameters: transactionParams }, true, selectedActiveAddress, undefined)
	return preparation.gasPayment === 'simulated-safe-executor'
}

const simulationModeCases = [
	{ description: 'the active Safe sends without naming a sender', selectedActiveAddress: SAFE_ADDRESS, createParams: async () => await createTransferParams({}), expected: true },
	{ description: 'the page names the active Safe as the sender', selectedActiveAddress: SAFE_ADDRESS, createParams: async () => await createTransferParams({ from: addressString(SAFE_ADDRESS) }), expected: true },
	{ description: 'the page names a configured Safe that is not the active address', selectedActiveAddress: ORDINARY_ACCOUNT, createParams: async () => await createTransferParams({ from: addressString(SAFE_ADDRESS) }), expected: false },
	{ description: 'the page names another sender while the Safe is active', selectedActiveAddress: SAFE_ADDRESS, createParams: async () => await createTransferParams({ from: addressString(ORDINARY_ACCOUNT) }), expected: false },
	{ description: 'the Safe\'s request carries EIP-7702 authorizations', selectedActiveAddress: SAFE_ADDRESS, createParams: async () => await createTransferParams({ authorizationList: [{ chainId: '0x1', address: addressString(CALLED_CONTRACT), nonce: '0x0' }] }), expected: false },
	{ description: 'the Safe\'s request creates a contract', selectedActiveAddress: SAFE_ADDRESS, createParams: async () => (await import('../../app/ts/types/JsonRpc-types.js')).SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [{ value: '0x0', data: '0x00' }] }), expected: false },
	{ description: 'the request is a raw signed transaction', selectedActiveAddress: SAFE_ADDRESS, createParams: async (): Promise<SendRawTransactionParams> => ({ method: 'eth_sendRawTransaction', params: [new Uint8Array([1])] }), expected: false },
]

for (const { description, selectedActiveAddress, createParams, expected } of simulationModeCases) {
	test(`${ expected ? 'runs' : 'does not run' } a simulation-mode transaction through the Gnosis Safe when ${ description }`, async () => {
		assert.equal(await isSimulationModeSafeExecution(selectedActiveAddress, await createParams()), expected)
	})
}

test('keeps the ordinary simulation for a configured Gnosis Safe whose version Interceptor does not support', async () => {
	fakeSafeContract.version = '1.2.0'
	assert.equal(await withSilencedConsole(async () => await isSimulationModeSafeExecution(SAFE_ADDRESS, await createTransferParams({}))), false)
})

async function importStackedTransaction(transaction: PreSimulationTransaction) {
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	const { importSimulationStack } = await import('../../app/ts/background/popupMessageHandlers.js')
	const eth_simulateV1 = await ethereum.ethSimulateV1Input([], 123n, undefined)
	// Storing the stack comes before visualizing it, whose result doesn't matter here.
	await withSilencedConsole(async () => await importSimulationStack(ethereum, new modules.TokenPriceService(ethereum, 60_000), {
		method: 'popup_importSimulationStack',
		data: { name: 'Interceptor Simulation Export', version: '1.0.0', eth_simulateV1, interceptorSimulateStack: { operations: [{ type: 'Transaction', preSimulationTransaction: transaction }] } },
	}))
	const [operation] = (await modules.getInterceptorTransactionStack()).operations
	if (operation?.type !== 'Transaction') throw new Error('Expected the imported transaction on the simulation stack')
	return operation.preSimulationTransaction.simulationOptions
}

const ORDINARY_SIMULATION_OPTIONS: TransactionSimulationOptions = { requiredChainId: fakeRpcNetwork.chainId }
const importCases = [
	{ description: 'drops executeThroughSafe from an imported transaction of the active Gnosis Safe, so a file cannot make Interceptor assume the owners approved it', imported: SAFE_EXECUTION_SIMULATION_OPTIONS },
	{ description: 'keeps an imported transaction of the active Gnosis Safe that does not ask to run through the Safe as an ordinary transaction', imported: ORDINARY_SIMULATION_OPTIONS },
]

for (const { description, imported } of importCases) {
	test(description, async () => {
		await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry()])
		await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: SAFE_ADDRESS })
		assert.deepEqual(await importStackedTransaction(createSafeCall({ value: 7n, input: new Uint8Array(), gas: 63_000n }, imported)), ORDINARY_SIMULATION_OPTIONS)
	})
}
