import * as assert from 'assert'
import { test } from 'bun:test'
import { SendTransactionParams } from '../../app/ts/types/JsonRpc-types.js'
import { activeAddress, addressString, createWebsitePort, fakeRpcNetwork, isRecord, modules, recipientAddress, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'

for (const { explicitSender, switchAccount } of [
	{ explicitSender: false, switchAccount: false },
	{ explicitSender: true, switchAccount: false },
	{ explicitSender: false, switchAccount: true },
	{ explicitSender: true, switchAccount: true },
]) {
	test(`gas edits forward immediately with ${ explicitSender ? 'explicit' : 'omitted' } sender, account change: ${ switchAccount }`, async () => {
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

		if (switchAccount) {
			await modules.updateTabState(uniqueRequestIdentifier.requestSocket.tabId, (state) => ({ ...state, signerAccounts: [recipientAddress], activeSigningAddress: recipientAddress }))
			await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({ ...pending, activeAddress: recipientAddress }))
			await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
		}
		const [refreshed] = await modules.getPendingTransactionsAndMessages()
		assert.equal(refreshed?.transactionOrMessageCreationStatus, explicitSender && switchAccount ? 'FailedToSimulate' : 'Simulated')
		if (refreshed?.type !== 'Transaction' || refreshed.transactionOrMessageCreationStatus !== 'Simulated') {
			assert.equal(explicitSender, true)
			return
		}
		const reviewedSender = switchAccount ? recipientAddress : activeAddress
		assert.equal(refreshed.transactionToSimulate.transaction.from, reviewedSender)
		await modules.setGasLimitForTransaction(refreshed.transactionIdentifier, 45_000n)
		const [edited] = await modules.getPendingTransactionsAndMessages()
		if (edited?.type !== 'Transaction' || edited.transactionOrMessageCreationStatus !== 'Simulated' || edited.originalRequestParameters.method !== 'eth_sendTransaction') throw new Error('Missing edited review')
		assert.equal(edited.transactionToSimulate.transaction.gas, 21_000n)
		// No re-simulation has completed: forwarding must use the persisted edit, not this old snapshot.
		assert.equal(edited.originalRequestParameters.params[0].gas, 45_000n)
		await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, connections,
			{ method: 'popup_confirmDialog', data: { action: 'accept', uniqueRequestIdentifier } })
		const forwarded = postedMessages.find((message) => isRecord(message) && message.type === 'forwardToSigner')
		assert.ok(isRecord(forwarded))
		const parsed = SendTransactionParams.parse(forwarded)
		assert.equal(parsed.params[0].from, reviewedSender)
		assert.equal(parsed.params[0].gas, 45_000n)
	})
}
