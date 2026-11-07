import * as assert from 'node:assert'
import { test } from 'bun:test'

// Pins, per module, the lock order that confirmationWindowLifecycle.ts defines.
const sourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
const sources = new Map<string, string>()
const rawSources = new Map<string, string>()
for await (const file of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: sourceDirectory })) {
	const source = await Bun.file(`${ sourceDirectory }${ file }`).text()
	rawSources.set(file, source)
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

test('every lock is classified in the lock order contract', () => {
	const contractSource = rawSources.get('background/confirmationWindowLifecycle.ts') ?? ''
	const contract = contractSource.slice(contractSource.indexOf('The lock order of the background'), contractSource.indexOf('test/tests/lockOrderBoundaries.test.ts'))
	assert.ok(contract.length > 0, 'the contract is found')
	// The keyed executor creates its locks inside utils/semaphore.ts; each executor is the lock to classify.
	const lockSources = [...sources].filter(([file]) => file !== 'utils/semaphore.ts')
	const lockNames = lockSources.flatMap(([, source]) => [...source.matchAll(/\b(?:const|let) (\w+) = (?:new Semaphore\(|createScopedKeyedSerialExecutor\b)/gu)].flatMap((match) => match[1] === undefined ? [] : [match[1]]))
	const semaphoreCount = lockSources.reduce((count, [, source]) => count + [...source.matchAll(/\bnew Semaphore\(/gu)].length, 0)
	const namedSemaphoreCount = lockSources.reduce((count, [, source]) => count + [...source.matchAll(/\b(?:const|let) \w+ = new Semaphore\(/gu)].length, 0)
	assert.equal(semaphoreCount, namedSemaphoreCount, 'every semaphore is a named variable, so this test sees it')
	assert.ok(lockNames.length >= 25, 'the scan finds the locks')
	assert.deepEqual(lockNames.filter((name) => !new RegExp(`\\b${ name }\\b`, 'u').test(contract)), [], 'locks missing from the contract in confirmationWindowLifecycle.ts')
})

// The modules a module loads, skipping imports of types only, which do not exist at runtime.
const getRuntimeImports = (file: string) => {
	const source = getSource(file)
	const directory = file.slice(0, file.lastIndexOf('/') + 1)
	const specifiers = [...source.matchAll(/^import (?!type )(?!\{ type [^,}]* \})[^\n]* from '(\.[^']+)'/gmu), ...source.matchAll(/\bimport\('(\.[^']+)'\)/gu)].flatMap((match) => match[1] === undefined ? [] : [match[1]])
	return specifiers.flatMap((specifier) => {
		const resolved = new URL(specifier.replace(/\.js$/u, ''), `file:///${ directory }`).pathname.slice(1)
		return [`${ resolved }.ts`, `${ resolved }.tsx`].filter((candidate) => sources.has(candidate))
	})
}
const getRuntimeClosure = (file: string) => {
	const reached = new Set<string>()
	const toVisit = [file]
	while (toVisit.length > 0) {
		const next = toVisit.pop()
		if (next === undefined || reached.has(next)) continue
		reached.add(next)
		toVisit.push(...getRuntimeImports(next))
	}
	return reached
}

test('the modules of the locks below the pending-confirmation lock cannot reach it', () => {
	const lockModules = [
		'background/simulationStackHashes.ts',
		'background/terminalReplyDelivery.ts',
		'background/popupVisualisationUpdater.ts',
		'background/simulationUpdating.ts',
		'background/windows/watchAsset.ts',
		'background/rpcSlowRequestTracking.ts',
		'simulation/services/EthereumSubscriptionService.ts',
		'background/storageVariables.ts',
		'background/pendingTerminalReplies.ts',
		'background/settings.ts',
		'utils/largeStateStore.ts',
	]
	for (const file of lockModules) {
		const reached = getRuntimeClosure(file)
		assert.ok(reached.size > 1 || file === 'utils/largeStateStore.ts', `${ file } has imports`)
		for (const pendingConfirmationModule of ['background/confirmationWindowLifecycle.ts', 'background/windows/confirmTransaction.ts', 'background/requestResolution.ts']) {
			assert.equal(reached.has(pendingConfirmationModule), false, `${ file } reaches ${ pendingConfirmationModule }`)
		}
	}
})

test('the signer-state lock is taken only by its callers, and what runs under the pending-confirmation lock takes no earlier lock', () => {
	assert.deepEqual(filesMatching(/\brunSignerStateOperation\(/u), ['background/providerMessageHandlers.ts', 'background/signerStateOwnership.ts', 'background/walletSwitch.ts', 'background/websiteTabConnections.ts'])
	const earlierLocks = /\b(?:runSignerStateOperation|requestAccessFromUser|activateAddressSelection|changeActiveAddressAndChain|askForSignerAccountsFromSignerIfNotAvailable|refreshSignerAccountsForTab|refreshSignerAccountsFromApprovedWebsitePorts)\(/u
	for (const file of ['background/windows/confirmTransaction.ts', 'background/requestResolution.ts', 'background/confirmationWindowLifecycle.ts', 'background/simulationStackHashes.ts', 'background/terminalReplyDelivery.ts']) {
		assert.doesNotMatch(getSource(file), earlierLocks, file)
	}
})
