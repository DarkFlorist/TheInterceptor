import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { EthereumClientService, getNextBlockTimeStampOverride } from '../../app/ts/simulation/services/EthereumClientService.js'
import { getCurrentSimulationInput, getCurrentSimulationOverrides, getGovernanceExecutionSimulationInput, prepareSimulationInputForRpc } from '../../app/ts/background/simulationUpdating.js'
import { requestDelegationSimulation, setDelegationSimulation } from '../../app/ts/background/popupMessageHandlers/delegationSimulation.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { changeSimulationMode, isDelegateClearingEnabled, setDelegateClearingEnabled, setMakeCurrentAddressRich } from '../../app/ts/background/settings.js'
import { getSettings } from '../../app/ts/background/settings.js'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { updateInterceptorTransactionStack } from '../../app/ts/background/storageVariables.js'
import { appendTransactionsToInput, createSimulationState, ethSimulateV1FromInput, getSimulatedCode, getSimulatedCodeFromInput, mockSignTransaction, simulatedCallFromInput, simulateEstimateGasFromInput } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { getSimulationInputHash } from '../../app/ts/utils/simulationFingerprint.js'
import { isCodeClearedBySimulationOverrides } from '../../app/ts/utils/delegateClearingState.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../../app/ts/utils/constants.js'
import { EthSimulateV1Params } from '../../app/ts/types/ethSimulate-types.js'
import { JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import { EthereumBlockHeader, serialize } from '../../app/ts/types/wire-types.js'
import { type SimulationState, SimulationStateInputBlock, toResolvedSimulationInput } from '../../app/ts/types/visualizer-types.js'
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
		const simulationOverrides = getCurrentSimulationOverrides(await getSettings())
		assert.deepEqual(input[0]?.stateOverrides[addressString(activeAddress)], { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value })
		assert.equal(isCodeClearedBySimulationOverrides(simulationOverrides, activeAddress), true)
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
		const rpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input({ value: input, simulationOverrides }, 1n, undefined)).request)
		assert.equal(rpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(rpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.balance, `0x${ MAKE_YOU_RICH_TRANSACTION.transaction.value.toString(16) }`)

		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress + 1n })
		assert.equal(isCodeClearedBySimulationOverrides(getCurrentSimulationOverrides(await getSettings()), activeAddress + 1n), false)
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: { ...rpcEntry, chainId: rpcEntry.chainId + 1n } })
		assert.equal(isCodeClearedBySimulationOverrides(getCurrentSimulationOverrides(await getSettings()), activeAddress), false)

		assert.equal(await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, false), true)
		assert.equal(await isDelegateClearingEnabled(activeAddress, rpcEntry.chainId), false)
	})

	test('keeps the idle stack empty and clears the first confirmation and RPC call', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true)
		const input = await getCurrentSimulationInput([])
		const simulationOverrides = getCurrentSimulationOverrides(await getSettings())
		assert.equal(input.length, 0)
		const parentBlockResponse = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
		if ('error' in parentBlockResponse) throw new Error(parentBlockResponse.error.message)
		const parentBlock = EthereumBlockHeader.parse(parentBlockResponse.result)
		if (parentBlock === null) throw new Error('Expected a parent block')
		const ethSimulateRequests: EthSimulateV1Params[] = []
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method === 'eth_getBlockByNumber') return parentBlockResponse.result
				if (request.method === 'eth_blockNumber') return `0x${ parentBlock.number.toString(16) }`
				if (request.method === 'eth_getTransactionCount') return '0x0'
				if (request.method === 'eth_simulateV1') {
					ethSimulateRequests.push(request)
					throw new Error('Captured simulation request')
				}
				throw new Error(`Unexpected RPC method ${ request.method }`)
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		const idleState = await createSimulationState(ethereum, undefined, input, simulationOverrides)
		assert.equal(idleState.success, true)
		if (idleState.success) assert.equal(idleState.simulatedBlocks.length, 0)
		assert.equal(ethSimulateRequests.length, 0)
		const idleCode = await getSimulatedCodeFromInput(ethereum, undefined, toResolvedSimulationInput(input, simulationOverrides), activeAddress)
		assert.equal(idleCode.statusCode, 'success')
		if (idleCode.statusCode === 'success') assert.equal(idleCode.getCodeReturn.length, 0)
		const popupCode = await getSimulatedCode(ethereum, undefined, { kind: 'simulated', value: idleState }, activeAddress)
		assert.equal(popupCode.statusCode, 'success')
		if (popupCode.statusCode === 'success') assert.equal(popupCode.getCodeReturn.length, 0)
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
		const confirmationRequest = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input({ value: confirmationInput, simulationOverrides }, 1n, undefined)).request)
		assert.equal(confirmationRequest.params[0].blockStateCalls.length, 1)
		assert.equal(confirmationRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		await assert.rejects(simulatedCallFromInput(ethereum, undefined, toResolvedSimulationInput(input, simulationOverrides), {
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
		await assert.rejects(simulateEstimateGasFromInput(ethereum, undefined, toResolvedSimulationInput(input, simulationOverrides), {
			from: activeAddress,
			to: activeAddress + 1n,
			value: 0n,
			input: new Uint8Array(),
		}), /Captured simulation request/)
		const estimateRequest = serialize(EthSimulateV1Params, ethSimulateRequests[1])
		assert.equal(estimateRequest.params[0].blockStateCalls.length, 1)
		assert.equal(estimateRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		await assert.rejects(ethSimulateV1FromInput(ethereum, undefined, toResolvedSimulationInput(input, simulationOverrides), {
			method: 'eth_simulateV1',
			params: [{ blockStateCalls: [{ calls: [] }] }],
		}), /Captured simulation request/)
		const directSimulationRequest = serialize(EthSimulateV1Params, ethSimulateRequests[2])
		assert.equal(directSimulationRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		await assert.rejects(ethSimulateV1FromInput(ethereum, undefined, toResolvedSimulationInput(confirmationInput, simulationOverrides), {
			method: 'eth_simulateV1',
			params: [{ blockStateCalls: [{ calls: [] }, { calls: [] }] }],
		}), /Captured simulation request/)
		const stackedSimulationRequest = serialize(EthSimulateV1Params, ethSimulateRequests[3])
		assert.equal(stackedSimulationRequest.params[0].blockStateCalls.length, 3)
		assert.equal(stackedSimulationRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(stackedSimulationRequest.params[0].blockStateCalls[1]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		assert.equal(stackedSimulationRequest.params[0].blockStateCalls[2]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		await assert.rejects(ethSimulateV1FromInput(ethereum, undefined, toResolvedSimulationInput(input, simulationOverrides), {
			method: 'eth_simulateV1',
			params: [{ blockStateCalls: [{ calls: [] }] }, parentBlock.number],
		}), /Captured simulation request/)
		const explicitParentRequest = serialize(EthSimulateV1Params, ethSimulateRequests.at(-1))
		assert.equal(explicitParentRequest.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(explicitParentRequest.params[1], `0x${ parentBlock.number.toString(16) }`)
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
		const capturedOverrides = getCurrentSimulationOverrides(settingsSnapshot)
		assert.equal(capturedInput.length, 2)
		for (const block of capturedInput) {
			assert.equal(block.stateOverrides[addressString(activeAddress)]?.code, undefined)
		}
		assert.equal(isCodeClearedBySimulationOverrides(capturedOverrides, activeAddress), true)
		assert.notEqual(getSimulationInputHash(capturedInput, capturedOverrides), getSimulationInputHash(capturedInput, {}))
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
		const rpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input({ value: capturedInput, simulationOverrides: capturedOverrides }, 1n, undefined)).request)
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
		const splitRpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input({ value: overfullInput, simulationOverrides: capturedOverrides }, 1n, undefined)).request)
		assert.equal(splitRpcInput.params[0].blockStateCalls.length, 2)
		assert.equal(splitRpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(splitRpcInput.params[0].blockStateCalls[1]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		const appended = appendTransactionsToInput(capturedInput, [transaction(3n)])
		assert.equal(appended[2]?.stateOverrides[addressString(activeAddress)]?.code, undefined)
		const appendedRpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input({ value: appended, simulationOverrides: capturedOverrides }, 1n, undefined)).request)
		assert.equal(appendedRpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(appendedRpcInput.params[0].blockStateCalls[2]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		const governanceInput = getGovernanceExecutionSimulationInput(capturedInput, transaction(4n), new Date('2026-01-01T00:01:00Z'), {})
		assert.equal(governanceInput[2]?.stateOverrides[addressString(activeAddress)]?.code, undefined)
		const governanceRpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input({ value: governanceInput, simulationOverrides: capturedOverrides }, 1n, undefined)).request)
		assert.equal(governanceRpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		assert.equal(governanceRpcInput.params[0].blockStateCalls[2]?.stateOverrides?.[addressString(activeAddress)]?.code, undefined)
		const currentInput = await getCurrentSimulationInput()
		assert.equal(currentInput[0]?.stateOverrides[addressString(activeAddress)]?.code, undefined)
		assert.equal(currentInput[1]?.stateOverrides[addressString(activeAddress)]?.code, undefined)
		assert.equal(getSimulationInputHash(currentInput, {}), getSimulationInputHash(capturedInput, {}))
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
			await assert.rejects(prepareSimulationInputForRpc(input, ethereum, simulationOverrides), /Captured preparation request/)
			assert.equal(requests.length, 1)
			const request = serialize(EthSimulateV1Params, requests[0])
			assert.equal(request.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		}
	})

	test('returns a retryable reply when delegation confirmation fails', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		const settings = await getSettings()
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest() { throw new Error('RPC unavailable') },
		}, async () => undefined, async () => undefined, rpcEntry)
		const services = { ethereum, tokenPriceService: new TokenPriceService(ethereum, 60000) }
		const requestReply = await requestDelegationSimulation(settings, ethereum, activeAddress, rpcEntry.chainId)
		assert.deepEqual(requestReply.data.status, { type: 'unknown' })
		const toggleReply = await setDelegationSimulation(settings, services, activeAddress, rpcEntry.chainId, true)
		assert.deepEqual(toggleReply.data, { ok: false, message: 'Could not confirm the current delegate. Please try again.' })
		assert.equal(await isDelegateClearingEnabled(activeAddress, rpcEntry.chainId), false)
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
			ethereum.getCachedDelegationHint(activeAddress),
			ethereum.getCachedDelegationHint(activeAddress),
		]), [delegate, delegate])
		assert.equal(await ethereum.getCachedDelegationHint(activeAddress), delegate)
		assert.equal(await ethereum.getCachedDelegationHint(activeAddress + 1n), undefined)
		assert.equal(await ethereum.getCachedDelegationHint(activeAddress + 1n), undefined)
		assert.equal(codeRequests, 2)
		const replacementEthereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				return '0x'
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		assert.equal(await replacementEthereum.getCachedDelegationHint(activeAddress), undefined)
	})

	test('refreshes popup checks on open while confirmation also refreshes before enabling', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		const settings = await getSettings()
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		let code = '0x'
		let codeRequests = 0
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				codeRequests += 1
				return code
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		assert.equal(await ethereum.getCachedDelegationHint(activeAddress), undefined)
		code = `0xef0100${ addressString(delegate).slice(2) }`
		const requestReply = await requestDelegationSimulation(settings, ethereum, activeAddress, rpcEntry.chainId)
		assert.deepEqual(requestReply.data.status, { type: 'delegated', delegate })
		assert.equal(codeRequests, 2)
		await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true)
		const services = { ethereum, tokenPriceService: new TokenPriceService(ethereum, 60000) }
		const toggleReply = await setDelegationSimulation(settings, services, activeAddress, rpcEntry.chainId, true)
		assert.deepEqual(toggleReply.data, { ok: true, address: activeAddress, chainId: rpcEntry.chainId, enabled: true })
		assert.equal(codeRequests, 3)
		code = '0x'
		const missingReply = await setDelegationSimulation(settings, services, activeAddress, rpcEntry.chainId, true)
		assert.deepEqual(missingReply.data, { ok: false, message: 'This account no longer has an EIP-7702 delegate.' })
		assert.equal(codeRequests, 4)
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
			const reply = await setDelegationSimulation(await getSettings(), services, activeAddress, rpcEntry.chainId, false)
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

		await assert.rejects(ethereum.getCachedDelegationHint(address), /RPC unavailable/)
		assert.equal(await ethereum.getCachedDelegationHint(address), undefined)
		assert.equal(codeRequests, 2)
	})

	test('keeps an abandoned lookup available to later waiters and invalidates it on cache reset', async () => {
		let codeRequests = 0
		let releaseFirst: (code: string) => void = () => undefined
		const firstResponse = new Promise<string>((resolve) => { releaseFirst = resolve })
		const delegate = 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdn
		const ethereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				codeRequests += 1
				return codeRequests === 1 ? await firstResponse : `0xef0100${ addressString(delegate).slice(2) }`
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		const abortController = new AbortController()
		const abortedLookup = ethereum.getCachedDelegationHint(activeAddress, abortController)
		abortController.abort(new Error('Refresh replaced'))
		await assert.rejects(abortedLookup, /Refresh replaced/u)
		releaseFirst('0x')
		assert.equal(await ethereum.getCachedDelegationHint(activeAddress), undefined)
		assert.equal(codeRequests, 1)
		ethereum.clearDelegationHintCache()
		assert.equal(await ethereum.getCachedDelegationHint(activeAddress), delegate)
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
		const aborted = ethereum.getCachedDelegationHint(activeAddress, abortController)
		const surviving = ethereum.getCachedDelegationHint(activeAddress)
		abortController.abort(new Error('Refresh replaced'))
		await assert.rejects(aborted, /Refresh replaced/u)
		releaseLookup(`0xef0100${ addressString(delegate).slice(2) }`)
		assert.equal(await surviving, delegate)
		assert.equal(await ethereum.getCachedDelegationHint(activeAddress), delegate)
		assert.equal(codeRequests, 1)
	})

	test('retries an in-flight delegation lookup after a cache reset invalidates it', async () => {
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
				return codeRequests === 1 ? await oldBlockResponse : '0x'
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		const staleLookup = ethereum.getCachedDelegationHint(activeAddress)
		ethereum.clearDelegationHintCache()
		assert.equal(await staleLookup, undefined)
		releaseOldBlock(`0xef0100${ addressString(delegate).slice(2) }`)
		assert.equal(await ethereum.getCachedDelegationHint(activeAddress), undefined)
		assert.equal(codeRequests, 2)
	})

	test('enabling delegate clearing survives a cache reset during delegation confirmation', async () => {
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
		const enabling = setDelegationSimulation(await getSettings(), services, activeAddress, rpcEntry.chainId, true)
		ethereum.clearDelegationHintCache()
		assert.deepEqual((await enabling).data, { ok: true, address: activeAddress, chainId: rpcEntry.chainId, enabled: true })
		releaseOldBlock('0x')
		assert.equal(codeRequests, 2)
	})
})
