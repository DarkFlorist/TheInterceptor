import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { WebsiteAccessArray } from '../../app/ts/types/websiteAccessTypes.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

describe('website access migration', () => {
	test('sanitizes stored remote website icons', async () => {
		const browserMock = installBrowserMock({
			storage: {
				local: {
					websiteAccess: [
						{ website: { websiteOrigin: 'remote.example', icon: 'https://remote.example/favicon.png', title: 'Remote' }, access: true },
						{ website: { websiteOrigin: 'cached.example', icon: 'data:image/png;base64,Y2FjaGVk', title: 'Cached' }, access: true },
					],
				},
			},
		})
		const { migrateWebsiteAccess } = await import('../../app/ts/background/websiteAccessMigration.js')

		await migrateWebsiteAccess()

		const storedWebsiteAccess = new Map(Object.entries(browserMock.readStorage())).get('websiteAccess')
		assert.equal(Array.isArray(storedWebsiteAccess), true)
		const websiteAccess = WebsiteAccessArray.parse(storedWebsiteAccess)
		assert.equal(websiteAccess[0]?.website.icon, undefined)
		assert.equal(websiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')
	})
})
