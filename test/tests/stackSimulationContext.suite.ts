import * as assert from 'node:assert'
import { test } from 'bun:test'
import { activeAddress, fakeRpcNetwork, modules } from './confirmTransactionTestHarness.js'

const fixedRichAddress = 0x3000000000000000000000000000000000000003n
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

test('every field of the stack simulation context, including one added later, changes its fingerprint', async () => {
	await storeSimulationState()
	const { captureStackSimulationContext, getStackSimulationContextFingerprint } = await import('../../app/ts/background/simulationUpdating.js')
	const { context } = await captureStackSimulationContext()
	const fingerprint = getStackSimulationContextFingerprint(context)
	const changedFields = {
		stack: { ...context, stack: { operations: [] } },
		chainId: { ...context, chainId: context.chainId + 1n },
		activeStackContext: { ...context, activeStackContext: { simulationMode: false as const, activeSafeAddress: undefined, chainId: context.chainId } },
		preSimulationBlockTimeManipulation: { ...context, preSimulationBlockTimeManipulation: { type: 'SetTimetamp' as const, timeToSet: 1n } },
		richAddresses: { ...context, richAddresses: [fixedRichAddress] },
	}

	assert.deepEqual(Object.keys(changedFields).sort(), Object.keys(context).sort())
	for (const [field, changedContext] of Object.entries(changedFields)) assert.notEqual(getStackSimulationContextFingerprint(changedContext), fingerprint, field)
	// A field added to the context is covered without listing it anywhere.
	const withAddedField = (value: bigint) => ({ ...context, settingAddedLater: value })
	assert.notEqual(getStackSimulationContextFingerprint(withAddedField(1n)), getStackSimulationContextFingerprint(withAddedField(2n)))
})

test('settings that do not decide the simulation input leave the stack simulation context fingerprint unchanged', async () => {
	await storeSimulationState()
	const { captureStackSimulationContext, getStackSimulationContextFingerprint } = await import('../../app/ts/background/simulationUpdating.js')
	const fingerprint = getStackSimulationContextFingerprint((await captureStackSimulationContext()).context)

	await modules.browserStorageLocalSet({ websiteAccess: [{ website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }, access: true, addressAccess: [] }], openedPageV2: { page: 'Settings' } })

	assert.equal(getStackSimulationContextFingerprint((await captureStackSimulationContext()).context), fingerprint)
})

test('the general simulation path and the wallet_sendCalls path build the same input from the same stored state', async () => {
	await storeSimulationState()
	const { captureSimulationSnapshot, captureStackSimulationContext, getCurrentSimulationInput, getSimulationInputForStack, getStackSimulationContextFingerprint, toStackSimulationContext } = await import('../../app/ts/background/simulationUpdating.js')
	const { getSimulationSettingsSnapshot } = await import('../../app/ts/background/settings.js')
	// The wallet_sendCalls approval rebuilds the context from a snapshot and the stack it reads inside the stack's write lock.
	const batchCommitContext = toStackSimulationContext(await getSimulationSettingsSnapshot(), await modules.getInterceptorTransactionStack())
	const generalInput = await getCurrentSimulationInput()

	assert.deepEqual((await captureSimulationSnapshot()).simulationStateInput, generalInput)
	assert.deepEqual(getSimulationInputForStack(batchCommitContext), generalInput)
	assert.equal(getStackSimulationContextFingerprint(batchCommitContext), getStackSimulationContextFingerprint((await captureStackSimulationContext()).context))
	// The input reflects every stored setting it depends on.
	assert.deepEqual(generalInput[0]?.blockTimeManipulation, { type: 'AddToTimestamp', deltaToAdd: 3600n, deltaUnit: 'Seconds' })
	assert.deepEqual(Object.keys(generalInput[0]?.stateOverrides ?? {}).map((address) => BigInt(address)).sort(), [activeAddress, fixedRichAddress].sort())
})
