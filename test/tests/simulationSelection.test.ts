import * as assert from 'node:assert'
import { test } from 'bun:test'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { selectionChanged, selectionNeedsRefresh, type SimulationSelection } from '../../app/ts/utils/simulationSelection.js'

const firstEndpoint: RpcNetwork = { name: 'Test Chain', chainId: 1n, httpsRpc: 'https://first-endpoint.example.invalid', currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true }
// Same chain on another endpoint, so changing endpoints leaves the stack context alone.
const otherEndpoint: RpcNetwork = { ...firstEndpoint, name: 'Test Chain (other endpoint)', httpsRpc: 'https://other-endpoint.example.invalid' }
const firstSafe = 0x1111111111111111111111111111111111111111n
const otherSafe = 0x2222222222222222222222222222222222222222n

// The ways a stack context can change: switching between simulation mode and signing, or switching to another Safe while signing. Another Safe in simulation mode keeps the simulation stack.
type StackContextChange = 'none' | 'mode' | 'safe'

function buildTransition(to: SimulationSelection, endpointChanged: boolean, stackContextChange: StackContextChange): { readonly from: SimulationSelection, readonly to: SimulationSelection } {
	const fromStack = stackContextChange === 'mode'
		? { simulationMode: !to.simulationMode, activeSigningSafeAddress: to.activeSigningSafeAddress }
		: stackContextChange === 'safe'
			? { simulationMode: to.simulationMode, activeSigningSafeAddress: to.activeSigningSafeAddress === firstSafe ? otherSafe : firstSafe }
			: { simulationMode: to.simulationMode, activeSigningSafeAddress: to.activeSigningSafeAddress }
	return { from: { ...fromStack, activeRpcNetwork: endpointChanged ? otherEndpoint : firstEndpoint }, to }
}

const transitions = [true, false].flatMap((simulationMode) => [undefined, firstSafe].flatMap((activeSigningSafeAddress) => [false, true].flatMap((endpointChanged) => {
	const stackContextChanges: readonly StackContextChange[] = simulationMode ? ['none', 'mode'] : ['none', 'mode', 'safe']
	return stackContextChanges.map((stackContextChange) => ({
		simulationMode, activeSigningSafeAddress, endpointChanged, stackContextChange,
		...buildTransition({ simulationMode, activeSigningSafeAddress, activeRpcNetwork: firstEndpoint }, endpointChanged, stackContextChange),
	}))
})))

// The enqueue side is activeSettings.ts, which queues a refresh when selectionNeedsRefresh holds; the abort side is popupVisualisationUpdater.ts, where a refresh made for `from` steps aside when selectionChanged holds against the current selection.
for (const transition of transitions) test(`a selection change and a refresh left behind by it agree (simulationMode=${ transition.simulationMode }, Safe=${ transition.activeSigningSafeAddress !== undefined }, endpointChanged=${ transition.endpointChanged }, stackContextChange=${ transition.stackContextChange })`, () => {
	const changed = transition.endpointChanged || transition.stackContextChange !== 'none'
	const showsStack = transition.simulationMode || transition.activeSigningSafeAddress !== undefined
	const refreshStepsAside = selectionChanged(transition.from, transition.to)
	const changeQueuesRefresh = selectionNeedsRefresh(transition.from, transition.to)
	assert.equal(refreshStepsAside, changed)
	assert.equal(changeQueuesRefresh, changed && showsStack)
	// A refresh only steps aside for a change, and every change that steps a refresh aside queues its replacement unless the new selection shows no stack: external-wallet signing without a Safe.
	if (changeQueuesRefresh) assert.equal(refreshStepsAside, true, 'A change queued a refresh while the refresh for the previous selection still publishes over it')
	if (refreshStepsAside && !changeQueuesRefresh) assert.deepEqual({ simulationMode: transition.to.simulationMode, activeSigningSafeAddress: transition.to.activeSigningSafeAddress }, { simulationMode: false, activeSigningSafeAddress: undefined }, 'A refresh stepped aside with no refresh queued for a selection that shows a stack')
})

test('switching to external-wallet signing without a Safe steps a refresh aside and queues none, so nothing publishes the previous stack', () => {
	const from: SimulationSelection = { simulationMode: true, activeSigningSafeAddress: undefined, activeRpcNetwork: firstEndpoint }
	for (const activeRpcNetwork of [firstEndpoint, otherEndpoint]) {
		const to: SimulationSelection = { simulationMode: false, activeSigningSafeAddress: undefined, activeRpcNetwork }
		assert.equal(selectionChanged(from, to), true)
		assert.equal(selectionNeedsRefresh(from, to), false)
	}
})

test('editing the metadata of the selected endpoint keeps the selection on both sides', () => {
	const from: SimulationSelection = { simulationMode: true, activeSigningSafeAddress: undefined, activeRpcNetwork: firstEndpoint }
	const to: SimulationSelection = { ...from, activeRpcNetwork: { ...firstEndpoint, name: 'Renamed Test Chain', currencyName: 'Test Ether' } }
	assert.equal(selectionChanged(from, to), false)
	assert.equal(selectionNeedsRefresh(from, to), false)
})
