import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { h, render } from 'preact'
import { act } from 'preact/test-utils'
import { SafeTxSigningDetails } from '../../app/ts/components/subcomponents/SafeTxSigningDetails.js'
import { createSafeTx, getSafeTxSigningHashes } from '../../app/ts/safe/safeCore.js'
import type { AddressBookEntry } from '../../app/ts/types/addressBookTypes.js'
import type { RpcNetwork } from '../../app/ts/types/rpc.js'
import { getSafeTxHash } from '../../app/ts/utils/eip712.js'
import { installDomMock } from './domMock.js'

const safeAddress = 0x1111111111111111111111111111111111111111n
const recipientAddress = 0x2222222222222222222222222222222222222222n
const gasTokenAddress = 0x3333333333333333333333333333333333333333n

const contact = (name: string, address: bigint): AddressBookEntry => ({ type: 'contact', name, address, entrySource: 'User', chainId: 1n })

const mainnet: RpcNetwork = {
	name: 'Ethereum Mainnet',
	chainId: 1n,
	httpsRpc: 'https://rpc.example',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	primary: true,
	minimized: false,
}


describe('SafeTxSigningDetails', () => {
	test('lists every EIP-712 SafeTx field together with the full domain, message, and Safe transaction hashes', async () => {
		const dom = installDomMock()
		const safeTx = createSafeTx(1n, safeAddress, { to: recipientAddress, value: 1_250_000_000_000_000_000n, input: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) }, 5n)
		const hashes = { ...getSafeTxSigningHashes(safeTx), safeTxHash: getSafeTxHash(safeTx) }
		const zeroAddressEntry = contact('Zero', 0n)

		await act(() => {
			render(h(SafeTxSigningDetails, {
				safeTx,
				hashes,
				addressBookEntries: { verifyingContract: contact('My Safe', safeAddress), to: contact('Recipient', recipientAddress), gasToken: zeroAddressEntry, refundReceiver: zeroAddressEntry },
				rpcNetwork: mainnet,
				renameAddressCallBack: () => undefined,
			}), dom.document.body)
		})

		const text = dom.document.body.textContent ?? ''
		for (const expected of [
			'Gnosis Safe: My Safe',
			'Chain: Ethereum Mainnet (1)',
			'To: Recipient',
			'Value: 1.25ETH',
			'Value (wei): 1250000000000000000',
			'Operation: 0',
			'Gnosis Safe Transaction Gas: 0',
			'Base Gas: 0',
			'Gas Price: 0',
			'Nonce: 5',
			`Domain Hash${ hashes.domainHash }`,
			`Message Hash${ hashes.messageHash }`,
			`Gnosis Safe Transaction Hash${ hashes.safeTxHash }`,
		]) assert.equal(text.includes(expected), true, `expected "${ expected }" in "${ text }"`)
		// Zero gas reimbursement addresses are the Interceptor policy default and would only add noise.
		assert.equal(text.includes('Gas Token'), false)
		assert.equal(text.includes('Refund Receiver'), false)

		await act(() => { render(null, dom.document.body) })
		dom.restore()
	})

	test('shows gas reimbursement addresses and falls back to an unlabelled native amount and a bare chain id when the network is unknown', async () => {
		const dom = installDomMock()
		const safeTx = { ...createSafeTx(999_999_999_999n, safeAddress, { to: recipientAddress, value: 7n, input: new Uint8Array() }, 5n) }
		const reimbursingSafeTx = { ...safeTx, message: { ...safeTx.message, gasToken: gasTokenAddress, refundReceiver: recipientAddress } }
		const hashes = { ...getSafeTxSigningHashes(reimbursingSafeTx), safeTxHash: getSafeTxHash(reimbursingSafeTx) }

		await act(() => {
			render(h(SafeTxSigningDetails, {
				safeTx: reimbursingSafeTx,
				hashes,
				addressBookEntries: { verifyingContract: contact('My Safe', safeAddress), to: contact('Recipient', recipientAddress), gasToken: contact('Gas Token', gasTokenAddress), refundReceiver: contact('Recipient', recipientAddress) },
				rpcNetwork: undefined,
				renameAddressCallBack: () => undefined,
			}), dom.document.body)
		})

		const text = dom.document.body.textContent ?? ''
		assert.equal(text.includes('Chain: 999999999999'), true, text)
		assert.equal(text.includes('Value: 0.000000000000000007 (native token)'), true, text)
		assert.equal(text.includes('Value (wei): 7'), true, text)
		assert.equal(text.includes('Gas Token: Gas Token'), true, text)
		assert.equal(text.includes('Refund Receiver: Recipient'), true, text)

		await act(() => { render(null, dom.document.body) })
		dom.restore()
	})
})
