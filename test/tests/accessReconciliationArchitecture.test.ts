import * as assert from 'node:assert'
import { test } from 'bun:test'

const appSourceDirectory = new URL('../../app/ts/', import.meta.url).pathname
const appSources: { readonly path: string, readonly source: string }[] = []
for await (const path of new Bun.Glob('**/*.{ts,tsx}').scan({ cwd: appSourceDirectory })) appSources.push({ path, source: await Bun.file(`${ appSourceDirectory }${ path }`).text() })
const accessManagementSource = appSources.find(({ path }) => path === 'background/accessManagement.ts')?.source ?? ''
const failClosedPrimitives = ['readSettingsForAccessReconciliation', 'revokeAffectedApprovalsBecauseSettingsAreUnreadable', 'getAffectedWebsites'] as const

test('the fail-closed access reconciliation primitives are private to accessManagement', () => {
	assert.notEqual(accessManagementSource, '')
	for (const primitive of failClosedPrimitives) {
		assert.match(accessManagementSource, new RegExp(`\\n(?:async )?function ${ primitive }\\(`, 'u'), primitive)
		assert.doesNotMatch(accessManagementSource, new RegExp(`export (?:async )?function ${ primitive }\\b`, 'u'), primitive)
		for (const { path, source } of appSources) if (path !== 'background/accessManagement.ts') assert.doesNotMatch(source, new RegExp(`\\b${ primitive }\\b`, 'u'), `${ path } uses ${ primitive }`)
	}
})

test('handlers reconcile committed access changes only through reconcileCommittedAccessChange', () => {
	const handlerSources = appSources.filter(({ path }) => path === 'background/background.ts' || path === 'background/popupMessageHandlers.ts' || path.startsWith('background/popupMessageHandlers/') || path.startsWith('background/popupMessageHandlerRegistries/'))
	assert.notEqual(handlerSources.length, 0)
	for (const { path, source } of handlerSources) {
		const lines = source.split('\n')
		lines.forEach((line, index) => {
			if (!/\b(?:updateWebsiteApprovalAccesses|finalizeWebsiteAccessChange)\(/u.test(line)) return
			// The reconciliation must be the callback of the command on the same or the preceding line, so it only ever receives committed settings.
			assert.equal([line, lines[index - 1] ?? ''].some((candidate) => candidate.includes('reconcileCommittedAccessChange(')), true, `${ path }:${ index + 1 }`)
		})
	}
})
