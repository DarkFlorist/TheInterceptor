import * as assert from 'node:assert'
import { test } from 'bun:test'
import type { SafeEntry } from '../../app/ts/types/addressBookTypes.js'
import { resolveSafeSigningPlan } from '../../app/ts/safe/safeSigningPlan.js'

const walletAccount = 0x1111111111111111111111111111111111111111n
const savedOwner = 0x2222222222222222222222222222222222222222n
const savedExecutor = 0x3333333333333333333333333333333333333333n
const safe: SafeEntry = { type: 'safe', name: 'Treasury', address: 0x4444444444444444444444444444444444444444n, chainId: 1n, entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [savedOwner, walletAccount] }

test('a Safe signs with its saved owner and executes with its saved execution account', () => {
	assert.deepEqual(resolveSafeSigningPlan({ ...safe, safeSigningSignerAddress: savedOwner, safeExecutionAddress: savedExecutor }, walletAccount), { signingOwner: savedOwner, executor: savedExecutor })
})

test('without a saved owner the wallet account signs, and without a saved execution account the signing owner executes', () => {
	assert.deepEqual(resolveSafeSigningPlan(safe, walletAccount), { signingOwner: walletAccount, executor: walletAccount })
	assert.deepEqual(resolveSafeSigningPlan({ ...safe, safeSigningSignerAddress: savedOwner }, walletAccount), { signingOwner: savedOwner, executor: savedOwner })
	assert.deepEqual(resolveSafeSigningPlan({ ...safe, safeExecutionAddress: savedExecutor }, walletAccount), { signingOwner: walletAccount, executor: savedExecutor })
	assert.deepEqual(resolveSafeSigningPlan({ ...safe, safeSigningSignerAddress: savedOwner }, undefined), { signingOwner: savedOwner, executor: savedOwner })
	assert.deepEqual(resolveSafeSigningPlan(safe, undefined), { signingOwner: undefined, executor: undefined })
})

test('an ordinary address signs and executes with the wallet account', () => {
	assert.deepEqual(resolveSafeSigningPlan(undefined, walletAccount), { signingOwner: walletAccount, executor: walletAccount })
})

// Request routing, confirmation creation (transactions and messages) and Safe transaction preparation decide the Safe's accounts only through resolveSafeSigningPlan, so they cannot apply different fallbacks to the same entry and wallet account.
test('every site that decides a Safe signer or executor uses the shared plan and no fallback of its own', async () => {
	const sources = await Promise.all(['background/background.ts', 'background/windows/confirmTransaction.ts', 'background/safeTransactionConfirmation.ts'].map(async (path) => ({ path, source: await Bun.file(new URL(`../../app/ts/${ path }`, import.meta.url)).text() })))
	for (const { path, source } of sources) {
		assert.match(source, /resolveSafeSigningPlan\(/u, path)
		assert.doesNotMatch(source, /safeSigningSignerAddress \?\?|safeExecutionAddress \?\?|getSavedSafeSigningAccount/u, path)
	}
})
