import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { INTERNAL_PROVIDER_ADMISSION_METHODS, INTERNAL_PROVIDER_METHODS, isInternalProviderMethod } from '../../app/shared/ts/internalProviderMethods.js'
import { getInternalRequestAdmission, internalRequestAdmissions, internalRequestAccessContextOwners } from '../../app/ts/background/internalRequestAdmissions.js'
import { getSiteReadRequestAccessContext } from '../../app/ts/background/siteReadRequestAdmission.js'
import { createRequestAccessContextResolver } from '../../app/ts/background/requestAccessContext.js'
import { installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'

test('internal admission dispatch is exhaustive and binds each access resolver to its protocol', () => {
	assert.deepEqual(Object.keys(internalRequestAdmissions).sort(), [...INTERNAL_PROVIDER_ADMISSION_METHODS].sort())
	assert.deepEqual(Object.keys(internalRequestAdmissions).sort(), ['safe_apps_request', 'site_rpc_request'])
	for (const owner of internalRequestAccessContextOwners) {
		const admission = getInternalRequestAdmission(owner.method)
		assert.ok(admission)
		assert.equal(admission.resolveAccess, owner.resolve)
		assert.equal(isInternalProviderMethod(owner.method), true)
	}
	assert.equal(getInternalRequestAdmission('safe_apps_request'), internalRequestAdmissions.safe_apps_request)
	assert.equal(getInternalRequestAdmission('site_rpc_request'), internalRequestAdmissions.site_rpc_request)
	assert.equal(internalRequestAdmissions.site_rpc_request.resolveAccess, getSiteReadRequestAccessContext)
	assert.notEqual(internalRequestAdmissions.site_rpc_request.prepare, internalRequestAdmissions.safe_apps_request.prepare)
})

test('ordinary, unknown, and non-admission internal methods cannot select an admission owner', () => {
	for (const method of [...INTERNAL_PROVIDER_METHODS.filter((method) => !INTERNAL_PROVIDER_ADMISSION_METHODS.some((admission) => admission === method)), 'eth_call', 'unknown_internal_method', 'site_rpc_request_extra', '__proto__', 'constructor']) assert.equal(getInternalRequestAdmission(method), undefined)
})

test('registry access composition keeps SDK ordinary authority and rejects unadmitted HTTP authority', async () => {
	installBrowserMock()
	const modules = await loadModules()
	const settings = await modules.getSettings()
	const socket = { tabId: 7, connectionName: 1n }
	const resolve = createRequestAccessContextResolver(internalRequestAccessContextOwners)
	for (const method of ['safe_apps_request', 'site_rpc_request', 'unknown_internal_method']) {
		const context = await resolve(new Map(), socket, { method, params: [], interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier: { requestId: 1, requestSocket: socket } }, settings, 'https://app.example', async () => undefined)
		assert.equal(context.activeAddress, undefined)
		assert.equal(context.accessSocket, socket)
	}
})
