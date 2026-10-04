function describeDiagnosticInspectionError(error: unknown) {
	try { return (error instanceof Error ? error.message : String(error)).slice(0, 512) }
	catch { return 'unknown inspection failure' }
}

type DiagnosticSnapshot = Record<string, unknown> & { name?: unknown, message?: unknown, stack?: unknown, inspectionError?: unknown, omittedProperties?: unknown }

const MAX_DIAGNOSTIC_DEPTH = 20
const MAX_DIAGNOSTIC_ENTRIES = 100
const MAX_DIAGNOSTIC_LENGTH = 64_000
const MAX_DIAGNOSTIC_NODES = 1_000
const MAX_DIAGNOSTIC_SNAPSHOT_TEXT = 32_000
const MAX_DIAGNOSTIC_VALUE_LENGTH = 8_000
const TRUNCATION_NOTICE = '\n[Diagnostic text truncated]'
const INSPECTION_LIMIT_NOTICE = '[Diagnostic inspection limit reached]'
const VALUE_TRUNCATION_NOTICE = '[Diagnostic value truncated]'

type SnapshotBudget = { remainingNodes: number, remainingText: number }

function snapshotText(value: string, budget: SnapshotBudget): string {
	const available = Math.min(MAX_DIAGNOSTIC_VALUE_LENGTH, budget.remainingText)
	const text = value.slice(0, available)
	budget.remainingText -= text.length
	return text.length === value.length ? text : `${ text }${ VALUE_TRUNCATION_NOTICE }`
}

function limitDiagnosticText(value: string): string {
	return value.length <= MAX_DIAGNOSTIC_LENGTH ? value : `${ value.slice(0, MAX_DIAGNOSTIC_LENGTH - TRUNCATION_NOTICE.length) }${ TRUNCATION_NOTICE }`
}

function snapshotDiagnosticValue(value: unknown, seen: WeakSet<object>, budget: SnapshotBudget, depth = 0): unknown {
	if (budget.remainingNodes === 0 || budget.remainingText === 0) return INSPECTION_LIMIT_NOTICE
	budget.remainingNodes -= 1
	if (value === undefined) return '[undefined]'
	if (value === null || typeof value === 'boolean') return value
	if (typeof value === 'string') return snapshotText(value, budget)
	if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
	if (typeof value === 'bigint' || typeof value === 'symbol') return snapshotText(String(value), budget)
	if (typeof value === 'function') return snapshotText(`[Function ${ value.name || 'anonymous' }]`, budget)
	if (depth >= MAX_DIAGNOSTIC_DEPTH) return '[Maximum diagnostic depth reached]'
	if (seen.has(value)) return '[Circular reference]'
	seen.add(value)
	try {
		if (value instanceof Date) {
			try { return Number.isNaN(value.valueOf()) ? 'Invalid Date' : snapshotText(value.toISOString(), budget) }
			catch (error) { return snapshotText(`[Unreadable date: ${ describeDiagnosticInspectionError(error) }]`, budget) }
		}
		const snapshot: DiagnosticSnapshot = Object.create(null)
		const readProperty = (key: PropertyKey) => {
			if (budget.remainingNodes <= 1 || budget.remainingText === 0) return INSPECTION_LIMIT_NOTICE
			budget.remainingNodes -= 1
			try { return snapshotDiagnosticValue(Reflect.get(value, key), seen, budget, depth + 1) }
			catch (error) { return snapshotText(`[Unreadable property: ${ describeDiagnosticInspectionError(error) }]`, budget) }
		}
		if (Array.isArray(value)) {
			const snapshotArray: unknown[] = []
			const limit = Math.min(value.length, MAX_DIAGNOSTIC_ENTRIES)
			for (let index = 0; index < limit && budget.remainingNodes > 1 && budget.remainingText > 0; index++) snapshotArray.push(readProperty(index))
			if (value.length > snapshotArray.length) snapshotArray.push(`[${ value.length - snapshotArray.length } more entries omitted]`)
			return snapshotArray
		}
		if (value instanceof Error) {
			snapshot.name = readProperty('name')
			snapshot.message = readProperty('message')
			snapshot.stack = readProperty('stack')
		}
		try {
			const keys = Reflect.ownKeys(value)
			let inspectedKeys = 0
			for (const key of keys.slice(0, MAX_DIAGNOSTIC_ENTRIES)) {
				if (budget.remainingNodes <= 1 || budget.remainingText === 0) break
				inspectedKeys += 1
				if (value instanceof Error && (key === 'name' || key === 'message' || key === 'stack')) continue
				snapshot[snapshotText(typeof key === 'symbol' ? String(key) : key, budget)] = readProperty(key)
			}
			if (keys.length > inspectedKeys) snapshot.omittedProperties = `${ keys.length - inspectedKeys } more properties omitted`
		} catch (error) {
			snapshot.inspectionError = snapshotText(describeDiagnosticInspectionError(error), budget)
		}
		return snapshot
	} finally {
		seen.delete(value)
	}
}

export function stringifyDiagnosticDetails(details: unknown): string | undefined {
	if (details === undefined) return undefined
	if (typeof details === 'string') return limitDiagnosticText(details)
	try {
		const budget: SnapshotBudget = { remainingNodes: MAX_DIAGNOSTIC_NODES, remainingText: MAX_DIAGNOSTIC_SNAPSHOT_TEXT }
		return limitDiagnosticText(JSON.stringify(snapshotDiagnosticValue(details, new WeakSet<object>(), budget)))
	} catch (error) {
		let fallback: string
		try { fallback = String(details) } catch { fallback = '[Value could not be inspected]' }
		return limitDiagnosticText(`[Diagnostic inspection failed: ${ describeDiagnosticInspectionError(error) }] ${ fallback }`)
	}
}
