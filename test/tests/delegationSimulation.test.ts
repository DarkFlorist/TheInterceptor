import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { getCurrentSimulationInput, getGovernanceExecutionSimulationInput } from '../../app/ts/background/simulationUpdating.js'
import { requestDelegationSimulation, setDelegationSimulation } from '../../app/ts/background/popupMessageHandlers/delegationSimulation.js'
import { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import { changeSimulationMode, isDelegateClearingEnabled, setDelegateClearingEnabled, setMakeCurrentAddressRich } from '../../app/ts/background/settings.js'
import { getSettings } from '../../app/ts/background/settings.js'
import { installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { updateInterceptorTransactionStack } from '../../app/ts/background/storageVariables.js'
import { appendTransactionsToInput, mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { addressString } from '../../app/ts/utils/bigint.js'
import { getSimulationInputHash } from '../../app/ts/utils/simulationFingerprint.js'
import { isDelegateClearedForBlock } from '../../app/ts/utils/delegateClearingState.js'
import { MAKE_YOU_RICH_TRANSACTION } from '../../app/ts/utils/constants.js'
import { EthSimulateV1Params } from '../../app/ts/types/ethSimulate-types.js'
import { JsonRpcResponse } from '../../app/ts/types/JsonRpc-types.js'
import { EthereumBlockHeader, serialize } from '../../app/ts/types/wire-types.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'

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

describe('delegate clearing in simulation', () => {
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
		assert.deepEqual(input[0]?.stateOverrides[addressString(activeAddress)], {
			balance: MAKE_YOU_RICH_TRANSACTION.transaction.value,
			code: new Uint8Array(),
		})
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
		const rpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input(input, 1n, undefined)).request)
		assert.equal(rpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')

		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress + 1n })
		assert.equal((await getCurrentSimulationInput())[0]?.stateOverrides[addressString(activeAddress + 1n)]?.code, undefined)
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: { ...rpcEntry, chainId: rpcEntry.chainId + 1n } })
		assert.equal((await getCurrentSimulationInput())[0]?.stateOverrides[addressString(activeAddress)]?.code, undefined)

		assert.equal(await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, false), true)
		assert.equal(await isDelegateClearingEnabled(activeAddress, rpcEntry.chainId), false)
	})

	test('clears every stack block and keeps a captured preference stable after storage changes', async () => {
		installBrowserMock()
		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress, rpcNetwork: rpcEntry })
		await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, true)
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
		await updateInterceptorTransactionStack(() => ({ operations: [
			{ type: 'Transaction', preSimulationTransaction: transaction(1n) },
			{ type: 'TimeManipulation', blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 5n, deltaUnit: 'Seconds' } },
			{ type: 'Transaction', preSimulationTransaction: transaction(2n) },
		] }))
		const settingsSnapshot = await getSettings()
		await setDelegateClearingEnabled(activeAddress, rpcEntry.chainId, false)
		const capturedInput = await getCurrentSimulationInput(undefined, settingsSnapshot)
		assert.equal(capturedInput.length, 2)
		for (const block of capturedInput) {
			assert.equal(isDelegateClearedForBlock(block, activeAddress), true)
			assert.deepEqual(block.stateOverrides[addressString(activeAddress)]?.code, new Uint8Array())
		}
		const markerOnlyInput = [{ ...capturedInput[0], stateOverrides: {} }]
		const unmarkedInput = [{ ...markerOnlyInput[0], delegateClearedAddress: undefined }]
		assert.notEqual(getSimulationInputHash(markerOnlyInput), getSimulationInputHash(unmarkedInput))
		assert.equal(isDelegateClearedForBlock({ ...capturedInput[0], delegateClearedAddress: undefined }, activeAddress), false)
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
		const rpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input(capturedInput, 1n, undefined)).request)
		assert.equal(rpcInput.params[0].blockStateCalls.length, 2)
		for (const block of rpcInput.params[0].blockStateCalls) assert.equal(block.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		const markerOnlyRpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input(markerOnlyInput, 1n, undefined)).request)
		assert.equal(markerOnlyRpcInput.params[0].blockStateCalls[0]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
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
		const splitRpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input(overfullInput, 1n, undefined)).request)
		assert.equal(splitRpcInput.params[0].blockStateCalls.length, 2)
		for (const block of splitRpcInput.params[0].blockStateCalls) assert.equal(block.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		const appended = appendTransactionsToInput(capturedInput, [transaction(3n)])
		assert.deepEqual(appended[2]?.stateOverrides[addressString(activeAddress)]?.code, new Uint8Array())
		const appendedRpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input(appended, 1n, undefined)).request)
		assert.equal(appendedRpcInput.params[0].blockStateCalls[2]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		const governanceInput = getGovernanceExecutionSimulationInput(capturedInput, transaction(4n), new Date('2026-01-01T00:01:00Z'), {})
		assert.deepEqual(governanceInput[2]?.stateOverrides[addressString(activeAddress)]?.code, new Uint8Array())
		const governanceRpcInput = serialize(EthSimulateV1Params, (await ethereum.prepareEthSimulateV1Input(governanceInput, 1n, undefined)).request)
		assert.equal(governanceRpcInput.params[0].blockStateCalls[2]?.stateOverrides?.[addressString(activeAddress)]?.code, '0x')
		const currentInput = await getCurrentSimulationInput()
		assert.equal(currentInput[0]?.stateOverrides[addressString(activeAddress)]?.code, undefined)
		assert.equal(currentInput[1]?.stateOverrides[addressString(activeAddress)]?.code, undefined)
		assert.notEqual(getSimulationInputHash(currentInput), getSimulationInputHash(capturedInput))
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
			ethereum.getCachedDelegation(activeAddress),
			ethereum.getCachedDelegation(activeAddress),
		]), [delegate, delegate])
		assert.equal(await ethereum.getCachedDelegation(activeAddress), delegate)
		assert.equal(await ethereum.getCachedDelegation(activeAddress + 1n), undefined)
		assert.equal(await ethereum.getCachedDelegation(activeAddress + 1n), undefined)
		assert.equal(codeRequests, 2)
		const replacementEthereum = new EthereumClientService({
			rpcUrl: rpcEntry.httpsRpc,
			clearCache() { return undefined },
			async jsonRpcRequest(request) {
				if (request.method !== 'eth_getCode') throw new Error(`Unexpected RPC method ${ request.method }`)
				return '0x'
			},
		}, async () => undefined, async () => undefined, rpcEntry)
		assert.equal(await replacementEthereum.getCachedDelegation(activeAddress), undefined)
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

		await assert.rejects(ethereum.getCachedDelegation(address), /RPC unavailable/)
		assert.equal(await ethereum.getCachedDelegation(address), undefined)
		assert.equal(codeRequests, 2)
	})

	test('invalidates delegation results on a new block and drops an aborted lookup', async () => {
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
		const abortedLookup = ethereum.getCachedDelegation(activeAddress, abortController)
		abortController.abort(new Error('Refresh replaced'))
		await assert.rejects(abortedLookup, /Refresh replaced/u)
		releaseFirst('0x')
		assert.equal(await ethereum.getCachedDelegation(activeAddress), delegate)
		assert.equal(codeRequests, 2)
		ethereum.clearDelegationCache()
		assert.equal(await ethereum.getCachedDelegation(activeAddress), delegate)
		assert.equal(codeRequests, 3)
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
		const aborted = ethereum.getCachedDelegation(activeAddress, abortController)
		const surviving = ethereum.getCachedDelegation(activeAddress)
		abortController.abort(new Error('Refresh replaced'))
		await assert.rejects(aborted, /Refresh replaced/u)
		releaseLookup(`0xef0100${ addressString(delegate).slice(2) }`)
		assert.equal(await surviving, delegate)
		assert.equal(await ethereum.getCachedDelegation(activeAddress), delegate)
		assert.equal(codeRequests, 1)
	})

	test('discards an in-flight result when a new block invalidates the cache', async () => {
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
		const staleLookup = ethereum.getCachedDelegation(activeAddress)
		ethereum.clearDelegationCache()
		releaseOldBlock(`0xef0100${ addressString(delegate).slice(2) }`)
		await assert.rejects(staleLookup, /New Block Abort/u)
		assert.equal(await ethereum.getCachedDelegation(activeAddress), undefined)
		assert.equal(codeRequests, 2)
	})
})
