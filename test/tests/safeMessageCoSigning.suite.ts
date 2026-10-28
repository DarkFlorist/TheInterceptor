import * as assert from 'node:assert'
import { test } from 'bun:test'
import { createSafeMessageCoSignSnapshot, isSafeSignerSelectionFailure } from '../../app/ts/background/safeConfirmationResolver.js'
import { getLatestUnexpectedError } from '../../app/ts/utils/unexpectedErrorStorage.js'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { acceptConfirmation, activeAddress, addressString, connectWebsite, createConfirmedSignerStateOwner, createEthAccountsReply, createSafeAddressBookEntry, createSafeTx, createSafeTxSignRequest, createSafeTxToRecipient, EIP712Message, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, isPostedMethod, modules, openMessageConfirmation, parseForwardedSafeTxTypedData, privateKeyToAccount, recipientAddress, requireForwardedSignerRequest, requireWebsiteReply, safeTestOwnerAddress, safeTxToTypedDataJson, setWalletAccounts, simulator, uniqueRequestIdentifier, withSafeOwnerLookupFailure } from './confirmTransactionTestHarness.js'

const sealwortWebsite = { websiteOrigin: 'https://sealwort.example', icon: undefined, title: 'Sealwort' }

test('routes a Safe co-signing request through the wallet-selected owner', async () => {
	const ownerAccount = privateKeyToAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd')
	const safeSignerAddress = BigInt(ownerAccount.address)
	const alternateOwnerAccount = privateKeyToAccount('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef')
	const alternateOwnerAddress = BigInt(alternateOwnerAccount.address)
	const safeTx = createSafeTxToRecipient()
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	fakeSafeContract.owners = [safeSignerAddress, alternateOwnerAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateSafeTransactionStacks(() => [])
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: recipientAddress,
		safeVersion: '1.4.1',
	})])
	await setWalletAccounts([safeSignerAddress, recipientAddress], { signerChain: fakeRpcNetwork.chainId })
	const socket = uniqueRequestIdentifier.requestSocket
	let accountReply: Promise<unknown> | undefined
	const website = connectWebsite({
		websiteOrigin: sealwortWebsite.websiteOrigin,
		signerStateOwner: createConfirmedSignerStateOwner(socket, 1, 1),
		onPostMessage: (message) => {
			if (!isPostedMethod(message, 'request_signer_to_eth_accounts')) return
			accountReply = modules.ethAccountsReply(
				createTestSimulationServicesOwner(simulator),
				website.websiteTabConnections,
				website.port,
				createEthAccountsReply([safeSignerAddress]),
				'hasAccess',
				activeAddress,
			)
		},
	})

	assert.deepEqual(await openMessageConfirmation(createSafeTxSignRequest(safeTx), sealwortWebsite, website.websiteTabConnections), { type: 'doNotReply' })

	const [reviewedCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.notEqual(reviewedCoSignRequest?.type === 'SignableMessage' ? reviewedCoSignRequest.safeMessageCoSignSnapshot : undefined, undefined)
	if (reviewedCoSignRequest?.type !== 'SignableMessage') throw new Error('Missing reviewed Safe co-signing request')
	await withSafeOwnerLookupFailure('unexpected', async () => {
		await assert.rejects(
			modules.resolveSafeConfirmation(simulator.ethereum, reviewedCoSignRequest, 'accept'),
			/Unexpected Safe owner decoder failure/u,
		)
		await assert.rejects(
			modules.resolveSafeSignerReply(simulator.ethereum, simulator.tokenPriceService, reviewedCoSignRequest, '0x1234'),
			/Unexpected Safe owner decoder failure/u,
		)
	})
	const expectedFailure = await withSafeOwnerLookupFailure('expected', async () => await modules.resolveSafeConfirmation(simulator.ethereum, reviewedCoSignRequest, 'accept'))
	assert.equal(expectedFailure.status, 'blocked')
	assert.match(expectedFailure.status === 'blocked' ? expectedFailure.approvalStatus.message : '', /Safe owner lookup unavailable/u)
	await setWalletAccounts([alternateOwnerAddress])
	await withSafeOwnerLookupFailure('unexpected', async () => {
		await assert.rejects(
			modules.resolveSafeConfirmation(
				simulator.ethereum,
				reviewedCoSignRequest,
				'accept',
				{ selectedSigner: alternateOwnerAddress, verificationError: undefined },
			),
			/Unexpected Safe owner decoder failure/u,
		)
	})
	const [unchangedCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(unchangedCoSignRequest?.approvalStatus.status, 'WaitingForUser')
	await modules.refreshPendingSafeSignerSelectionErrors(simulator.ethereum, simulator.tokenPriceService, socket.tabId)
	const [refreshedCoSignRequest] = await modules.getPendingTransactionsAndMessages()
	assert.equal(refreshedCoSignRequest?.type === 'SignableMessage' ? refreshedCoSignRequest.safeMessageCoSignSnapshot?.safeSignerAddress : undefined, alternateOwnerAddress)
	assert.equal(refreshedCoSignRequest?.approvalStatus.status, 'WaitingForUser')
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, website.websiteTabConnections, acceptConfirmation), true)

	const signerRequest = requireForwardedSignerRequest(website.postedMessages, 'Safe co-signer request')
	assert.equal(signerRequest.method, 'eth_signTypedData_v4')
	assert.equal(signerRequest.params[0], addressString(alternateOwnerAddress))
	assert.equal(parseForwardedSafeTxTypedData(signerRequest.params[1]).domain.verifyingContract.toLowerCase(), addressString(activeAddress).toLowerCase())

	const signature = await alternateOwnerAccount.signTypedData(EIP712Message.parse(safeTxToTypedDataJson(safeTx)))
	await modules.updateUserAddressBookEntries((entries) => entries.map((entry) =>
		entry.type === 'safe' && entry.address === activeAddress
			? { ...entry, safeSimulationSignerAddress: 0x2222222222222222222222222222222222222222n }
			: entry
	))
	const countSignerCodeReads = () => fakeSafeContract.requestedCodeAddresses.filter((address) => address === alternateOwnerAddress).length
	const signerCodeReadsBeforeReply = countSignerCodeReads()
	assert.equal(await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, website.websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'signerIncluded', signerReply: signature, uniqueRequestIdentifier },
	}), true)
	const dappReply = requireWebsiteReply(website.postedMessages, { type: 'result', method: 'eth_signTypedData_v4', requestId: uniqueRequestIdentifier.requestId }, 'Safe co-signature reply')
	assert.equal(dappReply.result, signature)
	assert.deepEqual(await modules.getSafeTransactionStacks(), [])
	assert.equal(countSignerCodeReads() - signerCodeReadsBeforeReply, 1)
	await accountReply
})

