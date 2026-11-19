import { hasOwnKey } from './typescript.js'

export type StorageWriteValue = string | number | bigint | boolean | undefined

type PendingWrite = { readonly changes: Readonly<Record<string, unknown>>, readonly completed: Promise<void> }

// Owned by the storage facade: snapshots observe writes of one key/value, including writes already pending when captured. No storage schema or domain policy lives here.
export function createStorageWriteTracking() {
	const revisions = new Map<string, Map<StorageWriteValue, number>>()
	const pending = new Set<PendingWrite>()
	const matches = (write: PendingWrite, key: string, value: StorageWriteValue) => hasOwnKey(write.changes, key) && write.changes[key] === value

	const capture = (key: string, value: StorageWriteValue) => {
		const values = revisions.get(key) ?? new Map<StorageWriteValue, number>()
		if (!values.has(value)) values.set(value, 0)
		revisions.set(key, values)
		const capturedRevision = values.get(value) ?? 0
		return {
			isCurrent: () => values.get(value) === capturedRevision && ![...pending].some((write) => matches(write, key, value)),
			// Wait only for matching writes pending now; callers still check a fresh snapshot before acting. A stalled write never forces an unbounded wait.
			waitForPendingWrites: async (timeoutMs: number): Promise<boolean> => {
				const writes = [...pending].filter((write) => matches(write, key, value)).map((write) => write.completed)
				if (writes.length === 0) return true
				let timer: ReturnType<typeof setTimeout> | undefined
				try {
					return await Promise.race([
						Promise.all(writes).then(() => true),
						new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
					])
				} finally {
					clearTimeout(timer)
				}
			},
		}
	}

	const write = async (changes: Readonly<Record<string, unknown>>, persist: () => Promise<void>) => {
		let complete: () => void = () => undefined
		const completed = new Promise<void>((resolve) => { complete = resolve })
		const entry = { changes, completed }
		// Register before calling storage, preserving invocation order between consecutive writes.
		pending.add(entry)
		try {
			await persist()
		} finally {
			// Even a failed write may have become visible. Snapshots captured before or during it must re-read storage.
			for (const [key, values] of revisions) {
				for (const [value, revision] of values) {
					if (matches(entry, key, value)) values.set(value, revision + 1)
				}
			}
			pending.delete(entry)
			complete()
		}
	}
	return { capture, write }
}
