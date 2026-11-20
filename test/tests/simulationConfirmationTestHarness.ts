import * as assert from 'assert'

import { addressString, browserMock, createReplayableAcceptConfirmation, createWebsitePort, fakeRpcNetwork, isRecord, modules, simulator, withSilencedConsole } from './confirmTransactionTestHarness.js'

export const SENDER = 0x7100000000000000000000000000000000000071n

export const RECIPIENT = 0x7300000000000000000000000000000000000073n

export const WEBSITE = { websiteOrigin: 'https://example.com', icon: undefined, title: undefined }

export const REQUEST_SOCKET = { tabId: 1, connectionName: 0n }

export const createTransferParams = async (value: bigint) => (await import('../../app/ts/types/JsonRpc-types.js')).SendTransactionParams.parse({
	method: 'eth_sendTransaction',
	params: [{ to: addressString(RECIPIENT), value: `0x${ value.toString(16) }`, data: '0x' }],
})

export function createWebsiteTabConnections(postedMessages: unknown[]) {
	return new Map([[REQUEST_SOCKET.tabId, {
		connections: {
			[modules.websiteSocketToString(REQUEST_SOCKET)]: {
				port: createWebsitePort(REQUEST_SOCKET, 0, postedMessages),
				socket: REQUEST_SOCKET,
				websiteOrigin: WEBSITE.websiteOrigin,
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])
}

export const CONFIRMATION_WINDOW_ID = 99

export async function startSimulationStack(activeSimulationAddress: bigint) {
	// The confirmation window stays open, so a confirmation opened while another is pending queues behind it.
	browserMock.setLiveWindowIds([CONFIRMATION_WINDOW_ID])
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress })
	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
}

export async function openConfirmation(requestId: number, from: bigint, value: bigint, websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>) {
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: from })
	const transactionParams = await createTransferParams(value)
	const uniqueRequestIdentifier = { requestId, requestSocket: REQUEST_SOCKET }
	assert.deepEqual(await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{ interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier, method: transactionParams.method, params: transactionParams.params },
		{ kind: 'transaction', parameters: transactionParams },
		true,
		from,
		WEBSITE,
		websiteTabConnections,
	)), { type: 'doNotReply' })
	return uniqueRequestIdentifier
}

export async function acceptConfirmation(uniqueRequestIdentifier: Awaited<ReturnType<typeof openConfirmation>>, websiteTabConnections: ReturnType<typeof createWebsiteTabConnections>, postedMessages: unknown[]) {
	const pending = (await modules.getPendingTransactionsAndMessages()).find((request) => request.uniqueRequestIdentifier.requestId === uniqueRequestIdentifier.requestId)
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error(`Expected a simulated pending transaction, got ${ pending?.transactionOrMessageCreationStatus }`)
	await withSilencedConsole(async () => await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, await createReplayableAcceptConfirmation(uniqueRequestIdentifier)))
	const stacked = (await modules.getInterceptorTransactionStack()).operations.find((operation) => operation.type === 'Transaction' && operation.preSimulationTransaction.transactionIdentifier === pending.transactionIdentifier)
	if (stacked?.type !== 'Transaction') throw new Error('Expected the accepted transaction on the simulation stack')
	const reply = postedMessages.find((message) => isRecord(message) && message.requestId === uniqueRequestIdentifier.requestId && 'result' in message)
	if (!isRecord(reply) || typeof reply.result !== 'string') throw new Error(`Expected the page to get a transaction hash, got ${ JSON.stringify(reply) }`)
	return { stacked: stacked.preSimulationTransaction, pageHash: BigInt(reply.result) }
}

export const getStackedTransactions = async () => (await modules.getInterceptorTransactionStack()).operations.flatMap((operation) => operation.type === 'Transaction' ? [operation.preSimulationTransaction] : [])

export const getPageResponses = (postedMessages: readonly unknown[], requestId: number) => postedMessages.flatMap((message) => {
	if (!isRecord(message) || message.requestId !== requestId) return []
	if (typeof message.result === 'string') return [{ result: BigInt(message.result) }]
	if (isRecord(message.error) && typeof message.error.code === 'number') return [{ error: message.error.code }]
	return []
})
