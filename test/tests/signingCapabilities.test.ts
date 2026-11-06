import { expect, test } from 'bun:test'
import { DirectSigningMethod, isSigningOperation } from '../../app/ts/types/signingMethods.js'
import { DirectSigningInput } from '../../app/ts/types/directSigning.js'
import { SIGNING_CAPABILITIES, getSigningMethodError } from '../../app/ts/signing/backend.js'
import { parseDerivationPath, isEthereumAccountPath } from '../../app/ts/utils/derivationPath.js'
import { encodeLedgerDerivationPath } from '../../app/ts/signing/ledgerFraming.js'

const directTypes: readonly ('ledger' | 'airgap')[] = ['ledger', 'airgap']

for (const method of ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'eth_sign', 'eth_signTypedData_v1', 'eth_sendRawTransaction', 'wallet_sendCalls', 'eth_signUnknown']) {
	test(`backend capabilities and persistent request schema agree for ${ method }`, () => {
		const direct = DirectSigningMethod.test(method)
		expect(DirectSigningInput.safeParse({ method, address: '0x01', data: '0x', chainId: '0x1' }).success).toBe(direct)
		for (const type of directTypes) {
			expect(SIGNING_CAPABILITIES[type].methods.test(method)).toBe(direct)
			expect(getSigningMethodError(type, method) === undefined).toBe(direct)
		}
		expect(getSigningMethodError('browser', method)).toBeUndefined()
		expect(isSigningOperation(method)).toBe(true)
	})
}

test('read-only methods are not classified as signing or rejected by direct capabilities', () => {
	expect(isSigningOperation('eth_call')).toBe(false)
	expect(getSigningMethodError('ledger', 'eth_call')).toBeUndefined()
})

test('shared concrete-path parsing preserves hardened indexes for Ledger encoding', () => {
	expect(parseDerivationPath('m/44\'/60\'/2147483647\'/0/9')).toEqual([{ index: 44, hardened: true }, { index: 60, hardened: true }, { index: 2147483647, hardened: true }, { index: 0, hardened: false }, { index: 9, hardened: false }])
	expect(Buffer.from(encodeLedgerDerivationPath('m/44\'/60\'/0\'/0/9')).toString('hex')).toBe('058000002c8000003c800000000000000000000009')
	for (const path of ['m', 'm/01', 'm/2147483648', 'm/-1', 'm/0/*', 'm/' + '1/'.repeat(11) + '1']) expect(parseDerivationPath(path)).toBeUndefined()
	expect(isEthereumAccountPath('m/44\'/60\'/0\'/0/9')).toBe(true)
	for (const path of ['m/44\'/60\'/0\'/1/9', 'm/44\'/60\'/0\'/0/9\'', 'm/44\'/60\'/0\'/0/2147483648']) expect(isEthereumAccountPath(path)).toBe(false)
})
