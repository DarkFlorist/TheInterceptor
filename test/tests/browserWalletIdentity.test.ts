import { getBrowserProviderId } from '../../app/ts/utils/browserProviderIdentity.js'
import { expect, test } from 'bun:test'
import { browserWalletProviderId, matchesBrowserSigningWallet } from '../../app/ts/signing/browserWallet.js'
import type { SigningWallet } from '../../app/ts/types/signingWallet.js'

const wallet: Extract<SigningWallet, { type: 'browser' }> = { type: 'browser', address: 1n, label: 'Browser account', signerName: 'MetaMask', providerId: 'eip6963:io.metamask' }

test('browser binding uses persistent RDNS and rejects same-name providers and ambiguous discovery', () => {
	expect(matchesBrowserSigningWallet(wallet, { signerName: 'MetaMask', signerProvider: { rdns: 'io.metamask', ambiguous: false } })).toBe(true)
	expect(matchesBrowserSigningWallet(wallet, { signerName: 'MetaMask', signerProvider: { rdns: 'com.example.wallet', ambiguous: false } })).toBe(false)
	expect(matchesBrowserSigningWallet(wallet, { signerName: 'MetaMask', signerProvider: { rdns: 'io.metamask', ambiguous: true } })).toBe(false)
	expect(matchesBrowserSigningWallet(wallet, { signerName: 'MetaMask' })).toBe(false)
	expect(browserWalletProviderId({ signerName: 'MetaMask', signerProvider: { ambiguous: true } })).toBeUndefined()
})

test('legacy bindings require explicit namespace and bare display names never authorize providers', () => {
	expect(browserWalletProviderId({ signerName: 'MetaMask' })).toBe('legacy:MetaMask')
	expect(matchesBrowserSigningWallet({ ...wallet, providerId: 'legacy:MetaMask' }, { signerName: 'MetaMask' })).toBe(true)
	expect(matchesBrowserSigningWallet({ ...wallet, providerId: 'MetaMask' }, { signerName: 'MetaMask', signerProvider: { rdns: 'io.metamask', ambiguous: false } })).toBe(false)
	expect(matchesBrowserSigningWallet({ ...wallet, providerId: 'MetaMask' }, { signerName: 'MetaMask' })).toBe(false)
	expect(matchesBrowserSigningWallet({ ...wallet, providerId: 'legacy:MetaMask' }, { signerName: 'MetaMask', signerProvider: { rdns: 'io.metamask', ambiguous: false } })).toBe(false)
})

test('shared provider wire identity distinguishes legacy, discovered and ambiguous providers', () => {
	expect(getBrowserProviderId('MetaMask')).toBe('legacy:MetaMask')
	expect(getBrowserProviderId('MetaMask', { rdns: 'io.metamask' })).toBe('eip6963:io.metamask')
	expect(getBrowserProviderId('MetaMask', { rdns: 'io.metamask', ambiguous: true })).toBeUndefined()
	expect(getBrowserProviderId('MetaMask', { ambiguous: true })).toBeUndefined()
})
