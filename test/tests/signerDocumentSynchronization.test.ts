import * as assert from 'assert'
import { test } from 'bun:test'
import { probeChildSignerDocument } from '../../app/ts/background/signerDocumentSynchronization.js'
import { clearSignerExecutionAuthorityForTab, getSignerDocumentGeneration, registerAuthoritativeTopSocket, registerCurrentChildSignerSocket } from '../../app/ts/background/signerExecutionAuthority.js'

test('document synchronization checks active top and child identities and revalidates after browser replies', async () => {
	const previousBrowser = Object.getOwnPropertyDescriptor(globalThis, 'browser')
	const top = { tabId: 816, connectionName: 1n }
	const child = { tabId: top.tabId, connectionName: 2n }
	const origin = 'https://example.test'
	const probes: unknown[] = []
	let topMatches = true
	let childMatches = true
	let childOrigin = origin
	let beforeReply: () => void = () => undefined
	let failure: Error | undefined
	Object.defineProperty(globalThis, 'browser', { configurable: true, value: { tabs: {
		sendMessage: async (tabId: number, message: unknown, options: { frameId: number }) => {
			probes.push({ tabId, message, options })
			if (failure !== undefined) throw failure
			beforeReply()
			return (options.frameId === 0 ? topMatches : childMatches) ? { origin: options.frameId === 0 ? origin : childOrigin } : false
		},
	} } })
	try {
		registerAuthoritativeTopSocket(top, origin)
		registerCurrentChildSignerSocket(child, 2)
		const generation = getSignerDocumentGeneration(top, origin)
		assert.ok(generation)
		assert.deepEqual(await probeChildSignerDocument(child, origin, 2), { status: 'ready', generation })
		assert.deepEqual(probes, [
			{ tabId: top.tabId, message: { method: 'interceptor_signer_document_probe', signerDocumentGeneration: generation }, options: { frameId: 0 } },
			{ tabId: top.tabId, message: { method: 'interceptor_signer_document_probe', connectionName: '0x2' }, options: { frameId: 2 } },
		])
		childOrigin = 'http://example.test'
		assert.deepEqual(await probeChildSignerDocument(child, origin, 2), { status: 'ineligible' }, 'A matching hostname cannot substitute for a matching origin')
		childOrigin = 'null'
		assert.deepEqual(await probeChildSignerDocument(child, origin, 2), { status: 'ineligible' }, 'Opaque sandbox origins cannot share wallet authority')
		childOrigin = origin
		topMatches = false
		assert.deepEqual(await probeChildSignerDocument(child, origin, 2), { status: 'retry' })
		topMatches = true
		childMatches = false
		assert.deepEqual(await probeChildSignerDocument(child, origin, 2), { status: 'retry' })
		childMatches = true
		failure = new Error('Could not establish connection. Receiving end does not exist.')
		assert.deepEqual(await probeChildSignerDocument(child, origin, 2), { status: 'retry' })
		failure = new Error('Unexpected browser failure')
		await assert.rejects(probeChildSignerDocument(child, origin, 2), /Unexpected browser failure/)
		failure = undefined
		beforeReply = () => { registerAuthoritativeTopSocket({ ...top, connectionName: 3n }, origin) }
		assert.deepEqual(await probeChildSignerDocument(child, origin, 2), { status: 'retry' }, 'Navigation invalidates a completed probe')
		beforeReply = () => { registerCurrentChildSignerSocket({ ...child, connectionName: 4n }, 2) }
		assert.deepEqual(await probeChildSignerDocument(child, origin, 2), { status: 'retry' }, 'A replaced child socket invalidates a completed probe')
	} finally {
		clearSignerExecutionAuthorityForTab(top.tabId)
		if (previousBrowser === undefined) Reflect.deleteProperty(globalThis, 'browser')
		else Object.defineProperty(globalThis, 'browser', previousBrowser)
	}
})
