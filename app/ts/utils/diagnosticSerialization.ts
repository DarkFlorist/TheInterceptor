const MAX_DIAGNOSTIC_TEXT_LENGTH = 16_000
const MAX_DIAGNOSTIC_FIELD_LENGTH = 8_000
const MAX_ERROR_CAUSE_DEPTH = 8
const MAX_ERROR_SNAPSHOT_NODES = 128
const MAX_ERROR_SNAPSHOT_TEXT = 12_000
const TRUNCATION_NOTICE = '\n[Diagnostic text truncated]'
const SAFE_DIAGNOSTIC_CONTEXT_KEYS = ['address', 'senderAddress', 'callbackName', 'popupRefreshGeneration', 'tokenId'] as const
type ErrorSnapshotBudget = { remainingNodes: number, remainingText: number }
type ErrorSnapshot = { name?: string, message?: string, stack?: string, cause?: ErrorSnapshot | string, errors?: unknown[], omitted?: string }

function limitDiagnosticText(value: string, limit = MAX_DIAGNOSTIC_TEXT_LENGTH): string {
	return value.length <= limit ? value : `${ value.slice(0, limit - TRUNCATION_NOTICE.length) }${ TRUNCATION_NOTICE }`
}

function ownDataProperty(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key)
	return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
}

function errorField(error: Error, key: string, budget: ErrorSnapshotBudget): string | undefined {
	if (budget.remainingText <= TRUNCATION_NOTICE.length) return undefined
	const value = ownDataProperty(error, key)
	if (typeof value !== 'string') return undefined
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
	const snapshot: ErrorSnapshot = {
		name: errorField(error, 'name', budget) ?? 'Error',
		message: errorField(error, 'message', budget),
		stack: errorField(error, 'stack', budget),
	}
	if (cause instanceof Error) snapshot.cause = snapshotError(cause, seen, budget, depth + 1)
	if (Array.isArray(errors)) {
		const children: unknown[] = []
		for (let index = 0; index < Math.min(errors.length, 10); index++) {
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

export function stringifyDiagnosticDetails(details: unknown): string | undefined {
	// Inspect only known fields and bound both traversal and output before untrusted errors reach the UI.
	if (details === undefined) return undefined
	if (typeof details === 'string') return limitDiagnosticText(details)
	if (details === null || typeof details === 'boolean' || typeof details === 'number' || typeof details === 'bigint') return limitDiagnosticText(String(details))
	try {
		if (details instanceof Error) return limitDiagnosticText(JSON.stringify(snapshotError(details, new WeakSet<object>(), { remainingNodes: MAX_ERROR_SNAPSHOT_NODES, remainingText: MAX_ERROR_SNAPSHOT_TEXT })))
		if (typeof details === 'object' && details !== null) {
			const context: Record<string, string | number | boolean> = {}
			for (const key of SAFE_DIAGNOSTIC_CONTEXT_KEYS) {
				const value = ownDataProperty(details, key)
				if (typeof value === 'string') context[key] = limitDiagnosticText(value, MAX_DIAGNOSTIC_FIELD_LENGTH)
				else if (typeof value === 'number' || typeof value === 'boolean') context[key] = value
				else if (typeof value === 'bigint') context[key] = String(value)
			}
			if (Object.keys(context).length > 0) return JSON.stringify(context)
		}
	} catch {
		return '[Error details could not be inspected]'
	}
	return '[Structured diagnostic context omitted]'
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
