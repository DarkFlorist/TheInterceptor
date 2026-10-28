import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { Website } from '../../app/ts/types/websiteAccessTypes.js'
import { beginSignerStateConfirmation, resolveSignerStateConfirmation } from '../../app/ts/background/signerStateOwnership.js'
import { requireDefined } from '../harness/assertions.js'
import { confirmedSignerOwnership, createEthereumWithGetBlockCounter, createPort, createRestoringBrowserMockInstaller, loadModules, noopPublishRpcConnectionStatus } from './backgroundEthAccountsTestHarness.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

const websiteOrigin = 'https://mode-switch.example'
const website: Website = { websiteOrigin, icon: undefined, title: undefined }
const account = 0x1111111111111111111111111111111111111111n
const optimism: RpcEntry = { name: 'Optimism', chainId: 10n, httpsRpc: 'https://optimism.example', currencyName: 'Ether', currencyTicker: 'ETH', primary: false, minimized: false }
const socket = { tabId: 1, connectionName: 0n }
const getAccountEntry = (askForAddressAccess: boolean, chainId: bigint | 'AllChains' = 1n): AddressBookEntry => ({ type: 'contact', name: 'Account', address: account, askForAddressAccess, useAsActiveAddress: true, entrySource: 'User', chainId })

// Website metadata the router awaits only after it has decided access, which gives a test a point to change settings in between.
function createWebsiteMetadataGate() {
	const websiteMetadata = Promise.withResolvers<Website>()
	const accessDecided = Promise.withResolvers<void>()
	// A plain object rather than a native promise, because await only calls then() on non-native thenables.
	const websiteAfterAccessDecision: Promise<Website> = {
		then: (onFulfilled, onRejected) => {
			accessDecided.resolve()
			return websiteMetadata.promise.then(onFulfilled, onRejected)
		},
		catch: (onRejected) => websiteMetadata.promise.catch(onRejected),
		finally: (onFinally) => websiteMetadata.promise.finally(onFinally),
		[Symbol.toStringTag]: 'Promise',
	}
	return { websiteAfterAccessDecision, accessDecided: accessDecided.promise, releaseWebsite: () => { websiteMetadata.resolve(website) } }
}

// An approved website with the Interceptor in simulation mode on the default network. The website has its own access to the account, or with accountSharedWithoutAsking, gets it because the account's address book entry shares it without asking.
async function setUpApprovedWebsiteInSimulationMode({ accountSharedWithoutAsking = false }: { readonly accountSharedWithoutAsking?: boolean }) {
	installBrowserMock()
	const modules = await loadModules()
	await modules.setUseSignersAddressAsActiveAddress(false)
	if (accountSharedWithoutAsking) await modules.updateUserAddressBookEntries(() => [getAccountEntry(false)])
	await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: account })
	await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: accountSharedWithoutAsking ? undefined : [{ address: account, access: true }] }])
	const { port, messages } = createPort(socket.tabId)
	const connections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
		[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	return { modules, port, messages, connections }
}

// Starts a wallet_addEthereumChain request in simulation mode from an approved website and returns once its access is decided; the caller changes settings, then releases the website metadata.
async function startRequestInSimulationMode(options: { readonly accountSharedWithoutAsking?: boolean } = {}) {
	const { modules, port, messages, connections } = await setUpApprovedWebsiteInSimulationMode(options)
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	const gate = createWebsiteMetadataGate()
	const request = modules.handleInterceptedRequest(port, websiteOrigin, gate.websiteAfterAccessDecision, simulationServicesOwner, socket, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 51, requestSocket: socket },
		method: 'wallet_addEthereumChain',
		params: [{ chainId: '0x2a', chainName: 'Example', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.example'] }],
	}, connections, noopPublishRpcConnectionStatus)
	await gate.accessDecided
	const finish = async () => {
		gate.releaseWebsite()
		await request
		return messages.filter((message) => message.requestId === 51)
	}
	return { modules, connections, finish }
}

