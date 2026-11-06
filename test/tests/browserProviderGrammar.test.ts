import { expect, test } from 'bun:test'
import { isProviderRdns, isUuidV4 } from '../../app/ts/utils/browserProviderIdentity.js'
import { BrowserProviderIdentity } from '../../app/ts/types/signerTypes.js'
import { SigningWalletBinding } from '../../app/ts/types/signingWallet.js'

test('provider codec and page-world validator share reverse-DNS admission', () => {
	for (const value of ['io.metamask', 'IO.MetaMask', 'com.wallet-name', 'localhost', '-bad.example', 'bad-.example', 'a..b', 'a.'.repeat(127) + 'b', '', undefined, 7]) {
		expect(BrowserProviderIdentity.test({ ambiguous: false, rdns: value })).toBe(value === undefined || isProviderRdns(value))
	}
	expect(isProviderRdns('io.metamask')).toBe(true)
	expect(isProviderRdns('a..b')).toBe(false)
})

test('UUID grammar checks version and variant while persisted revisions remain canonical lowercase', () => {
	const uuid = '200ecd95-afe4-4684-bce7-0f2f8bdd3498'
	const wallet = { type: 'browser', address: '0x0000000000000000000000000000000000000001', label: 'Test', signerName: 'MetaMask', providerId: 'eip6963:io.metamask' }
	for (const value of [uuid, uuid.toUpperCase(), uuid.replace('-4684-', '-5684-'), uuid.replace('-bce7-', '-7ce7-'), uuid + 'x', undefined]) {
		expect(SigningWalletBinding.safeParse({ wallet, revision: value }).success).toBe(isUuidV4(value) && value === value.toLowerCase())
	}
	expect(isUuidV4(uuid.toUpperCase())).toBe(true)
	expect(isUuidV4(uuid.replace('-4684-', '-5684-'))).toBe(false)
	expect(isUuidV4(uuid.replace('-bce7-', '-7ce7-'))).toBe(false)
})
