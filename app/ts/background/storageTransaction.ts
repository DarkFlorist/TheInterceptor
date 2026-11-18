import { Semaphore } from '../utils/semaphore.js'

type StorageTransactionPlan<Write, Result> = { readonly writes: readonly Write[], readonly result: Result }

// Creates the runner of one group of storage keys whose read-modify-writes must not interleave. Each run reads under the group's lock, and commit stores every write the plan returns in a single storage set, so the writes land together or not at all. A plan must only read storage: starting another run of the same group inside it would wait for the lock forever.
export function createStorageTransactionRunner<Write>(commit: (writes: readonly Write[]) => Promise<void>) {
	const lock = new Semaphore(1)
	return async <Result>(plan: () => Promise<StorageTransactionPlan<Write, Result>>) => await lock.execute(async () => {
		const { writes, result } = await plan()
		if (writes.length > 0) await commit(writes)
		return result
	})
}
