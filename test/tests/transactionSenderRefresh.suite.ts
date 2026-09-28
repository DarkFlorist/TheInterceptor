import * as assert from 'assert'
import { test } from 'bun:test'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { activeAddress, addressString, createWebsitePort, fakeRpcNetwork, isRecord, modules, recipientAddress, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

for (const explicitSender of [false, true]) {
	test(`account changes ${ explicitSender ? 'preserve an explicit sender restriction' : 'rebind an omitted sender to the latest successful review' }`, async () => {
		await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
		await modules.updateUserAddressBookEntries(() => [])
		await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({ ...state, signerName: 'MetaMask', signerAccounts: [activeAddress], activeSigningAddress: activeAddress, signerChain: fakeRpcNetwork.chainId }))
		const parameters = SendTransactionParams.parse({ method: 'eth_sendTransaction', params: [{ ...(explicitSender ? { from: addressString(activeAddress) } : {}), to: addressString(recipientAddress), gas: '0x5208', value: '0x0' }] })
		const postedMessages: unknown[] = []
		const port = createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages)
		const connections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, { connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: { port, socket: uniqueRequestIdentifier.requestSocket, websiteOrigin: 'https://example.com', approved: true, wantsToConnect: true },
		} }]])
		await modules.openConfirmTransactionDialogForTransaction(simulator.ethereum, simulator.tokenPriceService,
			{ interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, ...parameters },
			{ kind: 'transaction', parameters }, false, activeAddress,
			{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined }, connections)
		const [initial] = await modules.getPendingTransactionsAndMessages()
		assert.equal(initial?.transactionOrMessageCreationStatus, 'Simulated')
		if (initial?.originalRequestParameters.method !== 'eth_sendTransaction') throw new Error('Expected a transaction request')
		assert.equal(initial.originalRequestParameters.params[0].from, explicitSender ? activeAddress : undefined)

		await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({ ...state, signerAccounts: [recipientAddress], activeSigningAddress: recipientAddress }))
		await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({ ...pending, activeAddress: recipientAddress }))
		await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
		const [refreshed] = await modules.getPendingTransactionsAndMessages()
		assert.equal(refreshed?.transactionOrMessageCreationStatus, explicitSender ? 'FailedToSimulate' : 'Simulated')
		if (refreshed?.type !== 'Transaction' || refreshed.transactionOrMessageCreationStatus !== 'Simulated') {
			assert.equal(explicitSender, true)
			return
		}
		assert.equal(refreshed.transactionToSimulate.transaction.from, recipientAddress)
		await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections,
			{ method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } })
		const forwarded = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
		assert.ok(isRecord(forwarded))
		const parsed = SendTransactionParams.parse(forwarded)
		assert.equal(parsed.params[0].from, recipientAddress)
	})
}
