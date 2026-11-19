import * as assert from 'node:assert'
import { test } from 'bun:test'
import { activeAddress, fakeRpcNetwork, modules, pendingTransaction } from './confirmTransactionTestHarness.js'
import { toPreSimulationTransaction } from '../../app/ts/background/confirmationSimulationRun.js'

const fixedRichAddress = 0x3000000000000000000000000000000000000003n
if (!pendingTransaction.transactionToSimulate.success) throw new Error('Expected a formed test transaction')
// A call appended after the stack, as a wallet_sendCalls preview and approval append the batch's calls: the pre-simulation time manipulation and the rich addresses decide how it runs even when the stack itself holds no transaction.
const appendedCall = { type: 'Transaction' as const, preSimulationTransaction: toPreSimulationTransaction(pendingTransaction.transactionToSimulate) }
const stackTimeManipulation = { type: 'TimeManipulation' as const, blockTimeManipulation: { type: 'AddToTimestamp' as const, deltaToAdd: 60n, deltaUnit: 'Seconds' as const } }

// Stored state that every part of the simulation input depends on: a pre-simulation time manipulation, both kinds of rich addresses and a stack operation.
async function storeSimulationState() {
	await modules.browserStorageLocalSet({
		simulationMode: true,
		activeRpcNetwork: fakeRpcNetwork,
		useSignersAddressAsActiveAddress: false,
		independentActiveSimulationAddress: activeAddress,
		makeCurrentAddressRich: true,
		fixedAddressRichList: [{ address: fixedRichAddress, makingRich: true, type: 'UserAdded' }],
		preSimulationBlockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 3600n, deltaUnit: 'Seconds' },
	})
	await modules.updateInterceptorTransactionStack(() => ({ operations: [stackTimeManipulation] }))
}

test('every change to the simulation input built from the stack changes its fingerprint', async () => {
	await storeSimulationState()
	const { captureStackSimulationContext, getStackSimulationInputFingerprint } = await import('../../app/ts/background/simulationUpdating.js')
	const { context } = await captureStackSimulationContext()
	const fingerprint = getStackSimulationInputFingerprint(context, [appendedCall])
	const inputChanges = {
		stack: { ...context, stack: { operations: [] } },
		preSimulationBlockTimeManipulation: { ...context, preSimulationBlockTimeManipulation: { type: 'SetTimetamp' as const, timeToSet: 1n } },
		richAddresses: { ...context, richAddresses: [fixedRichAddress] },
	}

	for (const [change, changedContext] of Object.entries(inputChanges)) assert.notEqual(getStackSimulationInputFingerprint(changedContext, [appendedCall]), fingerprint, change)
})

test('the stack simulation input fingerprint is derived from the input, so a context change that leaves the input as it is leaves it unchanged', async () => {
	await storeSimulationState()
	const { captureStackSimulationContext, getSimulationInputForStack, getStackSimulationInputFingerprint } = await import('../../app/ts/background/simulationUpdating.js')
	const { context } = await captureStackSimulationContext()
	// The stack holds no transaction, so the chain id, which only decides which transactions run, does not change the input.
	const otherChainContext = { ...context, chainId: context.chainId + 1n }

	assert.deepEqual(getSimulationInputForStack(otherChainContext), getSimulationInputForStack(context))
	assert.equal(getStackSimulationInputFingerprint(otherChainContext, []), getStackSimulationInputFingerprint(context, []))
})

test('settings that do not decide the simulation input leave the stack simulation context fingerprint unchanged', async () => {
	await storeSimulationState()
	const { captureStackSimulationContext, getStackSimulationInputFingerprint } = await import('../../app/ts/background/simulationUpdating.js')
	const fingerprint = getStackSimulationInputFingerprint((await captureStackSimulationContext()).context, [appendedCall])

	await modules.browserStorageLocalSet({ websiteAccess: [{ website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }, access: true, addressAccess: [] }], openedPageV2: { page: 'Settings' } })

	assert.equal(getStackSimulationInputFingerprint((await captureStackSimulationContext()).context, [appendedCall]), fingerprint)
})

test('the general simulation path and the wallet_sendCalls path build the same input from the same stored state', async () => {
	await storeSimulationState()
	const { captureSimulationSnapshot, captureStackSimulationContext, getCurrentSimulationInput, getSimulationInputForStack, getStackSimulationInputFingerprint, toStackSimulationContext } = await import('../../app/ts/background/simulationUpdating.js')
	const { getSimulationSettingsSnapshot } = await import('../../app/ts/background/storedSettings.js')
	// The wallet_sendCalls approval rebuilds the context from a snapshot and the stack it reads inside the stack's write lock.
	const batchCommitContext = toStackSimulationContext(await getSimulationSettingsSnapshot(), await modules.getInterceptorTransactionStack())
	const generalInput = await getCurrentSimulationInput()

	assert.deepEqual((await captureSimulationSnapshot()).simulationStateInput, generalInput)
	assert.deepEqual(getSimulationInputForStack(batchCommitContext), generalInput)
	assert.equal(getStackSimulationInputFingerprint(batchCommitContext, [appendedCall]), getStackSimulationInputFingerprint((await captureStackSimulationContext()).context, [appendedCall]))
	// The input reflects every stored setting it depends on.
	assert.deepEqual(generalInput[0]?.blockTimeManipulation, { type: 'AddToTimestamp', deltaToAdd: 3600n, deltaUnit: 'Seconds' })
	assert.deepEqual(Object.keys(generalInput[0]?.stateOverrides ?? {}).map((address) => BigInt(address)).sort(), [activeAddress, fixedRichAddress].sort())
})
