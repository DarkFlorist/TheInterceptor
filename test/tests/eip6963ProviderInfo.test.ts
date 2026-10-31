import * as assert from 'assert'
import { test } from 'bun:test'
import { EIP6963ProviderInfo } from '../../app/ts/types/signerTypes.js'
import { isEip6963ProviderInfo } from '../../app/ts/utils/eip6963ProviderInfo.js'

test('inpage and background provider metadata validation agree at their bounds', () => {
	const info = { uuid: '11111111-1111-4111-8111-111111111111', name: 'Wallet', icon: 'data:image/png;base64,AA==', rdns: 'org.wallet' }
	for (const candidate of [info, { ...info, name: 'EIP6963' }, { ...info, name: 'a'.repeat(129) }, { ...info, rdns: 'a'.repeat(256) }, { ...info, icon: 'https://wallet.example/icon.png' }, { ...info, icon: 'data:image/png;base64,!!!!' }, { ...info, uuid: '11111111-1111-1111-8111-111111111111' }]) {
		assert.equal(isEip6963ProviderInfo(candidate), EIP6963ProviderInfo.safeParse(candidate).success)
	}
})