test('returns a Safe signer error when the wallet-selected co-signer is not a current owner', async () => {
	const safeSignerAddress = recipientAddress
	const currentOwner = safeTestOwnerAddress
	const safeTx = createSafeTxToRecipient()
	fakeSafeContract.owners = [currentOwner]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSignerAddresses: [safeSignerAddress],
		safeVersion: '1.4.1',
	})])
	await setWalletAccounts([safeSignerAddress], { signerChain: fakeRpcNetwork.chainId })
	const { websiteTabConnections } = connectWebsite({ websiteOrigin: sealwortWebsite.websiteOrigin })

	const reply = await openMessageConfirmation(createSafeTxSignRequest(safeTx), sealwortWebsite, websiteTabConnections)

	assert.equal(reply.type, 'result')
	if (reply.type !== 'result' || !('error' in reply)) throw new Error('Missing Safe signer selection error')
	assert.equal(reply.error.code, -32010)
	assert.match(reply.error.message, /is not an owner of Gnosis Safe/u)
})

test('treats a missing Safe version as an expected co-signing validation failure', async () => {
	fakeSafeContract.owners = [recipientAddress]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: undefined })])
	const safeTx = createSafeTxToRecipient()
	await assert.rejects(
		createSafeMessageCoSignSnapshot(simulator.ethereum, activeAddress, recipientAddress, createSafeTxSignRequest(safeTx), safeTx),
		(error: unknown) => isSafeSignerSelectionFailure(error) && error instanceof Error && /Re-save the active Gnosis Safe/u.test(error.message),
	)
})

