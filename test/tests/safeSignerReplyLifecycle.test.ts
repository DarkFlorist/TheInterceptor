import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'
import type { PendingTransactionOrSignableMessage } from '../../app/ts/types/accessRequest.js'
import type { SimulationServices } from '../../app/ts/simulation/serviceLifecycle.js'
import type { UniqueRequestIdentifier } from '../../app/ts/utils/requests.js'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import type { SafeSignerReplyConfirmationWindow } from '../../app/ts/background/safeSignerReplyLifecycle.js'

// Only extension storage is real; the confirmation window is the stub below. The lifecycle is loaded on its own, without the confirmation window, popup or shared confirmation test harness modules.
const storageState: Record<string, unknown> = {}
const readStorage = (keys: string | readonly string[] | Record<string, unknown> | null | undefined) => {
	if (keys === null || keys === undefined) return { ...storageState }
	const requestedKeys = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
	return Object.fromEntries(requestedKeys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
}
Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		runtime: {
			lastError: undefined,
			getManifest: () => ({ manifest_version: 3 }),
			async sendMessage() { return undefined },
		},
		storage: {
			local: {
				async get(keys: string | readonly string[] | Record<string, unknown> | null | undefined) { return readStorage(keys) },
				async set(items: Record<string, unknown>) { Object.assign(storageState, items) },
				async remove(keys: string | readonly string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) delete storageState[key] },
			},
		},
	},
})
const { resolvePendingRequestAsNoResponse, resolveSafeSignature } = await import('../../app/ts/background/safeSignerReplyLifecycle.js')
const { appendPendingTransactionOrMessage, getPendingTransactionsAndMessages, removePendingTransactionOrMessage } = await import('../../app/ts/background/storageVariables.js')
const { getPendingTerminalReplies } = await import('../../app/ts/background/pendingTerminalReplies.js')
const { createSimulationServices } = await import('../../app/ts/simulation/serviceLifecycle.js')
const { METAMASK_ERROR_USER_REJECTED_REQUEST } = await import('../../app/ts/utils/constants.js')

const SIGNING_CHAIN_ID = 1n
const SIGNATURE = '0x1234'
const uniqueRequestIdentifier: UniqueRequestIdentifier = { requestId: 7, requestSocket: { tabId: 3, connectionName: 0n } }
const websiteTabConnections: WebsiteTabConnections = new Map()

const createServices = (chainId: bigint): SimulationServices => createSimulationServices(
	{ name: `Chain ${ chainId.toString() }`, chainId, httpsRpc: `https://chain-${ chainId.toString() }.invalid`, currencyName: 'Ether', currencyTicker: 'ETH', primary: true, minimized: true },
	async () => undefined,
	async () => undefined,
)

// A request forwarded to its signer on SIGNING_CHAIN_ID.
const createRequestWaitingForSigner = (): PendingTransactionOrSignableMessage => {
	const created = new Date('2024-01-01T00:00:00.000Z')
	return {
		type: 'Transaction',
		transactionOrMessageCreationStatus: 'Crafting',
		popupOrTabId: { type: 'popup', id: 11 },
		originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: 0x1111111111111111111111111111111111111111n, to: 0x2222222222222222222222222222222222222222n, value: 0n, input: new Uint8Array() }] },
		uniqueRequestIdentifier,
		simulationMode: false,
		activeAddress: 0x1111111111111111111111111111111111111111n,
		created,
		transactionIdentifier: 1n,
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		approvalStatus: { status: 'WaitingForSigner' },
		signerRequestChainId: SIGNING_CHAIN_ID,
	}
}

// Records the confirmation-window calls these tests assert on. `settleClaimedSignature` settles the request by removing it, as a successful validation and store would.
function createStubConfirmationWindow() {
	const settledSignatures: { readonly services: SimulationServices, readonly uniqueRequestIdentifier: UniqueRequestIdentifier, readonly signerReply: string }[] = []
	const requestsThatLeftTheQueue: { readonly pending: PendingTransactionOrSignableMessage, readonly services: SimulationServices | undefined }[] = []
	const calls = { settleClaimedSignature: settledSignatures, updateAfterRequestLeftQueue: requestsThatLeftTheQueue }
	const confirmationWindow: SafeSignerReplyConfirmationWindow = {
		settleClaimedSignature: async (services, _websiteTabConnections, settledRequest, signerReply) => {
			calls.settleClaimedSignature.push({ services, uniqueRequestIdentifier: settledRequest, signerReply })
			await removePendingTransactionOrMessage(settledRequest)
		},
		updateAfterRequestLeftQueue: async (pending, services) => { calls.updateAfterRequestLeftQueue.push({ pending, services }) },
		refresh: async () => undefined,
		showSimulationStackChange: async () => undefined,
	}
	return { calls, confirmationWindow }
}

describe('Gnosis Safe signer-reply lifecycle with stub confirmation-window callbacks', () => {
	beforeEach(async () => {
		for (const key of Object.keys(storageState)) delete storageState[key]
		await appendPendingTransactionOrMessage(createRequestWaitingForSigner())
	})

	test('settles a signature through settleClaimedSignature with the services for its signing network', async () => {
		const { calls, confirmationWindow } = createStubConfirmationWindow()
		const otherNetworkServices = createServices(2n)
		const signingNetworkServices = createServices(SIGNING_CHAIN_ID)
		const settled = await resolveSafeSignature(uniqueRequestIdentifier, SIGNATURE, { services: otherNetworkServices, getInstalledServices: async () => signingNetworkServices, websiteTabConnections, confirmationWindow })
		assert.equal(settled, true)
		assert.equal(calls.settleClaimedSignature.length, 1)
		assert.equal(calls.settleClaimedSignature[0]?.services, signingNetworkServices)
		assert.equal(calls.settleClaimedSignature[0]?.signerReply, SIGNATURE)
		assert.deepEqual(await getPendingTransactionsAndMessages(), [])
	})

	test('keeps a claimed signature without services for its network and moves the window past the request', async () => {
		const { calls, confirmationWindow } = createStubConfirmationWindow()
		const settled = await resolveSafeSignature(uniqueRequestIdentifier, SIGNATURE, { services: undefined, getInstalledServices: async () => createServices(2n), websiteTabConnections, confirmationWindow })
		assert.equal(settled, false)
		assert.equal(calls.settleClaimedSignature.length, 0)
		assert.equal(calls.updateAfterRequestLeftQueue.length, 1)
		const [claimed] = await getPendingTransactionsAndMessages()
		assert.deepEqual(claimed?.deferredSafeSignerReply, { signerReply: SIGNATURE, chainId: SIGNING_CHAIN_ID })
	})

	test('rejects a request still waiting for its signer as no-response without RPC services', async () => {
		const { calls, confirmationWindow } = createStubConfirmationWindow()
		await resolvePendingRequestAsNoResponse(uniqueRequestIdentifier, { services: undefined, getInstalledServices: async () => undefined, websiteTabConnections, confirmationWindow })
		assert.deepEqual(await getPendingTransactionsAndMessages(), [])
		assert.equal(calls.settleClaimedSignature.length, 0)
		assert.equal(calls.updateAfterRequestLeftQueue.length, 1)
		// No website is connected, so the rejection stays queued for delivery.
		const [queuedRejection] = await getPendingTerminalReplies()
		assert.equal(queuedRejection !== undefined && queuedRejection.type === 'result' && 'error' in queuedRejection ? queuedRejection.error.code : undefined, METAMASK_ERROR_USER_REJECTED_REQUEST)
	})
})
