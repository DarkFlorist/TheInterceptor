const MAX_DIAGNOSTIC_TEXT_LENGTH = 16_000
const MAX_DIAGNOSTIC_FIELD_LENGTH = 8_000
const MAX_ERROR_CAUSE_DEPTH = 8
const MAX_ERROR_SNAPSHOT_NODES = 128
const MAX_ERROR_SNAPSHOT_TEXT = 12_000
const TRUNCATION_NOTICE = '\n[Diagnostic text truncated]'
const MAX_CONTEXT_DEPTH = 6
const MAX_CONTEXT_ENTRIES = 50
const MAX_CONTEXT_NODES = 256
type ErrorSnapshotBudget = { remainingNodes: number, remainingText: number }
const UNREADABLE_ERROR_FIELD = '[Error field could not be read]'
type ErrorSnapshot = { className?: string, name?: string, message?: string, stack?: string, cause?: ErrorSnapshot | string, errors?: unknown[], omitted?: string }

function limitDiagnosticText(value: string, limit = MAX_DIAGNOSTIC_TEXT_LENGTH): string {
	return value.length <= limit ? value : `${ value.slice(0, limit - TRUNCATION_NOTICE.length) }${ TRUNCATION_NOTICE }`
}

function ownDataProperty(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key)
	return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
}

// Standard fields use normal property access: native errors inherit name and message from their prototype, and V8 defines stack as an accessor.
function readStandardErrorField(error: Error, key: 'name' | 'message' | 'stack'): unknown {
	try {
		return error[key]
	} catch {
		return UNREADABLE_ERROR_FIELD
	}
}

function readErrorClassName(error: Error): unknown {
	try {
		return error.constructor?.name
	} catch {
		return UNREADABLE_ERROR_FIELD
	}
}

function budgetedErrorText(value: unknown, budget: ErrorSnapshotBudget): string | undefined {
	if (budget.remainingText <= TRUNCATION_NOTICE.length) return undefined
	if (typeof value !== 'string' || value === '') return undefined
	const text = limitDiagnosticText(value, Math.min(MAX_DIAGNOSTIC_FIELD_LENGTH, budget.remainingText))
	budget.remainingText -= text.length
	return text
}

function snapshotError(error: Error, seen: WeakSet<object>, budget: ErrorSnapshotBudget, depth = 0): ErrorSnapshot {
	if (seen.has(error)) return { omitted: '[Repeated or circular error reference]' }
	if (depth >= MAX_ERROR_CAUSE_DEPTH) return { cause: '[Maximum error cause depth reached]' }
	if (budget.remainingNodes === 0) return { omitted: '[Diagnostic inspection limit reached]' }
	budget.remainingNodes -= 1
	seen.add(error)
	const cause = ownDataProperty(error, 'cause')
	const errors = ownDataProperty(error, 'errors')
	const name = budgetedErrorText(readStandardErrorField(error, 'name'), budget) ?? 'Error'
	const snapshot: ErrorSnapshot = {
		className: budgetedErrorText(readErrorClassName(error), budget) ?? name,
		name,
		message: budgetedErrorText(readStandardErrorField(error, 'message'), budget),
		stack: budgetedErrorText(readStandardErrorField(error, 'stack'), budget),
	}
	if (cause instanceof Error) snapshot.cause = snapshotError(cause, seen, budget, depth + 1)
	if (Array.isArray(errors)) {
		const children: unknown[] = []
		const errorsLength = ownDataProperty(errors, 'length')
		const errorCount = typeof errorsLength === 'number' ? errorsLength : 0
		for (let index = 0; index < Math.min(errorCount, 10); index++) {
			if (budget.remainingNodes === 0 || budget.remainingText === 0) {
				children.push('[Remaining errors omitted]')
				break
			}
			const value = ownDataProperty(errors, String(index))
			children.push(value instanceof Error ? snapshotError(value, seen, budget, depth + 1) : '[Non-Error value omitted]')
		}
		snapshot.errors = children
	}
	return snapshot
}

