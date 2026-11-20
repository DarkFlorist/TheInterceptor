import * as assert from 'assert'
import { describe, spyOn, test } from 'bun:test'

const defineGlobal = (name: PropertyKey, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

function installBrowserMock(idsOfOpenedTabs: unknown) {
	const storageState: Record<string, unknown> = idsOfOpenedTabs === undefined ? {} : { idsOfOpenedTabs }
	const writes: Record<string, unknown>[] = []
	defineGlobal('browser', {
		storage: {
			local: {
				async get(keys: string | string[]) {
					return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in storageState).map((key) => [key, storageState[key]]))
				},
				async set(items: Record<string, unknown>) {
					writes.push(items)
					Object.assign(storageState, items)
				},
			},
		},
	})
	return { storageState, writes }
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/managementTabMigration.js'),
		...await import('../../app/ts/background/storageVariables.js'),
	}
}

describe('management tab migration', () => {
	test('carries the legacy settings tab ID over to the management tab ID', async () => {
		const { storageState } = installBrowserMock({ settingsView: 42, addressBook: 8, websiteAccess: 9, simulationStack: 10 })
		const { migrateManagementTabId, getManagementTabId } = await loadModules()

		await migrateManagementTabId()

		assert.deepEqual(storageState.idsOfOpenedTabs, { managementTabId: 42 })
		assert.equal(await getManagementTabId(), 42)
	})

	test('prefers an existing management tab ID over the legacy settings tab ID', async () => {
		const { storageState } = installBrowserMock({ settingsView: 42, managementTabId: 43 })
		const { migrateManagementTabId } = await loadModules()

		await migrateManagementTabId()

		assert.deepEqual(storageState.idsOfOpenedTabs, { managementTabId: 43 })
	})

	test('drops legacy standalone page tab IDs that have no management equivalent', async () => {
		const { storageState } = installBrowserMock({ addressBook: 8, websiteAccess: 9, simulationStack: 10 })
		const { migrateManagementTabId, getManagementTabId } = await loadModules()

		await migrateManagementTabId()

		assert.deepEqual(storageState.idsOfOpenedTabs, {})
		assert.equal(await getManagementTabId(), undefined)
	})

	test('leaves already migrated or absent tab IDs untouched', async () => {
		for (const idsOfOpenedTabs of [undefined, {}, { managementTabId: 43 }]) {
			const { writes } = installBrowserMock(idsOfOpenedTabs)
			const { migrateManagementTabId } = await loadModules()

			await migrateManagementTabId()

			assert.deepEqual(writes, [])
		}
	})
})

describe('management tab ID accessors', () => {
	test('stores the management tab ID and reads it back', async () => {
		const { storageState } = installBrowserMock(undefined)
		const { getManagementTabId, setManagementTabId } = await loadModules()

		assert.equal(await getManagementTabId(), undefined)
		await setManagementTabId(77)

		assert.deepEqual(storageState.idsOfOpenedTabs, { managementTabId: 77 })
		assert.equal(await getManagementTabId(), 77)
	})

	test('treats a corrupt stored value as no tracked tab', async () => {
		installBrowserMock({ managementTabId: 'not a tab id' })
		const { getManagementTabId } = await loadModules()
		const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
		try {
			assert.equal(await getManagementTabId(), undefined)
			assert.equal(warn.mock.calls[0]?.[0], 'Opened tab IDs was corrupt:')
		} finally {
			warn.mockRestore()
		}
	})
})
