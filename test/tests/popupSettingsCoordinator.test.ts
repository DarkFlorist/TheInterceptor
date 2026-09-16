import * as assert from 'assert'
import { test } from 'bun:test'
import { createPopupSettingsCoordinator } from '../../app/ts/background/popupSettingsCoordinator.js'
import { acceptPopupSettingsChangeStatus, type PopupSettingsChangeStatus } from '../../app/ts/types/popupSettingsProtocol.js'
import { createDeferredValue } from './backgroundEthAccountsTestHarness.js'

test('coordinator admits once, orders status despite clock rollback, and recovers after failure', async () => {
	const statuses: PopupSettingsChangeStatus['data'][] = []
	let clock = 100
	const coordinator = createPopupSettingsCoordinator(async status => { statuses.push(status) }, () => clock)
	const release = createDeferredValue<void>()
	const pending = coordinator.run('rpc', async () => { await release.promise; return 'saved' })
	assert.deepEqual(await coordinator.run('wallet', async () => { throw new Error('Busy action must not run') }), { accepted: false })
	await coordinator.publish()
	assert.equal(statuses[0]?.operation, 'rpc')
	assert.deepEqual(statuses[1], statuses[0])
	clock = 0
	release.resolve(undefined)
	assert.deepEqual(await pending, { accepted: true, result: 'saved' })
	const busy = statuses[0]
	const idle = statuses.at(-1)
	if (busy === undefined || idle === undefined) throw new Error('Missing coordinator status')
	assert.ok(idle.revision > busy.revision)
	assert.equal(acceptPopupSettingsChangeStatus(idle, busy), idle)
	await assert.rejects(coordinator.run('rich', async () => { throw new Error('Storage failed') }), /Storage failed/)
	assert.equal(statuses.at(-1)?.operation, undefined)
	assert.deepEqual(await coordinator.run('mode', async () => 'saved'), { accepted: true, result: 'saved' })
})
