import type { Settings } from '../types/interceptor-messages.js'
import { activeStackContextsEqual, getActiveStackContext } from './activeStackContext.js'
import { getRpcNetworkChange } from './rpcNetworkChange.js'

// Everything that decides which stack is simulated and on which endpoint. getActiveStackContext is called with this type below, so it cannot start reading a field this type lacks without failing to compile here.
export type SimulationSelection = Pick<Settings, 'simulationMode' | 'activeSigningSafeAddress' | 'activeRpcNetwork'>

// Whether work done for `from` no longer describes `to`: another endpoint or another stack; metadata edits keep a selection. A refresh made for `from` steps aside when this holds, and selectionNeedsRefresh is built on it, so the two sides cannot disagree on what counts as a change.
export const selectionChanged = (from: SimulationSelection, to: SimulationSelection) => (
	getRpcNetworkChange(from.activeRpcNetwork, to.activeRpcNetwork).endpointChanged
	|| !activeStackContextsEqual(getActiveStackContext(from), getActiveStackContext(to))
)

// External-wallet signing without a Safe has no simulated stack to show; simulation mode and Safe signing do.
export const selectionShowsStack = (selection: SimulationSelection) => selection.simulationMode || selection.activeSigningSafeAddress !== undefined

// Whether changing from `from` to `to` must queue a refresh of its own. It is selectionChanged except where `to` shows no stack: the refresh that steps aside then leaves the previous visualisation, rather than publishing the previous selection's stack over a selection that shows none.
export const selectionNeedsRefresh = (from: SimulationSelection, to: SimulationSelection) => selectionChanged(from, to) && selectionShowsStack(to)