test('rejects non-v4 Safe co-signing as a handled signer-selection failure', async () => {
	fakeSafeContract.owners = [recipientAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await setWalletAccounts([recipientAddress], { signerChain: fakeRpcNetwork.chainId })
	const signRequest = createSafeTxSignRequest(createSafeTxToRecipient(), { method: 'eth_signTypedData_v3' })
	const unexpectedErrorBeforeRequest = await getLatestUnexpectedError()

	const reply = await openMessageConfirmation(signRequest, { websiteOrigin: 'https://safe-v3.example', icon: undefined, title: 'Safe v3' }, new Map())
	assert.equal(reply.type, 'result')
	if (reply.type !== 'result' || !('error' in reply)) throw new Error('Missing handled non-v4 Safe co-signing error')
	assert.equal(reply.error.code, -32010)
	assert.match(reply.error.message, /requires eth_signTypedData_v4/u)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)
})

test('shows Safe transaction context failures in the co-signing dialog without reporting them as unexpected', async () => {
	fakeSafeContract.owners = [recipientAddress]
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeVersion: '1.4.1' })])
	await setWalletAccounts([recipientAddress], { signerChain: fakeRpcNetwork.chainId })
	const otherChainSafeTx = createSafeTx(fakeRpcNetwork.chainId + 1n, activeAddress, {
		to: recipientAddress,
		value: 0n,
		input: new Uint8Array(),
	}, 0n)
	const unexpectedErrorBeforeRequest = await getLatestUnexpectedError()

	assert.deepEqual(await openMessageConfirmation(createSafeTxSignRequest(otherChainSafeTx), { websiteOrigin: 'https://safe-context.example', icon: undefined, title: 'Safe context' }, new Map()), { type: 'doNotReply' })
	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingMessage?.approvalStatus.status, 'SignerError')
	if (pendingMessage?.approvalStatus.status !== 'SignerError') throw new Error('Missing Safe context validation error')
	assert.match(pendingMessage.approvalStatus.message, /chain ID does not match/u)
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)
})

