import type { GnosisSafeAppsRequestCommand } from '../types/gnosisSafeApps.js'

const pending = new WeakMap<browser.runtime.Port, Map<string, { command: GnosisSafeAppsRequestCommand, executed: boolean }>>()
type CommandCandidate = Record<string, unknown> & { readonly method?: unknown, readonly params?: unknown, readonly commandToken?: unknown, readonly message?: unknown, readonly safeAddress?: unknown, readonly chainId?: unknown, readonly isTypedData?: unknown }
const record = (value: unknown): value is CommandCandidate => typeof value === 'object' && value !== null

// Browser serialization may reorder object fields; compare JSON values structurally.
function sameCommand(left: unknown, right: unknown): boolean {
	if (left === right) return true
	if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameCommand(value, right[index]))
	if (!record(left) || !record(right)) return false
	const keys = Object.keys(left).filter((key) => left[key] !== undefined)
	return keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameCommand(left[key], right[key]))
}

// Capabilities are issued only after SDK policy admission and belong to the exact browser connection.
export function bindGnosisSafeAppsCommand(port: browser.runtime.Port, command: GnosisSafeAppsRequestCommand) {
	if (command.kind !== 'ethereumRequest' || command.safeRequestContext === undefined) return command
	let commands = pending.get(port)
	if (commands === undefined) { commands = new Map(); pending.set(port, commands) }
	if (commands.size >= 100) throw new Error('Too many pending Gnosis Safe Apps commands.')
	const commandToken = crypto.randomUUID()
	commands.set(commandToken, { command, executed: false })
	return { ...command, commandToken }
}

export function admitGnosisSafeAppsPrivateCommand(port: browser.runtime.Port, value: unknown) {
	if (!record(value) || (value.method !== 'execute' && value.method !== 'submitOffChainMessage')) return true
	const payload = value.params
	if (!record(payload) || typeof payload.commandToken !== 'string') return false
	const commands = pending.get(port)
	const captured = commands?.get(payload.commandToken)
	if (captured === undefined || captured.command.kind !== 'ethereumRequest') return false
	const { commandToken, ...supplied } = payload
	if (value.method === 'execute') {
		if (captured.executed || !sameCommand(supplied, captured.command)) return false
		captured.executed = true
		if (captured.command.mapResult !== 'safeMessage') commands?.delete(commandToken)
		return true
	}
	const command = captured.command
	if (!captured.executed || command.mapResult !== 'safeMessage' || payload.message !== command.message || payload.safeAddress !== command.safeAddress || payload.chainId !== command.chainId || (payload.isTypedData === true) !== (command.isTypedData === true)) return false
	commands?.delete(commandToken)
	return true
}
