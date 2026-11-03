// Counts committed changes of the active network. Only networkTransition.ts advances it, under the network transition lock and as the first effect of a change, and snapshots built under that lock record it; it lives in its own module so snapshot building can read it without importing the transition module.
let committedNetworkChanges = 0

export const getCommittedNetworkChangeGeneration = () => committedNetworkChanges

export const advanceCommittedNetworkChangeGeneration = () => {
	committedNetworkChanges += 1
}
