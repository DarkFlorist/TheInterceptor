import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { EthereumClientService, getNextBlockTimeStampOverride } from '../../app/ts/simulation/services/EthereumClientService.js'
import { captureSimulationSnapshotForPreview, captureSimulationStackSnapshot, getCurrentSimulationInput, getGovernanceExecutionSimulationInput, getSimulationInputForPreview, prepareSimulationInputForRpc, visualizeSimulatorState } from '../../app/ts/background/simulationUpdating.js'
import { getSimulationOverridesForPreview, type SimulationPreviewContext } from '../../app/ts/background/delegateClearingPolicy.js'
import { createEthereumClientService, createSimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'
import { requestDelegateClearing, setDelegateClearing } from '../../app/ts/background/popupMessageHandlers/delegateClearing.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { changeSimulationMode, isDelegateClearingEnabled, setDelegateClearingEnabled, setMakeCurrentAddressRich } from '../../app/ts/background/settings.js'
import { getSettings } from '../../app/ts/background/settings.js'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { updateInterceptorTransactionStack } from '../../app/ts/background/storageVariables.js'
import { appendTransactionsToInput, createSimulationState, ethSimulateV1FromInput, getBaseFeeAdjustmentBalances, getSimulatedCode, getSimulatedCodeFromInput, mockSignTransaction, simulatedCallFromInput, simulateEstimateGasFromInput } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { addressString, dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { getSimulatedStackV2 } from '../../app/ts/simulation/SimulationStackExtraction.js'
import { getSimulationInputHash } from '../../app/ts/utils/simulationFingerprint.js'
import { isCodeClearedBySimulationOverrides } from '../../app/ts/utils/delegateClearingState.js'
import { getAppendedBlockStateOverrides, mapBlocksWithEffectiveStateOverrides } from '../../app/ts/utils/simulationStateOverrides.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../../app/ts/utils/constants.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'
import { addr, authorization as eip7702Signing } from 'micro-eth-signer'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { normalizeEip7702AuthorizationList } from '../../app/ts/utils/eip7702Authorization.js'
import { encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { getRpcNetworkChange } from '../../app/ts/utils/rpcNetworkChange.js'
import type { RpcEntry, RpcNetwork } from '../../app/ts/types/rpc.js'
import { EthSimulateV1Params, type StateOverrides } from '../../app/ts/types/ethSimulate-types.js'
import { JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import { EthereumBlockHeader, serialize } from '../../app/ts/types/wire-types.js'
import { InterceptorSimulationExport, type SimulationState, SimulationStateInputBlock, createSimulatedExecutionInput } from '../../app/ts/types/visualizer-types.js'
import { eth_getBlockByNumber_goerli_8443561_true, eth_simulateV1_dummy_call_result } from '../RPCResponses.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../../app/ts/config/defaults.js'

const activeAddress = 0x1234567890123456789012345678901234567890n
const SIMULATION_STACK: SimulationPreviewContext = { kind: 'simulation-stack' }
const SAFE_TRANSACTION_SIGNATURE: SimulationPreviewContext = { kind: 'safe-transaction-signature' }
const rpcEntry = {
	name: 'Delegation test network',
	chainId: 31337n,
	httpsRpc: 'https://delegation-test.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: false,
	minimized: false,
} as const

const transaction = (identifier: bigint) => ({
	signedTransaction: mockSignTransaction({
		type: '1559' as const,
		from: activeAddress,
		to: activeAddress + 1n,
		value: 0n,
		input: new Uint8Array(),
		nonce: identifier - 1n,
		gas: 21_000n,
		chainId: rpcEntry.chainId,
		maxFeePerGas: 1n,
		maxPriorityFeePerGas: 1n,
	}),
	website: { websiteOrigin: 'https://delegation-test.invalid', icon: undefined, title: 'Delegation test' },
	created: new Date('2026-01-01T00:00:00Z'),
	originalRequestParameters: { method: 'eth_sendTransaction' as const, params: [{ from: activeAddress, to: activeAddress + 1n, value: 0n, input: new Uint8Array() }] },
	transactionIdentifier: identifier,
})

describe('delegate clearing in simulation', () => {
	test('keeps simulation blocks independent of the simulation-wide override', () => {
		const parsed = SimulationStateInputBlock.parse({
			stateOverrides: {},
			transactions: [],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: '0x0', deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		})
		assert.deepEqual(parsed.stateOverrides, {})
	})

	test('keeps the choice scoped to the active address and chain and preserves balance overrides', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		await setMakeCurrentAddressRich(true)
		assert.equal(await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true), true)
		assert.equal(await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true), false)
		assert.equal(await isDelegateClearingEnabled(activeAddress, rpcEntry.chainId), true)
		assert.equal(await isDelegateClearingEnabled(activeAddress + 1n, rpcEntry.chainId), false)
		assert.equal(await isDelegateClearingEnabled(activeAddress, rpcEntry.chainId + 1n), false)

		const input = await getCurrentSimulationInput()
		const simulationOverrides = getSimulationOverridesForPreview(SIMULATION_STACK, await getSettings())
		assert.deepEqual(input[0]?.stateOverrides[addressString(activeAddress)], { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value })
		assert.equal(isCodeClearedBySimulationOverrides(simulationOverrides, activeAddress), true)
		assert.deepEqual(getSimulationOverridesForPreview(SAFE_TRANSACTION_SIGNATURE, await getSettings()), {})
		assert.deepEqual((await getSimulationInputForPreview(SAFE_TRANSACTION_SIGNATURE, await getSettings())).simulationOverrides, {})
		const signingSnapshot = await captureSimulationSnapshotForPreview(SAFE_TRANSACTION_SIGNATURE)
		assert.deepEqual(signingSnapshot.simulationInput.simulationOverrides, {})
		assert.deepEqual(signingSnapshot.simulationInput.value[0]?.stateOverrides[addressString(activeAddress)], { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value })
		assert.equal(isCodeClearedBySimulationOverrides((await captureSimulationStackSnapshot()).simulationInput.simulationOverrides, activeAddress), true)
		assert.equal(input[0]?.transactions.length, 0)
		const parentBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
		if ('error' in parentBlockResponse) throw new Error(parentBlockResponse.error.message)
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getBlockByNumber') throw new Error(`Unexpected RPC method ${ request.method }`)
				return parentBlockResponse.result
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		const rpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input({ kind: 'simulated', value: input, simulationOverrides }, 1n, undefined)).request)
		assert.equal(rpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(rpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.balance, `0x${ MAKE_YOU_RICH_TRANSACTION.transaction.value.toString(16) }`)

		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress + 1n })
		assert.equal(isCodeClearedBySimulationOverrides(getSimulationOverridesForPreview(SIMULATION_STACK, await getSettings()), activeAddress + 1n), false)
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: { ...rpcEntry, chainId: rpcEntry.chainId + 1n } })
		assert.equal(isCodeClearedBySimulationOverrides(getSimulationOverridesForPreview(SIMULATION_STACK, await getSettings()), activeAddress), false)

		assert.equal(await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, false), true)
		assert.equal(await isDelegateClearingEnabled(activeAddress, rpcEntry.chainId), false)
	})

	test('applies initial state only to the first block and preserves per-block state later', () => {
		const initial = { [addressString(activeAddress)]: { code: new Uint8Array() } }
		const block = { [addressString(activeAddress)]: { balance: 5n } }
		const mergedFirstBlock = { [addressString(activeAddress)]: { balance: 5n, code: new Uint8Array() } }
		assert.deepEqual(getAppendedBlockStateOverrides(0, block, initial), mergedFirstBlock)
		assert.equal(getAppendedBlockStateOverrides(1, block, initial), block)
		const mapped = mapBlocksWithEffectiveStateOverrides([{ stateOverrides: block }, { stateOverrides: block }], initial, (simulatedBlock) => simulatedBlock.stateOverrides, (_simulatedBlock, effectiveStateOverrides, blockIndex) => ({ effectiveStateOverrides, blockIndex }))
		assert.deepEqual(mapped[0], { effectiveStateOverrides: mergedFirstBlock, blockIndex: 0 })
		assert.equal(mapped[1]?.effectiveStateOverrides, block)
	})

	test('keeps the idle stack empty and clears the first appended transaction and RPC call', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true)
		const input = await getCurrentSimulationInput([])
		const simulationOverrides = getSimulationOverridesForPreview(SIMULATION_STACK, await getSettings())
		assert.equal(input.length, 0)
		const parentBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
		if ('error' in parentBlockResponse) throw new Error(parentBlockResponse.error.message)
		const parentBlock = EthereumBlockHeader.parse(parentBlockResponse.result)
		if (parentBlock === null) throw new Error('Expected a parent block')
		const numberedBlockTag = parentBlock.number + 1n
		let numberedCodeRequests = 0
		const ethSimulateRequests: EthSimulateV1Params[] = []
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method === 'eth_getBlockByNumber') return parentBlockResponse.result
				if (request.method === 'eth_blockNumber') return `0x${ parentBlock.number.toString(16) }`
				if (request.method === 'eth_getTransactionCount') return '0x0'
				if (request.method === 'eth_getCode') {
					assert.equal(request.params[1], numberedBlockTag)
					numberedCodeRequests += 1
					return '0x6000'
				}
				if (request.method === 'eth_simulateV1') {
					ethSimulateRequests.push(request)
					throw new Error('Captured simulation request')
				}
				throw new Error(`Unexpected RPC method ${ request.method }`)
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		const idleState = await createSimulationState(ethereum, undefined, { kind: 'simulated', value: input, simulationOverrides })
		assert.equal(idleState.success, true)
		if (idleState.success) assert.equal(idleState.simulatedBlocks.length, 0)
		assert.equal(ethSimulateRequests.length, 0)
		// interceptor_getSimulationStack 2.0.0 must still report the cleared code although the idle stack has no simulated blocks.
		assert.deepEqual(getSimulatedStackV2({ kind: 'simulated', value: idleState }), { stateOverrides: { [addressString(activeAddress)]: { code: new Uint8Array() } }, transactions: [] })
		const idleCode = await getSimulatedCodeFromInput(ethereum, undefined, createSimulatedExecutionInput(input, simulationOverrides), activeAddress)
		assert.equal(idleCode.statusCode, 'success')
		if (idleCode.statusCode === 'success') assert.equal(idleCode.getCodeReturn.length, 0)
		const popupCode = await getSimulatedCode(ethereum, undefined, { kind: 'simulated', value: idleState }, activeAddress)
		assert.equal(popupCode.statusCode, 'success')
		if (popupCode.statusCode === 'success') assert.equal(popupCode.getCodeReturn.length, 0)
		const numberedInputCode = await getSimulatedCodeFromInput(ethereum, undefined, createSimulatedExecutionInput(input, simulationOverrides), activeAddress, numberedBlockTag)
		const numberedPopupCode = await getSimulatedCode(ethereum, undefined, { kind: 'simulated', value: idleState }, activeAddress, numberedBlockTag)
		assert.deepEqual(numberedInputCode, { statusCode: 'success', getCodeReturn: new Uint8Array([0x60, 0x00]) })
		assert.deepEqual(numberedPopupCode, numberedInputCode)
		assert.equal(numberedCodeRequests, 2)
		if (!idleState.success) throw new Error('Expected an idle simulation state')
		const { simulatedBlocks: _simulatedBlocks, ...failedBase } = idleState
		const failedState: SimulationState = {
			...failedBase,
			success: false,
			jsonRpcError: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Simulation failed' } },
		}
		assert.deepEqual(await getSimulatedCode(ethereum, undefined, { kind: 'simulated', value: failedState }, activeAddress), { statusCode: 'failure' })
		assert.equal(ethSimulateRequests.length, 0)
		const confirmationInput = appendTransactionsToInput(input, [transaction(1n)])
		assert.equal(confirmationInput.length, 1)
		const confirmationRequest = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input({ kind: 'simulated', value: confirmationInput, simulationOverrides }, 1n, undefined)).request)
		assert.equal(confirmationRequest.params[0].blockStateCalls.length, 1)
		assert.equal(confirmationRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		await assert.rejects(simulatedCallFromInput(ethereum, undefined, createSimulatedExecutionInput(input, simulationOverrides), {
			from: activeAddress,
			to: activeAddress + 1n,
			value: 0n,
			input: new Uint8Array(),
			maxFeePerGas: 0n,
			maxPriorityFeePerGas: 0n,
		}), /Captured simulation request/)
		const callRequest = serialize(EthSimulateV1Params, ethSimulateRequests[0])
		assert.equal(callRequest.params[0].blockStateCalls.length, 1)
		assert.equal(callRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.deepEqual(ethSimulateRequests[0]?.params[0].blockStateCalls[0]?.blockOverrides?.time, getNextBlockTimeStampOverride(parentBlock.timestamp, DEFAULT_BLOCK_MANIPULATION))
		await assert.rejects(simulateEstimateGasFromInput(ethereum, undefined, createSimulatedExecutionInput(input, simulationOverrides), {
			from: activeAddress,
			to: activeAddress + 1n,
			value: 0n,
			input: new Uint8Array(),
		}), /Captured simulation request/)
		const estimateRequest = serialize(EthSimulateV1Params, ethSimulateRequests[1])
		assert.equal(estimateRequest.params[0].blockStateCalls.length, 1)
		assert.equal(estimateRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		await assert.rejects(ethSimulateV1FromInput(ethereum, undefined, createSimulatedExecutionInput(input, simulationOverrides), {
			method: 'eth_simulateV1',
			params: [{ blockStateCalls: [{ calls: [] }] }],
		}), /Captured simulation request/)
		const directSimulationRequest = serialize(EthSimulateV1Params, ethSimulateRequests[2])
		assert.equal(directSimulationRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		await assert.rejects(ethSimulateV1FromInput(ethereum, undefined, createSimulatedExecutionInput(confirmationInput, simulationOverrides), {
			method: 'eth_simulateV1',
			params: [{ blockStateCalls: [{ calls: [] }, { calls: [] }] }],
		}), /Captured simulation request/)
		const stackedSimulationRequest = serialize(EthSimulateV1Params, ethSimulateRequests[3])
		assert.equal(stackedSimulationRequest.params[0].blockStateCalls.length, 3)
		assert.equal(stackedSimulationRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(stackedSimulationRequest.params[0].blockStateCalls[1]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		assert.equal(stackedSimulationRequest.params[0].blockStateCalls[2]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		await assert.rejects(ethSimulateV1FromInput(ethereum, undefined, createSimulatedExecutionInput(input, simulationOverrides), {
			method: 'eth_simulateV1',
			params: [{ blockStateCalls: [{ calls: [] }] }, parentBlock.number],
		}), /Captured simulation request/)
		const explicitParentRequest = serialize(EthSimulateV1Params, ethSimulateRequests.at(-1))
		assert.equal(explicitParentRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(explicitParentRequest.params[1], `0x${ parentBlock.number.toString(16) }`)
	})

	test('website eth_getCode reads on-chain delegate code in signing mode while the choice stays saved', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true)
		const delegationDesignator = new Uint8Array([0xef, 0x01, 0x00, ...new Uint8Array(20).fill(0xab)])
		const parentBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
		if ('error' in parentBlockResponse) throw new Error(parentBlockResponse.error.message)
		let chainCodeRequests = 0
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method === 'eth_getBlockByNumber') return parentBlockResponse.result
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				chainCodeRequests += 1
				return `0x${ Array.from(delegationDesignator, (byte) => byte.toString(16).padStart(2, '0')).join('') }`
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		// Mirrors the website eth_getCode path: background.ts builds the RPC input this way and the getCode handler calls getSimulatedCodeFromInput.
		const websiteGetCode = async () => {
			const simulationInput = await prepareSimulationInputForRpc(await getSimulationInputForPreview(SIMULATION_STACK, await getSettings()), ethereum)
			return await getSimulatedCodeFromInput(ethereum, undefined, simulationInput, activeAddress, 'latest')
		}

		assert.deepEqual(await websiteGetCode(), { statusCode: 'success', getCodeReturn: new Uint8Array() })
		assert.equal(chainCodeRequests, 0)

		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		assert.equal(await isDelegateClearingEnabled(activeAddress, rpcEntry.chainId), true)
		assert.deepEqual(getSimulationOverridesForPreview(SIMULATION_STACK, await getSettings()), {})
		assert.deepEqual((await getSimulationInputForPreview(SIMULATION_STACK, await getSettings())).simulationOverrides, {})
		assert.deepEqual(await websiteGetCode(), { statusCode: 'success', getCodeReturn: delegationDesignator })
		assert.equal(chainCodeRequests, 1)
	})

	test('clears before the first stack block and keeps a captured preference stable after storage changes', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true)
		await updateInterceptorTransactionStack(() => ({ operations: [
			{ type: 'Transaction', preSimulationTransaction: transaction(1n) },
			{ type: 'TimeManipulation', blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 5n, deltaUnit: 'Seconds' } },
			{ type: 'Transaction', preSimulationTransaction: transaction(2n) },
		] }))
		const settingsSnapshot = await getSettings()
		await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, false)
		const capturedInput = await getCurrentSimulationInput(undefined, settingsSnapshot)
		const capturedOverrides = getSimulationOverridesForPreview(SIMULATION_STACK, settingsSnapshot)
		assert.equal(capturedInput.length, 2)
		for (const block of capturedInput) {
			assert.equal(block.stateOverrides[addressString(activeAddress)]?.code, undefined)
		}
		assert.equal(isCodeClearedBySimulationOverrides(capturedOverrides, activeAddress), true)
		assert.notEqual(getSimulationInputHash({ kind: 'simulated', value: capturedInput, simulationOverrides: capturedOverrides }), getSimulationInputHash({ kind: 'simulated', value: capturedInput, simulationOverrides: {} }))
		const parentBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
		if ('error' in parentBlockResponse) throw new Error(parentBlockResponse.error.message)
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getBlockByNumber') throw new Error(`Unexpected RPC method ${ request.method }`)
				return parentBlockResponse.result
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		const rpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input({ kind: 'simulated', value: capturedInput, simulationOverrides: capturedOverrides }, 1n, undefined)).request)
		assert.equal(rpcInput.params[0].blockStateCalls.length, 2)
		assert.equal(rpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(rpcInput.params[0].blockStateCalls[1]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		const parentBlock = EthereumBlockHeader.parse(parentBlockResponse.result)
		if (parentBlock === null) throw new Error('Expected a parent block')
		const firstBlock = capturedInput[0]
		if (firstBlock === undefined) throw new Error('Expected the first simulation block')
		const firstTransaction = transaction(1n)
		const secondTransaction = transaction(2n)
		const overfullInput = [{ ...firstBlock, transactions: [
			{ ...firstTransaction, signedTransaction: { ...firstTransaction.signedTransaction, gas: parentBlock.gasLimit } },
			{ ...secondTransaction, signedTransaction: { ...secondTransaction.signedTransaction, gas: parentBlock.gasLimit } },
		] }]
		const splitRpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input({ kind: 'simulated', value: overfullInput, simulationOverrides: capturedOverrides }, 1n, undefined)).request)
		assert.equal(splitRpcInput.params[0].blockStateCalls.length, 2)
		assert.equal(splitRpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(splitRpcInput.params[0].blockStateCalls[1]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		const appended = appendTransactionsToInput(capturedInput, [transaction(3n)])
		assert.equal(appended[2]?.stateOverrides[addressString(activeAddress)]?.code, undefined)
		const appendedRpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input({ kind: 'simulated', value: appended, simulationOverrides: capturedOverrides }, 1n, undefined)).request)
		assert.equal(appendedRpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(appendedRpcInput.params[0].blockStateCalls[2]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		const governanceInput = getGovernanceExecutionSimulationInput(capturedInput, transaction(4n), new Date('2026-01-01T00:01:00Z'), {})
		assert.equal(governanceInput[2]?.stateOverrides[addressString(activeAddress)]?.code, undefined)
		const governanceRpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input({ kind: 'simulated', value: governanceInput, simulationOverrides: capturedOverrides }, 1n, undefined)).request)
		assert.equal(governanceRpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(governanceRpcInput.params[0].blockStateCalls[2]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		const currentInput = await getCurrentSimulationInput()
		assert.equal(currentInput[0]?.stateOverrides[addressString(activeAddress)]?.code, undefined)
		assert.equal(currentInput[1]?.stateOverrides[addressString(activeAddress)]?.code, undefined)
		assert.equal(getSimulationInputHash(createSimulatedExecutionInput(currentInput)), getSimulationInputHash(createSimulatedExecutionInput(capturedInput)))
	})

	test('uses clearing during balance and nonce preparation simulations', async () => {
		const parentBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
		if ('error' in parentBlockResponse) throw new Error(parentBlockResponse.error.message)
		const simulationOverrides = { [addressString(activeAddress)]: { code: new Uint8Array() } }
		for (const transactions of [[transaction(1n)], [transaction(1n), transaction(2n)]]) {
			const requests: EthSimulateV1Params[] = []
			const ethereum = new EthereumClientService({
				rpcUrl: rpcEntry.httpsRpc,
				clearCache() { return undefined },
				async jsonRpcRequest(request) {
					if (request.method === 'eth_getBlockByNumber') return parentBlockResponse.result
					if (request.method === 'eth_getBalance') return '0x0'
					if (request.method === 'eth_simulateV1') {
						requests.push(request)
						throw new Error('Captured preparation request')
					}
					throw new Error(`Unexpected RPC method ${ request.method }`)
				},
			}, async () => undefined, async () => undefined, rpcEntry)
			const input = [{ stateOverrides: {}, transactions, signedMessages: [], blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION, simulateWithZeroBaseFee: false }]
			await assert.rejects(prepareSimulationInputForRpc({ kind: 'simulated', value: input, simulationOverrides }, ethereum), /Captured preparation request/)
			assert.equal(requests.length, 1)
			const request = serialize(EthSimulateV1Params, requests[0])
			assert.equal(request.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		}
	})

	test('allows a previously visible option to be enabled when RPC becomes unavailable', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		const settings = await getSettings()
		let rpcAvailable = true
		let codeRequests = 0
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				codeRequests += 1
				if (!rpcAvailable) throw new Error('RPC unavailable')
				return `0xef0100${ addressString(delegate).slice(2) }`
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		const services = { ethereum, tokenPriceService: new TokenPriceService(ethereum, 60000) }
		const requestReply = await requestDelegateClearing(settings, ethereum, activeAddress, rpcEntry.chainId)
		assert.deepEqual(requestReply.data.status, { type: 'delegated', delegate })
		rpcAvailable = false
		const toggleReply = await setDelegateClearing(settings, services, activeAddress, rpcEntry.chainId, true)
		assert.deepEqual(toggleReply.data, { ok: true, address: activeAddress, chainId: rpcEntry.chainId, enabled: true })
		assert.equal(await isDelegateClearingEnabled(activeAddress, rpcEntry.chainId), true)
		assert.equal(codeRequests, 1)
	})

	test('reads the delegation hint only from a service whose endpoint the shared RPC change rule calls unchanged', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		const settings = await getSettings()
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const providerEntries = [
			{ description: 'the selected entry', entry: rpcEntry },
			{ description: 'the same endpoint under other list metadata', entry: { ...rpcEntry, name: 'Renamed entry', primary: true, minimized: true } },
			{ description: 'another URL on the same chain', entry: { ...rpcEntry, httpsRpc: 'https://other-delegation-test.invalid' } },
			{ description: 'the same URL on another chain', entry: { ...rpcEntry, chainId: rpcEntry.chainId + 1n } },
		]
		for (const { description, entry } of providerEntries) {
			let codeRequests = 0
			const ethereum = new EthereumClientService({
				rpcUrl: entry.httpsRpc,
				clearCache() { return undefined },
				async jsonRpcRequest(request) {
					if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
					codeRequests += 1
					return `0xef0100${ addressString(delegate).slice(2) }`
				},
			}, async () => undefined, async () => undefined, entry)
			const endpointChanged = getRpcNetworkChange(settings.activeRpcNetwork, entry).endpointChanged
			const reply = await requestDelegateClearing(settings, ethereum, activeAddress, rpcEntry.chainId)
			assert.deepEqual(reply.data.status, endpointChanged ? { type: 'unknown' } : { type: 'delegated', delegate }, description)
			assert.equal(codeRequests, endpointChanged ? 0 : 1, description)
		}
		assert.deepEqual(providerEntries.map(({ entry }) => getRpcNetworkChange(settings.activeRpcNetwork, entry).endpointChanged), [false, false, true, true])
		const signerOnlyNetwork: RpcNetwork = { httpsRpc: undefined, chainId: rpcEntry.chainId, name: 'Signer only', currencyName: 'Ether?', currencyTicker: 'ETH?', primary: false, minimized: true }
		const signerOnlySettings = { ...settings, activeRpcNetwork: signerOnlyNetwork }
		const fallbackEthereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) { throw new Error(`Unexpected RPC method ${ request.method }`) },
		}, async () => undefined, async () => undefined, rpcEntry)
		assert.deepEqual((await requestDelegateClearing(signerOnlySettings, fallbackEthereum, activeAddress, rpcEntry.chainId)).data.status, { type: 'unknown' })
	})

	// A JSON-RPC node whose account code the test controls, so hint and simulation reads go through the service's real RPC response cache.
	const startCodeServer = (initialCode: ReadonlyMap<bigint, string>) => {
		const codeByAddress = new Map(Array.from(initialCode, ([address, code]) => [addressString(address), code] as const))
		const latestBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
		if ('error' in latestBlockResponse) throw new Error(latestBlockResponse.error.message)
		let codeRequests = 0
		let heldAnswer: { readonly code: string, readonly released: Promise<void>, readonly markStarted: () => void } | undefined
		const server = Bun.serve({
			hostname: '127.0.0.1', port: 0,
			async fetch(request) {
				const message: unknown = await request.json()
				if (typeof message !== 'object' || message === null || !('id' in message) || !('method' in message) || !('params' in message) || !Array.isArray(message.params)) throw new Error('Missing fixture request fields')
				if (message.method === 'eth_getBlockByNumber') return Response.json({ jsonrpc: '2.0', id: message.id, result: latestBlockResponse.result })
				if (message.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ String(message.method) }`)
				codeRequests += 1
				const held = heldAnswer
				heldAnswer = undefined
				if (held === undefined) return Response.json({ jsonrpc: '2.0', id: message.id, result: codeByAddress.get(String(message.params[0])) ?? '0x' })
				held.markStarted()
				await held.released
				return Response.json({ jsonrpc: '2.0', id: message.id, result: held.code })
			},
		})
		return {
			network: { ...rpcEntry, httpsRpc: `${ server.url }rpc` },
			setCode: (address: bigint, code: string) => { codeByAddress.set(addressString(address), code) },
			getCodeRequests: () => codeRequests,
			// The next eth_getCode request answers with this code, as the node read it then, once the test releases it.
			holdNextCodeRequest: (code: string) => {
				let release = () => undefined
				let markStarted = () => undefined
				const released = new Promise<void>((resolve) => { release = () => resolve() })
				const started = new Promise<void>((resolve) => { markStarted = () => resolve() })
				heldAnswer = { code, released, markStarted }
				return { started, release }
			},
			stop: () => { server.stop(true) },
		}
	}
	const delegatedCode = (delegate: bigint) => `0xef0100${ addressString(delegate).slice(2) }`
	const createPollingEthereum = (network: RpcEntry) => {
		let markNewBlockSeen = () => undefined
		const newBlockSeen = new Promise<void>((resolve) => { markNewBlockSeen = () => resolve() })
		const ethereum = createEthereumClientService(network, async (_blockHeader, _ethereum, isNewBlock) => { if (isNewBlock) markNewBlockSeen() }, async () => undefined)
		// Block polling is the production path that clears the RPC response cache, and the first block it sees counts as new.
		const observeNewBlock = async () => {
			ethereum.setBlockPolling(true)
			await newBlockSeen
		}
		return { ethereum, observeNewBlock }
	}
	// The popup asks for the active simulation account's hint, so each read makes the queried account the active one.
	const requestHint = async (ethereum: EthereumClientService, address: bigint) => (await requestDelegateClearing({ ...await getSettings(), activeSimulationAddress: address }, ethereum, address, rpcEntry.chainId)).data.status

	test('the hint and the simulation read one cached eth_getCode response per block, and a new block refreshes both', async () => {
		installBrowserMock()
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const undelegated = activeAddress + 1n
		const node = startCodeServer(new Map([[activeAddress, delegatedCode(delegate)], [undelegated, '0x']]))
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: node.network })
		const { ethereum, observeNewBlock } = createPollingEthereum(node.network)
		// A simulated transaction's sender delegate is read this way in simulationUpdating.ts.
		const simulationRead = async (address: bigint) => await ethereum.getDelegation(address, 'latest', new AbortController())
		try {
			assert.deepEqual(await Promise.all([requestHint(ethereum, activeAddress), simulationRead(activeAddress), requestHint(ethereum, activeAddress)]), [{ type: 'delegated', delegate }, delegate, { type: 'delegated', delegate }])
			assert.deepEqual(await requestHint(ethereum, undelegated), { type: 'none' })
			assert.equal(await simulationRead(undelegated), undefined)
			assert.equal(node.getCodeRequests(), 2)

			// Within a block both keep reading the same cached code, so they cannot disagree.
			node.setCode(activeAddress, '0x')
			node.setCode(undelegated, delegatedCode(delegate))
			assert.deepEqual(await requestHint(ethereum, activeAddress), { type: 'delegated', delegate })
			assert.equal(await simulationRead(activeAddress), delegate)
			assert.deepEqual(await requestHint(ethereum, undelegated), { type: 'none' })
			assert.equal(await simulationRead(undelegated), undefined)
			assert.equal(node.getCodeRequests(), 2)

			// A new block clears the response cache, which refreshes delegated and undelegated hints alike.
			await observeNewBlock()
			assert.deepEqual(await requestHint(ethereum, activeAddress), { type: 'none' })
			assert.equal(await simulationRead(activeAddress), undefined)
			assert.deepEqual(await requestHint(ethereum, undelegated), { type: 'delegated', delegate })
			assert.equal(await simulationRead(undelegated), delegate)
			assert.equal(node.getCodeRequests(), 4)
		} finally {
			ethereum.cleanup()
			node.stop()
		}
	})

	test('code cached before block polling sleeps is not served after it', async () => {
		installBrowserMock()
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const node = startCodeServer(new Map([[activeAddress, delegatedCode(delegate)]]))
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: node.network })
		const { ethereum, observeNewBlock } = createPollingEthereum(node.network)
		try {
			await observeNewBlock()
			assert.deepEqual(await requestHint(ethereum, activeAddress), { type: 'delegated', delegate })
			node.setCode(activeAddress, '0x')
			assert.deepEqual(await requestHint(ethereum, activeAddress), { type: 'delegated', delegate })
			// Blocks mined while polling sleeps are never observed, so sleeping drops the cached responses.
			ethereum.setBlockPolling(false)
			assert.deepEqual(await requestHint(ethereum, activeAddress), { type: 'none' })
			assert.equal(node.getCodeRequests(), 2)
		} finally {
			ethereum.cleanup()
			node.stop()
		}
	})

	test('a hint read that a new block overtakes does not fill the new block\'s cache', async () => {
		installBrowserMock()
		const staleDelegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const node = startCodeServer(new Map([[activeAddress, '0x']]))
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: node.network })
		const { ethereum, observeNewBlock } = createPollingEthereum(node.network)
		try {
			const heldRead = node.holdNextCodeRequest(delegatedCode(staleDelegate))
			const pendingHint = requestHint(ethereum, activeAddress)
			await heldRead.started
			await observeNewBlock()
			heldRead.release()
			// The overtaken read answers for the block it was made in; the popup reads again on the new block.
			assert.deepEqual(await pendingHint, { type: 'delegated', delegate: staleDelegate })
			assert.deepEqual(await requestHint(ethereum, activeAddress), { type: 'none' })
			assert.deepEqual(await ethereum.getCode(activeAddress, 'latest', undefined), new Uint8Array())
			assert.equal(node.getCodeRequests(), 2)
		} finally {
			ethereum.cleanup()
			node.stop()
		}
	})

	test('a hint read sharing a simulation read survives the simulation cancelling it', async () => {
		installBrowserMock()
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const node = startCodeServer(new Map([[activeAddress, delegatedCode(delegate)]]))
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: node.network })
		const ethereum = createEthereumClientService(node.network, async () => undefined, async () => undefined)
		const heldRead = node.holdNextCodeRequest(delegatedCode(delegate))
		try {
			const simulationAbortController = new AbortController()
			const simulationRead = ethereum.getDelegation(activeAddress, 'latest', simulationAbortController)
			await heldRead.started
			const pendingHint = requestHint(ethereum, activeAddress)
			simulationAbortController.abort(new Error('Simulation replaced'))
			await assert.rejects(simulationRead, /Simulation replaced/u)
			assert.deepEqual(await pendingHint, { type: 'delegated', delegate })
			assert.equal(node.getCodeRequests(), 2)
		} finally {
			heldRead.release()
			ethereum.cleanup()
			node.stop()
		}
	})

	test('reuses the hint across popup opens and toggles within a block, and a replacement service reads it again', async () => {
		installBrowserMock()
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const node = startCodeServer(new Map([[activeAddress, delegatedCode(delegate)]]))
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: node.network })
		const owner = createSimulationServicesOwner(node.network, async () => undefined, async (_ethereum, error) => { throw error })
		try {
			const services = owner.getCurrent()
			assert.deepEqual(await requestHint(services.ethereum, activeAddress), { type: 'delegated', delegate })
			node.setCode(activeAddress, '0x')
			assert.deepEqual(await requestHint(services.ethereum, activeAddress), { type: 'delegated', delegate })
			const toggleReply = await setDelegateClearing(await getSettings(), services, activeAddress, rpcEntry.chainId, true)
			assert.deepEqual(toggleReply.data, { ok: true, address: activeAddress, chainId: rpcEntry.chainId, enabled: true })
			assert.equal(node.getCodeRequests(), 1)
			// A replacement service owns a new RPC response cache, so the hint is read from the node again.
			const replacement = owner.reset(node.network).ethereum
			assert.deepEqual(await requestHint(replacement, activeAddress), { type: 'none' })
			assert.equal(node.getCodeRequests(), 2)
		} finally {
			owner.getCurrent().ethereum.cleanup()
			node.stop()
		}
	})

	test('disables a saved choice after simulation mode or the active account changes', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest() { throw new Error('Disabling must not query RPC') },
		}, async () => undefined, async () => undefined, rpcEntry)
		const services = { ethereum, tokenPriceService: new TokenPriceService(ethereum, 60000) }
		for (const switched of [
			{ simulationMode: false, activeSimulationAddress: activeAddress },
			{ simulationMode: true, activeSimulationAddress: activeAddress + 1n },
			{ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: { ...rpcEntry, chainId: rpcEntry.chainId + 1n } },
		]) {
			await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true)
			await changeSimulationMode(switched)
			const reply = await setDelegateClearing(await getSettings(), services, activeAddress, rpcEntry.chainId, false)
			assert.deepEqual(reply.data, { ok: true, address: activeAddress, chainId: rpcEntry.chainId, enabled: false })
			assert.equal(await isDelegateClearingEnabled(activeAddress, rpcEntry.chainId), false)
		}
	})

	test('does not cache a failed delegation lookup as no delegate', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		let codeRequests = 0
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				codeRequests += 1
				if (codeRequests === 1) throw new TypeError('Failed to fetch')
				return '0x'
			},
		}, async () => undefined, async () => undefined, rpcEntry)

		assert.deepEqual(await requestHint(ethereum, activeAddress), { type: 'unknown' })
		assert.deepEqual(await requestHint(ethereum, activeAddress), { type: 'none' })
		assert.equal(codeRequests, 2)
	})

	test('saving delegate clearing does not wait for a pending hint lookup', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		let releaseCode: (code: string) => void = () => undefined
		const pendingCode = new Promise<string>((resolve) => { releaseCode = resolve })
		let codeRequests = 0
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				codeRequests += 1
				return await pendingCode
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		const services = { ethereum, tokenPriceService: new TokenPriceService(ethereum, 60000) }
		const pendingHint = requestHint(ethereum, activeAddress)
		const enabling = setDelegateClearing(await getSettings(), services, activeAddress, rpcEntry.chainId, true)
		assert.deepEqual((await enabling).data, { ok: true, address: activeAddress, chainId: rpcEntry.chainId, enabled: true })
		releaseCode('0x')
		assert.deepEqual(await pendingHint, { type: 'none' })
		assert.equal(codeRequests, 1)
	})

	const createCapturingEthereum = () => {
		const parentBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
		if ('error' in parentBlockResponse) throw new Error(parentBlockResponse.error.message)
		const parentBlock = EthereumBlockHeader.parse(parentBlockResponse.result)
		if (parentBlock === null) throw new Error('Expected a parent block')
		const ethSimulateRequests: EthSimulateV1Params[] = []
		const otherMethods: string[] = []
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method === 'eth_getBlockByNumber') return parentBlockResponse.result
				if (request.method === 'eth_simulateV1') {
					ethSimulateRequests.push(request)
					throw new Error('Captured simulation request')
				}
				otherMethods.push(request.method)
				if (request.method === 'eth_getTransactionCount') return '0x0'
				if (request.method === 'eth_blockNumber') return `0x${ parentBlock.number.toString(16) }`
				throw new Error(`Unexpected RPC method ${ request.method }`)
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		const lastRequestCodes = () => serialize(EthSimulateV1Params, ethSimulateRequests.at(-1)).params[0].blockStateCalls.map((block) => block.stateOverrides?.[addressString(activeAddress)]?.code)
		return { ethereum, parentBlock, ethSimulateRequests, otherMethods, lastRequestCodes }
	}
	const clearedCode = { [addressString(activeAddress)]: { code: new Uint8Array() } }
	const callFromActiveAddress = { from: activeAddress, to: activeAddress + 1n, value: 0n, input: new Uint8Array(), maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }

	test('a call appended after the simulation prefix gets initial state only when the prefix is empty', async () => {
		const { ethereum, lastRequestCodes } = createCapturingEthereum()
		await assert.rejects(simulatedCallFromInput(ethereum, undefined, createSimulatedExecutionInput([], clearedCode), callFromActiveAddress), /Captured simulation request/)
		assert.deepEqual(lastRequestCodes(), ['0x'])
		const stack = appendTransactionsToInput([], [transaction(1n)])
		await assert.rejects(simulatedCallFromInput(ethereum, undefined, createSimulatedExecutionInput(stack, clearedCode), callFromActiveAddress), /Captured simulation request/)
		assert.deepEqual(lastRequestCodes(), ['0x', undefined])
	})

	test('a website eth_simulateV1 first block gets initial state only when no stack block precedes it', async () => {
		const { ethereum, lastRequestCodes } = createCapturingEthereum()
		const websiteRequest: EthSimulateV1Params = { method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls: [] }] }] }
		await assert.rejects(ethSimulateV1FromInput(ethereum, undefined, createSimulatedExecutionInput([], clearedCode), websiteRequest), /Captured simulation request/)
		assert.deepEqual(lastRequestCodes(), ['0x'])
		const stack = appendTransactionsToInput([], [transaction(1n)])
		await assert.rejects(ethSimulateV1FromInput(ethereum, undefined, createSimulatedExecutionInput(stack, clearedCode), websiteRequest), /Captured simulation request/)
		assert.deepEqual(lastRequestCodes(), ['0x', undefined])
	})

	test('the balance before a transaction comes from initial state only in the input\'s first block', async () => {
		const { ethereum, parentBlock, ethSimulateRequests, otherMethods } = createCapturingEthereum()
		const initialBalance = 10n ** 18n
		const initialState = { [addressString(activeAddress)]: { balance: initialBalance } }
		const [currentBlock] = appendTransactionsToInput([], [transaction(1n)])
		if (currentBlock === undefined) throw new Error('Expected a simulation block')
		const { balances } = await getBaseFeeAdjustmentBalances(ethereum, undefined, parentBlock, createSimulatedExecutionInput([], initialState), currentBlock)
		assert.equal(balances.get(1n), initialBalance)
		assert.equal(ethSimulateRequests.length, 0)
		assert.deepEqual(otherMethods, [])
		const blocksBefore = appendTransactionsToInput([], [transaction(2n)])
		await assert.rejects(getBaseFeeAdjustmentBalances(ethereum, undefined, parentBlock, createSimulatedExecutionInput(blocksBefore, initialState), currentBlock), /Captured simulation request/)
		assert.equal(ethSimulateRequests.length, 1)
	})

	test('an idle stack reads cleared code from initial state while a non-empty stack simulates the read', async () => {
		const { ethereum, ethSimulateRequests, otherMethods } = createCapturingEthereum()
		assert.deepEqual(await getSimulatedCodeFromInput(ethereum, undefined, createSimulatedExecutionInput([], clearedCode), activeAddress), { statusCode: 'success', getCodeReturn: new Uint8Array() })
		assert.equal(ethSimulateRequests.length, 0)
		assert.deepEqual(otherMethods, [])
		const stack = appendTransactionsToInput([], [transaction(1n)])
		await assert.rejects(getSimulatedCodeFromInput(ethereum, undefined, createSimulatedExecutionInput(stack, clearedCode), activeAddress), /Captured simulation request/)
		assert.equal(ethSimulateRequests.length, 1)
	})

	const onChainDelegate = 0x0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0dn
	const restoredDelegate = 0xd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dn
	const codeReaderAddress = 0x1ce438391307f908756fefe0fe220c0f0d51508an
	const codeReaderAbi = [{ type: 'function', name: 'at', stateMutability: 'view', inputs: [{ name: 'target', type: 'address' }], outputs: [{ name: 'code', type: 'bytes' }] }] as const
	const delegationDesignator = (delegate: bigint) => `0xef0100${ addressString(delegate).slice(2) }`
	// The delegated account signs its own authorizations, so its key is known to the tests.
	const delegatedAccountKey = `0x${ '22'.repeat(32) }`
	const delegatedAccount = BigInt(addr.fromPrivateKey(delegatedAccountKey))
	const otherAccountKey = `0x${ '33'.repeat(32) }`
	const clearedDelegatedAccount = { [addressString(delegatedAccount)]: { code: new Uint8Array() } }
	type SignedAuthorization = { chainId: bigint, address: bigint, nonce: bigint, r: bigint, s: bigint, yParity: 'even' | 'odd', authority?: bigint }
	const signAuthorization = (delegate: bigint, nonce: bigint, signerKey = delegatedAccountKey): SignedAuthorization => {
		const signed = eip7702Signing.sign({ chainId: rpcEntry.chainId, address: addressString(delegate), nonce }, signerKey)
		return { chainId: rpcEntry.chainId, address: delegate, nonce, r: signed.r, s: signed.s, yParity: signed.yParity === 0 ? 'even' : 'odd', authority: BigInt(addr.fromPrivateKey(signerKey)) }
	}
	const delegatedAccountCall = (identifier: bigint, authorizationList: readonly SignedAuthorization[] = []) => ({
		...transaction(identifier),
		signedTransaction: authorizationList.length === 0
			? mockSignTransaction({ type: '1559', from: delegatedAccount, to: delegatedAccount, value: 0n, input: new Uint8Array(), nonce: identifier - 1n, gas: 50_000n, chainId: rpcEntry.chainId, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
			: mockSignTransaction({ type: '7702', from: delegatedAccount, to: delegatedAccount, value: 0n, input: new Uint8Array(), nonce: identifier - 1n, gas: 100_000n, chainId: rpcEntry.chainId, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, authorizationList }),
	})
	// Sent by another account, so only its authorizations can change the delegated account.
	const sponsoredTransaction = (identifier: bigint, authorizationList: readonly SignedAuthorization[]) => ({
		...transaction(identifier),
		signedTransaction: mockSignTransaction({ type: '7702', from: activeAddress, to: activeAddress, value: 0n, input: new Uint8Array(), nonce: identifier - 1n, gas: 100_000n, chainId: rpcEntry.chainId, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, authorizationList }),
	})
	const blockOf = (transactions: readonly ReturnType<typeof delegatedAccountCall>[]) => ({ stateOverrides: {}, transactions, signedMessages: [], blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION, simulateWithZeroBaseFee: false })

	// A stand-in for the node: answers each code read with what the node reports for the account after the request's prefix (the calls before the code reader's block), and records every read. Address identification probes get a JSON-RPC error, their handled outcome.
	type PrefixCall = EthSimulateV1Params['params'][0]['blockStateCalls'][number]['calls'][number]
	const createFakeNode = (nodeCode: (prefixCalls: readonly PrefixCall[], account: bigint) => string) => {
		const parentBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
		if ('error' in parentBlockResponse) throw new Error(parentBlockResponse.error.message)
		const simulatedBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_simulateV1_dummy_call_result))
		if ('error' in simulatedBlockResponse || !Array.isArray(simulatedBlockResponse.result)) throw new Error('Expected a simulated block fixture')
		const [simulatedBlockTemplate] = simulatedBlockResponse.result
		const parentBlock = EthereumBlockHeader.parse(parentBlockResponse.result)
		if (parentBlock === null) throw new Error('Expected a parent block')
		const codeReads: { readonly account: bigint, readonly prefixCallCount: number }[] = []
		const nonceLookups: bigint[] = []
		const callResult = (returnData: string) => ({ returnData, logs: [], gasUsed: '0x5208', status: '0x1' })
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method === 'eth_getBlockByNumber') return parentBlockResponse.result
				if (request.method === 'eth_blockNumber') return `0x${ parentBlock.number.toString(16) }`
				if (request.method === 'eth_getTransactionCount') {
					nonceLookups.push(request.params[0])
					return '0x0'
				}
				if (request.method === 'eth_getCode') return request.params[0] === delegatedAccount ? delegationDesignator(onChainDelegate) : '0x'
				if (request.method === 'eth_simulateV1') {
					const blockStateCalls = request.params[0].blockStateCalls
					const readerCall = blockStateCalls.at(-1)?.calls[0]
					if (readerCall?.to !== codeReaderAddress || readerCall.input === undefined) throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } })
					const account = BigInt(`0x${ dataStringWith0xStart(readerCall.input).slice(-40) }`)
					const prefixCalls = blockStateCalls.slice(0, -1).flatMap((block) => block.calls)
					codeReads.push({ account, prefixCallCount: prefixCalls.length })
					return blockStateCalls.map((block, blockIndex) => ({
						...simulatedBlockTemplate,
						calls: blockIndex === blockStateCalls.length - 1 ? [callResult(encodeFunctionReturn(codeReaderAbi, 'at', [nodeCode(prefixCalls, account)]))] : block.calls.map(() => callResult('0x')),
					}))
				}
				throw new Error(`Unexpected RPC method ${ request.method }`)
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		return { ethereum, codeReads, nonceLookups }
	}
	const stateBase = {
		blockNumber: 1n,
		blockTimestamp: new Date('2026-01-01T00:00:00Z'),
		baseFeePerGas: 1n,
		simulationConductedTimestamp: new Date('2026-01-01T00:00:00Z'),
		rpcNetwork: rpcEntry,
	}
	const successfulStateOf = (transactions: readonly ReturnType<typeof delegatedAccountCall>[], simulationOverrides: StateOverrides): SimulationState => ({
		...stateBase,
		success: true,
		simulationStateInput: [blockOf(transactions)],
		simulationOverrides,
		simulatedBlocks: [{
			stateOverrides: simulationOverrides,
			simulatedTransactions: transactions.map((preSimulationTransaction) => ({
				realizedGasPrice: 1n,
				preSimulationTransaction,
				ethSimulateV1CallResult: { status: 'success', returnData: new Uint8Array(), gasUsed: 21_000n, logs: [] },
				tokenBalancesAfter: [],
			})),
			signedMessages: [],
			blockTimestamp: new Date('2026-01-01T00:00:12Z'),
			blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
			blockBaseFeePerGas: 1n,
		}],
	})
	const visualizedDelegatesOf = async (simulationState: SimulationState, nodeCode: (prefixCalls: readonly PrefixCall[], account: bigint) => string) => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		const fakeNode = createFakeNode(nodeCode)
		// The recovered identification probes log warnings, which are not under test here.
		const originalConsole = { warn: console.warn, error: console.error }
		console.warn = () => undefined
		console.error = () => undefined
		const visualized = await (async () => {
			try {
				return await visualizeSimulatorState(simulationState, fakeNode.ethereum, new TokenPriceService(fakeNode.ethereum, 60000), undefined)
			} finally {
				console.warn = originalConsole.warn
				console.error = originalConsole.error
			}
		})()
		const delegates = visualized.visualizedSimulationState.visualizedBlocks.flatMap((block) => block.simulatedAndVisualizedTransactions.map((visualizedTransaction) => visualizedTransaction.transaction.delegationAddress?.address))
		return { delegates, codeReads: fakeNode.codeReads, nonceLookups: fakeNode.nonceLookups }
	}
	// Reads run in parallel, so they are compared in account order.
	const sortedReads = (reads: readonly { readonly account: bigint, readonly prefixCallCount: number }[]) => [...reads].sort((first, second) => first.account < second.account ? -1 : first.account > second.account ? 1 : 0)
	const authorizationNonceInPrefix = (prefixCalls: readonly PrefixCall[]) => prefixCalls.flatMap((call) => call.authorizationList ?? []).at(-1)?.nonce

	test('after a delegated CREATE the node skips a sponsored authorization with the stale nonce and applies the correct one, and the display follows it', async () => {
		// The account's first call runs its delegate's CREATE, so the node raises its nonce from 0 to 2 (the call and the creation); only an authorization with nonce 2 applies.
		const nodeCode = (prefixCalls: readonly PrefixCall[], account: bigint) => account !== delegatedAccount ? '0x' : delegationDesignator(authorizationNonceInPrefix(prefixCalls) === 2n ? restoredDelegate : onChainDelegate)
		for (const [nonce, expectedAfter] of [[1n, onChainDelegate], [2n, restoredDelegate]] as const) {
			const result = await visualizedDelegatesOf(successfulStateOf([delegatedAccountCall(1n), sponsoredTransaction(2n, [signAuthorization(restoredDelegate, nonce)]), delegatedAccountCall(3n)], {}), nodeCode)
			assert.deepEqual(result.delegates, [onChainDelegate, undefined, expectedAfter])
			// One read per account sending from the authorizing transaction on (the sponsor sends it, the delegated account the next one), each right after it; the delegated account's nonce is never looked up (the code reader only looks up its own sender's).
			assert.deepEqual(sortedReads(result.codeReads), sortedReads([{ account: activeAddress, prefixCallCount: 2 }, { account: delegatedAccount, prefixCallCount: 2 }]))
			assert.equal(result.nonceLookups.includes(delegatedAccount), false)
		}
	})

	test('a cleared account shows the delegate the node reports after its re-authorization, read once for all later transactions', async () => {
		const result = await visualizedDelegatesOf(successfulStateOf([delegatedAccountCall(1n), delegatedAccountCall(2n, [signAuthorization(restoredDelegate, 2n)]), delegatedAccountCall(3n)], clearedDelegatedAccount), (_prefixCalls, account) => account === delegatedAccount ? delegationDesignator(restoredDelegate) : '0x')
		assert.deepEqual(result.delegates, [undefined, restoredDelegate, restoredDelegate])
		assert.deepEqual(result.codeReads, [{ account: delegatedAccount, prefixCallCount: 2 }])
	})

	test('without any authorization in the stack nothing is read: a cleared account shows no delegate and an uncleared one its on-chain delegate', async () => {
		const cleared = await visualizedDelegatesOf(successfulStateOf([delegatedAccountCall(1n), delegatedAccountCall(2n)], clearedDelegatedAccount), () => { throw new Error('No code read expected') })
		assert.deepEqual(cleared.delegates, [undefined, undefined])
		assert.deepEqual(cleared.codeReads, [])
		const uncleared = await visualizedDelegatesOf(successfulStateOf([delegatedAccountCall(1n), delegatedAccountCall(2n)], {}), () => { throw new Error('No code read expected') })
		assert.deepEqual(uncleared.delegates, [onChainDelegate, onChainDelegate])
		assert.deepEqual(uncleared.codeReads, [])
	})

	test('a malleated high-s authorization keeps the delegate the node reports, while the original applies', async () => {
		// A real signature malleated the standard way (s becomes n - s, yParity flips) still normalizes to the same authority; the node rejects it.
		const original = signAuthorization(restoredDelegate, 0n)
		const [malleated] = await normalizeEip7702AuthorizationList([{ ...original, authority: undefined, s: secp256k1.CURVE.n - original.s, yParity: original.yParity === 'even' ? 'odd' : 'even' }])
		if (malleated === undefined || malleated.r === undefined || malleated.s === undefined || malleated.yParity === undefined) throw new Error('Expected a signed malleated authorization')
		assert.equal(malleated.authority, delegatedAccount)
		const nodeCode = (prefixCalls: readonly PrefixCall[], account: bigint) => account !== delegatedAccount ? '0x' : delegationDesignator(prefixCalls.flatMap((call) => call.authorizationList ?? []).some((authorization) => authorization.s !== undefined && authorization.s <= secp256k1.CURVE.n / 2n) ? restoredDelegate : onChainDelegate)
		const malleatedResult = await visualizedDelegatesOf(successfulStateOf([sponsoredTransaction(1n, [{ ...malleated, r: malleated.r, s: malleated.s, yParity: malleated.yParity }]), delegatedAccountCall(2n)], {}), nodeCode)
		assert.deepEqual(malleatedResult.delegates, [undefined, onChainDelegate])
		const originalResult = await visualizedDelegatesOf(successfulStateOf([sponsoredTransaction(1n, [original]), delegatedAccountCall(2n)], {}), nodeCode)
		assert.deepEqual(originalResult.delegates, [undefined, restoredDelegate])
	})

	test('authority metadata naming an account the signature does not recover leaves that account with the delegate the node reports', async () => {
		// Signed by another account, as an imported file may carry next to metadata naming the delegated account; the node only changes the signer.
		const otherSigned = { ...signAuthorization(restoredDelegate, 0n, otherAccountKey), authority: delegatedAccount }
		const otherAccount = BigInt(addr.fromPrivateKey(otherAccountKey))
		const nodeCode = (prefixCalls: readonly PrefixCall[], account: bigint) => {
			const changesAccount = prefixCalls.flatMap((call) => call.authorizationList ?? []).some((authorization) => authorization.r !== undefined && authorization.s !== undefined && authorization.yParity !== undefined
				&& BigInt(eip7702Signing.getAuthority({ chainId: authorization.chainId, address: addressString(authorization.address), nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity === 'even' ? 0 : 1 })) === account)
			return changesAccount ? delegationDesignator(restoredDelegate) : account === delegatedAccount ? delegationDesignator(onChainDelegate) : '0x'
		}
		const result = await visualizedDelegatesOf(successfulStateOf([sponsoredTransaction(1n, [otherSigned]), delegatedAccountCall(2n)], {}), nodeCode)
		assert.deepEqual(result.delegates, [undefined, onChainDelegate])
		assert.deepEqual(sortedReads(result.codeReads), sortedReads([{ account: activeAddress, prefixCallCount: 1 }, { account: delegatedAccount, prefixCallCount: 1 }]))
		assert.notEqual(otherAccount, delegatedAccount)
	})

	test('a failed visualised stack reads delegates from the simulation the same way', async () => {
		const failedState: SimulationState = {
			...stateBase,
			success: false,
			simulationStateInput: [blockOf([delegatedAccountCall(1n), delegatedAccountCall(2n, [signAuthorization(restoredDelegate, 2n)]), delegatedAccountCall(3n)])],
			simulationOverrides: clearedDelegatedAccount,
			jsonRpcError: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Simulation failed' } },
		}
		const result = await visualizedDelegatesOf(failedState, (_prefixCalls, account) => account === delegatedAccount ? delegationDesignator(restoredDelegate) : '0x')
		assert.deepEqual(result.delegates, [undefined, restoredDelegate, restoredDelegate])
	})

	test('a failed code read shows no delegate rather than a guess', async () => {
		const result = await visualizedDelegatesOf(successfulStateOf([delegatedAccountCall(1n), delegatedAccountCall(2n, [signAuthorization(restoredDelegate, 1n)]), delegatedAccountCall(3n)], {}), () => { throw new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } }) })
		assert.deepEqual(result.delegates, [onChainDelegate, undefined, undefined])
	})

	const createExportEthereum = () => {
		const parentBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
		if ('error' in parentBlockResponse) throw new Error(parentBlockResponse.error.message)
		const parentBlock = EthereumBlockHeader.parse(parentBlockResponse.result)
		if (parentBlock === null) throw new Error('Expected a parent block')
		return new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method === 'eth_getBlockByNumber') return parentBlockResponse.result
				if (request.method === 'eth_blockNumber') return `0x${ parentBlock.number.toString(16) }`
				throw new Error(`Unexpected RPC method ${ request.method }`)
			},
		}, async () => undefined, async () => undefined, rpcEntry)
	}

	const exportBlockStateCalls = async (ethereum: EthereumClientService) => {
		// Imported once the browser mock is installed, since the module loads the WebExtension polyfill.
		const { requestInterceptorSimulationInput } = await import('../../app/ts/background/popupMessageHandlers.js')
		const reply = await requestInterceptorSimulationInput(ethereum)
		if (!reply.ok) throw new Error(reply.message)
		const exported = InterceptorSimulationExport.parse(JSON.parse(reply.ethSimulateV1InputString))
		return serialize(EthSimulateV1Params, exported.eth_simulateV1).params[0].blockStateCalls
	}

	test('exports the cleared delegate code in the eth_simulateV1 request even with an empty stack', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true)
		assert.equal((await getCurrentSimulationInput()).length, 0)
		const blockStateCalls = await exportBlockStateCalls(createExportEthereum())
		assert.equal(blockStateCalls.length, 1)
		assert.deepEqual(blockStateCalls[0]?.calls, [])
		assert.deepEqual(blockStateCalls[0]?.stateOverrides, { [addressString(activeAddress)]: { code: '0x' } })
	})

	test('exports a non-empty stack with the cleared delegate code on its first block and no extra block', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true)
		await updateInterceptorTransactionStack(() => ({ operations: [{ type: 'Transaction', preSimulationTransaction: transaction(1n) }] }))
		const blockStateCalls = await exportBlockStateCalls(createExportEthereum())
		assert.equal(blockStateCalls.length, 1)
		assert.equal(blockStateCalls[0]?.calls.length, 1)
		assert.equal(blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
	})

	test('emits initial account state of an input without blocks as one call-less block, and nothing without it', async () => {
		installBrowserMock()
		const ethereum = createExportEthereum()
		const simulationOverrides = { [addressString(activeAddress)]: { code: new Uint8Array() } }
		const prepared = await ethereum.prepareEthSimulateV1Input({ kind: 'simulated', value: [], simulationOverrides }, 1n, undefined)
		const request = serialize(EthSimulateV1Params, prepared.request)
		assert.equal(request.params[0].blockStateCalls.length, 1)
		assert.deepEqual(request.params[0].blockStateCalls[0]?.calls, [])
		assert.deepEqual(request.params[0].blockStateCalls[0]?.stateOverrides, { [addressString(activeAddress)]: { code: '0x' } })
		assert.equal(prepared.rpcBlocks.length, 1)
		assert.equal(prepared.blockOverrides.length, 1)
		assert.deepEqual(prepared.inputBlocks.map((block) => block.rpcBlockCount), [1])
		const withoutOverrides = await ethereum.prepareEthSimulateV1Input({ kind: 'simulated', value: [], simulationOverrides: {} }, 1n, undefined)
		assert.deepEqual(serialize(EthSimulateV1Params, withoutOverrides.request).params[0].blockStateCalls, [])
		assert.equal(withoutOverrides.rpcBlocks.length, 0)
		assert.equal(withoutOverrides.inputBlocks.length, 0)
	})
})
