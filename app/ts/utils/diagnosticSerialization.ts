function describeDiagnosticInspectionError(error: unknown) {
	try { return error instanceof Error ? error.message : String(error) }
	catch { return 'unknown inspection failure' }
}

type DiagnosticSnapshot = Record<string, unknown> & { name?: unknown, message?: unknown, stack?: unknown, inspectionError?: unknown }

function snapshotDiagnosticValue(value: unknown, seen: WeakSet<object>): unknown {
	if (value === undefined) return '[undefined]'
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
	if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
	if (typeof value === 'function') return `[Function ${ value.name || 'anonymous' }]`
	if (seen.has(value)) return '[Circular reference]'
	seen.add(value)
	try {
		if (value instanceof Date) {
			try { return Number.isNaN(value.valueOf()) ? 'Invalid Date' : value.toISOString() }
			catch (error) { return `[Unreadable date: ${ describeDiagnosticInspectionError(error) }]` }
		}
		const snapshot: DiagnosticSnapshot = Object.create(null)
		const readProperty = (key: PropertyKey) => {
			try { return snapshotDiagnosticValue(Reflect.get(value, key), seen) }
			catch (error) { return `[Unreadable property: ${ describeDiagnosticInspectionError(error) }]` }
		}
		if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => readProperty(index))
		if (value instanceof Error) {
			snapshot.name = readProperty('name')
			snapshot.message = readProperty('message')
			snapshot.stack = readProperty('stack')
		}
		try {
			for (const key of Reflect.ownKeys(value)) {
				if (value instanceof Error && (key === 'name' || key === 'message' || key === 'stack')) continue
				snapshot[typeof key === 'symbol' ? String(key) : key] = readProperty(key)
			}
		} catch (error) {
			snapshot.inspectionError = describeDiagnosticInspectionError(error)
		}
		return snapshot
	} finally {
		seen.delete(value)
	}
}

export function stringifyDiagnosticDetails(details: unknown): string | undefined {
	if (details === undefined) return undefined
	if (typeof details === 'string') return details
	return JSON.stringify(snapshotDiagnosticValue(details, new WeakSet<object>()))
}