const switchedAccount = 0x2222222222222222222222222222222222222222n

// Starts an eth_requestAccounts request that has no configured or wallet-selected active address, so it falls back to the first signer account, and returns once its access is decided.
async function startAccountRequestOnFirstSignerAccount() {
	installBrowserMock()
	const modules = await loadModules()
	await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: undefined, activeSigningAddress: undefined })
	await modules.setUseSignersAddressAsActiveAddress(false)
	await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: account, access: true }, { address: switchedAccount, access: true }] }])
	await modules.updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: undefined }))
	const { port, messages } = createPort(socket.tabId)
	const connections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
		[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
	} }]])
	const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
	const gate = createWebsiteMetadataGate()
	const request = modules.handleInterceptedRequest(port, websiteOrigin, gate.websiteAfterAccessDecision, simulationServicesOwner, socket, {
		interceptorRequest: true,
		usingInterceptorWithoutSigner: false,
		uniqueRequestIdentifier: { requestId: 53, requestSocket: socket },
		method: 'eth_requestAccounts',
	}, connections, noopPublishRpcConnectionStatus)
	await gate.accessDecided
	const finish = async () => {
		gate.releaseWebsite()
		await request
	}
	return { modules, connections, messages, finish }
}

describe('intercepted request settings context', () => {
	test('executes a request on the snapshot its access was decided on when nothing that decides it changes', async () => {
		const { modules, finish } = await startRequestInSimulationMode()
		// The popup's open page is not part of the request's access decision.
		await modules.changePage({ method: 'popup_changePage', data: { page: 'Settings' } })
		const replies = await finish()

		// Simulation mode answers locally.
		assert.equal(replies.some((message) => message.type === 'forwardToSigner'), false)
		assert.equal(replies.at(-1)?.error?.code, 10000)
	})

	test('decides access again when the mode changes while the website metadata loads', async () => {
		const { modules, finish } = await startRequestInSimulationMode()
		await modules.changeSimulationMode({ simulationMode: false })
		const replies = await finish()

		// Decided again in signing mode, where the request needs a wallet account; no wallet is connected here, so it is refused instead of running on the simulation-mode snapshot.
		assert.equal(replies.some((message) => message.type === 'forwardToSigner'), false)
		assert.equal(replies.at(-1)?.error?.code, 4100)
	})

	test('decides access again when access to the website is revoked while its metadata loads', async () => {
		const { connections, finish } = await startRequestInSimulationMode()
		// Removing the website from the popup also withdraws the approval of its open connection.
		const { removeWebsiteAccess } = await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js')
		await removeWebsiteAccess(connections, { method: 'popup_removeWebsiteAccess', data: { websiteOrigin } })
		const replies = await finish()

		// The revoked website is refused instead of being answered on the snapshot taken before the revocation.
		assert.equal(replies.some((message) => message.type === 'forwardToSigner'), false)
		assert.equal(replies.at(-1)?.error?.code, 4100)
	})

	test('decides access again when the active address stops being shared without asking while the website metadata loads', async () => {
		const { modules, connections, finish } = await startRequestInSimulationMode({ accountSharedWithoutAsking: true })
		// The settings stay the same: the user edits the account's address book entry to ask before sharing it, and reconciling the approvals, as the address book handler does, withdraws the open connection's approval.
		await modules.updateUserAddressBookEntries(() => [getAccountEntry(true)])
		await modules.syncWebsiteApprovalsWithSettings(connections, { promptForAccessesIfNeeded: false })
		const replies = await finish()

		// Decided again: the website must now ask for the account, which this request does not do, so it is refused instead of being answered on the snapshot.
		assert.equal(replies.some((message) => message.type === 'forwardToSigner'), false)
		assert.equal(replies.at(-1)?.error?.code, 4100)
	})

	test('reads the wallet-selected address entry again, not a same-address Safe, when deciding whether a waiting request still has access', async () => {
		installBrowserMock()
		const modules = await loadModules()
		// Signing mode with the wallet's account active. The account has a contact that shares it without asking, and a Safe at the same address on this chain; wallet-selected addresses use the contact.
		const contact = (askForAddressAccess: boolean) => getAccountEntry(askForAddressAccess, 'AllChains')
		const sameAddressSafe: AddressBookEntry = { type: 'safe', name: 'Same-address Safe', address: account, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: false, safeSignerAddresses: [account] }
		await modules.changeSimulationMode({ simulationMode: false, activeSimulationAddress: undefined, activeSigningAddress: undefined })
		await modules.setUseSignersAddressAsActiveAddress(false)
		await modules.updateUserAddressBookEntries(() => [contact(false), sameAddressSafe])
		await modules.updateWebsiteAccess(() => [{ website, access: true, addressAccess: undefined }])
		await modules.updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [account], activeSigningAddress: undefined }))
		const { port, messages } = createPort(socket.tabId)
		const connections = new Map([[socket.tabId, { ...confirmedSignerOwnership(socket), connections: {
			[modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true },
		} }]])
		const { simulationServicesOwner } = createEthereumWithGetBlockCounter({ count: 0 })
		const gate = createWebsiteMetadataGate()
		const request = modules.handleInterceptedRequest(port, websiteOrigin, gate.websiteAfterAccessDecision, simulationServicesOwner, socket, {
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier: { requestId: 52, requestSocket: socket },
			method: 'eth_accounts',
		}, connections, noopPublishRpcConnectionStatus)
		await gate.accessDecided

		// Only the contact now asks before sharing the account; the Safe still would not.
		await modules.updateUserAddressBookEntries(() => [contact(true), sameAddressSafe])
		await modules.syncWebsiteApprovalsWithSettings(connections, { promptForAccessesIfNeeded: false })
		gate.releaseWebsite()
		await request

		// Decided again on the contact: the website has to ask for the account first, so it is not handed out.
		assert.deepEqual(messages.filter((message) => message.requestId === 52).at(-1)?.result, [])
	})

	test('follows a wallet account switch while the website metadata loads when the request uses the first signer account', async () => {
		const { modules, messages, finish } = await startAccountRequestOnFirstSignerAccount()
		// The wallet reports another account while the request waits; the settings do not change.
		await modules.updateTabState(socket.tabId, (previousState) => ({ ...previousState, signerAccounts: [switchedAccount] }))
		await finish()

		// Decided again for the account the wallet has now, instead of answering with the one it had when the request arrived.
		assert.deepEqual(messages.filter((message) => message.requestId === 53).at(-1)?.result, [`0x${ switchedAccount.toString(16) }`])
	})

	test('does not answer with the first signer account once the signer state is no longer confirmed', async () => {
		const { connections, messages, finish } = await startAccountRequestOnFirstSignerAccount()
		// A signer reconnect invalidates the state before its write clears the cached accounts, which still list the first account here.
		const tabConnection = requireDefined(connections.get(socket.tabId), 'tab connection')
		beginSignerStateConfirmation(tabConnection)
		resolveSignerStateConfirmation(tabConnection)
		await finish()

		// Decided again: no confirmed signer state means no wallet account, so the request is rejected instead of being given the cached one.
		const reply = messages.filter((message) => message.requestId === 53).at(-1)
		assert.equal(reply?.result, undefined)
		assert.equal(reply?.error?.code, 4001)
	})

	test('decides access again when the active network changes while the website metadata loads', async () => {
		const { modules, finish } = await startRequestInSimulationMode()
		// The network switch installs simulation services for Optimism, so the simulation-mode snapshot on Ethereum must not execute with them.
		await modules.changeSimulationMode({ simulationMode: false, rpcNetwork: optimism })
		const replies = await finish()

		// Decided again on the current settings: in signing mode the request needs a wallet account, and no wallet is connected here, so it is refused instead of being answered by the simulation.
		assert.equal(replies.some((message) => message.type === 'forwardToSigner'), false)
		assert.equal(replies.at(-1)?.error?.code, 4100)
	})
})