// Context is caller-supplied and may hold website data, so it is copied generically but defensively: own data properties only (getters are never run), with bounded depth, entries, nodes and text.
function snapshotContextValue(value: unknown, seen: WeakSet<object>, budget: ErrorSnapshotBudget, depth: number): unknown {
	if (value === undefined) return '[undefined]'
	if (value === null || typeof value === 'boolean') return value
	if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
	if (typeof value === 'bigint') return String(value)
	if (typeof value === 'string') return budgetedErrorText(value, budget) ?? (value === '' ? '' : '[Diagnostic inspection limit reached]')
	if (typeof value === 'symbol' || typeof value === 'function') return `[${ typeof value } omitted]`
	if (value instanceof Error) return snapshotError(value, seen, budget, depth)
	if (seen.has(value)) return '[Repeated or circular context reference]'
	if (depth >= MAX_CONTEXT_DEPTH) return '[Maximum context depth reached]'
	if (budget.remainingNodes === 0) return '[Diagnostic inspection limit reached]'
	budget.remainingNodes -= 1
	seen.add(value)
	if (value instanceof Date) return snapshotDate(value)
	if (value instanceof Map) return snapshotCollection(Map.prototype.entries, value, seen, budget, depth)
	if (value instanceof Set) return snapshotCollection(Set.prototype.values, value, seen, budget, depth)
	if (Array.isArray(value)) {
		const length = ownDataProperty(value, 'length')
		const entryCount = typeof length === 'number' ? length : 0
		const entries = Array.from({ length: Math.min(entryCount, MAX_CONTEXT_ENTRIES) }, (_, index) => snapshotOwnProperty(value, String(index), seen, budget, depth + 1))
		return entryCount > MAX_CONTEXT_ENTRIES ? [...entries, `[${ entryCount - MAX_CONTEXT_ENTRIES } more entries omitted]`] : entries
	}
	// Captures own enumerable string keys, matching JSON and main's diagnostics; non-enumerable and symbol keys are intentionally not captured.
	const keys = Object.keys(value)
	const entries: [string, unknown][] = keys.slice(0, MAX_CONTEXT_ENTRIES).map((key) => [key, snapshotOwnProperty(value, key, seen, budget, depth + 1)])
	if (keys.length > MAX_CONTEXT_ENTRIES) entries.push(['[omitted]', `${ keys.length - MAX_CONTEXT_ENTRIES } more properties omitted`])
	// Object.fromEntries defines own properties, so a caller key such as __proto__ is kept instead of hitting the inherited prototype setter.
	return Object.fromEntries(entries)
}

// Native prototype methods are called directly so a Date with overridden getTime or toISOString cannot run caller code.
function snapshotDate(value: Date) {
	try {
		return Number.isNaN(Date.prototype.getTime.call(value)) ? '[Invalid Date]' : Date.prototype.toISOString.call(value)
	} catch {
		return '[Unreadable Date]'
	}
}

// Iterates through the native prototype method and stops at the entry limit, so overridden collection methods never run and large collections stay bounded.
function snapshotCollection<T>(iterate: (this: T) => Iterable<unknown>, collection: T, seen: WeakSet<object>, budget: ErrorSnapshotBudget, depth: number) {
	const entries: unknown[] = []
	for (const entry of iterate.call(collection)) {
		if (entries.length === MAX_CONTEXT_ENTRIES) {
			entries.push('[More entries omitted]')
			break
		}
		entries.push(snapshotContextValue(entry, seen, budget, depth + 1))
	}
	return entries
}

function snapshotOwnProperty(value: object, key: string, seen: WeakSet<object>, budget: ErrorSnapshotBudget, depth: number): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key)
	if (descriptor === undefined) return undefined
	if (!('value' in descriptor)) return '[Getter omitted]'
	return snapshotContextValue(descriptor.value, seen, budget, depth)
}

export function stringifyDiagnosticDetails(details: unknown): string | undefined {
	if (details === undefined) return undefined
	if (typeof details === 'string') return limitDiagnosticText(details)
	if (details === null || typeof details === 'boolean' || typeof details === 'number' || typeof details === 'bigint') return limitDiagnosticText(String(details))
	try {
		if (details instanceof Error) return limitDiagnosticText(JSON.stringify(snapshotError(details, new WeakSet<object>(), { remainingNodes: MAX_ERROR_SNAPSHOT_NODES, remainingText: MAX_ERROR_SNAPSHOT_TEXT })))
		return limitDiagnosticText(JSON.stringify(snapshotContextValue(details, new WeakSet<object>(), { remainingNodes: MAX_CONTEXT_NODES, remainingText: MAX_ERROR_SNAPSHOT_TEXT }, 0)) ?? '[Structured diagnostic context omitted]')
	} catch {
		return '[Error details could not be inspected]'
	}
}

export function stringifyErrorForDiagnostic(error: unknown): string | undefined {
	if (typeof error === 'object' && error !== null) {
		try {
			if (error instanceof Error) return stringifyDiagnosticDetails(error)
		} catch {
			return '[Error details could not be inspected]'
		}
		return '[Non-Error thrown object omitted]'
	}
	return stringifyDiagnosticDetails(error)
}
