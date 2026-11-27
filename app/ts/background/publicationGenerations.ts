// Each capability owns an instance. Epoch changes invalidate captured publications before any feature-specific retraction sends run.
export function createPublicationGenerations<Key>(initialEnabled?: boolean) {
	let enabled = initialEnabled
	const tokens = new Map<Key, object>()
	return {
		getEnabled: () => enabled,
		begin(key: Key) {
			if (enabled !== true) return () => false
			const token = {}
			tokens.set(key, token)
			return () => enabled === true && tokens.get(key) === token
		},
		retract: (key: Key) => tokens.delete(key),
		setEnabled(next: boolean): ReadonlySet<Key> | undefined {
			if (enabled === next) return undefined
			enabled = next
			const invalidated = new Set(tokens.keys())
			tokens.clear()
			return invalidated
		},
	}
}
