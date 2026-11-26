import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createSiteSimulationTokenRequest, isSiteSimulationTokenMethod, isSiteSimulationTokenRequest, SITE_SIMULATION_TOKEN_METHODS } from '../../app/shared/ts/siteSimulationTokenProtocol.js'
import { getSiteRpcExecution } from '../../app/ts/background/siteRpcInterception.js'
import { uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

const envelope = (request: unknown) => ({ method: 'site_rpc_request', interceptorRequest: true, usingInterceptorWithoutSigner: true, uniqueRequestIdentifier, params: [{ chainId: '0x1', request }] })

for (const kind of ['addresses', 'metadata'] as const) test(`the shared ${ kind } request is admitted by the background private wire schema`, () => {
	const request = createSiteSimulationTokenRequest(kind, 47)
	assert.deepEqual(request, { jsonrpc: '2.0', id: 47, method: SITE_SIMULATION_TOKEN_METHODS[kind] })
	assert.equal(isSiteSimulationTokenRequest(request), true)
	const execution = getSiteRpcExecution(envelope(request), 'https://site.example', true, 1n)
	assert.ok(execution?.kind === 'tokens')
	assert.equal(execution.includeTokenMetadata, kind === 'metadata')
	const methodOnlyExecution = getSiteRpcExecution(envelope({ method: request.method }), 'https://site.example', true, 1n)
	assert.ok(methodOnlyExecution?.kind === 'tokens', 'the private schema requires only its method discriminant, not an RPC id or version')
})

test('unknown private methods fail closed and the token protocol does not become an outer provider method', () => {
	for (const method of ['interceptor_getSimulationTokensV2', 'interceptor_getSimulationTokenMetadataV2', 'eth_sendTransaction', '']) {
		assert.equal(isSiteSimulationTokenMethod(method), false)
		assert.equal(isSiteSimulationTokenRequest({ method }), false)
		assert.equal(getSiteRpcExecution(envelope({ method }), 'https://site.example', true, 1n)?.kind, 'rejected')
	}
	for (const method of Object.values(SITE_SIMULATION_TOKEN_METHODS)) assert.equal(getSiteRpcExecution({ ...envelope({ method }), method }, 'https://site.example', true, 1n), undefined)
})
