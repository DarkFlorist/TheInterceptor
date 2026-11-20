import * as assert from 'assert'
import { test } from 'bun:test'
import { ImportSettingsReply } from '../../app/ts/types/interceptor-messages.js'
import { createPopupSettingsCoordinator } from '../../app/ts/background/popupSettingsCoordinator.js'
import { acceptPopupSettingsChangeStatus, popupSettingsOperations, PopupSettingsOperation, type PopupSettingsChangeStatus } from '../../app/ts/types/popupSettingsProtocol.js'
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

test('admitted operation validation is derived from every protocol descriptor, including imports', () => {
	assert.equal(popupSettingsOperations.popup_import_settings.operation, 'import')
	for (const descriptor of Object.values(popupSettingsOperations)) assert.equal(PopupSettingsOperation.parse(descriptor.operation), descriptor.operation)
	assert.equal(PopupSettingsOperation.safeParse('unknown').success, false)
})


test('the import descriptor owns a valid broadcast admission-failure reply', () => {
	const reply = popupSettingsOperations.popup_import_settings.reply.createFailure('Settings are busy')
	assert.deepEqual(ImportSettingsReply.parse(reply), { method: 'popup_initiate_export_settings_reply', data: { success: false, errorMessage: 'Settings are busy' } })
})

test('token funding is an admitted rich command with a valid token-shaped failure reply', async () => {
	const { PopupRequestsReplies } = await import('../../app/ts/types/interceptor-reply-messages.js')
	const descriptor = popupSettingsOperations.popup_modifyRichToken
	assert.equal(descriptor.operation, 'rich')
	assert.deepEqual(PopupRequestsReplies.popup_modifyRichToken.parse(descriptor.reply.createFailure('Settings are busy')), { method: 'popup_modifyRichToken', result: { success: false, error: 'Settings are busy' } })
})
