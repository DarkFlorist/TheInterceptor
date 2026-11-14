// Counts committed changes of the active network. Only networkTransition.ts advances it, under the network transition lock and as the first effect of a change, and snapshots built under that lock record it; it lives in its own module so snapshot building can read it without importing the transition module.
let committedNetworkChanges = 0

export const getCommittedNetworkChangeGeneration = () => committedNetworkChanges

// Whether no network change committed since this read, even one that returned to the same endpoint. This is the check for a step that is about to act: cancelling a refresh, simulating, storing or broadcasting. It is synchronous, so nothing commits between it and the start of that step, and it sees a change the moment it commits, while its transition is still running. A change that commits while a write is in flight has its refresh serialized after that write. Two other checks answer different questions: snapshotNetworkIsStillActive in popupMessageHandlers.ts first waits for a transition in progress, for a home page that must not be published from settings a running change is about to replace, and it lives there because that wait needs the lock this module must not import. readsShareNetworkAndStackContext in confirmTransaction.ts compares two reads, because a re-read continues a request only if no change committed between them and its stack context is the same.
export const snapshotNetworkIsActive = (read: { readonly networkChangeGeneration: number }) => read.networkChangeGeneration === committedNetworkChanges

export const advanceCommittedNetworkChangeGeneration = () => {
	committedNetworkChanges += 1
}
