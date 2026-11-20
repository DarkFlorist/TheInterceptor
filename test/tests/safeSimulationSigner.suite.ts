import * as assert from 'node:assert'
import { test } from 'bun:test'
import { addOrModifyAddressBookEntry } from '../../app/ts/background/popupMessageHandlers/addressBook.js'
import { getLatestUnexpectedError } from '../../app/ts/utils/unexpectedErrorStorage.js'
import { createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import { activeAddress, connectWebsite, createSafeAddressBookEntry, createSafeTxSignRequest, createSafeTxToRecipient, fakeRpcNetwork, fakeSafeContract, getSafeTxHash, modules, openMessageConfirmation, recipientAddress, simulator, withSilencedConsole } from './confirmTransactionTestHarness.js'

const simulationSignerWebsite = { websiteOrigin: 'https://simulation-signer.example', icon: undefined, title: 'Simulation signer' }

const setSafeSimulationSigner = async (safeSimulationSignerAddress: bigint | undefined) => await modules.setSafeSimulationSigner(
	createTestSimulationServicesOwner(simulator),
	new Map(),
	{
		method: 'popup_setSafeSimulationSigner',
		data: {
			chainId: fakeRpcNetwork.chainId,
			safeAddress: activeAddress,
			safeSimulationSignerAddress,
		},
	},
)

async function getStoredSafeEntry() {
	const [storedEntry] = await modules.getUserAddressBookEntries()
	if (storedEntry?.type !== 'safe') throw new Error('Missing stored Gnosis Safe address book entry')
	return storedEntry
}

test('uses the configured Safe simulation signer without changing the active Safe account', async () => {
	const simulationSignerAddress = 0x4444444444444444444444444444444444444444n
	const safeTx = createSafeTxToRecipient()
	fakeSafeContract.owners = [simulationSignerAddress]
	fakeSafeContract.transactionHash = BigInt(getSafeTxHash(safeTx))
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: simulationSignerAddress,
		safeSignerAddresses: [simulationSignerAddress],
		safeVersion: '1.4.1',
	})])
	const { websiteTabConnections } = connectWebsite({ websiteOrigin: simulationSignerWebsite.websiteOrigin })

	assert.deepEqual(await openMessageConfirmation(createSafeTxSignRequest(safeTx), simulationSignerWebsite, websiteTabConnections, { simulationMode: true }), { type: 'doNotReply' })

	const [pendingMessage] = await modules.getPendingTransactionsAndMessages()
	assert.equal(pendingMessage?.type, 'SignableMessage')
	if (pendingMessage?.type !== 'SignableMessage') throw new Error('Missing simulated Safe message')
	assert.equal(pendingMessage.activeAddress, activeAddress)
	assert.equal(pendingMessage.signedMessageTransaction.activeAddress, activeAddress)
	assert.equal(pendingMessage.signedMessageTransaction.fakeSignedFor, simulationSignerAddress)
})

test('requires an explicit Safe simulation signer instead of using the first cached owner', async () => {
	const cachedOwner = 0x4444444444444444444444444444444444444444n
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		safeSimulationSignerAddress: undefined,
		safeSignerAddresses: [cachedOwner],
		safeVersion: '1.4.1',
	})])
	const signRequest = {
		method: 'personal_sign' as const,
		params: ['0x1234', activeAddress] as const,
	}

	const reply = await openMessageConfirmation(signRequest, simulationSignerWebsite, new Map(), { simulationMode: true })

	assert.equal(reply.type, 'result')
	if (reply.type !== 'result' || !('error' in reply)) throw new Error('Missing Safe simulation signer error')
	assert.equal(reply.error.code, -32010)
	assert.match(reply.error.message, /Select a Gnosis Safe signer for simulation/u)
	assert.deepEqual(await modules.getPendingTransactionsAndMessages(), [])
})

test('changes the Safe simulation signer only after validating current on-chain ownership', async () => {
	const alternateSigner = 0x1234567890123456789012345678901234567890n
	fakeSafeContract.owners = [recipientAddress, alternateSigner]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		useAsActiveAddress: false,
		safeSimulationSignerAddress: recipientAddress,
		safeSignerAddresses: [recipientAddress, alternateSigner],
	})])

	const reply = await setSafeSimulationSigner(alternateSigner)

	assert.deepEqual(reply, { type: 'SetSafeSimulationSignerReply', ok: true })
	const updatedSafeEntry = await getStoredSafeEntry()
	assert.equal(updatedSafeEntry.safeSimulationSignerAddress, alternateSigner)
	assert.deepEqual(updatedSafeEntry.safeSignerAddresses, [recipientAddress, alternateSigner])
	assert.equal(updatedSafeEntry.safeVersion, fakeSafeContract.version)
	assert.equal(fakeSafeContract.requestedCodeAddresses.includes(alternateSigner), true)

	fakeSafeContract.version = 'invalid-version'
	const unsupportedVersionFailure = await withSilencedConsole(async () => await setSafeSimulationSigner(recipientAddress))
	fakeSafeContract.version = '1.4.1'
	assert.equal(unsupportedVersionFailure.ok, false)
	assert.match(unsupportedVersionFailure.message ?? '', /version invalid-version is not supported/u)
	assert.equal(await getLatestUnexpectedError(), undefined)

	fakeSafeContract.version = 'invalid-version'
	const unsupportedVersionSaveFailure = await withSilencedConsole(async () => await addOrModifyAddressBookEntry(
		createTestSimulationServicesOwner(simulator),
		new Map(),
		{
			method: 'popup_addOrModifyAddressBookEntry',
			data: createSafeAddressBookEntry({
				useAsActiveAddress: false,
				safeSimulationSignerAddress: alternateSigner,
			}),
		},
	))
	fakeSafeContract.version = '1.4.1'
	assert.equal(unsupportedVersionSaveFailure.ok, false)
	assert.match(unsupportedVersionSaveFailure.message ?? '', /version invalid-version is not supported/u)
	assert.equal(await getLatestUnexpectedError(), undefined)
})

test('refreshes Safe owner metadata and clears a stale simulation signer without choosing a replacement', async () => {
	const staleSigner = 0x1234567890123456789012345678901234567890n
	fakeSafeContract.owners = [recipientAddress]
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({
		useAsActiveAddress: false,
		safeSimulationSignerAddress: staleSigner,
		safeSignerAddresses: [staleSigner],
		safeVersion: '1.3.0',
	})])

	const reply = await setSafeSimulationSigner(undefined)

	assert.deepEqual(reply, { type: 'SetSafeSimulationSignerReply', ok: true })
	const updatedSafeEntry = await getStoredSafeEntry()
	assert.equal(updatedSafeEntry.safeSimulationSignerAddress, undefined)
	assert.deepEqual(updatedSafeEntry.safeSignerAddresses, [recipientAddress])
	assert.equal(updatedSafeEntry.safeVersion, fakeSafeContract.version)
	assert.equal(fakeSafeContract.requestedCodeAddresses.includes(recipientAddress), false)
})
