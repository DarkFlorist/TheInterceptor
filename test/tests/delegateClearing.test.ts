import * as assert from 'node:assert'
import { describe, setSystemTime, test } from 'bun:test'
import { EthereumClientService, getNextBlockTimeStampOverride } from '../../app/ts/simulation/services/EthereumClientService.js'
import { captureSigningSimulationSnapshot, captureWhatIfSimulationSnapshot, getCurrentSimulationInput, getGovernanceExecutionSimulationInput, getSimulationInputForPurpose, prepareSimulationInputForRpc } from '../../app/ts/background/simulationUpdating.js'
import { getSimulationOverridesForPurpose } from '../../app/ts/background/delegateClearingPolicy.js'
import { createDelegateClearingHintCache } from '../../app/ts/simulation/services/delegateClearingHintCache.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { createEthereumClientService, createSimulationServicesOwner } from '../../app/ts/simulation/serviceLifecycle.js'
import { requestDelegateClearing, setDelegateClearing } from '../../app/ts/background/popupMessageHandlers/delegateClearing.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { changeSimulationMode, isDelegateClearingEnabled, setDelegateClearingEnabled, setMakeCurrentAddressRich } from '../../app/ts/background/settings.js'
import { getSettings } from '../../app/ts/background/settings.js'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { updateInterceptorTransactionStack } from '../../app/ts/background/storageVariables.js'
import { appendTransactionsToInput, createSimulationState, ethSimulateV1FromInput, getSimulatedCode, getSimulatedCodeFromInput, mockSignTransaction, simulatedCallFromInput, simulateEstimateGasFromInput } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { getSimulatedStackV2 } from '../../app/ts/simulation/SimulationStackExtraction.js'
import { getSimulationInputHash } from '../../app/ts/utils/simulationFingerprint.js'
import { isCodeClearedBySimulationOverrides } from '../../app/ts/utils/delegateClearingState.js'
import { getAppendedBlockStateOverrides, mapBlocksWithEffectiveStateOverrides } from '../../app/ts/utils/simulationStateOverrides.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../../app/ts/utils/constants.js'
import { EthSimulateV1Params } from '../../app/ts/types/ethSimulate-types.js'
import { JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import { EthereumBlockHeader, serialize } from '../../app/ts/types/wire-types.js'
import { type SimulationState, SimulationStateInputBlock, createSimulatedInput } from '../../app/ts/types/visualizer-types.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../../app/ts/config/defaults.js'

const activeAddress = 0x1234567890123456789012345678901234567890n
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
		const simulationOverrides = getSimulationOverridesForPurpose('what-if', await getSettings())
		assert.deepEqual(input[0]?.stateOverrides[addressString(activeAddress)], { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value })
		assert.equal(isCodeClearedBySimulationOverrides(simulationOverrides, activeAddress), true)
		assert.deepEqual(getSimulationOverridesForPurpose('signing-or-execution', await getSettings()), {})
		assert.deepEqual((await getSimulationInputForPurpose('signing-or-execution', await getSettings())).simulationOverrides, {})
		const signingSnapshot = await captureSigningSimulationSnapshot()
		assert.deepEqual(signingSnapshot.simulationInput.simulationOverrides, {})
		assert.deepEqual(signingSnapshot.simulationInput.value[0]?.stateOverrides[addressString(activeAddress)], { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value })
		assert.equal(isCodeClearedBySimulationOverrides((await captureWhatIfSimulationSnapshot()).simulationInput.simulationOverrides, activeAddress), true)
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
		assert.equal(isCodeClearedBySimulationOverrides(getSimulationOverridesForPurpose('what-if', await getSettings()), activeAddress + 1n), false)
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: { ...rpcEntry, chainId: rpcEntry.chainId + 1n } })
		assert.equal(isCodeClearedBySimulationOverrides(getSimulationOverridesForPurpose('what-if', await getSettings()), activeAddress), false)

		assert.equal(await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, false), true)
		assert.equal(await isDelegateClearingEnabled(activeAddress, rpcEntry.chainId), false)
	})

	test('applies initial state only to the first block and preserves per-block state later', () => {
		const initial = { [addressString(activeAddress)]: { code: new Uint8Array() } }
		const block = { [addressString(activeAddress)]: { balance: 5n } }
		const mergedFirstBlock = { [addressString(activeAddress)]: { balance: 5n, code: new Uint8Array() } }
		assert.deepEqual(getAppendedBlockStateOverrides([], block, initial), mergedFirstBlock)
		assert.equal(getAppendedBlockStateOverrides([{ stateOverrides: block }], block, initial), block)
		const mapped = mapBlocksWithEffectiveStateOverrides([{ stateOverrides: block }, { stateOverrides: block }], initial, (simulatedBlock) => simulatedBlock.stateOverrides, (_simulatedBlock, effectiveStateOverrides, blockIndex) => ({ effectiveStateOverrides, blockIndex }))
		assert.deepEqual(mapped[0], { effectiveStateOverrides: mergedFirstBlock, blockIndex: 0 })
		assert.equal(mapped[1]?.effectiveStateOverrides, block)
	})

	test('keeps the idle stack empty and clears the first appended transaction and RPC call', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true)
		const input = await getCurrentSimulationInput([])
		const simulationOverrides = getSimulationOverridesForPurpose('what-if', await getSettings())
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
		const idleCode = await getSimulatedCodeFromInput(ethereum, undefined, createSimulatedInput(input, simulationOverrides), activeAddress)
		assert.equal(idleCode.statusCode, 'success')
		if (idleCode.statusCode === 'success') assert.equal(idleCode.getCodeReturn.length, 0)
		const popupCode = await getSimulatedCode(ethereum, undefined, { kind: 'simulated', value: idleState }, activeAddress)
		assert.equal(popupCode.statusCode, 'success')
		if (popupCode.statusCode === 'success') assert.equal(popupCode.getCodeReturn.length, 0)
		const numberedInputCode = await getSimulatedCodeFromInput(ethereum, undefined, createSimulatedInput(input, simulationOverrides), activeAddress, numberedBlockTag)
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
		await assert.rejects(simulatedCallFromInput(ethereum, undefined, createSimulatedInput(input, simulationOverrides), {
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
		await assert.rejects(simulateEstimateGasFromInput(ethereum, undefined, createSimulatedInput(input, simulationOverrides), {
			from: activeAddress,
			to: activeAddress + 1n,
			value: 0n,
			input: new Uint8Array(),
		}), /Captured simulation request/)
		const estimateRequest = serialize(EthSimulateV1Params, ethSimulateRequests[1])
		assert.equal(estimateRequest.params[0].blockStateCalls.length, 1)
		assert.equal(estimateRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		await assert.rejects(ethSimulateV1FromInput(ethereum, undefined, createSimulatedInput(input, simulationOverrides), {
			method: 'eth_simulateV1',
			params: [{ blockStateCalls: [{ calls: [] }] }],
		}), /Captured simulation request/)
		const directSimulationRequest = serialize(EthSimulateV1Params, ethSimulateRequests[2])
		assert.equal(directSimulationRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		await assert.rejects(ethSimulateV1FromInput(ethereum, undefined, createSimulatedInput(confirmationInput, simulationOverrides), {
			method: 'eth_simulateV1',
			params: [{ blockStateCalls: [{ calls: [] }, { calls: [] }] }],
		}), /Captured simulation request/)
		const stackedSimulationRequest = serialize(EthSimulateV1Params, ethSimulateRequests[3])
		assert.equal(stackedSimulationRequest.params[0].blockStateCalls.length, 3)
		assert.equal(stackedSimulationRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(stackedSimulationRequest.params[0].blockStateCalls[1]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		assert.equal(stackedSimulationRequest.params[0].blockStateCalls[2]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		await assert.rejects(ethSimulateV1FromInput(ethereum, undefined, createSimulatedInput(input, simulationOverrides), {
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
			const simulationInput = await prepareSimulationInputForRpc(await getSimulationInputForPurpose('what-if', await getSettings()), ethereum)
			return await getSimulatedCodeFromInput(ethereum, undefined, simulationInput, activeAddress, 'latest')
		}

		assert.deepEqual(await websiteGetCode(), { statusCode: 'success', getCodeReturn: new Uint8Array() })
		assert.equal(chainCodeRequests, 0)

		await changeSimulationMode({ simulationMode: false, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		assert.equal(await isDelegateClearingEnabled(activeAddress, rpcEntry.chainId), true)
		assert.deepEqual(getSimulationOverridesForPurpose('what-if', await getSettings()), {})
		assert.deepEqual((await getSimulationInputForPurpose('what-if', await getSettings())).simulationOverrides, {})
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
		const capturedOverrides = getSimulationOverridesForPurpose('what-if', settingsSnapshot)
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
		assert.equal(getSimulationInputHash(createSimulatedInput(currentInput)), getSimulationInputHash(createSimulatedInput(capturedInput)))
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

	test('coalesces concurrent code lookups and caches both delegated and undelegated results', async () => {
		let codeRequests = 0
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				codeRequests += 1
				return request.params[0] === activeAddress ? `0xef0100${ addressString(delegate).slice(2) }` : '0x'
			},
		}, async () => undefined, async () => undefined, rpcEntry)

		assert.deepEqual(await Promise.all([
			ethereum.getDelegateClearingHint(activeAddress),
			ethereum.getDelegateClearingHint(activeAddress),
		]), [delegate, delegate])
		assert.equal(await ethereum.getDelegateClearingHint(activeAddress), delegate)
		assert.equal(await ethereum.getDelegateClearingHint(activeAddress + 1n), undefined)
		assert.equal(await ethereum.getDelegateClearingHint(activeAddress + 1n), undefined)
		assert.equal(codeRequests, 2)
		const replacementEthereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				return '0x'
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		assert.equal(await replacementEthereum.getDelegateClearingHint(activeAddress), undefined)
	})

	test('rechecks an aged delegated hint after a new block but keeps negative hints cached', async () => {
		let clock = 1_000_000
		const lookedUp: bigint[] = []
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const undelegated = activeAddress + 1n
		const delegateOnChain = new Map<bigint, bigint | undefined>([[activeAddress, delegate], [undelegated, undefined]])
		const hints = createDelegateClearingHintCache(async (address) => {
			lookedUp.push(address)
			return delegateOnChain.get(address)
		}, () => clock)
		assert.equal(await hints.get(activeAddress), delegate)
		assert.equal(await hints.get(undelegated), undefined)
		delegateOnChain.set(activeAddress, undefined)
		delegateOnChain.set(undelegated, delegate)
		clock += 59_000
		hints.invalidateDelegatedForNewBlock()
		assert.equal(await hints.get(activeAddress), delegate)
		clock += 2_000
		hints.invalidateDelegatedForNewBlock()
		assert.equal(await hints.get(activeAddress), undefined)
		assert.equal(await hints.get(undelegated), undefined)
		assert.deepEqual(lookedUp, [activeAddress, undelegated, activeAddress])
	})

	test('expires positive and negative hints after five minutes without a new block', async () => {
		const fiveMinutes = 5 * 60 * 1000
		let clock = 1_000_000
		const lookedUp: bigint[] = []
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const undelegated = activeAddress + 1n
		const delegateOnChain = new Map<bigint, bigint | undefined>([[activeAddress, delegate], [undelegated, undefined]])
		const hints = createDelegateClearingHintCache(async (address) => {
			lookedUp.push(address)
			return delegateOnChain.get(address)
		}, () => clock)
		assert.equal(await hints.get(activeAddress), delegate)
		assert.equal(await hints.get(undelegated), undefined)
		delegateOnChain.set(activeAddress, undefined)
		delegateOnChain.set(undelegated, delegate)
		clock += fiveMinutes - 1
		assert.equal(await hints.get(activeAddress), delegate)
		assert.equal(await hints.get(undelegated), undefined)
		assert.deepEqual(lookedUp, [activeAddress, undelegated])
		clock += 1
		assert.equal(await hints.get(activeAddress), undefined)
		assert.equal(await hints.get(undelegated), delegate)
		assert.equal(await hints.get(activeAddress), undefined)
		assert.equal(await hints.get(undelegated), delegate)
		assert.deepEqual(lookedUp, [activeAddress, undelegated, activeAddress, undelegated])
	})

	test('expires a negative hint at five minutes even with new blocks in between', async () => {
		const fiveMinutes = 5 * 60 * 1000
		let clock = 1_000_000
		let lookups = 0
		const hints = createDelegateClearingHintCache(async () => {
			lookups += 1
			return undefined
		}, () => clock)
		assert.equal(await hints.get(activeAddress), undefined)
		for (let elapsed = 60_000; elapsed < fiveMinutes; elapsed += 60_000) {
			clock = 1_000_000 + elapsed
			hints.invalidateDelegatedForNewBlock()
			assert.equal(await hints.get(activeAddress), undefined)
		}
		clock = 1_000_000 + fiveMinutes - 1
		assert.equal(await hints.get(activeAddress), undefined)
		assert.equal(lookups, 1)
		clock = 1_000_000 + fiveMinutes
		hints.invalidateDelegatedForNewBlock()
		assert.equal(await hints.get(activeAddress), undefined)
		assert.equal(lookups, 2)
	})

	test('refreshes an expired hint from the RPC even while the RPC response cache still holds the old code', async () => {
		const fiveMinutes = 5 * 60 * 1000
		const startedAt = new Date('2026-01-01T00:00:00Z').getTime()
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const delegatedCode = `0xef0100${ addressString(delegate).slice(2) }`
		const undelegated = activeAddress + 1n
		const codeByAddress = new Map<string, string>([[addressString(activeAddress), delegatedCode], [addressString(undelegated), '0x']])
		let codeRequests = 0
		const server = Bun.serve({
			hostname: '127.0.0.1', port: 0,
			async fetch(request) {
				const message: unknown = await request.json()
				if (typeof message !== 'object' || message === null || !('id' in message) || !('method' in message) || !('params' in message) || !Array.isArray(message.params)) throw new Error('Missing fixture request fields')
				if (message.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ String(message.method) }`)
				codeRequests += 1
				return Response.json({ jsonrpc: '2.0', id: message.id, result: codeByAddress.get(String(message.params[0])) ?? '0x' })
			},
		})
		// Without block polling the RPC response cache is never cleared, as while the extension sleeps.
		const ethereum = createEthereumClientService({ ...rpcEntry, httpsRpc: `${ server.url }rpc` }, async () => undefined, async () => undefined)
		try {
			setSystemTime(startedAt)
			assert.equal(await ethereum.getDelegateClearingHint(activeAddress), delegate)
			assert.equal(await ethereum.getDelegateClearingHint(undelegated), undefined)
			assert.equal(codeRequests, 2)
			codeByAddress.set(addressString(activeAddress), '0x')
			codeByAddress.set(addressString(undelegated), delegatedCode)
			setSystemTime(startedAt + fiveMinutes - 1)
			assert.equal(await ethereum.getDelegateClearingHint(activeAddress), delegate)
			assert.equal(await ethereum.getDelegateClearingHint(undelegated), undefined)
			assert.equal(codeRequests, 2)
			setSystemTime(startedAt + fiveMinutes)
			assert.deepEqual(await Promise.all([ethereum.getDelegateClearingHint(activeAddress), ethereum.getDelegateClearingHint(activeAddress)]), [undefined, undefined])
			assert.deepEqual(await Promise.all([ethereum.getDelegateClearingHint(undelegated), ethereum.getDelegateClearingHint(undelegated)]), [delegate, delegate])
			assert.equal(codeRequests, 4)
			assert.equal(await ethereum.getDelegateClearingHint(activeAddress), undefined)
			assert.equal(await ethereum.getDelegateClearingHint(undelegated), delegate)
			assert.equal(codeRequests, 4)
		} finally {
			setSystemTime()
			server.stop(true)
		}
	})

	test('a first hint lookup shares a same-block eth_getCode response with other callers', async () => {
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		let codeRequests = 0
		const server = Bun.serve({
			hostname: '127.0.0.1', port: 0,
			async fetch(request) {
				const message: unknown = await request.json()
				if (typeof message !== 'object' || message === null || !('id' in message) || !('method' in message)) throw new Error('Missing fixture request fields')
				if (message.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ String(message.method) }`)
				codeRequests += 1
				return Response.json({ jsonrpc: '2.0', id: message.id, result: `0xef0100${ addressString(delegate).slice(2) }` })
			},
		})
		const ethereum = createEthereumClientService({ ...rpcEntry, httpsRpc: `${ server.url }rpc` }, async () => undefined, async () => undefined)
		try {
			assert.equal((await ethereum.getCode(activeAddress, 'latest', undefined)).length, 23)
			assert.equal(await ethereum.getDelegateClearingHint(activeAddress), delegate)
			assert.equal(codeRequests, 1)
		} finally { server.stop(true) }
	})

	test('retries a lookup started before a new block without caching its stale result', async () => {
		let codeRequests = 0
		let markFirstStarted = () => undefined
		const firstStarted = new Promise<void>((resolve) => { markFirstStarted = () => resolve() })
		let releaseStaleCode = (_code: string) => undefined
		const staleCode = new Promise<string>((resolve) => { releaseStaleCode = resolve })
		const staleDelegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const latestBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
		if ('error' in latestBlockResponse) throw new Error(latestBlockResponse.error.message)
		let markNewBlockSeen = () => undefined
		const newBlockSeen = new Promise<void>((resolve) => { markNewBlockSeen = () => resolve() })
		// A real RPC handler and server keep the handler's pending-request sharing in the path the retry takes.
		const server = Bun.serve({
			hostname: '127.0.0.1', port: 0,
			async fetch(request) {
				const message: unknown = await request.json()
				if (typeof message !== 'object' || message === null || !('id' in message) || !('method' in message)) throw new Error('Missing fixture request fields')
				if (message.method === 'eth_getBlockByNumber') return Response.json({ jsonrpc: '2.0', id: message.id, result: latestBlockResponse.result })
				if (message.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ String(message.method) }`)
				codeRequests += 1
				if (codeRequests === 1) {
					markFirstStarted()
					return Response.json({ jsonrpc: '2.0', id: message.id, result: await staleCode })
				}
				return Response.json({ jsonrpc: '2.0', id: message.id, result: '0x' })
			},
		})
		const ethereum = createEthereumClientService({ ...rpcEntry, httpsRpc: `${ server.url }rpc` }, async (_blockHeader, _ethereum, isNewBlock) => { if (isNewBlock) markNewBlockSeen() }, async () => undefined)
		try {
			const pendingHint = ethereum.getDelegateClearingHint(activeAddress)
			await firstStarted
			// Block polling is the production path that tells the service's hint cache about a new block.
			ethereum.setBlockPolling(true)
			await newBlockSeen
			assert.equal(await pendingHint, undefined)
			assert.equal(codeRequests, 2)
			releaseStaleCode(`0xef0100${ addressString(staleDelegate).slice(2) }`)
			await new Promise((resolve) => setTimeout(resolve, 20))
			assert.equal(await ethereum.getDelegateClearingHint(activeAddress), undefined)
			assert.deepEqual(await ethereum.getCode(activeAddress, 'latest', undefined), new Uint8Array())
			assert.equal(codeRequests, 2)
		} finally {
			ethereum.cleanup()
			releaseStaleCode('0x')
			server.stop(true)
		}
	})

	test('reuses the background delegation hint across popup opens and toggles', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		const settings = await getSettings()
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		let code = `0xef0100${ addressString(delegate).slice(2) }`
		let codeRequests = 0
		const requestHandler: IEthereumJSONRpcRequestHandler = {
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				codeRequests += 1
				return code
			},
		}
		const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcEntry)
		const requestReply = await requestDelegateClearing(settings, ethereum, activeAddress, rpcEntry.chainId)
		assert.deepEqual(requestReply.data.status, { type: 'delegated', delegate })
		assert.equal(codeRequests, 1)
		code = '0x'
		const cachedReply = await requestDelegateClearing(settings, ethereum, activeAddress, rpcEntry.chainId)
		assert.deepEqual(cachedReply.data.status, { type: 'delegated', delegate })
		const services = { ethereum, tokenPriceService: new TokenPriceService(ethereum, 60000) }
		const toggleReply = await setDelegateClearing(settings, services, activeAddress, rpcEntry.chainId, true)
		assert.deepEqual(toggleReply.data, { ok: true, address: activeAddress, chainId: rpcEntry.chainId, enabled: true })
		assert.equal(codeRequests, 1)
		const replacementEthereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcEntry)
		const missingReply = await requestDelegateClearing(settings, replacementEthereum, activeAddress, rpcEntry.chainId)
		assert.deepEqual(missingReply.data.status, { type: 'none' })
		assert.equal(codeRequests, 2)
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
		let codeRequests = 0
		const address = activeAddress + 2n
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				codeRequests += 1
				if (codeRequests === 1) throw new Error('RPC unavailable')
				return '0x'
			},
		}, async () => undefined, async () => undefined, rpcEntry)

		await assert.rejects(ethereum.getDelegateClearingHint(address), /RPC unavailable/)
		assert.equal(await ethereum.getDelegateClearingHint(address), undefined)
		assert.equal(codeRequests, 2)
	})

	test('keeps an abandoned lookup available to later waiters until the service is replaced', async () => {
		let codeRequests = 0
		let releaseFirst: (code: string) => void = () => undefined
		const firstResponse = new Promise<string>((resolve) => { releaseFirst = resolve })
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const requestHandler: IEthereumJSONRpcRequestHandler = {
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				codeRequests += 1
				return codeRequests === 1 ? await firstResponse : `0xef0100${ addressString(delegate).slice(2) }`
			},
		}
		const ethereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcEntry)
		const abortController = new AbortController()
		const abortedLookup = ethereum.getDelegateClearingHint(activeAddress, abortController)
		abortController.abort(new Error('Refresh replaced'))
		await assert.rejects(abortedLookup, /Refresh replaced/u)
		releaseFirst('0x')
		assert.equal(await ethereum.getDelegateClearingHint(activeAddress), undefined)
		assert.equal(codeRequests, 1)
		const replacementEthereum = new EthereumClientService(requestHandler, async () => undefined, async () => undefined, rpcEntry)
		assert.equal(await replacementEthereum.getDelegateClearingHint(activeAddress), delegate)
		assert.equal(codeRequests, 2)
	})

	test('keeps a shared lookup alive when one waiting refresh is aborted', async () => {
		let releaseLookup: (code: string) => void = () => undefined
		const response = new Promise<string>((resolve) => { releaseLookup = resolve })
		let codeRequests = 0
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request, abortController) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				if (abortController === undefined) throw new Error('Expected the shared lookup to be abortable')
				codeRequests += 1
				return await response
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		const abortController = new AbortController()
		const aborted = ethereum.getDelegateClearingHint(activeAddress, abortController)
		const surviving = ethereum.getDelegateClearingHint(activeAddress)
		abortController.abort(new Error('Refresh replaced'))
		await assert.rejects(aborted, /Refresh replaced/u)
		releaseLookup(`0xef0100${ addressString(delegate).slice(2) }`)
		assert.equal(await surviving, delegate)
		assert.equal(await ethereum.getDelegateClearingHint(activeAddress), delegate)
		assert.equal(codeRequests, 1)
	})

	test('retries an in-flight delegation lookup after a new block invalidates it', async () => {
		let releaseOldBlock: (delegate: bigint | undefined) => void = () => undefined
		const oldBlockResponse = new Promise<bigint | undefined>((resolve) => { releaseOldBlock = resolve })
		let lookups = 0
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const hints = createDelegateClearingHintCache(async () => {
			lookups += 1
			return lookups === 1 ? await oldBlockResponse : undefined
		})
		const staleLookup = hints.get(activeAddress)
		hints.invalidateDelegatedForNewBlock()
		assert.equal(await staleLookup, undefined)
		releaseOldBlock(delegate)
		assert.equal(await hints.get(activeAddress), undefined)
		assert.equal(lookups, 2)
	})

	test('replacing the simulation services drops cached delegate clearing hints', async () => {
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		let code = `0xef0100${ addressString(delegate).slice(2) }`
		let codeRequests = 0
		const server = Bun.serve({
			hostname: '127.0.0.1', port: 0,
			async fetch(request) {
				const message: unknown = await request.json()
				if (typeof message !== 'object' || message === null || !('id' in message) || !('method' in message)) throw new Error('Missing fixture request fields')
				if (message.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ String(message.method) }`)
				codeRequests += 1
				return Response.json({ jsonrpc: '2.0', id: message.id, result: code })
			},
		})
		const network = { ...rpcEntry, httpsRpc: `${ server.url }rpc` }
		const owner = createSimulationServicesOwner(network, async () => undefined, async (_ethereum, error) => { throw error })
		try {
			const original = owner.getCurrent().ethereum
			assert.equal(await original.getDelegateClearingHint(activeAddress), delegate)
			code = '0x'
			assert.equal(await original.getDelegateClearingHint(activeAddress), delegate)
			assert.equal(codeRequests, 1)
			const replacement = owner.reset(network).ethereum
			assert.equal(await replacement.getDelegateClearingHint(activeAddress), undefined)
			assert.equal(codeRequests, 2)
		} finally {
			owner.getCurrent().ethereum.cleanup()
			server.stop(true)
		}
	})

	test('saving delegate clearing does not wait for a pending hint lookup', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		let releaseOldBlock: (code: string) => void = () => undefined
		const oldBlockResponse = new Promise<string>((resolve) => { releaseOldBlock = resolve })
		let codeRequests = 0
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				codeRequests += 1
				return codeRequests === 1 ? await oldBlockResponse : `0xef0100${ addressString(delegate).slice(2) }`
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		const services = { ethereum, tokenPriceService: new TokenPriceService(ethereum, 60000) }
		const pendingHint = ethereum.getDelegateClearingHint(activeAddress)
		const enabling = setDelegateClearing(await getSettings(), services, activeAddress, rpcEntry.chainId, true)
		assert.deepEqual((await enabling).data, { ok: true, address: activeAddress, chainId: rpcEntry.chainId, enabled: true })
		releaseOldBlock('0x')
		assert.equal(await pendingHint, undefined)
		assert.equal(codeRequests, 1)
	})
})
