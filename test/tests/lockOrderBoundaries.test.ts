import * as assert from 'node:assert'
import { test } from 'bun:test'

// Pins, per module, the lock order that confirmationWindowLifecycle.ts defines.
const sourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
const sources = new Map<string, string>()
for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: sourceDirectory })) {
	const source = await Bun.file(`${ sourceDirectory }${ file }`).text()
	sources.set(file, source.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).join('\n'))
}
const getSource = (file: string) => {
	const source = sources.get(file)
	if (source === undefined) throw new Error(`Missing source ${ file }`)
	return source
}
const filesMatching = (pattern: RegExp) => [...sources].filter(([, source]) => pattern.test(source)).map(([file]) => file).sort()

const PENDING_CONFIRMATION_LOCK = /\bwithPendingConfirmationLock\(/u
const SIMULATION_HASH_LOCK = /\bwithSimulationHashLock\(/u
const TERMINAL_REPLY_LOCK = /\bterminalReplySemaphore\b/u
const INPUT_LOG_LOCK = /\binputLogSemaphore\b/u

test('each lock is taken only by the modules that the lock order lists', () => {
	assert.deepEqual(filesMatching(PENDING_CONFIRMATION_LOCK), ['background/confirmationWindowLifecycle.ts', 'background/windows/confirmTransaction.ts'])
	assert.deepEqual(filesMatching(SIMULATION_HASH_LOCK), ['background/popupMessageHandlers.ts', 'background/simulationStackHashes.ts', 'background/windows/confirmTransaction.ts'])
	assert.deepEqual(filesMatching(TERMINAL_REPLY_LOCK), ['background/terminalReplyDelivery.ts'])
	assert.deepEqual(filesMatching(INPUT_LOG_LOCK), ['background/requestResolution.ts'])
})

test('the modules of the inner locks take no outer lock', () => {
	for (const file of ['background/simulationStackHashes.ts', 'background/terminalReplyDelivery.ts', 'background/storageVariables.ts', 'background/pendingTerminalReplies.ts']) {
		assert.doesNotMatch(getSource(file), PENDING_CONFIRMATION_LOCK, file)
	}
	for (const file of ['background/terminalReplyDelivery.ts', 'background/requestResolution.ts', 'background/storageVariables.ts', 'background/pendingTerminalReplies.ts']) {
		assert.doesNotMatch(getSource(file), SIMULATION_HASH_LOCK, file)
	}
})

test('the storage modules import no module that owns a lock above them', () => {
	for (const file of ['background/storageVariables.ts', 'background/pendingTerminalReplies.ts']) {
		assert.doesNotMatch(getSource(file), /from '\.\/(?:confirmationWindowLifecycle|simulationStackHashes|terminalReplyDelivery|requestResolution)\.js'/u, file)
	}
})

test('registering a transaction takes the hash lock inside the pending-confirmation lock', () => {
	const confirmTransaction = getSource('background/windows/confirmTransaction.ts')
	const opener = confirmTransaction.slice(confirmTransaction.indexOf('export async function openConfirmTransactionDialogForTransaction('))
	const pendingConfirmationLock = opener.search(PENDING_CONFIRMATION_LOCK)
	const hashLock = opener.search(SIMULATION_HASH_LOCK)
	assert.ok(pendingConfirmationLock >= 0 && hashLock > pendingConfirmationLock)
})