test('shows a Safe signing-account mismatch in the confirmation dialog without reporting an unexpected error', async () => {
	const walletOwner = safeTestOwnerAddress
	const mismatchedRequestedAccount = recipientAddress
	const safeTx = createSafeTxToRecipient()
	fakeSafeContract.owners = [walletOwner]
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	const walletOwnerEntry = {
		type: 'contact' as const,
		name: 'Known Safe owner',
		address: walletOwner,
		chainId: fakeRpcNetwork.chainId,
		entrySource: 'User' as const,
	}
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSignerAddresses: [walletOwner],
		safeVersion: '1.4.1',
	}), walletOwnerEntry])
	await setWalletAccounts([walletOwner], { signerChain: fakeRpcNetwork.chainId })
	const { websiteTabConnections } = connectWebsite({ websiteOrigin: sealwortWebsite.websiteOrigin })
	const signRequest = createSafeTxSignRequest(safeTx, { signingAccount: mismatchedRequestedAccount })
	const unexpectedErrorBeforeRequest = await getLatestUnexpectedError()

	assert.deepEqual(await openMessageConfirmation(signRequest, sealwortWebsite, websiteTabConnections), { type: 'doNotReply' })

	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingMessage?.type, 'SignableMessage')
	assert.equal(pendingMessage?.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(pendingMessage?.approvalStatus.status, 'SignerError')
	if (pendingMessage?.approvalStatus.status !== 'SignerError') throw new Error('Missing Safe account mismatch error')
	assert.equal(pendingMessage.approvalStatus.code, -32010)
	assert.equal(pendingMessage.approvalStatus.message, 'The Gnosis Safe transaction signing account does not match the active Gnosis Safe.')
	assert.deepEqual(pendingMessage.approvalStatus.safeSignerErrorDetails, {
		kind: 'safeSigningAccountMismatch',
		requestedSigningAccount: mismatchedRequestedAccount,
		activeSafe: activeAddress,
		requestedSafe: activeAddress,
		safeOwners: [walletOwner],
		safeOwnerAddressBookEntries: [walletOwnerEntry],
	})
	assert.equal(pendingMessage.type === 'SignableMessage' ? pendingMessage.safeMessageCoSignSnapshot : undefined, undefined)
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	assert.deepEqual(await withSafeOwnerLookupFailure('expected', async () => await openMessageConfirmation(signRequest, sealwortWebsite, websiteTabConnections)), { type: 'doNotReply' })
	const [pendingMessageWithoutOwners] = await modules.getPendingTransactionsAndMessages()
	if (pendingMessageWithoutOwners?.approvalStatus.status !== 'SignerError') throw new Error('Missing Safe account mismatch error after owner lookup failure')
	assert.deepEqual(pendingMessageWithoutOwners.approvalStatus.safeSignerErrorDetails, {
		kind: 'safeSigningAccountMismatch',
		requestedSigningAccount: mismatchedRequestedAccount,
		activeSafe: activeAddress,
		requestedSafe: activeAddress,
		safeOwners: [],
		safeOwnerAddressBookEntries: [],
		safeOwnersUnavailableReason: 'Safe owner lookup unavailable',
	})
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)

	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await withSafeOwnerLookupFailure('unexpected', async () => {
		await assert.rejects(
			createSafeMessageCoSignSnapshot(simulator.ethereum, activeAddress, walletOwner, signRequest, safeTx),
			/Unexpected Safe owner decoder failure/u,
		)
	})
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)
})

test('signs Safe transaction typed data normally when the active signing address is an EOA', async () => {
	const eoaAddress = safeTestOwnerAddress
	const safeTx = createSafeTxToRecipient()
	fakeSafeContract.owners = [eoaAddress]
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [
		createSafeAddressBookEntry({ safeSignerAddresses: [eoaAddress], safeVersion: '1.4.1' }),
		{ type: 'contact', name: 'Sealwort signer', address: eoaAddress, chainId: fakeRpcNetwork.chainId, entrySource: 'User' },
	])
	await setWalletAccounts([eoaAddress], { signerChain: fakeRpcNetwork.chainId })
	const { websiteTabConnections } = connectWebsite({ websiteOrigin: sealwortWebsite.websiteOrigin })
	const unexpectedErrorBeforeRequest = await getLatestUnexpectedError()

	assert.deepEqual(await openMessageConfirmation(createSafeTxSignRequest(safeTx, { signingAccount: eoaAddress }), sealwortWebsite, websiteTabConnections, { signingAddress: eoaAddress }), { type: 'doNotReply' })

	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	if (pendingMessage?.type !== 'SignableMessage' || pendingMessage.transactionOrMessageCreationStatus !== 'Simulated') throw new Error('Missing EOA Safe typed-data confirmation')
	assert.equal(pendingMessage.approvalStatus.status, 'WaitingForUser')
	assert.equal(pendingMessage.safeMessageCoSignSnapshot, undefined)
	assert.deepEqual(await modules.resolveSafeConfirmation(simulator.ethereum, pendingMessage, 'accept'), {
		status: 'ready',
		pending: pendingMessage,
		pendingChanged: false,
		signerFacingRequest: undefined,
	})
	assert.deepEqual(await modules.resolveSafeSignerReply(simulator.ethereum, simulator.tokenPriceService, pendingMessage, '0x1234'), { status: 'not-safe' })
	assert.deepEqual(await getLatestUnexpectedError(), unexpectedErrorBeforeRequest)
})
